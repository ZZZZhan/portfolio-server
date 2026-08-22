import { IsNumber, Max, Min } from 'class-validator';

/**
 * 修改单条持仓的可变字段。
 *
 * 目标配比 targetRatio 不在此处改——它有「同组合内加总为 100」的约束，
 * 单条改会破坏该语义，需要整组一起提交。
 */
export class UpdateHoldingDto {
  /** 偏离阈值 %（如 5 = 当前配比偏离目标超过 ±5% 时提醒再平衡） */
  @IsNumber()
  @Min(0)
  @Max(100)
  rebalanceThreshold!: number;
}
