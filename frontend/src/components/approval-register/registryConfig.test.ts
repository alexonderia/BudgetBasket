import { describe, expect, it } from 'vitest';
import {
  AGGREGATE_DISPLAY_LABELS,
  DEFAULT_COLUMN_VISIBILITY,
  REGISTRY_COLUMNS,
  applyWorkflowColumnVisibility,
  groupReadiness,
  groupReadinessPercent,
  groupRegistryStatus,
  groupYourStepSummary,
  groupHasWorkflowActions,
  isGroupActionable,
  isGroupSelectable,
  isRowActionable,
  orderedRegistryColumns,
  parseMoneyInput,
  rowReadiness,
  rowRegistryStatus,
  rowRejectedAmount,
} from './registryConfig';

describe('registry display helpers', () => {
  const sampleAggregates = { requested_sum: 100, approved_sum: 50, rejected_sum: 0, pending_sum: 50, difference: -50, total_rows: 2, approved_rows: 1, rejected_rows: 0, pending_rows: 1, requests_count: 1, modules_count: 1, aggregate_status: 'in_progress' as const, collecting_requests: 0, cfo_review_requests: 0, cfo_review_actionable_requests: 0, cfo_review_completable_requests: 0, in_approval_positions: 0, actionable_positions: 0 };
  const sampleRow = { id: '1', request_id: 'r', request_status: 'on_review' as const, budget_year: 2025, module_id: 'm', module_name: 'Модуль', cfo_id: 'c', cfo_name: 'ЦФО', category_id: 'cat', category_name: 'Категория', article_id: 'a', article_name: 'Статья', kind: 'dds' as const, name: 'Строка', justification: '', comment: '', files_count: 0, requested_sum: 10, approved_sum: 10, status: 'approved' as const, updated_at: '', is_collecting: false, is_cfo_review: false, is_cfo_review_actionable: false, position_id: null, is_in_approval: false, is_approval_actionable: false, approval_stage: null };

  it('shows status-related helpers', () => {
    expect(groupReadiness(sampleAggregates)).toBe('Проверено: 1 из 2');
    expect(groupReadinessPercent(sampleAggregates)).toBe(50);
    expect(rowReadiness(sampleRow)).toBe('Рассмотрено');
    expect(rowRegistryStatus(sampleRow).label).toBe('Утверждено');
    expect(AGGREGATE_DISPLAY_LABELS.in_progress).toBe('Частично рассмотрено');
    expect(rowRejectedAmount({ ...sampleRow, status: 'rejected', approved_sum: 0 })).toBe(10);
  });

  it('distinguishes sending a reviewed position from a line decision', () => {
    const aggregates = {
      ...sampleAggregates,
      actionable_positions: 1,
      submission_positions: 1,
    };
    expect(groupYourStepSummary(aggregates)).toBe('Передать экономисту: 1');
    expect(groupRegistryStatus(aggregates).label).toBe('Передайте экономисту');
  });

  it('shows revision instead of a handoff when a group contains returned lines', () => {
    expect(groupRegistryStatus({
      ...sampleAggregates,
      actionable_positions: 1,
      submission_positions: 1,
      revision_rows: 1,
    }).label).toBe('На доработке');
  });

  it('does not expose workflow actions for a group with returned lines', () => {
    const group = {
      id: 'group', type: 'article' as const, name: 'Article', label: 'Article', children: [],
      module_id: 'module', article_id: 'article', category_id: 'category', request_ids: ['request'], can_load_rows: false,
      aggregates: {
        ...sampleAggregates,
        actionable_positions: 1,
        submission_positions: 1,
        revision_rows: 1,
      },
    };
    expect(groupYourStepSummary(group.aggregates)).toBe('На доработке');
    expect(groupHasWorkflowActions(group)).toBe(false);
    expect(isGroupActionable(group)).toBe(false);
    expect(isGroupSelectable(group)).toBe(false);
  });

  it('limits group selection to actions available to the current role', () => {
    const workflowOnlyGroup = {
      id: 'group', type: 'article' as const, name: 'Article', label: 'Article', children: [],
      module_id: 'module', article_id: 'article', category_id: 'category', request_ids: ['request'], can_load_rows: false,
      aggregates: { ...sampleAggregates, actionable_positions: 1 },
    };
    const cfoCompletionGroup = {
      ...workflowOnlyGroup,
      aggregates: { ...sampleAggregates, cfo_review_completable_requests: 1 },
    };

    expect(isGroupSelectable(workflowOnlyGroup, 'employee')).toBe(false);
    expect(isGroupSelectable(workflowOnlyGroup, 'economist')).toBe(true);
    expect(isGroupSelectable(cfoCompletionGroup, 'employee')).toBe(true);
    expect(isGroupSelectable(cfoCompletionGroup, 'economist')).toBe(false);
  });

  it('distinguishes economist completion from a line decision', () => {
    const aggregates = {
      ...sampleAggregates,
      actionable_positions: 1,
      economist_completion_positions: 1,
    };
    expect(groupYourStepSummary(aggregates)).toBe('Согласовать и передать: 1');
    expect(groupRegistryStatus(aggregates).label).toBe('Согласуйте и передайте');
  });

  it('explains draft and waiting states clearly', () => {
    expect(rowRegistryStatus({ ...sampleRow, status: 'on_review', is_collecting: true, request_status: 'draft' }).label).toBe('Черновик');
    expect(rowRegistryStatus({
      ...sampleRow,
      status: 'on_review',
      is_in_approval: true,
      is_approval_actionable: false,
      approval_stage: 'Проверка экономистом ЦФО',
    }).label).toBe('Ожидает предыдущих этапов');
    expect(groupRegistryStatus({ ...sampleAggregates, collecting_requests: 1, requests_count: 1 }).label).toBe('Черновик');
    expect(groupRegistryStatus({ ...sampleAggregates, cfo_review_actionable_requests: 1 }).label).toBe('Ожидает вашего решения');
    expect(groupRegistryStatus({ ...sampleAggregates, cfo_review_completable_requests: 1 }).label).toBe('Завершите проверку');
    expect(groupRegistryStatus({ ...sampleAggregates, aggregate_status: 'rejected', rejected_rows: 2, pending_rows: 0, cfo_review_completable_requests: 1, revision_rows: 1 }).label).toBe('Завершите проверку');
    expect(groupRegistryStatus({ ...sampleAggregates, aggregate_status: 'approved', revision_rows: 1 }).label).toBe('На доработке');
  });

  it('keeps rejection distinct from revision', () => {
    expect(rowRegistryStatus({ ...sampleRow, status: 'rejected' }).label).toBe('Отклонено');
    expect(rowRegistryStatus({ ...sampleRow, status: 'deleted', is_collecting: true, request_status: 'draft' }).label).toBe('Удалена');
    expect(rowRegistryStatus({ ...sampleRow, is_revision: true, is_revision_actionable: false }).label).toBe('На доработке');
    expect(rowRegistryStatus({
      ...sampleRow,
      is_revision: true,
      status_context: {
        editability: {
          can_decide: false,
          can_edit_amount: false,
          can_edit_analytics: false,
          mode: 'readonly',
          summary: 'Решение принято',
          detail: 'Повторное решение сохранено',
        },
      },
    }).label).toBe('Согласовано после доработки');
    expect(rowRegistryStatus({
      ...sampleRow,
      is_revision: true,
      is_position_submission_actionable: true,
      status_context: {
        editability: {
          can_decide: false,
          can_edit_amount: false,
          can_edit_analytics: false,
          mode: 'readonly',
          summary: 'На доработке',
          detail: 'Позиция ждёт повторной проверки ЦФО',
        },
      },
    }).label).toBe('Требуется ваша проверка');
  });

  it('does not treat already decided lines as actionable', () => {
    const decidedButCfoReview = {
      ...sampleRow,
      status: 'on_review' as const,
      is_cfo_review: true,
      is_cfo_review_actionable: true,
      status_context: {
        editability: {
          can_decide: false,
          can_edit_amount: false,
          can_edit_analytics: true,
          mode: 'readonly' as const,
          summary: 'Решение принято',
          detail: 'Решение уже принято',
        },
      },
    };
    expect(isRowActionable(decidedButCfoReview)).toBe(false);

    const pending = {
      ...sampleRow,
      status: 'on_review' as const,
      is_cfo_review: true,
      is_cfo_review_actionable: true,
      status_context: {
        editability: {
          can_decide: true,
          can_edit_amount: true,
          can_edit_analytics: true,
          mode: 'editable' as const,
          summary: 'Можно изменить',
          detail: 'Вы можете согласовать строку',
        },
      },
    };
    expect(isRowActionable(pending)).toBe(true);

    const economistLine = {
      ...sampleRow,
      status: 'approved' as const,
      position_id: 'pos-1',
      is_in_approval: true,
      is_approval_actionable: true,
      approval_stage: 'Проверка экономистом ЦФО',
      status_context: {
        editability: {
          can_decide: true,
          can_edit_amount: true,
          can_edit_analytics: true,
          mode: 'editable' as const,
          summary: 'Можно изменить',
          detail: 'Экономист может принять решение',
        },
      },
    };
    expect(isRowActionable(economistLine)).toBe(true);

    expect(isRowActionable({ ...economistLine, is_cfo_review_actionable: false }, 'approver')).toBe(false);
  });

  it('parses amounts with spaces and rejects non-numeric input', () => {
    expect(parseMoneyInput('1 250,50')).toBe(1250.5);
    expect(parseMoneyInput('12x')).toBeNull();
  });

  it('uses saved column order and hidden columns', () => {
    const visibility = { ...DEFAULT_COLUMN_VISIBILITY, comment: false };
    const ids = orderedRegistryColumns(['select', 'structure', 'status', 'requested'], visibility).map((column) => column.id);
    expect(ids.slice(0, 4)).toEqual(['select', 'structure', 'status', 'requested']);
    expect(ids).not.toContain('comment');
    expect(ids).not.toContain('readiness');
  });

  it('keeps the required financial columns and one status/action column for every role', () => {
    expect(REGISTRY_COLUMNS.filter((column) => ['structure', 'requested', 'approved', 'rejected', 'status'].includes(column.id)).map((column) => column.label))
      .toEqual(['Структура', 'План, ₽', 'Факт, ₽', 'Корректировка, ₽', 'Статус']);

    const visibility = applyWorkflowColumnVisibility({ ...DEFAULT_COLUMN_VISIBILITY, status: false, your_step: true, actions: true }, 'economist');
    expect(visibility.status).toBe(true);
    expect(visibility.your_step).toBe(false);
    expect(visibility.actions).toBe(false);
  });
});
