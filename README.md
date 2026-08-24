# portfolio-server

投资组合管理后端。为移动端风格的投资组合前端（`portfolio-app`）提供真实的持仓、行情、收益数据，支持录入交易、新建组合、日终快照与再平衡提醒。

## 功能特性

- **认证**：better-auth 接入 NestJS，cookie session（httpOnly），业务数据按 `userId` 隔离
- **组合管理**：新建 / 更新（持仓 diff）/ 删除，目标配比和=100% 校验
- **交易模型**：场内（份额 × 单价）+ 场外（金额，份额=金额÷当日净值，日终补全），买入/卖出；支持补录历史场外交易（净值已公布则立即可算份额）
- **日终快照**：cron 定时（18:00 日终、22:00 补场外份额、启动补跑）计算组合级/持仓级收益、配比偏离、建仓完成度并落库；复用最近快照兜底
- **行情源**：新浪行情 adapter（`PriceProvider` 抽象，可替换）；失败降级用最近成交价 / 快照，不阻塞记账
- **资产检索**：东方财富搜索接口（无需登录）
- **再平衡提醒**：配偏离阈值（`rebalanceThreshold`）的持仓超阈值时，通过 Server酱推送微信消息（用户可填 SendKey）
- **数据隔离**：所有资源端点从 session 取 userId 并校验归属，跨用户访问返回 404

## 技术栈

- [NestJS](https://nestjs.com/) 11 + TypeScript
- [Prisma](https://www.prisma.io/) 7（driver adapters）+ PostgreSQL 16（`docker-compose.yaml`）
- [better-auth](https://www.better-auth.com/)（`@thallesp/nestjs-better-auth`，cookie session）
- `@nestjs/schedule` 定时任务 + PostgreSQL advisory lock（跨实例互斥）
- pnpm（workspace 单包）

## 快速开始

### 前置

- Node 22+（本项目用 pnpm，建议启用 corepack）
- Docker（本地 PostgreSQL 用 compose 起）

### 1. 启动数据库

```bash
docker compose up -d
```

### 2. 安装依赖并生成 Prisma Client

```bash
pnpm install
pnpm prisma generate   # 生成到 src/generated（被 .gitignore 排除）
```

### 3. 配置环境变量

```bash
cp .env.example .env
```

| 变量 | 说明 |
| --- | --- |
| `DATABASE_URL` | PostgreSQL 连接串（`postgresql://nest_user:nest_password@localhost:5432/nest_db`） |
| `PORT` | 服务端口，默认 `3000`（示例 3001） |
| `BETTER_AUTH_SECRET` | better-auth 签名密钥 |
| `BETTER_AUTH_URL` | 后端自身地址（如 `http://localhost:3001`） |
| `FRONTEND_URL` | 前端跨域来源（默认 `http://localhost:3000`） |

### 4. 迁移 & 种子（可选）

```bash
pnpm prisma migrate dev
pnpm exec tsx prisma/seed.ts
```

种子会注册演示用户 `demo@portfolio.local` / `password123` 并创建「稳健增值组合」（4 个标的，目标金额 80 万）。

### 5. 运行

```bash
pnpm start:dev          # 开发（watch）
pnpm run build          # 构建
pnpm run start:prod     # 运行构建产物
```

## API

所有业务路由挂在全局前缀 `/api` 下；成功响应统一为 `{ code: 0, message: 'ok', data }`，异常为 Nest 默认错误格式。

### 认证（better-auth，`/api/auth/*`）

标准端点：`POST /api/auth/sign-up/email`、`POST /api/auth/sign-in/email`、`GET /api/auth/session`、`POST /api/auth/sign-out`。

默认**所有业务路由都需要登录**（全局 `AuthGuard`）；仅资产搜索与根路由放行。

### 业务端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 健康检查（匿名） |
| GET | `/api/portfolio` | 当前用户组合列表 |
| POST | `/api/portfolio` | 新建组合（名称 + 目标金额 + 持仓配置，目标配比和=100） |
| GET | `/api/portfolio/:id` | 组合详情（含持仓 + 标的） |
| PATCH | `/api/portfolio/:id` | 更新组合（名称/金额；持仓按 symbol diff：改配比、增删标的） |
| DELETE | `/api/portfolio/:id` | 删除组合（级联删持仓/交易/快照，不可恢复） |
| GET | `/api/portfolio/:id/trades` | 组合交易列表 |
| POST | `/api/portfolio/:id/holdings/:holdingId/trades` | 录入交易（场内：`shares`+`price`；场外：`amount`，可选 `navPrice` 补录） |
| PATCH | `/api/portfolio/:id/holdings/:holdingId` | 修改持仓偏离阈值 `rebalanceThreshold` |
| POST | `/api/portfolio/:id/snapshot` | 手动触发快照计算并写入（调试用；日常由 cron 驱动） |
| GET | `/api/portfolio/:id/snapshot` | 读取组合最近一次快照（不触发计算） |
| GET | `/api/portfolio/assets/search?keyword=` | 资产检索（东方财富，匿名） |

> 交易字段：`type`（`EXCHANGE`/`OTC`）、`direction`（`BUY`/`SELL`）。场外当日申购（不填 `navPrice`）以 `PENDING` 状态落库，22:00 cron 用当日净值折算份额后置为 `COMPLETED`。

## 定时任务（cron）

| 时间 | 任务 |
| --- | --- |
| 每交易日 18:00 | 日终快照：拉全量持仓收盘价 → 计算并写入当日 `DailySnapshot`（非交易日不写，避免占位行干扰「最近交易日」判断） |
| 每交易日 22:00 | 补全当日 `PENDING` 场外交易份额（净值晚公布），重算受影响组合快照，随后推送一次再平衡提醒 |
| 启动时 | 补跑：若组合最新快照早于最近工作日则补算 |

多实例部署时用 PostgreSQL advisory lock 抢占，只有拿到锁的实例真正执行（防止重复微信推送）。

## 测试

```bash
pnpm test --runInBand               # 单元测试（含 controller/service）
pnpm run test:e2e --runInBand       # e2e（连真实 Postgres 测试库，注册真实用户走认证链路）
pnpm run lint                       # ESLint
```

e2e 会连本地测试库（`DATABASE_URL`）并注册临时用户，结束后自动清理（需先 `docker compose up -d` 起库）。

CI（GitHub Actions，`.github/workflows/ci.yaml`）：push/PR 时在独立 Postgres 服务上跑 lint（不带 `--fix`，严格校验）→ build → 单测 → e2e。

## Docker 部署

```bash
docker build -t portfolio-server .
docker run -d -p 3001:3001 \
  -e DATABASE_URL='postgresql://...' \
  -e PORT=3001 \
  -e BETTER_AUTH_SECRET='...' \
  -e BETTER_AUTH_URL='http://localhost:3001' \
  -e FRONTEND_URL='http://localhost:3000' \
  portfolio-server
```

镜像启动时自动执行 `prisma migrate deploy`。

## 目录结构

```
src/
  common/            # 全局响应拦截器、advisory lock
  lib/               # better-auth 实例、共享 Prisma adapter
  prisma/            # PrismaService
  price-provider/    # 行情 adapter（新浪）+ 抽象缝
  portfolio/         # 组合/持仓/交易/快照/资产搜索 + DTO + calc 纯计算
  notification/      # 再平衡提醒（Server酱 adapter）
  app.module.ts      # 根模块（AuthModule + ScheduleModule）
prisma/
  schema.prisma      # 数据模型（含 better-auth 表）
  seed.ts            # 演示数据
test/                # e2e（app/portfolio/notification）
```