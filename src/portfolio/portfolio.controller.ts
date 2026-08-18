import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
} from '@nestjs/common';
import { PortfolioService } from './portfolio.service';
import { TradeService } from './trade.service';
import { CreatePortfolioDto } from './dto/create-portfolio.dto';
import { UpdatePortfolioDto } from './dto/update-portfolio.dto';
import { RecordTradeDto } from './dto/create-trade.dto';

@Controller('portfolio')
export class PortfolioController {
  constructor(
    private readonly portfolioService: PortfolioService,
    private readonly tradeService: TradeService,
  ) {}

  @Post()
  create(
    @Body() createPortfolioDto: CreatePortfolioDto,
    @Query('userId') userId: string,
  ) {
    return this.portfolioService.create(createPortfolioDto, +userId);
  }

  @Get()
  findAll(@Query('userId') userId: string) {
    return this.portfolioService.findAll(+userId);
  }

  @Get('trades')
  findTrades(@Query('userId') userId: string) {
    return this.tradeService.findByUser(+userId);
  }

  @Post(':id/trades')
  recordTrade(
    @Param('id') portfolioId: string,
    @Body() recordTradeDto: RecordTradeDto,
    @Query('userId') userId: string,
  ) {
    return this.tradeService.create(recordTradeDto, +portfolioId, +userId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.portfolioService.findOne(+id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() updatePortfolioDto: UpdatePortfolioDto,
  ) {
    return this.portfolioService.update(+id, updatePortfolioDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.portfolioService.remove(+id);
  }
}
