import { describe, expect, it } from 'vitest';
import type { RequestLog } from '../../types';
import { historyChanges } from './requestHistory';

const entry = (changes: RequestLog['log']['changes']): RequestLog => ({
  id: 1,
  created_at: '2026-09-01T10:00:00Z',
  user: null,
  subject: null,
  log: { action: 'line_updated', entity: 'req_item', changes },
});

describe('historyChanges', () => {
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
    const [change] = historyChanges(entry({ metadata: { from: {}, to: { internal: true } } }));

    expect(change.from).toBe('Указано значение');
    expect(change.to).toBe('Указано значение');
  });
});
