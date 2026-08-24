import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import type { Agent } from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { SnapshotCronService } from './../src/portfolio/snapshot-cron.service';
import { TransformInterceptor } from './../src/common/transform.interceptor';
import { PrismaService } from './../src/prisma/prisma.service';

/**
 * Portfolio API e2e（认证链路）。
 *
 * 测试缝：真实 AppModule（含 AuthModule）连真实 Postgres 测试库，
 * 用 better-auth 注册真实用户拿会话 cookie，从而通过全局 AuthGuard。
 * 所有数据用固定邮箱/组合名，afterAll 清理，不依赖 seed。
 */
describe('PortfolioController (e2e)', () => {
  let app: INestApplication<App>;
  let agent: Agent; // 带 cookie 的请求代理
  let prisma: PrismaService;

  const email = `e2e-${Date.now()}@portfolio.test`;
  const userBEmail = `e2e-${Date.now()}-b@portfolio.test`;
  const password = 'password123';
  const portfolioName = 'e2e 认证组合';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SnapshotCronService)
      .useValue({}) // 禁掉 cron 补跑，避免测试期间写快照
      .compile();

    app = moduleFixture.createNestApplication();
    prisma = moduleFixture.get(PrismaService);
    // 和 main.ts 保持一致：启用全局 /api 前缀、校验、统一响应包装。
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.useGlobalInterceptors(new TransformInterceptor());
    await app.init();

    agent = request.agent(app.getHttpServer());
    // 注册用户 → 拿到会话 cookie（HttpOnly）。
    const res = await agent
      .post('/api/auth/sign-up/email')
      .set('Origin', 'http://localhost:3000')
      .send({ name: 'e2e 用户', email, password })
      .expect(200);
    if (!(res.body as { token?: string }).token) {
      throw new Error('e2e 注册未返回 token，认证链路异常');
    }
  });

  afterAll(async () => {
    // 清理该用户的所有业务数据（先业务表再由外键级联无依赖，直接按 userId 删组合即可级联 holding/trade/snapshot）
    for (const mail of [email, userBEmail]) {
      const user = await prisma.user.findUnique({ where: { email: mail } });
      if (user?.id) {
        await prisma.portfolio.deleteMany({ where: { userId: user.id } });
        await prisma.session.deleteMany({ where: { userId: user.id } });
        await prisma.account.deleteMany({ where: { userId: user.id } });
        await prisma.user.delete({ where: { id: user.id } });
      }
    }
    await app.close();
  });

  describe('GET /api/portfolio', () => {
    it('未登录被全局 AuthGuard 拒绝（401）', async () => {
      await request(app.getHttpServer()).get('/api/portfolio').expect(401);
    });

    it('登录后返回该用户（空）组合列表', async () => {
      const res = await agent.get('/api/portfolio').expect(200);
      expect(res.body.code).toBe(0);
      expect(Array.isArray(res.body.data)).toBe(true);
      // 新注册用户此时还没有组合
      expect(res.body.data).toHaveLength(0);
    });
  });

  describe('POST /api/portfolio', () => {
    it('登录后创建组合（持仓标的自动 upsert Asset）', async () => {
      const res = await agent
        .post('/api/portfolio')
        .set('Origin', 'http://localhost:3000')
        .send({
          name: portfolioName,
          targetTotalAmount: 100000,
          holdings: [
            {
              symbol: '510300',
              name: '沪深300ETF',
              assetType: 'ETF',
              exchange: 'SH',
              targetRatio: 60,
              rebalanceThreshold: 5,
            },
            {
              symbol: '159915',
              name: '创业板ETF',
              assetType: 'ETF',
              exchange: 'SZ',
              targetRatio: 40,
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

      // 组合确实入库
      const list = await agent.get('/api/portfolio').expect(200);
      const created = (list.body.data as Array<{ name: string }>).find(
        (p) => p.name === portfolioName,
      );
      expect(created).toBeTruthy();
    });

    it('配比之和不等于 100 时返回 400', async () => {
      const res = await agent
        .post('/api/portfolio')
        .set('Origin', 'http://localhost:3000')
        .send({
          name: '错误组合',
          targetTotalAmount: 100000,
          holdings: [
            {
              symbol: '511260',
              name: '债券基金',
              assetType: 'FUND',
              exchange: 'OTC',
              targetRatio: 30,
            },
          ],
        })
        .expect(400);
      expect(String(res.body.message)).toContain('目标配比之和必须为 100');
    });
  });

  describe('快照接口数据隔离', () => {
    let portfolioId: number;
    let userBAgent: Agent;

    beforeAll(async () => {
      // 取 userA（现有 agent）在前置用例里创建的组合 id
      const list = await agent.get('/api/portfolio').expect(200);
      const created = (
        list.body.data as Array<{ id: number; name: string }>
      ).find((p) => p.name === portfolioName);
      if (!created) throw new Error('未找到前置创建的组合');
      portfolioId = created.id;

      // 注册独立用户 userB，用于验证跨用户数据隔离
      userBAgent = request.agent(app.getHttpServer());
      const res = await userBAgent
        .post('/api/auth/sign-up/email')
        .set('Origin', 'http://localhost:3000')
        .send({ name: 'e2e 用户B', email: userBEmail, password })
        .expect(200);
      if (!(res.body as { token?: string }).token) {
        throw new Error('e2e 注册 userB 未返回 token，认证链路异常');
      }
    });

    it('userB 读取他人组合快照返回 404', async () => {
      await userBAgent
        .get(`/api/portfolio/${portfolioId}/snapshot`)
        .expect(404);
    });

    it('userB 触发他人组合快照计算返回 404（且不落库）', async () => {
      await userBAgent
        .post(`/api/portfolio/${portfolioId}/snapshot`)
        .expect(404);
    });

    it('userB 读取他人组合详情返回 404', async () => {
      await userBAgent.get(`/api/portfolio/${portfolioId}`).expect(404);
    });
  });
});