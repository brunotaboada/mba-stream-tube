import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { VideoProcessingConsumer } from '../videos/processing/video-processing.consumer';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  it('compiles and resolves the processing consumer without any HTTP controller', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    })
      .overrideProvider(DataSource)
      .useValue({})
      .overrideProvider(getRepositoryToken(Video))
      .useValue({})
      .overrideProvider(getRepositoryToken(Channel))
      .useValue({})
      .overrideProvider(getRepositoryToken(User))
      .useValue({})
      .compile();

    expect(moduleRef.get(VideoProcessingConsumer)).toBeDefined();

    await moduleRef.close();
  }, 60000);
});
