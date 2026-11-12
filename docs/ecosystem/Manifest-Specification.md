# Спецификация Skill Manifest (SKILL.md)

**Статус:** Утверждено
**Дата:** 2026-11-12

## 1. Назначение

Каждый Skill в SkillWharf описывается файлом `SKILL.md`, который состоит из двух частей:

1. **YAML Frontmatter:** Метаданные, используемые Gateway для проверки зависимостей, прав доступа и биллинга.
2. **Markdown Body:** Декларативные инструкции для LLM (как и когда использовать инструменты).

## 2. JSON Schema для валидации YAML-заголовка

Gateway использует эту схему (через библиотеку Zod) для валидации навыка перед установкой.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "SkillManifest",
  "type": "object",
  "required": ["name", "version", "description", "author", "permissions"],
  "properties": {
    "mcp_endpoint": {
      "type": "string",
      "format": "uri",
      "description": "URL к MCP-серверу, если навык работает как коннектор."
    },
    "egress_allowlist": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Список FQDN-доменов, к которым разрешен доступ."
    },
    "pricing": {
      "properties": {
        "model": {
          "enum": ["Free", "Pay-per-Call", "Subscription", "Freemium", "Pay-per-Outcome"]
        },
        "outcome": {
          "type": "object",
          "properties": {
            "requires_human_approval": { "type": "boolean" }
          }
        }
      }
    },    
    "name": {
      "type": "string",
      "pattern": "^[a-z0-9-]+$",
      "description": "Уникальный идентификатор навыка (kebab-case)."
    },
    "version": {
      "type": "string",
      "pattern": "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-((?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\\+([0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*))?$",
      "description": "Семантическая версия (SemVer 2.0.0)."
    },
    "description": {
      "type": "string",
      "maxLength": 256,
      "description": "Краткое описание возможностей навыка."
    },
    "author": {
      "type": "object",
      "required": ["name"],
      "properties": {
        "name": { "type": "string" },
        "email": { "type": "string", "format": "email" },
        "url": { "type": "string", "format": "uri" }
      }
    },
    "dependencies": {
      "type": "object",
      "properties": {
        "tools": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Список имен Tools, которые необходимы навыку (например, read_file, web_search)."
        },
        "skills": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Список других навыков, от которых зависит текущий."
        }
      }
    },
    "permissions": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": ["network", "filesystem", "shell", "secrets", "hardware"]
      },
      "description": "Запрашиваемые разрешения. Администратор может запретить их установку."
    },
    "pricing": {
      "type": "object",
      "required": ["model"],
      "properties": {
        "model": {
          "type": "string",
          "enum": ["Free", "Pay-per-Call", "Pay-per-Outcome", "Subscription", "Freemium"]
        },
        "price": { "type": "number", "minimum": 0 },
        "currency": { "type": "string", "enum": ["RUB", "USD"] },
        "freeCallsLimit": { "type": "integer", "minimum": 0 }
      }
    },
    "requiresApproval": {
      "type": "boolean",
      "description": "Требует ли навык подтверждения пользователя перед вызовом инструментов (Human-in-the-Loop)."
    },
    "checksum": {
      "type": "string",
      "pattern": "^sha256:[a-f0-9]{64}$",
      "description": "Хеш тела файла (Markdown Body) для защиты от подмены."
    }
  }
}
```

## 3. Пример валидного SKILL.md

```markdown
---
name: "web-researcher-pro"
version: "1.2.0"
description: "Ищет актуальную информацию в интернете, анализирует сайты и делает выжимку."
author:
  name: "Ivan Petrov"
  email: "ivan@example.com"
dependencies:
  tools:
    - "web_search"
    - "read_url"
permissions:
  - "network"
pricing:
  model: "Pay-per-Call"
  price: 0.05
  currency: "RUB"
checksum: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
---

# Инструкции для агента

Ты — эксперт по исследованию рынка. Когда пользователь просит найти информацию:
1. Используй инструмент `web_search` с точным запросом.
2. Выбери 3 наиболее релевантные ссылки.
3. Используй `read_url` для каждой ссылки.
4. Сформируй краткий отчет с указанием источников.

Если информация не найдена, честно сообщи об этом. Не выдумывай факты.
```
