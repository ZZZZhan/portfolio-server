import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Client } from 'pg';
import 'dotenv/config';

/**
 * 定时任务的互斥锁 key。
 *
 * Postgres advisory lock 以一个 bigint 作标识、在整个数据库范围内互斥，
 * 数值本身没有含义，只要求各任务之间不重复。
 */
export const LOCK_KEYS = {
  dailySnapshot: 48201,
  settleOtcTrades: 48202,
  startupBackfill: 48203,
} as const;

/**
 * 持锁连接。只用到 query / end 两个方法，便于测试注入 fake。
 */
export interface LockConnection {
  query<T>(sql: string, params: unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<void>;
}

/** 建立持锁连接的工厂 —— 网络调用集中在此 token（同 PRICE_HTTP_FETCHER 模式） */
export type LockConnector = () => Promise<LockConnection>;

export const LOCK_CONNECTOR = 'LOCK_CONNECTOR';

/**
 * 默认实现：为每次加锁单开一条 pg 连接。
 *
 * 不复用 PrismaService：session 级 advisory lock 绑定在**具体连接**上，
 * 而 Prisma 走连接池，加锁与解锁两次查询可能落在不同连接上 —— 解锁会失效、
 * 锁一直留到连接被回收。专用连接同时保证了进程崩溃时锁自动释放（连接断开即释放）。
 */
const defaultConnector: LockConnector = async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  return client;
};

/**
 * 跨实例互斥执行定时任务。
 *
 * 解决的问题：@nestjs/schedule 是进程内定时器，多实例部署时每个实例都会到点触发。
 * 快照是同组合同日 upsert、幂等，但微信推送不是 —— 用户会收到多条重复提醒。
 *
 * 用 pg_try_advisory_lock 而非 pg_advisory_lock：抢不到锁说明别的实例正在跑，
 * 直接跳过即可，排队等待只会让同一份工作再做一遍。
 */
@Injectable()
export class AdvisoryLockService {
  private readonly logger = new Logger(AdvisoryLockService.name);
  private readonly connect: LockConnector;

  constructor(@Optional() @Inject(LOCK_CONNECTOR) connector?: LockConnector) {
    this.connect = connector ?? defaultConnector;
  }

  /**
   * 抢到锁才执行 fn，抢不到直接返回 false（不等待、不执行）。
   *
   * fn 抛出的异常会照常向上抛，但锁与连接一定会被释放。
   *
   * @param key      LOCK_KEYS 里的任务标识
   * @param taskName 日志用的任务名
   * @returns 是否真的执行了 fn
   */
  async runExclusive(
    key: number,
    taskName: string,
    fn: () => Promise<void>,
  ): Promise<boolean> {
    const conn = await this.connect();
    try {
      const { rows } = await conn.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [key],
      );
      if (!rows[0]?.locked) {
        this.logger.log(`${taskName}：另一实例正在执行，本实例跳过`);
        return false;
      }

      try {
        await fn();
      } finally {
        await conn.query('SELECT pg_advisory_unlock($1)', [key]);
      }
      return true;
    } finally {
      await conn.end();
    }
  }
}
