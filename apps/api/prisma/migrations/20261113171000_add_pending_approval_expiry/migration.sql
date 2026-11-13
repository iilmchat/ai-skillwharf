-- AlterTable: TTL для ожидающих одобрения действий (HITL)
ALTER TABLE "PendingApproval" ADD COLUMN     "expiresAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "PendingApproval_status_expiresAt_idx" ON "PendingApproval"("status", "expiresAt");
