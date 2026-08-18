import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  ParseIntPipe,
} from '@nestjs/common';
import { PortfolioService } from './portfolio.service';
import { TradeService } from './trade.service';
import { SnapshotService } from './snapshot.service';
import { CreatePortfolioDto } from './dto/create-portfolio.dto';
import { UpdatePortfolioDto } from './dto/update-portfolio.dto';
import { RecordTradeDto } from './dto/create-trade.dto';

@Controller('portfolio')
export class PortfolioController {
  constructor(
    private readonly portfolioService: PortfolioService,
    private readonly tradeService: TradeService,
    private readonly snapshotService: SnapshotService,
  ) {}

  @Post()
  create(
    @Body() createPortfolioDto: CreatePortfolioDto,
    // @TODO(M3): userId 改为从 @Req() req.session 取当前登录用户
    // 目前未接 better-auth，暂用 ?userId= 传参
    @Query('userId', ParseIntPipe) userId: number,
  ) {
    return this.portfolioService.create(createPortfolioDto, userId);
  }

  @Get()
  findAll(@Query('userId', ParseIntPipe) userId: number) {
    return this.portfolioService.findAll(userId);
  }

  @Get('trades')
  findTrades(@Query('userId', ParseIntPipe) userId: number) {
    return this.tradeService.findByUser(userId);
  }

  @Post(':id/trades')
  recordTrade(
    @Param('id', ParseIntPipe) portfolioId: number,
    @Body() recordTradeDto: RecordTradeDto,
    // @TODO(M3): userId 改为从 @Req() req.session 取当前登录用户，去掉 query 传参
    // 目前未接 better-auth，暂用 ?userId= 传参
    @Query('userId', ParseIntPipe) userId: number,
  ) {
    return this.tradeService.create(recordTradeDto, portfolioId, userId);
  }

  // 调试端点：手动触发快照计算 + 返回（M4 换成 cron 定时）
  @Post(':id/snapshot')
  runSnapshot(@Param('id', ParseIntPipe) id: number) {
    return this.snapshotService.calculateAndSave(id);
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.portfolioService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() updatePortfolioDto: UpdatePortfolioDto,
  ) {
    return this.portfolioService.update(id, updatePortfolioDto);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.portfolioService.remove(id);
  }
}