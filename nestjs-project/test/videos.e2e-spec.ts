import { execFile } from 'child_process';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { ProcessingModule } from '../src/videos/processing/processing.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { VideoProcessingConsumer } from '../src/videos/processing/video-processing.consumer';
import { VideoStatus } from '../src/videos/entities/video-status.enum';
import { Video } from '../src/videos/entities/video.entity';

const execFileAsync = promisify(execFile);
const PASSWORD = 'password123';

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let storage: StorageService;
  let consumer: VideoProcessingConsumer;
  let throttlerStorage: ThrottlerStorageService;
  let workDir: string;
  let sampleVideo: Buffer;

  beforeAll(async () => {
    // ProcessingModule belongs to the worker process, not the API. It is
    // imported here so the e2e run can drive the processing step inline and
    // assert deterministically; the deployed worker consumes the same jobs
    // from Redis (covered separately in the consumer integration suite).
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule, ProcessingModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    storage = moduleFixture.get(StorageService);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);

    workDir = await mkdtemp(join(tmpdir(), 'videos-e2e-'));
    const samplePath = join(workDir, 'sample.mp4');
    await execFileAsync(ffmpegInstaller.path, [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=3:size=320x240:rate=25',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      samplePath,
    ]);
    sampleVideo = await readFile(samplePath);
  }, 180000);

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
    await cleanAllTables(dataSource);
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  let userCounter = 0;
  async function registerAndLogin(): Promise<string> {
    const email = `videos_e2e_${++userCounter}_${Date.now()}@example.com`;

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: PASSWORD })
      .expect(201);

    // Confirm directly in the database: the email flow is Fase 02's concern.
    await dataSource.query(
      'UPDATE "users" SET is_confirmed = true WHERE email = $1',
      [email],
    );

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);

    return (login.body as { access_token: string }).access_token;
  }

  function initiateUpload(
    token: string,
    overrides: Record<string, unknown> = {},
  ) {
    return request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${token}`)
      .send({
        filename: 'sample.mp4',
        contentType: 'video/mp4',
        sizeBytes: sampleVideo.length,
        ...overrides,
      });
  }

  /** Drives a video all the way to ready, exactly as a client would. */
  async function uploadAndProcess(token: string): Promise<string> {
    const initiated = await initiateUpload(token).expect(201);
    const body = initiated.body as {
      videoId: string;
      publicId: string;
      uploadId: string;
      parts: { partNumber: number; url: string }[];
    };

    const put = await fetch(body.parts[0].url, {
      method: 'PUT',
      body: new Uint8Array(sampleVideo),
    });
    expect(put.status).toBe(200);
    const etag = put.headers.get('etag')!;

    await request(app.getHttpServer())
      .post(`/videos/${body.videoId}/uploads/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ uploadId: body.uploadId, parts: [{ partNumber: 1, etag }] })
      .expect(200);

    // Run the job inline; the worker container does this in a real deployment.
    consumer = app.get(VideoProcessingConsumer, { strict: false });
    await consumer.process({
      data: { videoId: body.videoId },
      attemptsMade: 0,
      opts: { attempts: 3 },
    } as never);

    return body.publicId;
  }

  describe('POST /videos/uploads', () => {
    it('pre-registers a draft and returns presigned part URLs', async () => {
      const token = await registerAndLogin();

      const response = await initiateUpload(token).expect(201);

      const body = response.body as Record<string, unknown>;
      expect(body.status).toBe(VideoStatus.DRAFT);
      expect(body.publicId).toHaveLength(11);
      expect(body.uploadId).toBeTruthy();
      expect(Array.isArray(body.parts)).toBe(true);
      expect((body.parts as unknown[]).length).toBe(1);
    }, 60000);

    it('issues one presigned URL per 100 MiB part for a 10GB upload', async () => {
      const token = await registerAndLogin();

      const response = await initiateUpload(token, {
        sizeBytes: 10 * 1024 * 1024 * 1024,
      }).expect(201);

      const body = response.body as { parts: unknown[]; partSizeBytes: number };
      expect(body.partSizeBytes).toBe(104857600);
      expect(body.parts.length).toBe(103);
    }, 60000);

    it('rejects an anonymous caller', async () => {
      await request(app.getHttpServer())
        .post('/videos/uploads')
        .send({
          filename: 'a.mp4',
          contentType: 'video/mp4',
          sizeBytes: 100,
        })
        .expect(401);
    }, 60000);

    it('rejects an unsupported content type with 415', async () => {
      const token = await registerAndLogin();

      const response = await initiateUpload(token, {
        contentType: 'application/pdf',
      }).expect(415);

      expect((response.body as { error: string }).error).toBe(
        'UNSUPPORTED_VIDEO_FORMAT',
      );
    }, 60000);

    it('rejects a file above the maximum size with 413', async () => {
      const token = await registerAndLogin();

      const response = await initiateUpload(token, {
        sizeBytes: 10 * 1024 * 1024 * 1024 + 1,
      }).expect(413);

      expect((response.body as { error: string }).error).toBe(
        'VIDEO_TOO_LARGE',
      );
    }, 60000);

    it('rejects a malformed body with 400', async () => {
      const token = await registerAndLogin();

      await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${token}`)
        .send({ filename: '', contentType: 'video/mp4' })
        .expect(400);
    }, 60000);
  });

  describe('upload completion', () => {
    it('completes the upload and moves the video to processing', async () => {
      const token = await registerAndLogin();
      const initiated = await initiateUpload(token).expect(201);
      const body = initiated.body as {
        videoId: string;
        uploadId: string;
        parts: { url: string }[];
      };

      const put = await fetch(body.parts[0].url, {
        method: 'PUT',
        body: new Uint8Array(sampleVideo),
      });
      const etag = put.headers.get('etag')!;

      const response = await request(app.getHttpServer())
        .post(`/videos/${body.videoId}/uploads/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ uploadId: body.uploadId, parts: [{ partNumber: 1, etag }] })
        .expect(200);

      expect((response.body as { status: string }).status).toBe(
        VideoStatus.PROCESSING,
      );
    }, 120000);

    it('returns 409 when the upload is completed twice', async () => {
      const token = await registerAndLogin();
      const initiated = await initiateUpload(token).expect(201);
      const body = initiated.body as {
        videoId: string;
        uploadId: string;
        parts: { url: string }[];
      };
      const put = await fetch(body.parts[0].url, {
        method: 'PUT',
        body: new Uint8Array(sampleVideo),
      });
      const parts = [{ partNumber: 1, etag: put.headers.get('etag')! }];

      await request(app.getHttpServer())
        .post(`/videos/${body.videoId}/uploads/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ uploadId: body.uploadId, parts })
        .expect(200);

      const conflict = await request(app.getHttpServer())
        .post(`/videos/${body.videoId}/uploads/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ uploadId: body.uploadId, parts })
        .expect(409);

      expect((conflict.body as { error: string }).error).toBe(
        'INVALID_VIDEO_STATE',
      );
    }, 120000);

    it("returns 404 when completing another channel's video", async () => {
      const owner = await registerAndLogin();
      const stranger = await registerAndLogin();
      const initiated = await initiateUpload(owner).expect(201);
      const body = initiated.body as { videoId: string; uploadId: string };

      await request(app.getHttpServer())
        .post(`/videos/${body.videoId}/uploads/complete`)
        .set('Authorization', `Bearer ${stranger}`)
        .send({
          uploadId: body.uploadId,
          parts: [{ partNumber: 1, etag: 'x' }],
        })
        .expect(404);
    }, 60000);

    it('aborts an upload and discards the draft', async () => {
      const token = await registerAndLogin();
      const initiated = await initiateUpload(token).expect(201);
      const { videoId } = initiated.body as { videoId: string };

      await request(app.getHttpServer())
        .delete(`/videos/${videoId}/uploads`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      await expect(
        videoRepository.findOneBy({ id: videoId }),
      ).resolves.toBeNull();
    }, 60000);
  });

  describe('processed video', () => {
    it('exposes the video anonymously by its unique public URL', async () => {
      const token = await registerAndLogin();
      const publicId = await uploadAndProcess(token);

      const response = await request(app.getHttpServer())
        .get(`/videos/${publicId}`)
        .expect(200);

      const body = response.body as Record<string, unknown>;
      expect(body.publicId).toBe(publicId);
      expect(body.status).toBe(VideoStatus.READY);
      expect(body.durationSeconds).toBeCloseTo(3, 0);
      expect(body.width).toBe(320);
      expect(body.height).toBe(240);
      expect(body.thumbnailUrl).toContain('.jpg');
      expect(body.channel).toMatchObject({ nickname: expect.any(String) });
    }, 180000);

    it('never leaks internal identifiers or storage keys', async () => {
      const token = await registerAndLogin();
      const publicId = await uploadAndProcess(token);

      const response = await request(app.getHttpServer())
        .get(`/videos/${publicId}`)
        .expect(200);

      const body = response.body as Record<string, unknown>;
      expect(body.id).toBeUndefined();
      expect(body.storage_key).toBeUndefined();
      expect(body.metadata).toBeUndefined();
      expect(body.upload_id).toBeUndefined();
    }, 180000);

    it('returns 404 for an unknown public id', async () => {
      await request(app.getHttpServer()).get('/videos/doesNotExis').expect(404);
    }, 60000);

    it('hides a video that has not finished processing', async () => {
      const token = await registerAndLogin();
      const initiated = await initiateUpload(token).expect(201);
      const { publicId } = initiated.body as { publicId: string };

      await request(app.getHttpServer()).get(`/videos/${publicId}`).expect(404);
    }, 60000);
  });

  describe('streaming and download', () => {
    it('streams without requiring a full download: the redirect target answers 206', async () => {
      const token = await registerAndLogin();
      const publicId = await uploadAndProcess(token);

      const redirect = await request(app.getHttpServer())
        .get(`/videos/${publicId}/stream`)
        .expect(302);

      const location = redirect.headers['location'];
      expect(location).toBeTruthy();

      const ranged = await fetch(location, {
        headers: { Range: 'bytes=0-1023' },
      });

      expect(ranged.status).toBe(206);
      expect(ranged.headers.get('content-range')).toMatch(/^bytes 0-1023\//);
      const chunk = Buffer.from(await ranged.arrayBuffer());
      expect(chunk.length).toBe(1024);
      expect(chunk.length).toBeLessThan(sampleVideo.length);
    }, 180000);

    it('downloads the video as an attachment', async () => {
      const token = await registerAndLogin();
      const publicId = await uploadAndProcess(token);

      const redirect = await request(app.getHttpServer())
        .get(`/videos/${publicId}/download`)
        .expect(302);

      const response = await fetch(redirect.headers['location']);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toContain(
        'attachment',
      );
      expect(response.headers.get('content-disposition')).toContain(
        'sample.mp4',
      );
      const downloaded = Buffer.from(await response.arrayBuffer());
      expect(downloaded.length).toBe(sampleVideo.length);
    }, 180000);

    it('refuses to stream a video that is not ready', async () => {
      const token = await registerAndLogin();
      const initiated = await initiateUpload(token).expect(201);
      const { publicId } = initiated.body as { publicId: string };

      await request(app.getHttpServer())
        .get(`/videos/${publicId}/stream`)
        .expect(404);
      await request(app.getHttpServer())
        .get(`/videos/${publicId}/download`)
        .expect(404);
    }, 60000);
  });

  describe('processing by the deployed worker container', () => {
    it('processes a completed upload without the API doing any work', async () => {
      const token = await registerAndLogin();
      const initiated = await initiateUpload(token).expect(201);
      const body = initiated.body as {
        videoId: string;
        publicId: string;
        uploadId: string;
        parts: { url: string }[];
      };

      const put = await fetch(body.parts[0].url, {
        method: 'PUT',
        body: new Uint8Array(sampleVideo),
      });
      const etag = put.headers.get('etag')!;

      // Completing enqueues onto the same Redis the video-worker container
      // consumes. Nothing in this test invokes the consumer.
      await request(app.getHttpServer())
        .post(`/videos/${body.videoId}/uploads/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ uploadId: body.uploadId, parts: [{ partNumber: 1, etag }] })
        .expect(200);

      const deadline = Date.now() + 90000;
      let processed: Video | null = null;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        processed = await videoRepository.findOneBy({ id: body.videoId });
        if (
          processed &&
          (processed.status === VideoStatus.READY ||
            processed.status === VideoStatus.FAILED)
        ) {
          break;
        }
      }

      expect(processed).not.toBeNull();
      expect(processed!.status).toBe(VideoStatus.READY);
      expect(Number(processed!.duration_seconds)).toBeCloseTo(3, 0);
      expect(processed!.thumbnail_key).toBe(`${body.videoId}.jpg`);

      const thumb = await fetch(
        storage.buildPublicUrl(
          storage.thumbnailsBucket,
          processed!.thumbnail_key!,
        ),
      );
      expect(thumb.status).toBe(200);
    }, 180000);
  });
});
