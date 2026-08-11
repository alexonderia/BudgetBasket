import type { ApprovalRegisterGroup, ApprovalRegisterRow } from '../../types';
import { ANALYTICS_FIELD_KEYS, type AnalyticsFieldKey } from '../../utils/analyticsFields';
import { money } from '../../utils/labels';
import type { TableColumnDefinition, TableSortState } from '../../utils/tableColumns';
import {
  groupRegistryStatus,
  groupPreviousStepSummary,
  groupYourStepSummary,
  rowRegistryStatus,
  rowRejectedAmount,
  type RegistryColumnId,
} from './registryConfig';

export type RegisterControlRow =
  | { kind: 'group'; group: ApprovalRegisterGroup }
  | { kind: 'item'; item: ApprovalRegisterRow; groupId: string };

export const REGISTRY_COLUMN_MIN_WIDTHS: Record<RegistryColumnId, number> = {
  select: 40,
  structure: 220,
  requested: 100,
  approved: 100,
  rejected: 100,
  previous_step: 150,
  your_step: 190,
  status: 120,
  actions: 72,
  justification: 160,
  comment: 130,
  files: 72,
  ...ANALYTICS_FIELD_KEYS.reduce((result, key) => {
    result[key] = 120;
    return result;
  }, {} as Record<AnalyticsFieldKey, number>),
};

function groupStructureLabel(group: ApprovalRegisterGroup) {
  return `${group.name} · ${group.label}`;
}

function groupAnalyticsValue(group: ApprovalRegisterGroup, key: AnalyticsFieldKey) {
  const field = group.analytics?.fields[key];
  if (!field) return '';
  if (field.mixed) return 'Разные значения';
  return field.value;
}

function compareSortValues(
  left: string | number | boolean | null | undefined,
  right: string | number | boolean | null | undefined,
) {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (typeof left === 'boolean' && typeof right === 'boolean') return Number(left) - Number(right);
  return String(left).localeCompare(String(right), 'ru', { numeric: true, sensitivity: 'base' });
}

export const REGISTRY_TABLE_COLUMN_DEFINITIONS: TableColumnDefinition<RegisterControlRow, RegistryColumnId>[] = [
  { id: 'select', label: '', sortable: false, filterable: false, hideable: false, getValue: () => '' },
  {
    id: 'structure',
    label: 'Структура',
    getValue: (row) => (row.kind === 'group' ? groupStructureLabel(row.group) : row.item.name || '—'),
    getSortValue: (row) => (row.kind === 'group' ? row.group.name : row.item.name || ''),
  },
  {
    id: 'requested',
    label: 'Запрошено, ₽',
    getValue: (row) => money(row.kind === 'group' ? row.group.aggregates.requested_sum : row.item.requested_sum),
    getSortValue: (row) => (row.kind === 'group' ? row.group.aggregates.requested_sum : row.item.requested_sum),
  },
  {
    id: 'approved',
    label: 'Согласовано, ₽',
    getValue: (row) => {
      if (row.kind === 'group') return money(row.group.aggregates.approved_sum);
      const previous = row.item.status_context?.previous_step;
      if (previous?.amount != null) return money(previous.amount);
      return previous?.label || money(row.item.approved_sum);
    },
    getSortValue: (row) => {
      if (row.kind === 'group') return row.group.aggregates.approved_sum;
      const previous = row.item.status_context?.previous_step;
      if (previous?.amount != null) return previous.amount;
      return row.item.approved_sum;
    },
  },
  {
    id: 'rejected',
    label: 'Отклонено, ₽',
    getValue: (row) => money(row.kind === 'group' ? row.group.aggregates.rejected_sum : rowRejectedAmount(row.item)),
    getSortValue: (row) => (row.kind === 'group' ? row.group.aggregates.rejected_sum : rowRejectedAmount(row.item)),
  },
  {
    id: 'previous_step',
    label: 'Предыдущий шаг',
    getValue: (row) => (
      row.kind === 'group'
        ? groupPreviousStepSummary(row.group.aggregates)
        : row.item.status_context?.previous_step?.label || '—'
    ),
    getSortValue: (row) => (
      row.kind === 'group'
        ? groupPreviousStepSummary(row.group.aggregates)
        : row.item.status_context?.previous_step?.label || ''
    ),
  },
  {
    id: 'your_step',
    label: 'Ваше решение',
    getValue: (row) => {
      if (row.kind === 'group') return groupYourStepSummary(row.group.aggregates);
      const your = row.item.status_context?.your_step;
      if (your?.amount != null) return `${money(your.amount)} · ${your.label}`;
      return your?.label || '—';
    },
    getSortValue: (row) => (
      row.kind === 'group'
        ? groupYourStepSummary(row.group.aggregates)
        : row.item.status_context?.your_step?.label || ''
    ),
  },
  {
    id: 'status',
    label: 'Статус',
    getValue: (row) => (
      row.kind === 'group'
        ? groupRegistryStatus(row.group.aggregates).label
        : rowRegistryStatus(row.item).label
    ),
    getSortValue: (row) => (
      row.kind === 'group'
        ? row.group.aggregates.aggregate_status
        : row.item.status
    ),
  },
  {
    id: 'justification',
    label: 'Обоснование',
    getValue: (row) => (row.kind === 'group' ? '—' : row.item.justification || '—'),
    getSortValue: (row) => (row.kind === 'group' ? '' : row.item.justification || ''),
  },
  {
    id: 'comment',
    label: 'Комментарий',
    getValue: (row) => (row.kind === 'group' ? '—' : row.item.comment || '—'),
    getSortValue: (row) => (row.kind === 'group' ? '' : row.item.comment || ''),
  },
  {
    id: 'files',
    label: 'Файлы',
    sortable: false,
    getValue: (row) => (row.kind === 'group' ? '—' : String(row.item.files_count || '—')),
    getSortValue: (row) => (row.kind === 'group' ? -1 : row.item.files_count || 0),
  },
  { id: 'actions', label: 'Действия', sortable: false, filterable: false, hideable: false, getValue: () => '' },
  ...ANALYTICS_FIELD_KEYS.map((key) => ({
    id: key,
    label: `Аналитика ${key.slice(-1)}`,
    defaultVisible: false,
    getValue: (row: RegisterControlRow) => (
      row.kind === 'group' ? groupAnalyticsValue(row.group, key) || '—' : row.item[key] || '—'
    ),
    getSortValue: (row: RegisterControlRow) => (
      row.kind === 'group' ? groupAnalyticsValue(row.group, key) : row.item[key] || ''
    ),
  })),
];

const definitionsById = new Map(REGISTRY_TABLE_COLUMN_DEFINITIONS.map((column) => [column.id, column]));

export function flattenRegisterGroups(groups: ApprovalRegisterGroup[]): ApprovalRegisterGroup[] {
  return groups.flatMap((group) => [group, ...flattenRegisterGroups(group.children)]);
}

export function buildRegisterControlRows(
  groups: ApprovalRegisterGroup[],
  loadedItems: ReadonlyArray<{ item: ApprovalRegisterRow; groupId: string }>,
): RegisterControlRow[] {
  const rows: RegisterControlRow[] = flattenRegisterGroups(groups).map((group) => ({ kind: 'group', group }));
  loadedItems.forEach(({ item, groupId }) => {
    rows.push({ kind: 'item', item, groupId });
  });
  return rows;
}

export function computeRegisterVisibility(
  groups: ApprovalRegisterGroup[],
  filteredRows: RegisterControlRow[],
  hasColumnFilters: boolean,
) {
  if (!hasColumnFilters) {
    return { visibleGroupIds: null as Set<string> | null, visibleItemIds: null as Set<string> | null };
  }

  const visibleGroupIds = new Set<string>();
  const visibleItemIds = new Set<string>();
  const parentById = new Map<string, string | undefined>();

  const walkParents = (nodes: ApprovalRegisterGroup[], parentId?: string) => {
    nodes.forEach((group) => {
      parentById.set(group.id, parentId);
      walkParents(group.children, group.id);
    });
  };
  walkParents(groups);

  const includeAncestors = (groupId: string) => {
    let current: string | undefined = groupId;
    while (current) {
      visibleGroupIds.add(current);
      current = parentById.get(current);
    }
  };

  filteredRows.forEach((row) => {
    if (row.kind === 'group') {
      includeAncestors(row.group.id);
      return;
    }
    visibleItemIds.add(row.item.id);
    includeAncestors(row.groupId);
  });

  return { visibleGroupIds, visibleItemIds };
}

export function filterRegisterGroups(
  groups: ApprovalRegisterGroup[],
  visibleGroupIds: Set<string> | null,
): ApprovalRegisterGroup[] {
  if (!visibleGroupIds) return groups;
  return groups.flatMap((group) => {
    const children = filterRegisterGroups(group.children, visibleGroupIds);
    if (!visibleGroupIds.has(group.id) && !children.length) return [];
    return [{ ...group, children }];
  });
}

export function sortRegisterGroups(
  groups: ApprovalRegisterGroup[],
  sort: TableSortState<RegistryColumnId> | null,
): ApprovalRegisterGroup[] {
  if (!sort) return groups;
  const column = definitionsById.get(sort.column);
  if (!column || column.sortable === false) return groups;

  const sorted = [...groups].sort((left, right) => {
    const leftRow: RegisterControlRow = { kind: 'group', group: left };
    const rightRow: RegisterControlRow = { kind: 'group', group: right };
    const leftValue = column.getSortValue ? column.getSortValue(leftRow) : column.getValue(leftRow);
    const rightValue = column.getSortValue ? column.getSortValue(rightRow) : column.getValue(rightRow);
    const result = compareSortValues(
      leftValue as string | number | boolean | null | undefined,
      rightValue as string | number | boolean | null | undefined,
    );
    return sort.direction === 'asc' ? result : -result;
  });

  return sorted.map((group) => ({
    ...group,
    children: sortRegisterGroups(group.children, sort),
  }));
}

export function sortRegisterItems(
  items: ApprovalRegisterRow[],
  sort: TableSortState<RegistryColumnId> | null,
): ApprovalRegisterRow[] {
  if (!sort) return items;
  const column = definitionsById.get(sort.column);
  if (!column || column.sortable === false) return items;

  return [...items].sort((left, right) => {
    const leftRow: RegisterControlRow = { kind: 'item', item: left, groupId: '' };
    const rightRow: RegisterControlRow = { kind: 'item', item: right, groupId: '' };
    const leftValue = column.getSortValue ? column.getSortValue(leftRow) : column.getValue(leftRow);
    const rightValue = column.getSortValue ? column.getSortValue(rightRow) : column.getValue(rightRow);
    const result = compareSortValues(
      leftValue as string | number | boolean | null | undefined,
      rightValue as string | number | boolean | null | undefined,
    );
    return sort.direction === 'asc' ? result : -result;
  });
}

export function getRegisterAutoFitValues(
  rows: RegisterControlRow[],
  columnId: RegistryColumnId,
) {
  const column = definitionsById.get(columnId);
  if (!column) return [];
  return rows.map((row) => String(column.getValue(row)));
}
