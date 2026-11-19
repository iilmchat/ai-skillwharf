-- Sprint 36: статический аудит безопасности навыков (DEVPORTAL-36.1/36.2).

ALTER TABLE "MarketplaceSkill" ADD COLUMN "auditStatus" TEXT NOT NULL DEFAULT 'passed';
ALTER TABLE "MarketplaceSkill" ADD COLUMN "auditFindingsJson" JSONB;
