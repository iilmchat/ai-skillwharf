import { createInstance } from 'i18next';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';
import ru from '../locales/ru.json';
import { DesignPartnerSection } from './DesignPartnerSection';
import { OfficeSimulator } from './OfficeSimulator';

/**
 * Серверный рендер лендинг-блоков: i18n.ts трогает `document`, поэтому для
 * теста создаём отдельный инстанс i18next с русским словарём и оборачиваем
 * компоненты в провайдер. Эффекты и таймеры SSR не запускает — проверяем
 * начальное (idle) состояние и тексты.
 */
function createTestI18n() {
  const instance = createInstance();

  void instance.init({
    lng: 'ru',
    fallbackLng: 'ru',
    resources: { ru: { translation: ru } },
    initAsync: false,
    interpolation: { escapeValue: false },
    returnNull: false,
  });

  return instance;
}

function renderWithI18n(element: ReturnType<typeof createElement>): string {
  const i18n = createTestI18n();

  return renderToStaticMarkup(
    createElement(I18nextProvider, { i18n }, element),
  );
}

describe('OfficeSimulator', () => {
  it('рендерит переключатель всех 12 треков и стартовое состояние', () => {
    const html = renderWithI18n(
      createElement(OfficeSimulator, { officeHref: '/app/office' }),
    );
    const trackItems = Object.values(ru.landing.tracks.items);

    expect(trackItems).toHaveLength(12);

    for (const track of trackItems) {
      // React экранирует `&` в названии трека I («OCR & Документы»).
      expect(html).toContain(track.name.replace(/&/g, '&amp;'));
    }

    expect(html).toContain('Попробуйте AI-Офис в действии (12 отраслей)');
    expect(html).toContain('Запустить демо-сценарий');
    expect(html).toContain('Запустите сценарий, чтобы увидеть работу агентов.');
    expect(html).toContain('Демонстрация: данные вымышленные');
    // Первый трек выбран по умолчанию, панель показывает его агентов.
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain(ru.landing.tracks.items.pvz.agents.storekeeper.name);
  });
});

describe('DesignPartnerSection', () => {
  it('рендерит поля заявки и все 12 отраслей', () => {
    const html = renderWithI18n(
      createElement(DesignPartnerSection, {
        email: 'pilot@example.ru',
        webhookUrl: '',
      }),
    );

    expect(html).toContain('Запросить инвайт на пилот');
    expect(html).toContain('Имя / Компания');
    expect(html).toContain('Контакт');
    expect(html).toContain('Отрасль');
    expect(html).toContain('Комментарий');
    expect(html).toContain('Необязательно.');
    expect(html).toContain('Отправить заявку');

    expect(html).toContain('A — ПВЗ');
    expect(html).toContain('L — Производство');
    expect(html).toContain('name="track"');
    expect(html).toContain('name="contact"');
    expect(html.match(/<option/g)?.length ?? 0).toBe(13);
  });
});
