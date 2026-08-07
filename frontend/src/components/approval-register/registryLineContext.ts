import type { ApprovalRegisterRow } from '../../types';

function formatDecisionDate(value?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function lineStatusFootnote(item?: ApprovalRegisterRow) {
  const context = item?.status_context;
  if (!context) return undefined;

  const { editability, last_decision: lastDecision, current_owner: currentOwner } = context;
  if (editability.mode === 'editable') return 'Можно изменить';

  if (lastDecision?.by_name && (item?.status === 'approved' || item?.status === 'approved_with_changes' || item?.status === 'rejected')) {
    const stage = lastDecision.stage ? ` · ${lastDecision.stage}` : '';
    return `${lastDecision.by_name}${stage}`;
  }

  if (currentOwner?.by_name && editability.mode === 'readonly' && !editability.can_decide) {
    return `Ждёт: ${currentOwner.by_name}`;
  }

  return editability.summary || undefined;
}

export function lineStatusTooltipLines(item?: ApprovalRegisterRow) {
  const context = item?.status_context;
  if (!context) return [];

  const lines: string[] = [];
  const { editability, last_decision: lastDecision, current_owner: currentOwner } = context;

  if (editability.detail) lines.push(editability.detail);

  if (lastDecision?.by_name) {
    const when = formatDecisionDate(lastDecision.at);
    const parts = [`Последнее решение: ${lastDecision.action_label}`, `Кто: ${lastDecision.by_name}`];
    if (when) parts.push(`Когда: ${when}`);
    if (lastDecision.stage) parts.push(`Этап: ${lastDecision.stage}`);
    lines.push(parts.join(' · '));
  }

  if (currentOwner?.by_name && editability.mode !== 'editable') {
    lines.push(`Сейчас ждёт ${currentOwner.role_label}: ${currentOwner.by_name}`);
  }

  if (editability.mode === 'editable') {
    lines.push('Доступно: согласование, корректировка суммы, возврат на доработку');
  } else if (editability.mode === 'locked') {
    lines.push('Изменения заблокированы');
  } else {
    lines.push('Изменения недоступны на текущем этапе');
  }

  return [...new Set(lines.filter(Boolean))];
}
