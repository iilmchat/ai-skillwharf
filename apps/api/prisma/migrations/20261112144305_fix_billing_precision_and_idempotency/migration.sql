-- AlterTable: денежная точность DECIMAL(18,2)
ALTER TABLE "Wallet" ALTER COLUMN "balance" SET DATA TYPE DECIMAL(18, 2);
ALTER TABLE "LedgerEntry" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(18, 2);

-- Idempotency: колонка добавляется nullable, существующие записи получают
-- сгенерированные ключи, затем NOT NULL + уникальный индекс.
ALTER TABLE "LedgerEntry" ADD COLUMN "idempotencyKey" TEXT;
UPDATE "LedgerEntry" SET "idempotencyKey" = gen_random_uuid()::text WHERE "idempotencyKey" IS NULL;
ALTER TABLE "LedgerEntry" ALTER COLUMN "idempotencyKey" SET NOT NULL;
CREATE UNIQUE INDEX "LedgerEntry_idempotencyKey_key" ON "LedgerEntry"("idempotencyKey");

-- Append-only защита Ledger: UPDATE и DELETE запрещены на уровне БД.
CREATE OR REPLACE FUNCTION prevent_ledger_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Ledger is append-only. Modifications are forbidden.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prevent_update_ledger
    BEFORE UPDATE ON "LedgerEntry"
    FOR EACH ROW EXECUTE FUNCTION prevent_ledger_modification();

CREATE TRIGGER prevent_delete_ledger
    BEFORE DELETE ON "LedgerEntry"
    FOR EACH ROW EXECUTE FUNCTION prevent_ledger_modification();