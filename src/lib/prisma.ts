import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import 'dotenv/config';

// 全局共享的 pg 连接池 + PrismaPg adapter（better-auth 的 PrismaClient 与
// NestJS 的 PrismaService 各自 new，但共用同一 adapter/池，避免重复建池）。
// 池由本模块自建并持有：Prisma 7 driver adapters 的 $disconnect() 不保证
// 关闭 adapter 的底层池，优雅停机/测试结束时仍需显式 pool.end()。
// 注意：better-auth 实例化早于 NestFactory，因此这里需自行加载 dotenv。
let pool: Pool | undefined;
let adapter: PrismaPg | undefined;

export function getPrismaAdapter(): PrismaPg {
  if (!adapter) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    adapter = new PrismaPg(pool, { disposeExternalPool: true });
  }
  return adapter;
}

/**
 * 关闭共享连接池（测试/优雅停机时调用），否则 pg 连接保持 Node 事件循环活跃。
 * 幂等：可重复调用，未初始化时为无操作。
 */
export async function disposePrismaAdapter(): Promise<void> {
  adapter = undefined;
  const p = pool;
  pool = undefined;
  if (p) {
    try {
      await p.end();
    } catch {
      // 池已关闭或无法干净结束时不阻塞停机流程
    }
  }
}
