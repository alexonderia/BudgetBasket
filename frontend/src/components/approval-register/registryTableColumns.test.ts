import { describe, expect, it } from 'vitest';
import type { ApprovalRegisterGroup, ApprovalRegisterRow } from '../../types';
import {
  buildRegisterControlRows,
  computeRegisterVisibility,
  filterRegisterGroups,
  sortRegisterGroups,
  sortRegisterItems,
} from './registryTableColumns';

const baseAggregates = {
  requested_sum: 100,
  approved_sum: 50,
  rejected_sum: 0,
  pending_sum: 50,
  difference: -50,
  total_rows: 2,
  approved_rows: 1,
  rejected_rows: 0,
  pending_rows: 1,
  requests_count: 1,
  modules_count: 1,
  aggregate_status: 'in_progress' as const,
  collecting_requests: 0,
  cfo_review_requests: 1,
  cfo_review_actionable_requests: 1,
  in_approval_positions: 0,
  actionable_positions: 0,
};

function makeGroup(id: string, name: string, children: ApprovalRegisterGroup[] = []): ApprovalRegisterGroup {
  return {
    id,
    type: 'article',
    name,
    label: 'Статья',
    module_id: 'module-1',
    article_id: id,
    category_id: 'category-1',
    request_ids: ['request-1'],
    aggregates: baseAggregates,
    children,
    can_load_rows: false,
  };
}

function makeItem(id: string, name: string): ApprovalRegisterRow {
  return {
    id,
    request_id: 'request-1',
    request_status: 'on_review',
    budget_year: 2026,
    module_id: 'module-1',
    module_name: 'Модуль',
    cfo_id: 'cfo-1',
    cfo_name: 'ЦФО',
    category_id: 'category-1',
    category_name: 'Категория',
    article_id: 'article-1',
    article_name: 'Статья',
    kind: 'dds',
    name,
    justification: '',
    comment: '',
    files_count: 0,
    requested_sum: 10,
    approved_sum: 0,
    status: 'on_review',
    updated_at: '2026-08-07T10:00:00Z',
    is_collecting: false,
    is_cfo_review: true,
    is_cfo_review_actionable: true,
    position_id: null,
    is_in_approval: false,
    is_approval_actionable: false,
    approval_stage: null,
    frozen: false,
    fixed: false,
    analytics_1: '',
    analytics_2: '',
    analytics_3: '',
    analytics_4: '',
    analytics_5: '',
  };
}

describe('registryTableColumns', () => {
  it('sorts groups and items by structure ascending', () => {
    const groups = [makeGroup('article:b', 'Бета'), makeGroup('article:a', 'Альфа')];
    const sorted = sortRegisterGroups(groups, { column: 'structure', direction: 'asc' });
    expect(sorted.map((group) => group.name)).toEqual(['Альфа', 'Бета']);
  });

  it('filters groups by column visibility and keeps ancestors', () => {
    const child = makeGroup('article:child', 'Дочерняя');
    const parent = makeGroup('article:parent', 'Родитель', [child]);
    const groups = [parent];
    const rows = buildRegisterControlRows(groups, [{ item: makeItem('line-1', 'Нужная строка'), groupId: child.id }]);
    const { visibleGroupIds, visibleItemIds } = computeRegisterVisibility(groups, rows.filter((row) => row.kind === 'item'), true);
    expect(visibleItemIds?.has('line-1')).toBe(true);
    expect(visibleGroupIds?.has(parent.id)).toBe(true);
    expect(visibleGroupIds?.has(child.id)).toBe(true);
    const filtered = filterRegisterGroups(groups, visibleGroupIds);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].children).toHaveLength(1);
  });

  it('sorts item rows by requested sum', () => {
    const items = [makeItem('1', 'A'), makeItem('2', 'B')];
    items[0].requested_sum = 20;
    items[1].requested_sum = 5;
    const sorted = sortRegisterItems(items, { column: 'requested', direction: 'asc' });
    expect(sorted.map((item) => item.id)).toEqual(['2', '1']);
  });
});
