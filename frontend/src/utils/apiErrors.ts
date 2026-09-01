import axios from 'axios';

type ValidationDetail = {
  msg?: string;
};

type MessageDetail = {
  message?: string;
};

export function getApiErrorDetail(error: unknown): unknown {
  return axios.isAxiosError(error) ? error.response?.data?.detail : undefined;
}

export function getApiErrorMessage(error: unknown, fallback: string): string {
  if (axios.isAxiosError(error)) {
    const detail = getApiErrorDetail(error);
    if (typeof detail === 'string' && detail.trim()) return detail;
    if (detail && typeof detail === 'object' && 'message' in detail) {
      const message = (detail as MessageDetail).message;
      if (typeof message === 'string' && message.trim()) return message;
    }
    if (Array.isArray(detail)) {
      const messages = detail
        .map((entry) => {
          if (typeof entry === 'string') return entry;
          if (entry && typeof entry === 'object' && 'msg' in entry) {
            return String((entry as ValidationDetail).msg);
          }
          return null;
        })
        .filter(Boolean);
      if (messages.length) return messages.join('; ');
    }
    if (error.message === 'Network Error') return 'Не удалось подключиться к серверу';
  }

  if (error instanceof Error && error.message && error.message !== 'Network Error') {
    return error.message;
  }

  return fallback;
}
