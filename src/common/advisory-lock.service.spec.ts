import { AdvisoryLockService, LockConnection } from './advisory-lock.service';

/** 记录 SQL 调用顺序的 fake 连接 */
function fakeConn(locked: boolean) {
  const calls: string[] = [];
  const conn: LockConnection = {
    query: <T>(sql: string) => {
      calls.push(sql);
      return Promise.resolve({
        rows: [{ locked } as unknown as T],
      });
    },
    end: () => {
      calls.push('END');
      return Promise.resolve();
    },
  };
  return { conn, calls };
}

describe('AdvisoryLockService', () => {
  it('抢到锁：执行任务，随后解锁并关连接', async () => {
    const { conn, calls } = fakeConn(true);
    const service = new AdvisoryLockService(() => Promise.resolve(conn));
    const fn = jest.fn().mockResolvedValue(undefined);

    const ran = await service.runExclusive(1, '测试任务', fn);

    expect(ran).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([
      'SELECT pg_try_advisory_lock($1) AS locked',
      'SELECT pg_advisory_unlock($1)',
      'END',
    ]);
  });

  it('抢不到锁：不执行任务，也不解锁别人的锁', async () => {
    const { conn, calls } = fakeConn(false);
    const service = new AdvisoryLockService(() => Promise.resolve(conn));
    const fn = jest.fn().mockResolvedValue(undefined);

    const ran = await service.runExclusive(1, '测试任务', fn);

    expect(ran).toBe(false);
    expect(fn).not.toHaveBeenCalled();
    // 关键：没有 unlock —— 锁是别的实例持有的，误解锁会让两边同时跑
    expect(calls).toEqual(['SELECT pg_try_advisory_lock($1) AS locked', 'END']);
  });

  it('任务抛错：异常照常上抛，但锁和连接都已释放', async () => {
    const { conn, calls } = fakeConn(true);
    const service = new AdvisoryLockService(() => Promise.resolve(conn));
    const boom = new Error('任务炸了');

    await expect(
      service.runExclusive(1, '测试任务', () => Promise.reject(boom)),
    ).rejects.toBe(boom);

    expect(calls).toEqual([
      'SELECT pg_try_advisory_lock($1) AS locked',
      'SELECT pg_advisory_unlock($1)',
      'END',
    ]);
  });
});
