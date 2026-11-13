# Sandbox (MVP)

Изолированное окружение для запуска сторонних плагинов. На этапе MVP это
hardened Docker-контейнер; целевой бэкенд — Firecracker (основной) и gVisor
(fallback), см. `docs/security/Threat-Model.md`.

## Что где лежит

| Путь | Назначение |
| --- | --- |
| `Dockerfile` | Образ `skillwharf-sandbox` с `curl`, `jq`, `gh`, `bash`, `python3` и `pip` |
| `docker-compose.sandbox.yml` | Описание сервиса `sandbox-runner` (лимиты и изоляция) |
| `seccomp-profile.json` | Default-deny seccomp-профиль для контейнеров `sandbox-worker` |
| `egress-setup.sh` | Root-entrypoint контейнера: iptables-allowlist FQDN и запуск кода от uid 65534 |
| `scripts/test-sandbox.sh` | Скрипт проверки изоляции |

Образ собирается из `sandbox/Dockerfile` на базе `alpine:3.20`. Утилиты нужны
навыкам, которые обращаются к внешним API (например, `tavily-search` и
`github`). API запускает контейнеры с образом `skillwharf-sandbox:latest`;
переопределить образ можно переменной `SANDBOX_IMAGE`.

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

Сборка образа:

```bash
docker compose -f docker-compose.sandbox.yml build
```

Ручной запуск контейнера:

```bash
docker compose -f docker-compose.sandbox.yml run --rm sandbox-runner sh
```

## Что проверяет скрипт

1. Контейнер поднимается и выполняет команду (`Hello from Sandbox`).
2. Корневая файловая система смонтирована read-only: запись в `/` падает.
3. `tmpfs` в `/tmp` доступен для записи.
4. Под `seccomp-profile.json` работают bash, curl, jq, gh, Python и Node.js/V8.
5. Опасные сисколлы (`ptrace`, `mount`, `unshare`, `bpf` и др.) возвращают `EPERM`.
6. В образе есть `iptables`, `su-exec` и entrypoint `sandbox-egress-setup.sh`.

## Ограничения сервиса

- `read_only: true` — корневая ФС неизменяема, запись только в `/tmp`;
- `cap_drop: ALL` — все Linux capabilities сняты;
- `no-new-privileges:true` — запрет повышения привилегий через setuid;
- `seccomp` — default-deny профиль `sandbox/seccomp-profile.json`; worker
  применяет его, если задан `SANDBOX_SECCOMP_PROFILE` (в staging обязателен),
  иначе действует профиль Docker по умолчанию;
- сеть по умолчанию выключена (`NetworkMode: none`): ни внешней сети, ни
  доступа к другим контейнерам. Egress включается только `egress_allowlist`
  из манифеста навыка, объявившего инструмент, и только при `permissions:
  [network]` (deny by default). Глобальный `SANDBOX_ALLOW_NETWORK` и
  legacy-флаг `ALLOW_NETWORK` сеть больше не включают;
- `mem_limit: 128m`, `cpus: 0.5` — лимиты памяти и CPU.

## Egress по FQDN

`SandboxService.runCommand(code, env, { egress })` передаёт worker'у
`{ network, egressAllowlist }`. Без allowlist worker ставит `NetworkMode:
none`. С непустым списком контейнер запускается на `bridge` с
capabilities `NET_ADMIN`, `SETUID`, `SETGID`; root-entrypoint
`sandbox-egress-setup.sh`:

1. разрешает loopback и DNS `127.0.0.11:53`;
2. резолвит каждый FQDN (`getent ahosts`, fallback `nslookup`) и разрешает
   tcp 80/443 только на полученные IP;
3. ставит политику `OUTPUT/INPUT/FORWARD DROP` (best-effort ip6tables);
4. сбрасывает привилегии (`su-exec 65534:65534`) и запускает код.

Остаточные риски (DNS rebinding/SSRF через разрешённый домен, DNS-туннель
через resolver, ротация IP у CDN, best-effort IPv6) зафиксированы в KI-028.

## Чего пока нет

- Firecracker/gVisor и таймаутов выполнения — это следующий этап;
- профилей seccomp для arm64: текущий файл рассчитан на linux/amd64 (см.
  KI-026).

В CI шаг `Test Sandbox Isolation` запускает `scripts/test-sandbox.sh` и
проверяет изоляцию контейнера.
