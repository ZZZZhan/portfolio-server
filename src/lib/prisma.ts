import { PrismaPg } from '@prisma/adapter-pg';
import 'dotenv/config';

// 全局共享的 PrismaPg adapter（管理底层 pg 连接池）。
// better-auth 的 PrismaClient 与 NestJS 的 PrismaService 各自 new，
// 但共用同一个 adapter 实例，从而共用同一个连接池，避免重复建池。
// 注意：better-auth 实例化早于 NestFactory，因此这里需自行加载 dotenv。
let adapter: PrismaPg | undefined;

export function getPrismaAdapter(): PrismaPg {
  if (!adapter) {
    adapter = new PrismaPg({
      connectionString: process.env.DATABASE_URL,
    });
  }
  return adapter;
}
