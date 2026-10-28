import { describe, expect, it } from 'vitest';
import { parseForwardBlockingRequests } from './forwardErrors';

describe('forward blocking errors', () => {
  it('parses concrete blockers from the transfer error detail', () => {
    const result = parseForwardBlockingRequests({
      reason: 'cfo_review_incomplete',
      blocking_requests: [
        {
          request_id: 'request-1',
          module_id: 'module-1',
          module_name: 'M-1',
          reason: 'pending_decisions',
          message: '2 строк без решения',
          pending_count: 2,
          pending_items: [
            { id: 'item-1', name: 'Кресла', status: 'on_review' },
            { id: 'item-2', name: 'Столы', status: 'on_review' },
          ],
        },
      ],
    });
    expect(result).toHaveLength(1);
    expect(result[0].module_name).toBe('M-1');
    expect(result[0].reason).toBe('pending_decisions');
    expect(result[0].pending_items.map((item) => item.name)).toEqual(['Кресла', 'Столы']);
  });

  it('returns an empty list for old errors without blocking_requests', () => {
    expect(parseForwardBlockingRequests({ message: 'Передача невозможна' })).toEqual([]);
    expect(parseForwardBlockingRequests(null)).toEqual([]);
  });
});
