import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageService } from './storage.service';

// S3 requires every part except the last to be at least 5 MiB.
const PART_SIZE = 5 * 1024 * 1024;

describe('StorageService (integration)', () => {
  let storage: StorageService;
  const createdKeys: { bucket: string; key: string }[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] })],
      providers: [StorageService],
    }).compile();

    storage = moduleRef.get(StorageService);
  });

  afterAll(async () => {
    for (const { bucket, key } of createdKeys) {
      await storage.deleteObject(bucket, key).catch(() => undefined);
    }
  });

  function track(bucket: string, key: string): string {
    createdKeys.push({ bucket, key });
    return key;
  }

  async function uploadPart(url: string, body: Buffer): Promise<string> {
    const response = await fetch(url, {
      method: 'PUT',
      body: new Uint8Array(body),
    });
    expect(response.status).toBe(200);
    const etag = response.headers.get('etag');
    expect(etag).toBeTruthy();
    return etag!;
  }

  describe('multipart upload', () => {
    it('assembles a multi-part object that matches the input byte for byte', async () => {
      const key = track(storage.videosBucket, `it-multipart-${Date.now()}.bin`);
      const first = Buffer.alloc(PART_SIZE, 'a');
      const second = Buffer.from('trailing-part-content');

      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
      const parts = await storage.getPartUploadUrls(key, uploadId, 2);
      expect(parts).toHaveLength(2);

      // Uploaded out of order on purpose — the service must sort before completing.
      const secondEtag = await uploadPart(parts[1].url, second);
      const firstEtag = await uploadPart(parts[0].url, first);

      await storage.completeMultipartUpload(key, uploadId, [
        { partNumber: 2, etag: secondEtag },
        { partNumber: 1, etag: firstEtag },
      ]);

      const url = await storage.getPresignedDownloadUrl(
        storage.videosBucket,
        key,
      );
      const downloaded = Buffer.from(await (await fetch(url)).arrayBuffer());

      expect(downloaded.length).toBe(first.length + second.length);
      expect(downloaded.equals(Buffer.concat([first, second]))).toBe(true);
    }, 60000);

    it('leaves no object behind when the upload is aborted', async () => {
      const key = `it-abort-${Date.now()}.bin`;
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

      await storage.abortMultipartUpload(key, uploadId);

      const url = await storage.getPresignedDownloadUrl(
        storage.videosBucket,
        key,
      );
      expect((await fetch(url)).status).toBe(404);
    }, 30000);
  });

  describe('presigned reads', () => {
    it('serves a ranged request as 206 Partial Content', async () => {
      const key = track(storage.videosBucket, `it-range-${Date.now()}.bin`);
      const body = Buffer.alloc(4096, 'r');
      await storage.putObject(
        storage.videosBucket,
        key,
        body,
        'application/octet-stream',
      );

      const url = await storage.getPresignedDownloadUrl(
        storage.videosBucket,
        key,
      );
      const response = await fetch(url, {
        headers: { Range: 'bytes=0-1023' },
      });

      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe('bytes 0-1023/4096');
      const chunk = Buffer.from(await response.arrayBuffer());
      expect(chunk.length).toBe(1024);
    }, 30000);

    it('signs a download URL that forces an attachment filename', async () => {
      const key = track(storage.videosBucket, `it-disp-${Date.now()}.bin`);
      await storage.putObject(
        storage.videosBucket,
        key,
        Buffer.from('content'),
        'application/octet-stream',
      );

      const url = await storage.getPresignedDownloadUrl(
        storage.videosBucket,
        key,
        { downloadFilename: 'my video.mp4', contentType: 'application/octet-stream' },
      );
      const response = await fetch(url);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toContain(
        'attachment',
      );
      expect(response.headers.get('content-disposition')).toContain(
        'my video.mp4',
      );
    }, 30000);

    it('expires the signature', async () => {
      const key = track(storage.videosBucket, `it-exp-${Date.now()}.bin`);
      await storage.putObject(
        storage.videosBucket,
        key,
        Buffer.from('x'),
        'application/octet-stream',
      );

      const url = await storage.getPresignedDownloadUrl(
        storage.videosBucket,
        key,
        { expiresIn: 1 },
      );
      await new Promise((resolve) => setTimeout(resolve, 1500));

      expect((await fetch(url)).status).toBe(403);
    }, 30000);
  });

  describe('objects', () => {
    it('round-trips an object through put and stream', async () => {
      const key = track(storage.thumbnailsBucket, `it-thumb-${Date.now()}.jpg`);
      const body = Buffer.from('fake-jpeg-bytes');

      await storage.putObject(storage.thumbnailsBucket, key, body, 'image/jpeg');

      const stream = await storage.getObjectStream(storage.thumbnailsBucket, key);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk as Buffer);
      }
      expect(Buffer.concat(chunks).equals(body)).toBe(true);
    }, 30000);

    it('serves the thumbnails bucket anonymously but not the videos bucket', async () => {
      const thumbKey = track(
        storage.thumbnailsBucket,
        `it-public-${Date.now()}.jpg`,
      );
      const videoKey = track(storage.videosBucket, `it-private-${Date.now()}.bin`);
      await storage.putObject(
        storage.thumbnailsBucket,
        thumbKey,
        Buffer.from('thumb'),
        'image/jpeg',
      );
      await storage.putObject(
        storage.videosBucket,
        videoKey,
        Buffer.from('video'),
        'video/mp4',
      );

      const publicThumb = await fetch(
        storage.buildPublicUrl(storage.thumbnailsBucket, thumbKey),
      );
      const publicVideo = await fetch(
        storage.buildPublicUrl(storage.videosBucket, videoKey),
      );

      expect(publicThumb.status).toBe(200);
      expect(publicVideo.status).toBe(403);
    }, 30000);

    it('deletes an object', async () => {
      const key = `it-del-${Date.now()}.bin`;
      await storage.putObject(
        storage.videosBucket,
        key,
        Buffer.from('bye'),
        'application/octet-stream',
      );

      await storage.deleteObject(storage.videosBucket, key);

      const url = await storage.getPresignedDownloadUrl(
        storage.videosBucket,
        key,
      );
      expect((await fetch(url)).status).toBe(404);
    }, 30000);
  });
});
