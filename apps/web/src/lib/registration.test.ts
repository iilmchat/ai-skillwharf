import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import {
  registerAccount,
  registerFormSchema,
  registerRequestSchema,
} from './registration';

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));

vi.mock('./api', () => ({
  api: { post: postMock },
}));

const VALID_FORM = {
  email: 'partner@example.com',
  password: 'strong-password',
};

describe('registerRequestSchema', () => {
  it('не отправляет inviteCode, если поле пустое или отсутствует', () => {
    expect(registerRequestSchema.parse(VALID_FORM)).toEqual(VALID_FORM);
    expect(
      registerRequestSchema.parse({ ...VALID_FORM, inviteCode: '' }),
    ).toEqual(VALID_FORM);
    expect(
      registerRequestSchema.parse({ ...VALID_FORM, inviteCode: '   ' }),
    ).toEqual(VALID_FORM);
    expect(
      registerRequestSchema.parse({ ...VALID_FORM, inviteCode: undefined }),
    ).toEqual(VALID_FORM);
  });

  it('передаёт непустой inviteCode без пробелов по краям', () => {
    expect(
      registerRequestSchema.parse({
        ...VALID_FORM,
        inviteCode: '  SW-INVITE-42  ',
      }),
    ).toEqual({ ...VALID_FORM, inviteCode: 'SW-INVITE-42' });
  });

  it('обрезает пробелы у email', () => {
    expect(
      registerRequestSchema.parse({
        email: '  partner@example.com ',
        password: 'strong-password',
      }),
    ).toEqual(VALID_FORM);
  });

  it('отклоняет неверный email, короткий пароль и длинный inviteCode', () => {
    expect(
      registerFormSchema.safeParse({ ...VALID_FORM, email: 'not-an-email' })
        .success,
    ).toBe(false);
    expect(
      registerFormSchema.safeParse({ ...VALID_FORM, password: 'short' })
        .success,
    ).toBe(false);
    expect(
      registerFormSchema.safeParse({
        ...VALID_FORM,
        inviteCode: 'x'.repeat(129),
      }).success,
    ).toBe(false);
    expect(
      registerFormSchema.safeParse({ ...VALID_FORM, password: 'x'.repeat(129) })
        .success,
    ).toBe(false);
  });
});

describe('registerAccount', () => {
  beforeEach(() => {
    postMock.mockReset();
  });

  it('отправляет email и пароль без inviteCode, если он не заполнен', async () => {
    await registerAccount(VALID_FORM);

    expect(postMock).toHaveBeenCalledWith('/auth/register', VALID_FORM);
    expect(postMock.mock.calls[0]?.[1]).not.toHaveProperty('inviteCode');
  });

  it('отправляет заполненный inviteCode в POST /auth/register', async () => {
    await registerAccount({ ...VALID_FORM, inviteCode: ' SW-INVITE-42 ' });

    expect(postMock).toHaveBeenCalledWith('/auth/register', {
      ...VALID_FORM,
      inviteCode: 'SW-INVITE-42',
    });
  });

  it('не обращается к API, если данные формы не прошли Zod-валидацию', async () => {
    await expect(
      registerAccount({ email: 'not-an-email', password: 'short' }),
    ).rejects.toBeInstanceOf(ZodError);
    expect(postMock).not.toHaveBeenCalled();
  });
});
