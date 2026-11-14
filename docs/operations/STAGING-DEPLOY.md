# Staging на WSL2 (без публичного домена)

Runbook для локального staging-стенда: всё поднимается в отдельном
WSL2-дистрибутиве, смотрит только на `127.0.0.1`, TLS и Let's Encrypt не
используются. Это тот же набор сервисов, что в production-parity compose, минус
Caddy и мониторинг.

## 1. Что поднимается

| Сервис | Порт на хосте | Зачем |
| --- | --- | --- |
| `web` | `127.0.0.1:8080` | UI (Vite build + nginx) |
| `api` | `127.0.0.1:3001` | REST + WebSocket |
| `postgres` | `127.0.0.1:5435` | БД, только для отладки |
| `redis` | внутри сети | очередь BullMQ |
| `llm-worker` | внутри сети | LLM-граф, лимит 2 CPU / 2 ГБ |
| `sandbox-worker` | внутри сети | исполнение кода, лимит 1 CPU / 1 ГБ |
| `db-migrate` | one-shot | миграции, `restart: "no"` |

`caddy` (`--profile production`), `ollama` (`--profile with-llm`) и
`prometheus`/`grafana`/`otel-collector` (`--profile monitoring`) по умолчанию
не запускаются.

## 2. Требования

- WSL2-дистрибутив Ubuntu 24.04 с Docker Engine + Compose v2.
- Не меньше 8 ГБ RAM, доступной дистрибутиву (`%USERPROFILE%\.wslconfig`).
- Рабочий выход в интернет: `llm-worker` ходит в LLM-провайдеров, `api`
  проверяет egress в preflight.

## 3. Секреты

Скопируйте шаблон и заполните значения. Никаких реальных ключей в git —
`.env` уже в `.gitignore`.

```bash
cp .env.example .env

# три обязательных секрета
openssl rand -hex 32   # → JWT_SECRET
openssl rand -hex 32   # → TOKEN_ENCRYPTION_KEY
openssl rand -hex 32   # → INTERNAL_API_TOKEN

# пароль БД и базовые параметры
openssl rand -base64 24 | tr -d '/+=' | head -c 24   # → POSTGRES_PASSWORD
```

Минимальный набор для старта (без платёжки и внешних API):

```dotenv
POSTGRES_USER=skillwharf
POSTGRES_PASSWORD=<сгенерированный>
POSTGRES_DB=skillwharf
JWT_SECRET=<openssl rand -hex 32>
TOKEN_ENCRYPTION_KEY=<openssl rand -hex 32>
INTERNAL_API_TOKEN=<openssl rand -hex 32>
LLM_BASE_URL=http://host.docker.internal:8034/v1
LLM_MODEL=qwen/qwen2.5-coder-7b-instruct
LLM_API_KEY=<ключ локального LM Studio или провайдера>
```

`YOOKASSA_*`, `TAVILY_API_KEY`, `GITHUB_TOKEN` в staging опциональны: без них
стенд поднимается, `/billing/topup` работает (он не ходит в ЮKassa), а навыки,
которым нужен внешний ключ, откажут в рантайме.

## 4. Запуск

```bash
docker compose -f docker-compose.yml -f docker-compose.staging.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.staging.yml ps
```

Проверка, что API поднялся:

```bash
curl -sS http://127.0.0.1:3001/api/v1/health/ready
```

## 5. Сидинг тестовых данных

```bash
pnpm seed:staging
```

Скрипт идемпотентен и делает три вещи:

1. `admin@skillwharf.local` с ролью `admin` и `tester@skillwharf.local` с ролью
   `user` (пароли генерируются один раз);
2. пополняет тестировщику баланс до **10 000 ₽** через `POST /billing/topup`
   от имени админа — Ledger остаётся append-only, прямых вставок нет;
3. устанавливает и включает навыки `tavily-search` и `document-analyzer`
   через `SkillsService` (API).

Роль `admin` выставляется одним `UPDATE "User" SET role` через `psql` в
контейнере `postgres`: отдельного эндпоинта смены роли в API нет, а леджер и
кошельки это не затрагивает.

Пароли сохраняются в `staging-credentials.txt` (права `600`, файл в
`.gitignore`) и печатаются в консоль при первом запуске. Повторный запуск
переиспользует тот же файл.

Если баланс просадили тестами и нужно долить ещё раз:

```bash
STAGING_ALLOW_REPEAT_TOPUP=1 pnpm seed:staging
```

## 6. Pre-flight перед передачей тестировщикам

```bash
bash scripts/preflight-check.sh
```

Проверяет: `/api/v1/health/ready`, контейнер `llm-worker` и его связь с Redis
(BullMQ), успешность `db-migrate`, доступность Grafana (если профиль включён) и
egress в `api.telegram.org` из контейнера `api`. Exit code `1` при любом
провале — годится как гейт в CI.

## 7. Доступ с Windows

WSL2 пробрасывает `127.0.0.1` дистрибутива на localhost Windows:

- UI — <http://localhost:8080>
- API — <http://localhost:3001/api/v1>
- Grafana (если включена) — <http://localhost:3003>

## 8. Остановка и очистка

```bash
# остановить, сохранив данные
docker compose -f docker-compose.yml -f docker-compose.staging.yml down

# остановить и удалить тома (БД, Redis)
docker compose -f docker-compose.yml -f docker-compose.staging.yml down -v

# полностью снести дистрибутив
wsl --unregister skillwharf-staging
```

## 9. Типовые проблемы

| Симптом | Причина | Что делать |
| --- | --- | --- |
| `POSTGRES_PASSWORD is required in .env` | не заполнен `.env` | шаг 3 |
| `db-migrate` exited ≠ 0 | миграции упали | `docker compose logs db-migrate` |
| `health/ready` → 503 | БД или Redis недоступны | `docker compose ps`, логи `api` |
| preflight: egress недоступен | нет выхода в интернет из дистрибутива | проверить DNS: `docker compose exec api getent hosts api.telegram.org` |
| `seed:staging`: «пользователь уже существует с другим паролем» | потерян `staging-credentials.txt` | удалить пользователя или файл и пересоздать |
| Grafana SKIP | профиль `monitoring` не поднят | это нормально для стенда без мониторинга |

## 10. Профили

```bash
# мониторинг (Prometheus + Grafana + OTel)
docker compose -f docker-compose.yml -f docker-compose.staging.yml \
  --profile monitoring up -d

# Caddy на 80/443 (нужен DOMAIN, ACME_EMAIL, MONITORING_BASIC_AUTH_*)
docker compose -f docker-compose.yml -f docker-compose.staging.yml \
  --profile production up -d

# локальная Ollama (порт только на 127.0.0.1:11435)
docker compose -f docker-compose.yml -f docker-compose.staging.yml \
  --profile with-llm up -d
```
