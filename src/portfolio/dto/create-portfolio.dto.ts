import {
  IsString,
  IsNotEmpty,
  IsNumber,
  Min,
  Max,
  IsArray,
  ValidateNested,
  IsOptional,
} from 'class-validator';
import { Type } from 'class-transformer';

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

export class HoldingInput {
  @IsNumber()
  assetId!: number;

  @IsNumber()
  @Min(0)
  @Max(100)
  targetRatio!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  rebalanceThreshold?: number;
}
