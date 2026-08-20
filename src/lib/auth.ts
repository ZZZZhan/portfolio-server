import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { PrismaClient } from '../generated/prisma/client';
import { getPrismaAdapter } from './prisma';
import 'dotenv/config';

// better-auth 自有的 PrismaClient（与 NestJS 的 PrismaService 共享同一个 adapter 连接池）
const prisma = new PrismaClient({ adapter: getPrismaAdapter() });

// Better Auth 实例。在 NestFactory 启动前执行，故需自行加载 dotenv。
export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL, // http://localhost:3001
  secret: process.env.BETTER_AUTH_SECRET,
  basePath: '/api/auth', // 默认即此值，显式写出便于对照前端
  database: prismaAdapter(prisma, {
    provider: 'postgresql', // 项目用 PostgreSQL
  }),
  emailAndPassword: { enabled: true }, // 开启邮箱密码注册/登录
  user: {
    // 自定义用户字段：随 session 一起返回，前端 useSession 可直接读到。
    // 想加更多字段就照这里的形状追加（CLI 会同步到 DB schema）。
    additionalFields: {
      // 行情更新模式：盘后 / 实时
      marketUpdateMode: {
        type: ['AFTER_CLOSE', 'REALTIME'],
        required: false,
        defaultValue: 'AFTER_CLOSE',
        input: true, // 允许用户/前端修改
      },
      // 微信推送 SendKey（Server酱）。用户可填、可改，未填则推送跳过。
      sendkey: {
        type: 'string',
        required: false,
        input: true, // 允许用户/前端修改
      },
    },
  },
  trustedOrigins: [
    // 前端跨域来源（库会据此为 /api/auth/* 注入 CORS 头）
    process.env.FRONTEND_URL ?? 'http://localhost:3000',
  ],
});
