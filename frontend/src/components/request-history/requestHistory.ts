import type { ItemStatus, RequestLog, RequestStatus, StepStatus } from '../../types';
import { ANALYTICS_FIELD_LABELS } from '../../utils/analyticsFields';
import { itemStatusLabels, requestStatusLabels, stepStatusLabels } from '../../utils/labels';
import { money } from '../../utils/labels';

const historyActionLabels: Record<string, string> = {
  created: 'Заявка создана',
  submitted: 'Заявка отправлена на рассмотрение',
  withdrawn: 'Заявка отозвана в черновик',
  cancelled: 'Заявка отменена',
  review_started: 'Начато рассмотрение заявки',
  finalized: 'Рассмотрение заявки завершено',
  reopened: 'Заявка возвращена на рассмотрение',
  frozen: 'Бюджет зафиксирован',
  unfrozen: 'Бюджет разморожен',
  request_created: 'Заявка создана',
  request_submitted_to_cfo: 'Заявка отправлена на проверку ЦФО',
  request_cancelled: 'Заявка отменена',
  request_restored: 'Заявка восстановлена из отмены',
  cfo_request_review_completed: 'Проверка ЦФО завершена',
  line_created: 'Создана строка заявки',
  line_updated: 'Изменена строка заявки',
  line_deleted: 'Удалена строка заявки',
  cfo_item_decided: 'Решение по строке на этапе ЦФО',
  economist_item_decided: 'Решение экономиста по строке',
  item_returned_for_revision: 'Строка возвращена на доработку',
  file_attached: 'Добавлен файл',
  file_deleted: 'Удалён файл',
  file_sanitized: 'Файл обработан антивирусом',
  chat_message_sent: 'Отправлено сообщение в чат',
  system_message_sent: 'Отправлено системное сообщение в чат',
  position_sent_to_economist: 'Позиция передана экономисту',
  economist_review_completed: 'Экономист завершил проверку позиции',
  position_frozen_and_forwarded: 'Позиция зафиксирована и передана дальше',
  position_items_frozen: 'Строки позиции зафиксированы',
  position_unfrozen: 'Фиксация позиции снята',
  position_returned: 'Позиция возвращена на доработку',
  fixed_items_reopened: 'Зафиксированные строки открыты повторно',
  position_comment_added: 'Добавлен комментарий к позиции',
  position_moved_to_shared_economist_step: 'Позиция переведена на общий этап экономиста',
  position_moved_to_economist_step: 'Позиция переведена на этап экономиста',
};

const approvalRouteActionLabels: Record<string, string> = {
  step_created: 'Этап создан',
  step_reopened: 'Этап открыт повторно',
  step_opened: 'Этап открыт для согласования',
  step_approved: 'Этап согласован',
  step_returned: 'Заявка возвращена на доработку',
  step_status_changed: 'Статус этапа изменён',
  approval_graph_closed: 'Маршрут закрыт после фиксации ЗГД',
  approval_request_step_approved: 'Заявка согласована на этапе',
  approval_request_fixed: 'Заявка зафиксирована ЗГД',
  approval_step_opened: 'Этап открыт для согласования',
  approval_step_waiting: 'Этап ожидает предыдущий этап',
  approval_request_forwarded: 'Заявка передана на следующий этап',
  approval_request_returned: 'Заявка возвращена на доработку',
  approval_request_returned_to_employee: 'Заявка возвращена сотруднику на доработку',
  approval_request_reopened_for_revision: 'Заявка направлена на доработку',
  approval_request_revision_accepted: 'Заявка принята после доработки',
  approval_request_final_revoked: 'Финальное согласование ЗГД отменено',
  approval_economist_review_resumed: 'Экономист возобновил рассмотрение заявки',
};

const historyFieldLabels: Record<string, string> = {
  name: 'Наименование',
  justification: 'Обоснование',
  sum_plan: 'Плановая сумма',
  sum_fact: 'Утверждённая сумма',
  status: 'Статус',
  comment: 'Комментарий',
  frozen: 'Фиксация бюджета',
  fixed: 'Финальная фиксация ЗГД',
  is_income: 'Тип строки',
  dds_id: 'Статья ДДС',
  invest_id: 'Инвест-проект',
  text: 'Текст сообщения',
  ...ANALYTICS_FIELD_LABELS,
};

const technicalHistoryFields = new Set([
  'id', 'item_id', 'request_id', 'req_id', 'unit_id', 'economist_id', 'created_at', 'updated_at',
]);

const approvalOnlyActions = new Set([
  'request_submitted_to_cfo',
  'cfo_request_review_completed',
  'cfo_item_decided',
  'economist_item_decided',
]);

export function historyActionLabel(action: string) {
  if (action.startsWith('approval_')) {
    return approvalRouteActionLabels[action] || 'Состояние согласования изменено';
  }
  return historyActionLabels[action] || 'Данные заявки изменены';
}

export function historyActorName(actor: RequestLog['user']) {
  if (!actor) return 'Неизвестный пользователь';
  const profile = actor.profile;
  return [profile?.last_name, profile?.name, profile?.second_name].filter(Boolean).join(' ') || actor.login;
}

function historyValue(value: unknown, field: string, entity: string, action: string) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') {
    if (field === 'is_income') return value ? 'Доход' : 'Расход';
    return value ? 'Да' : 'Нет';
  }
  if (field === 'sum_plan' || field === 'sum_fact') return money(Number(value));
  if (field === 'status' && typeof value === 'string') {
    if (action.startsWith('approval_')) {
      return stepStatusLabels[value as StepStatus] || requestStatusLabels[value as RequestStatus] || value;
    }
    return entity === 'req_item'
      ? itemStatusLabels[value as ItemStatus] || value
      : requestStatusLabels[value as RequestStatus] || stepStatusLabels[value as StepStatus] || value;
  }
  if (field === 'frozen') return value ? 'Зафиксирован' : 'Разморожен';
  return String(value);
}

export type HistoryChange = { field: string; from: string; to: string };

export function historyChanges(entry: RequestLog): HistoryChange[] {
  return Object.entries(entry.log.changes || {})
    .filter(([field]) => !technicalHistoryFields.has(field))
    .map(([field, change]) => ({
      field: historyFieldLabels[field] || 'Параметр заявки',
      from: historyValue(change.from, field, entry.log.entity, entry.log.action),
      to: historyValue(change.to, field, entry.log.entity, entry.log.action),
    }));
}

export function isApprovalHistoryEntry(entry: RequestLog) {
  if (entry.source === 'cfo_position') return true;
  if (entry.log.action.startsWith('approval_')) return true;
  return approvalOnlyActions.has(entry.log.action);
}

export function splitRequestLogs(logs: RequestLog[]) {
  const content: RequestLog[] = [];
  const approval: RequestLog[] = [];
  logs.forEach((entry) => {
    if (isApprovalHistoryEntry(entry)) approval.push(entry);
    else content.push(entry);
  });
  return { content, approval };
}

export function filterLogsByLine(logs: RequestLog[], lineId?: string, lineName?: string) {
  if (!lineId && !lineName) return logs;
  return logs.filter((entry) => {
    const entityId = entry.log.entity_id || entry.log.req_item_id;
    if (lineId && entityId === lineId) return true;
    if (lineName && entry.subject?.name && entry.subject.name === lineName) return true;
    return false;
  });
}
