import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import CancelOutlinedIcon from '@mui/icons-material/CancelOutlined';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import SearchIcon from '@mui/icons-material/Search';
import UnfoldLessIcon from '@mui/icons-material/UnfoldLess';
import UnfoldMoreIcon from '@mui/icons-material/UnfoldMore';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Pagination from '@mui/material/Pagination';
import Paper from '@mui/material/Paper';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { api } from '../api/client';
import { usePageChromeActions, usePageChromeLeading } from './Layout';
import { ItemStatusBadge } from './StatusBadge';
import { ConfirmDialog } from './ConfirmDialog';
import { TableColumnResizeHandle, TableColumnTools } from './TableColumnControls';
import {
  AGGREGATE_DISPLAY_LABELS,
  DEFAULT_COLUMN_VISIBILITY,
  DEFAULT_COLUMN_ORDER,
  DEFAULT_COLUMN_WIDTHS,
  groupReadinessPercent,
  isRowActionable,
  parseMoneyInput,
  REGISTRY_COLUMNS,
  REGISTRY_VIEW_LABELS,
  orderedRegistryColumns,
  rowRejectedAmount,
  STATUS_LABELS,
  toMoneyInput,
  type RegistryColumnId,
  type RegistryFilters,
  type RegistryView,
} from './approval-register/registryConfig';
import type { ApprovalRegisterGroup, ApprovalRegisterResponse, ApprovalRegisterRow, ApprovalRegisterRowsResponse, BudgetItem, FileAttachment, ItemStatus, RegisterAggregates, User } from '../types';
import { money } from '../utils/labels';
import { filterFieldSx } from '../utils/responsive';

const PREFERENCES_KEY = 'budgetbasket:approval-register:preferences';
const LEGACY_COLUMNS_KEY = 'budgetbasket:approval-register:columns';
const REQUEST_PAGE_SIZE_KEY = 'budgetbasket:register:request-page-size';
const EMPTY_FILTERS: RegistryFilters = { search: '', status: '', budgetYear: '' };

type RowDecision = 'approved' | 'approved_with_changes' | 'rejected';
type DecisionTarget = { rows: ApprovalRegisterRow[]; decision: RowDecision; amount?: number };
type RowLog = { id: number; created_at: string; action?: string; log?: { action?: string } };

function groupEntityId(group: ApprovalRegisterGroup) {
  const segment = group.id.split('/').at(-1) || '';
  const prefix = `${group.type}:`;
  return segment.startsWith(prefix) ? segment.slice(prefix.length) : '';
}

function readPreferences(): { view?: RegistryView; filters?: RegistryFilters; order: RegistryColumnId[]; visibility: Record<RegistryColumnId, boolean>; widths: Record<RegistryColumnId, number> } {
  try {
    const raw = localStorage.getItem(PREFERENCES_KEY);
    const legacyRaw = localStorage.getItem(LEGACY_COLUMNS_KEY);
    if (!raw && !legacyRaw) return { order: DEFAULT_COLUMN_ORDER, visibility: DEFAULT_COLUMN_VISIBILITY, widths: DEFAULT_COLUMN_WIDTHS };
    const parsed: unknown = JSON.parse(raw || legacyRaw || '');
    if (!parsed || typeof parsed !== 'object') return { order: DEFAULT_COLUMN_ORDER, visibility: DEFAULT_COLUMN_VISIBILITY, widths: DEFAULT_COLUMN_WIDTHS };
    const value = parsed as { view?: RegistryView; filters?: Partial<RegistryFilters>; order?: RegistryColumnId[]; visibility?: Partial<Record<RegistryColumnId, boolean>>; widths?: Partial<Record<RegistryColumnId, number>> };
    return {
      view: value.view,
      filters: value.filters ? { ...EMPTY_FILTERS, ...value.filters } : undefined,
      order: value.order?.filter((id): id is RegistryColumnId => DEFAULT_COLUMN_ORDER.includes(id)) || DEFAULT_COLUMN_ORDER,
      visibility: { ...DEFAULT_COLUMN_VISIBILITY, ...value.visibility },
      widths: { ...DEFAULT_COLUMN_WIDTHS, ...value.widths },
    };
  } catch {
    return { order: DEFAULT_COLUMN_ORDER, visibility: DEFAULT_COLUMN_VISIBILITY, widths: DEFAULT_COLUMN_WIDTHS };
  }
}

function rejectedMoney(value: number) {
  if (!value) return money(0);
  return money(-Math.abs(value));
}

const REGISTRY_FILTER_SX = {
  '& .MuiInputBase-root': { height: 34, fontSize: 13 },
  '& .MuiInputLabel-root': { fontSize: 13, transform: 'translate(14px, 8px) scale(1)' },
  '& .MuiInputLabel-shrink': { transform: 'translate(14px, -7px) scale(0.78)' },
  '& .MuiSelect-select, & .MuiInputBase-input': { py: '6px !important' },
};

function RegistryStatusLegend({ compact = false }: { compact?: boolean }) {
  const items = [
    { color: '#059669', label: 'Согласовано' },
    { color: '#DC2626', label: 'Отклонено' },
    { color: '#D97706', label: 'На рассмотрении' },
    { color: '#94A3B8', label: 'Черновик' },
  ];
  return (
    <Stack direction="row" spacing={compact ? 1 : 1.5} flexWrap="wrap" useFlexGap alignItems="center">
      {items.map((item) => (
        <Stack key={item.label} direction="row" spacing={0.5} alignItems="center">
          <Box sx={{ width: compact ? 7 : 8, height: compact ? 7 : 8, borderRadius: '50%', bgcolor: item.color }} />
          <Typography variant="caption" color="text.secondary" sx={{ fontSize: compact ? 11 : 12, lineHeight: 1.2 }}>{item.label}</Typography>
        </Stack>
      ))}
    </Stack>
  );
}

function CompactStatusChip({ label, color }: { label: string; color: 'success' | 'error' | 'warning' | 'default' }) {
  return (
    <Chip
      size="small"
      variant="outlined"
      label={label}
      color={color}
      sx={{ height: 22, fontSize: 11, fontWeight: 600, '& .MuiChip-label': { px: 0.85, py: 0 } }}
    />
  );
}

function aggregateStatus(aggregates: RegisterAggregates) {
  if (!aggregates.total_rows) return 'no_data' as const;
  if (aggregates.approved_rows === aggregates.total_rows) return 'approved' as const;
  if (aggregates.rejected_rows === aggregates.total_rows) return 'rejected' as const;
  if (!aggregates.pending_rows) return 'partially_approved' as const;
  if (!aggregates.approved_rows && !aggregates.rejected_rows) return 'on_review' as const;
  return 'in_progress' as const;
}

function applyItemChange(aggregates: RegisterAggregates, previous: ApprovalRegisterRow, next: Pick<BudgetItem, 'status' | 'sum_fact'>): RegisterAggregates {
  const wasApproved = previous.status === 'approved' || previous.status === 'approved_with_changes';
  const wasRejected = previous.status === 'rejected';
  const approved = next.status === 'approved' || next.status === 'approved_with_changes';
  const rejected = next.status === 'rejected';
  const approvedRows = aggregates.approved_rows + Number(approved) - Number(wasApproved);
  const rejectedRows = aggregates.rejected_rows + Number(rejected) - Number(wasRejected);
  const approvedSum = aggregates.approved_sum - previous.approved_sum + (approved ? Number(next.sum_fact || 0) : 0);
  const updated = {
    ...aggregates,
    approved_rows: approvedRows,
    rejected_rows: rejectedRows,
    pending_rows: aggregates.total_rows - approvedRows - rejectedRows,
    approved_sum: approvedSum,
    rejected_sum: aggregates.rejected_sum - (wasRejected ? previous.requested_sum : 0) + (rejected ? previous.requested_sum : 0),
    pending_sum: aggregates.pending_sum - (!wasApproved && !wasRejected ? previous.requested_sum : 0) + (!approved && !rejected ? previous.requested_sum : 0),
    difference: approvedSum - aggregates.requested_sum,
  };
  return { ...updated, aggregate_status: aggregateStatus(updated) };
}

function updateRegisterCache(queryClient: ReturnType<typeof useQueryClient>, previous: ApprovalRegisterRow, next: Pick<BudgetItem, 'status' | 'sum_fact'>) {
  queryClient.setQueriesData<ApprovalRegisterRowsResponse>({ queryKey: ['approval-register-rows'] }, (current) => {
    if (!current) return current;
    return {
      ...current,
      items: current.items.map((item) => item.id === previous.id
        ? { ...item, status: next.status, approved_sum: next.status === 'approved' || next.status === 'approved_with_changes' ? Number(next.sum_fact || 0) : 0 }
        : item),
      group: { ...current.group, aggregates: applyItemChange(current.group.aggregates, previous, next) },
    };
  });
  queryClient.setQueriesData<ApprovalRegisterResponse>({ queryKey: ['approval-register'] }, (current) => {
    if (!current) return current;
    const updateGroups = (groups: ApprovalRegisterGroup[]): ApprovalRegisterGroup[] => groups.map((group) => {
      const includesItem = group.module_id === previous.module_id && group.request_ids.includes(previous.request_id);
      return {
        ...group,
        aggregates: includesItem ? applyItemChange(group.aggregates, previous, next) : group.aggregates,
        children: updateGroups(group.children),
      };
    });
    return { ...current, aggregates: applyItemChange(current.aggregates, previous, next), groups: updateGroups(current.groups) };
  });
}

function RegistryFilterBar({
  view,
  filters,
  onViewChange,
  onChange,
  onReset,
  onExport,
  columnTools,
  availableViews,
}: {
  view: RegistryView;
  filters: RegistryFilters;
  onViewChange: (view: RegistryView) => void;
  onChange: (next: RegistryFilters) => void;
  onReset: () => void;
  onExport: () => void;
  columnTools: React.ReactNode;
  availableViews: RegistryView[];
}) {
  const hasActiveFilters = Boolean(filters.search || filters.status || filters.budgetYear);
  return (
    <Paper variant="outlined" className="approval-register-filters" sx={{ px: 1, py: 0.75, borderColor: 'rgba(15, 23, 42, 0.08)', borderRadius: 1.5, bgcolor: '#F8FAFC' }}>
      <Stack direction={{ xs: 'column', xl: 'row' }} spacing={0.75} alignItems={{ xl: 'center' }} justifyContent="space-between">
        <Stack direction={{ xs: 'column', lg: 'row' }} spacing={0.75} useFlexGap sx={{ flex: 1, minWidth: 0, ...REGISTRY_FILTER_SX }}>
          <TextField select size="small" value={view} onChange={(event) => onViewChange(event.target.value as RegistryView)} sx={{ ...filterFieldSx(128), maxWidth: { lg: 128 } }}>
            {availableViews.map((key) => <MenuItem key={key} value={key} dense>{REGISTRY_VIEW_LABELS[key]}</MenuItem>)}
          </TextField>
          <TextField
            size="small"
            placeholder="Поиск по строке, статье, модулю или заявке"
            value={filters.search}
            onChange={(event) => onChange({ ...filters, search: event.target.value })}
            sx={{ minWidth: { md: 220 }, flex: { lg: '1 1 260px' } }}
            InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon sx={{ fontSize: 18 }} color="action" /></InputAdornment> }}
          />
          <TextField select size="small" label="Статус строки" value={filters.status} onChange={(event) => onChange({ ...filters, status: event.target.value as RegistryFilters['status'] })} sx={{ ...filterFieldSx(150), maxWidth: { lg: 150 } }}>
            <MenuItem value="" dense>Все</MenuItem>
            {(Object.keys(STATUS_LABELS) as ItemStatus[]).map((status) => <MenuItem key={status} value={status} dense>{STATUS_LABELS[status]}</MenuItem>)}
          </TextField>
          <TextField size="small" label="Бюджетный год" type="number" placeholder="2025" value={filters.budgetYear} onChange={(event) => onChange({ ...filters, budgetYear: event.target.value })} sx={{ ...filterFieldSx(118), maxWidth: { lg: 118 } }} />
          <Button size="small" variant="text" color="inherit" startIcon={<RestartAltIcon sx={{ fontSize: 18 }} />} onClick={onReset} sx={{ minWidth: 0, px: 1, fontSize: 13, whiteSpace: 'nowrap' }}>
            Сбросить
          </Button>
        </Stack>
        <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap justifyContent={{ xs: 'flex-start', xl: 'flex-end' }} alignItems="center" sx={{ '& .MuiButton-root': { height: 34, minHeight: 34, fontSize: 13, px: 1.25 } }}>
          <Button size="small" variant="outlined" color="inherit" startIcon={<FileDownloadOutlinedIcon sx={{ fontSize: 18 }} />} endIcon={<ArrowDropDownIcon sx={{ fontSize: 18 }} />} onClick={onExport}>
            Экспорт
          </Button>
          {columnTools}
        </Stack>
      </Stack>
      {hasActiveFilters ? (
        <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ pt: 0.75 }}>
          {filters.search ? <Chip label={`Поиск: ${filters.search}`} size="small" variant="outlined" sx={{ height: 22, fontSize: 11 }} /> : null}
          {filters.status ? <Chip label={`Статус: ${STATUS_LABELS[filters.status]}`} size="small" variant="outlined" sx={{ height: 22, fontSize: 11 }} /> : null}
          {filters.budgetYear ? <Chip label={`Год: ${filters.budgetYear}`} size="small" variant="outlined" sx={{ height: 22, fontSize: 11 }} /> : null}
        </Stack>
      ) : null}
    </Paper>
  );
}

function RegistrySummary({ aggregates }: { aggregates: RegisterAggregates }) {
  const readiness = groupReadinessPercent(aggregates);
  const metrics = [
    { label: 'Всего строк', value: String(aggregates.total_rows), tone: 'default' as const },
    { label: 'Запрошено', value: money(aggregates.requested_sum), tone: 'default' as const },
    { label: 'Согласовано', value: money(aggregates.approved_sum), tone: 'default' as const },
    { label: 'Отклонено', value: rejectedMoney(aggregates.rejected_sum), tone: 'danger' as const },
    { label: 'На рассмотрении', value: money(aggregates.pending_sum), tone: 'default' as const },
  ];
  return (
    <Paper variant="outlined" className="approval-register-summary" sx={{ borderColor: 'rgba(15, 23, 42, 0.08)', borderRadius: 1.5, overflow: 'hidden', bgcolor: '#fff' }}>
      <Stack direction={{ xs: 'column', md: 'row' }} alignItems="stretch">
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(3, minmax(0, 1fr))', lg: 'repeat(5, minmax(0, 1fr))' }, flex: 1 }}>
          {metrics.map((metric) => (
            <Box key={metric.label} sx={{ px: 1.5, py: 0.85, borderRight: { md: '1px solid rgba(15, 23, 42, 0.06)' }, borderBottom: { xs: '1px solid rgba(15, 23, 42, 0.06)', md: 0 } }}>
              <Typography variant="caption" color="text.secondary" sx={{ fontSize: 11, lineHeight: 1.2 }}>{metric.label}</Typography>
              <Typography variant="body2" fontWeight={700} noWrap title={metric.value} sx={{ mt: 0.15, fontSize: 14, color: metric.tone === 'danger' ? 'error.main' : 'text.primary' }}>
                {metric.value}
              </Typography>
            </Box>
          ))}
        </Box>
        <Stack direction="row" spacing={1} alignItems="center" justifyContent="center" sx={{ px: 1.75, py: 0.85, minWidth: { md: 132 }, borderTop: { xs: '1px solid rgba(15, 23, 42, 0.06)', md: 0 }, borderLeft: { md: '1px solid rgba(15, 23, 42, 0.06)' } }}>
          <Box sx={{ position: 'relative', display: 'inline-flex' }}>
            <CircularProgress variant="determinate" value={readiness} size={46} thickness={4.5} sx={{ color: readiness >= 70 ? '#059669' : '#D97706' }} />
            <Box sx={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Typography variant="caption" fontWeight={700} sx={{ fontSize: 11 }}>{readiness}%</Typography>
            </Box>
          </Box>
          <Typography variant="caption" color="text.secondary" fontWeight={600} sx={{ fontSize: 11, maxWidth: 72, lineHeight: 1.25 }}>Статусы</Typography>
        </Stack>
      </Stack>
    </Paper>
  );
}

function RegistryFooter({ totalRows }: { totalRows: number }) {
  return (
    <Paper variant="outlined" className="approval-register-footer" sx={{ px: 1.25, py: 0.65, borderColor: 'rgba(15, 23, 42, 0.08)', borderRadius: 1.5, bgcolor: '#fff' }}>
      <Stack direction={{ xs: 'column', lg: 'row' }} spacing={0.75} alignItems={{ lg: 'center' }} justifyContent="space-between">
        <Typography variant="caption" color="text.secondary" sx={{ fontSize: 12 }}>
          Всего строк: {totalRows}
        </Typography>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }} justifyContent="flex-end">
          <RegistryStatusLegend compact />
        </Stack>
      </Stack>
    </Paper>
  );
}

function EditableMoneyCell({ item, active, onCommit }: { item: ApprovalRegisterRow; active: boolean; onCommit: (amount: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(() => toMoneyInput(item.approved_sum));
  useEffect(() => { if (!editing) setValue(toMoneyInput(item.approved_sum)); }, [editing, item.approved_sum]);
  const save = () => {
    const amount = parseMoneyInput(value);
    if (amount === null || amount > item.requested_sum) return;
    setEditing(false);
    onCommit(amount);
  };
  if (!active) return <Typography variant="body2" sx={{ fontSize: 13 }}>{money(item.approved_sum)}</Typography>;
  if (!editing) return <Box component="button" type="button" onDoubleClick={() => setEditing(true)} onKeyDown={(event) => { if (event.key === 'Enter') setEditing(true); }} sx={{ border: 0, bgcolor: 'transparent', font: 'inherit', fontSize: 13, cursor: 'text', p: 0, textAlign: 'right', width: '100%' }} title="Дважды щёлкните, чтобы изменить сумму">{money(item.approved_sum)}</Box>;
  return <TextField autoFocus size="small" value={value} onChange={(event) => setValue(event.target.value)} error={parseMoneyInput(value) === null || (parseMoneyInput(value) || 0) > item.requested_sum} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); save(); } if (event.key === 'Escape') { setValue(toMoneyInput(item.approved_sum)); setEditing(false); } }} onBlur={save} inputProps={{ inputMode: 'decimal', 'aria-label': 'Согласованная сумма' }} sx={{ width: '100%', '& .MuiInputBase-input': { py: 0.2, px: 0.75, fontSize: 13, textAlign: 'right' } }} />;
}

function DecisionDialog({ target, onClose, onSave, saving, error }: { target: DecisionTarget | null; onClose: () => void; onSave: (comment: string, amount?: number) => void; saving: boolean; error: string | null }) {
  const [comment, setComment] = useState('');
  const [amount, setAmount] = useState('');
  useEffect(() => { setComment(''); setAmount(target?.amount === undefined ? '' : toMoneyInput(target.amount)); }, [target]);
  if (!target) return null;
  const requiresComment = target.decision !== 'approved';
  const adjustedAmount = target.decision === 'approved_with_changes' ? parseMoneyInput(amount) : undefined;
  const title = target.decision === 'rejected' ? 'Отправить на доработку' : target.decision === 'approved_with_changes' ? 'Согласовать с корректировкой' : 'Согласовать строки';
  return <Dialog open onClose={saving ? undefined : onClose} fullWidth maxWidth="xs"><DialogTitle>{title}</DialogTitle><DialogContent><Stack spacing={1.5} sx={{ pt: 1 }}>
    <Typography variant="body2" color="text.secondary">Будет обработано строк: {target.rows.length} · запрошено: {money(target.rows.reduce((total, row) => total + row.requested_sum, 0))}</Typography>
    {target.decision === 'approved_with_changes' && <TextField autoFocus size="small" label="Согласованная сумма" value={amount} onChange={(event) => setAmount(event.target.value)} error={adjustedAmount === null || (adjustedAmount || 0) > target.rows[0].requested_sum} helperText="Не больше запрошенной суммы" />}
    <TextField size="small" label={requiresComment ? 'Комментарий' : 'Комментарий (необязательно)'} required={requiresComment} multiline minRows={3} value={comment} onChange={(event) => setComment(event.target.value)} />
    {error && <Alert severity="error">{error}</Alert>}
  </Stack></DialogContent><DialogActions><Button onClick={onClose} disabled={saving}>Отмена</Button><Button variant="contained" disabled={saving || (requiresComment && !comment.trim()) || (target.decision === 'approved_with_changes' && (adjustedAmount === null || adjustedAmount === undefined || adjustedAmount > target.rows[0].requested_sum))} onClick={() => onSave(comment.trim(), adjustedAmount ?? undefined)}>{saving ? 'Сохраняется…' : 'Подтвердить'}</Button></DialogActions></Dialog>;
}

function RegistryDetailsDrawer({ item, onClose }: { item: ApprovalRegisterRow | null; onClose: () => void }) {
  const { data: files = [] } = useQuery({ queryKey: ['registry-item-files', item?.id], queryFn: async () => (await api.get<FileAttachment[]>(`/items/${item!.id}/files`)).data, enabled: !!item });
  const { data: logs = [] } = useQuery({ queryKey: ['registry-request-logs', item?.request_id], queryFn: async () => (await api.get<RowLog[]>(`/requests/${item!.request_id}/logs`)).data, enabled: !!item });
  return <Drawer anchor="right" open={!!item} onClose={onClose} PaperProps={{ sx: { width: { xs: '100%', sm: 460 }, p: 2.5 } }}>
    {item && <Stack spacing={2}><Box><Typography variant="h6">{item.name}</Typography><Typography variant="body2" color="text.secondary">Заявка №{item.request_id.slice(0, 8)}</Typography></Box><Divider />
      {[['ЦФО', item.cfo_name], ['Статья', item.article_name], ['Категория', item.category_name], ['Модуль', item.module_name], ['Запрошено', money(item.requested_sum)], ['Согласовано', money(item.approved_sum)], ['Статус', STATUS_LABELS[item.status]], ['Обоснование', item.justification || '—'], ['Комментарий экономиста', item.comment || '—']].map(([label, value]) => <Box key={label}><Typography variant="caption" color="text.secondary">{label}</Typography><Typography variant="body2">{value}</Typography></Box>)}
      <Box><Typography variant="subtitle2">Прикреплённые файлы</Typography>{files.length ? files.map((file) => <Typography key={file.id} variant="body2">{file.original_name}</Typography>) : <Typography variant="body2" color="text.secondary">Нет файлов</Typography>}</Box>
      <Box><Typography variant="subtitle2">История изменений</Typography>{logs.length ? logs.slice(0, 8).map((log) => <Typography key={log.id} variant="body2" color="text.secondary">{new Date(log.created_at).toLocaleString('ru-RU')} · {log.log?.action || log.action || 'Изменение заявки'}</Typography>) : <Typography variant="body2" color="text.secondary">История пока пуста</Typography>}</Box>
      <Button component="a" href={`/requests/${item.request_id}?article_id=${encodeURIComponent(item.article_id)}&category_id=${encodeURIComponent(item.category_id)}`} target="_blank" rel="noopener noreferrer" variant="outlined" startIcon={<OpenInNewIcon />}>Открыть заявку</Button>
    </Stack>}
  </Drawer>;
}

function RowActions({ item, onDecision, onOpen }: { item: ApprovalRegisterRow; onDecision: (target: DecisionTarget) => void; onOpen: () => void }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const actionable = isRowActionable(item);
  const approve = () => onDecision({ rows: [item], decision: 'approved' });
  const reject = () => onDecision({ rows: [item], decision: 'rejected' });
  return <Stack direction="row" spacing={0} justifyContent="flex-end" sx={{ '& .MuiIconButton-root': { p: 0.35 } }}><Tooltip title="Открыть подробнее"><IconButton size="small" onClick={onOpen}><OpenInNewIcon sx={{ fontSize: 17 }} /></IconButton></Tooltip>{actionable && <><Tooltip title="Согласовать"><IconButton size="small" color="success" onClick={approve}><CheckCircleOutlineIcon sx={{ fontSize: 17 }} /></IconButton></Tooltip><Tooltip title="Отправить на доработку"><IconButton size="small" color="error" onClick={reject}><CancelOutlinedIcon sx={{ fontSize: 17 }} /></IconButton></Tooltip><IconButton size="small" onClick={(event) => setAnchor(event.currentTarget)} aria-label="Дополнительные действия"><MoreVertIcon sx={{ fontSize: 17 }} /></IconButton><Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)}><MenuItem dense onClick={() => { setAnchor(null); onDecision({ rows: [item], decision: 'approved_with_changes', amount: item.approved_sum || item.requested_sum }); }}>Согласовать с корректировкой</MenuItem><MenuItem dense onClick={() => { setAnchor(null); onOpen(); }}>Открыть подробнее</MenuItem></Menu></>}</Stack>;
}

function RegistryRowCells({ item, columns, widths, selected, active, onSelect, onActive, onDecision, onOpen }: { item: ApprovalRegisterRow; columns: typeof REGISTRY_COLUMNS; widths: Record<RegistryColumnId, number>; selected: boolean; active: boolean; onSelect: (checked: boolean) => void; onActive: () => void; onDecision: (target: DecisionTarget) => void; onOpen: () => void }) {
  const actionEnabled = isRowActionable(item);
  const commitAmount = (amount: number) => onDecision({ rows: [item], decision: amount === item.requested_sum ? 'approved' : 'approved_with_changes', amount });
  const cellTextSx = { fontSize: 13, lineHeight: 1.25 };
  const cells: Partial<Record<RegistryColumnId, React.ReactNode>> = {
    select: <Checkbox size="small" checked={selected} disabled={!item.is_cfo_review_actionable} onChange={(_, checked) => onSelect(checked)} sx={{ p: 0.35 }} inputProps={{ 'aria-label': `Выбрать ${item.name}` }} />,
    structure: <Typography variant="body2" title={item.name} noWrap sx={{ ...cellTextSx, fontWeight: 500 }}>{item.name}</Typography>,
    requested: <Typography variant="body2" sx={cellTextSx}>{money(item.requested_sum)}</Typography>,
    approved: <EditableMoneyCell item={item} active={actionEnabled} onCommit={commitAmount} />,
    rejected: <Typography variant="body2" sx={{ ...cellTextSx, color: rowRejectedAmount(item) ? 'error.main' : 'inherit' }}>{rejectedMoney(rowRejectedAmount(item))}</Typography>,
    status: <Box sx={{ '& .MuiChip-root': { height: 22, fontSize: 11, fontWeight: 600, '& .MuiChip-label': { px: 0.85 } } }}><ItemStatusBadge status={item.status} /></Box>,
    justification: <Typography variant="body2" noWrap title={item.justification || '—'} sx={cellTextSx}>{item.justification || '—'}</Typography>,
    comment: <Typography variant="body2" noWrap title={item.comment || '—'} sx={cellTextSx}>{item.comment || '—'}</Typography>,
    files: <Typography variant="body2" align="center" sx={cellTextSx}>{item.files_count || '—'}</Typography>,
    actions: <RowActions item={item} onDecision={onDecision} onOpen={onOpen} />,
  };
  return <TableRow hover selected={active} tabIndex={0} onClick={onActive} onDoubleClick={onOpen} onKeyDown={(event) => { if (event.key === 'Enter') onOpen(); if (event.key.toLocaleLowerCase('ru-RU') === 'с' && actionEnabled) onDecision({ rows: [item], decision: 'approved' }); }} className="approval-register-row approval-register-row--item" sx={{ '& td': { py: 0.2, px: 0.75, height: 36, bgcolor: '#fff' }, '&.Mui-selected td': { bgcolor: '#edf5ff' }, '&:hover td': { bgcolor: '#f7fbff' } }}>
    {columns.map((column) => {
      const fixed = column.id === 'select' || column.id === 'structure';
      const align = ['requested', 'approved', 'rejected'].includes(column.id) ? 'right' : ['select', 'files'].includes(column.id) ? 'center' : 'left';
      return <TableCell key={column.id} align={align} sx={{ width: widths[column.id], minWidth: widths[column.id], maxWidth: widths[column.id], overflow: 'hidden', position: fixed ? 'sticky' : 'static', left: column.id === 'structure' ? widths.select : 0, zIndex: fixed ? 2 : 0, bgcolor: '#fff !important', borderRight: '1px solid', borderColor: 'rgba(15, 23, 42, 0.06)', fontSize: 13 }}>{cells[column.id]}</TableCell>;
    })}
  </TableRow>;
}

function RegisterRows({ group, expanded, filters, columns, widths, selectedIds, activeId, onToggleSelected, onActive, onDecision, onOpen, onItems, requestId }: { group: ApprovalRegisterGroup; expanded: boolean; filters: RegistryFilters; columns: typeof REGISTRY_COLUMNS; widths: Record<RegistryColumnId, number>; selectedIds: Set<string>; activeId: string | null; onToggleSelected: (item: ApprovalRegisterRow, checked: boolean) => void; onActive: (item: ApprovalRegisterRow) => void; onDecision: (target: DecisionTarget) => void; onOpen: (item: ApprovalRegisterRow) => void; onItems: (items: ApprovalRegisterRow[]) => void; requestId?: string }) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(() => Number(sessionStorage.getItem(REQUEST_PAGE_SIZE_KEY)) || 50);
  useEffect(() => { setPage(1); }, [group.id, filters.status, filters.budgetYear, filters.search]);
  const { data, isFetching, error } = useQuery({
    queryKey: ['approval-register-rows', group.id, group.module_id, group.article_id, group.category_id, requestId, page, pageSize, filters],
    queryFn: async ({ signal }) => (await api.get<ApprovalRegisterRowsResponse>('/approval-register/rows', {
      params: {
        module_id: group.module_id,
        article_id: group.article_id,
        category_id: group.category_id,
        request_id: requestId,
        page,
        page_size: pageSize,
        status: filters.status || undefined,
        budget_year: filters.budgetYear || undefined,
        search: filters.search || undefined,
      },
      signal,
    })).data,
    enabled: expanded,
    placeholderData: (previous) => previous,
  });
  useEffect(() => { if (data) onItems(data.items); }, [data, onItems]);
  if (!expanded) return null;
  const columnsCount = columns.length;
  const pagination = data?.pagination;
  const rangeStart = pagination?.total_items ? (page - 1) * pageSize + 1 : 0;
  const rangeEnd = pagination?.total_items ? Math.min(page * pageSize, pagination.total_items) : 0;
  return <>
    {isFetching && !data && <TableRow><TableCell colSpan={columnsCount} sx={{ pl: 5, py: 0.5 }}><Typography variant="caption" color="text.secondary">Загрузка строк…</Typography></TableCell></TableRow>}
    {error && <TableRow><TableCell colSpan={columnsCount} sx={{ pl: 5 }}><Alert severity="error" sx={{ py: 0.25 }}>Не удалось загрузить строки заявки. Повторите попытку.</Alert></TableCell></TableRow>}
    {data?.items.map((item) => <RegistryRowCells key={item.id} item={item} columns={columns} widths={widths} selected={selectedIds.has(item.id)} active={activeId === item.id} onSelect={(checked) => onToggleSelected(item, checked)} onActive={() => onActive(item)} onDecision={onDecision} onOpen={() => onOpen(item)} />)}
    {data && !data.items.length && <TableRow><TableCell colSpan={columnsCount} sx={{ pl: 5 }}><Typography variant="caption" color="text.secondary">Строк заявки не найдено.</Typography></TableCell></TableRow>}
    {pagination && pagination.total_items > 0 && (
      <TableRow className="approval-register-request-pagination">
        <TableCell colSpan={columnsCount} sx={{ pl: 5, py: 0.45, bgcolor: '#fafbfd', borderTop: '1px solid rgba(15, 23, 42, 0.06)' }}>
          <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between" flexWrap="wrap" useFlexGap>
            <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap>
              <Typography variant="caption" color="text.secondary" sx={{ fontSize: 11 }}>Строк на странице:</Typography>
              <Select
                size="small"
                value={pageSize}
                onChange={(event) => {
                  const nextSize = Number(event.target.value);
                  setPageSize(nextSize);
                  setPage(1);
                  sessionStorage.setItem(REQUEST_PAGE_SIZE_KEY, String(nextSize));
                }}
                sx={{ height: 24, fontSize: 11, minWidth: 56, '& .MuiSelect-select': { py: '2px !important' } }}
              >
                {[25, 50, 100, 200].map((value) => <MenuItem key={value} value={value} dense sx={{ fontSize: 12 }}>{value}</MenuItem>)}
              </Select>
              <Typography variant="caption" color="text.secondary" sx={{ fontSize: 11 }}>
                {`${rangeStart}–${rangeEnd} из ${pagination.total_items}`}
              </Typography>
            </Stack>
            {pagination.total_pages > 1 && (
              <Pagination
                size="small"
                page={page}
                count={pagination.total_pages}
                onChange={(_, value) => setPage(value)}
                siblingCount={1}
                boundaryCount={1}
                sx={{ '& .MuiPaginationItem-root': { minWidth: 24, height: 24, fontSize: 11 } }}
              />
            )}
          </Stack>
        </TableCell>
      </TableRow>
    )}
  </>;
}

function TreeRows({ groups, level, expanded, filters, columns, widths, selectedIds, activeId, onToggle, onToggleSelected, onActive, onDecision, onOpen, onApproveGroup, onItems, requestId }: { groups: ApprovalRegisterGroup[]; level: number; expanded: Set<string>; filters: RegistryFilters; columns: typeof REGISTRY_COLUMNS; widths: Record<RegistryColumnId, number>; selectedIds: Set<string>; activeId: string | null; onToggle: (id: string) => void; onToggleSelected: (item: ApprovalRegisterRow, checked: boolean) => void; onActive: (item: ApprovalRegisterRow) => void; onDecision: (target: DecisionTarget) => void; onOpen: (item: ApprovalRegisterRow) => void; onApproveGroup: (group: ApprovalRegisterGroup) => void; onItems: (items: ApprovalRegisterRow[]) => void; requestId?: string }) {
  return <>{groups.map((group) => {
    const isExpanded = expanded.has(group.id);
    const hasContent = group.children.length > 0 || group.can_load_rows;
    const groupCells: Partial<Record<RegistryColumnId, React.ReactNode>> = {
      select: null,
      structure: <Stack direction="row" alignItems="center" spacing={0.25} sx={{ pl: level * 1.15, minWidth: 0 }}><Box sx={{ width: 22, flex: '0 0 auto' }}>{hasContent && <IconButton size="small" aria-label={isExpanded ? 'Свернуть группу' : 'Раскрыть группу'} onClick={() => onToggle(group.id)} sx={{ p: 0.25 }}>{isExpanded ? <ExpandMoreIcon sx={{ fontSize: 18 }} /> : <ChevronRightIcon sx={{ fontSize: 18 }} />}</IconButton>}</Box><Box minWidth={0}><Typography variant="body2" fontWeight={level === 0 ? 700 : 600} noWrap title={group.name} sx={{ fontSize: 13, lineHeight: 1.25 }}>{group.name}</Typography><Typography variant="caption" color="text.secondary" sx={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, lineHeight: 1.2 }}>{group.label} · {group.aggregates.total_rows} строк{group.type === 'module' && group.request_ids.length === 1 && <> · <Box component="a" href={`/requests/${group.request_ids[0]}?article_id=${encodeURIComponent(group.article_id)}&category_id=${encodeURIComponent(group.category_id)}`} target="_blank" rel="noopener noreferrer" onClick={(event) => event.stopPropagation()} sx={{ color: 'primary.main', font: 'inherit', cursor: 'pointer', textDecoration: 'underline' }}>заявка №{group.request_ids[0].slice(0, 8)}</Box></>}</Typography></Box></Stack>,
      requested: <Typography variant="body2" sx={{ fontSize: 13 }}>{money(group.aggregates.requested_sum)}</Typography>,
      approved: <Typography variant="body2" sx={{ fontSize: 13 }}>{money(group.aggregates.approved_sum)}</Typography>,
      rejected: <Typography variant="body2" sx={{ fontSize: 13, color: group.aggregates.rejected_sum ? 'error.main' : 'inherit' }}>{rejectedMoney(group.aggregates.rejected_sum)}</Typography>,
      status: <CompactStatusChip label={AGGREGATE_DISPLAY_LABELS[group.aggregates.aggregate_status]} color={group.aggregates.aggregate_status === 'approved' ? 'success' : group.aggregates.aggregate_status === 'rejected' ? 'error' : group.aggregates.aggregate_status === 'no_data' ? 'default' : 'warning'} />,
      justification: '—',
      comment: '—',
      files: '—',
      actions: group.type === 'article' && group.aggregates.cfo_review_actionable_requests > 0
        ? <Tooltip title="Согласовать все доступные строки статьи"><Button size="small" color="success" sx={{ px: 0.5, minWidth: 0, fontSize: 11, whiteSpace: 'nowrap' }} onClick={() => onApproveGroup(group)}>Согласовать</Button></Tooltip>
        : null,
    };
    return <Fragment key={group.id}><TableRow hover className="approval-register-row" sx={{ '& td': { py: 0.2, px: 0.75, height: 34, bgcolor: level === 0 ? '#f4f9ff' : '#fff', borderBottom: level === 0 ? '1px solid rgba(15, 23, 42, 0.08)' : undefined, fontSize: 13 }, '&:hover td': { bgcolor: '#edf6ff' } }}>{columns.map((column) => { const fixed = column.id === 'select' || column.id === 'structure'; return <TableCell key={column.id} align={['requested', 'approved', 'rejected', 'pending'].includes(column.id) ? 'right' : column.id === 'select' ? 'center' : 'left'} sx={{ width: widths[column.id], minWidth: widths[column.id], maxWidth: widths[column.id], overflow: 'hidden', position: fixed ? 'sticky' : 'static', left: column.id === 'structure' ? widths.select : 0, zIndex: fixed ? 2 : 0, bgcolor: level === 0 ? '#f4f9ff !important' : '#fff !important', borderRight: '1px solid', borderColor: 'rgba(15, 23, 42, 0.06)', fontWeight: ['requested', 'approved', 'rejected', 'pending'].includes(column.id) ? (level === 0 ? 700 : 500) : undefined }}>{groupCells[column.id]}</TableCell>; })}</TableRow>{isExpanded && group.children.length > 0 && <TreeRows groups={group.children} level={level + 1} expanded={expanded} filters={filters} columns={columns} widths={widths} selectedIds={selectedIds} activeId={activeId} onToggle={onToggle} onToggleSelected={onToggleSelected} onActive={onActive} onDecision={onDecision} onOpen={onOpen} onApproveGroup={onApproveGroup} onItems={onItems} requestId={requestId} />}{group.can_load_rows && <RegisterRows group={group} expanded={isExpanded} filters={filters} columns={columns} widths={widths} selectedIds={selectedIds} activeId={activeId} onToggleSelected={onToggleSelected} onActive={onActive} onDecision={onDecision} onOpen={onOpen} onItems={onItems} requestId={requestId} />}</Fragment>;
  })}</>;
}

export function ApprovalRegister({
  user,
  requestId,
  embedded = false,
  inRequestsPage = false,
}: {
  user: User;
  requestId?: string;
  embedded?: boolean;
  inRequestsPage?: boolean;
}) {
  const availableViews = useMemo<RegistryView[]>(
    () => ['cfo', 'request'],
    [],
  );
  const defaultView: RegistryView = 'cfo';
  const [storedPreferences] = useState(readPreferences);
  const [view, setView] = useState<RegistryView>(() => {
    const storedView = storedPreferences.view || (sessionStorage.getItem('budgetbasket:register:view') as RegistryView);
    return storedView && availableViews.includes(storedView) ? storedView : defaultView;
  });
  const [filters, setFilters] = useState<RegistryFilters>(() => storedPreferences.filters || EMPTY_FILTERS);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [preferences, setPreferences] = useState(() => ({ order: storedPreferences.order, visibility: storedPreferences.visibility, widths: storedPreferences.widths }));
  const [draggedColumn, setDraggedColumn] = useState<RegistryColumnId | null>(null);
  const [selected, setSelected] = useState<Map<string, ApprovalRegisterRow>>(new Map());
  const [activeItem, setActiveItem] = useState<ApprovalRegisterRow | null>(null);
  const [detailsItem, setDetailsItem] = useState<ApprovalRegisterRow | null>(null);
  const [decisionTarget, setDecisionTarget] = useState<DecisionTarget | null>(null);
  const [groupToApprove, setGroupToApprove] = useState<ApprovalRegisterGroup | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const tableContainerRef = useRef<HTMLDivElement | null>(null);
  const deferredSearch = useDeferredValue(filters.search);
  const effectiveFilters = useMemo(() => ({ ...filters, search: deferredSearch }), [deferredSearch, filters]);
  const queryClient = useQueryClient();
  useEffect(() => { sessionStorage.setItem('budgetbasket:register:view', view); }, [view]);
  useEffect(() => { localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ version: 1, view, filters, ...preferences })); }, [filters, preferences, view]);
  useEffect(() => { setExpanded(new Set()); setSelected(new Map()); }, [view, filters.status, filters.budgetYear, deferredSearch]);
  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: ['approval-register', requestId, view, effectiveFilters],
    queryFn: async ({ signal }) => (await api.get<ApprovalRegisterResponse>('/approval-register', {
      params: {
        view,
        status: effectiveFilters.status || undefined,
        budget_year: effectiveFilters.budgetYear || undefined,
        search: deferredSearch || undefined,
        request_id: requestId,
      },
      signal,
    })).data,
  });
  const decide = useMutation({ mutationFn: async ({ target, comment, amount }: { target: DecisionTarget; comment: string; amount?: number }) => {
    const first = target.rows[0];
    const payload = { decision: target.decision, comment, ...(amount === undefined ? {} : { sum_fact: amount }) };
    if (target.rows.length > 1) return api.post('/items/cfo-decision/bulk', { item_ids: target.rows.map((row) => row.id), decision: target.decision, comment });
    if (first.is_cfo_review_actionable) return api.post<BudgetItem>(`/items/${first.id}/cfo-decision`, payload);
    if (first.is_approval_actionable && first.position_id) return api.post<BudgetItem>(`/cfo-positions/${first.position_id}/items/${first.id}/decision`, payload);
    throw new Error('Для этой строки действие больше недоступно. Обновите реестр.');
  }, onSuccess: (response, variables) => {
    if (variables.target.rows.length === 1) updateRegisterCache(queryClient, variables.target.rows[0], response.data as BudgetItem);
    else queryClient.invalidateQueries({ queryKey: ['approval-register'] });
    setSelected(new Map()); setDecisionTarget(null); setDecisionError(null);
  }, onError: () => setDecisionError('Не удалось сохранить решение. Данные не изменены; попробуйте ещё раз.') });
  const approveArticle = useMutation({
    mutationFn: async (group: ApprovalRegisterGroup) => api.post(
      `/approval-register/groups/${group.type}/${groupEntityId(group)}/cfo-decision`,
      { decision: 'approved', comment: '' },
      { params: { request_id: requestId } },
    ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['approval-register'] });
      queryClient.invalidateQueries({ queryKey: ['approval-register-rows'] });
      setGroupToApprove(null);
    },
  });
  const toggle = (id: string) => setExpanded((current) => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const expandAll = useCallback(() => {
    const ids: string[] = [];
    const visit = (groups: ApprovalRegisterGroup[]) => groups.forEach((group) => { if (group.children.length) { ids.push(group.id); visit(group.children); } });
    visit(data?.groups || []);
    setExpanded(new Set(ids));
  }, [data?.groups]);
  const collapseAll = useCallback(() => setExpanded(new Set()), []);
  const pageChromeActions = useMemo(() => (
    <Stack direction="row" spacing={0.25} flexWrap="wrap" useFlexGap className="approval-register-chrome-actions">
      <Button size="small" color="inherit" startIcon={<UnfoldLessIcon sx={{ fontSize: 16 }} />} onClick={collapseAll} sx={{ textTransform: 'none', fontWeight: 500, minWidth: 0, px: 0.75, fontSize: 13 }}>
        Свернуть все
      </Button>
      <Button size="small" color="inherit" startIcon={<UnfoldMoreIcon sx={{ fontSize: 16 }} />} onClick={expandAll} sx={{ textTransform: 'none', fontWeight: 500, minWidth: 0, px: 0.75, fontSize: 13 }}>
        Развернуть все
      </Button>
    </Stack>
  ), [collapseAll, expandAll]);
  usePageChromeActions(embedded || inRequestsPage ? null : pageChromeActions);
  usePageChromeLeading(useMemo(() => embedded || inRequestsPage ? null : (
    <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 500, fontSize: 12 }}>
      register &gt; Реестр бюджетных заявок
    </Typography>
  ), [embedded, inRequestsPage]));
  const toggleColumn = (id: RegistryColumnId) => setPreferences((current) => ({ ...current, visibility: { ...current.visibility, [id]: !current.visibility[id] } }));
  const moveColumn = (target: RegistryColumnId) => {
    if (!draggedColumn || draggedColumn === target || target === 'select' || target === 'structure') return;
    setPreferences((current) => {
      const order = current.order.filter((id) => id !== draggedColumn);
      const targetIndex = order.indexOf(target);
      if (targetIndex < 0) return current;
      order.splice(targetIndex, 0, draggedColumn);
      return { ...current, order };
    });
    setDraggedColumn(null);
  };
  const resizeColumn = (id: RegistryColumnId, event: ReactPointerEvent<HTMLSpanElement>) => { event.preventDefault(); const startX = event.clientX; const startWidth = preferences.widths[id]; const onMove = (moveEvent: PointerEvent) => setPreferences((current) => ({ ...current, widths: { ...current.widths, [id]: Math.max(id === 'structure' ? 280 : 88, startWidth + moveEvent.clientX - startX) } })); const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); }; window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp); };
  const visibleColumns = orderedRegistryColumns(preferences.order, preferences.visibility);
  const tableWidth = visibleColumns.reduce((total, column) => total + preferences.widths[column.id], 0);
  const selectedRows = [...selected.values()];
  const exportRegister = () => { const rows: string[][] = [['Структура', 'Запрошено', 'Согласовано', 'Статус']]; const visit = (groups: ApprovalRegisterGroup[], level = 0) => groups.forEach((group) => { rows.push([`${'  '.repeat(level)}${group.name}`, String(group.aggregates.requested_sum), String(group.aggregates.approved_sum), AGGREGATE_DISPLAY_LABELS[group.aggregates.aggregate_status]]); visit(group.children, level + 1); }); visit(data?.groups || []); const content = rows.map((row) => row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(';')).join('\n'); const url = URL.createObjectURL(new Blob([`\ufeff${content}`], { type: 'text/csv;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = 'реестр-бюджетных-заявок.csv'; link.click(); URL.revokeObjectURL(url); };
  const updateKnownItems = useCallback((items: ApprovalRegisterRow[]) => setSelected((current) => {
    let changed = false;
    const next = new Map(current);
    items.forEach((item) => {
      if (next.has(item.id) && next.get(item.id) !== item) {
        next.set(item.id, item);
        changed = true;
      }
    });
    return changed ? next : current;
  }), []);
  const hasActiveTableFilters = Boolean(filters.search || filters.status || filters.budgetYear);
  const columnTools = (
    <>
      <TableColumnTools
        buttonLabel="Колонки"
        columns={REGISTRY_COLUMNS}
        visibility={preferences.visibility}
        onToggleColumn={toggleColumn}
        onResetColumns={() => setPreferences({ order: DEFAULT_COLUMN_ORDER, visibility: DEFAULT_COLUMN_VISIBILITY, widths: DEFAULT_COLUMN_WIDTHS })}
        onResetFilters={() => setFilters(EMPTY_FILTERS)}
        onResetWidths={() => setPreferences((current) => ({ ...current, widths: DEFAULT_COLUMN_WIDTHS }))}
        hasActiveFilters={hasActiveTableFilters}
      />
      <TableColumnTools
        columns={REGISTRY_COLUMNS}
        visibility={preferences.visibility}
        onToggleColumn={toggleColumn}
        onResetColumns={() => setPreferences({ order: DEFAULT_COLUMN_ORDER, visibility: DEFAULT_COLUMN_VISIBILITY, widths: DEFAULT_COLUMN_WIDTHS })}
        onResetFilters={() => setFilters(EMPTY_FILTERS)}
        onResetWidths={() => setPreferences((current) => ({ ...current, widths: DEFAULT_COLUMN_WIDTHS }))}
        hasActiveFilters={hasActiveTableFilters}
      />
    </>
  );
  return <Stack spacing={1.1} className="approval-register-page">
    <Box sx={{ pt: 0.15 }}>
      <Typography fontWeight={700} letterSpacing="-0.02em" sx={{ fontSize: { xs: '1.2rem', md: '1.35rem' }, lineHeight: 1.2 }}>
        {embedded ? 'Проверка заявки' : inRequestsPage ? 'Заявки' : 'Реестр бюджетных заявок'}
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ mt: 0.35, display: 'block', fontSize: 12, lineHeight: 1.35 }}>
        {embedded
          ? 'Просматривайте строки, принимайте решение по статье или детализации, корректируйте сумму либо отправляйте строку на доработку.'
          : inRequestsPage
            ? 'Проверяйте бюджетные строки по ЦФО, статье и категории или переключайтесь на представление по заявкам.'
          : 'Агрегированный реестр бюджетных заявок с возможностью детализации и управления.'}
      </Typography>
    </Box>
    <RegistryFilterBar
      view={view}
      filters={filters}
      onViewChange={setView}
      onChange={setFilters}
      onReset={() => setFilters(EMPTY_FILTERS)}
      onExport={exportRegister}
      columnTools={columnTools}
      availableViews={availableViews}
    />
    {data && <RegistrySummary aggregates={data.aggregates} />}
    {selectedRows.length > 0 && <Paper variant="outlined" sx={{ px: 1.25, py: 0.75, borderColor: 'primary.main', bgcolor: 'primary.50' }}><Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}><Typography variant="body2" fontWeight={700}>Выбрано: {selectedRows.length} · запрошено: {money(selectedRows.reduce((total, item) => total + item.requested_sum, 0))}</Typography><Box sx={{ flex: 1 }} /><Button size="small" color="success" onClick={() => { setDecisionError(null); setDecisionTarget({ rows: selectedRows, decision: 'approved' }); }}>Согласовать</Button><Button size="small" color="error" onClick={() => { setDecisionError(null); setDecisionTarget({ rows: selectedRows, decision: 'rejected' }); }}>Отклонить</Button><Button size="small" onClick={() => setSelected(new Map())}>Снять выделение</Button></Stack></Paper>}
    {error && <Alert severity="error">Не удалось загрузить реестр. Повторите попытку.</Alert>}
    <TableContainer ref={tableContainerRef} component={Paper} variant="outlined" className="approval-register-table" sx={{ maxHeight: 'calc(100vh - 250px)', minHeight: 420, borderColor: 'rgba(15, 23, 42, 0.08)', borderRadius: 1.5 }}><Table stickyHeader size="small" sx={{ width: tableWidth, minWidth: tableWidth, tableLayout: 'fixed', '& td, & th': { borderRight: '1px solid', borderColor: 'rgba(15, 23, 42, 0.06)', fontSize: 12 } }}><colgroup>{visibleColumns.map((column) => <col key={column.id} style={{ width: preferences.widths[column.id] }} />)}</colgroup><TableHead sx={{ '& .MuiTableCell-root': { bgcolor: '#F8FAFC !important', backgroundImage: 'none', boxShadow: 'inset 0 -1px 0 rgba(15, 23, 42, 0.08)', py: 0.55, px: 0.75, fontSize: 12, fontWeight: 700, color: 'text.secondary' } }}><TableRow>{visibleColumns.map((column) => { const movable = column.id !== 'select' && column.id !== 'structure'; const fixed = column.id === 'select' || column.id === 'structure'; return <TableCell key={column.id} draggable={movable} onDragStart={() => movable && setDraggedColumn(column.id)} onDragEnd={() => setDraggedColumn(null)} onDragOver={(event) => { if (movable && draggedColumn) event.preventDefault(); }} onDrop={() => moveColumn(column.id)} align={['requested', 'approved', 'rejected', 'pending'].includes(column.id) ? 'right' : column.id === 'select' ? 'center' : 'left'} sx={{ width: preferences.widths[column.id], minWidth: preferences.widths[column.id], overflow: 'hidden', position: 'sticky', top: 0, left: column.id === 'structure' ? preferences.widths.select : fixed ? 0 : undefined, zIndex: fixed ? 5 : 4, bgcolor: draggedColumn === column.id ? '#E8EEF8 !important' : '#F8FAFC !important', cursor: movable ? 'grab' : 'default', whiteSpace: 'nowrap' }}><Tooltip title={movable ? 'Перетащите заголовок для изменения порядка' : ''}><Box sx={{ position: 'relative', pr: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{column.id === 'select' ? <Checkbox size="small" checked={selectedRows.length > 0} indeterminate={selectedRows.length > 0} onChange={() => setSelected(new Map())} sx={{ p: 0.35 }} inputProps={{ 'aria-label': 'Снять выделение' }} /> : column.label}<TableColumnResizeHandle onPointerDown={(event) => resizeColumn(column.id, event)} /></Box></Tooltip></TableCell>; })}</TableRow></TableHead><TableBody>{isLoading && !data && <TableRow><TableCell colSpan={visibleColumns.length} align="center" sx={{ py: 4 }}><Typography variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>Загрузка реестра…</Typography></TableCell></TableRow>}    {isFetching && data && <TableRow><TableCell colSpan={visibleColumns.length} sx={{ py: 0.5, bgcolor: '#f8fbff' }}><Typography variant="caption" color="text.secondary">Обновление…</Typography></TableCell></TableRow>}{data && !data.groups.length && <TableRow><TableCell colSpan={visibleColumns.length} align="center" sx={{ py: 4, fontSize: 13 }}>Нет строк по выбранным условиям.</TableCell></TableRow>}{data && <TreeRows groups={data.groups} level={0} expanded={expanded} filters={effectiveFilters} columns={visibleColumns} widths={preferences.widths} selectedIds={new Set(selected.keys())} activeId={activeItem?.id || null} onToggle={toggle} onToggleSelected={(item, checked) => setSelected((current) => { const next = new Map(current); if (checked) next.set(item.id, item); else next.delete(item.id); return next; })} onActive={setActiveItem} onDecision={(target) => { setDecisionError(null); setDecisionTarget(target); }} onOpen={setDetailsItem} onApproveGroup={setGroupToApprove} onItems={updateKnownItems} requestId={requestId} />}</TableBody></Table></TableContainer>
    <RegistryFooter totalRows={data?.aggregates.total_rows || 0} />
    <DecisionDialog target={decisionTarget} saving={decide.isPending} error={decisionError} onClose={() => { setDecisionTarget(null); setDecisionError(null); }} onSave={(comment, amount) => decisionTarget && decide.mutate({ target: decisionTarget, comment, amount })} />
    <ConfirmDialog open={!!groupToApprove} title="Согласовать статью" description={groupToApprove && <Stack spacing={0.5}><Typography>Будут согласованы все доступные для вас строки статьи «{groupToApprove.name}».</Typography><Typography variant="body2" color="text.secondary">Строк в статье: {groupToApprove.aggregates.total_rows} · запрошено: {money(groupToApprove.aggregates.requested_sum)}</Typography>{approveArticle.error && <Alert severity="error">Не удалось согласовать статью. Попробуйте ещё раз.</Alert>}</Stack>} confirmLabel={approveArticle.isPending ? 'Сохраняется…' : 'Согласовать'} confirmColor="success" pending={approveArticle.isPending} onClose={() => setGroupToApprove(null)} onConfirm={() => groupToApprove && approveArticle.mutate(groupToApprove)} />
    <RegistryDetailsDrawer item={detailsItem} onClose={() => setDetailsItem(null)} />
  </Stack>;
}
