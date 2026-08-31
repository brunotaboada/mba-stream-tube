import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import databaseConfig from '../config/database.config';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { QueueModule } from '../queue/queue.module';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { VideoStatus } from './entities/video-status.enum';
import { Video } from './entities/video.entity';
import { InvalidVideoStateException } from './exceptions/video.exceptions';
import { VideosService } from './videos.service';

const PART_SIZE = 5 * 1024 * 1024;

describe('VideosService (integration)', () => {
  let moduleRef: TestingModule;
  let service: VideosService;
  let storage: StorageService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let userRepository: Repository<User>;
  let queue: Queue;

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
        QueueModule,
      ],
      providers: [VideosService, ChannelsService],
    }).compile();

    service = moduleRef.get(VideosService);
    storage = moduleRef.get(StorageService);
    dataSource = moduleRef.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    userRepository = dataSource.getRepository(User);
    queue = moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
  }, 60000);

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await cleanAllTables(dataSource);
    await moduleRef.close();
  });

  let counter = 0;
  async function createOwner(): Promise<User> {
    const user = await userRepository.save(
      userRepository.create({
        email: `videos_svc_${++counter}_${Date.now()}@example.com`,
        password: 'hashed',
      }),
    );
    await moduleRef.get(ChannelsService).createChannel(user.id, user.email);
    return user;
  }

  beforeEach(async () => {
    await queue.obliterate({ force: true });
    await cleanAllTables(dataSource);
  });

  async function uploadPart(url: string, body: Buffer): Promise<string> {
    const response = await fetch(url, {
      method: 'PUT',
      body: new Uint8Array(body),
    });
    expect(response.status).toBe(200);
    return response.headers.get('etag')!;
  }

  it('pre-registers the video as a draft bound to the owner channel', async () => {
    const user = await createOwner();

    const result = await service.initiateUpload(user.id, {
      filename: 'holiday.mp4',
      contentType: 'video/mp4',
      sizeBytes: 1024,
    });

    const stored = await videoRepository.findOneByOrFail({ id: result.videoId });
    expect(stored.status).toBe(VideoStatus.DRAFT);
    expect(stored.public_id).toHaveLength(11);
    expect(stored.storage_key).toBe(`${stored.id}/source.mp4`);
    expect(stored.upload_id).toBeTruthy();
    expect(result.parts).toHaveLength(1);
  }, 60000);

  it('completes a genuine multipart upload, moves to processing and enqueues one job', async () => {
    const user = await createOwner();
    const first = Buffer.alloc(PART_SIZE, 'a');
    const second = Buffer.from('tail');

    const initiated = await service.initiateUpload(user.id, {
      filename: 'clip.mp4',
      contentType: 'video/mp4',
      sizeBytes: first.length + second.length,
    });
    expect(initiated.parts.length).toBeGreaterThanOrEqual(1);

    const uploadId = initiated.uploadId;
    const key = `${initiated.videoId}/source.mp4`;
    const partUrls = await storage.getPartUploadUrls(key, uploadId, 2);
    const etag1 = await uploadPart(partUrls[0].url, first);
    const etag2 = await uploadPart(partUrls[1].url, second);

    const completed = await service.completeUpload(user.id, initiated.videoId, {
      uploadId,
      parts: [
        { partNumber: 1, etag: etag1 },
        { partNumber: 2, etag: etag2 },
      ],
    });

    expect(completed.status).toBe(VideoStatus.PROCESSING);
    expect(completed.upload_id).toBeNull();

    const url = await storage.getPresignedDownloadUrl(storage.videosBucket, key);
    const downloaded = Buffer.from(await (await fetch(url)).arrayBuffer());
    expect(downloaded.length).toBe(first.length + second.length);

    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].data).toEqual({ videoId: initiated.videoId });
  }, 120000);

  it('refuses to complete the same upload twice', async () => {
    const user = await createOwner();
    const body = Buffer.alloc(PART_SIZE, 'b');
    const initiated = await service.initiateUpload(user.id, {
      filename: 'clip.mp4',
      contentType: 'video/mp4',
      sizeBytes: body.length,
    });
    const key = `${initiated.videoId}/source.mp4`;
    const partUrls = await storage.getPartUploadUrls(
      key,
      initiated.uploadId,
      1,
    );
    const etag = await uploadPart(partUrls[0].url, body);
    const parts = [{ partNumber: 1, etag }];

    await service.completeUpload(user.id, initiated.videoId, {
      uploadId: initiated.uploadId,
      parts,
    });

    await expect(
      service.completeUpload(user.id, initiated.videoId, {
        uploadId: initiated.uploadId,
        parts,
      }),
    ).rejects.toBeInstanceOf(InvalidVideoStateException);
  }, 120000);

  it('abort removes both the pending upload and the draft row', async () => {
    const user = await createOwner();
    const initiated = await service.initiateUpload(user.id, {
      filename: 'discard.mp4',
      contentType: 'video/mp4',
      sizeBytes: 2048,
    });

    await service.abortUpload(user.id, initiated.videoId);

    await expect(
      videoRepository.findOneBy({ id: initiated.videoId }),
    ).resolves.toBeNull();

    const url = await storage.getPresignedDownloadUrl(
      storage.videosBucket,
      `${initiated.videoId}/source.mp4`,
    );
    expect((await fetch(url)).status).toBe(404);
  }, 60000);

  it('gives every video a distinct public id', async () => {
    const user = await createOwner();

    const created = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        service.initiateUpload(user.id, {
          filename: `clip-${index}.mp4`,
          contentType: 'video/mp4',
          sizeBytes: 1024,
        }),
      ),
    );

    const publicIds = new Set(created.map((item) => item.publicId));
    expect(publicIds.size).toBe(5);
  }, 60000);
});
