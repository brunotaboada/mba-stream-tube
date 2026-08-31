import { extname } from 'path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import videoConfig from '../config/video.config';
import { VideoProcessingProducer } from '../queue/video-processing.producer';
import { StorageService } from '../storage/storage.service';
import type { PresignedPart } from '../storage/storage.service';
import type { CompleteUploadDto } from './dto/complete-upload.dto';
import type { InitiateUploadDto } from './dto/initiate-upload.dto';
import { VideoStatus } from './entities/video-status.enum';
import { Video } from './entities/video.entity';
import {
  ChannelNotFoundException,
  InvalidVideoStateException,
  UnsupportedVideoFormatException,
  VideoNotFoundException,
  VideoNotReadyException,
  VideoTooLargeException,
} from './exceptions/video.exceptions';
import { generatePublicId } from './public-id.util';

const PG_UNIQUE_VIOLATION = '23505';
const PUBLIC_ID_MAX_ATTEMPTS = 5;

export interface InitiatedUpload {
  videoId: string;
  publicId: string;
  status: VideoStatus;
  uploadId: string;
  partSizeBytes: number;
  parts: PresignedPart[];
  expiresIn: number;
}

/**
 * The filename is signed into the presigned URL, so a client cannot tamper
 * with it — but it still must not be able to break out of the
 * Content-Disposition header, so quotes, path separators and control
 * characters are removed.
 */
export function sanitizeDownloadFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? 'video';
  const cleaned = Array.from(base)
    .filter((char) => {
      const code = char.charCodeAt(0);
      if (code < 32 || code === 127) return false;
      return char !== '"' && char !== "'";
    })
    .join('')
    .trim();
  return cleaned.length > 0 ? cleaned : 'video';
}

@Injectable()
export class VideosService {
  private readonly logger = new Logger(VideosService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    private readonly processingProducer: VideoProcessingProducer,
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
  ) {}

  /**
   * Pre-registers the video as a draft and hands back presigned URLs so the
   * client uploads straight to object storage. No video bytes pass through
   * the API.
   */
  async initiateUpload(
    userId: string,
    dto: InitiateUploadDto,
  ): Promise<InitiatedUpload> {
    if (!this.config.allowedMimeTypes.includes(dto.contentType)) {
      throw new UnsupportedVideoFormatException(this.config.allowedMimeTypes);
    }
    if (dto.sizeBytes > this.config.maxSizeBytes) {
      throw new VideoTooLargeException(this.config.maxSizeBytes);
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new ChannelNotFoundException();
    }

    const video = await this.persistDraft(channel.id, dto);

    const uploadId = await this.storageService.createMultipartUpload(
      video.storage_key,
      dto.contentType,
    );
    const partCount = Math.ceil(dto.sizeBytes / this.config.uploadPartSizeBytes);
    const parts = await this.storageService.getPartUploadUrls(
      video.storage_key,
      uploadId,
      partCount,
    );

    video.upload_id = uploadId;
    await this.videoRepository.save(video);

    return {
      videoId: video.id,
      publicId: video.public_id,
      status: video.status,
      uploadId,
      partSizeBytes: this.config.uploadPartSizeBytes,
      parts,
      expiresIn: this.storageService.urlExpirationSeconds,
    };
  }

  /**
   * The public id is generated in application code, so a collision is
   * possible in principle. The unique index is the real guarantee; this
   * retries against it rather than assuming uniqueness.
   */
  private async persistDraft(
    channelId: string,
    dto: InitiateUploadDto,
  ): Promise<Video> {
    const extension = extname(dto.filename) || '.mp4';
    const title = dto.title ?? dto.filename.replace(/\.[^/.]+$/, '');

    for (let attempt = 0; attempt < PUBLIC_ID_MAX_ATTEMPTS; attempt++) {
      const video = this.videoRepository.create({
        public_id: generatePublicId(),
        channel_id: channelId,
        title,
        status: VideoStatus.DRAFT,
        storage_key: 'pending',
        original_filename: dto.filename,
        content_type: dto.contentType,
        size_bytes: String(dto.sizeBytes),
      });

      try {
        const saved = await this.videoRepository.save(video);
        // The key embeds the row id, so it is only knowable after the insert.
        saved.storage_key = `${saved.id}/source${extension}`;
        return await this.videoRepository.save(saved);
      } catch (error) {
        if (this.isPublicIdCollision(error)) {
          this.logger.warn('public_id collision, regenerating');
          continue;
        }
        throw error;
      }
    }

    throw new Error(
      `Could not generate a unique public id after ${PUBLIC_ID_MAX_ATTEMPTS} attempts`,
    );
  }

  private isPublicIdCollision(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) return false;
    const driverError = error as unknown as { code?: string; detail?: string };
    return (
      driverError.code === PG_UNIQUE_VIOLATION &&
      typeof driverError.detail === 'string' &&
      driverError.detail.includes('public_id')
    );
  }

  async completeUpload(
    userId: string,
    videoId: string,
    dto: CompleteUploadDto,
  ): Promise<Video> {
    const video = await this.findOwnedVideo(userId, videoId);

    if (video.status !== VideoStatus.DRAFT) {
      throw new InvalidVideoStateException(
        `Upload can only be completed while the video is a draft (current status: ${video.status})`,
      );
    }

    // Assemble the object first: if this fails the row stays a draft and the
    // client can retry, rather than being stranded in processing.
    await this.storageService.completeMultipartUpload(
      video.storage_key,
      dto.uploadId,
      dto.parts,
    );

    video.status = VideoStatus.PROCESSING;
    video.upload_id = null;
    const saved = await this.videoRepository.save(video);

    await this.processingProducer.enqueueVideoProcessing(saved.id);

    return saved;
  }

  async abortUpload(userId: string, videoId: string): Promise<void> {
    const video = await this.findOwnedVideo(userId, videoId);

    if (video.status !== VideoStatus.DRAFT) {
      throw new InvalidVideoStateException(
        `Only a draft upload can be aborted (current status: ${video.status})`,
      );
    }

    if (video.upload_id) {
      await this.storageService.abortMultipartUpload(
        video.storage_key,
        video.upload_id,
      );
    }

    await this.videoRepository.remove(video);
  }

  private async findOwnedVideo(userId: string, videoId: string): Promise<Video> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new ChannelNotFoundException();
    }

    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });

    // A video owned by someone else is reported as missing, so ownership
    // probing cannot be used to discover which video ids exist.
    if (!video || video.channel_id !== channel.id) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  async findByPublicId(publicId: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId },
      relations: { channel: true },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  /** Resolves a video for public consumption; unfinished videos stay hidden. */
  async findReadyByPublicId(publicId: string): Promise<Video> {
    const video = await this.findByPublicId(publicId);
    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException();
    }
    return video;
  }

  async getStreamUrl(publicId: string): Promise<string> {
    const video = await this.findReadyByPublicId(publicId);
    return this.storageService.getPresignedDownloadUrl(
      this.storageService.videosBucket,
      video.storage_key,
    );
  }

  async getDownloadUrl(publicId: string): Promise<string> {
    const video = await this.findReadyByPublicId(publicId);
    return this.storageService.getPresignedDownloadUrl(
      this.storageService.videosBucket,
      video.storage_key,
      {
        downloadFilename: sanitizeDownloadFilename(video.original_filename),
        contentType: 'application/octet-stream',
      },
    );
  }
}
