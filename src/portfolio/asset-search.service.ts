import { Injectable, Optional, Inject, Logger } from '@nestjs/common';
import { SearchAssetDto } from './dto/search-asset.dto';
import { AssetType, Exchange } from '../generated/prisma/client';

/**
 * 搜索结果项 —— 对齐前端「新建组合时选标的」所需的最小信息集。
 * assetType 已归一到 Prisma 的 AssetType 枚举（ETF / STOCK / FUND）。
 */
export interface AssetSearchResult {
  symbol: string; // 标的代码，如 510300 / 110022 / 600519
  name: string; // 标的名称，如 沪深300ETF华泰柏瑞
  assetType: AssetType; // 归一到 Prisma schema 的 AssetType 枚举（ETF / STOCK / FUND）
  exchange: Exchange; // 交易所：SH / SZ / OTC，用于拼行情源前缀（sh / sz / of）
}

/**
 * HTTP 抓取缝 —— 所有对外网络调用集中在此，便于：
 * 1. 测试注入 fake（SPEC：唯一可注入的内部缝是 PriceProvider，但搜索同样不应在单测里打真网）
 * 2. 未来换源只改这一个 token 的实现
 *
 * 返回字符串（响应体），失败抛 Error。
 */
export type HttpFetcher = (url: string, opts?: RequestInit) => Promise<string>;

export const HTTP_FETCHER = 'HTTP_FETCHER';

/**
 * 默认实现：Node 内置 fetch。生产/本地用，测试用 fake 覆盖。
 */
const defaultFetcher: HttpFetcher = async (url, opts) => {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} @ ${url}`);
  return res.text();
};

/**
 * 东方财富 searchapi 返回的一项（字段节选，仅取我们关心的）。
 * 参考：https://searchapi.eastmoney.com/api/suggest/get
 */
interface EastMoneySuggestItem {
  Code: string; // 510300
  Name: string; // 沪深300ETF华泰柏瑞
  Classify: string; // Fund / AStock / OTCFUND ...
  SecurityTypeName: string; // 基金 / 沪A
  MktNum: string; // 市场代码：1=沪、0=深、其他（如 150）=场外基金
}

interface EastMoneySuggestResponse {
  QuotationCodeTable?: {
    Data?: EastMoneySuggestItem[] | null;
    TotalCount?: number;
  };
  Status?: number;
}

/**
 * 资产搜索服务 —— 桥接免费行情源的「标的检索」能力。
 *
 * 设计取舍：
 * - 不缓存：搜索是低频、即时性强的操作（用户边输入边查），缓存反而易误导
 * - 不落库：搜索只读外部源，Asset 表的写入由「新建组合/录交易」时按需 upsert
 *   （见 PortfolioService.create / TradeService.create 的 TODO）
 * - 失败降级：源不可用时返回空数组而非抛 500，前端只提示「未找到」（对齐 SPEC 第 12 条）
 */
@Injectable()
export class AssetSearchService {
  private readonly logger = new Logger(AssetSearchService.name);
  private readonly fetcher: HttpFetcher;

  // 东方财富搜索 API token 是公开的固定值，非鉴权凭证
  private static readonly SEARCH_URL =
    'https://searchapi.eastmoney.com/api/suggest/get';
  private static readonly SEARCH_TOKEN = 'D43BF722C8E33BDC906FB84D85D3D226';

  constructor(@Optional() @Inject(HTTP_FETCHER) fetcher?: HttpFetcher) {
    this.fetcher = fetcher ?? defaultFetcher;
  }

  async search(dto: SearchAssetDto): Promise<AssetSearchResult[]> {
    const keyword = dto.keyword.trim();
    if (!keyword) return [];

    let items: EastMoneySuggestItem[];
    try {
      items = await this.fetchSuggestions(keyword);
    } catch (err) {
      // 行情源不可用：降级返回空（SPEC 第 12 条「源不可用时服务仍可用」）
      this.logger.warn(
        `资产搜索失败，keyword="${keyword}"：${(err as Error).message}`,
      );
      return [];
    }

    return items
      .map((it) => this.normalize(it))
      .filter((r): r is AssetSearchResult => r !== null);
  }

  /** 调用东方财富搜索接口并解析 JSON */
  private async fetchSuggestions(
    keyword: string,
  ): Promise<EastMoneySuggestItem[]> {
    const url =
      `${AssetSearchService.SEARCH_URL}` +
      `?input=${encodeURIComponent(keyword)}` +
      `&type=14` +
      `&token=${AssetSearchService.SEARCH_TOKEN}` +
      `&count=15`;

    const body = await this.fetcher(url);
    let parsed: EastMoneySuggestResponse;
    try {
      parsed = JSON.parse(body) as EastMoneySuggestResponse;
    } catch {
      throw new Error(`东方财富搜索响应不是合法 JSON`);
    }
    return parsed.QuotationCodeTable?.Data ?? [];
  }

  /**
   * 把东方财富的 Classify 归一到我们的 AssetType / Exchange 枚举。
   * - OTCFUND（场外基金）→ FUND / OTC
   * - Fund（含 ETF，场内基金）→ ETF / SH|SZ（按代码前缀）
   * - AStock / BStock / HStock → STOCK / SH|SZ（按代码前缀）
   * - 其他不认识的丢弃（返回 null）
   */
  private normalize(item: EastMoneySuggestItem): AssetSearchResult | null {
    const code = item.Code?.trim();
    const name = item.Name?.trim();
    if (!code || !name) return null;

    const classify = item.Classify ?? '';
    let assetType: AssetType;
    let exchange: Exchange;
    if (classify === 'OTCFUND') {
      assetType = AssetType.FUND;
      exchange = Exchange.OTC; // 场外基金走净值接口（of 前缀）
    } else if (classify === 'Fund' || classify === 'ETF') {
      assetType = AssetType.ETF;
      exchange = this.exchangeByMktNum(item.MktNum); // 场内基金按市场代码分沪/深
    } else if (
      classify === 'AStock' ||
      classify === 'BStock' ||
      classify === 'HStock'
    ) {
      assetType = AssetType.STOCK;
      exchange = this.exchangeByMktNum(item.MktNum);
    } else {
      // 不支持的品种（债券、指数、期权等）不返回，避免污染选标的结果
      return null;
    }

    return { symbol: code, name, assetType, exchange };
  }

  /**
   * 东方财富 MktNum → 交易所枚举。
   * 1=沪市（SH），0=深市（SZ），其余（如 150 场外基金）归 OTC。
   * 比按代码前缀推导更准（直接用源返回的市场标识）。
   */
  private exchangeByMktNum(mktNum: string | undefined): Exchange {
    if (mktNum === '1') return Exchange.SH;
    if (mktNum === '0') return Exchange.SZ;
    return Exchange.OTC;
  }
}
