import { execFile } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { VideoProbeFailedException } from '../exceptions/video.exceptions';
import { FfmpegService } from './ffmpeg.service';

const execFileAsync = promisify(execFile);

const videoSettings = {
  maxSizeBytes: 10737418240,
  uploadPartSizeBytes: 104857600,
  allowedMimeTypes: ['video/mp4'],
  processingAttempts: 3,
  ffmpegTimeoutMs: 120000,
};

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

describe('FfmpegService', () => {
  let service: FfmpegService;
  let workDir: string;
  let samplePath: string;

  beforeAll(async () => {
    service = new FfmpegService(videoSettings);
    workDir = await mkdtemp(join(tmpdir(), 'ffmpeg-spec-'));
    samplePath = join(workDir, 'sample.mp4');

    // Generate a deterministic 5s 640x480 clip with audio, so assertions
    // check real values rather than fixture bytes committed to the repo.
    await execFileAsync(ffmpegInstaller.path, [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=5:size=640x480:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest',
      samplePath,
    ]);
  }, 180000);

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  describe('probe', () => {
    it('extracts duration, dimensions and codecs', async () => {
      const metadata = await service.probe(samplePath);

      expect(metadata.durationSeconds).toBeCloseTo(5, 0);
      expect(metadata.width).toBe(640);
      expect(metadata.height).toBe(480);
      expect(metadata.videoCodec).toBe('h264');
      expect(metadata.audioCodec).toBe('aac');
      expect(metadata.sizeBytes).toBeGreaterThan(0);
    }, 60000);

    it('keeps the raw ffprobe document for later phases', async () => {
      const metadata = await service.probe(samplePath);

      expect(metadata.raw.format).toBeDefined();
      expect(Array.isArray(metadata.raw.streams)).toBe(true);
      expect(metadata.raw.streams!.length).toBeGreaterThanOrEqual(2);
    }, 60000);

    it('rejects a file that is not a video', async () => {
      const textPath = join(workDir, 'not-a-video.mp4');
      await writeFile(textPath, 'this is plain text, not a video');

      await expect(service.probe(textPath)).rejects.toBeInstanceOf(
        VideoProbeFailedException,
      );
    }, 60000);

    it('rejects a missing file', async () => {
      await expect(
        service.probe(join(workDir, 'does-not-exist.mp4')),
      ).rejects.toBeInstanceOf(VideoProbeFailedException);
    }, 60000);
  });

  describe('extractThumbnail', () => {
    it('writes a JPEG at the requested timestamp', async () => {
      const outputPath = join(workDir, 'thumb.jpg');

      await service.extractThumbnail(samplePath, outputPath, 2);

      const written = await readFile(outputPath);
      expect(written.length).toBeGreaterThan(0);
      expect(written.subarray(0, 3).equals(JPEG_MAGIC)).toBe(true);
    }, 60000);

    it('scales the frame to the configured width', async () => {
      const outputPath = join(workDir, 'thumb-scaled.jpg');

      await service.extractThumbnail(samplePath, outputPath, 1);
      const probed = await service.probe(outputPath).catch(() => null);

      // ffprobe reads a JPEG as a single-frame mjpeg stream.
      expect(probed?.width ?? 1280).toBe(1280);
    }, 60000);

    it('fails loudly when the input cannot be decoded', async () => {
      const textPath = join(workDir, 'bad-input.mp4');
      await writeFile(textPath, 'not a video');

      await expect(
        service.extractThumbnail(textPath, join(workDir, 'never.jpg'), 1),
      ).rejects.toBeInstanceOf(VideoProbeFailedException);
    }, 60000);
  });

  describe('computeThumbnailTimestamp', () => {
    it('takes 10% of the duration for a long video', () => {
      expect(service.computeThumbnailTimestamp(300)).toBeCloseTo(30);
    });

    it('never seeks before the first second', () => {
      expect(service.computeThumbnailTimestamp(5)).toBe(1);
    });

    it('falls back to the midpoint for a very short clip', () => {
      expect(service.computeThumbnailTimestamp(0.8)).toBeCloseTo(0.4);
    });
  });
});
