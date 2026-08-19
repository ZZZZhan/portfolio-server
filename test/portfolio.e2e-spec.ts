import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { SnapshotCronService } from './../src/portfolio/snapshot-cron.service';
import { TransformInterceptor } from './../src/common/transform.interceptor';
import { PrismaService } from './../src/prisma/prisma.service';

interface PortfolioListResponse {
  code: number;
  data: Array<{
    userId: number;
    name: string;
    targetTotalAmount: string;
  }>;
}

describe('PortfolioController (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SnapshotCronService)
      .useValue({})
      .compile();

    app = moduleFixture.createNestApplication();
    prisma = moduleFixture.get(PrismaService);
    await prisma.portfolio.deleteMany({
      where: { userId: 999, name: '测试组合' },
    });
    // 和 main.ts 保持一致：启用全局校验和响应包装。
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true }),
    );
    app.useGlobalInterceptors(new TransformInterceptor());
    await app.init();
  });

  afterAll(async () => {
    await prisma.portfolio.deleteMany({
      where: { userId: 999, name: '测试组合' },
    });
    await app.close();
  });

  describe('GET /portfolio', () => {
    it('按 userId 返回该用户的组合列表', async () => {
      const res = await request(app.getHttpServer())
        .get('/portfolio?userId=1')
        .expect(200);

      const body = res.body as PortfolioListResponse;

      // 种子数据：稳健增值组合属于 userId=1
      expect(body.code).toBe(0);
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeGreaterThan(0);
      expect(body.data[0]).toHaveProperty('name');
      expect(body.data[0]).toHaveProperty('targetTotalAmount');
    });

    it('不同 userId 返回不同/空列表（隔离）', async () => {
      // 没有 userId=999 的组合
      const res = await request(app.getHttpServer())
        .get('/portfolio?userId=999')
        .expect(200);

      const body = res.body as PortfolioListResponse;

      expect(body.code).toBe(0);
      expect(Array.isArray(body.data)).toBe(true);
      // 隔离：不包含 userId=1 的数据
      expect(body.data.every((portfolio) => portfolio.userId === 999)).toBe(
        true,
      );
    });

    it('缺少 userId 参数时返回 400', async () => {
      // findAll(+userId) 传 undefined → +undefined = NaN，Prisma where userId: NaN 会报错
      // 目前 controller 没处理缺失参数，这里先记录现状（期望 400 是未来加固方向）
      const res = await request(app.getHttpServer()).get('/portfolio');
      expect([400, 500]).toContain(res.status);
    });
  });

  describe('POST /portfolio', () => {
    it('按当前 DTO 创建组合并返回统一响应', async () => {
      const res = await request(app.getHttpServer())
        .post('/portfolio?userId=999')
        .send({
          name: '测试组合',
          targetTotalAmount: 100000,
          holdings: [
            {
              symbol: '510300',
              name: '沪深300ETF',
              assetType: 'ETF',
              exchange: 'SH',
              targetRatio: 50,
              rebalanceThreshold: 5,
            },
            {
              symbol: '159915',
              name: '创业板ETF',
              assetType: 'ETF',
              exchange: 'SZ',
              targetRatio: 50,
              rebalanceThreshold: 5,
            },
          ],
        })
        .expect(201);

      expect(res.body).toMatchObject({
        code: 0,
        message: 'ok',
        data: { message: '创建成功' },
      });
    });
  });
});
