---
name: "fraud-shield-audit"
version: "1.0.0"
description: "Аудит рисков санкций и фрода в рекламных кампаниях."
author:
  name: "SkillWharf Team"
  url: https://skillwharf.ru
dependencies:
  tools: ["audit_fraud_risk"]
permissions: []
pricing:
  model: "Pay-per-Outcome"
  price: 500.00
  currency: "RUB"
requiresApproval: true
---

# Fraud Shield Audit

Проверяй риск санкций через инструмент `audit_fraud_risk`.

## Когда использовать

- Нужно проверить рекламную кампанию перед запуском.
- Нужно найти неполный доказательный пакет.
- Нужно оценить риск блокировки или штрафа.

## Порядок действий

1. Уточни идентификатор кампании.
2. Вызови `audit_fraud_risk` с полем `campaignId`.
3. Верни найденные риски и рекомендации по устранению.

## Ограничения

- Инструмент пока работает в режиме заглушки и возвращает демонстрационный аудит.
- Не принимай юридически значимые решения на основе одного аудита.
