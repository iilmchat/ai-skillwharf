-- AlterTable: тип задачи и дневной бюджет затрат на маршрут (LLM Router v2)
ALTER TABLE "LlmRoute" ADD COLUMN     "taskType" TEXT NOT NULL DEFAULT 'chat',
ADD COLUMN     "dailyCostLimit" DECIMAL(18,2);

-- AlterTable: привязка LLM-списаний Ledger к маршруту для budget guardrails
ALTER TABLE "LedgerEntry" ADD COLUMN     "llmRouteName" TEXT;

-- DropIndex: заменяется составным индексом с taskType
DROP INDEX "LlmRoute_isActive_priority_idx";

-- CreateIndex
CREATE INDEX "LlmRoute_isActive_taskType_priority_idx" ON "LlmRoute"("isActive", "taskType", "priority");

-- CreateIndex
CREATE INDEX "LedgerEntry_llmRouteName_createdAt_idx" ON "LedgerEntry"("llmRouteName", "createdAt");
