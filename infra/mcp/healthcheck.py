#!/usr/bin/env python3
"""Healthcheck для MCP-серверов Ozon/WB.

Проверяет два условия:
1) обязательные ключи переданы в контейнер через env;
2) HTTP health-endpoint самого MCP-сервера отвечает 200.

Ключи никогда не печатаются. Для локального запуска без ключей можно задать
MCP_ALLOW_MISSING_KEYS=1, но в production/staging это не рекомендуется.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

REQUIRED_KEYS = {
    "ozon": ("OZON_CLIENT_ID", "OZON_API_KEY"),
    "wb": ("WB_API_TOKEN",),
}

TIMEOUT_SECONDS = 5


def fail(message: str) -> None:
    print(json.dumps({"status": "error", "message": message}, ensure_ascii=False))
    sys.exit(1)


def main() -> None:
    if len(sys.argv) != 3 or sys.argv[1] not in REQUIRED_KEYS:
        fail("usage: mcp-healthcheck.py <ozon|wb> <health-url>")

    role = sys.argv[1]
    url = sys.argv[2]
    required = REQUIRED_KEYS[role]
    missing = [name for name in required if not os.environ.get(name, "").strip()]
    allow_missing = os.environ.get("MCP_ALLOW_MISSING_KEYS", "0") == "1"

    if missing:
        if not allow_missing:
            fail(f"{role}: не заданы обязательные переменные: {', '.join(missing)}")
        print(
            json.dumps(
                {
                    "status": "warning",
                    "message": f"{role}: ключи не заданы, проверяется только /api/health",
                    "missing": missing,
                },
                ensure_ascii=False,
            )
        )

    try:
        with urllib.request.urlopen(url, timeout=TIMEOUT_SECONDS) as response:
            body = response.read(256).decode("utf-8", errors="replace")
            if response.status != 200:
                fail(f"{role}: health endpoint вернул HTTP {response.status}")
    except urllib.error.HTTPError as error:
        fail(f"{role}: health endpoint вернул HTTP {error.code}")
    except Exception as error:  # noqa: BLE001 - healthcheck не должен падать трейсом
        fail(f"{role}: health endpoint недоступен: {error}")

    print(
        json.dumps(
            {
                "status": "ok",
                "role": role,
                "keys": len(required),
                "health": body[:120],
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
