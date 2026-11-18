import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SecretField, type SecretFieldProps } from './SecretField';

const BASE_PROPS: SecretFieldProps = {
  id: 'bitrix24-webhook-url',
  name: 'webhookUrl',
  label: 'Webhook URL',
  hint: 'Входящий вебхук портала.',
  note: 'URL содержит секретный токен доступа — не показывайте его на демонстрациях экрана.',
  placeholder: 'https://portal.bitrix24.ru/rest/1/xxxxxxxx/',
  value: 'https://portal.bitrix24.ru/rest/1/secret123/',
  onValueChange: () => {},
  visible: false,
  onVisibleChange: () => {},
  revealable: true,
  revealLabel: 'Показать',
  concealLabel: 'Скрыть',
  inputMode: 'url',
  className: 'input-classes',
};

function render(overrides: Partial<SecretFieldProps> = {}): string {
  return renderToStaticMarkup(
    createElement(SecretField, { ...BASE_PROPS, ...overrides }),
  );
}

describe('SecretField (маскировка вебхука, KI-076)', () => {
  it('по умолчанию маскирует значение и предлагает «Показать»', () => {
    const html = render();

    expect(html).toContain('type="password"');
    expect(html).not.toContain('type="text"');
    expect(html).toContain('aria-label="Показать"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('aria-controls="bitrix24-webhook-url"');
  });

  it('по нажатию переключателя показывает значение и предлагает «Скрыть»', () => {
    const html = render({ visible: true });

    expect(html).toContain('type="text"');
    expect(html).not.toContain('type="password"');
    expect(html).toContain('aria-label="Скрыть"');
    expect(html).toContain('aria-pressed="true"');
  });

  it('без revealable оставляет поле скрытым и не рисует переключатель', () => {
    const html = render({ revealable: false, visible: true });

    expect(html).toContain('type="password"');
    expect(html).not.toContain('aria-pressed');
    expect(html).not.toContain('<button');
  });

  it('показывает подсказку, предупреждение о секрете и связывает их с полем', () => {
    const html = render();

    expect(html).toContain('Входящий вебхук портала.');
    expect(html).toContain(
      'URL содержит секретный токен доступа — не показывайте его на демонстрациях экрана.',
    );
    expect(html).toContain(
      'aria-describedby="bitrix24-webhook-url-hint bitrix24-webhook-url-note"',
    );
    expect(html).toContain('id="bitrix24-webhook-url-hint"');
    expect(html).toContain('id="bitrix24-webhook-url-note"');
  });

  it('показывает ошибку формата и признак невалидного поля', () => {
    const html = render({ error: 'Введите абсолютный адрес вебхука.' });

    expect(html).toContain('role="alert"');
    expect(html).toContain('Введите абсолютный адрес вебхука.');
    expect(html).toContain('aria-invalid="true"');
  });

  it('передаёт имя, inputMode, плейсхолдер и disabled', () => {
    const html = render({ disabled: true });

    expect(html).toContain('name="webhookUrl"');
    expect(html.toLowerCase()).toContain('inputmode="url"');
    expect(html).toContain(
      'placeholder="https://portal.bitrix24.ru/rest/1/xxxxxxxx/"',
    );
    expect(html).toContain('disabled');
  });
});
