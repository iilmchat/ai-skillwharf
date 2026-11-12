# Runbook: Развёртывание SkillWharf (On-Premise)

**Статус:** Утверждено
**Дата:** 2026-11-12

## 1. Системные требования

* **ОС:** Linux (Ubuntu 22.04+ / Debian 12+).
* **CPU:** x86_64 с поддержкой аппаратной виртуализации (Intel VT-x / AMD-V) для запуска Firecracker (Sandbox).
* **RAM:** Минимум 8 GB (рекомендуется 16 GB для LLM и агентов).
* **Диск:** 50 GB SSD.
* **ПО:** Docker 24+, Docker Compose v2, PostgreSQL 15+ (если не используется встроенный контейнер).

## 2. Переменные окружения (.env)

Перед запуском создайте файл `.env` в корне проекта на основе `.env.example`:

* `POSTGRES_PASSWORD`: Надежный пароль для БД.
* `DATABASE_URL`: Строка подключения Prisma к PostgreSQL (по умолчанию порт хоста `5435`, см. `.env.example`).
* `JWT_SECRET`: Секрет для подписи токенов (минимум 32 символа).
* `GIGACHAT_CLIENT_ID` / `GIGACHAT_CLIENT_SECRET`: Ключи для российских LLM (опционально).
* `YOOKASSA_SHOP_ID` / `YOOKASSA_SECRET_KEY`: Ключи для биллинга (если включен).
* `KVM_DEVICE_PATH`: Путь к устройству KVM (обычно `/dev/kvm`).

## 3. Шаги развертывания (Docker Compose)

1. **Клонирование репозитория:**

   ```bash
   git clone https://github.com/iilmchat/ai-skillwharf.git
   cd ai-skillwharf
   ```

2. **Подготовка окружения:**

   ```bash
   cp .env.example .env
   # Отредактируйте .env, задав пароли и ключи
   ```

3. **Запуск стека:**

   ```bash
   docker compose up -d --build
   ```

4. **Применение миграций БД (при первом запуске):**

   ```bash
   docker compose exec api prisma migrate deploy
   ```

5. **Проверка статуса:**

   ```bash
   curl http://localhost:3001/api/v1/health
   # Ожидаемый ответ: {"status":"ok","database":true}
   ```

   > Порты `3000` и `5432` на хосте заняты другими проектами, поэтому API
   > проброшен на `3001`, а PostgreSQL — на `5435` (см. `docker-compose.yml`).

## 4. Бэкап и восстановление (Ledger и БД)

Для предотвращения потери данных биллинга (Ledger) необходимо регулярно делать бэкап PostgreSQL.

**Создание бэкапа:**

```bash
docker compose exec -T postgres pg_dump -U skillwharf_admin -d skillwharf_db -Fc > backup_$(date +%Y%m%d).dump
```

**Восстановление:**

```bash
docker compose exec -T postgres pg_restore -U skillwharf_admin -d skillwharf_db --clean < backup_20261112.dump
```

## 5. Диагностика проблем

* **Ошибка: `KVM device not found`**
  * *Решение:* Убедитесь, что хост-система поддерживает виртуализацию (`egrep -c '(vmx|svm)' /proc/cpuinfo` > 0) и модуль KVM загружен (`lsmod | grep kvm`). Если развертывание в облаке, используйте инстансы с поддержкой вложенной виртуализации.
* **Ошибка: `Connection refused` при вызове LLM.**
  * *Решение:* Проверьте доступность API LLM-провайдера из контейнера (`docker compose exec api curl ...`).
