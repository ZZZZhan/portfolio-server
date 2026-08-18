import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * 资产搜索入参：用户输入基金/股票代码或名称片段。
 * 例如 "510300"、"茅台"、"hs300"。
 */
export class SearchAssetDto {
  @IsString()
  @IsNotEmpty({ message: '搜索词不能为空' })
  @MaxLength(40, { message: '搜索词过长' })
  keyword!: string;
}
