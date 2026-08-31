import { registerAs } from '@nestjs/config';

const DEFAULT_ALLOWED_MIME_TYPES =
  'video/mp4,video/quicktime,video/x-matroska,video/webm,video/x-msvideo';

export default registerAs('video', () => ({
  maxSizeBytes: parseInt(
    process.env.VIDEO_MAX_SIZE_BYTES || '10737418240',
    10,
  ),
  uploadPartSizeBytes: parseInt(
    process.env.VIDEO_UPLOAD_PART_SIZE_BYTES || '104857600',
    10,
  ),
  allowedMimeTypes: (
    process.env.VIDEO_ALLOWED_MIME_TYPES || DEFAULT_ALLOWED_MIME_TYPES
  )
    .split(',')
    .map((type) => type.trim())
    .filter((type) => type.length > 0),
  processingAttempts: parseInt(
    process.env.VIDEO_PROCESSING_ATTEMPTS || '3',
    10,
  ),
  ffmpegTimeoutMs: parseInt(
    process.env.VIDEO_FFMPEG_TIMEOUT_MS || '300000',
    10,
  ),
}));
