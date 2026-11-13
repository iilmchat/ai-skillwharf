-- Sprint 18: зашифрованные Google OAuth-токены и привязка Telegram-чатов.
-- Токены хранятся только в виде envelope `v1:<iv>:<tag>:<ciphertext>`
-- (AES-256-GCM); открытые значения в БД не попадают.

CREATE TABLE "GoogleCredential" (
  "userId" TEXT NOT NULL,
  "accessToken" TEXT NOT NULL,
  "refreshToken" TEXT,
  "scope" TEXT NOT NULL,
  "email" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "GoogleCredential_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE "TelegramBot" (
  "userId" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "botUsername" TEXT,
  "botName" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "TelegramBot_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE "TelegramChatLink" (
  "chatId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TelegramChatLink_pkey" PRIMARY KEY ("chatId")
);

CREATE UNIQUE INDEX "TelegramChatLink_conversationId_key"
  ON "TelegramChatLink"("conversationId");

CREATE INDEX "TelegramChatLink_userId_idx"
  ON "TelegramChatLink"("userId");

ALTER TABLE "GoogleCredential"
  ADD CONSTRAINT "GoogleCredential_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TelegramChatLink"
  ADD CONSTRAINT "TelegramChatLink_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TelegramChatLink"
  ADD CONSTRAINT "TelegramChatLink_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TelegramBot"
  ADD CONSTRAINT "TelegramBot_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
