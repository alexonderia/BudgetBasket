import type { ApprovalRegisterRow, ItemStatus, RegisterAggregateStatus, RegisterAggregates } from '../../types';

export type RegistryView = 'cfo' | 'category' | 'article' | 'module' | 'request';
export type RegistryColumnId = 'select' | 'structure' | 'requested' | 'approved' | 'rejected' | 'status' | 'justification' | 'comment' | 'files' | 'actions';

export type RegistryFilters = {
  search: string;
  status: '' | ItemStatus;
  budgetYear: string;
};

export const REGISTRY_VIEW_LABELS: Record<RegistryView, string> = {
  cfo: 'По ЦФО',
  article: 'По статье',
  category: 'По категории',
  module: 'По модулю',
  request: 'По заявкам',
};

export const REGISTRY_COLUMNS: Array<{ id: RegistryColumnId; label: string; width: number; hideable?: boolean }> = [
  { id: 'select', label: '', width: 40, hideable: false },
  { id: 'structure', label: 'Структура', width: 320, hideable: false },
  { id: 'requested', label: 'Запрошено, ₽', width: 118 },
  { id: 'approved', label: 'Согласовано, ₽', width: 126 },
  { id: 'rejected', label: 'Отклонено, ₽', width: 118 },
  { id: 'status', label: 'Статус', width: 148 },
  { id: 'justification', label: 'Обоснование', width: 300 },
  { id: 'comment', label: 'Комментарий', width: 220 },
  { id: 'files', label: 'Файлы', width: 86 },
  { id: 'actions', label: 'Действия', width: 108, hideable: false },
];

export const DEFAULT_COLUMN_VISIBILITY: Record<RegistryColumnId, boolean> = {
  select: true,
  structure: true,
  requested: true,
  approved: true,
  rejected: true,
  status: true,
  justification: true,
  comment: true,
  files: true,
  actions: true,
};

export const DEFAULT_COLUMN_WIDTHS = REGISTRY_COLUMNS.reduce((result, column) => {
  result[column.id] = column.width;
  return result;
}, {} as Record<RegistryColumnId, number>);

export const DEFAULT_COLUMN_ORDER = REGISTRY_COLUMNS.map((column) => column.id);

export function orderedRegistryColumns(order: RegistryColumnId[], visibility: Record<RegistryColumnId, boolean>) {
  const byId = new Map(REGISTRY_COLUMNS.map((column) => [column.id, column]));
  const normalizedOrder = [...order, ...DEFAULT_COLUMN_ORDER.filter((id) => !order.includes(id))];
  return normalizedOrder.flatMap((id) => {
    const column = byId.get(id);
    return column && visibility[id] ? [column] : [];
  });
}

export const STATUS_LABELS: Record<ItemStatus, string> = {
  on_review: 'На рассмотрении',
  approved: 'Согласовано',
  approved_with_changes: 'Согласовано с корректировкой',
  rejected: 'Отклонено',
  deleted: 'Удалено',
};

export const AGGREGATE_STATUS_LABELS: Record<RegisterAggregateStatus, string> = {
  approved: 'Все согласовано',
  rejected: 'Есть отклонения',
  partially_approved: 'Частично рассмотрено',
  on_review: 'На рассмотрении',
  in_progress: 'Частично рассмотрено',
  no_data: 'Не начато',
};

export function isRowActionable(item: ApprovalRegisterRow) {
  return item.is_cfo_review_actionable || (item.is_approval_actionable && !!item.position_id);
}

export function rowReadiness(item: ApprovalRegisterRow) {
  if (item.status === 'approved' || item.status === 'approved_with_changes') return 'Рассмотрено';
  if (item.status === 'rejected') return 'Требует доработки';
  if (item.is_cfo_review_actionable || item.is_approval_actionable) return 'Ожидает решения';
  if (item.is_collecting) return 'Сбор данных';
  if (item.is_cfo_review) return 'Проверка ЦФО';
  if (item.is_in_approval) return item.approval_stage ? `На согласовании: ${item.approval_stage}` : 'На согласовании';
  return 'Не начато';
}

export function groupReadiness(aggregates: RegisterAggregates) {
  if (!aggregates.total_rows) return 'Не начато';
  if (aggregates.approved_rows === aggregates.total_rows) return 'Готово';
  if (aggregates.rejected_rows > 0 && aggregates.pending_rows === 0) return 'Есть отклоненные строки';
  const reviewed = aggregates.approved_rows + aggregates.rejected_rows;
  if (reviewed > 0) return `Проверено: ${reviewed} из ${aggregates.total_rows}`;
  if (aggregates.collecting_requests > 0) return `Сбор данных: ${aggregates.collecting_requests} из ${aggregates.requests_count}`;
  return 'Не начато';
}

export function groupReadinessPercent(aggregates: RegisterAggregates) {
  if (!aggregates.total_rows) return 0;
  return Math.round(((aggregates.approved_rows + aggregates.rejected_rows) / aggregates.total_rows) * 100);
}

export function rowRejectedAmount(item: ApprovalRegisterRow) {
  if (item.status === 'rejected') return item.requested_sum;
  if (item.status === 'approved_with_changes') return Math.max(item.requested_sum - item.approved_sum, 0);
  return 0;
}

export const AGGREGATE_DISPLAY_LABELS: Record<RegisterAggregateStatus, string> = {
  approved: 'Согласовано',
  rejected: 'Отклонено',
  partially_approved: 'На рассмотрении',
  on_review: 'На рассмотрении',
  in_progress: 'На рассмотрении',
  no_data: 'Черновик',
};

export function toMoneyInput(value: number) {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value);
}

export function parseMoneyInput(value: string) {
  const normalized = value.replace(/\s/g, '').replace(',', '.');
  if (!/^\d*(?:\.\d{0,2})?$/.test(normalized) || !normalized) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}
