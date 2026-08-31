import { execFile } from 'child_process';
import { promisify } from 'util';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import videoConfig from '../../config/video.config';
import { VideoProbeFailedException } from '../exceptions/video.exceptions';

const execFileAsync = promisify(execFile);

const MAX_PROBE_OUTPUT_BYTES = 10 * 1024 * 1024;
const THUMBNAIL_WIDTH = 1280;
const THUMBNAIL_POSITION_RATIO = 0.1;
const MIN_THUMBNAIL_TIMESTAMP_SECONDS = 1;

export interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  [key: string]: unknown;
}

export interface ProbeOutput {
  format?: Record<string, unknown>;
  streams?: ProbeStream[];
}

export interface VideoMetadata {
  durationSeconds: number;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  bitrate: number | null;
  sizeBytes: number | null;
  raw: ProbeOutput;
}

/**
 * Thin wrapper over the ffprobe/ffmpeg binaries. Both are invoked through
 * execFile with an argument array, so no shell ever parses a filename, and
 * both are bounded by an explicit timeout so a malformed file cannot hang
 * the worker.
 */
@Injectable()
export class FfmpegService {
  private readonly logger = new Logger(FfmpegService.name);

  constructor(
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
  ) {}

  async probe(filePath: string): Promise<VideoMetadata> {
    let stdout: string;

    try {
      const result = await execFileAsync(
        ffprobeInstaller.path,
        [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          filePath,
        ],
        {
          timeout: this.config.ffmpegTimeoutMs,
          maxBuffer: MAX_PROBE_OUTPUT_BYTES,
        },
      );
      stdout = result.stdout;
    } catch (error) {
      throw new VideoProbeFailedException(
        error instanceof Error ? error.message : String(error),
      );
    }

    let parsed: ProbeOutput;
    try {
      parsed = JSON.parse(stdout) as ProbeOutput;
    } catch {
      throw new VideoProbeFailedException('ffprobe returned malformed JSON');
    }

    const videoStream = parsed.streams?.find(
      (stream) => stream.codec_type === 'video',
    );
    if (!videoStream) {
      throw new VideoProbeFailedException('no video stream found');
    }

    const audioStream = parsed.streams?.find(
      (stream) => stream.codec_type === 'audio',
    );

    const duration = this.toNumber(parsed.format?.duration);
    if (duration === null || duration <= 0) {
      throw new VideoProbeFailedException('could not determine duration');
    }

    return {
      durationSeconds: duration,
      width: videoStream.width ?? null,
      height: videoStream.height ?? null,
      videoCodec: videoStream.codec_name ?? null,
      audioCodec: audioStream?.codec_name ?? null,
      bitrate: this.toNumber(parsed.format?.bit_rate),
      sizeBytes: this.toNumber(parsed.format?.size),
      raw: parsed,
    };
  }

  async extractThumbnail(
    filePath: string,
    outputPath: string,
    atSeconds: number,
  ): Promise<void> {
    try {
      await execFileAsync(
        ffmpegInstaller.path,
        [
          '-y',
          // Placed before -i so the seek happens on input: cost does not
          // scale with file size.
          '-ss',
          atSeconds.toFixed(3),
          '-i',
          filePath,
          '-frames:v',
          '1',
          // -2 keeps the derived height even, which the JPEG encoder requires.
          '-vf',
          `scale=${THUMBNAIL_WIDTH}:-2`,
          '-q:v',
          '2',
          outputPath,
        ],
        {
          timeout: this.config.ffmpegTimeoutMs,
          maxBuffer: MAX_PROBE_OUTPUT_BYTES,
        },
      );
    } catch (error) {
      throw new VideoProbeFailedException(
        `thumbnail extraction failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Frame position for the thumbnail: 10% into the video, never before the
   * first second, and never past the end of a very short clip.
   */
  computeThumbnailTimestamp(durationSeconds: number): number {
    const proportional = durationSeconds * THUMBNAIL_POSITION_RATIO;
    const candidate = Math.max(MIN_THUMBNAIL_TIMESTAMP_SECONDS, proportional);
    if (candidate >= durationSeconds) {
      return Math.max(0, durationSeconds / 2);
    }
    return candidate;
  }

  private toNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }
}
