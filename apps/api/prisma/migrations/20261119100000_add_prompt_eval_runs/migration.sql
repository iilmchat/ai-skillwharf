-- Sprint 29: автоматические LLM Evals и гейт промоушена A/B (EVAL-29.2/29.3).

CREATE TABLE "PromptEvalRun" (
    "id" TEXT NOT NULL,
    "promptId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "trackFilter" TEXT,
    "totalCases" INTEGER NOT NULL,
    "passedCases" INTEGER NOT NULL,
    "passRate" DOUBLE PRECISION NOT NULL,
    "avgScore" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "resultsJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "PromptEvalRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PromptEvalRun_promptId_createdAt_idx" ON "PromptEvalRun"("promptId", "createdAt");
CREATE INDEX "PromptEvalRun_versionId_status_idx" ON "PromptEvalRun"("versionId", "status");
ALTER TABLE "PromptEvalRun" ADD CONSTRAINT "PromptEvalRun_promptId_fkey" FOREIGN KEY ("promptId") REFERENCES "PromptTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
