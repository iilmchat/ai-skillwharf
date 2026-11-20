-- Sprint 40: единый шлюз адаптеров корпоративных мессенджеров (OMNI-40.1/40.2).

CREATE TABLE "CorpMessengerChannel" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "apiBaseUrl" TEXT,
    "encryptedBotToken" TEXT NOT NULL,
    "webhookSecret" TEXT NOT NULL,
    "allowedChatIds" TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastMessageAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CorpMessengerChannel_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CorpMessengerChannel_workspaceId_idx" ON "CorpMessengerChannel"("workspaceId");
CREATE INDEX "CorpMessengerChannel_userId_idx" ON "CorpMessengerChannel"("userId");
CREATE INDEX "CorpMessengerChannel_provider_idx" ON "CorpMessengerChannel"("provider");
ALTER TABLE "CorpMessengerChannel" ADD CONSTRAINT "CorpMessengerChannel_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
