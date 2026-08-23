import { Exchange } from '../generated/prisma/client';
import { SnapshotService } from './snapshot.service';
import {
  PriceProvider,
  PriceQuery,
  PriceResult,
} from '../price-provider/price-provider';
import { PrismaService } from '../prisma/prisma.service';

/** 记录每次取价调用的假行情源 */
class RecordingProvider extends PriceProvider {
  calls: PriceQuery[][] = [];
  constructor(private table: Record<string, number> = {}) {
    super();
  }
  getPrices(queries: PriceQuery[]): Promise<PriceResult[]> {
    this.calls.push(queries);
    return Promise.resolve(
      queries
        .filter((q) => this.table[q.symbol] != null)
        .map((q) => ({
          symbol: q.symbol,
          price: this.table[q.symbol],
          date: '2026-08-23',
        })),
    );
  }
}

/** 三个组合共持有 4 个标的，其中 510300 被两个组合同时持有 */
const HOLDINGS_BY_PORTFOLIO: Record<number, string[]> = {
  1: ['510300', '513100'],
  2: ['510300', '159915'],
  3: ['511260'],
};

function fakePrisma() {
  const assetRows = [
    { symbol: '510300', exchange: Exchange.SH },
    { symbol: '513100', exchange: Exchange.SH },
    { symbol: '159915', exchange: Exchange.SZ },
    { symbol: '511260', exchange: Exchange.SH },
  ];
  return {
    asset: {
      findMany: jest.fn().mockResolvedValue(assetRows),
    },
    portfolio: {
      findUnique: jest.fn(({ where }: { where: { id: number } }) =>
        Promise.resolve({ id: where.id, targetTotalAmount: '10000' }),
      ),
    },
    holding: {
      findMany: jest.fn(({ where }: { where: { portfolioId: number } }) =>
        Promise.resolve(
          HOLDINGS_BY_PORTFOLIO[where.portfolioId].map((symbol, i) => ({
            id: i,
            targetRatio: 50,
            asset: {
              symbol,
              name: symbol,
              exchange: assetRows.find((a) => a.symbol === symbol)!.exchange,
            },
            trades: [],
          })),
        ),
      ),
    },
    dailySnapshot: {
      findFirst: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
    },
  };
}

function makeService(table: Record<string, number>) {
  const provider = new RecordingProvider(table);
  const prisma = fakePrisma();
  const service = new SnapshotService(
    prisma as unknown as PrismaService,
    provider,
  );
  return { service, provider, prisma };
}

const PRICES = { '510300': 4.0, '513100': 1.5, '159915': 2.2, '511260': 100.1 };

describe('SnapshotService 预取行情', () => {
  it('prefetchPrices 按标的并集只打一次源，重复持有的标的不重复查', async () => {
    const { service, provider } = makeService(PRICES);

    const prefetched = await service.prefetchPrices();

    expect(provider.calls).toHaveLength(1);
    // 510300 被组合 1、2 同时持有，但只出现一次
    const asked = provider.calls[0].map((q) => q.symbol);
    expect(asked).toEqual(['510300', '513100', '159915', '511260']);
    expect(prefetched.prices).toEqual(PRICES);
    expect(prefetched.marketDate).toBe('2026-08-23');
  });

  it('三个组合共用一次预取：整轮只打一次源，而非每组合一次', async () => {
    const { service, provider } = makeService(PRICES);

    const prefetched = await service.prefetchPrices();
    for (const id of [1, 2, 3]) {
      await service.calculateAndSave(id, new Date(), { prefetched });
    }

    // 关键：3 个组合算完，取价调用总数仍是 1（预取那次）
    expect(provider.calls).toHaveLength(1);
  });

  it('不传 prefetched 时维持原行为：每个组合各自取价', async () => {
    const { service, provider } = makeService(PRICES);

    for (const id of [1, 2, 3]) {
      await service.calculateAndSave(id, new Date());
    }

    expect(provider.calls).toHaveLength(3);
  });

  it('预取表里缺某标的时不影响其它组合，缺的走兜底（价格为 0）', async () => {
    // 行情源查不到 513100
    const { service, provider } = makeService({
      '510300': 4.0,
      '159915': 2.2,
      '511260': 100.1,
    });

    const prefetched = await service.prefetchPrices();
    expect(prefetched.prices['513100']).toBeUndefined();

    const r = await service.calculateAndSave(1, new Date(), { prefetched });

    expect(provider.calls).toHaveLength(1); // 没有为补 513100 再打一次源
    expect(r.marketDate).toBe('2026-08-23');
  });

  it('没有任何持仓时不打源', async () => {
    const { service, provider, prisma } = makeService(PRICES);
    prisma.asset.findMany.mockResolvedValue([]);

    const prefetched = await service.prefetchPrices();

    expect(provider.calls).toHaveLength(0);
    expect(prefetched).toEqual({ prices: {}, marketDate: null });
  });
});
