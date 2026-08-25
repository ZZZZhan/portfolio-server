# 投资组合管理

后端以 Portfolio 为边界管理用户资产配置与交易流水，快照为唯一计算真相。

## Language

### Portfolio
用户创建的一组投资目标容器，含目标总投入金额与一组 Holding 槽位；目标金额创建后不可改，有流水的 Holding 不可删，避免历史快照的 completion 重算歧义。
_Avoid_: 组合包、投资组合单（code 中统一用 Portfolio）


### Asset
可交易的证券标的（ETF / 股票 / 场外基金），由 symbol 唯一标识，含类型与交易所。
_Avoid_: 标的、证券、Instrument（code 中统一用 Asset）

### Holding
Portfolio 与 Asset 的配置槽位，存目标配比与偏离阈值，生命周期跟随 Portfolio 的目标配置；无流水时可增删，有已确认 Trade 后不可删，删槽位将级联删流水导致历史重算。
_Avoid_: 持仓、仓位、Position（持仓状态请用 HoldingSnapshot）


### Trade
对某个 Holding 的一笔买入或卖出流水，记录成交金额、份额、单价与确认状态；份额已确认才参与所有计算。
_Avoid_: 交易记录、订单、委托

### TradeType
交易渠道：EXCHANGE 场内按份额交易，OTC 场外按金额交易；场外卖出（赎回）亦按金额录入，份额日终由金额除以净值补全。
_Avoid_: 类型、渠道类型

### TradeStatus
份额确认状态：COMPLETED 已确认参与计算，PENDING 待净值确认不计入 Completion、成本与盈亏。
_Avoid_: 待确认、已完成

### Price
Trade.price 的统一字段，场内存成交价、场外存当日净值；场外申购时可为空，22:00 补全后与 shares 一并回填，净值更正则覆盖该字段并重算受影响快照。
_Avoid_: 单价、净值、成交价（code 中统一用 price）

### HoldingSnapshot
某日某 Holding 由已确认 Trade 与行情推导出的快照态，含当前份额、市值、成本、盈亏、当前配比与偏离度；持久化于 DailySnapshot.holdings Json，不回写 Holding 表。
_Avoid_: HoldingResult、持仓详情

### DailySnapshot
某 Portfolio 在某日的组合级快照，含总市值、总成本、累计/今日盈亏与收益率、建仓完成度及全量 HoldingSnapshot。
_Avoid_: 快照行、日终快照（code 中统一用 DailySnapshot）

### Profit
累计盈亏 = 已实现盈亏 + 浮动盈亏；已实现为卖出时 (卖出价 - 当时成本均价)×份额累加，浮动为当前市值 - 持仓成本。
_Avoid_: 收益、总收益（code 中统一用 totalPnl / totalProfit）

### ProfitRate
累计收益率 = 累计盈亏 / Σ已确认买入金额；分母为历史累计投入而非当前持仓成本，与 Completion 同源为累计口径。
_Avoid_: 收益率、年化收益

### TodayProfit
今日收益 = 今日快照总市值 - 最近一期快照总市值；跨周末或节假日无快照时累计价差，今日收益率 = 今日收益 / 昨日市值。
_Avoid_: 当日盈亏、日收益

### Deviation
配比偏离度 = HoldingSnapshot.currentRatio - Holding.targetRatio；仅再平衡期（Completion≥100%）计算，建仓期置 0 不触发提醒。
_Avoid_: 偏离、偏差

### RebalanceThreshold
Holding 上的偏离阈值，偏离绝对值超过阈值时触发再平衡提醒；建仓期因 Deviation 置 0 而不生效。
_Avoid_: 阈值、再平衡线

### Completion
建仓完成度，历史累计建仓进度 = Σ已确认买入金额 / Portfolio.targetTotalAmount；卖出不扣减，一旦达 100% 永不回退，用于判定建仓期与再平衡期的阶段开关，展示时封顶 100%。
### MarketDate
行情源返回的交易日，与服务器本地日独立；仅当 MarketDate 为当日才落当日 DailySnapshot，否则不写占位行，读快照返回最近一期。
_Avoid_: 交易日期、行情日期（code 中统一用 marketDate）

### SnapshotDate
DailySnapshot 的主键日期（@db.Date），由 asDateOnly 按 UTC 0 点构造，避免时区错位；与 MarketDate 共同决定是否落库与今日收益的差值基准。
_Avoid_: 快照日期、落库日



### PriceProvider
行情源适配器，按 symbol 批量提供最新价与行情日期，失败时由调用方兜底。
_Avoid_: 行情服务、MarketDataService
