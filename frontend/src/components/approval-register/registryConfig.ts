import type { ApprovalRegisterGroup, ApprovalRegisterRow, ItemStatus, RegisterAggregateStatus, RegisterAggregates, User } from '../../types';
import { ANALYTICS_FIELD_KEYS, EMPTY_ANALYTICS_FILTERS, type AnalyticsFieldKey } from '../../utils/analyticsFields';

export type RegistryView = 'cfo' | 'category' | 'article' | 'module' | 'request';
export type RegistryColumnId = 'select' | 'structure' | 'requested' | 'approved' | 'rejected' | 'status' | 'previous_step' | 'your_step' | 'justification' | 'comment' | 'files' | 'actions' | AnalyticsFieldKey;

export type RegistryFilters = {
  search: string;
  flow: '' | 'expense' | 'income';
  status: '' | ItemStatus;
  budgetYear: string;
  cfoId: string;
  articleId: string;
  requestStatus: string;
  frozen: '' | 'frozen' | 'fixed';
} & Record<AnalyticsFieldKey, string>;

export const REGISTRY_VIEW_LABELS: Record<RegistryView, string> = {
  cfo: 'По ЦФО',
  article: 'По статье',
  category: 'По категории',
  module: 'По модулю',
  request: 'По заявкам',
};

export const REGISTRY_COLUMNS: Array<{ id: RegistryColumnId; label: string; width: number; hideable?: boolean }> = [
  { id: 'select', label: '', width: 40, hideable: false },
  { id: 'structure', label: 'Структура', width: 300, hideable: false },
  { id: 'requested', label: 'План, ₽', width: 110 },
  { id: 'approved', label: 'Факт, ₽', width: 132 },
  { id: 'rejected', label: 'Корректировка, ₽', width: 132 },
  { id: 'status', label: 'Статус', width: 188 },
  { id: 'justification', label: 'Обоснование', width: 240 },
  { id: 'comment', label: 'Комментарий', width: 180 },
  { id: 'files', label: 'Файлы', width: 72 },
  ...ANALYTICS_FIELD_KEYS.map((id) => ({ id, label: `Аналитика ${id.slice(-1)}`, width: 160, hideable: true })),
];

export const DEFAULT_COLUMN_VISIBILITY: Record<RegistryColumnId, boolean> = {
  select: true,
  structure: true,
  requested: true,
  approved: true,
  rejected: true,
  previous_step: false,
  your_step: false,
  status: true,
  justification: true,
  comment: true,
  files: true,
  actions: false,
  ...ANALYTICS_FIELD_KEYS.reduce((result, key) => {
    result[key] = false;
    return result;
  }, {} as Record<AnalyticsFieldKey, boolean>),
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

export function usesWorkflowStepColumns(role?: User['role']) {
  return role === 'economist' || role === 'approver' || role === 'zgd';
}

export function defaultRegistryColumnVisibility(role?: User['role']): Record<RegistryColumnId, boolean> {
  const visibility = { ...DEFAULT_COLUMN_VISIBILITY };
  if (usesWorkflowStepColumns(role)) {
    // Status owns the current workflow action for every role.
    visibility.status = true;
    visibility.previous_step = false;
    visibility.actions = false;
    visibility.rejected = false;
    visibility.your_step = false;
    visibility.justification = true;
    visibility.comment = true;
    visibility.files = true;
  }
  return visibility;
}

/** Keep the essential workflow layout intact when restoring saved table preferences. */
export function applyWorkflowColumnVisibility(
  visibility: Record<RegistryColumnId, boolean>,
  role?: User['role'],
): Record<RegistryColumnId, boolean> {
  const coreVisibility = {
    ...visibility,
    status: true, // Status is the single place for state, locks and actions.
    rejected: true, // Internal id; user-facing label is «Корректировка».
    previous_step: false,
    your_step: false,
    actions: false,
  };
  const userVisibility = { ...coreVisibility, ...visibility, select: true, structure: true };
  if (!usesWorkflowStepColumns(role)) return userVisibility;
  return userVisibility;
}

export function groupPreviousStepSummary(aggregates: RegisterAggregates) {
  const waiting = Math.max(aggregates.pending_rows - aggregates.cfo_review_actionable_requests - aggregates.actionable_positions, 0);
  if (aggregates.cfo_review_requests > 0) {
    return `ЦФО: ${aggregates.cfo_review_requests} на проверке`;
  }
  if (waiting > 0) {
    return `Ожидает: ${waiting}`;
  }
  if (aggregates.approved_rows > 0) {
    return `Проверено: ${aggregates.approved_rows + aggregates.rejected_rows}`;
  }
  return '—';
}

export function groupYourStepSummary(aggregates: RegisterAggregates) {
  const submissionPositions = aggregates.submission_positions || 0;
  const economistCompletionPositions = aggregates.economist_completion_positions || 0;
  const decisions = aggregates.cfo_review_actionable_requests
    + Math.max(aggregates.actionable_positions - submissionPositions - economistCompletionPositions, 0);
  if (decisions > 0) {
    return `К решению: ${decisions}`;
  }
  if ((aggregates.revision_rows || 0) > 0) {
    return 'На доработке';
  }
  if (economistCompletionPositions > 0) {
    return `Согласовать и передать: ${economistCompletionPositions}`;
  }
  if (submissionPositions > 0) {
    return `Передать экономисту: ${submissionPositions}`;
  }
  if (aggregates.cfo_review_completable_requests > 0) {
    return `Можно передать: ${aggregates.cfo_review_completable_requests}`;
  }
  if (aggregates.approved_rows === aggregates.total_rows && aggregates.total_rows > 0) {
    return 'Все проверено';
  }
  return '—';
}

/** Article/CFO rows that can be decided in one click from the group row. */
export function canQuickDecideGroup(group: ApprovalRegisterGroup) {
  return isGroupActionable(group) && (group.type === 'article' || group.type === 'cfo');
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

export function isRowActionable(item: ApprovalRegisterRow, role?: User['role']) {
  if (role && !canUseLineLevelWorkflowActions(role) && item.is_approval_actionable && !item.is_cfo_review_actionable) {
    return false;
  }
  if (item.status_context?.editability) {
    return item.status_context.editability.can_decide;
  }
  if (item.is_approval_actionable && item.position_id) return true;
  return item.status === 'on_review' && item.is_cfo_review_actionable;
}

export function isGroupActionable(group: ApprovalRegisterGroup) {
  if (Object.keys(group.scope || {}).some((key) => key.startsWith('analytics_'))) return false;
  const hasRevision = (group.aggregates.revision_rows || 0) > 0;
  return (group.type === 'article' || group.type === 'cfo')
    && (
      group.aggregates.cfo_review_actionable_requests > 0
      || group.aggregates.cfo_review_completable_requests > 0
      || (!hasRevision && group.aggregates.actionable_positions > 0)
    );
}

export function isGroupSelectable(group: ApprovalRegisterGroup, role?: User['role']) {
  if (Object.keys(group.scope || {}).some((key) => key.startsWith('analytics_'))) return false;
  if (role === 'employee') {
    // An employee can also select a position that is already prepared for
    // transfer, so a stalled «Передайте экономисту» state can be completed
    // from the common selection bar.
    return groupHasCfoActions(group) || groupHasCfoCompleteActions(group) || groupHasWorkflowActions(group);
  }
  if (role) return groupHasWorkflowActions(group);
  return group.aggregates.cfo_review_actionable_requests > 0 || (
    !(group.aggregates.revision_rows || 0) && group.aggregates.actionable_positions > 0
  );
}

export function canUseLineLevelWorkflowActions(role: User['role']) {
  return role === 'economist' || role === 'employee' || role === 'zgd';
}

export function canEditRevisionLineDetails(role: User['role']) {
  return role === 'economist' || role === 'employee';
}

export function canEditApprovedAmount(role: User['role'], item: ApprovalRegisterRow) {
  if (role === 'approver' || role === 'zgd') return false;
  if (item.status_context?.editability) {
    return item.status_context.editability.can_edit_amount;
  }
  if (role === 'employee') {
    return item.is_cfo_review_actionable && item.status === 'on_review';
  }
  if (role === 'economist') {
    return item.is_approval_actionable;
  }
  return false;
}

/**
 * A point approval accepts the full plan until the user explicitly enters a
 * fact.  This keeps an empty fact (shown as 0 in a read-only cell) distinct
 * from a deliberate correction to zero.
 */
export function resolvePointApprovalAmount(
  requestedSum: number,
  factSum: number,
  hasEnteredFact: boolean,
) {
  return hasEnteredFact ? factSum : requestedSum;
}

export function groupHasCfoActions(group: ApprovalRegisterGroup) {
  return group.aggregates.cfo_review_actionable_requests > 0;
}

export function groupHasCfoCompleteActions(group: ApprovalRegisterGroup) {
  return group.aggregates.cfo_review_completable_requests > 0;
}

export function groupHasWorkflowActions(group: ApprovalRegisterGroup) {
  return !(group.aggregates.revision_rows || 0) && group.aggregates.actionable_positions > 0;
}

export function workflowApproveLabel(role: User['role']) {
  if (role === 'employee') return 'Передать экономисту';
  if (role === 'economist') return 'Согласовать и передать';
  return 'Согласовать';
}

export function rowReadiness(item: ApprovalRegisterRow) {
  if (item.is_revision) return 'Требует доработки';
  if (item.status === 'approved' || item.status === 'approved_with_changes') return 'Рассмотрено';
  if (item.status === 'rejected') return 'Отклонено';
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
  partially_approved: 'Частично рассмотрено',
  on_review: 'На рассмотрении',
  in_progress: 'Частично рассмотрено',
  no_data: 'Черновик',
};

export type RegistryStatusTone = 'success' | 'error' | 'warning' | 'info' | 'default';

export type RegistryStatusDisplay = {
  label: string;
  tone: RegistryStatusTone;
  hint: string;
  shortHint?: string;
};

export function rowRegistryStatus(item: ApprovalRegisterRow): RegistryStatusDisplay {
  if (item.fixed) {
    return {
      label: 'Зафиксировано',
      tone: 'default',
      hint: 'Строка зафиксирована после финального согласования',
      shortHint: 'Изменения недоступны',
    };
  }
  if (item.status === 'deleted') {
    return {
      label: 'Удалена',
      tone: 'default',
      hint: 'Строка удалена из заявки и сохранена в истории изменений',
      shortHint: 'Удалена',
    };
  }
  const wasReviewedAfterRevision = Boolean(
    item.is_revision
    && !item.is_position_submission_actionable
    && item.status_context
    && !item.status_context?.editability?.can_decide
    && (item.status === 'approved' || item.status === 'approved_with_changes' || item.status === 'rejected'),
  );
  if (wasReviewedAfterRevision) {
    const approved = item.status === 'approved' || item.status === 'approved_with_changes';
    return {
      label: approved ? 'Согласовано после доработки' : 'Отклонено после доработки',
      tone: approved ? 'success' : 'error',
      hint: approved
        ? 'Повторное решение по строке сохранено. Завершите проверку позиции, когда рассмотрите остальные строки.'
        : 'Повторное отрицательное решение по строке сохранено.',
      shortHint: approved ? 'Решение повторно принято' : 'Решение повторно отклонено',
    };
  }
  if (item.status_context?.editability?.can_decide) {
    return {
      label: 'Ожидает вашего решения',
      tone: 'warning',
      hint: 'Именно вы можете принять решение по строке на текущем этапе',
      shortHint: 'Можно принять решение',
    };
  }
  if (item.is_position_submission_actionable && !item.is_revision_actionable) {
    return {
      label: 'Передайте экономисту',
      tone: 'warning',
      hint: 'Проверка завершена. Передайте позицию экономисту для продолжения маршрута',
      shortHint: 'Можно передать экономисту',
    };
  }
  if (item.is_revision) {
    return {
      label: 'На доработке',
      tone: 'warning',
      hint: item.is_revision_actionable
        ? 'Исправьте строку и повторно отправьте заявку'
        : 'Строка возвращена на текущий этап маршрута',
      shortHint: 'Требуются исправления',
    };
  }
  if (item.status === 'approved') {
    return {
      label: 'Утверждено',
      tone: 'success',
      hint: 'Решение принято, строка больше не требует действий',
      shortHint: 'Решение принято',
    };
  }
  if (item.status === 'approved_with_changes') {
    return {
      label: 'Утверждено с изменениями',
      tone: 'success',
      hint: 'Согласовано с корректировкой суммы',
      shortHint: 'Сумма скорректирована',
    };
  }
  if (item.status === 'rejected') {
    return {
      label: 'Отклонено',
      tone: 'error',
      hint: 'Строка не принята для выделения бюджета',
      shortHint: 'Отрицательное решение',
    };
  }

  if (item.is_collecting || item.request_status === 'draft') {
    return {
      label: 'Черновик',
      tone: 'default',
      hint: 'Заявка ещё не отправлена на проверку. Согласование недоступно',
      shortHint: 'Не отправлено',
    };
  }
  if (item.request_status === 'cancelled') {
    return {
      label: 'Заявка отменена',
      tone: 'default',
      hint: 'Заявка отменена, действия недоступны',
      shortHint: 'Отменена',
    };
  }
  if (item.request_status === 'rejected') {
    return {
      label: 'Заявка отклонена',
      tone: 'error',
      hint: 'Заявка отклонена целиком на этапе проверки ЦФО',
      shortHint: 'Заявка отклонена',
    };
  }

  if (item.is_cfo_review) {
    if (item.is_cfo_review_actionable) {
      return {
        label: 'Ожидает вашего решения',
        tone: 'warning',
        hint: 'Проверка ответственным ЦФО: можно согласовать или вернуть на доработку',
        shortHint: 'Можно принять решение',
      };
    }
    return {
      label: 'Проверка ЦФО',
      tone: 'info',
      hint: 'Заявка на проверке у ответственного ЦФО. Ваше решение пока недоступно',
      shortHint: 'Ждёт ответственного ЦФО',
    };
  }

  if (item.is_in_approval) {
    if (item.is_approval_actionable) {
      const stage = item.approval_stage || 'согласование';
      return {
        label: 'Ожидает вашего решения',
        tone: 'warning',
        hint: `Текущий этап: ${stage}. Можно согласовать или вернуть на доработку`,
        shortHint: 'Можно принять решение',
      };
    }
    const stage = item.approval_stage || 'согласование';
    return {
      label: 'Ожидает предыдущих этапов',
      tone: 'default',
      hint: `Сейчас на этапе «${stage}». Решение станет доступно после предыдущих согласований`,
      shortHint: 'Ждёт предыдущих этапов',
    };
  }

  if (item.status === 'on_review') {
    return {
      label: 'На рассмотрении',
      tone: 'warning',
      hint: 'Строка ожидает решения в текущем процессе',
      shortHint: 'Ожидает решения',
    };
  }

  return {
    label: 'Не начато',
    tone: 'default',
    hint: 'Данные ещё не отправлены в процесс согласования',
    shortHint: 'Не отправлено',
  };
}

export function groupRegistryStatus(aggregates: RegisterAggregates): RegistryStatusDisplay {
  if (!aggregates.total_rows) {
    return {
      label: 'Нет данных',
      tone: 'default',
      hint: 'В группе нет строк для отображения',
      shortHint: 'Нет строк',
    };
  }

  const submissionPositions = aggregates.submission_positions || 0;
  const economistCompletionPositions = aggregates.economist_completion_positions || 0;
  const decisions = aggregates.cfo_review_actionable_requests
    + Math.max(aggregates.actionable_positions - submissionPositions - economistCompletionPositions, 0);
  if (decisions > 0) {
    return {
      label: 'Ожидает вашего решения',
      tone: 'warning',
      hint: `${decisions} объектов ждут вашего решения`,
      shortHint: 'Можно принять решение',
    };
  }
  // A returned line must be visible before a handoff from another line in the
  // same aggregated group. Otherwise the user is incorrectly prompted to send
  // the position to the economist while it is waiting for module revisions.
  if ((aggregates.revision_rows || 0) > 0 && !(aggregates.cfo_review_completable_requests || 0)) {
    return {
      label: 'На доработке',
      tone: 'warning',
      hint: `${aggregates.revision_rows} строк возвращено на доработку`,
      shortHint: 'Требуются исправления',
    };
  }
  if (submissionPositions > 0) {
    return {
      label: 'Передайте экономисту',
      tone: 'warning',
      hint: `${submissionPositions} позиций проверены по строкам и готовы к передаче экономисту`,
      shortHint: 'Можно передать экономисту',
    };
  }
  if (economistCompletionPositions > 0) {
    return {
      label: 'Согласуйте и передайте',
      tone: 'warning',
      hint: `${economistCompletionPositions} позиций рассмотрены экономистом и готовы к передаче дальше по маршруту`,
      shortHint: 'Можно передать дальше',
    };
  }
  if (aggregates.cfo_review_completable_requests > 0) {
    return {
      label: 'Завершите проверку',
      tone: 'warning',
      hint: `${aggregates.cfo_review_completable_requests} заявок проверены по строкам, но ещё не переданы в маршрут согласования`,
      shortHint: 'Нужно завершить проверку',
    };
  }
  if ((aggregates.revision_rows || 0) > 0) {
    return {
      label: 'На доработке',
      tone: 'warning',
      hint: `${aggregates.revision_rows} строк возвращено на доработку`,
      shortHint: 'Требуются исправления',
    };
  }

  if (aggregates.aggregate_status === 'approved') {
    return {
      label: 'Всё согласовано',
      tone: 'success',
      hint: `Все ${aggregates.total_rows} строк утверждены`,
      shortHint: 'Все строки утверждены',
    };
  }
  if (aggregates.aggregate_status === 'rejected') {
    return {
      label: 'Есть отклонения',
      tone: 'error',
      hint: `${aggregates.rejected_rows} из ${aggregates.total_rows} строк отклонено`,
      shortHint: 'Есть отклонённые строки',
    };
  }
  if (aggregates.aggregate_status === 'partially_approved') {
    const reviewed = aggregates.approved_rows + aggregates.rejected_rows;
    return {
      label: 'Частично рассмотрено',
      tone: 'info',
      hint: `Проверено ${reviewed} из ${aggregates.total_rows} строк`,
      shortHint: `Проверено ${reviewed} из ${aggregates.total_rows}`,
    };
  }

  if (aggregates.collecting_requests > 0) {
    if (aggregates.collecting_requests === aggregates.requests_count) {
      return {
        label: 'Черновик',
        tone: 'default',
        hint: 'Заявки не отправлены на проверку. Согласование недоступно',
        shortHint: 'Не отправлено',
      };
    }
    return {
      label: 'Частично в черновике',
      tone: 'default',
      hint: `${aggregates.collecting_requests} из ${aggregates.requests_count} заявок ещё не отправлены`,
      shortHint: `${aggregates.collecting_requests} заявок не отправлено`,
    };
  }

  if (aggregates.cfo_review_actionable_requests > 0) {
    return {
      label: 'Ожидает вашего решения',
      tone: 'warning',
      hint: `${aggregates.cfo_review_actionable_requests} заявок ждут проверки ответственного ЦФО`,
      shortHint: 'Можно принять решение',
    };
  }
  if (aggregates.cfo_review_requests > 0) {
    return {
      label: 'Проверка ЦФО',
      tone: 'info',
      hint: `${aggregates.cfo_review_requests} заявок на проверке у ответственного ЦФО`,
      shortHint: 'Ждёт ответственного ЦФО',
    };
  }
  if (aggregates.in_approval_positions > 0) {
    return {
      label: 'На согласовании',
      tone: 'info',
      hint: `${aggregates.in_approval_positions} позиций в маршруте согласования, ожидают предыдущих этапов`,
      shortHint: 'Ждёт предыдущих этапов',
    };
  }

  return {
    label: AGGREGATE_STATUS_LABELS[aggregates.aggregate_status] || 'На рассмотрении',
    tone: 'warning',
    hint: `Ожидает решения: ${aggregates.pending_rows} из ${aggregates.total_rows} строк`,
    shortHint: `Ожидает ${aggregates.pending_rows} строк`,
  };
}

export function rowActionBlockedReason(item: ApprovalRegisterRow) {
  if (isRowActionable(item)) return null;
  return item.status_context?.editability.detail || rowRegistryStatus(item).hint;
}

export function toMoneyInput(value: number) {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value);
}

export function parseMoneyInput(value: string) {
  const normalized = value.replace(/\s/g, '').replace(',', '.');
  if (!/^\d*(?:\.\d{0,2})?$/.test(normalized) || !normalized) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}
