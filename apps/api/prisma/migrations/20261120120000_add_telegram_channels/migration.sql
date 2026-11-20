-- Sprint 39: подключение Telegram-бота к воркспейсу (OMNI-39.1/HITL-39.3).

CREATE TABLE "TelegramChannel" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botUsername" TEXT,
    "encryptedBotToken" TEXT NOT NULL,
    "webhookSecret" TEXT NOT NULL,
    "allowedChatIds" TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastMessageAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramChannel_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TelegramChannel_workspaceId_botUsername_key" ON "TelegramChannel"("workspaceId", "botUsername");
CREATE INDEX "TelegramChannel_workspaceId_idx" ON "TelegramChannel"("workspaceId");
CREATE INDEX "TelegramChannel_userId_idx" ON "TelegramChannel"("userId");
ALTER TABLE "TelegramChannel" ADD CONSTRAINT "TelegramChannel_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
