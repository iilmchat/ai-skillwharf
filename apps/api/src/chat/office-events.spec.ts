import { officeTaskForTool } from './office-events.js';

describe('officeTaskForTool', () => {
  it.each([
    ['web_search', 'Веб-поиск'],
    ['execute_sandbox_code', 'Выполнение кода'],
    ['exec', 'Выполнение shell-команды'],
    ['read_file', 'Чтение файла'],
    ['unknown_tool', 'Вызов инструмента «unknown_tool»'],
  ])('возвращает задачу для инструмента %s', (toolName, task) => {
    expect(officeTaskForTool(toolName)).toBe(task);
  });
});
