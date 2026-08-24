// src/portfolio/dto/record-trade.dto.ts
import {
  IsEnum,
  IsNumber,
  Min,
  ValidateIf,
  IsDefined,
  IsOptional,
} from 'class-validator';

export enum TradeType {
  EXCHANGE = 'EXCHANGE',
  OTC = 'OTC',
}

export enum TradeDirection {
  BUY = 'BUY',
  SELL = 'SELL',
}

/**
 * 录入交易入参。
 *
 * 标的（holdingId）由路径参数指定 —— 组合的目标配置在建组合时已定好，
 * 加仓减仓只针对已有持仓，不新增标的（避免破坏配比和=100% 的语义）。
 */
export class RecordTradeDto {
  @IsEnum(TradeDirection)
  direction!: TradeDirection; // 买入/卖出

  @IsEnum(TradeType)
  type!: TradeType;

  // 场外交易：填金额
  @ValidateIf((o: RecordTradeDto) => o.type === TradeType.OTC)
  @IsDefined({ message: '场外交易必须填金额' })
  @IsNumber()
  @Min(0.01, { message: '金额必须 > 0' })
  amount?: number;

  // 场外交易：单价可选
  // - 填了（补录历史，净值已公布）→ 份额=金额/单价，状态 COMPLETED
  // - 不填（今天实时申购，净值未出）→ PENDING，等收盘后 cron 用当日净值折算
  @ValidateIf((o: RecordTradeDto) => o.type === TradeType.OTC)
  @IsOptional()
  @IsNumber()
  @Min(0.0001, { message: '单价必须 > 0' })
  navPrice?: number;

  // 场内交易：shares + price 必填
  @ValidateIf((o: RecordTradeDto) => o.type === TradeType.EXCHANGE)
  @IsDefined({ message: '场内交易必须填份额' })
  @IsNumber()
  @Min(0.0001)
  shares?: number;

  @ValidateIf((o: RecordTradeDto) => o.type === TradeType.EXCHANGE)
  @IsDefined({ message: '场内交易必须填单价' })
  @IsNumber()
  @Min(0.0001)
  price?: number;
}
