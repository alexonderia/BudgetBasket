import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import FileDownloadIcon from '@mui/icons-material/FileDownload';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import TuneOutlinedIcon from '@mui/icons-material/TuneOutlined';
import UndoIcon from '@mui/icons-material/Undo';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Collapse from '@mui/material/Collapse';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormGroup from '@mui/material/FormGroup';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useAppToast } from '../components/Layout';
import { TableColumnHeader, TableColumnResizeHandle, TableColumnTools } from '../components/TableColumnControls';
import { RequestStatusBadge } from '../components/StatusBadge';
import type { BudgetItem, BudgetRequest, CatalogItem, RequestStatus, Unit, User } from '../types';
import { EXPORTABLE_REQUEST_STATUSES } from '../types';
import { downloadBlob } from '../utils/download';
import { money, requestStatusLabels } from '../utils/labels';
import { useTableColumnControls, useTableColumnWidths, type TableColumnDefinition } from '../utils/tableColumns';

function getErrorMessage(error: unknown, fallback: string) {
  const detail = (error as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
  if (detail) return detail;
  if (error instanceof Error && error.message === 'Network Error') return 'Не удалось подключиться к серверу';
  return detail || (error instanceof Error ? error.message : fallback);
}

type RequestTableColumn = 'unit' | 'status' | 'planned' | 'approved' | 'items_count' | 'actions';
type DeletePreviewColumn = 'kind' | 'name' | 'sum';
type DeletePreviewRow = {
  kind: string;
  name: string;
  sum: number;
};

const REQUEST_TABLE_COLUMN_WIDTHS: Record<RequestTableColumn, number> = {
  unit: 300,
  status: 380,
  planned: 160,
  approved: 180,
  items_count: 120,
  actions: 160,
};

const REQUEST_TABLE_COLUMN_MIN_WIDTHS: Record<RequestTableColumn, number> = {
  unit: 180,
  status: 220,
  planned: 130,
  approved: 140,
  items_count: 100,
  actions: 100,
};

export default function RequestsPage({ user }: { user: User }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useAppToast();
  const [filters, setFilters] = useState({ status: '', frozen: '' });
  const [withdrawTarget, setWithdrawTarget] = useState<BudgetRequest | null>(null);
  const [createError, setCreateError] = useState('');
  const [exportError, setExportError] = useState('');
  const [exportOpen, setExportOpen] = useState(false);
  const [expandedExportDepartments, setExpandedExportDepartments] = useState<string[]>([]);
  const [exportSettings, setExportSettings] = useState({
    statuses: [...EXPORTABLE_REQUEST_STATUSES],
    fixed_only: false,
    export_kind: 'all' as 'all' | 'expense' | 'income',
    department_ids: [] as string[],
    module_ids: [] as string[],
    include_files: false,
  });
  const [deleteTarget, setDeleteTarget] = useState<BudgetRequest | null>(null);
  const deleteTargetId = deleteTarget?.id || '';

  const { data: units = [] } = useQuery({ queryKey: ['units'], queryFn: async () => (await api.get<Unit[]>('/units')).data });
  const { data: deleteTargetRequest } = useQuery({
    queryKey: ['request-delete-preview', deleteTargetId],
    queryFn: async () => (await api.get<BudgetRequest>(`/requests/${deleteTargetId}`)).data,
    enabled: !!deleteTargetId,
  });
  const { data: deleteTargetDds = [] } = useQuery({
    queryKey: ['request-delete-preview-dds', deleteTargetId],
    queryFn: async () => (await api.get<BudgetItem[]>(`/requests/${deleteTargetId}/items`)).data.filter((item) => !!item.dds_id && item.status !== 'deleted'),
    enabled: !!deleteTargetRequest,
  });
  const { data: deleteTargetInvest = [] } = useQuery({
    queryKey: ['request-delete-preview-invest', deleteTargetId],
    queryFn: async () => (await api.get<BudgetItem[]>(`/requests/${deleteTargetId}/items`)).data.filter((item) => !!item.invest_id && item.status !== 'deleted'),
    enabled: !!deleteTargetRequest,
  });
  const { data: deleteTargetDdsCatalog = [] } = useQuery({
    queryKey: ['request-delete-preview-dds-catalog', deleteTargetRequest?.unit_id],
    queryFn: async () =>
      (
        await api.get<CatalogItem[]>('/catalog/dds', {
          params: { module_id: deleteTargetRequest?.unit_id, active_only: true },
        })
      ).data,
    enabled: !!deleteTargetRequest?.unit_id,
  });
  const { data: deleteTargetInvestCatalog = [] } = useQuery({
    queryKey: ['request-delete-preview-invest-catalog', deleteTargetRequest?.unit_id],
    queryFn: async () =>
      (
        await api.get<CatalogItem[]>('/catalog/invests', {
          params: { module_id: deleteTargetRequest?.unit_id, active_only: true },
        })
      ).data,
    enabled: !!deleteTargetRequest?.unit_id,
  });
  const { data = [] } = useQuery({
    queryKey: ['requests', filters.status],
    queryFn: async () =>
      (
        await api.get<BudgetRequest[]>('/requests', {
          params: { status: filters.status || undefined },
        })
      ).data,
  });
  const filteredRequests = useMemo(
    () => data.filter((request) => {
      if (!filters.frozen) return true;
      if (filters.frozen === 'fixed') return request.fixed;
      if (filters.frozen === 'frozen') return request.frozen && !request.fixed;
      return !request.frozen;
    }),
    [data, filters.frozen],
  );

  const allModules = units.filter((unit) => unit.type === 'department' || unit.type === 'module');
  const departments = units.filter((unit) => !unit.parent_id);
  const modulesByDepartment = useMemo(
    () => new Map(departments.map((department) => [department.id, units.filter((unit) => unit.parent_id === department.id)])),
    [departments, units],
  );
  const unitById = useMemo(() => new Map(units.map((unit) => [unit.id, unit])), [units]);
  const formatUnitName = (unitId: string | null | undefined) => units.find((unit) => unit.id === unitId)?.name || unitId || '—';
  const employeeUnitNames = useMemo(
    () => (user.unit_ids || []).map((unitId) => formatUnitName(unitId)).filter(Boolean),
    [units, user.unit_ids],
  );

  const employeeModules = useMemo(() => {
    if (user.role !== 'employee') return allModules;
    const assignedUnits = new Set(user.unit_ids || []);
    return allModules.filter((module) => {
      let current: Unit | undefined = module;
      while (current) {
        if (assignedUnits.has(current.id)) return true;
        current = current.parent_id ? unitById.get(current.parent_id) : undefined;
      }
      return false;
    });
  }, [allModules, unitById, user.role, user.unit_ids]);

  const create = useMutation({
    mutationFn: (unitId: string) => api.post<BudgetRequest>('/requests', { unit_id: unitId }),
    onSuccess: (response) => {
      setCreateError('');
      queryClient.invalidateQueries({ queryKey: ['requests'] });
      toast('Заявка создана', 'success');
      navigate(`/requests/${response.data.id}`);
    },
    onError: (error) => {
      setCreateError(getErrorMessage(error, 'Заявку не удалось создать'));
      toast('Не удалось создать заявку', 'error');
    },
  });

  const deleteRequest = useMutation({
    mutationFn: (requestId: string) => api.delete(`/requests/${requestId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['requests'] });
      toast('Заявка удалена', 'success');
      setDeleteTarget(null);
    },
    onError: (error) => {
      toast(getErrorMessage(error, 'Не удалось удалить заявку'), 'error');
    },
  });

  const withdrawRequest = useMutation({
    mutationFn: (requestId: string) => api.post(`/requests/${requestId}/withdraw`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['requests'] });
      toast('Заявка отозвана в черновик', 'success');
    },
    onError: (error) => toast(getErrorMessage(error, 'Не удалось отозвать заявку'), 'error'),
  });

  const exportClosed = async () => {
    setExportError('');
    try {
      const response = await api.get('/requests/export/closed', {
        params: {
          department_ids: exportSettings.department_ids.join(',') || undefined,
          module_ids: exportSettings.module_ids.join(',') || undefined,
          statuses: exportSettings.statuses.join(','),
          fixed_only: exportSettings.fixed_only,
          export_kind: exportSettings.export_kind,
          include_files: exportSettings.include_files,
        },
        responseType: 'blob',
      });
      const baseFilename = exportSettings.export_kind === 'income'
        ? 'Доходы_бюджета'
        : exportSettings.export_kind === 'expense'
          ? 'Расходы_бюджета'
          : exportSettings.fixed_only ? 'Зафиксированные_заявки' : 'Утверждение_бюджета';
      downloadBlob(response.data, `${baseFilename}.${exportSettings.include_files ? 'zip' : 'xlsx'}`);
      setExportOpen(false);
    } catch {
      setExportError('Нет заявок для выбранных настроек экспорта или недостаточно прав.');
    }
  };

  const exportStatusOptions: RequestStatus[] = [...EXPORTABLE_REQUEST_STATUSES, 'rejected'];

  const toggleExportStatus = (status: RequestStatus) => {
    setExportSettings((current) => ({
      ...current,
      statuses: current.statuses.includes(status)
        ? current.statuses.filter((item) => item !== status)
        : [...current.statuses, status],
    }));
  };

  const toggleExportDepartment = (departmentId: string) => {
    setExportSettings((current) => ({
      ...current,
      department_ids: current.department_ids.includes(departmentId)
        ? current.department_ids.filter((id) => id !== departmentId)
        : [...current.department_ids, departmentId],
    }));
  };

  const toggleExportModule = (moduleId: string) => {
    setExportSettings((current) => ({
      ...current,
      module_ids: current.module_ids.includes(moduleId)
        ? current.module_ids.filter((id) => id !== moduleId)
        : [...current.module_ids, moduleId],
    }));
  };

  const toggleExportDepartmentModules = (departmentId: string) => {
    setExpandedExportDepartments((current) => (
      current.includes(departmentId)
        ? current.filter((id) => id !== departmentId)
        : [...current, departmentId]
    ));
  };

  const deletePreviewRows = useMemo<DeletePreviewRow[]>(() => {
    const ddsRows = deleteTargetDds.map((item) => ({
      kind: 'ДДС',
      name: deleteTargetDdsCatalog.find((entry) => entry.id === item.dds_id)?.name || item.dds_id || '',
      sum: item.sum_plan,
    }));
    const investRows = deleteTargetInvest.map((item) => ({
      kind: 'Инвест',
      name: deleteTargetInvestCatalog.find((entry) => entry.id === item.invest_id)?.name || item.invest_id || '',
      sum: item.sum_plan,
    }));
    return [...ddsRows, ...investRows];
  }, [deleteTargetDds, deleteTargetDdsCatalog, deleteTargetInvest, deleteTargetInvestCatalog]);

  const requestTableColumns = useMemo<TableColumnDefinition<BudgetRequest, RequestTableColumn>[]>(() => [
    { id: 'unit', label: 'Объединение заявки', getValue: (item) => formatUnitName(item.unit_id) },
    { id: 'status', label: 'Статус', getValue: (item) => requestStatusLabels[item.status] || item.status },
    { id: 'planned', label: 'План', getValue: (item) => money(item.summary?.planned_sum), getSortValue: (item) => item.summary?.planned_sum ?? 0 },
    { id: 'approved', label: 'Утверждено', getValue: (item) => money(item.summary?.approved_sum ?? (item.status === 'cancelled' ? 0 : item.sum)), getSortValue: (item) => item.summary?.approved_sum ?? (item.status === 'cancelled' ? 0 : item.sum) },
    { id: 'items_count', label: 'Строк', getValue: (item) => String(item.summary?.items_count || 0), getSortValue: (item) => item.summary?.items_count || 0 },
    { id: 'actions', label: 'Действия', sortable: false, filterable: false, hideable: false, getValue: () => '' },
  ], [formatUnitName]);
  const {
    clearColumnFilter: clearRequestColumnFilter,
    clearSort: clearRequestSort,
    filterOptions: requestFilterOptions,
    filterSearchValues: requestFilterSearchValues,
    hasActiveFilters: hasActiveRequestFilters,
    resetFilters: resetRequestFilters,
    resetVisibility: resetRequestVisibility,
    rows: visibleRequests,
    selectedFilterValues: selectedRequestFilterValues,
    setAllFilterOptions: setAllRequestFilterOptions,
    setFilterSearchValue: setRequestFilterSearchValue,
    setSortAscending: setRequestSortAscending,
    setSortDescending: setRequestSortDescending,
    setVisibleFilterOptions: setRequestVisibleFilterOptions,
    sort: requestSort,
    toggleFilterOption: toggleRequestFilterOption,
    toggleVisibility: toggleRequestVisibility,
    visibility: requestVisibility,
    visibleColumns: visibleRequestColumns,
  } = useTableColumnControls({ rows: filteredRequests, columns: requestTableColumns });
  const { columnWidths: requestColumnWidths, resetColumnWidths: resetRequestColumnWidths, resizeColumn: resizeRequestColumn } = useTableColumnWidths(REQUEST_TABLE_COLUMN_WIDTHS, REQUEST_TABLE_COLUMN_MIN_WIDTHS);
  const requestTableWidth = visibleRequestColumns.reduce((sum, column) => sum + requestColumnWidths[column.id], 0);
  const renderRequestHeader = (
    columnId: RequestTableColumn,
    label: ReactNode,
    options?: { sortable?: boolean; filterable?: boolean },
  ) => (
    <TableColumnHeader
      label={label}
      sortable={options?.sortable}
      filterable={options?.filterable}
      sortDirection={requestSort?.column === columnId ? requestSort.direction : null}
      onSortAscending={() => setRequestSortAscending(columnId)}
      onSortDescending={() => setRequestSortDescending(columnId)}
      onClearSort={() => clearRequestSort(columnId)}
      filterOptions={requestFilterOptions[columnId]}
      selectedFilterValues={selectedRequestFilterValues[columnId]}
      filterSearchValue={requestFilterSearchValues[columnId]}
      onFilterSearchChange={(value) => setRequestFilterSearchValue(columnId, value)}
      onToggleFilterValue={(value) => toggleRequestFilterOption(columnId, value)}
      onSelectAllFilterValues={() => setAllRequestFilterOptions(columnId)}
      onClearColumnFilter={() => clearRequestColumnFilter(columnId)}
      onClearVisibleFilterValues={() => setRequestVisibleFilterOptions(columnId, false)}
    />
  );

  const deletePreviewColumns = useMemo<TableColumnDefinition<DeletePreviewRow, DeletePreviewColumn>[]>(() => [
    { id: 'kind', label: 'Тип', getValue: (row) => row.kind },
    { id: 'name', label: 'Статья / проект', getValue: (row) => row.name },
    { id: 'sum', label: 'План', getValue: (row) => money(row.sum), getSortValue: (row) => row.sum },
  ], []);
  const {
    clearColumnFilter: clearDeletePreviewColumnFilter,
    clearSort: clearDeletePreviewSort,
    filterOptions: deletePreviewFilterOptions,
    filterSearchValues: deletePreviewFilterSearchValues,
    hasActiveFilters: hasActiveDeletePreviewFilters,
    resetFilters: resetDeletePreviewFilters,
    resetVisibility: resetDeletePreviewVisibility,
    rows: visibleDeletePreviewRows,
    selectedFilterValues: selectedDeletePreviewFilterValues,
    setAllFilterOptions: setAllDeletePreviewFilterOptions,
    setFilterSearchValue: setDeletePreviewFilterSearchValue,
    setSortAscending: setDeletePreviewSortAscending,
    setSortDescending: setDeletePreviewSortDescending,
    setVisibleFilterOptions: setDeletePreviewVisibleFilterOptions,
    sort: deletePreviewSort,
    toggleFilterOption: toggleDeletePreviewFilterOption,
    toggleVisibility: toggleDeletePreviewVisibility,
    visibility: deletePreviewVisibility,
    visibleColumns: visibleDeletePreviewColumns,
  } = useTableColumnControls({ rows: deletePreviewRows, columns: deletePreviewColumns });
  const renderDeletePreviewHeader = (
    columnId: DeletePreviewColumn,
    label: string,
  ) => (
    <TableColumnHeader
      label={label}
      sortDirection={deletePreviewSort?.column === columnId ? deletePreviewSort.direction : null}
      onSortAscending={() => setDeletePreviewSortAscending(columnId)}
      onSortDescending={() => setDeletePreviewSortDescending(columnId)}
      onClearSort={() => clearDeletePreviewSort(columnId)}
      filterOptions={deletePreviewFilterOptions[columnId]}
      selectedFilterValues={selectedDeletePreviewFilterValues[columnId]}
      filterSearchValue={deletePreviewFilterSearchValues[columnId]}
      onFilterSearchChange={(value) => setDeletePreviewFilterSearchValue(columnId, value)}
      onToggleFilterValue={(value) => toggleDeletePreviewFilterOption(columnId, value)}
      onSelectAllFilterValues={() => setAllDeletePreviewFilterOptions(columnId)}
      onClearColumnFilter={() => clearDeletePreviewColumnFilter(columnId)}
      onClearVisibleFilterValues={() => setDeletePreviewVisibleFilterOptions(columnId, false)}
    />
  );

  return (
    <Stack spacing={3}>
      {exportError && <Alert severity="warning">{exportError}</Alert>}
      {createError && <Alert severity="error">{createError}</Alert>}

      <Paper className="surface-pad" elevation={0}>
        <Stack spacing={1.5}>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems={{ md: 'center' }} justifyContent="space-between">
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ flex: 1 }}>
              <TextField select label="Статус" value={filters.status} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))} sx={{ minWidth: 220 }}>
                <MenuItem value="">Все</MenuItem>
                {Object.entries(requestStatusLabels).map(([value, label]) => (
                  <MenuItem key={value} value={value}>
                    {label}
                  </MenuItem>
                ))}
              </TextField>
              <TextField select label="Блокировка заявки" value={filters.frozen} onChange={(event) => setFilters((current) => ({ ...current, frozen: event.target.value }))} sx={{ minWidth: 220 }}>
                <MenuItem value="">Все заявки</MenuItem>
                <MenuItem value="frozen">Замороженные экономистом</MenuItem>
                <MenuItem value="fixed">Зафиксированные ЗГД</MenuItem>
                <MenuItem value="unfrozen">Доступные для изменения</MenuItem>
              </TextField>
              <TableColumnTools
                columns={requestTableColumns}
                visibility={requestVisibility}
                onToggleColumn={toggleRequestVisibility}
                onResetColumns={resetRequestVisibility}
                onResetFilters={resetRequestFilters}
                onResetWidths={resetRequestColumnWidths}
                hasActiveFilters={hasActiveRequestFilters}
              />
            </Stack>
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              {user.role === 'employee' ? (
                <Button startIcon={<AddIcon />} variant="contained" onClick={() => employeeModules[0] && create.mutate(employeeModules[0].id)} disabled={employeeModules.length === 0 || create.isPending}>
                  Добавить заявку
                </Button>
              ) : null}
              <Button startIcon={<TuneOutlinedIcon />} variant="outlined" onClick={() => setExportOpen(true)}>
                Настроить экспорт
              </Button>
            </Stack>
          </Stack>
          {user.role === 'employee' ? (
            <Alert severity="info" variant="outlined">
              Объединение сотрудника: {employeeUnitNames.length ? employeeUnitNames.join(', ') : 'не назначено'}
            </Alert>
          ) : null}
          {['economist', 'approver', 'zgd'].includes(user.role) ? (
            <Alert severity="info" variant="outlined">
              Здесь собраны заявки вашего маршрута. Откройте заявку, чтобы просмотреть её шаги и выполнить доступное действие согласования.
            </Alert>
          ) : null}
        </Stack>
      </Paper>

      <Dialog open={exportOpen} onClose={() => setExportOpen(false)} fullWidth maxWidth="sm" className="export-dialog">
        <DialogTitle>Настройки экспорта</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2.5} sx={{ pt: 0.5 }}>
            <Stack spacing={0.5}>
              <Stack direction="row" spacing={0.5} alignItems="center">
                <Typography fontWeight={700}>Состав выгрузки</Typography>
                <Tooltip title="Выберите, включать в экспорт доходы, расходы или оба вида строк.">
                  <IconButton size="small" aria-label="Нюансы состава выгрузки"><InfoOutlinedIcon fontSize="small" /></IconButton>
                </Tooltip>
              </Stack>
              <TextField
                select
                label="Состав выгрузки"
                value={exportSettings.export_kind}
                onChange={(event) => setExportSettings((current) => ({ ...current, export_kind: event.target.value as 'all' | 'expense' | 'income' }))}
                fullWidth
                sx={{ mt: 1 }}
              >
                <MenuItem value="all">Доходы и расходы</MenuItem>
                <MenuItem value="expense">Только расходы</MenuItem>
                <MenuItem value="income">Только доходы</MenuItem>
              </TextField>
            </Stack>

            <Stack spacing={0.75}>
              <Stack direction="row" spacing={0.5} alignItems="center">
                <Typography fontWeight={700}>Объединения</Typography>
                <Tooltip title="Отметьте объединение, чтобы включить все его дочерние объединения, или отметьте только нужные. Без выбора экспортируются все доступные объединения.">
                  <IconButton size="small" aria-label="Нюансы выбора области экспорта"><InfoOutlinedIcon fontSize="small" /></IconButton>
                </Tooltip>
              </Stack>
              <FormGroup sx={{ mt: 0.5 }}>
                {departments.map((department) => {
                  const departmentSelected = exportSettings.department_ids.includes(department.id);
                  const modules = modulesByDepartment.get(department.id) || [];
                  const modulesExpanded = expandedExportDepartments.includes(department.id);
                  return (
                    <Stack key={department.id} spacing={0}>
                      <Stack direction="row" alignItems="center">
                        <FormControlLabel
                          sx={{ flex: 1, mr: 0 }}
                          control={<Checkbox checked={departmentSelected} onChange={() => toggleExportDepartment(department.id)} />}
                          label={department.name}
                        />
                        {modules.length > 0 && (
                          <IconButton
                            size="small"
                            aria-label={`${modulesExpanded ? 'Скрыть' : 'Показать'} дочерние объединения ${department.name}`}
                            onClick={() => toggleExportDepartmentModules(department.id)}
                          >
                            <ExpandMoreIcon sx={{ transform: modulesExpanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 150ms ease' }} />
                          </IconButton>
                        )}
                      </Stack>
                      <Collapse in={modulesExpanded} timeout="auto" unmountOnExit>
                        <FormGroup>
                          {modules.map((module) => (
                            <FormControlLabel
                              key={module.id}
                              sx={{ ml: 3 }}
                              control={<Checkbox checked={departmentSelected || exportSettings.module_ids.includes(module.id)} disabled={departmentSelected} onChange={() => toggleExportModule(module.id)} />}
                              label={module.name}
                            />
                          ))}
                        </FormGroup>
                      </Collapse>
                    </Stack>
                  );
                })}
              </FormGroup>
            </Stack>

            <Stack spacing={0.5}>
              <Stack direction="row" spacing={0.5} alignItems="center">
                <Typography fontWeight={700}>Заявки и статусы</Typography>
                <Tooltip title="По умолчанию выгружаются утверждённые заявки. При необходимости отдельно включите отклонённые; отменённые заявки не экспортируются.">
                  <IconButton size="small" aria-label="Нюансы статусов экспорта"><InfoOutlinedIcon fontSize="small" /></IconButton>
                </Tooltip>
              </Stack>
              <FormGroup sx={{ mt: 0.5 }}>
                {exportStatusOptions.map((status) => (
                  <FormControlLabel
                    key={status}
                    control={<Checkbox checked={exportSettings.statuses.includes(status)} onChange={() => toggleExportStatus(status)} />}
                    label={requestStatusLabels[status]}
                  />
                ))}
              </FormGroup>
              <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mt: 0.5 }}>
                <FormControlLabel
                  sx={{ mr: 0 }}
                  control={<Switch checked={exportSettings.fixed_only} onChange={(event) => setExportSettings((current) => ({ ...current, fixed_only: event.target.checked }))} />}
                  label="Экспортировать только зафиксированные заявки"
                />
                <Tooltip title="В выгрузку попадут только заявки с зафиксированным бюджетом среди выбранных статусов.">
                  <IconButton size="small" aria-label="Нюансы экспорта зафиксированных заявок"><InfoOutlinedIcon fontSize="small" /></IconButton>
                </Tooltip>
              </Stack>
            </Stack>

            <Stack spacing={0.25}>
              <Stack direction="row" spacing={0.5} alignItems="center">
                <FormControlLabel
                  sx={{ mr: 0 }}
                  control={<Switch checked={exportSettings.include_files} onChange={(event) => setExportSettings((current) => ({ ...current, include_files: event.target.checked }))} />}
                  label="Включить прикреплённые файлы"
                />
                <Tooltip title="С файлами выгружается ZIP-архив: Excel и папка вложений, разложенных по заявкам и строкам бюджета. Без файлов будет скачан только Excel.">
                  <IconButton size="small" aria-label="Нюансы выгрузки файлов"><InfoOutlinedIcon fontSize="small" /></IconButton>
                </Tooltip>
              </Stack>
            </Stack>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 2 }}>
          <Button onClick={() => setExportOpen(false)}>Отмена</Button>
          <Button
            variant="contained"
            startIcon={<FileDownloadIcon />}
            onClick={exportClosed}
            disabled={exportSettings.statuses.length === 0}
          >
            Экспортировать
          </Button>
        </DialogActions>
      </Dialog>

      <Paper className="table-surface" elevation={0}>
        <Table size="small" sx={{ width: requestTableWidth, minWidth: '100%', tableLayout: 'fixed' }}>
          <colgroup>
            {visibleRequestColumns.map((column) => <col key={column.id} style={{ width: requestColumnWidths[column.id] }} />)}
          </colgroup>
          <TableHead>
            <TableRow>
              {requestVisibility.unit && <TableCell sx={{ position: 'relative' }}>{renderRequestHeader('unit', 'Объединение заявки')}<TableColumnResizeHandle onPointerDown={(event) => resizeRequestColumn('unit', event)} /></TableCell>}
              {requestVisibility.status && <TableCell sx={{ position: 'relative' }}>{renderRequestHeader('status', 'Статус')}<TableColumnResizeHandle onPointerDown={(event) => resizeRequestColumn('status', event)} /></TableCell>}
              {requestVisibility.planned && <TableCell sx={{ position: 'relative' }}>{renderRequestHeader('planned', 'План')}<TableColumnResizeHandle onPointerDown={(event) => resizeRequestColumn('planned', event)} /></TableCell>}
              {requestVisibility.approved && <TableCell sx={{ position: 'relative' }}>{renderRequestHeader('approved', 'Утверждено')}<TableColumnResizeHandle onPointerDown={(event) => resizeRequestColumn('approved', event)} /></TableCell>}
              {requestVisibility.items_count && <TableCell sx={{ position: 'relative' }}>{renderRequestHeader('items_count', 'Строк')}<TableColumnResizeHandle onPointerDown={(event) => resizeRequestColumn('items_count', event)} /></TableCell>}
              {requestVisibility.actions && <TableCell sx={{ position: 'relative' }}>{renderRequestHeader('actions', 'Действие', { sortable: false, filterable: false })}<TableColumnResizeHandle onPointerDown={(event) => resizeRequestColumn('actions', event)} /></TableCell>}
            </TableRow>
          </TableHead>
          <TableBody>
            {visibleRequests.map((item) => {
              const canDelete = item.status === 'draft' && user.role === 'employee';
              const canWithdraw = item.status === 'on_review' && user.role === 'employee';
              const unitName = formatUnitName(item.unit_id);
              return (
                <TableRow
                  key={item.id}
                  hover
                  onClick={() => navigate(`/requests/${item.id}`)}
                  sx={{ cursor: 'pointer' }}
                  className={item.frozen ? 'fixed-request' : ''}
                >
                  {requestVisibility.unit && <TableCell>{unitName}</TableCell>}
                  {requestVisibility.status && (
                    <TableCell>
                      <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
                        <RequestStatusBadge status={item.status} />
                        {item.frozen && (
                          <Tooltip title={item.fixed ? 'Окончательно зафиксирована ЗГД' : 'Заморожена экономистом'}>
                            <LockOutlinedIcon color={item.fixed ? 'success' : 'warning'} fontSize="small" />
                          </Tooltip>
                        )}
                      </Stack>
                    </TableCell>
                  )}
                  {requestVisibility.planned && <TableCell>{money(item.summary?.planned_sum)}</TableCell>}
                  {requestVisibility.approved && <TableCell>{money(item.summary?.approved_sum ?? (item.status === 'cancelled' ? 0 : item.sum))}</TableCell>}
                  {requestVisibility.items_count && <TableCell>{item.summary?.items_count || 0}</TableCell>}
                  {requestVisibility.actions && (
                    <TableCell>
                      <Stack direction="row" spacing={0.5} justifyContent="flex-start">
                        {canWithdraw ? (
                          <Tooltip title="Отозвать в черновик">
                            <span>
                              <IconButton
                                size="small"
                                onClick={(event) => { event.stopPropagation(); setWithdrawTarget(item); }}
                                disabled={withdrawRequest.isPending}
                                aria-label="Отозвать в черновик"
                              >
                                <UndoIcon fontSize="small" />
                              </IconButton>
                            </span>
                          </Tooltip>
                        ) : null}
                        {canDelete ? (
                          <Tooltip title="Удалить">
                            <IconButton
                              size="small"
                              color="error"
                              onClick={(event) => { event.stopPropagation(); setDeleteTarget(item); }}
                              aria-label="Удалить"
                            >
                              <DeleteOutlineIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        ) : null}
                      </Stack>
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
            {visibleRequests.length === 0 && (
              <TableRow>
                <TableCell colSpan={visibleRequestColumns.length} align="center">Заявки по выбранным фильтрам не найдены</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Paper>

      <ConfirmDialog
        open={!!withdrawTarget}
        title="Отозвать заявку в черновик?"
        description="Заявка вернётся в черновик, и её строки снова станут доступны для редактирования."
        confirmLabel="Отозвать"
        pending={withdrawRequest.isPending}
        onClose={() => setWithdrawTarget(null)}
        onConfirm={() => {
          if (!withdrawTarget) return;
          withdrawRequest.mutate(withdrawTarget.id, { onSuccess: () => setWithdrawTarget(null) });
        }}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        title="Удалить заявку?"
        maxWidth="md"
        description={
          deleteTarget ? (
            <Stack spacing={1.5}>
              {deleteTargetRequest ? (
                <Typography variant="body2" color="text.secondary">
                  {deleteTargetRequest.unit_id ? `???????????? ?????????????????? ?? ??????????????????????: ${formatUnitName(deleteTargetRequest.unit_id)}` : ''}
                </Typography>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  ???????????????? ?????????????? ????????????...
                </Typography>
              )}
              {deletePreviewRows.length > 0 && (
                <Stack spacing={1}>
                  <Stack direction="row" justifyContent="flex-start">
                    <TableColumnTools
                      columns={deletePreviewColumns}
                      visibility={deletePreviewVisibility}
                      onToggleColumn={toggleDeletePreviewVisibility}
                      onResetColumns={resetDeletePreviewVisibility}
                      onResetFilters={resetDeletePreviewFilters}
                      hasActiveFilters={hasActiveDeletePreviewFilters}
                    />
                  </Stack>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        {deletePreviewVisibility.kind && <TableCell sx={{ py: 0.75 }}>{renderDeletePreviewHeader('kind', '???')}</TableCell>}
                        {deletePreviewVisibility.name && <TableCell sx={{ py: 0.75 }}>{renderDeletePreviewHeader('name', '?????? / ??????')}</TableCell>}
                        {deletePreviewVisibility.sum && <TableCell sx={{ py: 0.75 }} align="right">{renderDeletePreviewHeader('sum', '????')}</TableCell>}
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {visibleDeletePreviewRows.map((row, index) => (
                        <TableRow key={`${row.kind}-${row.name}-${index}`}>
                          {deletePreviewVisibility.kind && <TableCell sx={{ py: 0.75 }}>{row.kind}</TableCell>}
                          {deletePreviewVisibility.name && <TableCell sx={{ py: 0.75 }}>{row.name}</TableCell>}
                          {deletePreviewVisibility.sum && (
                            <TableCell sx={{ py: 0.75 }} align="right">
                              {money(row.sum)}
                            </TableCell>
                          )}
                        </TableRow>
                      ))}
                      {visibleDeletePreviewRows.length === 0 && (
                        <TableRow>
                          <TableCell sx={{ py: 0.75 }} colSpan={visibleDeletePreviewColumns.length} align="center">
                            ?????? ?? ???????
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </Stack>
              )}
            </Stack>
          ) : null
        }
        confirmLabel="Удалить"
        confirmColor="error"
        pending={deleteRequest.isPending}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && deleteRequest.mutate(deleteTarget.id)}
      />
    </Stack>
  );
}
