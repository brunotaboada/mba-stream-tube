import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'stream';
import storageConfig from '../config/storage.config';

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export interface PresignedPart {
  partNumber: number;
  url: string;
}

export interface PresignedGetOptions {
  expiresIn?: number;
  downloadFilename?: string;
  contentType?: string;
}

/**
 * Single point of contact with the object store. Every S3 concept stays
 * behind this service so no other module depends on the AWS SDK.
 *
 * Two clients are held: one addressed by the in-cluster endpoint for
 * server-side calls, and one addressed by the browser-reachable endpoint used
 * only to sign URLs that are handed to clients.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly internalClient: S3Client;
  private readonly signingClient: S3Client;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.internalClient = this.buildClient(config.endpoint);
    this.signingClient =
      config.publicEndpoint === config.endpoint
        ? this.internalClient
        : this.buildClient(config.publicEndpoint);
  }

  private buildClient(endpoint: string): S3Client {
    return new S3Client({
      endpoint,
      region: this.config.region,
      // MinIO serves buckets as path segments, not as virtual hosts.
      forcePathStyle: true,
      credentials: {
        accessKeyId: this.config.accessKey,
        secretAccessKey: this.config.secretKey,
      },
    });
  }

  get videosBucket(): string {
    return this.config.videosBucket;
  }

  get thumbnailsBucket(): string {
    return this.config.thumbnailsBucket;
  }

  get urlExpirationSeconds(): number {
    return this.config.urlExpirationSeconds;
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const result = await this.internalClient.send(
      new CreateMultipartUploadCommand({
        Bucket: this.videosBucket,
        Key: key,
        ContentType: contentType,
      }),
    );

    if (!result.UploadId) {
      throw new Error('Object storage did not return a multipart upload id');
    }
    return result.UploadId;
  }

  async getPartUploadUrls(
    key: string,
    uploadId: string,
    partCount: number,
  ): Promise<PresignedPart[]> {
    const parts: PresignedPart[] = [];

    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      const url = await getSignedUrl(
        this.signingClient,
        new UploadPartCommand({
          Bucket: this.videosBucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
        }),
        { expiresIn: this.urlExpirationSeconds },
      );
      parts.push({ partNumber, url });
    }

    return parts;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    // S3 requires parts in ascending order; a client may report them
    // out of order because parts upload in parallel.
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);

    await this.internalClient.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.videosBucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: ordered.map((part) => ({
            PartNumber: part.partNumber,
            ETag: part.etag,
          })),
        },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.internalClient.send(
      new AbortMultipartUploadCommand({
        Bucket: this.videosBucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  /**
   * Signs a temporary GET URL. Object storage — not the API — serves the
   * bytes, so it handles Range requests and answers 206 natively.
   */
  async getPresignedDownloadUrl(
    bucket: string,
    key: string,
    options: PresignedGetOptions = {},
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ...(options.downloadFilename && {
        ResponseContentDisposition: `attachment; filename="${options.downloadFilename}"`,
      }),
      ...(options.contentType && { ResponseContentType: options.contentType }),
    });

    return getSignedUrl(this.signingClient, command, {
      expiresIn: options.expiresIn ?? this.urlExpirationSeconds,
    });
  }

  async putObject(
    bucket: string,
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.internalClient.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async getObjectStream(bucket: string, key: string): Promise<Readable> {
    const result = await this.internalClient.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );

    if (!result.Body) {
      throw new Error(`Object ${bucket}/${key} has no body`);
    }
    return result.Body as Readable;
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    await this.internalClient.send(
      new DeleteObjectCommand({ Bucket: bucket, Key: key }),
    );
  }

  /** Public, unsigned URL — only valid for the publicly readable bucket. */
  buildPublicUrl(bucket: string, key: string): string {
    return `${this.config.publicEndpoint}/${bucket}/${key}`;
  }
}
