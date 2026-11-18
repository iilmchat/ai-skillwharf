import { z } from 'zod';
import { api } from './api';

/**
 * Регистрация аккаунта (UI-часть KI-073).
 *
 * `inviteCode` необязателен: пока открыта свободная регистрация, пустое поле
 * не уходит на сервер вовсе. Значение обрезается по краям и передаётся только
 * непустым, поэтому форма совместима и с открытой регистрацией, и с
 * инвайт-кодами, когда их поддержит API.
 */
export const registerFormSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(128),
  inviteCode: z.string().trim().max(128).optional(),
});

export type RegisterFormValues = z.input<typeof registerFormSchema>;

export interface RegisterPayload {
  email: string;
  password: string;
  /** Передаётся только если пользователь заполнил поле приглашения. */
  inviteCode?: string;
}

/** Тело `POST /api/v1/auth/register`: пустой `inviteCode` не отправляется. */
export const registerRequestSchema = registerFormSchema.transform(
  (values): RegisterPayload => {
    const inviteCode = values.inviteCode?.trim();

    return inviteCode === undefined || inviteCode === ''
      ? { email: values.email, password: values.password }
      : { email: values.email, password: values.password, inviteCode };
  },
);

/** Регистрация: схема проверяет форму ещё раз перед запросом к API. */
export async function registerAccount(input: unknown): Promise<void> {
  const payload = registerRequestSchema.parse(input);

  await api.post('/auth/register', payload);
}
