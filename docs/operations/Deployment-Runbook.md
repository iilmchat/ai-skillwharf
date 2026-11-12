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

**Создание бэкапа:**

```bash
docker compose exec -T postgres pg_dump -U skillwharf_admin -d skillwharf_db -Fc > backup_$(date +%Y%m%d).dump
```

**Восстановление:**

```bash
docker compose exec -T postgres pg_restore -U skillwharf_admin -d skillwharf_db --clean < backup_20261112.dump
```

## 6. Диагностика проблем

* **Ошибка: `KVM device not found`**
  * *Решение:* Убедитесь, что хост-система поддерживает виртуализацию (`egrep -c '(vmx|svm)' /proc/cpuinfo` > 0) и модуль KVM загружен (`lsmod | grep kvm`). Если развертывание в облаке, используйте инстансы с поддержкой вложенной виртуализации.
* **Ошибка: `Connection refused` при вызове LLM.**
  * *Решение:* Проверьте доступность API LLM-провайдера из контейнера (`docker compose exec api curl ...`).

## 7. Безопасность Sandbox

`SandboxService` запускает код в одноразовых контейнерах через `dockerode`, поэтому
ему нужен доступ к Docker daemon. В базовом `docker-compose.yml` этот доступ
намеренно не выдан: сокет подключается отдельным оверрайд-файлом только для
локальной разработки.

### Production

Монтировать `/var/run/docker.sock` в API в production **запрещено**: доступ к
сокету эквивалентен root-доступу к хосту, а компрометация API означает
компрометацию хоста и обход изоляции песочницы.

В production должен использоваться **удалённый Sandbox Provider** — отдельный
микросервис на базе Firecracker или gVisor, который общается с Gateway по gRPC
и не требует доступа к Docker daemon со стороны API.

### Локальная разработка

Для запуска стека с песочницей используйте оверрайд
`docker-compose.sandbox-dev.yml`:

```bash
docker compose -f docker-compose.yml -f docker-compose.sandbox-dev.yml up -d
```

Остановка стека выполняется с тем же набором файлов:

```bash
docker compose -f docker-compose.yml -f docker-compose.sandbox-dev.yml down
```

На Windows/macOS с Docker Desktop путь к сокету отличается. Задайте его через
переменную `DOCKER_SOCKET` перед запуском:

```powershell
$env:DOCKER_SOCKET = '//var/run/docker.sock'
docker compose -f docker-compose.yml -f docker-compose.sandbox-dev.yml up -d
```

На Linux по умолчанию используется `/var/run/docker.sock`, переменную можно не
задавать.

> **Внимание:** Монтирование сокета дает контейнеру root-доступ к хосту.
> Используйте только на локальной машине разработчика. Не переносите этот
> оверрайд в базовый `docker-compose.yml` и не применяйте его на общих или
> публичных стендах.

CI собирает только базовый образ (`docker compose build api`) и не использует
`docker-compose.sandbox-dev.yml`, поэтому оверрайд не влияет на пайплайн.
