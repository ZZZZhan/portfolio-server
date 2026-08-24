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
import { Session, AllowAnonymous } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import { PortfolioService } from './portfolio.service';
import { TradeService } from './trade.service';
import { SnapshotService } from './snapshot.service';
import { AssetSearchService } from './asset-search.service';
import { CreatePortfolioDto } from './dto/create-portfolio.dto';
import { UpdatePortfolioDto } from './dto/update-portfolio.dto';
import { UpdateHoldingDto } from './dto/update-holding.dto';
import { RecordTradeDto } from './dto/create-trade.dto';
import { SearchAssetDto } from './dto/search-asset.dto';
import { auth } from '../lib/auth';

/**
 * 鉴权说明：
 * 全局 AuthGuard 默认要求登录。本控制器内所有业务路由都依赖当前登录用户，
 * userId 通过 @Session() 从 better-auth 会话中取（值为 user.id）。
 * 无需登录的查询类路由用 @AllowAnonymous() 标记。
 */
@Controller('portfolio')
export class PortfolioController {
  constructor(
    private readonly portfolioService: PortfolioService,
    private readonly tradeService: TradeService,
    private readonly snapshotService: SnapshotService,
    private readonly assetSearchService: AssetSearchService,
  ) {}

  @Post()
  create(
    @Body() createPortfolioDto: CreatePortfolioDto,
    @Session() session: UserSession<typeof auth>,
  ) {
    const userId = session.user.id;
    return this.portfolioService.create(createPortfolioDto, userId);
  }

  @Get()
  findAll(@Session() session: UserSession<typeof auth>) {
    return this.portfolioService.findAll(session.user.id);
  }

  @Get(':id/trades')
  findPortfolioTrades(
    @Param('id', ParseIntPipe) portfolioId: number,
    @Session() session: UserSession<typeof auth>,
  ) {
    return this.tradeService.findByPortfolio(portfolioId, session.user.id);
  }

  @Post(':id/holdings/:holdingId/trades')
  recordTrade(
    @Param('id', ParseIntPipe) portfolioId: number,
    @Param('holdingId', ParseIntPipe) holdingId: number,
    @Body() recordTradeDto: RecordTradeDto,
    @Session() session: UserSession<typeof auth>,
  ) {
    return this.tradeService.create(
      recordTradeDto,
      holdingId,
      portfolioId,
      session.user.id,
    );
  }

  // 改单条持仓的偏离阈值。放在 @Patch(':id') 之前，具体路由优先
  @Patch(':id/holdings/:holdingId')
  updateHolding(
    @Param('id', ParseIntPipe) portfolioId: number,
    @Param('holdingId', ParseIntPipe) holdingId: number,
    @Body() updateHoldingDto: UpdateHoldingDto,
    @Session() session: UserSession<typeof auth>,
  ) {
    return this.portfolioService.updateHolding(
      portfolioId,
      holdingId,
      session.user.id,
      updateHoldingDto,
    );
  }

  // 调试端点：手动触发快照计算 + 返回（M4 换成 cron 定时）。先校验组合归属防越权。
  @Post(':id/snapshot')
  async runSnapshot(
    @Param('id', ParseIntPipe) id: number,
    @Session() session: UserSession<typeof auth>,
  ) {
    await this.portfolioService.assertOwned(id, session.user.id);
    return this.snapshotService.calculateAndSave(id);
  }

  // 读取某组合最新快照（不触发计算）。先校验组合归属防越权。
  @Get(':id/snapshot')
  async getLatestSnapshot(
    @Param('id', ParseIntPipe) id: number,
    @Session() session: UserSession<typeof auth>,
  ) {
    await this.portfolioService.assertOwned(id, session.user.id);
    return this.snapshotService.getLatest(id);
  }

  // 标的搜索无需登录
  @Get('assets/search')
  @AllowAnonymous() // 全局 AuthGuard 下显式放行
  searchAssets(@Query() query: SearchAssetDto) {
    return this.assetSearchService.search(query);
  }

  @Get(':id')
  findOne(
    @Param('id', ParseIntPipe) id: number,
    @Session() session: UserSession<typeof auth>,
  ) {
    return this.portfolioService.findOne(id, session.user.id);
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() updatePortfolioDto: UpdatePortfolioDto,
    @Session() session: UserSession<typeof auth>,
  ) {
    return this.portfolioService.update(
      id,
      updatePortfolioDto,
      session.user.id,
    );
  }

  @Delete(':id')
  remove(
    @Param('id', ParseIntPipe) id: number,
    @Session() session: UserSession<typeof auth>,
  ) {
    return this.portfolioService.remove(id, session.user.id);
  }
}
