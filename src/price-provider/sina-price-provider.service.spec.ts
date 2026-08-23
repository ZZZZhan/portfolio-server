import { Exchange } from '../generated/prisma/client';
import { SinaPriceProvider, HttpFetcher } from './sina-price-provider.service';
import { PriceQuery } from './price-provider';

/** 造 N 个场内标的查询（代码从 600000 递增，保证不重复） */
function queries(n: number): PriceQuery[] {
  return Array.from({ length: n }, (_, i) => ({
    symbol: String(600000 + i),
    exchange: Exchange.SH,
  }));
}

/** 按请求里出现的 symbol 回一段合法的新浪响应，并记录每次请求的 URL */
function recordingFetcher(urls: string[]): HttpFetcher {
  return (url: string) => {
    urls.push(url);
    const list = url.split('list=')[1] ?? '';
    const body = list
      .split(',')
      .filter(Boolean)
      .map(
        (code) =>
          `var hq_str_${code}="某标的,1.0,1.0,2.500,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,2026-08-23,15:00:00,00";`,
      )
      .join('\n');
    return Promise.resolve(body);
  };
}

describe('SinaPriceProvider 分批', () => {
  it('不超过单批上限时只发一次请求', async () => {
    const urls: string[] = [];
    const provider = new SinaPriceProvider(recordingFetcher(urls));

    const results = await provider.getPrices(queries(100));

    expect(urls).toHaveLength(1);
    expect(results).toHaveLength(100);
  });

  it('超出上限时切片串行取，且不漏标的', async () => {
    const urls: string[] = [];
    const provider = new SinaPriceProvider(recordingFetcher(urls));

    const results = await provider.getPrices(queries(250));

    // 250 个标的 → 100 + 100 + 50
    expect(urls).toHaveLength(3);
    expect(results).toHaveLength(250);
    // 每批都没超过上限（URL 过长会被源站拒绝）
    for (const url of urls) {
      const codes = url.split('list=')[1].split(',');
      expect(codes.length).toBeLessThanOrEqual(100);
    }
    // 首尾标的都取到了，说明切片没丢边界
    const symbols = results.map((r) => r.symbol);
    expect(symbols).toContain('600000');
    expect(symbols).toContain('600249');
  });

  it('单批请求失败只丢那一批，其余照常返回', async () => {
    const urls: string[] = [];
    const ok = recordingFetcher(urls);
    const provider = new SinaPriceProvider((url, opts) => {
      // 让第二批（含 600100）整批失败
      if (url.includes('600100')) return Promise.reject(new Error('网络炸了'));
      return ok(url, opts);
    });

    const results = await provider.getPrices(queries(250));

    expect(results).toHaveLength(150); // 第一批 100 + 第三批 50
    expect(results.map((r) => r.symbol)).not.toContain('600100');
  });

  it('空入参不发请求', async () => {
    const urls: string[] = [];
    const provider = new SinaPriceProvider(recordingFetcher(urls));

    expect(await provider.getPrices([])).toEqual([]);
    expect(urls).toHaveLength(0);
  });
});
