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

### Порты и общий сетевой namespace WSL

WSL 3.0 держит дистрибутивы в общем сетевом namespace с Windows: порт,
занятый на хосте, ломает старт контейнера (`failed to bind host port
127.0.0.1:5435`), даже если внутри дистрибутива он свободен. Поэтому порты
вынесены в `.env`, править compose не нужно:

```dotenv
STAGING_API_PORT=13001
STAGING_WEB_PORT=18080
STAGING_POSTGRES_PORT=5436
STAGING_OLLAMA_PORT=11436
```

Проверить, что занято на хосте: `netstat -ano | findstr :8080` (Windows) или
`ss -ltn` (внутри дистрибутива).

### Дистрибутив засыпает без клиента

WSL гасит дистрибутив через 15–20 секунд после выхода последнего клиента, и
стенд перезапускается (`restart: always` поднимает контейнеры заново, но с
задержкой на прогрев). Чтобы стенд жил постоянно, нужен keep-alive — задача
планировщика при входе в Windows:

```powershell
# wscript.exe со скрытым окном: wsl.exe -d Ubuntu-22.04 --exec sleep infinity
schtasks /create /tn "SkillWharf WSL Keepalive" `
  /tr "wscript.exe \"C:\path\to\keepalive.vbs\"" /sc onlogon /f
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

WSL2 пробрасывает `127.0.0.1` дистрибутива на localhost Windows, порты берутся
из `.env` (`STAGING_*_PORT`, см. §5):

- UI — <http://localhost:18080>
- API — <http://localhost:13001/api/v1>
- Postgres — `127.0.0.1:5436`
- Grafana (если включена) — <http://localhost:3003>

`host.docker.internal` из контейнеров заблокирован firewall Windows: внешние
сервисы на хосте (например, LM Studio) адресуются по LAN-IP `192.168.1.121`,
а не через `host.docker.internal`.

### Публикация в интернет: Cloudflare Tunnel

Публичный HTTPS нужен для двух вещей: лендинга на `https://skillwharf.ru` и
webhook ЮKassa (`/api/v1/billing/webhook` — баланс зачисляется только им).
Порты на роутере при этом не открываются: `cloudflared` сам открывает
исходящее соединение к Cloudflare.

Схема: `интернет → Cloudflare (TLS) → tunnel → 127.0.0.1:18080 (Caddy web)`,
Caddy уже проксирует `/api/*` и `/socket.io/*` в `api:3000`, поэтому одного
hostname достаточно.

**Один раз, в панели Cloudflare (Free):** добавить сайт `skillwharf.ru`,
получить два NS и прописать их у регистратора (reg.ru → домен → «Изменить
DNS-серверы»). Дождаться статуса Active.

**Один раз, в дистрибутиве:**

```bash
# 1. Авторизация (откроет браузер; cert.pem ляжет в /root/.cloudflared)
cloudflared tunnel login

# 2. Туннель и DNS-записи (apex + www)
cloudflared tunnel create skillwharf          # запомнить UUID из вывода
cloudflared tunnel route dns skillwharf skillwharf.ru
cloudflared tunnel route dns skillwharf www.skillwharf.ru

# 3. Конфиг и служба
sudo mkdir -p /etc/cloudflared
sudo tee /etc/cloudflared/config.yml >/dev/null <<'EOF'
tunnel: <UUID>
credentials-file: /root/.cloudflared/<UUID>.json
no-autoupdate: true
ingress:
  - hostname: skillwharf.ru
    service: http://127.0.0.1:18080
  - hostname: www.skillwharf.ru
    service: http://127.0.0.1:18080
  - service: http_status:404
EOF
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

Проверка: `cloudflared tunnel info skillwharf` (коннекторы `dme05`/`dme06`),
`cloudflared tunnel ingress validate`, затем `curl -sS -o /dev/null -w '%{http_code}' https://skillwharf.ru/`
→ `200`. Логи — `journalctl -u cloudflared -f`.

**Текущая конфигурация стенда (15.11.2026):** зона `skillwharf.ru` в Cloudflare
(Free), NS `dolly.ns.cloudflare.com` и `piers.ns.cloudflare.com`; туннель
`skillwharf`, UUID `c9f128f4-146d-4cad-bdf0-4bb5aebc0270`; служба `cloudflared`
в systemd, конфиг `/etc/cloudflared/config.yml`; apex и `www` проксируются на
`127.0.0.1:18080`.

**CSP и аналитика Cloudflare.** Для проксируемых сайтов Cloudflare автоматически
вставляет маячок `static.cloudflareinsights.com/beacon.min.js`. Он разрешён в
`apps/web/Caddyfile` (`script-src`), иначе в консоли появляется CSP-ошибка.
После правки CSP нужно пересобрать образ `web` — заголовок отдаёт Caddy.

**ЮKassa:** в кабинете (Интеграция → HTTP-уведомления) указать
`https://skillwharf.ru/api/v1/billing/webhook`, события `payment.succeeded` и
`payment.canceled`. Через API это не настраивается: `POST /v3/webhooks` с ключом
магазина отвечает `401` («Authentication type is not allowed») — нужен
OAuth-токен партнёра. Обработчик сам перепроверяет платёж запросом в API ЮKassa,
поэтому подделка уведомления не зачислит деньги; повторная доставка
идемпотентна. `YOOKASSA_RETURN_URL` — `https://app.skillwharf.ru/app/chat`.

Туннель зависит от живого дистрибутива: если WSL выгружен или Windows
перезагружен без keep-alive (§5), сайт и webhook недоступны.

### Витрина отдельно от приложения

Стенд живёт на рабочей машине, поэтому приложение может быть недоступно. Чтобы
лендинг и статьи открывались всегда, их держим статикой на постоянном хостинге,
а приложение — на поддомене за туннелем:

| Адрес | Что отдаёт | Где живёт |
| --- | --- | --- |
| `https://skillwharf.ru` | лендинг (статика) | хостинг, не зависит от ПК |
| `https://app.skillwharf.ru` | приложение + API | туннель → `127.0.0.1:18080` |

Сборка витрины — отдельный вход `landing.html`, без API и без роутера
приложения:

```bash
VITE_APP_URL=https://app.skillwharf.ru pnpm --filter web build:landing
# результат: apps/web/dist-landing (index.html + assets) — залить в корень сайта
```

`VITE_APP_URL` подставляется в кнопки «Войти», «AI-офис» и «Смотреть демо»,
поэтому с витрины нельзя попасть в 404 на хостинге. Без переменной ссылки
остаются относительными — так собирается образ для Caddy.

В ingress туннеля нужен отдельный hostname приложения:

```yaml
ingress:
  - hostname: app.skillwharf.ru
    service: http://127.0.0.1:18080
  - service: http_status:404
```

`cloudflared tunnel route dns skillwharf app.skillwharf.ru` создаёт CNAME.
Корень домена после переезда витрины указывает на хостинг, а не на туннель.

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
