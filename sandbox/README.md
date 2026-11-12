# Sandbox (MVP)

Изолированное окружение для запуска сторонних плагинов. На этапе MVP это
hardened Docker-контейнер; целевой бэкенд — Firecracker (основной) и gVisor
(fallback), см. `docs/04-security/Threat-Model.md`.

## Что где лежит

| Путь | Назначение |
| --- | --- |
| `docker-compose.sandbox.yml` | Описание сервиса `sandbox-runner` (лимиты и изоляция) |
| `scripts/test-sandbox.sh` | Скрипт проверки изоляции |

## Требования

- Docker Engine или Docker Desktop;
- Docker Compose v2 (`docker compose`).

## Как запустить

Из корня репозитория:

```bash
bash scripts/test-sandbox.sh
```

На Windows скрипт запускается через Git Bash. Если Docker недоступен,
скрипт завершится с ошибкой `FAIL: Docker недоступен`.

Ручной запуск контейнера:

```bash
docker compose -f docker-compose.sandbox.yml run --rm sandbox-runner sh
```

## Что проверяет скрипт

1. Контейнер поднимается и выполняет команду (`Hello from Sandbox`).
2. Корневая файловая система смонтирована read-only: запись в `/` падает.
3. `tmpfs` в `/tmp` доступен для записи.

## Ограничения сервиса

- `read_only: true` — корневая ФС неизменяема, запись только в `/tmp`;
- `cap_drop: ALL` — все Linux capabilities сняты;
- `no-new-privileges:true` — запрет повышения привилегий через setuid;
- `network_mode: "none"` — сети нет: ни внешней, ни доступа к другим контейнерам;
- `mem_limit: 128m`, `cpus: 0.5` — лимиты памяти и CPU.

## Чего пока нет

- non-root пользователя и собственного seccomp-профиля (сейчас действует
  профиль Docker по умолчанию) — добавим, когда в песочнице начнёт
  выполняться недоверенный код;
- Firecracker/gVisor и таймаутов выполнения — это следующий этап;
- запуска из CI: скрипт можно вызывать на раннере с Docker, но в
  `.github/workflows/ci.yml` он пока не подключён.
