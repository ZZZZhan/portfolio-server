import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { Exchange } from '../generated/prisma/client';
import { PriceProvider, PriceQuery, PriceResult } from './price-provider';

/**
 * HTTP 抓取缝 —— 行情源的网络调用集中在此 token，便于：
 * 1. 测试注入 fake（不打真网）
 * 2. 将来换底层 HTTP 客户端只改一处
 */
export type HttpFetcher = (url: string, opts?: RequestInit) => Promise<string>;

export const PRICE_HTTP_FETCHER = 'PRICE_HTTP_FETCHER';

const defaultFetcher: HttpFetcher = async (url, opts) => {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} @ ${url}`);
  // 新浪行情接口返回 GBK，需以 GBK 解码
  return res.text();
};

/**
 * 新浪行情源实现（已验证可用）。
 *
 * 场内（SH / SZ）：http://hq.sinajs.cn/list=sh510300,sz159915
 *   - Header: Referer: https://finance.sina.com.cn（不带会 403）
 *   - 返回 GBK 文本，逗号分隔，当前价 = 第 4 字段，日期 = 倒数第 2 字段
 *
 * 场外（OTC）：http://hq.sinajs.cn/list=of110022
 *   - 返回：名称,单位净值,累计净值,昨净值,涨跌幅,日期
 *   - 净值未公布时返回上一交易日数据，date 字段会早于今天（调用方据此判断）
 *
 * 失败降级（SPEC 第 12 条）：单条解析失败不影响其它标的，整体网络失败返回空数组。
 */
@Injectable()
export class SinaPriceProvider implements PriceProvider {
  private readonly logger = new Logger(SinaPriceProvider.name);
  private readonly fetcher: HttpFetcher;

  private static readonly QUOTE_URL = 'http://hq.sinajs.cn/list=';
  private static readonly REFERER = 'https://finance.sina.com.cn';

  constructor(@Optional() @Inject(PRICE_HTTP_FETCHER) fetcher?: HttpFetcher) {
    this.fetcher = fetcher ?? defaultFetcher;
  }

  async getPrices(queries: PriceQuery[]): Promise<PriceResult[]> {
    if (queries.length === 0) return [];

    // 1. 拼 symbol 前缀，记录原始 symbol 以便回填
    const prefixed = queries.map((q) => ({
      prefix: this.prefixOf(q.exchange),
      symbol: q.symbol,
    }));

    const list = prefixed.map((p) => `${p.prefix}${p.symbol}`).join(',');
    let body: string;
    try {
      body = await this.fetcher(`${SinaPriceProvider.QUOTE_URL}${list}`, {
        headers: { Referer: SinaPriceProvider.REFERER },
      });
    } catch (err) {
      this.logger.warn(`新浪行情请求失败：${(err as Error).message}`);
      return []; // 整体降级
    }

    // 2. 逐行解析，失败的单条跳过
    const results: PriceResult[] = [];
    const lines = body.split('\n').filter(Boolean);
    for (const line of lines) {
      const parsed = this.parseLine(line);
      if (parsed) results.push(parsed);
    }
    return results;
  }

  /** 交易所 → 新浪前缀 */
  private prefixOf(exchange: Exchange): string {
    switch (exchange) {
      case Exchange.SH:
        return 'sh';
      case Exchange.SZ:
        return 'sz';
      case Exchange.OTC:
        return 'of'; // 场外基金走净值接口
    }
  }

  /**
   * 解析单行新浪行情文本为 PriceResult。
   * - 场内：var hq_str_sh510300="名称,昨收,今开,当前价,最高,...,日期,时间,...";
   * - 场外：var hq_str_of110022="名称,单位净值,累计净值,昨净值,涨跌幅,日期";
   * 当前价 / 净值 都是引号内第 4 / 第 2 个字段，日期都是最后一个字段。
   */
  private parseLine(line: string): PriceResult | null {
    // 匹配 var hq_str_sh510300="..." / of511260="..."
    // (?:sh|sz|of) 非捕获前缀，仅捕获纯代码（510300 / 511260）
    const match = line.match(/var hq_str_(?:sh|sz|of)(\d+)="([^"]*)"/);
    if (!match) return null;
    const symbol = match[1].trim(); // 纯代码，如 510300
    const payload = match[2];
    if (!payload) return null; // 空字符串 = 该标的查不到

    const fields = payload.split(',');
    const isOTC = line.includes('hq_str_of');
    // 场外：单位净值 = fields[1]；场内：当前价 = fields[3]
    const priceStr = isOTC ? fields[1] : fields[3];
    // 日期：场外在末字段 fields[5]，场内在 findDate（第一个 YYYY-MM-DD）
    const dateStr = isOTC ? fields[5]?.trim() : this.findDate(fields);
    const price = Number(priceStr);
    if (!priceStr || Number.isNaN(price) || !dateStr) return null;

    return { symbol, price, date: dateStr };
  }

  /** 场内行情日期字段位置不固定，扫描第一个 YYYY-MM-DD 形态的段 */
  private findDate(fields: string[]): string {
    for (const f of fields) {
      const m = f.trim().match(/^\d{4}-\d{2}-\d{2}$/);
      if (m) return m[0];
    }
    return '';
  }
}
