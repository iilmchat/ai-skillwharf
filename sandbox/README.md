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
| `egress-setup.sh` | Root-entrypoint: FQDN-allowlist в iptables, DNS только для root, `/etc/hosts`, строгий ip6tables, запуск кода от uid 65534 |
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
none`. С непустым списком контейнер запускается на `bridge` с capabilities
`NET_ADMIN`, `SETUID`, `SETGID`.

**Prod-путь резолва доменов без DNS — `HostConfig.ExtraHosts` от worker-а.**
Worker ПЕРЕД `createContainer` резолвит домены allowlist через `node:dns`
(`resolve4`/`resolve6`), строит `ExtraHosts: ['<fqdn>:<ipv4>']` и передаёт их
Docker-у. Docker инжектит записи в `/etc/hosts` даже при `ReadonlyRootfs:
true` (проверено на Docker Desktop 29.9.3: файл остаётся read-only для
записи, но записи видны и резолвятся), поэтому разрешённые домены
резолвятся у кода без DNS. IPv6 в ExtraHosts не поддерживается — такие
адреса пропускаются с логом. Ошибка резолва отдельного домена не фатальна:
он пропускается, остальные работают.

Root-entrypoint `sandbox-egress-setup.sh` дополняет worker:

1. резолвит каждый FQDN allowlist-а (`getent ahosts`, fallback `nslookup`)
   пока действует default-ACCEPT;
2. пишет `<ip> <fqdn>` в `/etc/hosts` (IPv4+IPv6) — best-effort: при
   `read_only: true` файл read-only, ошибка логируется и не фатальна.
   Это dev-путь/страховка; prod-резолв делает worker через ExtraHosts;
3. разрешает tcp 80/443 только на полученные IP;
4. закрывает DNS-туннель: DNS `127.0.0.11:53` разрешён только root
   (`-m owner --uid-owner 0`), все остальные пакеты с оригинальным dport 53
   получают явный DROP (`--ctorigdstport`: Docker DNAT-ит resolver, поэтому
   `--dport 53` после NAT не совпадает). DNS-DROP стоит до общего
   `-o lo ACCEPT`, иначе loopback-правило пропускало бы DNS всем;
5. ставит политику `OUTPUT/INPUT/FORWARD DROP` (ESTABLISHED,RELATED — ACCEPT);
6. применяет ip6tables строго, если IPv6-стек присутствует
   (`/proc/net/if_inet6` непуст): loopback ACCEPT, DNS только root к `::1`,
   явный DROP на оригинальный dport 53, ESTABLISHED/RELATED, политики DROP.
   Ошибка ip6tables при включённом IPv6 — fail closed (`exit 1`); если IPv6
   нет — ip6tables пропускается с логом;
7. сбрасывает привилегии (`su-exec 65534:65534`) и запускает код.

Что считается «DNS закрыт»: код под uid 65534 не может отправить DNS-запрос
ни к Docker-resolver `127.0.0.11`, ни к любому другому резолверу (явный DROP
на dport 53 + политика `OUTPUT DROP`). Разрешённые домены резолвятся без
DNS — через `/etc/hosts` (ExtraHosts от worker-а в prod, best-effort запись
entrypoint-а в dev); неразрешённые домены не резолвятся вовсе.

Остаточные риски (KI-028):

- ExtraHosts только IPv4: домен, у которого есть лишь AAAA-адреса, не
  получит hosts-записи (worker логирует и пропускает); IPv6-трафик при этом
  всё равно фильтруется ip6tables строго при наличии IPv6-стека;
- DNS rebinding/SSRF: домен allowlist может резолвиться во внутренний адрес —
  фильтр работает на уровне IP, range-денлиста нет;
- двойной резолв: worker (ExtraHosts) и entrypoint (iptables ACCEPT)
  резолвят домен независимо; при ротации IP/CDN между вызовами возможен
  разлад (hosts указывает на IP, которого нет в ACCEPT). Обычно оба резолва
  идут через один Docker DNS почти одновременно;
- ротация IP у CDN: правила строятся на момент старта контейнера;
- IPv6: строгий режим зависит от доступности ip6tables в ядре/образе; при
  включённом IPv6 любая ошибка = fail closed;
- SNI/Host-фильтрации нет: allowlist ограничивает IP:port, а не домен в TLS;
  для этого нужен egress-прокси (план, см. «Чего пока нет»).

## Чего пока нет

- egress-прокси с TLS SNI/Host-фильтрацией: сейчас allowlist работает на
  уровне IP:port, поэтому разрешённый IP можно использовать с любым
  Host/SNI; прокси — следующий этап (KI-028);
- Firecracker/gVisor и таймаутов выполнения — это следующий этап;
- профилей seccomp для arm64: текущий файл рассчитан на linux/amd64 (см.
  KI-026).

В CI шаг `Test Sandbox Isolation` запускает `scripts/test-sandbox.sh` и
проверяет изоляцию контейнера.
