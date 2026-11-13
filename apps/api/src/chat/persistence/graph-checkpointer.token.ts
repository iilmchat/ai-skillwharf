/**
 * DI-токен checkpointer'а LangGraph.
 *
 * Вынесен из `persistence.module.ts`, чтобы сервисы, которые модуль
 * регистрирует (например, `ExpiredApprovalsService`), могли инжектить токен
 * без циклического импорта «модуль → сервис → модуль».
 */
export const GRAPH_CHECKPOINTER = Symbol('GRAPH_CHECKPOINTER');
