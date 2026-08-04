import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import SearchIcon from '@mui/icons-material/Search';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import MenuItem from '@mui/material/MenuItem';
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
import { useQuery } from '@tanstack/react-query';
import { useDeferredValue, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { CfoRequestReviewDialog } from './CfoRequestReviewDialog';
import { ItemStatusBadge } from '../components/StatusBadge';
import type { ApprovalRegisterGroup, ApprovalRegisterResponse, ApprovalRegisterRow, ApprovalRegisterRowsResponse, RegisterAggregateStatus, RegisterAggregates, User } from '../types';
import { money } from '../utils/labels';

type View = 'cfo' | 'category' | 'article' | 'module';

const VIEW_LABELS: Record<View, string> = {
  cfo: 'По ЦФО', category: 'По категориям', article: 'По статьям', module: 'По модулям',
};

const AGGREGATE_LABELS: Record<RegisterAggregateStatus, string> = {
  approved: 'Согласовано', rejected: 'Не согласовано', partially_approved: 'Частично согласовано',
  on_review: 'На рассмотрении', in_progress: 'В процессе', no_data: 'Нет данных',
};

const AGGREGATE_TONES: Record<RegisterAggregateStatus, 'success' | 'error' | 'warning' | 'info' | 'default'> = {
  approved: 'success', rejected: 'error', partially_approved: 'info', on_review: 'warning', in_progress: 'info', no_data: 'default',
};

type Filters = { search: string; status: string; budget_year: string };

function GroupStatus({ status }: { status: RegisterAggregateStatus }) {
  return <Chip size="small" color={AGGREGATE_TONES[status]} variant="outlined" label={AGGREGATE_LABELS[status]} sx={{ fontWeight: 600 }} />;
}

function Readiness({ aggregates }: { aggregates: RegisterAggregates }) {
  const chips: Array<{ label: string; color: 'success' | 'warning' | 'info' | 'default' }> = [];
  if (aggregates.actionable_positions) chips.push({ label: `Можно согласовать: ${aggregates.actionable_positions}`, color: 'success' });
  if (aggregates.cfo_review_actionable_requests) chips.push({ label: `К проверке ЦФО: ${aggregates.cfo_review_actionable_requests}`, color: 'warning' });
  else if (aggregates.cfo_review_requests) chips.push({ label: `Проверка ЦФО: ${aggregates.cfo_review_requests}`, color: 'warning' });
  if (aggregates.collecting_requests) chips.push({ label: `Сбор данных: ${aggregates.collecting_requests}`, color: 'default' });
  const waitingForOthers = aggregates.in_approval_positions - aggregates.actionable_positions;
  if (waitingForOthers > 0) chips.push({ label: `На согласовании: ${waitingForOthers}`, color: 'info' });
  return chips.length
    ? <Stack spacing={0.5} alignItems="flex-start">{chips.map((chip) => <Chip key={chip.label} size="small" color={chip.color} variant="outlined" label={chip.label} sx={{ fontWeight: 600 }} />)}</Stack>
    : <Typography variant="body2" color="text.secondary">Завершено</Typography>;
}

function RowReadiness({ item }: { item: ApprovalRegisterRow }) {
  if (item.is_approval_actionable) return <Chip size="small" color="success" variant="outlined" label="Можно согласовать" sx={{ fontWeight: 600 }} />;
  if (item.is_cfo_review_actionable) return <Chip size="small" color="warning" variant="outlined" label="К проверке ЦФО" sx={{ fontWeight: 600 }} />;
  if (item.is_collecting) return <Chip size="small" variant="outlined" label="Сбор данных" sx={{ fontWeight: 600 }} />;
  if (item.is_cfo_review) return <Chip size="small" color="warning" variant="outlined" label="Проверка ЦФО" sx={{ fontWeight: 600 }} />;
  if (item.is_in_approval) return <Chip size="small" color="info" variant="outlined" label={item.approval_stage ? `На согласовании · ${item.approval_stage}` : 'На согласовании'} sx={{ fontWeight: 600 }} />;
  return <Typography variant="body2" color="text.secondary">Завершено</Typography>;
}

function RegisterRows({ group, expanded, filters }: { group: ApprovalRegisterGroup; expanded: boolean; filters: Filters }) {
  const storageKey = `budgetbasket:register:${group.id}`;
  const [page, setPage] = useState(() => Number(sessionStorage.getItem(`${storageKey}:page`)) || 1);
  const [pageSize, setPageSize] = useState(() => Number(sessionStorage.getItem('budgetbasket:register:page-size')) || 50);
  const [reviewRequest, setReviewRequest] = useState<{ id: string; budget_year: number } | null>(null);
  const navigate = useNavigate();
  const filterKey = JSON.stringify(filters);
  useEffect(() => { setPage(1); }, [filterKey]);
  useEffect(() => { sessionStorage.setItem(`${storageKey}:page`, String(page)); }, [page, storageKey]);
  useEffect(() => { sessionStorage.setItem('budgetbasket:register:page-size', String(pageSize)); }, [pageSize]);
  const { data, isFetching, error } = useQuery({
    queryKey: ['approval-register-rows', group.id, group.module_id, page, pageSize, filters],
    queryFn: async ({ signal }) => (await api.get<ApprovalRegisterRowsResponse>('/approval-register/rows', {
      params: { module_id: group.module_id, page, page_size: pageSize, status: filters.status || undefined, budget_year: filters.budget_year || undefined, search: filters.search || undefined }, signal,
    })).data,
    enabled: expanded,
    placeholderData: (previous) => previous,
  });
  if (!expanded) return null;
  const pagination = data?.pagination;
  return <>
    {isFetching && !data && <TableRow><TableCell colSpan={8} sx={{ pl: 7 }}><Stack direction="row" spacing={1} alignItems="center"><CircularProgress size={16} /> <Typography variant="body2">Загрузка строк…</Typography></Stack></TableCell></TableRow>}
    {error && <TableRow><TableCell colSpan={8} sx={{ pl: 7 }}><Alert severity="error">Не удалось загрузить строки модуля.</Alert></TableCell></TableRow>}
    {data?.items.map((item) => <TableRow key={item.id} hover sx={{ '& td': { py: 0.65, bgcolor: 'background.default' } }}>
      <TableCell sx={{ pl: 7, position: 'sticky', left: 0, zIndex: 1, bgcolor: 'background.default !important', minWidth: 360 }}>
        <Box minWidth={0}><Typography variant="body2" noWrap title={item.name}>{item.name}</Typography><Typography variant="caption" color="text.secondary" noWrap>{item.article_name} · заявка {item.request_id.slice(0, 8)}</Typography></Box>
      </TableCell>
      <TableCell align="right">{money(item.requested_sum)}</TableCell>
      <TableCell align="right">{money(item.approved_sum)}</TableCell>
      <TableCell align="right">{money(item.approved_sum - item.requested_sum)}</TableCell>
      <TableCell><ItemStatusBadge status={item.status} /></TableCell>
      <TableCell><RowReadiness item={item} /></TableCell>
      <TableCell align="center">{item.files_count || '—'}</TableCell>
      <TableCell align="right"><Stack direction="row" spacing={0.5} justifyContent="flex-end">{item.is_cfo_review_actionable && <Button size="small" onClick={() => setReviewRequest({ id: item.request_id, budget_year: item.budget_year })}>Проверить</Button>}<Tooltip title="Открыть заявку"><IconButton size="small" onClick={() => navigate(`/requests/${item.request_id}`)}><OpenInNewIcon fontSize="small" /></IconButton></Tooltip></Stack></TableCell>
    </TableRow>)}
    {data && !data.items.length && <TableRow><TableCell colSpan={8} sx={{ pl: 7 }}><Typography variant="body2" color="text.secondary">В этой детализации строк нет.</Typography></TableCell></TableRow>}
    {pagination && <TableRow><TableCell colSpan={8} sx={{ pl: 7, py: 1, bgcolor: 'background.default' }}>
      <Stack direction={{ xs: 'column', sm: 'row' }} alignItems={{ sm: 'center' }} spacing={1.5} justifyContent="space-between">
        <Typography variant="caption" color="text.secondary">Показано {pagination.total_items ? `${(pagination.page - 1) * pagination.page_size + 1}–${Math.min(pagination.page * pagination.page_size, pagination.total_items)}` : '0'} из {pagination.total_items}</Typography>
        <Stack direction="row" spacing={1} alignItems="center"><Typography variant="caption">Строк на странице:</Typography><Select size="small" value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }} sx={{ height: 30, fontSize: 13 }}>{[25, 50, 100, 200].map((value) => <MenuItem key={value} value={value}>{value}</MenuItem>)}</Select>
          <Button size="small" disabled={!pagination.has_previous || isFetching} onClick={() => setPage((value) => value - 1)}>← Предыдущая</Button><Typography variant="caption" sx={{ whiteSpace: 'nowrap' }}>{pagination.page} из {pagination.total_pages}</Typography><Button size="small" disabled={!pagination.has_next || isFetching} onClick={() => setPage((value) => value + 1)}>Следующая →</Button>{isFetching && <CircularProgress size={14} />}
        </Stack>
      </Stack>
    </TableCell></TableRow>}
    <CfoRequestReviewDialog request={reviewRequest} open={!!reviewRequest} onClose={() => setReviewRequest(null)} />
  </>;
}

function TreeRows({ groups, level, expanded, onToggle, filters }: { groups: ApprovalRegisterGroup[]; level: number; expanded: Set<string>; onToggle: (id: string) => void; filters: Filters }) {
  const navigate = useNavigate();
  return <>{groups.map((group) => {
    const isExpanded = expanded.has(group.id);
    const hasContent = group.children.length > 0 || group.can_load_rows;
    return <TreeRowsItem key={group.id} group={group} level={level} isExpanded={isExpanded} hasContent={hasContent} expanded={expanded} onToggle={onToggle} filters={filters} navigate={navigate} />;
  })}</>;
}

function TreeRowsItem({ group, level, isExpanded, hasContent, expanded, onToggle, filters, navigate }: { group: ApprovalRegisterGroup; level: number; isExpanded: boolean; hasContent: boolean; expanded: Set<string>; onToggle: (id: string) => void; filters: Filters; navigate: ReturnType<typeof useNavigate> }) {
  return <>
    <TableRow hover sx={{ '& td': { py: 0.75 }, '&:hover td': { bgcolor: 'action.hover' } }}>
      <TableCell sx={{ position: 'sticky', left: 0, zIndex: 1, bgcolor: 'background.paper', minWidth: 360 }}>
        <Stack direction="row" alignItems="center" spacing={0.5} sx={{ pl: level * 2 }}>
          {hasContent ? <IconButton size="small" aria-label={isExpanded ? 'Свернуть группу' : 'Раскрыть группу'} onClick={() => onToggle(group.id)}>{isExpanded ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}</IconButton> : <Box sx={{ width: 32 }} />}
          <Box minWidth={0}><Typography variant="body2" fontWeight={650} noWrap title={group.name}>{group.name}</Typography><Typography variant="caption" color="text.secondary">{group.label} · {group.aggregates.total_rows} строк</Typography></Box>
        </Stack>
      </TableCell>
      <TableCell align="right">{money(group.aggregates.requested_sum)}</TableCell>
      <TableCell align="right">{money(group.aggregates.approved_sum)}</TableCell>
      <TableCell align="right">{money(group.aggregates.difference)}</TableCell>
      <TableCell><GroupStatus status={group.aggregates.aggregate_status} /></TableCell>
      <TableCell><Readiness aggregates={group.aggregates} /></TableCell>
      <TableCell align="center">{group.aggregates.approved_rows} / {group.aggregates.rejected_rows} / {group.aggregates.pending_rows}</TableCell>
      <TableCell align="right">{group.request_ids.length === 1 && <Tooltip title="Открыть заявку модуля"><IconButton size="small" onClick={() => navigate(`/requests/${group.request_ids[0]}`)}><OpenInNewIcon fontSize="small" /></IconButton></Tooltip>}</TableCell>
    </TableRow>
    {isExpanded && group.children.length > 0 && <TreeRows groups={group.children} level={level + 1} expanded={expanded} onToggle={onToggle} filters={filters} />}
    <RegisterRows group={group} expanded={isExpanded && group.can_load_rows} filters={filters} />
  </>;
}

export function ApprovalRegister({ user }: { user: User }) {
  const defaultView: View = user.role === 'employee' ? 'article' : 'cfo';
  const [view, setView] = useState<View>(() => (sessionStorage.getItem('budgetbasket:register:view') as View) || defaultView);
  const [filters, setFilters] = useState<Filters>({ search: '', status: '', budget_year: '' });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const deferredSearch = useDeferredValue(filters.search);
  const effectiveFilters = { ...filters, search: deferredSearch };
  useEffect(() => { sessionStorage.setItem('budgetbasket:register:view', view); }, [view]);
  useEffect(() => { setExpanded(new Set()); }, [view, filters.status, filters.budget_year, deferredSearch]);
  const { data, isLoading, error } = useQuery({
    queryKey: ['approval-register', view, effectiveFilters],
    queryFn: async ({ signal }) => (await api.get<ApprovalRegisterResponse>('/approval-register', { params: { view, status: filters.status || undefined, budget_year: filters.budget_year || undefined, search: deferredSearch || undefined }, signal })).data,
  });
  const toggle = (id: string) => setExpanded((current) => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const expandAll = () => { const ids: string[] = []; const visit = (groups: ApprovalRegisterGroup[]) => groups.forEach((group) => { ids.push(group.id); visit(group.children); }); visit(data?.groups || []); setExpanded(new Set(ids)); };
  return <Stack spacing={1.5}>
    <Stack direction={{ xs: 'column', lg: 'row' }} spacing={1} justifyContent="space-between" alignItems={{ lg: 'center' }}>
      <Box><Typography variant="h5">Реестр бюджетных заявок</Typography><Typography variant="body2" color="text.secondary">Агрегаты рассчитаны по всем доступным строкам; детализация загружается постранично.</Typography></Box>
      <Stack direction="row" spacing={1}><Button size="small" onClick={expandAll}>Раскрыть все</Button><Button size="small" onClick={() => setExpanded(new Set())}>Свернуть все</Button></Stack>
    </Stack>
    <Paper variant="outlined" sx={{ p: 1.25 }}><Stack direction={{ xs: 'column', md: 'row' }} spacing={1}>
      <TextField size="small" placeholder="Поиск по строке, статье, модулю или заявке" value={filters.search} onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))} sx={{ minWidth: { md: 340 }, flex: 1 }} InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }} />
      <TextField select size="small" label="Статус строки" value={filters.status} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))} sx={{ minWidth: 180 }}><MenuItem value="">Все статусы</MenuItem><MenuItem value="on_review">На рассмотрении</MenuItem><MenuItem value="approved">Согласовано</MenuItem><MenuItem value="approved_with_changes">С изменениями</MenuItem><MenuItem value="rejected">Отклонено</MenuItem></TextField>
      <TextField size="small" label="Бюджетный год" type="number" value={filters.budget_year} onChange={(event) => setFilters((current) => ({ ...current, budget_year: event.target.value }))} sx={{ width: { md: 150 } }} />
      <Button startIcon={<RestartAltIcon />} onClick={() => setFilters({ search: '', status: '', budget_year: '' })}>Сбросить</Button>
    </Stack></Paper>
    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }} justifyContent="space-between"><Select size="small" value={view} onChange={(event) => setView(event.target.value as View)} sx={{ minWidth: 190 }}>{(Object.keys(VIEW_LABELS) as View[]).map((key) => <MenuItem key={key} value={key}>{VIEW_LABELS[key]}</MenuItem>)}</Select>{data && <Typography variant="body2" color="text.secondary">Всего строк: {data.aggregates.total_rows} · Запрошено: {money(data.aggregates.requested_sum)}</Typography>}</Stack>
    {error && <Alert severity="error">Не удалось загрузить реестр. Повторите попытку.</Alert>}
    <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: 'calc(100vh - 300px)', minHeight: 320 }}><Table stickyHeader size="small" sx={{ minWidth: 1210 }}><TableHead><TableRow><TableCell sx={{ minWidth: 360 }}>Группа / строка</TableCell><TableCell align="right">Запрошено</TableCell><TableCell align="right">Согласовано</TableCell><TableCell align="right">Отклонение</TableCell><TableCell>Результат</TableCell><TableCell sx={{ minWidth: 190 }}>Готовность</TableCell><TableCell align="center">Статусы<br />(✓ / ✕ / …)</TableCell><TableCell align="right">Действия</TableCell></TableRow></TableHead><TableBody>
      {isLoading && <TableRow><TableCell colSpan={8} align="center" sx={{ py: 5 }}><CircularProgress size={24} /></TableCell></TableRow>}
      {data && !data.groups.length && <TableRow><TableCell colSpan={8} align="center" sx={{ py: 5 }}>Нет строк по выбранным условиям.</TableCell></TableRow>}
      {data && <TreeRows groups={data.groups} level={0} expanded={expanded} onToggle={toggle} filters={effectiveFilters} />}
    </TableBody></Table></TableContainer>
  </Stack>;
}
