import { describe, expect, it } from 'vitest';
import {
  AGGREGATE_DISPLAY_LABELS,
  DEFAULT_COLUMN_VISIBILITY,
  groupReadiness,
  groupReadinessPercent,
  groupRegistryStatus,
  isRowActionable,
  orderedRegistryColumns,
  parseMoneyInput,
  rowReadiness,
  rowRegistryStatus,
  rowRejectedAmount,
} from './registryConfig';

describe('registry display helpers', () => {
  const sampleAggregates = { requested_sum: 100, approved_sum: 50, rejected_sum: 0, pending_sum: 50, difference: -50, total_rows: 2, approved_rows: 1, rejected_rows: 0, pending_rows: 1, requests_count: 1, modules_count: 1, aggregate_status: 'in_progress' as const, collecting_requests: 0, cfo_review_requests: 0, cfo_review_actionable_requests: 0, in_approval_positions: 0, actionable_positions: 0 };
  const sampleRow = { id: '1', request_id: 'r', request_status: 'on_review' as const, budget_year: 2025, module_id: 'm', module_name: 'Модуль', cfo_id: 'c', cfo_name: 'ЦФО', category_id: 'cat', category_name: 'Категория', article_id: 'a', article_name: 'Статья', kind: 'dds' as const, name: 'Строка', justification: '', comment: '', files_count: 0, requested_sum: 10, approved_sum: 10, status: 'approved' as const, updated_at: '', is_collecting: false, is_cfo_review: false, is_cfo_review_actionable: false, position_id: null, is_in_approval: false, is_approval_actionable: false, approval_stage: null };

  it('shows status-related helpers', () => {
    expect(groupReadiness(sampleAggregates)).toBe('Проверено: 1 из 2');
    expect(groupReadinessPercent(sampleAggregates)).toBe(50);
    expect(rowReadiness(sampleRow)).toBe('Рассмотрено');
    expect(rowRegistryStatus(sampleRow).label).toBe('Утверждено');
    expect(AGGREGATE_DISPLAY_LABELS.in_progress).toBe('Частично рассмотрено');
    expect(rowRejectedAmount({ ...sampleRow, status: 'rejected', approved_sum: 0 })).toBe(10);
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
});
