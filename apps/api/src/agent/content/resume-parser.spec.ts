import { describe, expect, it } from 'vitest';
import {
  canonicalSkill,
  extractContact,
  extractEducation,
  extractExperience,
  extractLanguages,
  parseResume,
  splitSkillList,
  splitSections,
} from './resume-parser.js';

const RESUME = `Иванов Иван Иванович
Москва, ivanov@example.com, +7 (999) 123-45-67, @ivan_dev

О себе
Backend-разработчик с опытом проектирования сервисов на Node.js.

Опыт работы
ООО «Ромашка» — Senior Backend Developer
03.2021 — 06.2024
Разрабатывал API на TypeScript и PostgreSQL, внедрил Docker и CI/CD.

АО «Вектор» — Backend Developer
05.2024 — н.в.
Отвечаю за сервисы на NestJS, RabbitMQ и Kubernetes.

Навыки
TypeScript, PostgreSQL, Python, Jira, публичные выступления

Образование
МГТУ им. Баумана — бакалавр, 2020

Языки
Английский — B2
Немецкий — A1
`;

describe('parseResume: реальные данные', () => {
  it('извлекает контакты', () => {
    const contact = extractContact(RESUME);

    expect(contact).toEqual({
      name: 'Иванов Иван Иванович',
      email: 'ivanov@example.com',
      phone: '+7 (999) 123-45-67',
      telegram: '@ivan_dev',
      location: 'Москва',
    });
  });

  it('находит навыки по словарю и в разделе «Навыки»', () => {
    const parsed = parseResume(RESUME);

    expect(parsed.skills).toEqual(
      expect.arrayContaining([
        'TypeScript',
        'PostgreSQL',
        'Python',
        'Jira',
        'Node.js',
        'Docker',
        'CI/CD',
        'NestJS',
        'Kubernetes',
      ]),
    );
    expect(parsed.skillsFromSections).toEqual(['публичные выступления']);
  });

  it('считает опыт по диапазонам дат без двойного учёта', () => {
    const parsed = parseResume(RESUME);

    // 03.2021–06.2024 = 40 мес., 05.2024–н.в.: пересечение по 06.2024
    // считается один раз, открытый период доходит до текущего месяца.
    expect(parsed.experience.current).toBe(true);
    expect(parsed.experience.totalMonths).toBeGreaterThan(40);
    expect(parsed.experience.positions).toHaveLength(2);
    expect(parsed.experience.positions[0]).toMatchObject({
      title: 'Senior Backend Developer',
      company: 'ООО «Ромашка»',
      from: '2021-03',
      to: '2024-06',
      months: 40,
    });
    expect(parsed.experience.positions[1]?.to).toBe('н.в.');
  });

  it('извлекает образование и языки', () => {
    const parsed = parseResume(RESUME);

    expect(parsed.education).toEqual({
      level: 'bachelor',
      institutions: ['МГТУ им. Баумана — бакалавр, 2020'],
    });
    expect(parsed.languages).toEqual([
      { name: 'Английский', level: 'B2' },
      { name: 'Немецкий', level: 'A1' },
    ]);
  });

  it('не придумывает данные в пустом резюме', () => {
    const parsed = parseResume('   ');

    expect(parsed.skills).toEqual([]);
    expect(parsed.experience.totalMonths).toBe(0);
    expect(parsed.contact).toEqual({
      name: null,
      email: null,
      phone: null,
      telegram: null,
      location: null,
    });
    expect(parsed.warnings).toEqual(
      expect.arrayContaining([
        'резюме пусто',
        'в резюме не найдены email и телефон',
        'навыки не найдены: ни по словарю, ни в разделе «Навыки»',
        'не найдено ни одного периода работы с датами',
      ]),
    );
  });
});

describe('splitSections', () => {
  it('делит текст по заголовкам RU/EN', () => {
    const sections = splitSections(
      [
        'Пётр Петров',
        'Experience',
        'Acme — QA',
        '01.2020 - 12.2021',
        'Skills',
        'Jira, SQL',
        'Education',
        'МГУ',
      ].join('\n'),
    );

    expect(sections.summary).toContain('Пётр Петров');
    expect(sections.experience).toContain('Acme — QA');
    expect(sections.skills).toBe('Jira, SQL');
    expect(sections.education).toBe('МГУ');
  });
});

describe('extractExperience', () => {
  it('понимает месяцы словами и годы', () => {
    expect(
      extractExperience('ООО «Альфа»\nянварь 2020 — декабрь 2021\nРазработчик'),
    ).toMatchObject({ totalMonths: 24, years: 2, current: false });

    expect(extractExperience('2020 — 2022').totalMonths).toBe(36);
    expect(
      extractExperience('01.03.2020 — 31.12.2021').totalMonths,
    ).toBe(22);
  });

  it('объединяет пересекающиеся периоды', () => {
    const experience = extractExperience(
      '01.2020 — 12.2021\n06.2021 — 06.2022',
    );

    // Объединение: 01.2020–06.2022 = 30 месяцев, а не 24 + 13.
    expect(experience.totalMonths).toBe(30);
  });

  it('игнорирует невозможные и слишком длинные периоды', () => {
    const warnings: string[] = [];
    const experience = extractExperience(
      '13.2020 — 12.2021\n1950 — 2020',
      warnings,
    );

    expect(experience.positions).toEqual([]);
    expect(experience.totalMonths).toBe(0);
  });
});

describe('canonicalSkill / splitSkillList', () => {
  it('приводит алиасы к каноническому имени', () => {
    expect(canonicalSkill('typescript')).toBe('TypeScript');
    expect(canonicalSkill('Node.js')).toBe('Node.js');
    expect(canonicalSkill('1С')).toBe('1С');
    expect(canonicalSkill('публичные выступления')).toBeNull();
    expect(canonicalSkill('')).toBeNull();
  });

  it('разбивает список навыков по разделителям и чистит маркеры', () => {
    expect(splitSkillList('• React\n- Vue, SQL; Jira')).toEqual([
      'React',
      'Vue',
      'SQL',
      'Jira',
    ]);
  });
});

describe('extractEducation / extractLanguages', () => {
  it('определяет уровень образования', () => {
    expect(extractEducation('МГУ, кандидат наук').level).toBe('phd');
    expect(extractEducation('МГУ, магистр').level).toBe('master');
    expect(extractEducation('Техникум, среднее специальное').level).toBe(
      'secondary',
    );
    expect(extractEducation('нет данных').level).toBeNull();
  });

  it('находит языки без дублей', () => {
    expect(
      extractLanguages('Английский — C1, английский свободный, German B2'),
    ).toEqual([
      { name: 'Английский', level: 'C1' },
      { name: 'German', level: 'B2' },
    ]);
  });
});
