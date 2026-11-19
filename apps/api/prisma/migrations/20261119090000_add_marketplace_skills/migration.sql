-- Публичный каталог навыков и Revenue Share (API-27.2).
-- Подпись SKILL.md проверяется по TRUSTED_SKILL_PUBLIC_KEYS (API-27.1).

ALTER TABLE "InstalledSkill" ADD COLUMN "marketplaceSlug" TEXT;
CREATE INDEX "InstalledSkill_marketplaceSlug_idx" ON "InstalledSkill"("marketplaceSlug");

CREATE TABLE "MarketplaceSkill" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "trackIds" TEXT[],
    "authorId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "payoutAccountId" TEXT,
    "manifestYaml" TEXT NOT NULL,
    "signature" TEXT,
    "publicKeyId" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "pricingModel" TEXT NOT NULL,
    "price" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "downloadsCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketplaceSkill_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MarketplaceSkill_slug_key" ON "MarketplaceSkill"("slug");
CREATE INDEX "MarketplaceSkill_status_idx" ON "MarketplaceSkill"("status");
CREATE INDEX "MarketplaceSkill_authorId_idx" ON "MarketplaceSkill"("authorId");
