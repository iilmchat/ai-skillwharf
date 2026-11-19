-- Sprint 28: A/B-эксперименты промптов, per-model тарифы и метаданные памяти.

CREATE TABLE "PromptExperiment" (
    "id" TEXT NOT NULL,
    "promptId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "variantAVersionId" TEXT NOT NULL,
    "variantBVersionId" TEXT NOT NULL,
    "trafficSplitB" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "winnerVersionId" TEXT,
    "metricsJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stoppedAt" TIMESTAMP(3),

    CONSTRAINT "PromptExperiment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PromptExperiment_promptId_status_idx" ON "PromptExperiment"("promptId", "status");
ALTER TABLE "PromptExperiment" ADD CONSTRAINT "PromptExperiment_promptId_fkey" FOREIGN KEY ("promptId") REFERENCES "PromptTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LlmRoute" ADD COLUMN "inputCostPer1k" DECIMAL(18,6);
ALTER TABLE "LlmRoute" ADD COLUMN "outputCostPer1k" DECIMAL(18,6);

ALTER TABLE "MemoryChunk" ADD COLUMN "source" TEXT;
ALTER TABLE "MemoryChunk" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'fact';
ALTER TABLE "MemoryChunk" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
