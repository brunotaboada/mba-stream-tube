import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { StorageService } from './storage.service';

const config = {
  endpoint: 'http://minio:9000',
  publicEndpoint: 'http://minio:9000',
  region: 'us-east-1',
  accessKey: 'key',
  secretKey: 'secret',
  videosBucket: 'videos-bucket',
  thumbnailsBucket: 'thumbs-bucket',
  urlExpirationSeconds: 900,
};

function buildService(): { service: StorageService; send: jest.Mock } {
  const service = new StorageService(config);
  const send = jest.fn().mockResolvedValue({ UploadId: 'upload-1' });
  // Both clients are internal detail; replace their transport for the unit test.
  (service as any).internalClient = { send };
  (service as any).signingClient = { send };
  return { service, send };
}

describe('StorageService', () => {
  it('exposes the configured buckets and expiry', () => {
    const { service } = buildService();

    expect(service.videosBucket).toBe('videos-bucket');
    expect(service.thumbnailsBucket).toBe('thumbs-bucket');
    expect(service.urlExpirationSeconds).toBe(900);
  });

  it('creates a multipart upload in the videos bucket and returns its id', async () => {
    const { service, send } = buildService();

    await expect(
      service.createMultipartUpload('key/source.mp4', 'video/mp4'),
    ).resolves.toBe('upload-1');

    const command = send.mock.calls[0][0] as CreateMultipartUploadCommand;
    expect(command).toBeInstanceOf(CreateMultipartUploadCommand);
    expect(command.input).toMatchObject({
      Bucket: 'videos-bucket',
      Key: 'key/source.mp4',
      ContentType: 'video/mp4',
    });
  });

  it('throws when object storage returns no upload id', async () => {
    const { service, send } = buildService();
    send.mockResolvedValue({});

    await expect(
      service.createMultipartUpload('key/source.mp4', 'video/mp4'),
    ).rejects.toThrow('multipart upload id');
  });

  it('sorts parts ascending before completing the upload', async () => {
    const { service, send } = buildService();

    await service.completeMultipartUpload('key', 'upload-1', [
      { partNumber: 3, etag: 'c' },
      { partNumber: 1, etag: 'a' },
      { partNumber: 2, etag: 'b' },
    ]);

    const command = send.mock.calls[0][0] as CompleteMultipartUploadCommand;
    expect(command).toBeInstanceOf(CompleteMultipartUploadCommand);
    expect(command.input.MultipartUpload?.Parts).toEqual([
      { PartNumber: 1, ETag: 'a' },
      { PartNumber: 2, ETag: 'b' },
      { PartNumber: 3, ETag: 'c' },
    ]);
  });

  it('aborts a multipart upload against the videos bucket', async () => {
    const { service, send } = buildService();

    await service.abortMultipartUpload('key', 'upload-1');

    const command = send.mock.calls[0][0] as AbortMultipartUploadCommand;
    expect(command).toBeInstanceOf(AbortMultipartUploadCommand);
    expect(command.input).toMatchObject({
      Bucket: 'videos-bucket',
      Key: 'key',
      UploadId: 'upload-1',
    });
  });

  // Presigned URL generation requires a real S3 client (getSignedUrl reads the
  // client's resolved config), so it is covered in storage.service.integration-spec.ts
  // against real MinIO rather than mocked here.

  it('builds an unsigned public URL from the public endpoint', () => {
    const { service } = buildService();

    expect(service.buildPublicUrl('thumbs-bucket', 'abc.jpg')).toBe(
      'http://minio:9000/thumbs-bucket/abc.jpg',
    );
  });
});
