import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { Video } from './entities/video.entity';
import { VideosModule } from './videos.module';

describe('VideosModule', () => {
  it('compiles and registers the Video repository', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [VideosModule],
    })
      .overrideProvider(getRepositoryToken(Video))
      .useValue({})
      .overrideProvider(DataSource)
      .useValue({})
      .compile();

    expect(moduleRef.get(getRepositoryToken(Video))).toBeDefined();
    await moduleRef.close();
  });
});
