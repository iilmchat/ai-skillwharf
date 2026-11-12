# Схемы взаимодействия биллинга

**Статус:** Утверждено
**Дата:** 2026-11-12

## 1. Сценарий Pay-per-Call (Оплата за вызов)

Этот сценарий описывает процесс списания средств при вызове платного навыка. Ключевая особенность — двухфазная фиксация транзакции (Hold -> Capture), чтобы не списывать деньги, если выполнение навыка в песочнице завершится ошибкой.

### Диаграмма последовательности

```mermaid
sequenceDiagram
    autonumber
    actor Client as Клиент (Агент/UI)
    participant GW as Gateway (API)
    participant BAL as Billing Service (BAL)
    participant DB as Ledger (PostgreSQL)
    participant PG as Платежный шлюз (ЮKassa)

    Client->>GW: Запрос на выполнение Skill (Pay-per-Call)
    GW->>GW: Проверка прав и валидация манифеста

    GW->>BAL: authorizeTransaction(userId, skillId, price)
    BAL->>DB: Начало транзакции (BEGIN)
    DB-->>BAL: Текущий баланс пользователя
    BAL->>DB: Создание блокировки средств (Hold)
    DB-->>BAL: Транзакция зафиксирована (COMMIT)
    BAL-->>GW: Успех. Резерв создан (transactionId)

    alt Недостаточно средств
        BAL-->>GW: Ошибка (Insufficient Funds)
        GW-->>Client: 402 Payment Required
    else Средств достаточно
        GW->>GW: Передача задачи в Sandbox (выполнение Skill)

        alt Ошибка выполнения в Sandbox
            GW->>BAL: cancelTransaction(transactionId)
            BAL->>DB: Отмена блокировки (Rollback Hold)
            GW-->>Client: Ошибка выполнения (средства не списаны)
        else Успешное выполнение
            GW->>BAL: captureTransaction(transactionId)
            BAL->>DB: Запись в append-only Ledger (Списание)
            BAL->>PG: Инициализация выплаты (при необходимости)
            PG-->>BAL: Успешно
            BAL-->>GW: Средства списаны
            GW-->>Client: Результат работы Skill
        end
    end
```

## 2. Компоненты и их роли

* **Gateway:** Выступает точкой интеграции. Он не знает, как именно списываются деньги, он лишь дергает абстрактный метод `authorize` перед запуском Sandbox и `capture` после успешного выполнения.
* **Billing Abstraction Layer (BAL):** Оркестратор платежей. Он инкапсулирует логику работы с разными провайдерами (ЮKassa, CloudPayments, Тинькофф) и внутренним кредитным бэкендом (для on-premise).
* **Ledger (Реестр):** Таблица в PostgreSQL с политикой `append-only`. Записи нельзя изменять или удалять, только добавлять новые. Это обеспечивает аудит и соответствие требованиям ФСТЭК.
* **Payment Gateway:** Внешний шлюз (например, ЮKassa). Используется для фактического вывода средств с карты или проведения сплитования (Revenue Share 85/15).
