import {
  IsString,
  IsNotEmpty,
  IsNumber,
  Min,
  Max,
  IsArray,
  ValidateNested,
  IsOptional,
  IsEnum,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AssetType } from '../../generated/prisma/client';

export class CreatePortfolioDto {
  @IsString()
  @IsNotEmpty({ message: '组合名不能为空' })
  name!: string;

  @IsNumber()
  @Min(0)
  targetTotalAmount!: number;

  @IsArray()
  @ValidateNested({ each: true }) // 数组里每项都要递归校验
  @Type(() => HoldingInput) // 告诉校验器每项转成什么类
  holdings!: HoldingInput[];
}

/**
 * 新建组合时的单条持仓输入。
 *
 * 注意：提交的是标的「symbol + name + assetType」，而非数据库 assetId ——
 * 因为标的可能来自前端资产搜索接口（联网查到的新标的），尚未落库。
 * 后端 PortfolioService.create 会按 symbol upsert Asset 自动建表记录。
 */
export class HoldingInput {
  @IsString()
  @IsNotEmpty({ message: '标的代码不能为空' })
  symbol!: string;

  @IsString()
  @IsNotEmpty({ message: '标的名称不能为空' })
  name!: string;

  @IsEnum(AssetType, { message: '资产类型必须是 ETF / STOCK / FUND' })
  assetType!: AssetType;

  @IsNumber()
  @Min(0)
  @Max(100)
  targetRatio!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  rebalanceThreshold?: number;
}
