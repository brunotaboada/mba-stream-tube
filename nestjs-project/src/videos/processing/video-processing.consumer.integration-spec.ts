import { execFile } from 'child_process';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { Job } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import databaseConfig from '../../config/database.config';
import queueConfig from '../../config/queue.config';
import storageConfig from '../../config/storage.config';
import videoConfig from '../../config/video.config';
import { StorageModule } from '../../storage/storage.module';
import { StorageService } from '../../storage/storage.service';
import { cleanAllTables } from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { VideoStatus } from '../entities/video-status.enum';
import { Video } from '../entities/video.entity';
import { FfmpegService } from './ffmpeg.service';
import { VideoProcessingConsumer } from './video-processing.consumer';

const execFileAsync = promisify(execFile);

describe('VideoProcessingConsumer (integration)', () => {
  let moduleRef: TestingModule;
  let consumer: VideoProcessingConsumer;
  let storage: StorageService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let workDir: string;
  let sampleVideo: Buffer;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [databaseConfig, storageConfig, queueConfig, videoConfig],
        }),
        TypeOrmModule.forRootAsync({
          inject: [databaseConfig.KEY],
          useFactory: (config: ReturnType<typeof databaseConfig>) => ({
            type: 'postgres' as const,
            host: config.host,
            port: config.port,
            username: config.username,
            password: config.password,
            database: config.name,
            entities: [User, Channel, RefreshToken, VerificationToken, Video],
            synchronize: false,
          }),
        }),
        TypeOrmModule.forFeature([Video, Channel]),
        StorageModule,
      ],
      providers: [FfmpegService, VideoProcessingConsumer],
    }).compile();

    consumer = moduleRef.get(VideoProcessingConsumer);
    storage = moduleRef.get(StorageService);
    dataSource = moduleRef.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);

    workDir = await mkdtemp(join(tmpdir(), 'consumer-spec-'));
    const samplePath = join(workDir, 'sample.mp4');
    await execFileAsync(ffmpegInstaller.path, [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=4:size=320x240:rate=25',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest',
      samplePath,
    ]);
    sampleVideo = await readFile(samplePath);
  }, 180000);

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
    await cleanAllTables(dataSource);
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function seedVideo(body: Buffer): Promise<Video> {
    const n = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `consumer_${n}_${Date.now()}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: `chan_${n}`,
        nickname: `consumer_${n}_${Date.now()}`,
        user_id: user.id,
      }),
    );
    const video = await videoRepository.save(
      videoRepository.create({
        public_id: `cons${n}${Date.now() % 100000}`.slice(0, 11),
        channel_id: channel.id,
        title: 'Sample',
        status: VideoStatus.PROCESSING,
        storage_key: 'placeholder',
        original_filename: 'sample.mp4',
        content_type: 'video/mp4',
      }),
    );
    video.storage_key = `${video.id}/source.mp4`;
    await videoRepository.save(video);

    await storage.putObject(
      storage.videosBucket,
      video.storage_key,
      body,
      'video/mp4',
    );
    return video;
  }

  function makeJob(videoId: string, attemptsMade = 3): Job<{ videoId: string }> {
    return {
      data: { videoId },
      attemptsMade,
      opts: { attempts: 3 },
    } as Job<{ videoId: string }>;
  }

  it('probes the video, generates a thumbnail and marks it ready', async () => {
    const video = await seedVideo(sampleVideo);

    await consumer.process(makeJob(video.id));

    const processed = await videoRepository.findOneByOrFail({ id: video.id });
    expect(processed.status).toBe(VideoStatus.READY);
    expect(Number(processed.duration_seconds)).toBeCloseTo(4, 0);
    expect(processed.width).toBe(320);
    expect(processed.height).toBe(240);
    expect(processed.video_codec).toBe('h264');
    expect(processed.audio_codec).toBe('aac');
    expect(processed.thumbnail_key).toBe(`${video.id}.jpg`);
    expect(processed.metadata).toBeTruthy();
    expect(processed.processing_error).toBeNull();

    const thumbUrl = storage.buildPublicUrl(
      storage.thumbnailsBucket,
      processed.thumbnail_key!,
    );
    const response = await fetch(thumbUrl);
    expect(response.status).toBe(200);
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(
      true,
    );
  }, 180000);

  it('is idempotent: reprocessing a ready video changes nothing', async () => {
    const video = await seedVideo(sampleVideo);
    await consumer.process(makeJob(video.id));
    const first = await videoRepository.findOneByOrFail({ id: video.id });

    await consumer.process(makeJob(video.id));

    const second = await videoRepository.findOneByOrFail({ id: video.id });
    expect(second.status).toBe(VideoStatus.READY);
    expect(second.updated_at.getTime()).toBe(first.updated_at.getTime());
  }, 180000);

  it('returns quietly when the video row no longer exists', async () => {
    await expect(
      consumer.process(makeJob('00000000-0000-0000-0000-000000000000')),
    ).resolves.toBeUndefined();
  }, 60000);

  it('marks a corrupt upload as failed with a stored reason on the final attempt', async () => {
    const video = await seedVideo(Buffer.from('this is not a video file'));

    const job = makeJob(video.id);
    await expect(consumer.process(job)).rejects.toBeDefined();
    await consumer.onFailed(job, new Error('no video stream found'));

    const failed = await videoRepository.findOneByOrFail({ id: video.id });
    expect(failed.status).toBe(VideoStatus.FAILED);
    expect(failed.processing_error).toContain('no video stream');
  }, 120000);

  it('leaves the video in processing while retries remain', async () => {
    const video = await seedVideo(Buffer.from('still not a video'));
    const job = makeJob(video.id, 1);

    await expect(consumer.process(job)).rejects.toBeDefined();
    await consumer.onFailed(job, new Error('transient failure'));

    const stillProcessing = await videoRepository.findOneByOrFail({
      id: video.id,
    });
    expect(stillProcessing.status).toBe(VideoStatus.PROCESSING);
  }, 120000);
});
