export type ForwardBlockingItem = {
  id: string;
  name: string;
  status?: string;
};

export type ForwardBlockingRequest = {
  request_id: string;
  module_id?: string | null;
  module_name?: string;
  reason: string;
  message?: string;
  pending_count?: number;
  pending_items: ForwardBlockingItem[];
};

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function parseForwardBlockingRequests(detail: unknown): ForwardBlockingRequest[] {
  if (!detail || typeof detail !== 'object') return [];
  const raw = (detail as { blocking_requests?: unknown }).blocking_requests;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
    .map((entry) => {
      const pendingItems = Array.isArray(entry.pending_items)
        ? entry.pending_items
          .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
          .map((item) => ({
            id: stringValue(item.id),
            name: stringValue(item.name) || 'Без названия',
            status: stringValue(item.status) || undefined,
          }))
        : [];
      return {
        request_id: stringValue(entry.request_id),
        module_id: stringValue(entry.module_id) || null,
        module_name: stringValue(entry.module_name) || 'Модуль',
        reason: stringValue(entry.reason) || 'unknown',
        message: stringValue(entry.message) || undefined,
        pending_count: typeof entry.pending_count === 'number' ? entry.pending_count : pendingItems.length,
        pending_items: pendingItems,
      };
    })
    .filter((entry) => !!entry.request_id);
}
