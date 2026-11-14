#!/usr/bin/env python3
"""Аудит staging-конфигурации SkillWharf.

Проверяет docker-compose.staging.yml поверх базового docker-compose.yml и
.env.example:

  * restart: always у всех долгоживущих сервисов (кроме one-shot db-migrate);
  * все опубликованные порты привязаны к 127.0.0.1, наружу ничего не торчит;
  * у sandbox-worker и llm-worker заданы deploy.resources.limits;
  * в .env.example есть обязательные для staging переменные.

Использование:
    python3 scripts/audit-compose.py
    python3 scripts/audit-compose.py --root . --json

Код возврата: 0 — замечаний нет, 1 — есть FAIL, 2 — нет PyYAML.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover - зависит от окружения
    print("Нужен PyYAML: pip install pyyaml", file=sys.stderr)
    sys.exit(2)

# Сервисы, которые не перезапускаются: one-shot миграции.
ONE_SHOT = {"db-migrate"}

# Кому разрешено смотреть наружу: публичный edge за профилем production.
PUBLIC_EDGE = {"caddy"}

# Кому обязательны лимиты CPU/RAM.
LIMITED = {"sandbox-worker", "llm-worker"}

# Что staging обязан уметь прочитать из .env.
REQUIRED_ENV = [
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "POSTGRES_DB",
    "JWT_SECRET",
    "TOKEN_ENCRYPTION_KEY",
    "INTERNAL_API_TOKEN",
    "LLM_BASE_URL",
    "LLM_MODEL",
]


def load_compose(path: Path) -> dict:
    with path.open(encoding="utf-8") as handle:
        data = yaml.safe_load(handle) or {}
    services = data.get("services")
    return services if isinstance(services, dict) else {}


def env_example_keys(path: Path) -> set[str]:
    keys: set[str] = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        keys.add(stripped.split("=", 1)[0].strip())
    return keys


def resolve_templates(text: str) -> str:
    """Разворачивает ${VAR:-default} в default (иначе оставляет ${VAR})."""
    import re

    def replace(match: re.Match[str]) -> str:
        default = match.group(2)
        return default if default is not None else match.group(0)

    return re.sub(r"\$\{([A-Za-z0-9_]+)(?::-([^}]*))?\}", replace, text)


def published_ports(service: dict) -> list[dict]:
    """Приводит ports к списку {target, published, host_ip}."""
    result: list[dict] = []
    for entry in service.get("ports") or []:
        if isinstance(entry, dict):
            result.append(
                {
                    "target": entry.get("target"),
                    "published": entry.get("published"),
                    "host_ip": entry.get("host_ip"),
                }
            )
            continue
        text = resolve_templates(str(entry))
        host_ip = None
        published = None
        target = None
        parts = text.split(":")
        if len(parts) == 3:
            host_ip, published, target = parts
        elif len(parts) == 2:
            published, target = parts
        elif len(parts) == 1:
            target = parts[0]
        result.append({"target": target, "published": published, "host_ip": host_ip})
    return result


def audit(root: Path) -> tuple[list[dict], list[dict]]:
    base = load_compose(root / "docker-compose.yml")
    staging = load_compose(root / "docker-compose.staging.yml")
    env_keys = env_example_keys(root / ".env.example")

    rows: list[dict] = []
    issues: list[dict] = []

    for name, base_service in base.items():
        override = staging.get(name) or {}
        base_service = base_service or {}
        restart = override.get("restart", base_service.get("restart", "-"))
        ports = published_ports(override) or published_ports(base_service)
        limits = (
            (base_service.get("deploy") or override.get("deploy") or {})
            .get("resources", {})
            .get("limits")
        )

        rows.append(
            {
                "service": name,
                "restart": str(restart),
                "ports": ",".join(
                    f"{p['host_ip'] or '0.0.0.0'}:{p['published']}->{p['target']}"
                    for p in ports
                )
                or "-",
                "limits": limits or None,
            }
        )

        if name not in ONE_SHOT and str(restart) not in ("always", "unless-stopped"):
            issues.append(
                {
                    "level": "FAIL",
                    "service": name,
                    "message": f"restart={restart}, ожидается always",
                }
            )

        for port in ports:
            if port["host_ip"] in (None, "0.0.0.0", "::"):
                if name in PUBLIC_EDGE:
                    issues.append(
                        {
                            "level": "INFO",
                            "service": name,
                            "message": (
                                f"порт {port['published']} слушает все интерфейсы "
                                "(edge за профилем production) — ожидаемо"
                            ),
                        }
                    )
                    continue
                issues.append(
                    {
                        "level": "FAIL",
                        "service": name,
                        "message": (
                            f"порт {port['published']} опубликован на все интерфейсы; "
                            "нужен 127.0.0.1"
                        ),
                    }
                )

        if name in LIMITED and not limits:
            issues.append(
                {
                    "level": "FAIL",
                    "service": name,
                    "message": "нет deploy.resources.limits",
                }
            )

    missing = [key for key in REQUIRED_ENV if key not in env_keys]
    for key in missing:
        issues.append(
            {"level": "FAIL", "service": ".env.example", "message": f"нет {key}"}
        )

    return rows, issues


def main() -> int:
    parser = argparse.ArgumentParser(description="Аудит staging-compose SkillWharf")
    parser.add_argument("--root", default=".", help="корень репозитория (default: .)")
    parser.add_argument("--json", action="store_true", help="вывести JSON")
    args = parser.parse_args()

    root = Path(args.root).resolve()
    rows, issues = audit(root)
    failed = [issue for issue in issues if issue["level"] == "FAIL"]

    if args.json:
        print(json.dumps({"services": rows, "issues": issues}, ensure_ascii=False, indent=2))
    else:
        print(f"{'service':<16} {'restart':<16} {'ports':<32} limits")
        for row in rows:
            limits = json.dumps(row["limits"], ensure_ascii=False) if row["limits"] else "-"
            print(
                f"{row['service']:<16} {row['restart']:<16} {row['ports']:<32} {limits}"
            )
        print()
        if not issues:
            print("OK: замечаний нет")
        for issue in issues:
            print(f"{issue['level']}: {issue['service']} — {issue['message']}")

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
