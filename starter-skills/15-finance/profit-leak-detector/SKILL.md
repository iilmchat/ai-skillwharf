---
name: "profit-leak-detector"
version: "1.0.0"
description: "Поиск утечек прибыли у селлера на маркетплейсе."
author:
  name: "SkillWharf Team"
  url: https://skillwharf.ru
dependencies:
  tools: ["detect_profit_leaks"]
permissions: []
pricing:
  model: "Pay-per-Call"
  price: 300.00
  currency: "RUB"
---

# Profit Leak Detector

Ищи утечки прибыли через инструмент `detect_profit_leaks`.

## Когда использовать

- Нужно понять, почему прибыль ниже ожидаемой.
- Нужно проверить штрафы, логистику и габариты.
- Нужно подготовить список подозрительных списаний.

## Порядок действий

1. Уточни идентификатор продавца.
2. Вызови `detect_profit_leaks` с полем `sellerId`.
3. Верни найденные утечки и предложи следующие шаги.

## Ограничения

- Инструмент пока работает в режиме заглушки и возвращает демонстрационную утечку.
- Перед выводами сверяй данные с отчётами маркетплейса.
