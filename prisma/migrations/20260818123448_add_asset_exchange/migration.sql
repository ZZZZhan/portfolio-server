-- CreateEnum
CREATE TYPE "Exchange" AS ENUM ('SH', 'SZ', 'OTC');

-- AlterTable: 先加可空列
ALTER TABLE "Asset" ADD COLUMN "exchange" "Exchange";

-- 回填：
--   type = FUND（场外基金）→ OTC
--   symbol 以 5/6/9 开头（沪市）→ SH
--   其余（0/1/3 开头，深市）→ SZ
UPDATE "Asset" SET "exchange" = 'OTC' WHERE "type" = 'FUND';
UPDATE "Asset" SET "exchange" = 'SH'  WHERE "type" <> 'FUND' AND ("symbol" ~ '^[569]');
UPDATE "Asset" SET "exchange" = 'SZ'  WHERE "type" <> 'FUND' AND ("symbol" ~ '^[013]');

-- 收紧为 NOT NULL
ALTER TABLE "Asset" ALTER COLUMN "exchange" SET NOT NULL;
