// src/portfolio/dto/record-trade.dto.ts
import {
  IsEnum,
  IsNumber,
  Min,
  IsNotEmpty,
  IsOptional,
  ValidateIf,
  IsDefined,
} from 'class-validator';
import { Type } from 'class-transformer';

export enum TradeType {
  EXCHANGE = 'EXCHANGE',
  OTC = 'OTC',
}

export enum TradeDirection {
  BUY = 'BUY',
  SELL = 'SELL',
}

export class RecordTradeDto {
  @IsEnum(TradeDirection)
  direction!: TradeDirection; // 买入/卖出

  @IsEnum(TradeType)
  type!: TradeType;

  @ValidateIf((o) => o.type === TradeType.OTC)
  @IsDefined({ message: '场外交易必须填金额' })
  @IsNumber()
  @Min(0.01, { message: '金额必须 > 0' })
  amount?: number;

  // 场内交易：shares + price 必填
  // ValidateIf：只有 type === EXCHANGE 时才校验下面的规则
  @ValidateIf((o) => o.type === TradeType.EXCHANGE)
  @IsDefined({ message: '场内交易必须填份额' })
  @IsNumber()
  @Min(0.0001)
  shares?: number;

  @ValidateIf((o) => o.type === TradeType.EXCHANGE)
  @IsDefined({ message: '场内交易必须填单价' })
  @IsNumber()
  @Min(0.0001)
  price?: number;

  @IsNumber()
  @IsNotEmpty()
  holdingId!: number;
}
