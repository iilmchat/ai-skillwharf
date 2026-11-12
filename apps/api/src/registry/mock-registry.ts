/** Карточка навыка в мок-реестре магазина. */
export interface RegistrySkill {
  name: string;
  description: string;
  author: string;
  version: string;
  price: number;
  permissions: string[];
}

/**
 * Временный реестр навыков. Заменяет внешний API магазина на время
 * разработки: карточки отдаются как есть, без запросов в сеть.
 */
export const MOCK_REGISTRY_SKILLS: readonly RegistrySkill[] = [
  {
    name: 'weather-api',
    description:
      'Получает текущую погоду и прогноз по городу через открытый API.',
    author: 'Weather Labs',
    version: '1.2.0',
    price: 0,
    permissions: ['network'],
  },
  {
    name: 'pdf-parser',
    description:
      'Извлекает текст и таблицы из PDF-документов и сохраняет результат.',
    author: 'DocTools',
    version: '2.0.1',
    price: 1.5,
    permissions: ['filesystem'],
  },
  {
    name: 'sql-runner',
    description:
      'Выполняет SQL-запросы к подключённой базе и возвращает табличный результат.',
    author: 'DataWorks',
    version: '0.9.3',
    price: 3,
    permissions: ['network', 'filesystem'],
  },
];
