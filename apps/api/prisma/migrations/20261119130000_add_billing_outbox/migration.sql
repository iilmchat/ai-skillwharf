-- Sprint 33: Transactional Outbox и Platform Treasury (OUTBOX-33.1, KI-087).

CREATE TABLE "BillingOutbox" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL DEFAULT 'yookassa_author_transfer',
    "idempotencyKey" TEXT NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "nextRetryAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "BillingOutbox_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BillingOutbox_idempotencyKey_key" ON "BillingOutbox"("idempotencyKey");
CREATE INDEX "BillingOutbox_status_nextRetryAt_idx" ON "BillingOutbox"("status", "nextRetryAt");
