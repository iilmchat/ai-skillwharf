-- AlterTable
ALTER TABLE "Wallet" ADD COLUMN     "heldBalance" DECIMAL(18,2) NOT NULL DEFAULT 0;

-- Escrow: append-only Ledger разрешает только завершение PENDING-записи.
-- Все остальные изменения и удаления по-прежнему запрещены.
CREATE OR REPLACE FUNCTION prevent_ledger_modification()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD."type" = 'PENDING'
       AND NEW."type" IN ('debit', 'credit')
       AND NEW."id" = OLD."id"
       AND NEW."walletId" = OLD."walletId"
       AND NEW."amount" = OLD."amount"
       AND NEW."description" = OLD."description"
       AND NEW."idempotencyKey" = OLD."idempotencyKey"
       AND NEW."createdAt" = OLD."createdAt"
    THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'Ledger is append-only. Modifications are forbidden.';
END;
$$ LANGUAGE plpgsql;
