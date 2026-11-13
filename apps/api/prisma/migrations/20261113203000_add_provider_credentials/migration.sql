-- Ключи Ozon/Wildberries/Midjourney, подключённые пользователем.
-- Секреты хранятся в envelope `v1:<iv>:<tag>:<ciphertext>` (AES-256-GCM,
-- ключ TOKEN_ENCRYPTION_KEY); открытых значений в БД нет.
-- `metadata` — только неконфиденциальные поля для UI (срок действия токена WB).

CREATE TABLE "ProviderCredential" (
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderCredential_pkey" PRIMARY KEY ("userId","provider")
);

CREATE INDEX "ProviderCredential_provider_idx" ON "ProviderCredential"("provider");

ALTER TABLE "ProviderCredential" ADD CONSTRAINT "ProviderCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
