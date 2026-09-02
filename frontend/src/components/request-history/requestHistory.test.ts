import { describe, expect, it } from 'vitest';
import type { RequestLog } from '../../types';
import { historyChanges, historyStatusLabel } from './requestHistory';

const entry = (changes: RequestLog['log']['changes']): RequestLog => ({
  id: 1,
  created_at: '2026-09-01T10:00:00Z',
  user: null,
  subject: null,
  log: { action: 'line_updated', entity: 'req_item', changes },
});

describe('historyChanges', () => {
  it('uses Russian labels for workflow statuses', () => {
    expect(historyStatusLabel('on_approval')).toBe('На согласовании');
  });

  it('renders month plans as a readable list instead of object stringification', () => {
    const [change] = historyChanges(entry({
      month_plans: {
        from: [{ month: 1, sum_plan: 0 }],
        to: [{ month: 1, sum_plan: 1000 }, { month: 2, sum_plan: 250 }],
      },
    }));

    expect(change.field).toBe('Помесячный план');
    expect(change.to).toContain('янв.: 1 000');
    expect(change.to).not.toContain('[object Object]');
  });

  it('never exposes a raw object in a history field', () => {
    expect(historyChanges(entry({ metadata: { from: {}, to: { internal: true } } }))).toEqual([]);
  });

  it('shows only business fields for a newly created request', () => {
    const changes = historyChanges(entry({
      id: { from: null, to: '8c48d77e-718c-4c14-a3e0-0233e181b6c6' },
      unit_id: { from: null, to: '42bd4301-b3f3-4fd1-8491-85534299bac4' },
      budget_year: { from: null, to: 2026 },
      created_at: { from: null, to: '2026-09-01T10:00:00Z' },
      status: { from: null, to: 'draft' },
    }));

    expect(changes).toEqual([{ field: 'Статус', from: '—', to: 'Черновик' }]);
  });
});
