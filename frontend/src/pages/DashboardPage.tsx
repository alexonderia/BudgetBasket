import ArrowOutwardIcon from '@mui/icons-material/ArrowOutward';
import AssignmentTurnedInIcon from '@mui/icons-material/AssignmentTurnedIn';
import FactCheckIcon from '@mui/icons-material/FactCheck';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import PaymentsOutlinedIcon from '@mui/icons-material/PaymentsOutlined';
import InsightsOutlinedIcon from '@mui/icons-material/InsightsOutlined';
import TrendingUpIcon from '@mui/icons-material/TrendingUp';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Grid from '@mui/material/Grid';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import MenuItem from '@mui/material/MenuItem';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { ApprovalRegister } from '../components/ApprovalRegister';
import type { User } from '../types';
import { buildRegisterHref, dashboardMetricFilters, parseArticleKey, type DashboardMetric } from '../utils/dashboardNavigation';
import { money } from '../utils/labels';

type Breakdown = {
  id: string;
  name: string;
  kind: 'dds' | 'invest' | 'unit' | 'cfo';
  planned: number;
  approved: number;
  items_count: number;
  cfo_id?: string;
  article_id?: string;
};

type DashboardData = {
  scope: {
    unit_id: string | null;
    available_units: { id: string; name: string; parent_id: string | null }[];
    table_units: { id: string; name: string; parent_id: string | null }[];
  };
  totals: {
    planned: number;
    approved: number;
    frozen: number;
    remaining: number;
    requests_count: number;
    approved_requests_count: number;
    review_requests_count: number;
    frozen_requests_count: number;
  };
  by_unit: Breakdown[];
  by_category: Breakdown[];
  by_article: Breakdown[];
};

type ArticleCfoBreakdown = Breakdown & {
  cfo: Breakdown[];
};

function DashboardDrillLink({ to, title, children }: { to: string; title: string; children: ReactNode }) {
  return (
    <Tooltip title={title} arrow>
      <Box
        component={RouterLink}
        to={to}
        target="_blank"
        rel="noopener noreferrer"
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.5,
          minWidth: 0,
          color: 'inherit',
          textDecoration: 'none',
          borderRadius: 1,
          px: 0.25,
          mx: -0.25,
          transition: 'background-color 0.15s ease',
          '&:hover': { bgcolor: 'rgba(47, 111, 237, 0.08)', color: 'primary.main' },
        }}
      >
        {children}
      </Box>
    </Tooltip>
  );
}

function DashboardDrillButton({ to, title }: { to: string; title: string }) {
  return (
    <Tooltip title={title} arrow>
      <IconButton
        component={RouterLink}
        to={to}
        target="_blank"
        rel="noopener noreferrer"
        size="small"
        aria-label={title}
        sx={{ color: 'text.secondary', '&:hover': { color: 'primary.main' } }}
      >
        <OpenInNewIcon sx={{ fontSize: 16 }} />
      </IconButton>
    </Tooltip>
  );
}

function compactMoney(value: number) {
  const absolute = Math.abs(value);
  const [divisor, suffix] = absolute >= 1_000
    ? [1_000, 'тыс']
    : [1, ''];
  const formatted = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: divisor === 1 ? 0 : 1 }).format(value / divisor);
  return `${formatted}${suffix ? ` ${suffix}` : ''} ₽`;
}

function Metric({ title, value, exactValue, hint, icon, tone = 'blue', to }: { title: string; value: string | number; exactValue?: string; hint: ReactNode; icon: React.ReactNode; tone?: string; to: string }) {
  return (
    <Card className="metric-card dashboard-metric" elevation={0}>
      <CardActionArea component={RouterLink} to={to} aria-label={`Открыть реестр: ${title}`} sx={{ height: '100%', textAlign: 'inherit', '&:focus-visible': { outline: '3px solid', outlineColor: 'primary.light', outlineOffset: -3 } }}>
      <CardContent sx={{ p: 2.5 }}>
        <Stack direction="row" justifyContent="space-between" spacing={1.5}>
          <Box minWidth={0} flex={1}>
            <Typography className="section-label">{title}</Typography>
            <Tooltip title={exactValue || String(value)} arrow>
              <Typography className="dashboard-metric-value" variant="h5" sx={{ mt: 0.65 }}>{value}</Typography>
            </Tooltip>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>{hint}</Typography>
          </Box>
          <Box className={`metric-icon metric-icon-${tone}`}>{icon}</Box>
        </Stack>
      </CardContent>
      </CardActionArea>
    </Card>
  );
}

const chartColors = [
  '#2F6FED', '#20A68A', '#8B5CF6', '#F59E0B', '#EC6A5C', '#3AA6D0',
  '#64748B', '#D946EF', '#0F766E', '#7C3AED', '#EA580C', '#0891B2',
  '#4F46E5', '#BE123C', '#65A30D', '#C2410C', '#0284C7', '#9333EA',
  '#0D9488', '#B45309', '#475569', '#DB2777', '#2563EB', '#16A34A',
];

function chartColorForId(id: string) {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = ((hash * 31) + id.charCodeAt(index)) >>> 0;
  }
  return chartColors[hash % chartColors.length];
}

function ParetoChart({ rows, total, ariaLabel, showType = false, getRowHref }: {
  rows: Breakdown[];
  total: number;
  ariaLabel: string;
  showType?: boolean;
  getRowHref?: (row: Breakdown) => string | null;
}) {
  const segments = useMemo(() => {
    const ordered = [...rows].sort((left, right) => right.planned - left.planned || left.name.localeCompare(right.name, 'ru'));
    const denominator = total || ordered.reduce((sum, row) => sum + row.planned, 0);
    const mainRows: Breakdown[] = [];
    const otherRows: Breakdown[] = [];
    let cumulative = 0;
    ordered.forEach((row) => {
      if (denominator && cumulative / denominator < 0.8) {
        mainRows.push(row);
        cumulative += row.planned;
      } else {
        otherRows.push(row);
      }
    });
    const chartRows = otherRows.length
      ? [...mainRows, otherRows.reduce<Breakdown>((rest, row) => ({ ...rest, planned: rest.planned + row.planned, approved: rest.approved + row.approved, items_count: rest.items_count + row.items_count }), { id: 'other', name: 'Прочее', kind: 'dds', planned: 0, approved: 0, items_count: 0 })]
      : mainRows;
    let offset = 0;
    return chartRows.map((row, index) => {
      const percentage = denominator ? (row.planned / denominator) * 100 : 0;
      const result = { ...row, offset, percentage, color: chartColors[index % chartColors.length] };
      offset += percentage;
      return result;
    });
  }, [rows, total]);

  if (!rows.length) return <Box className="dashboard-empty-chart">Нет данных для расчета</Box>;

  const point = (radius: number, angle: number) => {
    const radians = (angle * Math.PI) / 180;
    return { x: 21 + radius * Math.cos(radians), y: 21 + radius * Math.sin(radians) };
  };
  const segmentPath = (offset: number, percentage: number) => {
    if (percentage >= 99.999) return '';
    const start = point(19, offset * 3.6 - 90);
    const end = point(19, (offset + percentage) * 3.6 - 90);
    const innerStart = point(11, offset * 3.6 - 90);
    const innerEnd = point(11, (offset + percentage) * 3.6 - 90);
    const largeArc = percentage > 50 ? 1 : 0;
    return `M ${start.x} ${start.y} A 19 19 0 ${largeArc} 1 ${end.x} ${end.y} L ${innerEnd.x} ${innerEnd.y} A 11 11 0 ${largeArc} 0 ${innerStart.x} ${innerStart.y} Z`;
  };
  return (
    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2.5} alignItems="center" aria-label={ariaLabel}>
      <Box className="dashboard-donut">
        <svg viewBox="0 0 42 42" role="img" aria-label={ariaLabel}>
          <circle className="dashboard-donut-track" cx="21" cy="21" r="15" />
          {segments.map((segment) => (
            <Tooltip
              key={segment.id}
              arrow
              placement="top"
              classes={{ popper: 'dashboard-donut-tooltip' }}
              title={<Box><Typography variant="caption" component="div">{segment.name}</Typography><Typography variant="body2" component="div" fontWeight={700}>{money(segment.planned)}</Typography></Box>}
            >
              <g className="dashboard-donut-segment" tabIndex={0} role="img" aria-label={`${segment.name}: ${money(segment.planned)}`}>
              {segment.percentage >= 99.999
                ? <circle cx="21" cy="21" r="15" fill="none" stroke={segment.color} strokeWidth="8" />
                : <path d={segmentPath(segment.offset, segment.percentage)} fill={segment.color} />}
              </g>
            </Tooltip>
          ))}
        </svg>
        <Tooltip
          arrow
          placement="top"
          classes={{ popper: 'dashboard-donut-tooltip' }}
          title={<Box><Typography variant="caption" component="div">Общая сумма</Typography><Typography variant="body2" component="div" fontWeight={700}>{money(total)}</Typography></Box>}
        >
          <Box className="dashboard-donut-value" sx={{ inset: '43px', pointerEvents: 'auto', cursor: 'default' }}>
            <Typography variant="caption" color="text.secondary">Расчет</Typography>
            <Typography variant="subtitle2">{compactMoney(total)}</Typography>
          </Box>
        </Tooltip>
      </Box>
      <Stack spacing={1.15} className="dashboard-legend">
        {segments.map((segment) => (
          <Stack key={segment.id} className="dashboard-legend-row" direction="row" spacing={1} alignItems="center" justifyContent="space-between">
            <Stack direction="row" spacing={0.9} minWidth={0} alignItems="center" className="dashboard-legend-name">
              <Box className="dashboard-legend-dot" sx={{ backgroundColor: segment.color }} />
              {getRowHref?.(segment) ? (
                <DashboardDrillLink to={getRowHref(segment)!} title="Открыть строки в реестре">
                  <Typography variant="body2" noWrap title={segment.name}>{segment.name}</Typography>
                </DashboardDrillLink>
              ) : (
                <Typography variant="body2" noWrap title={segment.name}>{segment.name}</Typography>
              )}
              {showType && <Chip size="small" label={segment.kind === 'invest' ? 'Инвест' : 'ДДС'} className={`dashboard-type-chip dashboard-type-chip-${segment.kind}`} />}
            </Stack>
            <Stack direction="row" spacing={0.5} alignItems="center" flexShrink={0} className="dashboard-legend-values">
              <Tooltip title={money(segment.planned)} arrow><Typography variant="body2" color="text.secondary">{compactMoney(segment.planned)}</Typography></Tooltip>
              <Typography variant="body2" color="text.secondary" fontWeight={700}>{segment.percentage.toFixed(0)}%</Typography>
              {getRowHref?.(segment) ? <DashboardDrillButton to={getRowHref(segment)!} title="Открыть строки в реестре" /> : null}
            </Stack>
          </Stack>
        ))}
      </Stack>
    </Stack>
  );
}

function BudgetBars({ rows, title, emptyText, showType, showAmounts, getRowHref }: { rows: Breakdown[]; title: string; emptyText: string; showType?: boolean; showAmounts?: boolean; getRowHref?: (row: Breakdown) => string | null }) {
  const visibleRows = rows.slice(0, 5);
  const scaleMax = Math.max(...visibleRows.map((item) => Math.max(item.planned, item.approved)), 0);

  return (
    <Card className="surface dashboard-panel" elevation={0}>
      <Box className="dashboard-panel-heading">
        <Typography variant="h6">{title}</Typography>
        <Typography variant="body2" color="text.secondary">План / утверждено</Typography>
      </Box>
      {!visibleRows.length ? (
        <Box className="dashboard-empty-chart">{emptyText}</Box>
      ) : (
        <Stack spacing={2.1}>
          {visibleRows.map((row) => {
            const planned = scaleMax ? (row.planned / scaleMax) * 100 : 0;
            const approved = scaleMax ? (row.approved / scaleMax) * 100 : 0;
            const delta = row.approved - row.planned;
            return (
              <Box key={row.id}>
                <Stack direction="row" justifyContent="space-between" spacing={1.5} alignItems="baseline">
                  <Stack direction="row" spacing={0.8} alignItems="center" minWidth={0}>
                  {getRowHref?.(row) ? (
                    <DashboardDrillLink to={getRowHref(row)!} title="Открыть строки статьи в реестре">
                      <Typography variant="body2" fontWeight={650} noWrap title={row.name}>{row.name}</Typography>
                    </DashboardDrillLink>
                  ) : (
                    <Typography variant="body2" fontWeight={650} noWrap title={row.name}>{row.name}</Typography>
                  )}
                  {showType ? (
                    <Chip
                      size="small"
                      label={row.kind === 'invest' ? 'Инвест-проект' : 'Статья ДДС'}
                      className={`dashboard-type-chip dashboard-type-chip-${row.kind}`}
                    />
                  ) : null}
                  {getRowHref?.(row) ? <DashboardDrillButton to={getRowHref(row)!} title="Открыть строки статьи в реестре" /> : null}
                </Stack>
                  {showAmounts ? (
                    <Stack className="dashboard-article-amounts" spacing={0.15} alignItems="flex-end">
                      <Typography variant="caption" color="text.secondary">План: {money(row.planned)}</Typography>
                      <Typography variant="caption" color="primary.main" fontWeight={700}>Утверждено: {money(row.approved)}</Typography>
                      <Typography variant="caption" color={delta >= 0 ? 'success.main' : 'error.main'} fontWeight={700}>
                        Корректировка: {delta >= 0 ? `+${money(delta)}` : money(delta)}
                      </Typography>
                    </Stack>
                  ) : (
                    <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>{money(row.planned)}</Typography>
                  )}
                </Stack>
                <Box className="dashboard-bar-track" sx={{ mt: 0.9 }}>
                  <Box className="dashboard-bar-planned" sx={{ width: `${planned}%` }} />
                  <Box className="dashboard-bar-approved" sx={{ width: `${approved}%` }} />
                </Box>
              </Box>
            );
          })}
        </Stack>
      )}
    </Card>
  );
}

function CfoShareBars({ rows, getRowHref }: { rows: Breakdown[]; getRowHref?: (row: Breakdown) => string | null }) {
  const total = rows.reduce((sum, row) => sum + row.planned, 0);

  if (!rows.length) return <Box className="dashboard-empty-chart">Нет данных по ЦФО для выбранной статьи</Box>;

  return (
    <Box className="dashboard-cfo-bars">
      <Box className="dashboard-cfo-segmented-bar" role="img" aria-label="Распределение статьи по ЦФО">
        {rows.map((row) => {
          const share = total ? (row.planned / total) * 100 : 0;
          return (
            <Tooltip key={row.id} title={<Box><Typography variant="caption" component="div">{row.name}</Typography><Typography variant="body2" component="div" fontWeight={700}>{money(row.planned)} · {share.toFixed(1)}%</Typography></Box>} arrow>
              <Box component="span" className="dashboard-cfo-segment" sx={{ width: `${share}%`, backgroundColor: chartColorForId(row.id) }} />
            </Tooltip>
          );
        })}
      </Box>
      <Box className="dashboard-cfo-legend">
        {rows.map((row) => {
          const share = total ? (row.planned / total) * 100 : 0;
          return (
            <Stack key={row.id} className="dashboard-cfo-legend-item" direction="row" spacing={0.8} alignItems="center" minWidth={0}>
              <Box className="dashboard-legend-dot" sx={{ backgroundColor: chartColorForId(row.id) }} />
              {getRowHref?.(row) ? (
                <DashboardDrillLink to={getRowHref(row)!} title="Открыть строки ЦФО в реестре">
                  <Typography variant="body2" noWrap title={row.name} minWidth={0}>{row.name}</Typography>
                </DashboardDrillLink>
              ) : (
                <Typography variant="body2" noWrap title={row.name} minWidth={0}>{row.name}</Typography>
              )}
              <Stack direction="row" spacing={0.8} alignItems="baseline" flexShrink={0} className="dashboard-cfo-values">
                <Tooltip title={money(row.planned)} arrow>
                  <Typography variant="body2" color="text.secondary">{compactMoney(row.planned)}</Typography>
                </Tooltip>
                <Typography variant="body2" color="primary.main" fontWeight={700}>{share.toFixed(0)}%</Typography>
                {getRowHref?.(row) ? <DashboardDrillButton to={getRowHref(row)!} title="Открыть строки ЦФО в реестре" /> : null}
              </Stack>
            </Stack>
          );
        })}
      </Box>
    </Box>
  );
}

export default function DashboardPage({ user }: { user: User }) {
  const [unitId, setUnitId] = useState('');
  const [mode, setMode] = useState<'expense' | 'income'>('expense');
  const [articleFilterId, setArticleFilterId] = useState<string | null>(null);
  const [searchParams] = useSearchParams();
  const view = searchParams.get('view') === 'table' ? 'table' : 'dashboard';
  const isIncomeDashboard = mode === 'income';
  const subject = isIncomeDashboard ? 'доходов' : 'расходов';
  const { data, isLoading } = useQuery({
    queryKey: ['dashboard', mode, unitId],
    queryFn: async () => (await api.get<DashboardData>(isIncomeDashboard ? '/dashboard/income' : '/dashboard', { params: { unit_id: unitId || undefined } })).data,
  });
  const { data: articlesCfo = [], isLoading: articlesCfoLoading } = useQuery({
    queryKey: ['dashboard-articles-cfo', mode, unitId],
    queryFn: async () => (await api.get<ArticleCfoBreakdown[]>('/dashboard/articles-cfo', {
      params: { unit_id: unitId || undefined, is_income: isIncomeDashboard },
    })).data,
    enabled: view === 'dashboard',
  });

  const approvalRate = data?.totals.planned ? Math.round((data.totals.approved / data.totals.planned) * 100) : 0;
  const correction = data ? data.totals.approved - data.totals.planned : 0;
  const correctionLabel = correction === 0 ? 'Без корректировки' : correction > 0 ? 'Сумма увеличена' : 'Сумма уменьшена';
  const selectedArticleFilter = articlesCfo.find((article) => article.id === articleFilterId) || null;
  const visibleArticlesCfo = selectedArticleFilter ? [selectedArticleFilter] : articlesCfo;
  const articleRegisterHref = useMemo(() => (row: Breakdown) => {
    const articleId = row.article_id || parseArticleKey(row.id);
    if (!articleId) return null;
    if (user.role === 'economist') {
      const cfoId = row.cfo_id;
      return buildRegisterHref(user, { view: 'cfo', articleId, ...(cfoId ? { cfoId } : {}), positionedOnly: true });
    }
    return buildRegisterHref(user, { view: 'article', articleId, positionedOnly: true });
  }, [user]);
  const cfoRegisterHref = useMemo(() => (row: Breakdown) => {
    const cfoId = row.cfo_id || row.id;
    return cfoId ? buildRegisterHref(user, { view: 'cfo', cfoId, positionedOnly: true }) : null;
  }, [user]);
  const articleCfoRegisterHref = useMemo(() => (article: ArticleCfoBreakdown, cfo: Breakdown) => {
    const articleId = article.article_id || parseArticleKey(article.id);
    const cfoId = cfo.cfo_id || cfo.id;
    return articleId && cfoId
      ? buildRegisterHref(user, { view: 'cfo', articleId, cfoId, positionedOnly: true })
      : null;
  }, [user]);
  const detailView = user.role === 'economist' || user.role === 'approver' || user.role === 'zgd' ? 'cfo' : 'article';
  const metricHref = (metric: DashboardMetric) => buildRegisterHref(user, dashboardMetricFilters(metric, {
    view: detailView,
    cfoId: unitId || undefined,
    flow: isIncomeDashboard ? 'income' : 'expense',
  }));
  const requestsApprovedHref = metricHref('approved');
  const requestsReviewHref = buildRegisterHref(user, { view: detailView, requestStatus: 'on_review', cfoId: unitId || undefined, flow: isIncomeDashboard ? 'income' : 'expense', positionedOnly: true });
  const requestsAllHref = metricHref('planned');
  const frozenRequestsHref = metricHref('frozen');
  const registerHref = buildRegisterHref(user, { view: detailView, positionedOnly: true });

  if (isLoading || !data) {
    return <Skeleton variant="rounded" height={420} sx={{ borderRadius: 4 }} />;
  }

  return (
    <Stack spacing={2.5} className="dashboard-page">
      {view !== 'table' && (
        <Card className="dashboard-hero" elevation={0}>
          <Box>
            <Typography variant="h5">Сводка объединений</Typography>
            <Tabs
              value={mode}
              onChange={(_, nextMode: 'expense' | 'income') => setMode(nextMode)}
              aria-label="Тип сводки"
              sx={{ mt: 1 }}
            >
              <Tab value="expense" label="Расходы" />
              <Tab value="income" label="Доходы" />
            </Tabs>
          </Box>
          <TextField select size="small" label="Объединение" value={unitId} onChange={(event) => setUnitId(event.target.value)} className="dashboard-unit-filter">
            <MenuItem value="">Все доступные объединения</MenuItem>
            {data.scope.available_units.map((unit) => <MenuItem key={unit.id} value={unit.id}>{unit.name}</MenuItem>)}
          </TextField>
        </Card>
      )}

      {view === 'table' ? (
        <ApprovalRegister
          user={user}
          hideHeader
          flow={mode}
          tableTabs={(
            <Tabs
              value={mode}
              onChange={(_, nextMode: 'expense' | 'income') => setMode(nextMode)}
              aria-label="Тип табличного вида"
              sx={{ mt: 1 }}
            >
              <Tab value="expense" label="Расходы" />
              <Tab value="income" label="Доходы" />
            </Tabs>
          )}
        />
      ) : <>

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, sm: 6, lg: 2.4 }}><Metric title={isIncomeDashboard ? 'Доходы' : 'Расходы'} value={compactMoney(data.totals.planned)} exactValue={money(data.totals.planned)} hint="Запланированная объединениями" icon={<PaymentsOutlinedIcon fontSize="small" />} to={metricHref('planned')} /></Grid>
        <Grid size={{ xs: 12, sm: 6, lg: 2.4 }}><Metric title="Корректировка" value={`${correction > 0 ? '+' : ''}${compactMoney(correction)}`} exactValue={money(correction)} hint={correctionLabel} icon={<TrendingUpIcon fontSize="small" />} tone="purple" to={metricHref('correction')} /></Grid>
        <Grid size={{ xs: 12, sm: 6, lg: 2.4 }}><Metric title="Утверждено" value={compactMoney(data.totals.approved)} exactValue={money(data.totals.approved)} hint={`${approvalRate}% от расчета`} icon={<AssignmentTurnedInIcon fontSize="small" />} tone="green" to={metricHref('approved')} /></Grid>
        <Grid size={{ xs: 12, sm: 6, lg: 2.4 }}><Metric title="Зафиксировано" value={compactMoney(data.totals.frozen)} exactValue={money(data.totals.frozen)} hint={`${data.totals.frozen_requests_count} заявок зафиксировано`} icon={<LockOutlinedIcon fontSize="small" />} tone="amber" to={frozenRequestsHref} /></Grid>
        <Grid size={{ xs: 12, sm: 6, lg: 2.4 }}><Metric title="Обработано" value={data.totals.approved_requests_count} hint={`заявок из ${data.totals.requests_count}`} icon={<FactCheckIcon fontSize="small" />} tone="amber" to={metricHref('processed')} /></Grid>
      </Grid>

      <Grid container spacing={2.5}>
        <Grid size={{ xs: 12, lg: 7 }}>
          <Card className="surface dashboard-panel dashboard-category-panel" elevation={0}>
            <Box className="dashboard-panel-heading">
              <Box>
                <Typography variant="h6">Структура {subject}</Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.35 }}>По статьям сумм объединений и решениям экономиста</Typography>
              </Box>
              <InsightsOutlinedIcon color="primary" />
            </Box>
            <ParetoChart rows={data.by_article} total={data.totals.planned} ariaLabel={`Структура ${subject} по статьям`} showType getRowHref={articleRegisterHref} />
          </Card>
        </Grid>
        <Grid size={{ xs: 12, lg: 5 }}>
          <Card className="surface dashboard-panel" elevation={0}>
            <Box className="dashboard-panel-heading">
              <Box>
                <Typography variant="h6">ЦФО</Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.35 }}>Распределение плановых сумм по центрам финансовой ответственности</Typography>
              </Box>
              <InsightsOutlinedIcon color="primary" />
            </Box>
            <ParetoChart rows={data.by_unit} total={data.totals.planned} ariaLabel={`Парето ${subject} по ЦФО`} getRowHref={cfoRegisterHref} />
          </Card>
        </Grid>
        <Grid size={{ xs: 12, lg: 7 }}>
          <BudgetBars rows={data.by_article} title={`Ключевые статьи ${subject}`} emptyText={`Добавьте строки ${subject} в заявки, чтобы увидеть распределение`} showType showAmounts getRowHref={articleRegisterHref} />
        </Grid>
        <Grid size={{ xs: 12, lg: 5 }}>
          <Card className="surface dashboard-panel dashboard-progress-panel" elevation={0}>
            <Box className="dashboard-panel-heading">
              <Typography variant="h6">Статус согласования</Typography>
              <Button component={RouterLink} to={registerHref} target="_blank" rel="noopener noreferrer" size="small" endIcon={<ArrowOutwardIcon />} sx={{ textTransform: 'none' }}>
                Реестр заявок
              </Button>
            </Box>
            <Stack spacing={2.25}>
              <Box>
                <Stack direction="row" justifyContent="space-between"><Typography variant="body2" fontWeight={650}>Подтверждение {subject}</Typography><Typography variant="body2" color="primary.main" fontWeight={700}>{approvalRate}%</Typography></Stack>
                <LinearProgress variant="determinate" value={approvalRate} sx={{ mt: 1, height: 9, borderRadius: 9 }} />
              </Box>
              <Box className="dashboard-status-summary">
                <DashboardDrillLink to={requestsApprovedHref} title="Открыть детализацию утверждённых">
                  <Box><Typography variant="h6">{data.totals.approved_requests_count}</Typography><Typography variant="body2" color="text.secondary">утверждено</Typography></Box>
                </DashboardDrillLink>
                <DashboardDrillLink to={requestsReviewHref} title="Открыть детализацию заявок на проверке">
                  <Box><Typography variant="h6">{data.totals.review_requests_count}</Typography><Typography variant="body2" color="text.secondary">на проверке</Typography></Box>
                </DashboardDrillLink>
                <DashboardDrillLink to={requestsAllHref} title="Открыть детализацию реестра">
                  <Box><Typography variant="h6">{data.totals.requests_count}</Typography><Typography variant="body2" color="text.secondary">всего заявок</Typography></Box>
                </DashboardDrillLink>
              </Box>
            </Stack>
          </Card>
        </Grid>
        <Grid size={{ xs: 12 }}>
          <Card className="surface dashboard-panel" elevation={0}>
            <Box className="dashboard-panel-heading">
              <Box>
                <Typography variant="h6">Статьи в разрезе ЦФО</Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.35 }}>
                  Доля каждого ЦФО в плановой сумме статьи
                </Typography>
              </Box>
              <Autocomplete
                size="small"
                options={articlesCfo}
                value={selectedArticleFilter}
                onChange={(_, article) => setArticleFilterId(article?.id || null)}
                getOptionLabel={(article) => article.name}
                isOptionEqualToValue={(option, value) => option.id === value.id}
                className="dashboard-article-filter"
                renderInput={(params) => <TextField {...params} label="Найти статью" placeholder="Введите название" />}
              />
            </Box>
            {articlesCfoLoading ? (
              <Skeleton variant="rounded" height={220} sx={{ borderRadius: 3 }} />
            ) : visibleArticlesCfo.length ? (
              <Stack spacing={2.5}>
                {visibleArticlesCfo.map((article) => (
                  <Box key={article.id} className="dashboard-cfo-article">
                    <Stack direction="row" justifyContent="space-between" spacing={1.5} alignItems="baseline">
                      <Stack direction="row" spacing={0.8} alignItems="center" minWidth={0}>
                        {articleRegisterHref(article) ? (
                          <>
                            <DashboardDrillLink to={articleRegisterHref(article)!} title="Открыть строки статьи в реестре">
                              <Typography variant="body1" fontWeight={700} noWrap title={article.name}>{article.name}</Typography>
                            </DashboardDrillLink>
                            <DashboardDrillButton to={articleRegisterHref(article)!} title="Открыть строки статьи в реестре" />
                          </>
                        ) : (
                          <Typography variant="body1" fontWeight={700} noWrap title={article.name}>{article.name}</Typography>
                        )}
                        <Chip size="small" label={article.kind === 'invest' ? 'Инвест-проект' : 'Статья ДДС'} className={`dashboard-type-chip dashboard-type-chip-${article.kind}`} />
                      </Stack>
                      <Tooltip title={money(article.planned)} arrow>
                        <Typography variant="body2" color="text.secondary" fontWeight={700} flexShrink={0}>{compactMoney(article.planned)}</Typography>
                      </Tooltip>
                    </Stack>
                    <CfoShareBars rows={article.cfo} getRowHref={(cfo) => articleCfoRegisterHref(article, cfo)} />
                  </Box>
                ))}
              </Stack>
            ) : (
              <Box className="dashboard-empty-chart">Нет статей для отображения</Box>
            )}
          </Card>
        </Grid>
      </Grid>
      </>}
    </Stack>
  );
}
