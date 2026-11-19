-- Sprint 35: No-Code конструктор кастомных ролей агентов (BUILDER-35.1/35.2/35.3).

CREATE TABLE "CustomAgentRole" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "roleKey" TEXT NOT NULL,
    "description" TEXT,
    "systemPrompt" TEXT NOT NULL,
    "skillSlugs" TEXT[],
    "hitlPolicy" TEXT NOT NULL DEFAULT 'high_risk',
    "dailyBudgetRub" DECIMAL(18,2),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomAgentRole_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CustomAgentRole_workspaceId_roleKey_key" ON "CustomAgentRole"("workspaceId", "roleKey");
CREATE INDEX "CustomAgentRole_workspaceId_idx" ON "CustomAgentRole"("workspaceId");
ALTER TABLE "CustomAgentRole" ADD CONSTRAINT "CustomAgentRole_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
