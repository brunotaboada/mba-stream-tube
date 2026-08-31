import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { Video } from '../entities/video.entity';
import { VideoStatus } from '../entities/video-status.enum';

export class VideoChannelDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  nickname: string;

  @ApiProperty()
  name: string;
}

/**
 * Public projection of a video. The internal id, storage keys and raw
 * ffprobe document are deliberately absent.
 */
export class VideoResponseDto {
  @ApiProperty({ example: 'A1b2C3d4E5f' })
  publicId: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ enum: VideoStatus })
  status: VideoStatus;

  @ApiPropertyOptional({ type: Number, nullable: true })
  durationSeconds: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  width: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  height: number | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  thumbnailUrl: string | null;

  @ApiProperty({ type: VideoChannelDto })
  channel: VideoChannelDto;

  @ApiProperty()
  createdAt: Date;

  static fromEntity(video: Video, thumbnailUrl: string | null): VideoResponseDto {
    return {
      publicId: video.public_id,
      title: video.title,
      status: video.status,
      durationSeconds:
        video.duration_seconds === null ? null : Number(video.duration_seconds),
      width: video.width,
      height: video.height,
      thumbnailUrl,
      channel: {
        id: video.channel.id,
        nickname: video.channel.nickname,
        name: video.channel.name,
      },
      createdAt: video.created_at,
    };
  }
}

export class InitiateUploadPartDto {
  @ApiProperty({ example: 1 })
  partNumber: number;

  @ApiProperty({ description: 'Presigned PUT URL for this part' })
  url: string;
}

export class InitiateUploadResponseDto {
  @ApiProperty()
  videoId: string;

  @ApiProperty()
  publicId: string;

  @ApiProperty({ enum: VideoStatus })
  status: VideoStatus;

  @ApiProperty()
  uploadId: string;

  @ApiProperty()
  partSizeBytes: number;

  @ApiProperty({ type: [InitiateUploadPartDto] })
  parts: InitiateUploadPartDto[];

  @ApiProperty({ description: 'Seconds until the part URLs expire' })
  expiresIn: number;
}

export class CompleteUploadResponseDto {
  @ApiProperty()
  videoId: string;

  @ApiProperty()
  publicId: string;

  @ApiProperty({ enum: VideoStatus })
  status: VideoStatus;
}
