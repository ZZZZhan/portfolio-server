# SPEC：投资组合管理后端（portfolio-server）

> 状态：定稿（实现中）。本文档为实现依据，改动需经讨论；实现状态于 2026-08 同步至当前代码。
> 前端：`portfolio-app`（Next.js 16，移动端风格，当前用 `src/lib/mockData.ts` 假数据，无 API 层）。

## Problem Statement

用户有一个移动端风格的投资组合管理前端（`portfolio-app`），目前所有页面数据是前端写死的 mock。用户需要一个后端服务，提供真实的持仓、行情、收益数据，让前端能展示自己投资组合的真实状态（总资产、今日/累计收益、建仓完成度、持仓明细、配比偏离与再平衡建议），并支持录入交易、新建组合。

用户是**场内（ETF/股票，按份额交易）+ 场外（基金申购，按金额交易）混合**的投资方式，买场外基金时不知道份额，只知道投入金额。

## Solution

一个 NestJS 后端（`portfolio-server`）：
- **数据层**：Prisma + PostgreSQL（docker 已有），存用户（复用 better-auth 的 user）、组合、持仓、交易、每日快照。
- **行情层**：新浪/腾讯免费行情接口，藏在 `PriceProvider` adapter 后；白天不实时拉取，**每交易日日终（18:00 快照 + 22:00 补场外份额）** 由内置 cron 拉全量行情，计算组合级/持仓级数据写入 `DailySnapshot`。
- **API 层**：细粒度资源端点（RESTful），前端自行组合页面所需数据；快照计算在后端完成。录入/建组合走资源端点写库。
- **认证**：better-auth 挂 NestJS，cookie session，复用其 user 表，业务表以 userId 关联。
- 所有收益/偏离/完成度计算在后端完成，前端只展示。

## User Stories

1. 作为用户，我想要注册/登录（better-auth），以便我的组合数据是私有的、与其他用户隔离。
2. 作为用户，我想要登录后看到"首页总览"，展示总资产、今日收益、今日收益率、累计收益、收益率、我的组合列表（名称、今日涨跌、建仓完成度、市值、风险标识），以便一屏了解全局。
3. 作为用户，我想要新建一个投资组合（名称 + 目标配置），以便按策略管理不同资产。
4. 作为用户，我想要在一个组合下录入**场内**交易（标的、份额、成交单价、日期），金额自动算出，以便记录精确的场内持仓。
5. 作为用户，我想要在一个组合下录入**场外**交易（标的、投入金额、日期），份额由后端用当日净值自动折算（22:00 后补全），以便无需知道份额也能记账。
6. 作为用户，我想要查看组合详情页（名称、今日涨跌、市值、总成本、累计盈亏、收益率、完成度、持仓明细：各持仓当前/目标配比、市值、盈亏），以便了解组合全貌。
7. 作为用户，我想要看到再平衡页（各持仓 vs 目标配比的偏离度、超配/低配状态、建议），以便知道何时调整。
8. 作为用户，我想要在调整页看到每个持仓的当前/目标配比和调整后建议配比，以便执行再平衡。
9. 作为用户，我想要"今日收益/收益率"是盘后更新（读日终快照），白天不改动，以便符合"盘后才能看"的使用习惯。
10. 作为用户，我想要场外净值公布较晚（个别 22:00 前未出）的份额次日补全，以便数据最终一致。
11. 作为用户，我想要我的所有数据只对我可见（数据隔离），以便隐私安全。
12. 作为用户，我想要行情源不可用时服务仍可用（降级用最近快照，不报错），以便行情波动不影响记账功能。
13. 作为用户，我想要建仓完成度按"已投入成本/目标投入成本"计算，以便知道建仓进度。

## Implementation Decisions

### 技术栈
- NestJS 11 + TypeScript、Prisma 7 + PostgreSQL 16（docker-compose 已有，本地 5432）
- better-auth 挂 NestJS（express 中间件），cookie session（httpOnly），复用其 user/session/account/verification 表；business 表以 `userId` 外键关联
- `@nestjs/schedule` 内嵌 cron；行情源为新浪免费接口，藏在 `PriceProvider` adapter 后，失败降级用最近成交价/快照（最初设想的 60s TTL 缓存未实施——行情只在快照/补份额时按需拉取）
- 本地运行：DB 走 docker；Nest 端口 `PORT` 环境变量（默认 3000，示例 3001），Next 3000 用 rewrites 将 `/api` 代理到 3001（代理由前端仓库配置）

### 领域模型（Prisma schema）
```
better-auth 表：user / session / account / verification（复用，不新建 User）

Asset              id, symbol(唯一, 如 510300), name(沪深300ETF), type(ETF/股票/基金)
Portfolio          id, userId(→user), name, targetTotalAmount(目标总投入金额, 用户设定, Decimal)
Holding            id, portfolioId, assetId, targetRatio(目标配比 %), rebalanceThreshold(偏离阈值 %, 如 5 = 偏离>5%提醒再平衡)
Trade              id, holdingId, type(EXCHANGE 场内 / OTC 场外), direction(BUY/SELL), amount(必填),
                   shares(场内必填; 场外=金额÷当日净值, 日终补全), price(场内成交价/场外净值), tradedAt, status(COMPLETED/PENDING 份额待定)
DailySnapshot      id, portfolioId, date(每组合每日一行), 组合级: totalMarketValue, totalCost, totalProfit, profitRate, todayProfit, todayProfitRate, completion
                   + holdings Json(持仓级快照: 每支的名称/当前市值/当前配比/目标配比/盈亏/偏离状态, 冗余全量)
```
- 唯一约束：Asset.symbol、DailySnapshot(portfolioId, date)
- 市值/当前配比/盈亏/偏离度均不落库于 Holding/Trade，而是由 Trade + 行情推导并写入快照
- User 复用 better-auth 表，并扩展自定义字段：`marketUpdateMode`（盘后/实时行情模式）、`sendkey`（Server酱微信推送密钥，未填则不推送）

### 收益口径
- 今日收益 = 今日快照市值 − 昨日快照市值；今日收益率 = 今日收益 / 昨日市值
### 收益口径
采用**成本均价法**（券商常见口径），区分已实现/未实现盈亏：

```
成本均价        = Σ买入金额 / Σ买入份额      （只统计 BUY，卖出不参与）
已实现盈亏       += (卖出价 - 当时成本均价) × 卖出份额（SELL 时累加）
当前份额        = Σ买入份额 - Σ卖出份额
持仓成本        = 成本均价 × 当前份额
当前市值        = 当前份额 × 最新价
浮动盈亏        = 当前市值 - 持仓成本
累计盈亏(总收益) = 已实现盈亏 + 浮动盈亏
累计收益率      = 累计盈亏 / 累计投入成本
建仓完成度      = 累计投入成本 / 目标总投入金额 (targetTotalAmount, 用户设定)
```

要点：**卖出不改变成本均价**，但减少当前份额（从而持仓成本绝对数变小）；卖出的利润计入"已实现盈亏"。所有计算只统计**份额已确认（COMPLETED）**的交易，场外 `PENDING` 不参与。

今日收益 = 今日快照市值 − 昨日快照市值；今日收益率 = 今日收益 / 昨日市值（需要前一日快照）

### API 契约

> **不采用 BFF 聚合端点。** 经讨论，后端只提供细粒度资源端点（标准的 RESTful），前端自行组合所需数据。
> SPEC 原拟的 `GET /api/home`、`/api/portfolios/:id`、`/api/portfolios/:id/rebalance`、`/api/portfolios/:id/adjust` 等「一页一端点」聚合接口**不再实现**；前端从下方列出的细粒度端点自行取数拼装页面。

**端点（全部已实现，统一 `/api` 前缀）：**
- `POST /api/auth/*`（sign-up/email、sign-in/email、session、sign-out 等）—— better-auth 标准路由
- `GET /api/portfolio` — 当前登录用户组合列表（userId 取 session，不再用 query 参数）
- `POST /api/portfolio` — 新建组合（名称 + 目标配置，含持仓；目标配比和=100）
- `GET /api/portfolio/:id` — 组合详情（含持仓 + 标的）
- `PATCH /api/portfolio/:id` — 更新组合（名称/金额；持仓按 symbol diff，可增删标的）
- `DELETE /api/portfolio/:id` — 删除组合（级联删持仓/交易/快照）
- `GET /api/portfolio/:id/trades` — 某组合下的交易列表
- `POST /api/portfolio/:id/holdings/:holdingId/trades` — 录入交易（场内：份额+单价；场外：金额，份额日终补；支持 BUY/SELL）
- `PATCH /api/portfolio/:id/holdings/:holdingId` — 修改持仓偏离阈值 rebalanceThreshold
- `POST /api/portfolio/:id/snapshot` — 手动触发快照计算并写入（调试用；日常由 cron 驱动）
- `GET /api/portfolio/:id/snapshot` — 读某组合最近一次快照（不触发计算）
- `GET /api/portfolio/assets/search?keyword=` — 资产检索（东方财富，匿名放行）

> 全局前缀 `/api` 已统一（`main.ts` 的 `setGlobalPrefix('api')`，better-auth 路由由库自动排除）。所有组合级端点都做**归属校验**（session.user.id 关联 portfolio.userId），跨用户访问返回 404。

### Cron 任务（@nestjs/schedule）
- 每交易日 18:00：拉全部持仓最新价 → 计算 → 写当日 DailySnapshot（仅当行情日期为当日才写，避免周末/节假日写占位行）
- 每交易日 22:00：补全所有 PENDING 场外 Trade 的份额（净值晚公布），重算受影响组合快照，随后推送一次再平衡提醒（配了 SendKey 的用户）
- 补跑逻辑：进程启动时若发现最近交易日无快照则补算
- 多实例：三个入口都用 PostgreSQL advisory lock 抢占（`AdvisoryLockService`），只有拿到锁的实例执行，避免重复微信推送；行情按所有组合的「标的并集」预取一次（`prefetchPrices`），整轮只打一次行情源

### 计算归属
- 后端为唯一计算真相：市值、配比、偏离度、收益、完成度都由后端算好写快照；前端不重复计算逻辑

## Testing Decisions

- **好测试的定义**：只测外部行为（打 HTTP API），不测内部模块结构/实现细节。
- **两个测试缝**：
  1. **主缝：HTTP API e2e**（supertest 打 Nest 端点，连真实 Postgres 测试库 + 注入 fake PriceProvider 返回固定价格）。覆盖完整链路：认证 → 建组合 → 录场内/场外交易 → 触发快照计算 → 读组合详情/快照。
  2. **唯一内部缝：PriceProvider adapter 接口**（fake 注入，验证可替换性）。
- 快照计算逻辑不做独立单测——通过 API e2e 全链路验证（刻意避免滋生内部缝）。
- 先例：repo 现有 `app.e2e-spec.ts`（Nest 默认 smoke test）将扩展为 e2e 基底。

> 注：原 SPEC 以「BFF 聚合端点」为 e2e 验收对象，现 BFF 端点已取消（见上节），e2e 转为验收细粒度资源端点。

## Out of Scope

- 部署（云服务器/域名/HTTPS/env 配置）——代码保持可部署（`PORT` env、Prisma migrate 脚本）但不实施
- 真实行情源替换（Tushare/付费源）——adapter 已留缝，不在本期实现
- TWR/时间加权收益率、资金流入流出加权
- 部分卖出 / 冻结股数的复杂模型（目前按整笔 BUY/SELL 记账，成本均价法口径见上）
- 场外基金的 T+1 确认、赎回规则模拟（个人记账简化处理）
- 前端 `portfolio-app` 的改造（接 API、rewrites 代理）——本期只做后端，前端接入作为下一张票
- 行情历史曲线/API 之外的消费方
- **BFF 聚合端点**（`/api/home`、`/api/portfolios/:id`、`/rebalance`、`/adjust` 等「一页一端点」）——后端只提供细粒度资源端点，前端自行组合，不再实现聚合层