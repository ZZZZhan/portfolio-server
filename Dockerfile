# ---- 构建阶段 ----
FROM node:22-bookworm-slim AS builder
RUN corepack enable
WORKDIR /app

# 先装依赖（利用 Docker 层缓存）
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml prisma.config.ts ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile

# 生成 Prisma Client（src/generated/prisma 被 .gitignore 排除，构建时生成）
RUN pnpm prisma generate

# 复制源码并构建
COPY . .
RUN pnpm build

# ---- 运行阶段 ----
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# Prisma 引擎运行时需要 openssl
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

# 只拷运行所需文件
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./

# 启动前先跑迁移，确保 schema 最新；然后启动 NestJS
CMD ["sh", "-c", "pnpm prisma migrate deploy && node dist/src/main"]
