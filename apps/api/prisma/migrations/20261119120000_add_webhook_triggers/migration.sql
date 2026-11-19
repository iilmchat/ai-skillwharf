-- Sprint 32: Event-Driven Agents — входящие webhook-триггеры (CONNECT-32.2).

CREATE TABLE "WebhookTrigger" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "secretToken" TEXT NOT NULL,
    "promptTemplate" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastTriggeredAt" TIMESTAMP(3),
    "triggerCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookTrigger_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WebhookTrigger_slug_key" ON "WebhookTrigger"("slug");
CREATE INDEX "WebhookTrigger_workspaceId_idx" ON "WebhookTrigger"("workspaceId");
CREATE INDEX "WebhookTrigger_userId_idx" ON "WebhookTrigger"("userId");
ALTER TABLE "WebhookTrigger" ADD CONSTRAINT "WebhookTrigger_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
