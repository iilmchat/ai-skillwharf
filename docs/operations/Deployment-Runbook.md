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
* `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`: Подключение к LLM по OpenAI-совместимому API (по умолчанию — локальный Ollama, см. раздел 4).
* `GIGACHAT_CLIENT_ID` / `GIGACHAT_CLIENT_SECRET`: Ключи для российских LLM (опционально).
* `YOOKASSA_SHOP_ID` / `YOOKASSA_SECRET_KEY`: Ключи для биллинга (если включен).
* `KVM_DEVICE_PATH`: Путь к устройству KVM (обычно `/dev/kvm`).
* `LLM_WORKER_URL`: Внутренний адрес llm-worker (в compose —
  `http://llm-worker:4100`); наружу порт не публикуется.
* `INTERNAL_API_TOKEN`: Общий секрет внутренней сети API ↔ llm-worker.
  В production задайте случайное значение; пустое значение допустимо только
  для локальной разработки (см. KI-045).
* `REDIS_URL`: Подключение к Redis для BullMQ (`redis://redis:6379`). Пусто —
  API использует setInterval-таймеры вместо очередей.

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

   Миграции выполняет отдельный one-shot сервис `db-migrate` (Prisma
   `migrate deploy`), а API-реплики стартуют только после его успешного
   завершения (`service_completed_successfully`). `entrypoint.sh` API больше
   не запускает миграции, поэтому `--scale api=2` безопасен.

   Проверить миграции можно отдельно:

   ```bash
   docker compose up -d db-migrate
   docker compose logs db-migrate
   docker compose ps -a db-migrate
   ```

   Ожидаемо: `All migrations have been successfully applied` и
   `STATUS Exited (0)`. Если `db-migrate` упал, API не запустится; см.
   раздел 6 «Диагностика проблем».

   В стек входят `llm-worker` и `redis`. API стартует после healthcheck'ов
   обоих сервисов; `llm-worker` не публикует порт наружу и общается с API по
   внутренней сети. Проверка:

   ```bash
   docker compose ps api llm-worker redis
   docker compose logs -f llm-worker
   # Ожидаемо: llm-worker слушает 4100, Redis отвечает PONG
   docker exec skillwharf-redis-1 redis-cli ping
   ```

   Образ API не содержит `@langchain/*` (проверяется в CI, лимит 400 МБ);
   LangGraph/LangChain живут только в образе `llm-worker`.

4. **Проверка статуса:**

   ```bash
   curl http://localhost:3001/api/v1/health
   # Ожидаемый ответ: {"status":"ok","database":true}

   curl http://localhost:3001/api/v1/health/ready
   curl http://localhost:3001/api/v1/health/live
   docker compose ps api
   ```

   `health/ready` проверяет БД (readiness), `health/live` — только процесс
   (liveness). Compose healthcheck использует `/health/ready`, поэтому
   `docker compose ps` показывает `healthy` только после готовности API.
   Для Kubernetes: `readinessProbe` → `/api/v1/health/ready`,
   `livenessProbe` → `/api/v1/health/live`; старт API дополнительно
   контролируется Job'ом с `prisma migrate deploy`.

   > Порты `3000` и `5432` на хосте заняты другими проектами, поэтому API
   > проброшен на `3001`, а PostgreSQL — на `5435` (см. `docker-compose.yml`).

## 4. Настройка LLM

API общается с моделями по OpenAI-совместимому API: адрес, ключ и имя модели
задаются в `.env` переменными `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`
(значения по умолчанию — из `.env.example`).

### Локальная модель (Ollama)

Сервис `ollama` вынесен в профиль `with-llm`, поэтому не запускается вместе с
основным стеком и не расходует RAM:

```bash
docker compose --profile with-llm up -d ollama
docker compose exec ollama ollama run llama3
```

Сервис `api` в compose-сети видит Ollama по имени `ollama`:

```text
LLM_BASE_URL=http://ollama:11434/v1
LLM_API_KEY=ollama
LLM_MODEL=llama3
```

> Порт `11434` на хосте обычно занят локальным Ollama, поэтому контейнер
> проброшен на `11435`: с хоста (`pnpm start:dev`) используйте
> `LLM_BASE_URL=http://localhost:11435/v1`. Если Ollama установлен на хосте, а
> не в контейнере, оставьте `LLM_BASE_URL=http://localhost:11434/v1`.

После изменения переменных перезапустите API:

```bash
docker compose up -d api
```

### Настройка LM Studio через Control Plane

LM Studio запускается на хосте и отдаёт OpenAI-совместимый API. Маршрут
хранится в БД (`LlmRoute`), поэтому модель, адрес и приоритет можно менять
без перезапуска API.

1. В LM Studio откройте вкладку **Developer**, загрузите модель
   `qwen2.5-coder-7b-instruct` и нажмите **Start Server**. Порт — `8034`,
   доступ по сети должен быть разрешён.
2. Добавьте в `.env` адрес и ключ LM Studio:

   ```text
   LLM_BASE_URL=http://host.docker.internal:8034/v1
   LLM_API_KEY=<ключ из настроек LM Studio>
   LLM_MODEL=qwen2.5-coder-7b-instruct
   ```

3. Перезапустите API:

   ```bash
   docker compose up -d api
   ```

   В `docker-compose.yml` у сервиса `api` уже объявлен `extra_hosts` с
   `host.docker.internal:host-gateway`: на Linux это открывает доступ к хосту,
   на Windows и macOS `host.docker.internal` работает из коробки.

4. Получите JWT администратора (`POST /api/v1/auth/login`) и создайте маршрут
   через Control Plane:

   ```bash
   curl -X POST http://localhost:3001/api/v1/admin/llm-routes \
     -H "Authorization: Bearer <JWT_АДМИНА>" \
     -H "Content-Type: application/json" \
     -d '{
       "name": "local-qwen-coder",
       "modelName": "qwen2.5-coder-7b-instruct",
       "baseUrl": "http://host.docker.internal:8034/v1",
       "apiKeyEnvVar": "LLM_API_KEY",
       "priority": 1,
       "isActive": true
     }'
   ```

   `apiKeyEnvVar` хранит только имя переменной окружения: сам ключ остаётся
   в `.env` и не попадает в БД. Маршрут с наименьшим `priority` среди активных
   используется первым; env-переменные `LLM_*` остаются fallback-вариантом.

5. Проверьте маршрут и чат:

   ```bash
   curl -s http://localhost:3001/api/v1/admin/llm-routes \
     -H "Authorization: Bearer <JWT_АДМИНА>"
   ```

   Затем отправьте сообщение в чат: ответ должен прийти от Qwen, а не от
   заглушки.

> Если контейнер не видит `host.docker.internal`, укажите IP хоста вручную:
> на Linux это обычно `http://172.17.0.1:8034/v1` (проверьте
> `ip addr show docker0`). Тот же адрес используйте в `baseUrl` маршрута.

### Внешняя модель (GigaChat / YandexGPT и др.)

Укажите в `.env` OpenAI-совместимый эндпоинт провайдера (или прокси перед ним),
ключ и имя модели:

```text
LLM_BASE_URL=https://llm.example.ru/v1
LLM_API_KEY=<ключ провайдера>
LLM_MODEL=<имя модели>
```

Для GigaChat клиентские ключи `GIGACHAT_CLIENT_ID` / `GIGACHAT_CLIENT_SECRET`
описаны в разделе 2. После изменения переменных перезапустите API
(`docker compose up -d api`).

## 5. Бэкап и восстановление (Ledger и БД)

Для предотвращения потери данных биллинга (Ledger) необходимо регулярно делать бэкап PostgreSQL.

### Бэкапы БД

Скрипт `scripts/backup-db.sh` делает `pg_dump` в формате custom и кладёт
дамп в `backups/` с датой и временем в имени:

```bash
bash scripts/backup-db.sh
# backups/skillwharf_db-20261113-121500.dump
```

Скрипт читает `POSTGRES_USER`/`POSTGRES_DB` из `.env` и требует запущенный
контейнер `postgres`. Каталог можно переопределить переменной `BACKUP_DIR`:

```bash
BACKUP_DIR=/mnt/backups bash scripts/backup-db.sh
```

Дамп пишется во временный файл `.partial` и переименовывается только после
успешного `pg_dump` и проверки непустоты. Если бэкап не создан, скрипт
завершается с кодом `1` и печатает причину.

Перед дампом проверяется свободное место в `BACKUP_DIR`. По умолчанию
требуется не меньше 512 МБ (`BACKUP_MIN_FREE_MB`); при нехватке места
бэкап не начинается:

```text
ОШИБКА: недостаточно свободного места в /mnt/backups: доступно 120 МБ,
требуется минимум 512 МБ.
```

### Ротация бэкапов

После успешного бэкапа `backup-db.sh` вызывает `scripts/rotate-backups.sh`.
Политика: хранить `BACKUP_KEEP_DAYS` дней, но всегда оставлять не меньше
`BACKUP_KEEP_MIN` последних успешных дампов. Удаляются только файлы
`${POSTGRES_DB}-YYYYMMDD-HHMMSS.dump` старше срока и только сверх минимума.
Каждое удаление пишется в лог с датой, возрастом и размером.

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `BACKUP_DIR` | `backups` | Каталог с дампами |
| `BACKUP_KEEP_DAYS` | `14` | Хранить последние N дней |
| `BACKUP_KEEP_MIN` | `7` | Всегда оставлять N последних дампов |
| `BACKUP_MIN_FREE_MB` | `512` | Минимум свободного места перед дампом |

Проверить, что будет удалено, без изменений на диске:

```bash
bash scripts/rotate-backups.sh --dry-run
# поддерживается также -DryRun
```

Запустить только ротацию с другими параметрами:

```bash
bash scripts/rotate-backups.sh --keep-days 30 --keep-min 10
```

### Offsite-копии в S3

Offsite включается, когда задан `BACKUP_S3_BUCKET`. После успешного
локального `pg_dump` и локальной ротации `backup-db.sh` вызывает
`scripts/upload-backup.sh`, который выгружает дамп через `rclone` в
S3-совместимое хранилище (MinIO, AWS S3 и т. п.). Если offsite не настроен,
локальные бэкапы работают как раньше.

Требуется `rclone` в `PATH` на хосте, где выполняется cron:
<https://rclone.org/install/>. Секреты передаются rclone через переменные
окружения и не попадают в аргументы командной строки.

| Переменная | Обязательна | Назначение |
| --- | --- | --- |
| `BACKUP_S3_BUCKET` | да, для offsite | Bucket; пусто — offsite выключен |
| `BACKUP_S3_ENDPOINT` | нет | Endpoint MinIO/S3; пусто — AWS S3 |
| `BACKUP_S3_REGION` | нет | Регион, по умолчанию `us-east-1` |
| `BACKUP_S3_ACCESS_KEY` | нет | Access key; можно не задавать при IAM-роли |
| `BACKUP_S3_SECRET_KEY` | нет | Secret key |
| `BACKUP_S3_PREFIX` | нет | Префикс ключей, например `skillwharf/db/` |
| `BACKUP_S3_KEEP_DAYS` | нет | Retention offsite, по умолчанию `BACKUP_KEEP_DAYS` |

Пример `.env` (значения — заглушки, реальные секреты не коммитьте):

```text
BACKUP_S3_ENDPOINT=https://s3.example.com
BACKUP_S3_BUCKET=skillwharf-backups
BACKUP_S3_REGION=us-east-1
BACKUP_S3_ACCESS_KEY=<access-key>
BACKUP_S3_SECRET_KEY=<secret-key>
BACKUP_S3_PREFIX=skillwharf/db/
BACKUP_S3_KEEP_DAYS=30
```

Проверка после запуска:

```bash
bash scripts/backup-db.sh
# В логе: "Offsite-копия готова: s3://..."
```

`BACKUP_S3_KEEP_DAYS=0` отключает удаление старых объектов, но не саму
выгрузку. Свежий дамп под retention не попадает. Если S3/rclone недоступны,
локальный дамп и результат локальной ротации сохраняются, скрипт печатает
причину и завершается с кодом `1` — это сигнал для мониторинга, а не повод
удалять локальную копию. Повторная выгрузка вручную:

```bash
bash scripts/upload-backup.sh --file backups/skillwharf_db-20261113-020000.dump
```

**Откат offsite:** очистите `BACKUP_S3_BUCKET` в `.env` (или удалите
`BACKUP_S3_*`). Следующий запуск `backup-db.sh` снова будет только локальным;
уже загруженные объекты останутся в хранилище. Если нужно прекратить и
удалить их, настройте lifecycle-политику bucket отдельно.

### Restore-drill

`scripts/restore-drill.sh` проверяет не только наличие файла, но и
восстановимость: скачивает последний offsite-дамп `${POSTGRES_DB}-*.dump`,
создаёт временную БД `drill_*`, выполняет `pg_restore`, проверяет таблицы
`User` и `LedgerEntry` и удаляет временную БД (в том числе при ошибке).

```bash
bash scripts/restore-drill.sh
```

Ожидаемый результат: `OK: User=<n>, LedgerEntry=<n>` и
`Restore-drill успешно завершён`. Скрипт возвращает `0` только при успехе;
при недоступном S3, ошибке `pg_restore` или отсутствии таблиц — `1`.
Локальные дампы не используются: проверяется именно offsite-копия.

Проверить, что временные БД не остались:

```bash
docker compose exec -T postgres psql --username "$POSTGRES_USER" \
  --dbname postgres -At \
  -c "SELECT datname FROM pg_database WHERE datname LIKE 'drill_%';"
```

Если drill падает, смотрите `docker compose logs postgres`, права
`POSTGRES_USER` (нужны `CREATEDB` и чтение схемы), свободное место и
доступность bucket. Drill не изменяет рабочую БД: восстановление идёт в
отдельную временную базу, а при сбое она удаляется.

### Включение по расписанию

Рекомендуется добавить запуск в cron (например, ежедневно в 02:00). Ротация
и offsite-выгрузка запускаются автоматически после успешного бэкапа:

```cron
0 2 * * * cd /opt/skillwharf && \
  PATH=/usr/local/bin:/usr/bin:/bin \
  BACKUP_DIR=/mnt/backups BACKUP_KEEP_DAYS=14 BACKUP_KEEP_MIN=7 \
  bash scripts/backup-db.sh >> /var/log/skillwharf-backup.log 2>&1

# 03:00 — проверка восстановления последнего offsite-дампа.
0 3 * * * cd /opt/skillwharf && \
  PATH=/usr/local/bin:/usr/bin:/bin \
  bash scripts/restore-drill.sh >> /var/log/skillwharf-restore-drill.log 2>&1
```

`PATH` в cron должен содержать `docker` и `rclone`: cron не наследует PATH
интерактивной оболочки. Если offsite не настроен, `restore-drill.sh` вернёт
`1` с понятной ошибкой — это ожидаемо только до включения S3.

Если ротация должна выполняться отдельным заданием, добавьте
`--skip-prune` к бэкапу и второй cron-вызов:

```cron
30 2 * * * cd /opt/skillwharf && BACKUP_DIR=/mnt/backups \
  bash scripts/rotate-backups.sh >> /var/log/skillwharf-backup.log 2>&1
```

### Проверка бэкапов

```bash
# Последний запуск завершился без ошибок?
tail -n 30 /var/log/skillwharf-backup.log

# Сколько дампов и какой объём занимают?
ls -lh /mnt/backups/*.dump | tail -n 10
du -sh /mnt/backups

# Что будет удалено при текущей политике?
BACKUP_DIR=/mnt/backups bash scripts/rotate-backups.sh --dry-run

# Offsite: последняя выгрузка и restore-drill.
tail -n 30 /var/log/skillwharf-backup.log
tail -n 30 /var/log/skillwharf-restore-drill.log
```

Дампы в `backups/` не попадают в git. Каталог `backups/` стоит хранить на
отдельном носителе и периодически проверять восстановление.

**Восстановление:**

```bash
docker compose stop api
docker compose exec -T postgres pg_restore \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --clean --if-exists \
  < backups/skillwharf_db-20261113-121500.dump
docker compose start api
```

После восстановления проверьте здоровье API и баланс Ledger:

```bash
curl -fsS http://localhost:3001/api/v1/health
curl -fsS http://localhost:3001/metrics | head
```

**Изменение retention:** задайте `BACKUP_KEEP_DAYS` и `BACKUP_KEEP_MIN` в
`.env` (или в cron) и проверьте результат через `--dry-run`. Уменьшать
`BACKUP_KEEP_MIN` ниже 1 не рекомендуется: это разрешает удалить все дампы.

## 6. Диагностика проблем

* **Ошибка: `KVM device not found`**
  * *Решение:* Убедитесь, что хост-система поддерживает виртуализацию (`egrep -c '(vmx|svm)' /proc/cpuinfo` > 0) и модуль KVM загружен (`lsmod | grep kvm`). Если развертывание в облаке, используйте инстансы с поддержкой вложенной виртуализации.
* **Ошибка: `Connection refused` при вызове LLM.**
  * *Решение:* Проверьте доступность API LLM-провайдера из контейнера (`docker compose exec api curl ...`).
* **`db-migrate` завершился с ошибкой, API не стартует.**
  * *Решение:* API ждёт `service_completed_successfully`, поэтому его контейнер
    не запустится. Посмотрите `docker compose logs db-migrate` и
    `docker compose ps -a db-migrate`. Частые причины: неверный
    `DATABASE_URL`, нет прав на схему, конфликтующая/частично применённая
    миграция. Исправьте причину и повторите миграции:
    `docker compose up -d --force-recreate db-migrate`, затем
    `docker compose up -d api`. В production не делайте `migrate reset` —
    исправляйте миграцию вперёд и проверяйте бэкап.
* **API в статусе `unhealthy`.**
  * *Решение:* Проверьте `curl http://localhost:3001/api/v1/health/ready`
    (readiness, проверяет БД) и `curl .../health/live` (процесс).
    `unhealthy` при живом процессе обычно означает проблему с БД или
    `db-migrate`; смотрите `docker compose logs api`.

## 7. Безопасность Sandbox

Код выполняется в отдельном сервисе `sandbox-worker`
(`apps/sandbox-worker`). Только этот сервис получает `/var/run/docker.sock`;
в API сокет не монтируется. API вызывает worker по HTTP:

```text
POST http://sandbox-worker:4000/execute
```

Адрес задаётся переменной `SANDBOX_WORKER_URL` (по умолчанию
`http://sandbox-worker:4000`).

### Worker

* Express-сервер на порту `4000`, порт не публикуется на хост.
* Ограничения контейнера: read-only rootfs, `cap_drop: ALL`,
  `no-new-privileges`, 128 МБ памяти, 0.5 CPU.
* Сеть по умолчанию `none` (deny by default). Egress включается только
  `egress_allowlist` из манифеста навыка, объявившего инструмент, и только
  при `permissions: [network]`: worker запускает контейнер на `bridge` с
  `NET_ADMIN`/`SETUID`/`SETGID`, entrypoint `sandbox/egress-setup.sh`
  настраивает iptables (DNS `127.0.0.11`, `ACCEPT` только на IP разрешённых
  FQDN, `DROP` по умолчанию) и выполняет код от uid 65534.
  `SANDBOX_ALLOW_NETWORK`/`ALLOW_NETWORK` сеть больше не включают (legacy,
  игнорируются).
* Worker запускается от root: GID `docker.sock` зависит от хоста. API при этом
  остаётся непривилегированным и не имеет доступа к Docker.

### Egress по FQDN

Навык объявляет домены в `egress_allowlist` манифеста (точные FQDN в нижнем
регистре, без wildcard/схемы/порта, до 50 доменов). Пустой или отсутствующий
список означает полный запрет сети. Остаточные риски (DNS rebinding/SSRF
через разрешённый домен, DNS-туннель, ротация IP, best-effort IPv6) описаны
в KI-028. Для диагностики: `docker exec <sandbox> iptables -S` недоступен
после завершения контейнера, поэтому смотрите логи worker и результат
команды внутри песочницы (`curl -sS https://<разрешённый-домен>`).

### Seccomp-профиль

Профиль лежит в `sandbox/seccomp-profile.json` и работает по принципу
deny-by-default (`defaultAction: SCMP_ACT_ERRNO`): разрешены только сисколлы,
нужные Node.js/V8, Python, bash, curl, jq и gh. `ptrace`, `mount`, `unshare`,
`setns`, `bpf`, `keyctl`, `perf_event_open`, `kexec_*`, `reboot`,
`swapon/swapoff`, `init_module`, `delete_module`, `pivot_root`, `chroot`,
`personality`, `userfaultfd` и другие опасные вызовы запрещены явно, а
`clone` разрешён только без namespace-флагов.

**Включение.** В базовом `docker-compose.yml` файл уже смонтирован в
`/etc/sandbox/seccomp-profile.json:ro`. Достаточно задать путь внутри
worker-контейнера:

```text
SANDBOX_SECCOMP_PROFILE=/etc/sandbox/seccomp-profile.json
```

Локально переменную можно оставить пустой — тогда worker использует профиль
Docker по умолчанию (прежнее поведение). В staging
`docker-compose.staging.yml` задаёт этот путь жёстко, поэтому профиль
обязателен. Путь указывается именно внутри контейнера worker: worker сам
читает файл и передаёт демону inline JSON, потому что хостовый демон не
видит файловую систему worker.

Если путь задан, но файл отсутствует или не проходит валидацию, worker
завершается с ошибкой (fail closed) и не запускает контейнеры без профиля.
После правки профиля перезапустите worker:

```bash
docker compose up -d --force-recreate sandbox-worker
```

**Проверка.**

1. В логах worker должна быть строка о включении профиля:

   ```bash
   docker compose logs sandbox-worker | grep 'seccomp profile enabled'
   ```

   Ожидаемо: путь `/etc/sandbox/seccomp-profile.json` и число правил.

2. Запустите smoke-тест. Он проверяет утилиты, Python, Node.js/V8 с
   `worker_threads` и `EPERM` для опасных сисколлов:

   ```bash
   bash scripts/test-sandbox.sh
   ```

   На Windows скрипт запускается через Git Bash. На не-amd64 хосте проверки
   seccomp помечаются `SKIP`.

3. Убедитесь, что профиль попал в контейнер, созданный worker. Запустите
   долгую команду через API (не дольше таймаута worker) и на хосте:

   ```bash
   docker ps --filter ancestor=skillwharf-sandbox:latest
   docker inspect --format '{{json .HostConfig.SecurityOpt}}' <container-id>
   ```

   В выводе должны быть `no-new-privileges:true` и `seccomp={...}` с
   `SCMP_ACT_ERRNO`.

**Откат.**

* Если профиль сломал совместимость, верните предыдущую версию
  `sandbox/seccomp-profile.json` и перезапустите worker:

  ```bash
  docker compose up -d --force-recreate sandbox-worker
  ```

* Аварийно отключить профиль локально: очистите `SANDBOX_SECCOMP_PROFILE` в
  `.env` и пересоздайте worker. Это возвращает профиль Docker по умолчанию и
  снова открывает KI-005, поэтому используйте только на время диагностики.

* В staging значение задано в `docker-compose.staging.yml`. Для аварийного
  отключения создайте локальный (не коммитьте его) override-файл:

  ```yaml
  services:
    sandbox-worker:
      environment:
        SANDBOX_SECCOMP_PROFILE: ""
  ```

  и запустите compose с ним:

  ```bash
  docker compose -f docker-compose.yml -f docker-compose.staging.yml \
    -f docker-compose.seccomp-off.yml --profile production \
    up -d --force-recreate sandbox-worker
  ```

  После устранения причины верните профиль и перезапустите worker; не
  оставляйте staging без seccomp.

### Production

Монтировать `/var/run/docker.sock` в API **запрещено**: доступ к сокету
эквивалентен root-доступу к хосту. Сокет должен быть только у
`sandbox-worker`, а порт `4000` — доступен только внутри compose-сети.
Для строгой изоляции замените worker на удалённый Firecracker/gVisor
provider.

### Локальная разработка

`sandbox-worker` входит в базовый `docker-compose.yml`, поэтому достаточно:

```bash
docker compose up -d --build
```

На Windows/macOS с Docker Desktop сокет доступен по
`/var/run/docker.sock`. На Linux используется тот же путь; при нестандартном
расположении сокета задайте `DOCKER_SOCKET` и смонтируйте его в
`sandbox-worker`.

Файл `docker-compose.sandbox-dev.yml` больше не нужен: он оставлен пустым
для совместимости старых команд и не даёт API доступ к сокету.

CI собирает базовый образ API и отдельный образ `sandbox-worker`
(`docker compose build sandbox-worker`).

## 8. Настройка биллинга

Для локальной разработки в `.env` используются mock-значения из
`.env.example`:

```text
# Billing (YooKassa Mock)
YOOKASSA_SHOP_ID=mock_shop_id
YOOKASSA_SECRET_KEY=mock_secret_key
YOOKASSA_RETURN_URL=http://localhost:3001/billing/success
```

### Реальные ключи ЮKassa

1. Получите `shopId` и секретный ключ в личном кабинете ЮKassa
   (раздел «Настройки» → «Магазин» → API-ключи).
2. Пропишите их в `.env`:

   ```text
   YOOKASSA_SHOP_ID=<shopId из личного кабинета>
   YOOKASSA_SECRET_KEY=<секретный ключ>
   YOOKASSA_RETURN_URL=https://<домен>/billing/success
   ```

3. Перезапустите API, чтобы он перечитал переменные:

   ```bash
   docker compose up -d api
   ```

> Секретный ключ ЮKassa — это платёжный секрет. Не коммитьте `.env` и не
> передавайте ключ в открытом виде; в production используйте секрет-хранилище.

### Проверка пополнения и списания

Миграции (включая триггеры append-only для Ledger) применяются автоматически
при старте контейнера через `entrypoint.sh`.

Эндпоинты требуют JWT администратора (`Authorization: Bearer <token>`).

**Пополнение баланса (админка):**

```bash
curl -X POST http://localhost:3001/api/v1/billing/topup \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"userId":"<uuid>","amount":500.00,"description":"Пополнение баланса","idempotencyKey":"topup-001"}'
```

**Списание за вызов Skill:**

```bash
curl -X POST http://localhost:3001/api/v1/billing/charge \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"userId":"<uuid>","amount":10.00,"description":"Списание за вызов Skill","idempotencyKey":"charge-001"}'
```

`idempotencyKey` обязателен: повторный запрос с тем же ключом не создаёт
вторую запись в Ledger. Баланс кошелька можно проверить через
`GET /api/v1/billing/balance`.

Записи Ledger неизменяемы: миграция создаёт триггеры, которые запрещают
`UPDATE` и `DELETE` для `LedgerEntry`.

## 9. Локализация

Интерфейс поддерживает русский (RU) и английский (EN) языки. Язык
переключается в интерфейсе, выбор пользователя сохраняется в браузере и
переопределяет значение по умолчанию.

Язык по умолчанию задаётся переменной окружения:

```text
DEFAULT_LANGUAGE=ru
```

Допустимые значения — `ru` и `en`; если переменная не задана, используется
`ru`. Для англоязычной инсталляции укажите `DEFAULT_LANGUAGE=en` в `.env` и
перезапустите API:

```bash
docker compose up -d api
```

Непереведённые строки откатываются к русскому языку.

## 10. Production: HTTPS с Caddy

Локальный сервис `web` слушает HTTP `:80` (на хосте — `8080`) и проксирует
`/api` и `/socket.io` на `api:3000`. Для production в compose добавлен
отдельный edge-контейнер `caddy` под профилем `production`: он терминирует
TLS, автоматически получает сертификаты Let's Encrypt и передаёт запросы на
`web:80`.

### Подготовка

1. Направьте A/AAAA-запись домена (например, `skillwharf.example.com`) на
   хост и откройте входящие порты `80` и `443`.
2. Задайте домен и e-mail для ACME в `.env`:

   ```text
   DOMAIN=skillwharf.example.com
   ACME_EMAIL=admin@example.com
   ```

3. Убедитесь, что наружу не опубликованы лишние порты. В production должны
   быть доступны только `80` и `443`; `8080` (web) и `3001` (api) закройте
   файрволом или не публикуйте в production-оверрайде.

### Запуск

```bash
docker compose --profile production up -d --build
```

Caddy запустится вместе с базовым стеком, запросит сертификат для `DOMAIN` и
включит автоматический редирект с HTTP на HTTPS.

### Проверка

```bash
curl -I https://skillwharf.example.com
curl -I http://skillwharf.example.com
curl https://skillwharf.example.com/api/v1/health
```

Ожидаемо: HTTPS отвечает `200`, HTTP — редирект `308` на HTTPS, healthcheck
возвращает `{"status":"ok","database":true}`.

WebSocket (`/socket.io/`) идёт через тот же домен: edge-Caddy проксирует
запрос на `web:80`, а `web` — на `api:3000` с сохранением заголовков
`Upgrade`/`Connection`.

> Сертификаты и ACME-аккаунт хранятся в volume `caddy_data`, конфигурация —
> в `caddy_config`. Не удаляйте `caddy_data` при перезапуске, иначе Caddy
> запросит сертификаты повторно и может упереться в лимиты Let's Encrypt.

## 11. Тестирование

### E2E-тесты (Playwright)

Сквозные сценарии лежат в `apps/web/e2e` и запускаются против уже
поднятого стека. Проверяются страница входа, отправка сообщения в чат и
установка навыка из магазина.

1. Установите зависимости и браузер:

   ```bash
   pnpm install
   pnpm exec playwright install --with-deps chromium
   ```

2. Поднимите стек и дождитесь healthcheck:

   ```bash
   docker compose up -d --build
   curl http://localhost:8080/api/v1/health
   ```

3. Для детерминированного ответа чата отключите внешнюю LLM — API вернёт
   эхо-заглушку. В `.env`:

   ```text
   LLM_BASE_URL=
   LLM_MODEL=
   ```

   Затем перезапустите API: `docker compose up -d api`. Если LLM настроена и
   доступна, тест всё равно пройдёт — он проверяет факт ответа, а не его текст.

4. Запустите тесты:

   ```bash
   pnpm exec playwright test
   ```

Тестовый пользователь `e2e@skillwharf.test` создаётся автоматически через
`POST /api/v1/auth/register` и получает стартовый баланс через
`POST /api/v1/billing/topup`; отдельный сид не нужен. Для локального стека
тест повышает пользователя до `admin` и удаляет ранее установленный
`weather-api`, чтобы установка из магазина проверялась при каждом прогоне.

## 12. Наблюдаемость (AgentOps)

API отправляет OTLP-спаны в OTel Collector (профиль `monitoring`) и
по-прежнему пишет OTel-совместимые JSON-события в stdout. Коллектор по
умолчанию печатает трейсы в свой stdout и не отправляет их во внешние SaaS.

**Вызов LLM** (`apps/api/src/llm/llm.service.ts`) — одна запись и один спан
на каждый ответ модели:

```json
{
  "event": "gen_ai.usage",
  "gen_ai.system": "openai",
  "gen_ai.model": "qwen2.5-coder-7b-instruct",
  "gen_ai.agent.id": "office",
  "gen_ai.tenant.id": "<user-id>",
  "gen_ai.skill.id": "<skill-id>",
  "gen_ai.usage.cost": 0.015,
  "gen_ai.prompt_tokens": 128,
  "gen_ai.completion_tokens": 42
}
```

**Запуск агента** (`apps/api/src/chat/chat.service.ts`) — запись и спан перед
обработкой сообщения:

```json
{
  "event": "gen_ai.agent.run",
  "gen_ai.agent.id": "office",
  "gen_ai.tenant.id": "<user-id>",
  "gen_ai.skill.id": "<skill-id>",
  "conversationId": "<conversation-id>"
}
```

### OTel Collector

1. Включите экспорт в `.env`:

   ```text
   OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
   OTEL_SERVICE_NAME=skillwharf-api
   ```

2. Поднимите коллектор и пересоздайте API, чтобы он прочитал env:

   ```bash
   docker compose --profile monitoring up -d otel-collector
   docker compose up -d api
   ```

3. Проверьте, что коллектор принимает спаны:

   ```bash
   docker compose logs -f otel-collector
   curl -fsS http://localhost:3001/api/v1/health/ready
   ```

   В логах появятся `service.name=skillwharf-api`, HTTP/Nest-спаны и
   атрибуты `gen_ai.*`. OTLP-порты `4317`/`4318` опубликованы только на
   `127.0.0.1`.

**Откат:** очистите `OTEL_EXPORTER_OTLP_ENDPOINT` и выполните
`docker compose up -d api`. Коллектор можно остановить командой
`docker compose stop otel-collector`; API продолжит работать без трейсов.
Конфигурация коллектора — `infra/otel/otel-collector.yml`; файл/внешний
экспортёр добавляйте осознанно, чтобы не отправлять данные в SaaS.

### Sentry

Sentry выключен, пока `SENTRY_DSN` пуст. Для включения задайте в `.env`:

```text
SENTRY_DSN=https://<public-key>@<sentry-host>/<project-id>
SENTRY_ENVIRONMENT=production
SENTRY_RELEASE=<git-sha>
```

и пересоздайте API (`docker compose up -d api`). DSN — секрет: не коммитьте
его и не передавайте в логи.

Перед отправкой события Sentry удаляются HTTP-заголовки, тела запросов,
cookies, query string, `user`, контексты и переменные stack frame; токены в
сообщениях и breadcrumbs маскируются (`[REDACTED]`). В key integration
отключены user info, AI inputs/outputs и MCP content (`dataCollection`).
Ошибки 4xx не считаются необработанными; фильтр `SentryGlobalFilter`
перехватывает непредвиденные исключения и 5xx, сохраняя JSON-формат Nest.

**Проверка:** временно вызовите тестовый 500/исключение на стенде и
убедитесь, что событие появилось в Sentry без заголовков `Authorization`,
тел запросов и токенов. **Откат:** очистите `SENTRY_DSN` и пересоздайте API.

### Grafana: стоимость по tenant

API экспортирует Prometheus-метрику:

```text
llm_cost_total{tenant_id="<user-id>",model="<model>",agent_id="<agent>"}
```

Стоимость — в рублях, рассчитывается по `LLM_COST_PER_1K_TOKENS` и
фактическому/оценочному usage. `tenant_id` — внутренний userId, не email.

```promql
# Стоимость за выбранный период по tenant
sum by (tenant_id) (increase(llm_cost_total[$__range]))

# Токены по модели
sum by (model) (increase(llm_tokens_total[$__range]))
```

На дашборде `SkillWharf Overview` добавлены панели **Cost by Tenant** и
**Tokens by Model**. Запуск мониторинга:

```bash
docker compose --profile monitoring up -d
```

Grafana: <http://localhost:3003/>, Prometheus: <http://localhost:9090/>.
Если `llm_cost_total` ещё не появилась, выполните хотя бы один вызов LLM с
настроенным провайдером — Counter создаёт серию только после первого
инкремента.

Как читать логи:

```bash
# Все события GenAI
docker compose logs api | grep gen_ai

# Поток логов в реальном времени
docker compose logs -f api
```

В PowerShell вместо `grep` используйте
`docker compose logs api | Select-String gen_ai`.

Атрибуты `gen_ai.prompt_tokens` и `gen_ai.completion_tokens` позволяют считать
стоимость по модели, а `gen_ai.tenant.id` — разносить расходы по клиентам.
Если провайдер не вернул usage, значения будут `0`.
На удалённом стенде (`E2E_BASE_URL`) эти шаги пропускаются: роль и чистое
состояние должен обеспечить сид.

Адрес стенда переопределяется переменной `E2E_BASE_URL` (по умолчанию
`http://localhost:8080`).

### Отчёты и артефакты

HTML-отчёт открывается командой:

```bash
pnpm exec playwright show-report
```

При падении Playwright сохраняет скриншоты и trace в `test-results/`, отчёт —
в `playwright-report/`. В CI эти каталоги публикуются артефактом
`playwright-artifacts` (job `e2e`, retention 7 дней).

### Что делать при падении

* `#email`/`#password` не найдены — проверьте, что `/` редиректит на `/login`,
  а статика собирается из актуального `apps/web`.
* Поле `#chat-message` остаётся disabled — не поднялся Socket.IO; проверьте
  `docker compose logs web api` и проксирование `/socket.io`.
* В чате `insufficient funds` — у тестового пользователя не пополнился
  баланс; проверьте доступность `POST /api/v1/billing/topup`.
* Пустой магазин — не отвечает `GET /api/v1/registry/skills`; проверьте
  `docker compose logs api` и модуль `RegistryModule`.
* Установка навыка возвращает 403 — тестовый пользователь не `admin`;
  локально это делает `promoteToAdmin()` в `beforeAll`.

## 13. Импорт навыков

Навыки из OpenClaw переносятся ZIP-архивом через Control Plane или API.
Эндпоинт доступен только администратору:

```text
POST /api/v1/admin/skills/import
Content-Type: multipart/form-data
Поле файла: file
```

Ограничения и проверки:

* размер архива — до 5 МБ;
* `SKILL.md` ищется в корне архива или во вложенной папке;
* YAML frontmatter валидируется схемой `SkillManifestSchema`;
* skill-vetter блокирует опасные команды (`rm -rf`, `eval`, `curl | sh`);
* при успехе навык сохраняется или обновляется в `InstalledSkill`.

Пример запроса:

```bash
curl -X POST http://localhost:3001/api/v1/admin/skills/import \
  -H "Authorization: Bearer <JWT_АДМИНА>" \
  -F "file=@my-skill.zip"
```

В интерфейсе откройте **Пульт управления → Навыки → Импорт из OpenClaw**,
выберите ZIP-архив и нажмите «Импортировать». Успех подтверждается
сообщением «Навык успешно импортирован», ошибки валидации и skill-vetter
показываются в модалке.

## 14. Тестирование оплаты (ЮKassa)

ЮKassa присылает HTTP-уведомления только на публичный HTTPS-адрес. Для
локального стенда поднимите временный туннель к API на порту `3001`.

### Временный туннель

Через `cloudflared`:

```bash
cloudflared tunnel --url http://localhost:3001
```

Или через `ngrok`:

```bash
ngrok http 3001
```

Скопируйте выданный адрес, например
`https://random-name.trycloudflare.com`. Он живёт только пока запущен
туннель; после перезапуска URL изменится.

### Настройка в личном кабинете ЮKassa

1. Откройте **Личный кабинет → Интеграция → HTTP-уведомления**.
2. Укажите адрес вебхука:

   ```text
   https://random-name.trycloudflare.com/api/v1/billing/webhook
   ```

3. Включите событие `payment.succeeded`. Остальные события API принимает,
   логирует и игнорирует, поэтому `payment.canceled` можно не подключать.
4. Сохраните настройки. Публичный URL должен быть HTTPS и без завершающего
   слэша.

### Переменные окружения

В `.env` должны быть заполнены:

```text
YOOKASSA_SHOP_ID=<shopId>
YOOKASSA_SECRET_KEY=<секретный ключ>
YOOKASSA_RETURN_URL=http://localhost:8080/app/chat?payment=success
```

Сервис `api` получает эти переменные из `env_file: .env` и явно объявленного
блока `environment` в `docker-compose.yml`. После изменения `.env`
перезапустите API:

```bash
docker compose up -d api
```

### Проверка вебхука

1. Откройте логи API:

   ```bash
   docker compose logs -f api
   ```

2. Нажмите «Пополнить» в интерфейсе и оплатите тестовой картой ЮKassa.
3. После возврата проверьте в логах запись `ЮKassa webhook: зачислено ...`
   и обновлённый баланс в кошельке.

Если вебхук не приходит, проверьте, что туннель запущен, URL в кабинете
указывает на `/api/v1/billing/webhook`, а API доступен по `/api/v1/health`.
Не коммитьте реальные ключи ЮKassa и выключайте туннель после тестирования.

## 15. Подключение MCP-серверов

Для Ozon и Wildberries используются Python MCP-серверы с транспортом SSE:

| Сервис | Пакет | Версия | Порт |
| --- | --- | --- | --- |
| `ozon-mcp` | `ozon-mcp-server` | 2.5.2 | 5001 |
| `wb-mcp` | `wb-mcp-server` | 2.6.1 | 5002 |

Оба сервиса описаны в `docker-compose.mcp.yml` и собираются из
`infra/mcp/*.Dockerfile`. API обращается к ним по внутренней сети через
`OZON_MCP_URL` и `WB_MCP_URL`, а ключи передаются только контейнерам MCP.

### Получение ключей

**Ozon** (seller.ozon.ru):

1. Настройки → API-ключи: создайте Client ID и Api-Key для Seller API.
2. Для рекламы (Performance API) создайте отдельные Client ID и
   Client Secret.
3. Заполните в `.env`:

   ```text
   OZON_CLIENT_ID=<client-id>
   OZON_API_KEY=<api-key>
   OZON_PERF_CLIENT_ID=<performance-client-id>
   OZON_PERF_CLIENT_SECRET=<performance-client-secret>
   ```

**Wildberries** (seller.wildberries.ru):

1. Настройки → Доступ к API → Создать токен. Отметьте категории, которые
   нужны навыку (контент, цены, заказы, финансы и т.д.).
2. Заполните в `.env`:

   ```text
   WB_API_TOKEN=<токен>
   ```

3. Токен действует 180 дней; срок можно проверить на странице
   `/diagnostics` WB MCP-сервера.

Для защиты `/sse` задайте общий токен:

```text
MCP_AUTH_TOKEN=<случайная строка>
```

Пустое значение отключает авторизацию — допустимо только во внутренней
compose-сети.

### Запуск MCP-серверов

```bash
docker compose -f docker-compose.yml -f docker-compose.mcp.yml up -d --build
```

Проверка:

```bash
curl http://localhost:5001/api/health
curl http://localhost:5002/api/health
```

Веб-панели MCP-серверов: <http://localhost:5001/shops> и
<http://localhost:5002/shops>. Через них можно добавить магазин и проверить
ключи кнопкой «Проверить».

### Вызов из агента

Инструменты `ozon_mcp_call` и `wb_mcp_call` передают `action` как точное имя
MCP-инструмента из `tools/list`:

```json
{
  "action": "ozon_get_prices",
  "params": { "shop_id": "default" }
}
```

Примеры имён: `ozon_get_prices`, `ozon_orders_fbs`, `ozon_reviews_list`,
`wb_cards_list`, `wb_finance_report`, `wb_advert_list`. Полный список
возвращает `tools/list` соответствующего сервера.

Если ключи не заданы, инструмент вернёт `Ozon API keys not configured` или
`WB API token not configured` и не будет обращаться к MCP-серверу.

### Безопасность

* Не публикуйте порты `5001`/`5002` в интернет: веб-панели MCP не защищены
  `MCP_AUTH_TOKEN`.
* Для удалённого доступа используйте VPN или reverse proxy с TLS.
* Ключи маркетплейсов хранятся в зашифрованном виде в volume
  `ozon_mcp_data`/`wb_mcp_data`; не копируйте только `shops.json` без
  `.encryption_key`.
* Фоновые проверки MCP-серверов отключены (`HEALTH_CHECK_INTERVAL_MIN=0`),
  чтобы не расходовать лимиты API; включайте их осознанно.

## 16. Мониторинг и staging

### Prometheus и Grafana

API отдаёт метрики на `GET /metrics` (вне префикса `api/v1`). Prometheus
скрейпит `api:3000/metrics`, Grafana при старте получает datasource и дашборд
`SkillWharf Overview` из `infra/monitoring`.

Мониторинг закрыт HTTP Basic Auth. Пароли и bcrypt-хэши не хранятся в git:
задайте их в `.env` (см. `.env.example`). На staging оба пути проходят через
Caddy, а Prometheus дополнительно проверяет креды нативно через
`web.config.file` с `basic_auth_users`.

```bash
# 1. Сгенерируйте bcrypt-хэш пароля (значение содержит `$`).
read -rs -p 'Monitoring password: ' P; echo
docker run --rm caddy:2-alpine caddy hash-password --plaintext "$P"

# 2. Внесите в .env; хэш — в одинарных кавычках.
# Пароль — без `$` (Grafana provisioning повторно интерпретирует `$`).
# MONITORING_BASIC_AUTH_USER=monitoring
# MONITORING_BASIC_AUTH_PASSWORD=<пароль без $>
# MONITORING_BASIC_AUTH_HASH='$2a$...'
# GRAFANA_ADMIN_USER=admin
# GRAFANA_ADMIN_PASSWORD=<отдельный пароль Grafana>

# 3. Запустите staging с профилем monitoring.
docker compose -f docker-compose.yml -f docker-compose.staging.yml \
  --profile production --profile monitoring up -d
```

Проверка на staging:

```bash
# -k нужен для self-signed сертификата staging; на боевом домене уберите его.
# Без кредов — 401 (Caddy для /grafana/ и /prometheus/).
curl -ksS -o /dev/null -w '%{http_code}\n' https://$DOMAIN/grafana/
curl -ksS -o /dev/null -w '%{http_code}\n' https://$DOMAIN/prometheus/

# С кредами — 302/200 для Grafana и 200 для Prometheus.
curl -ksS -u "$MONITORING_BASIC_AUTH_USER:$MONITORING_BASIC_AUTH_PASSWORD" \
  -o /dev/null -w '%{http_code}\n' https://$DOMAIN/grafana/
curl -ksS -u "$MONITORING_BASIC_AUTH_USER:$MONITORING_BASIC_AUTH_PASSWORD" \
  -o /dev/null -w '%{http_code}\n' https://$DOMAIN/prometheus/

# Healthcheck API не должен затрагиваться Basic Auth.
curl -kfsS https://$DOMAIN/api/v1/health
```

* Grafana: <https://$DOMAIN/grafana/> — Caddy Basic Auth, затем вход в
  Grafana с `GRAFANA_ADMIN_USER`/`GRAFANA_ADMIN_PASSWORD`. Дефолтный
  `admin/admin` не используется.
* Prometheus: <https://$DOMAIN/prometheus/> — Caddy Basic Auth и нативная
  проверка `basic_auth_users`. Прямой `http://127.0.0.1:9090` тоже требует
  креды.

В локальном dev-профиле (`docker compose --profile monitoring up -d`) те же
переменные обязательны: контейнеры не стартуют с пустыми паролями.
Порты по-прежнему опубликованы только на `127.0.0.1`; для удалённого доступа
используйте SSH-туннель или Caddy.

Дашборд показывает `http_requests_total`, `llm_tokens_total` и
`llm_errors_total`. Grafana обращается к Prometheus с теми же
`MONITORING_BASIC_AUTH_*` через provisioned datasource.

### Staging

`docker-compose.staging.yml` — оверрайд поверх базового compose. Наружу
открыты только `80`/`443` (Caddy), остальные порты слушают `127.0.0.1`.
Критичные переменные объявлены через `${VAR:?}`: без реальных значений в
`.env` запуск падает до старта контейнеров, mock-провайдеры не включаются.
Это же касается `MONITORING_BASIC_AUTH_*` и `GRAFANA_ADMIN_PASSWORD`.

Caddy на staging маршрутизирует `/grafana/*` и `/prometheus/*` через Basic
Auth, а остальной трафик — на `web:80`. Поэтому API healthcheck
(`/api/v1/health`) и фронтенд не требуют авторизации мониторинга. Для
доступа к панелям поднимите профиль `monitoring` (см. раздел выше).

```bash
docker compose -f docker-compose.yml -f docker-compose.staging.yml \
  --profile production up -d --build
```

Caddy выпускает сертификат Let's Encrypt. По умолчанию используется
staging-CA (`ACME_CA`), поэтому браузер будет ругаться на недоверенный
сертификат — это ожидаемо. Для боевого домена задайте:

```text
ACME_CA=https://acme-v02.api.letsencrypt.org/directory
```

## 17. HITL, ожидающие одобрения и checkpoint'ы

Состояние графа агента (LangGraph) и ожидающие подтверждения хранятся в
PostgreSQL, поэтому пауза `waiting_approval` и escrow-hold переживают
`docker compose restart api`:

* `GraphCheckpoint` / `GraphCheckpointWrite` — сериализованное состояние
  графа по треду `thread_id = conversationId`;
* `PendingApproval` — ожидающие решения действия (`reason`: `approval` или
  `payment`), инструменты и зарезервированные escrow-holds.

Таблицы создаются миграцией `20261113150000_add_graph_checkpointer_and_pending_approval`.
В Compose миграции применяет one-shot сервис `db-migrate`; API стартует
только после его успешного завершения. В Kubernetes нужен такой же Job
(см. KI-037).

**Диагностика ожиданий:**

```bash
# Ожидающие одобрения пользователя (JWT): conversationId, reason, tools
curl -H "Authorization: Bearer <token>" \
  http://localhost:8080/api/v1/chat/pending

# Сколько hold'ов заморожено в Ledger (PENDING)
docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "SELECT count(*), sum(amount) FROM \"LedgerEntry\" WHERE type = 'PENDING';"
```

**Поведение:**

* подтверждение/отклонение — `approve_action` по WebSocket; граф
  возобновляется из checkpoint'а и стримит ответ;
* отклонение отменяет hold (`PENDING` → `credit`), баланс возвращается;
* новое сообщение в диалоге со старым ожиданием автоматически закрывает его
  как `rejected`, отменяет hold'ы и удаляет checkpoint треда;
* TTL для ожиданий пока нет (KI-033): зависшие записи закрывайте вручную
  через `approve_action` с `approved: false`;
* ретенции checkpoint'ов нет (KI-034): в пилоте объём мал, долгосрочно нужен
  retention-job.

**Восстановление из бэкапа:** таблицы checkpoint'ов входят в общий дамп БД,
поэтому после восстановления ожидания и позиция графа сохраняются вместе с
Ledger. После восстановления проверьте отсутствие «осиротевших» `PENDING`
без активных `PendingApproval`.

## 18. Telegram webhook

1. Создайте бота у `@BotFather`, получите `TELEGRAM_BOT_TOKEN`.
2. Сгенерируйте секрет webhook и запишите его в `.env`:

   ```bash
   openssl rand -hex 32
   # TELEGRAM_WEBHOOK_SECRET=<значение>
   # TELEGRAM_WEBHOOK_RATE_LIMIT=120
   ```

3. Пересоберите и перезапустите API; Caddy проксирует
   `/api/v1/webhooks/telegram` напрямую в `api:3000`:

   ```bash
   docker compose up -d --build api caddy
   docker compose logs --tail=50 api
   ```

4. Зарегистрируйте webhook у Telegram (публичный URL — через Caddy):

   ```bash
   curl -fsS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
     -H 'content-type: application/json' \
     -d "{\"url\":\"https://${DOMAIN}/api/v1/webhooks/telegram\",\"secret_token\":\"${TELEGRAM_WEBHOOK_SECRET}\"}"
   ```

   Альтернатива — admin-эндпоинт
   `POST /api/v1/integrations/telegram/webhook/register`
   с `{ "publicUrl": "https://<domain>/api/v1/webhooks/telegram" }`.

5. Проверка:

   ```bash
   curl -fsS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"
   # Ожидаемо: url = https://<domain>/api/v1/webhooks/telegram, ошибок нет

   # Секрет обязателен: без него/с неверным — 401,
   # без TELEGRAM_WEBHOOK_SECRET — 503 (fail closed)
   curl -i -X POST "https://${DOMAIN}/api/v1/webhooks/telegram" \
     -H 'content-type: application/json' \
     -H "X-Telegram-Bot-Api-Secret-Token: ${TELEGRAM_WEBHOOK_SECRET}" \
     -d '{"update_id":1}'
   ```

   Rate limit — `TELEGRAM_WEBHOOK_RATE_LIMIT` запросов в минуту на IP
   (Caddy передаёт реальный IP в `X-Forwarded-For`; API настроен на
   `trust proxy`). На валидный update endpoint отвечает 200.

## 19. Google Workspace OAuth

1. В Google Cloud Console создайте проект, включите Google Sheets API,
   Google Docs API и Google Calendar API.
2. Настройте OAuth consent screen (Internal или Testing) и создайте
   OAuth client типа **Web application**.
3. Authorized redirect URI:

   ```text
   https://<domain>/api/v1/integrations/google/callback
   ```

4. Заполните `.env`:

   ```bash
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_REDIRECT_URI=https://<domain>/api/v1/integrations/google/callback
   # optional: GOOGLE_OAUTH_SCOPES=...
   # optional: GOOGLE_OAUTH_STATE_SECRET=<отдельный HMAC-секрет>
   TOKEN_ENCRYPTION_KEY=$(openssl rand -base64 32)
   TOKEN_ENCRYPTION_KEY_ID=local-v1
   ```

   `TOKEN_ENCRYPTION_KEY` — 32 байта в base64 (или 64 hex-символа). В
   production храните его в Docker secret/менеджере секретов, не в git.

5. Перезапустите API и проверьте статус:

   ```bash
   docker compose up -d --build api
   curl -fsS "http://localhost:3001/api/v1/integrations/google/status" \
     -H "Authorization: Bearer <JWT>"
   # Ожидаемо: {"configured":true,"connected":false}
   ```

6. Получите URL согласия (`GET /api/v1/integrations/google/authorize` с JWT),
   откройте в браузере и подтвердите доступ. Callback сохранит access и
   refresh-токены; access обновляется автоматически.

7. Проверка шифрования:

   ```bash
   docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
     -c 'SELECT "userId", left("refreshToken", 3) AS prefix, length("refreshToken") FROM "GoogleCredential";'
   ```

   Ожидаемо: `prefix = v1:`; открытого токена в колонках нет. При потере
   `TOKEN_ENCRYPTION_KEY` старые токены не расшифруются — см. KI-053.

## 20. Egress api/worker

Внешние запросы API (Telegram, Google OAuth/API) и worker (LLM)
проверяются allowlist из `@skillwharf/shared`:

```bash
# В .env / compose
API_OUTBOUND_ALLOWLIST=api.telegram.org,www.googleapis.com,oauth2.googleapis.com,sheets.googleapis.com,docs.googleapis.com,api.ttapi.io,api-performance.ozon.ru,discounts-prices-api.wildberries.ru
LLM_WORKER_OUTBOUND_ALLOWLIST=api.telegram.org,www.googleapis.com,oauth2.googleapis.com,sheets.googleapis.com,docs.googleapis.com,api.ttapi.io,api-performance.ozon.ru,discounts-prices-api.wildberries.ru,llm.api.cloud.yandex.net,iam.api.cloud.yandex.net,ngw.devices.sberbank.ru,gigachat.devices.sberbank.ru
```

Правила:

* внешний URL — только `https` и только домен из allowlist;
* локальные `host.docker.internal`, `127.0.0.1`, RFC1918 и compose-имена
  разрешены для dev (LM Studio/Ollama);
* неизвестный домен — `403 errors.outbound_blocked`, запрос не уходит в сеть.

Egress — прикладной allowlist, не замена NetworkPolicy (KI-052).

## 18. Интеграции: Telegram и Google Workspace

### 18.1. Переменные окружения

| Переменная | Назначение |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Токен системного бота (BotFather) для webhook и исходящих по умолчанию |
| `TELEGRAM_WEBHOOK_SECRET` | Секрет webhook (`openssl rand -hex 32`); без него endpoint отвечает 503 |
| `TELEGRAM_WEBHOOK_RATE_LIMIT` | Лимит запросов webhook на IP в минуту (по умолчанию 120) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | OAuth-клиент Google Cloud Console |
| `GOOGLE_REDIRECT_URI` | Должен совпадать с redirect URI клиента (например, `https://<host>/api/v1/integrations/google/callback`) |
| `GOOGLE_OAUTH_SCOPES` | Через запятую; пусто — Sheets/Docs/Calendar по умолчанию |
| `GOOGLE_OAUTH_STATE_SECRET` | HMAC для OAuth-state; пусто — берётся `TOKEN_ENCRYPTION_KEY` |
| `GOOGLE_OAUTH_SUCCESS_REDIRECT` | Полный URL веб-приложения для возврата после OAuth; пусто — JSON-ответ |
| `TOKEN_ENCRYPTION_KEY` | AES-256-GCM ключ для токенов (`openssl rand -base64 32`), только Docker secret/KMS |
| `GOOGLE_CALENDAR_ID` | Календарь для `google_calendar_create` (`primary` по умолчанию) |
| `API_OUTBOUND_ALLOWLIST` | Домены egress API: Telegram, Google OAuth/API, Sheets/Docs; только https |
| `PROVIDER_RETRY_*` | Повторы 429/5xx: max attempts, base/max delay, предел ожидания `retry_after` |

Секреты не коммитить: в `.env` локально, в production — Docker secret или
KMS. Без `TOKEN_ENCRYPTION_KEY` подключение Google не сохраняется (503
`errors.provider_not_configured`).

### 18.2. Telegram

1. Создайте бота у `@BotFather`, задайте `TELEGRAM_BOT_TOKEN` и
   `TELEGRAM_WEBHOOK_SECRET`.
2. Зарегистрируйте webhook (admin-JWT):
   `POST /api/v1/integrations/telegram/webhook/register` с
   `{ "publicUrl": "https://<host>/api/v1/webhooks/telegram" }` либо curl:
   `curl "https://api.telegram.org/bot<token>/setWebhook" -d "url=https://<host>/api/v1/webhooks/telegram" -d "secret_token=<secret>"`.
   Caddy проксирует `/api/v1/webhooks/telegram` напрямую в API (см. раздел 10).
3. Подключите бота в UI (Настройки → Интеграции) или `POST /api/v1/integrations/telegram`
   с `{ "botToken": "<token>" }` — токен проверяется через `getMe` и
   сохраняется зашифрованным. Персональный бот используется для исходящих;
   входящие обслуживает системный бот (KI-056).
4. Привяжите чат: `POST /api/v1/integrations/telegram/link` с `{ "chatId": "<id>" }`
   (JWT пользователя). Сообщения из этого чата маршрутизируются в его диалог;
   непривязанный чат получает подсказку.
5. Проверка: `GET /api/v1/integrations` → `telegram.status = "active"`,
   `GET /api/v1/health`; логи `telegram.chat_linked`, `telegram.bot_connected`.

### 18.3. Google Workspace

1. В Google Cloud Console создайте OAuth client (Web application) и добавьте
   redirect URI `GOOGLE_REDIRECT_URI`; включите Google Sheets API, Google Docs
   API и Google Calendar API.
2. Задайте `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`,
   сгенерируйте `TOKEN_ENCRYPTION_KEY` (32 байта base64) и перезапустите API.
3. Пользователь открывает Настройки → Интеграции → «Подключить Google»;
   `GET /api/v1/integrations/google/authorization-url` отдаёт URL согласия,
   callback сохраняет зашифрованные access/refresh-токены и email. При
   `GOOGLE_OAUTH_SUCCESS_REDIRECT` браузер возвращается в настройки с
   `?integration=google&status=success|error`.
4. Проверка: `GET /api/v1/integrations/google/status` →
   `{ connected: true, email, expiresAt }`; инструменты
   `google_sheets_append` / `google_docs_create` / `google_calendar_create`
   возвращают реальные `spreadsheetId`/`documentId`/`eventId`.
5. Отключение: `DELETE /api/v1/integrations/google` (локальные токены
   удаляются; revoke в Google пока не вызывается — KI-054).

### 18.4. Ошибки и лимиты

* 429 после всех повторов — `errors.provider_rate_limited` (повторить позже);
  5xx/сеть — `errors.provider_unavailable`; 401/403 —
  `errors.provider_auth_required` (для Google нужно заново пройти OAuth);
  нет ключей — `errors.provider_not_configured`; запрещённый домен —
  `errors.outbound_blocked`.
* Повторы: экспоненциальный backoff (`PROVIDER_RETRY_BASE_DELAY_MS`,
  `PROVIDER_RETRY_MAX_DELAY_MS`), `Retry-After` учитывается, но ожидание
  больше `PROVIDER_RETRY_MAX_AFTER_MS` не выполняется — сразу 429.
* Egress: внешние запросы только https и только домены из
  `OUTBOUND_ALLOWLIST`; при добавлении нового API обновите allowlist в
  `.env`/compose.
* Тесты без реальных ключей: `pnpm --filter api test` — Telegram/Google
  эмулируются nock (429/401/refresh, тела запросов, webhook secret).

## 19. Финансовые интеграции и Midjourney

### 19.1. Источники данных Ozon/WB

Финансовые инструменты не используют демо-данные: они вызывают MCP-серверы
Ozon/WB. Нужны ключи продавца и запущенный MCP-стек
(`docker compose -f docker-compose.yml -f docker-compose.mcp.yml up -d`).

* `OZON_CLIENT_ID`, `OZON_API_KEY` — Ozon Seller API; для рекламы нужны
  Performance-ключи `OZON_PERF_CLIENT_ID`/`OZON_PERF_CLIENT_SECRET` и
  `OZON_PERFORMANCE_API_BASE_URL=https://api-performance.ozon.ru`
  (старый `performance.ozon.ru` не использовать);
* `WB_API_TOKEN` — Wildberries Seller/Marketplace + Pricing;
  Pricing API живёт на отдельном хосте
  `WB_PRICING_API_BASE_URL=https://discounts-prices-api.wildberries.ru`
  (не `marketplace-api.wildberries.ru`);
* токен WB действует 180 дней; отдельного API-поля срока действия нет —
  дату создания/окончания фиксируйте в кабинете продавца и проверяйте
  `GET {WB_PRICING_API_BASE_URL}/ping` (см. `scripts/test-integrations.sh`);
* endpoint берётся из `mcp_endpoint` манифеста навыка, fallback —
  `OZON_MCP_URL`/`WB_MCP_URL` (compose задаёт `http://ozon-mcp:5001`,
  `http://wb-mcp:5002`);
* `MCP_AUTH_TOKEN` — общий Bearer для `/sse` (опционально).

Получение ключей:

* **Ozon Performance**: кабинет Ozon Performance → API → создать
  Client ID/Secret; запросы идут на `https://api-performance.ozon.ru`
  (старый `performance.ozon.ru` мёртв с января 2025).
* **WB Pricing**: кабинет продавца → Настройки → Доступ к API → создать
  токен с категорией «Цены и скидки»; запросы — на
  `https://discounts-prices-api.wildberries.ru`, токен действует 180 дней.

Проверка ключей без MCP UI:

```bash
bash scripts/test-integrations.sh --ozon --wb
```

Ozon проверяется `POST /v1/product/import/prices` с пустым `prices:[]`
(цены не меняются), WB — `GET /ping` на Pricing-хосте. 401/403 — ошибка,
400/422 для Ozon означает, что ключ принят, а тестовое тело отклонено.

Проверка MCP: `curl http://127.0.0.1:5001/api/health` и
`scripts/test-integrations.sh` (при заданных ключах делает реальные запросы,
секреты не печатает).

### 19.2. Инструменты и периоды

| Инструмент | Действия MCP | Особенности |
| --- | --- | --- |
| `calculate_unit_economics` | `ozon_finance_totals`, `ozon_analytics`, `ozon_get_prices`, `wb_finance_report` | Ozon — период ≤ 31 дня; расходы распределяются по выручке SKU (KI-061); без `cost` маржа не считается |
| `detect_profit_leaks` | `ozon_finance_totals`, `ozon_finance_transactions`, `wb_finance_report`, `wb_deductions`, `wb_prices_quarantine` | Pay-per-Call 300 ₽, списание после успешного вызова; аномалии — по реальным accruals |
| `monitor_competitor_prices` | `ozon_get_prices`, `ozon_pricing_competitor_prices`, `wb_prices_list` | Для Ozon нужен `productId`; WB конкурентные цены не отдаёт |
| `audit_fraud_risk` | `ozon_ad_campaigns`, `ozon_ad_statistics_expenses`, `wb_advert_list`, `wb_advert_costs`, `wb_deductions`, `wb_analytics_antifraud` | Pay-per-Outcome 500 ₽ + подтверждение; ERID/UTM проверяются в сырых данных (KI-062) |

Ошибки: нет данных по SKU — `dataAvailable:false`; непригодный ответ MCP —
502 `errors.mcp_provider`; лимит/таймаут MCP — `errors.mcp_timeout`;
не сконфигурирован — `errors.mcp_unavailable`.

Сверка MCP-действий с аудитом API (11.2026):

* `ozon_analytics` → `/v1/analytics/data`;
* `ozon_finance_totals` / `ozon_finance_transactions` → начисления
  `/v1/finance/accrual/by-day`: `/v3/finance/transaction/list` отключён
  Ozon, MCP-сервер пересобирает операции по дням (не вызывайте v3 напрямую);
* `ozon_get_prices` → `/v5/product/info/prices` — это read-метод;
  `/v1/product/import/prices` — write-импорт цен (используется только в
  `scripts/test-integrations.sh` с пустым телом);
* `ozon_pricing_competitor_prices`, `ozon_ad_campaigns`,
  `ozon_ad_statistics_expenses` — Ozon Performance
  (`api-performance.ozon.ru`);
* `wb_prices_list` → хост `discounts-prices-api.wildberries.ru`,
  `/api/v2/list/goods/filter`; внутри MCP-сервера авторизация — raw
  `Authorization` без `Bearer`, наружу это не выходит;
* `wb_finance_report` → отчёт о реализации (комиссии, логистика,
  возвраты, штрафы), `wb_deductions` → удержания за подмены,
  `wb_analytics_antifraud` → самовыкупы.

### 19.3. Midjourney (TTAPI)

Официального API нет; разрешён только TTAPI — выбранный провайдер по аудиту
ноября 2026. GoAPI/UseAPI и Discord-обёртки не используются.

1. Получите ключ в кабинете TTAPI и задайте:

   ```text
   MIDJOURNEY_API_KEY=<ключ TTAPI>
   ```

2. Эндпоинты зафиксированы в коде и не переопределяются окружением:
   * `POST https://api.ttapi.io/midjourney/v1/imagine`
     (заголовок `TT-API-KEY`, тело `{ "prompt": "...", "mode": "fast" }`)
     → `jobId`;
   * `GET https://api.ttapi.io/midjourney/v1/fetch?jobId=<jobId>`
     (тот же заголовок) → `status`, `imageUrl`.
   Поллинг — `MIDJOURNEY_POLL_INTERVAL_MS`/`MIDJOURNEY_TIMEOUT_MS`.
3. Домен `api.ttapi.io` зафиксирован в `API_OUTBOUND_ALLOWLIST`; другие
   домены Midjourney не добавляйте — смена провайдера запрещена.
4. Проверка ключа без генерации:

   ```bash
   bash scripts/test-integrations.sh --midjourney
   ```

   Скрипт делает `GET /midjourney/v1/fetch?jobId=test`; 404/2xx — ключ
   принят, 401 — ключ отклонён.

Ограничения: 429/5xx повторяются, после исчерпания —
`errors.provider_rate_limited`/`provider_unavailable`; Pay-per-Call
0.50 ₽ списывается после успешной генерации; при ошибке/таймауте списания
нет. TTAPI не даёт официального SLA (KI-059).

### 19.4. Финансовый дашборд: REST `/finance/*`

Дашборд `/app/finance` читает сохранённые результаты инструментов агента, а
не пересчитывает финансы сам. Поэтому GET не тратит квоты маркетплейсов и
не обходит оплату навыков.

| Маршрут | Назначение |
| --- | --- |
| `GET /api/v1/finance/overview` | агрегат `unit-economics`, `profit-leak-detector`, `fraud-shield-audit` |
| `GET /api/v1/finance/unit-economics?sku=&marketplace=` | таблица SKU |
| `GET /api/v1/finance/profit-leaks?marketplace=` | алерты утечек |
| `GET /api/v1/finance/fraud-shield?campaignId=` | последний аудит кампании |

Все маршруты требуют JWT (`Authorization: Bearer <access token>`);
`userId` берётся только из токена. Ответы валидируются Zod
(`apps/api/src/finance/finance-contracts.ts`), схема совпадает с
`apps/web/src/lib/finance.ts`. Некорректные query-параметры → `400`
`errors.invalid_request`.

Как появляются данные:

1. Пользователь запускает `unit-economics`/`profit-leak-detector`/
   `fraud-shield-audit` в чате — инструменты делают реальные MCP-вызовы
   Ozon/WB и списывают BAL (Pay-per-Call/Pay-per-Outcome).
2. `AgentToolsService` после успешного вызова пишет ответ в
   `FinanceSnapshotStore`.
3. Дашборд читает снапшоты: Redis (`REDIS_URL`,
   `FINANCE_SNAPSHOT_TTL_SECONDS`, по умолчанию 604800 — 7 суток); если
   Redis не задан/недоступен — память процесса API.

Проверка:

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:3000/api/v1/finance/overview | jq
```

Ожидаемые состояния:

* расчётов не было — `200`, `dataAvailable: false`, `reason` с просьбой
  запустить инструмент в чате, `unitEconomics: []`;
* есть снапшоты — `dataAvailable: true`, `currency: "RUB"`, `period`,
  `updatedAt`, массивы результатов;
* Redis недоступен — в логах `finance.snapshots.redis_unavailable` /
  `finance.snapshots.redis_fallback`, дашборд продолжает работать на памяти
  процесса (в multi-replica окружении данные могут быть не видны на другой
  реплике).

Ограничения: снапшоты не пересчитываются и не обновляются фоном — это
последний расчёт пользователя; после `FINANCE_SNAPSHOT_TTL_SECONDS` записи
истекают и дашборд снова показывает `dataAvailable: false`. Подключение
ключей из UI пока не реализовано (KI-063).
