-- AlterTable: сумма после операции (аудит баланса на момент записи)
ALTER TABLE "LedgerEntry" ADD COLUMN "balanceAfter" DECIMAL(18, 2);

-- Бэкфилл для уже существующих записей: текущий баланс кошелька.
-- Append-only триггеры блокируют UPDATE, поэтому на время бэкфилла отключаем
-- пользовательские триггеры; после миграции они снова активны.
ALTER TABLE "LedgerEntry" DISABLE TRIGGER USER;

UPDATE "LedgerEntry" AS le
SET "balanceAfter" = w."balance"
FROM "Wallet" AS w
WHERE w."id" = le."walletId";

UPDATE "LedgerEntry" SET "balanceAfter" = 0 WHERE "balanceAfter" IS NULL;

ALTER TABLE "LedgerEntry" ENABLE TRIGGER USER;

ALTER TABLE "LedgerEntry" ALTER COLUMN "balanceAfter" SET NOT NULL;
