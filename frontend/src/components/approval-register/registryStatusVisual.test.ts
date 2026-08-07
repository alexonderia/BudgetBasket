import { describe, expect, it } from 'vitest';
import { groupStatusPresentation, rowStatusPresentation, rowStatusVisual } from './registryStatusVisual';

const baseStatus = {
  tone: 'warning' as const,
  hint: 'Подсказка',
  shortHint: 'Кратко',
};

describe('registry status visuals', () => {
  it('highlights actionable row with filled action badge', () => {
    const presentation = rowStatusPresentation({ ...baseStatus, label: 'Ожидает вашего решения' }, {
      is_cfo_review: true,
    } as never);
    expect(presentation.primary.text).toBe('Ваше решение');
    expect(presentation.primary.variant).toBe('action');
    expect(presentation.meta).toContain('ЦФО');
  });

  it('keeps approved row compact and calm', () => {
    const spec = rowStatusVisual({ ...baseStatus, label: 'Утверждено' });
    expect(spec.text).toBe('Согласовано');
    expect(spec.variant).toBe('success');
  });

  it('shows one dominant group status with secondary counts', () => {
    const presentation = groupStatusPresentation({
      requested_sum: 100,
      approved_sum: 0,
      rejected_sum: 0,
      pending_sum: 100,
      difference: -100,
      total_rows: 8,
      approved_rows: 0,
      rejected_rows: 2,
      pending_rows: 6,
      requests_count: 2,
      modules_count: 2,
      aggregate_status: 'in_progress',
      collecting_requests: 0,
      cfo_review_requests: 0,
      cfo_review_actionable_requests: 1,
      in_approval_positions: 4,
      actionable_positions: 2,
    }, { ...baseStatus, label: 'Ожидает вашего решения' });

    expect(presentation.primary.text).toBe('Ваше решение · 3');
    expect(presentation.primary.variant).toBe('action');
    expect(presentation.meta).toContain('на доработке');
    expect(presentation.meta).toContain('в очереди');
  });
});
