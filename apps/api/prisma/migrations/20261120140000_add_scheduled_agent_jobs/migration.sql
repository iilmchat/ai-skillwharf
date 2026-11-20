-- Sprint 43: cron-планировщик автономных задач агентов (CRON-43.1/43.2).

CREATE TABLE "ScheduledAgentJob" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cronExpression" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Moscow',
    "prompt" TEXT NOT NULL,
    "deliveryChannelType" TEXT NOT NULL DEFAULT 'none',
    "deliveryChannelId" TEXT,
    "deliveryChatId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "lastRunStatus" TEXT,
    "lastRunSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledAgentJob_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ScheduledAgentJob_workspaceId_idx" ON "ScheduledAgentJob"("workspaceId");
CREATE INDEX "ScheduledAgentJob_nextRunAt_idx" ON "ScheduledAgentJob"("nextRunAt");
ALTER TABLE "ScheduledAgentJob" ADD CONSTRAINT "ScheduledAgentJob_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
