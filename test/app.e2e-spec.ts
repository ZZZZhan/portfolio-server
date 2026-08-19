import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { SnapshotCronService } from './../src/portfolio/snapshot-cron.service';
import { TransformInterceptor } from './../src/common/transform.interceptor';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SnapshotCronService)
      .useValue({})
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalInterceptors(new TransformInterceptor());
    await app.init();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer()).get('/').expect(200).expect({
      code: 0,
      message: 'ok',
      data: 'portfolio-server is running',
    });
  });

  afterAll(async () => {
    await app.close();
  });
});
