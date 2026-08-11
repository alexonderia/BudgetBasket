import { describe, expect, it } from 'vitest';
import axios from 'axios';
import { getApiErrorMessage } from './apiErrors';

describe('getApiErrorMessage', () => {
  it('returns API detail string', () => {
    const error = new axios.AxiosError(
      'Request failed',
      'ERR_BAD_REQUEST',
      undefined,
      undefined,
      {
        status: 409,
        data: { detail: 'Заявка не находится на проверке ЦФО' },
        statusText: 'Conflict',
        headers: {},
        config: {} as never,
      },
    );
    expect(getApiErrorMessage(error, 'fallback')).toBe('Заявка не находится на проверке ЦФО');
  });

  it('returns thrown Error message', () => {
    expect(getApiErrorMessage(new Error('Для этой строки действие больше недоступно'), 'fallback'))
      .toBe('Для этой строки действие больше недоступно');
  });

  it('falls back when detail is missing', () => {
    expect(getApiErrorMessage(new Error('unknown'), 'Не удалось сохранить')).toBe('unknown');
    expect(getApiErrorMessage(null, 'Не удалось сохранить')).toBe('Не удалось сохранить');
  });
});
