import AddIcon from '@mui/icons-material/Add';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import CenterFocusStrongIcon from '@mui/icons-material/CenterFocusStrong';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import DownloadIcon from '@mui/icons-material/Download';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import FactCheckIcon from '@mui/icons-material/FactCheck';
import RefreshIcon from '@mui/icons-material/Refresh';
import UndoIcon from '@mui/icons-material/Undo';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import ZoomOutIcon from '@mui/icons-material/ZoomOut';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
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
import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useAppToast } from '../components/Layout';
import { RequestStatusBadge, StepStatusBadge } from '../components/StatusBadge';
import type {
  ApprovalStep,
  StepLog,
  StepRequest,
  User,
} from '../types';
import { money, roleLabels, stepStatusLabels } from '../utils/labels';
import { downloadAuthorized } from '../utils/download';

const logActionLabels: Record<string, string> = {
  step_created: 'Шаг создан',
  step_updated: 'Шаг изменён',
  step_deleted: 'Шаг удалён',
  step_assignee_changed: 'Назначение изменено',
  step_status_changed: 'Статус изменён',
  step_edge_created: 'Связь создана',
  step_edge_deleted: 'Связь удалена',
  step_opened: 'Шаг открыт',
  step_approved: 'Шаг согласован',
  step_returned: 'Заявки возвращены',
  step_reopened: 'Шаг открыт повторно',
  approval_graph_closed: 'Маршрут закрыт',
};

const logActions = Object.keys(logActionLabels);

function errorMessage(error: unknown, fallback: string) {
  const detail = (error as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
  return detail || (error instanceof Error ? error.message : fallback);
}

function actorName(log: StepLog) {
  const profile = log.user?.profile;
  const fullName = [profile?.last_name, profile?.name, profile?.second_name].filter(Boolean).join(' ');
  return fullName || log.user?.login || 'Системное действие';
}

function StepLogsTable({ logs, technical = false }: { logs: StepLog[]; technical?: boolean }) {
  return (
    <TableContainer component={Paper} className="table-surface">
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Дата</TableCell>
            <TableCell>Пользователь</TableCell>
            <TableCell>Действие</TableCell>
            <TableCell>Изменение</TableCell>
            <TableCell>Комментарий</TableCell>
            <TableCell>Заявки</TableCell>
            {technical && <TableCell>Event ID</TableCell>}
          </TableRow>
        </TableHead>
        <TableBody>
          {logs.map((item) => {
            const statusChange = item.log.changes?.status;
            return (
              <TableRow key={item.id}>
                <TableCell sx={{ whiteSpace: 'nowrap' }}>
                  {item.created_at ? new Date(item.created_at).toLocaleString('ru-RU') : '—'}
                </TableCell>
                <TableCell>
                  <Typography variant="body2">{actorName(item)}</Typography>
                  {item.user && (
                    <Typography variant="caption" color="text.secondary">
                      {roleLabels[item.user.role]}
                    </Typography>
                  )}
                </TableCell>
                <TableCell>{logActionLabels[item.log.action] || item.log.action}</TableCell>
                <TableCell>
                  {statusChange
                    ? `${stepStatusLabels[String(statusChange.from) as keyof typeof stepStatusLabels] || statusChange.from || '—'} → ${stepStatusLabels[String(statusChange.to) as keyof typeof stepStatusLabels] || statusChange.to || '—'}`
                    : '—'}
                </TableCell>
                <TableCell sx={{ maxWidth: 320 }}>{item.log.comment || '—'}</TableCell>
                <TableCell>{item.log.request_ids?.length || 0}</TableCell>
                {technical && (
                  <TableCell>
                    <Typography variant="caption" sx={{ wordBreak: 'break-all' }}>
                      {item.log.event_id || '—'}
                    </Typography>
                  </TableCell>
                )}
              </TableRow>
            );
          })}
          {!logs.length && (
            <TableRow>
              <TableCell colSpan={technical ? 7 : 6} align="center">
                История пока пуста
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function personName(user: User | null) {
  if (!user) return 'Не назначен';
  const profile = user.profile;
  const fullName = [profile?.last_name, profile?.name, profile?.second_name].filter(Boolean).join(' ');
  return fullName || user.login;
}

function moduleName(step: ApprovalStep) {
  const cfoName = step.cfo?.name || step.unit_path.at(-2);
  const module = step.unit?.name || step.unit_path.at(-1);
  return [cfoName, module].filter(Boolean).join(' \\ ') || 'Модуль не указан';
}

function stepName(step: ApprovalStep) {
  if (step.unit_id) return moduleName(step);
  if (step.user?.role === 'zgd') return `ЗГД · ${personName(step.user)}`;
  return personName(step.user);
}

function ApprovalGraph({
  steps,
  selectedStepId,
  onSelect,
  onCreateStep,
  onAssign,
  onConnect,
}: {
  steps: ApprovalStep[];
  selectedStepId: string;
  onSelect: (stepId: string) => void;
  onCreateStep: () => void;
  onAssign: (step: ApprovalStep) => void;
  onConnect: (childStepId: string, parentStepId: string) => void;
}) {
  const [draggedChildId, setDraggedChildId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(0.75);
  const [pan, setPan] = useState({ x: 72, y: 56 });
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef({ pointerX: 0, pointerY: 0, x: 0, y: 0 });
  const layout = useMemo(() => {
    const byId = new Map(steps.map((step) => [step.id, step]));
    const depth = new Map<string, number>();
    const visiting = new Set<string>();
    const resolveDepth = (stepId: string): number => {
      if (depth.has(stepId)) return depth.get(stepId)!;
      if (visiting.has(stepId)) return 0;
      visiting.add(stepId);
      const step = byId.get(stepId);
      const childDepths = (step?.child_step_ids || []).map(resolveDepth);
      visiting.delete(stepId);
      const value = childDepths.length ? Math.max(...childDepths) + 1 : 0;
      depth.set(stepId, value);
      return value;
    };
    steps.forEach((step) => resolveDepth(step.id));
    const columns = new Map<number, ApprovalStep[]>();
    steps.forEach((step) => {
      const column = depth.get(step.id) || 0;
      columns.set(column, [...(columns.get(column) || []), step]);
    });
    const routeKey = (step: ApprovalStep): string => {
      const roots = new Set<string>();
      const collectRoots = (stepId: string, visited = new Set<string>()) => {
        if (visited.has(stepId)) return;
        visited.add(stepId);
        const current = byId.get(stepId);
        if (!current?.parent_step_ids.length) {
          roots.add(stepId);
          return;
        }
        current.parent_step_ids.forEach((parentId) => collectRoots(parentId, visited));
      };
      collectRoots(step.id);
      return [...roots].sort().join(':');
    };
    const groupKey = (step: ApprovalStep) => [
      routeKey(step),
      step.department?.name || step.unit_path[0] || '',
      step.cfo?.name || step.unit_path.at(-2) || '',
    ].join('\u0000');
    for (const column of columns.values()) {
      column.sort((left, right) => {
        const groupComparison = groupKey(left).localeCompare(groupKey(right), 'ru');
        if (groupComparison) return groupComparison;
        return (left.unit?.name || left.user?.login || '').localeCompare(right.unit?.name || right.user?.login || '', 'ru');
      });
    }
    const nodeWidth = 280;
    const nodeHeight = 208;
    const horizontalGap = 112;
    const verticalGap = 28;
    const rowSize = nodeHeight + verticalGap;
    const positions = new Map<string, { x: number; y: number }>();
    const maxDepth = Math.max(0, ...depth.values());
    const leafColumn = columns.get(0) || [];
    let leafRow = 0;
    let previousLeafGroup = '';
    leafColumn.forEach((step) => {
      const currentGroup = groupKey(step);
      if (previousLeafGroup && previousLeafGroup !== currentGroup) leafRow += 0.35;
      positions.set(step.id, { x: 112, y: 96 + leafRow * rowSize });
      previousLeafGroup = currentGroup;
      leafRow += 1;
    });

    // Position every checking node around the middle of its immediate branch.
    // This keeps a route visually readable: child modules stay together and
    // the reviewer sits between them instead of at the top of the column.
    for (let column = 1; column <= maxDepth; column += 1) {
      const columnSteps = columns.get(column) || [];
      const withPreferredY = columnSteps.map((step, index) => {
        const childY = step.child_step_ids
          .map((childId) => positions.get(childId)?.y)
          .filter((value): value is number => value !== undefined);
        return {
          step,
          preferredY: childY.length
            ? childY.reduce((total, value) => total + value, 0) / childY.length
            : 96 + index * rowSize,
        };
      }).sort((left, right) => left.preferredY - right.preferredY);

      let nextAvailableY = 96;
      withPreferredY.forEach(({ step, preferredY }) => {
        const y = Math.max(preferredY, nextAvailableY);
        positions.set(step.id, {
          x: 112 + column * (nodeWidth + horizontalGap),
          y,
        });
        nextAvailableY = y + rowSize;
      });
    }
    const maxY = Math.max(96, ...[...positions.values()].map((position) => position.y));
    return {
      positions,
      nodeWidth,
      nodeHeight,
      width: 224 + (maxDepth + 1) * nodeWidth + maxDepth * horizontalGap,
      height: maxY + nodeHeight + 96,
    };
  }, [steps]);

  if (!steps.length) {
    return <Alert severity="info">Листовые шаги появятся автоматически, когда ответственный отправит первую заявку модуля на проверку.</Alert>;
  }

  const changeZoom = (delta: number) => {
    setZoom((current) => Math.min(1.6, Math.max(0.55, Number((current + delta).toFixed(2)))));
  };
  const resetViewport = () => {
    setZoom(0.75);
    setPan({ x: 72, y: 56 });
  };
  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button, a, input, textarea, select, [draggable="true"], .approval-graph-card')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    panStart.current = { pointerX: event.clientX, pointerY: event.clientY, ...pan };
    setIsPanning(true);
  };
  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!isPanning) return;
    setPan({ x: panStart.current.x + event.clientX - panStart.current.pointerX, y: panStart.current.y + event.clientY - panStart.current.pointerY });
  };
  const stopPanning = (event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setIsPanning(false);
  };

  return (
    <>
      <Stack className="org-chart-toolbar" direction="row" spacing={0.5} alignItems="center" justifyContent="flex-end">
        <Typography className="org-chart-zoom-value" variant="caption">{Math.round(zoom * 100)}%</Typography>
        <Tooltip title="Отдалить"><span><IconButton size="small" onClick={() => changeZoom(-0.1)} disabled={zoom <= 0.55} aria-label="Отдалить граф"><ZoomOutIcon fontSize="small" /></IconButton></span></Tooltip>
        <Tooltip title="Приблизить"><span><IconButton size="small" onClick={() => changeZoom(0.1)} disabled={zoom >= 1.6} aria-label="Приблизить граф"><ZoomInIcon fontSize="small" /></IconButton></span></Tooltip>
        <Tooltip title="Сбросить масштаб и положение"><IconButton size="small" onClick={resetViewport} aria-label="Сбросить масштаб и положение графа"><CenterFocusStrongIcon fontSize="small" /></IconButton></Tooltip>
      </Stack>
      <Box
        className={`org-chart-viewport approval-chart-viewport ${isPanning ? 'is-panning' : ''}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={stopPanning}
        onPointerCancel={stopPanning}
      >
      <Box className="approval-chart-stage" sx={{ width: layout.width, minHeight: layout.height, transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})` }}>
        <svg className="approval-chart-lines" width={layout.width} height={layout.height} role="img" aria-label="Связи графа маршрута согласования">
        <defs>
          <marker id="approval-arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
            <path d="M0,0 L0,6 L9,3 z" fill="#263238" />
          </marker>
        </defs>
        {steps.flatMap((parent) => parent.child_step_ids.map((childId) => ({ parent, childId }))).map(({ parent, childId }) => {
          const child = layout.positions.get(childId);
          const parentPosition = layout.positions.get(parent.id);
          if (!child || !parentPosition) return null;
          const x1 = child.x + layout.nodeWidth;
          const y1 = child.y + layout.nodeHeight / 2;
          const x2 = parentPosition.x;
          const y2 = parentPosition.y + layout.nodeHeight / 2;
          const bend = Math.max(36, (x2 - x1) / 2);
          return <path key={`${parent.id}:${childId}`} d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`} fill="none" stroke="#263238" strokeWidth="1.7" markerEnd="url(#approval-arrow)" />;
        })}
        </svg>
        {steps.map((step) => {
          const position = layout.positions.get(step.id)!;
          const isLeaf = Boolean(step.unit_id);
          const isSelected = step.id === selectedStepId;
          return (
            <Card
              key={step.id}
              className={`approval-graph-card ${isLeaf ? 'is-leaf' : 'is-review'} ${isSelected ? 'is-selected' : ''}`}
              onClick={() => onSelect(step.id)}
              onDragOver={(event) => {
                if (draggedChildId && draggedChildId !== step.id && !isLeaf) event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (draggedChildId && draggedChildId !== step.id && !isLeaf) onConnect(draggedChildId, step.id);
                setDraggedChildId(null);
              }}
              sx={{ left: position.x, top: position.y, width: layout.nodeWidth, height: layout.nodeHeight, overflow: 'visible' }}
            >
              <Stack spacing={0.75} sx={{ p: 1.5, height: '100%' }}>
                <Stack spacing={0.5} alignItems="flex-start">
                  <Typography variant="subtitle2" fontWeight={800} sx={{ lineHeight: 1.3 }}>
                    {isLeaf ? moduleName(step) : step.user?.role === 'zgd' ? 'ЗГД' : 'Проверяющий'}
                  </Typography>
                  <Chip
                    size="small"
                    variant="outlined"
                    label={isLeaf ? 'Проверка экономистом' : step.user?.role === 'zgd' ? 'Финальное утверждение' : 'Согласование'}
                  />
                </Stack>
                {isLeaf ? (
                  <>
                    <Tooltip title={step.department?.name || 'Подразделение не указано'}>
                      <Typography variant="caption" color="text.secondary" noWrap><strong>Подразделение:</strong> {step.department?.name || '—'}</Typography>
                    </Tooltip>
                    <Typography variant="body2"><strong>Ответственный:</strong> {personName(step.responsible)}</Typography>
                    <Typography variant="body2"><strong>Экономист:</strong> {personName(step.user)}</Typography>
                  </>
                ) : (
                  <>
                    <Typography variant="body2" color="text.secondary">Назначенный проверяющий</Typography>
                    <Typography variant="body2" fontWeight={700}>{personName(step.user)}</Typography>
                  </>
                )}
                <Stack direction="row" justifyContent="flex-end" spacing={0.5} mt="auto">
                  {!isLeaf && (
                    <Tooltip title="Назначить проверяющего">
                      <IconButton size="small" onClick={(event) => { event.stopPropagation(); onAssign(step); }} aria-label="Назначить проверяющего">
                        <EditOutlinedIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  )}
                  <Tooltip title="Создать самостоятельный шаг">
                    <IconButton size="small" color="primary" onClick={(event) => { event.stopPropagation(); onCreateStep(); }} aria-label="Создать самостоятельный шаг">
                      <AddIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </Stack>
                <Tooltip title="Потяните стрелку на проверяющего или ЗГД, чтобы создать связь">
                  <Box
                    className={`approval-graph-link-handle ${draggedChildId === step.id ? 'is-dragging' : ''}`}
                    draggable
                    onDragStart={(event) => {
                      event.stopPropagation();
                      event.dataTransfer.effectAllowed = 'link';
                      event.dataTransfer.setData('text/plain', step.id);
                      setDraggedChildId(step.id);
                    }}
                    onDragEnd={() => setDraggedChildId(null)}
                    aria-label="Связать шаг перетаскиванием"
                  >
                    <ArrowForwardIcon fontSize="small" />
                  </Box>
                </Tooltip>
              </Stack>
            </Card>
          );
        })}
      </Box>
    </Box>
      <Typography className="org-chart-pan-hint" variant="caption">Зажмите пустую область и перетащите граф. Используйте кнопки справа для масштаба.</Typography>
    </>
  );
}

function AdminApprovalPage() {
  const toast = useAppToast();
  const queryClient = useQueryClient();
  const [parentStepId, setParentStepId] = useState('');
  const [childStepId, setChildStepId] = useState('');
  const [selectedStepId, setSelectedStepId] = useState('');
  const [stepDialog, setStepDialog] = useState<
    | { kind: 'create' }
    | { kind: 'assign'; step: ApprovalStep }
    | null
  >(null);
  const [dialogUserId, setDialogUserId] = useState('');
  const [logAction, setLogAction] = useState('');
  const [logUserId, setLogUserId] = useState('');
  const [validation, setValidation] = useState<{
    valid: boolean;
    errors: string[];
    root_step_id: string | null;
  } | null>(null);

  const { data: steps = [] } = useQuery({
    queryKey: ['approval-steps'],
    queryFn: async () => (await api.get<ApprovalStep[]>('/steps')).data,
  });
  const { data: users = [] } = useQuery({
    queryKey: ['users'],
    queryFn: async () => (await api.get<User[]>('/users')).data,
  });
  const { data: logs = [] } = useQuery({
    queryKey: ['step-logs', logAction, logUserId],
    queryFn: async () => (
      await api.get<StepLog[]>('/step-logs', {
        params: {
          action: logAction || undefined,
          user_id: logUserId || undefined,
        },
      })
    ).data,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['approval-steps'] });
    queryClient.invalidateQueries({ queryKey: ['step-logs'] });
  };

  const createStep = useMutation({
    mutationFn: async ({ userId }: { userId: string }) => {
      return (await api.post<ApprovalStep>('/steps', { user_id: userId })).data;
    },
    onSuccess: () => {
      toast('Шаг создан. Свяжите его, перетащив стрелку из дочернего шага.', 'success');
      setStepDialog(null);
      setDialogUserId('');
      refresh();
    },
    onError: (error) => toast(errorMessage(error, 'Не удалось создать шаг'), 'error'),
  });
  const patchStep = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, string | null> }) => api.patch(`/steps/${id}`, patch),
    onSuccess: () => {
      toast('Назначение шага обновлено', 'success');
      setStepDialog(null);
      setDialogUserId('');
      refresh();
    },
    onError: (error) => toast(errorMessage(error, 'Не удалось обновить шаг'), 'error'),
  });
  const deleteStep = useMutation({
    mutationFn: (id: string) => api.delete(`/steps/${id}`),
    onSuccess: () => {
      toast('Шаг удалён', 'success');
      refresh();
    },
    onError: (error) => toast(errorMessage(error, 'Не удалось удалить шаг'), 'error'),
  });
  const createEdge = useMutation({
    mutationFn: (edge: { parent_step_id: string; child_step_id: string }) => api.post('/step-edges', edge),
    onSuccess: () => {
      toast('Связь создана', 'success');
      setParentStepId('');
      setChildStepId('');
      refresh();
    },
    onError: (error) => toast(errorMessage(error, 'Не удалось создать связь'), 'error'),
  });
  const deleteEdge = useMutation({
    mutationFn: (edge: { parent_step_id: string; child_step_id: string }) => api.delete('/step-edges', { data: edge }),
    onSuccess: () => {
      toast('Связь удалена', 'success');
      refresh();
    },
    onError: (error) => toast(errorMessage(error, 'Не удалось удалить связь'), 'error'),
  });
  const validate = useMutation({
    mutationFn: () => api.post('/steps/validate'),
    onSuccess: (response) => {
      setValidation(response.data);
      toast(response.data.valid ? 'Маршрут валиден' : 'В маршруте есть ошибки', response.data.valid ? 'success' : 'warning');
    },
    onError: (error) => toast(errorMessage(error, 'Не удалось проверить маршрут'), 'error'),
  });
  const bootstrapReviewed = useMutation({
    mutationFn: () => api.post<{ created: { step_id: string }[]; skipped: { unit_id: string; reason: string }[] }>('/steps/bootstrap-reviewed'),
    onSuccess: (response) => {
      const { created, skipped } = response.data;
      toast(
        created.length ? `Добавлено листовых шагов: ${created.length}` : 'Новых проверенных заявок для добавления нет',
        created.length ? 'success' : 'info',
      );
      if (skipped.length) toast(`Пропущено модулей: ${skipped.length}`, 'warning');
      refresh();
    },
    onError: (error) => toast(errorMessage(error, 'Не удалось подготовить проверенные заявки'), 'error'),
  });

  const eligibleUsers = users.filter((item) => ['approver', 'zgd'].includes(item.role));
  const stepNames = useMemo(() => new Map(steps.map((step) => [step.id, stepName(step)])), [steps]);
  const edges = steps.flatMap((parent) => parent.child_step_ids.map((child) => ({
    parent_step_id: parent.id,
    child_step_id: child,
  })));
  const dialogUsers = stepDialog?.kind === 'assign'
    ? eligibleUsers.filter((item) => item.role === stepDialog.step.user?.role)
    : eligibleUsers;
  const openCreateStep = () => {
    setDialogUserId('');
    setStepDialog({ kind: 'create' });
  };
  const openAssign = (step: ApprovalStep) => {
    setDialogUserId(step.user_id);
    setStepDialog({ kind: 'assign', step });
  };

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h5">Маршрут согласования</Typography>
        <Typography color="text.secondary" sx={{ mt: 0.5 }}>
          Согласование бюджета организаций на 2027 год
        </Typography>
      </Box>

      {validation && (
        <Alert severity={validation.valid ? 'success' : 'warning'}>
          {validation.valid
            ? `Маршрут валиден. Корневой шаг: ${validation.root_step_id?.slice(0, 8)}`
            : validation.errors.join(' · ')}
        </Alert>
      )}

      <Paper className="surface-pad">
        <Stack spacing={1.5}>
          <Typography variant="h6">Граф шагов</Typography>
          <Typography variant="body2" color="text.secondary">
            Стрелка показывает движение заявки: от модуля и экономиста к проверяющим, затем к ЗГД. Потяните стрелку справа от карточки на проверяющего или ЗГД, чтобы создать связь.
          </Typography>
          <ApprovalGraph
            steps={steps}
            selectedStepId={selectedStepId}
            onSelect={setSelectedStepId}
            onCreateStep={openCreateStep}
            onAssign={openAssign}
            onConnect={(childStepId, parentStepId) => createEdge.mutate({ child_step_id: childStepId, parent_step_id: parentStepId })}
          />
        </Stack>
      </Paper>

      <TableContainer component={Paper} className="table-surface">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Назначенный пользователь</TableCell>
              <TableCell>Роль</TableCell>
              <TableCell>Подразделение</TableCell>
              <TableCell>Ответственный</TableCell>
              <TableCell>Родители</TableCell>
              <TableCell>Дети</TableCell>
              <TableCell align="right">Действия</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {steps.map((step) => (
              <TableRow key={step.id} selected={step.id === selectedStepId} onClick={() => setSelectedStepId(step.id)} sx={{ cursor: 'pointer' }}>
                <TableCell sx={{ minWidth: 210 }}>
                  {step.unit_id ? (
                    <Typography variant="body2">{personName(step.user)}</Typography>
                  ) : (
                    <TextField
                      select
                      size="small"
                      value={step.user_id}
                      onChange={(event) => patchStep.mutate({ id: step.id, patch: { user_id: event.target.value } })}
                      fullWidth
                    >
                      {eligibleUsers.map((item) => (
                        <MenuItem key={item.id} value={item.id}>{personName(item)}</MenuItem>
                      ))}
                    </TextField>
                  )}
                </TableCell>
                <TableCell>{step.user ? roleLabels[step.user.role] : '—'}</TableCell>
                <TableCell>{step.unit_id ? moduleName(step) : '—'}</TableCell>
                <TableCell>{step.unit_id ? personName(step.responsible) : '—'}</TableCell>
                <TableCell>{step.parent_step_ids.map((id) => stepNames.get(id) || id.slice(0, 8)).join(', ') || '—'}</TableCell>
                <TableCell>{step.child_step_ids.map((id) => stepNames.get(id) || id.slice(0, 8)).join(', ') || '—'}</TableCell>
                <TableCell align="right">
                  <Tooltip title="Удалить шаг">
                    <IconButton
                      color="error"
                      onClick={() => {
                        if (window.confirm('Удалить шаг и его связи?')) deleteStep.mutate(step.id);
                      }}
                    >
                      <DeleteOutlineIcon />
                    </IconButton>
                  </Tooltip>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      <Paper className="surface-pad">
        <Stack spacing={2}>
          <Typography variant="h6">Связи графа</Typography>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
            <TextField select label="Родительский шаг" value={parentStepId} onChange={(event) => setParentStepId(event.target.value)} fullWidth>
              {steps.map((step) => <MenuItem key={step.id} value={step.id}>{stepNames.get(step.id)}</MenuItem>)}
            </TextField>
            <TextField select label="Дочерний шаг" value={childStepId} onChange={(event) => setChildStepId(event.target.value)} fullWidth>
              {steps.map((step) => <MenuItem key={step.id} value={step.id}>{stepNames.get(step.id)}</MenuItem>)}
            </TextField>
            <Button
              variant="outlined"
              onClick={() => createEdge.mutate({ parent_step_id: parentStepId, child_step_id: childStepId })}
              disabled={!parentStepId || !childStepId || createEdge.isPending}
              sx={{ minWidth: 180 }}
            >
              Создать связь
            </Button>
          </Stack>
          <Stack direction="row" gap={1} flexWrap="wrap">
            {edges.map((edge) => (
              <Chip
                key={`${edge.parent_step_id}:${edge.child_step_id}`}
                label={`${stepNames.get(edge.child_step_id)} → ${stepNames.get(edge.parent_step_id)}`}
                onDelete={() => deleteEdge.mutate(edge)}
              />
            ))}
            {!edges.length && <Typography color="text.secondary">Связей пока нет</Typography>}
          </Stack>
          <Box>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.25} alignItems={{ sm: 'center' }}>
              <Button
                variant="contained"
                color="secondary"
                startIcon={validate.isPending ? <CircularProgress size={18} /> : <FactCheckIcon />}
                onClick={() => validate.mutate()}
                disabled={validate.isPending}
              >
                Проверить валидность графа
              </Button>
              <Button
                variant="outlined"
                onClick={() => bootstrapReviewed.mutate()}
                disabled={bootstrapReviewed.isPending}
              >
                Добавить уже проверенные заявки
              </Button>
            </Stack>
          </Box>
        </Stack>
      </Paper>

      <Stack spacing={2}>
        <Typography variant="h6">Журнал маршрута</Typography>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          <TextField select label="Действие" value={logAction} onChange={(event) => setLogAction(event.target.value)} sx={{ minWidth: 260 }}>
            <MenuItem value="">Все действия</MenuItem>
            {logActions.map((action) => <MenuItem key={action} value={action}>{logActionLabels[action]}</MenuItem>)}
          </TextField>
          <TextField select label="Пользователь" value={logUserId} onChange={(event) => setLogUserId(event.target.value)} sx={{ minWidth: 240 }}>
            <MenuItem value="">Все пользователи</MenuItem>
            {users.map((item) => <MenuItem key={item.id} value={item.id}>{personName(item)}</MenuItem>)}
          </TextField>
          <Button startIcon={<RefreshIcon />} onClick={refresh}>Обновить</Button>
        </Stack>
        <StepLogsTable logs={logs} technical />
      </Stack>

      <Dialog open={Boolean(stepDialog)} onClose={() => setStepDialog(null)} fullWidth maxWidth="xs">
        <DialogTitle>
          {stepDialog?.kind === 'assign' ? 'Назначить проверяющего' : 'Добавить шаг'}
        </DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2} sx={{ pt: 1 }}>
            {stepDialog?.kind === 'create' && (
              <Alert severity="info">
                Новый шаг создаётся отдельно. Затем перетащите стрелку из дочерней карточки на него, чтобы задать связь.
              </Alert>
            )}
            <TextField
              select
              label={stepDialog?.kind === 'assign' ? 'Проверяющий' : 'Пользователь нового шага'}
              value={dialogUserId}
              onChange={(event) => setDialogUserId(event.target.value)}
              fullWidth
              autoFocus
            >
              {dialogUsers.map((item) => (
                <MenuItem key={item.id} value={item.id}>
                  {personName(item)} · {roleLabels[item.role]}
                </MenuItem>
              ))}
            </TextField>
            {!dialogUsers.length && <Alert severity="warning">Сначала создайте пользователя с ролью «Согласующий» или «ЗГД».</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setStepDialog(null)}>Отмена</Button>
          {stepDialog?.kind === 'assign' ? (
            <Button
              variant="contained"
              disabled={!dialogUserId || patchStep.isPending}
              onClick={() => patchStep.mutate({ id: stepDialog.step.id, patch: { user_id: dialogUserId } })}
            >
              Назначить
            </Button>
          ) : (
            <Button
              variant="contained"
              disabled={!dialogUserId || createStep.isPending}
              onClick={() => createStep.mutate({ userId: dialogUserId })}
            >
              Создать шаг
            </Button>
          )}
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

type StepDashboard = {
  totals: {
    planned: number;
    approved: number;
    requests_count: number;
    fixed_requests_count: number;
  };
  by_unit: {
    unit_id: string;
    name: string;
    planned: number;
    approved: number;
    requests_count: number;
  }[];
};

function UserApprovalPage({ user }: { user: User }) {
  const toast = useAppToast();
  const queryClient = useQueryClient();
  const [stepId, setStepId] = useState('');
  const [childStepId, setChildStepId] = useState('');
  const [selectedRequestIds, setSelectedRequestIds] = useState<string[]>([]);
  const [comment, setComment] = useState('');

  const { data: steps = [], isLoading } = useQuery({
    queryKey: ['my-approval-steps'],
    queryFn: async () => (await api.get<ApprovalStep[]>('/steps/my')).data,
  });
  useEffect(() => {
    if (!stepId && steps.length) setStepId(steps[0].id);
    if (stepId && !steps.some((step) => step.id === stepId)) setStepId(steps[0]?.id || '');
  }, [stepId, steps]);
  const selectedStep = steps.find((step) => step.id === stepId);

  const { data: requests = [] } = useQuery({
    queryKey: ['step-requests', stepId],
    queryFn: async () => (await api.get<StepRequest[]>(`/steps/${stepId}/requests`)).data,
    enabled: !!stepId,
  });
  const { data: dashboard } = useQuery({
    queryKey: ['step-dashboard', stepId],
    queryFn: async () => (await api.get<StepDashboard>(`/steps/${stepId}/dashboard`)).data,
    enabled: !!stepId,
  });
  const { data: logs = [] } = useQuery({
    queryKey: ['step-logs', stepId],
    queryFn: async () => (await api.get<StepLog[]>(`/steps/${stepId}/logs`)).data,
    enabled: !!stepId,
  });

  useEffect(() => {
    setSelectedRequestIds([]);
    setComment('');
    setChildStepId('');
  }, [stepId]);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['my-approval-steps'] });
    queryClient.invalidateQueries({ queryKey: ['step-requests'] });
    queryClient.invalidateQueries({ queryKey: ['step-dashboard'] });
    queryClient.invalidateQueries({ queryKey: ['step-logs'] });
    queryClient.invalidateQueries({ queryKey: ['requests'] });
  };

  const approve = useMutation({
    mutationFn: () => api.post(`/steps/${stepId}/approve`),
    onSuccess: () => {
      toast(user.role === 'zgd' ? 'Бюджет окончательно зафиксирован' : 'Шаг согласован', 'success');
      refresh();
    },
    onError: (error) => toast(errorMessage(error, 'Не удалось согласовать шаг'), 'error'),
  });
  const returnRequests = useMutation({
    mutationFn: () => api.post(
      `/steps/${stepId}/return`,
      selectedStep?.unit_id
        ? { request_ids: selectedRequestIds, comment }
        : {
            targets: [{ child_step_id: childStepId, request_ids: selectedRequestIds }],
            comment,
          },
    ),
    onSuccess: () => {
      toast(selectedStep?.unit_id ? 'Заявки разморожены и возвращены сотруднику' : 'Заявки переданы на нижестоящий шаг', 'success');
      setSelectedRequestIds([]);
      setComment('');
      refresh();
    },
    onError: (error) => toast(errorMessage(error, 'Не удалось вернуть заявки'), 'error'),
  });

  const childLabels = useMemo(() => new Map(steps.map((step) => [step.id, stepName(step)])), [steps]);
  const returnableRequests = requests.filter((item) => ['on_approval', 'on_revision'].includes(item.approval_status));
  const allSelected = returnableRequests.length > 0 && selectedRequestIds.length === returnableRequests.length;
  const returnReady = selectedRequestIds.length > 0
    && comment.trim().length > 0
    && (!!selectedStep?.unit_id || !!childStepId);
  const isLeaf = Boolean(selectedStep?.unit_id);
  const isFinal = selectedStep?.user?.role === 'zgd';
  const allDelivered = requests.length > 0 && requests.every((item) => item.approval_status === 'on_approval');
  const allReviewed = allDelivered && requests.every((item) => item.reviewed_at_step);
  const canForwardPackage = !isLeaf && !isFinal && allDelivered && allReviewed;

  if (isLoading) return <CircularProgress />;
  if (!steps.length) {
    return <Alert severity="info">Вам пока не назначены шаги согласования.</Alert>;
  }

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h5">
          {user.role === 'economist' ? 'Проверка заявок' : 'Согласование бюджета'}
        </Typography>
        <Typography color="text.secondary" sx={{ mt: 0.5 }}>
          Согласование бюджета организаций на 2027 год
        </Typography>
      </Box>

      <Paper className="surface-pad">
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems={{ md: 'center' }}>
          <TextField
            select
            label="Шаг"
            value={stepId}
            onChange={(event) => setStepId(event.target.value)}
            sx={{ minWidth: 320 }}
          >
            {steps.map((step) => (
              <MenuItem key={step.id} value={step.id}>
                {stepName(step)} · {stepStatusLabels[step.status]}
              </MenuItem>
            ))}
          </TextField>
          {selectedStep && <StepStatusBadge status={selectedStep.status} />}
          <Box flex={1} />
          <Button
            startIcon={<DownloadIcon />}
            onClick={() => downloadAuthorized(`/steps/${stepId}/export`, `budget_step_${stepId.slice(0, 8)}.xlsx`)}
            disabled={!requests.length}
          >
            Экспорт
          </Button>
          {!isLeaf && !isFinal && (
            <Button
              variant="contained"
              startIcon={<FactCheckIcon />}
              disabled={!canForwardPackage || approve.isPending}
              onClick={() => approve.mutate()}
            >
              Передать проверенный пакет дальше
            </Button>
          )}
        </Stack>
      </Paper>

      {selectedStep?.status === 'waiting' && (
        <Alert severity="info">На этот этап пока не переданы заявки. Проверка станет доступна после их поступления.</Alert>
      )}
      {selectedStep?.status === 'on_revision' && (
        <Alert severity="warning">
          Шаг находится на доработке. Передайте выбранные заявки дальше вниз с комментарием.
        </Alert>
      )}
      {!isLeaf && !isFinal && requests.length > 0 && (
        <Alert severity={canForwardPackage ? 'success' : 'info'}>
          {canForwardPackage
            ? 'Все заявки маршрута поступили и подтверждены. Их можно передать дальше одним пакетом.'
            : `Передача пакета пока недоступна: поступило ${requests.filter((item) => item.approval_status === 'on_approval').length} из ${requests.length}, подтверждено ${requests.filter((item) => item.reviewed_at_step).length} из ${requests.length}.`}
        </Alert>
      )}

      {dashboard && (
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
          {[
            ['Заявок', dashboard.totals.requests_count],
            ['План', money(dashboard.totals.planned)],
            ['Утверждено', money(dashboard.totals.approved)],
            ['Зафиксировано', dashboard.totals.fixed_requests_count],
          ].map(([label, value]) => (
            <Card key={label} className="metric-card" sx={{ p: 2.25, flex: 1 }}>
              <Typography variant="caption" color="text.secondary">{label}</Typography>
              <Typography variant="h6" sx={{ mt: 0.5 }}>{value}</Typography>
            </Card>
          ))}
        </Stack>
      )}

      <Stack spacing={2}>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Typography variant="h6">Заявки шага</Typography>
          <FormControlLabel
            control={(
              <Checkbox
                checked={allSelected}
                indeterminate={selectedRequestIds.length > 0 && !allSelected}
                onChange={(_, checked) => setSelectedRequestIds(checked ? returnableRequests.map((item) => item.id) : [])}
              />
            )}
            label="Выбрать все"
          />
        </Stack>
        <TableContainer component={Paper} className="table-surface">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell padding="checkbox" />
                <TableCell>Заявка</TableCell>
                <TableCell>Подразделение</TableCell>
                <TableCell>Статус</TableCell>
                <TableCell>На этом этапе</TableCell>
                <TableCell>Проверка</TableCell>
                <TableCell align="right">План</TableCell>
                <TableCell align="right">Утверждено</TableCell>
                <TableCell>Проверка строк</TableCell>
                <TableCell>Блокировка</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {requests.map((item) => (
                <TableRow key={item.id} hover>
                  <TableCell padding="checkbox">
                    <Checkbox
                      checked={selectedRequestIds.includes(item.id)}
                      disabled={!returnableRequests.some((request) => request.id === item.id)}
                      onChange={(_, checked) => setSelectedRequestIds((current) => (
                        checked ? [...current, item.id] : current.filter((id) => id !== item.id)
                      ))}
                    />
                  </TableCell>
                  <TableCell>
                    <Typography component={Link} to={`/requests/${item.id}`} color="primary" sx={{ textDecoration: 'none' }}>
                      {item.id.slice(0, 8)}
                    </Typography>
                  </TableCell>
                  <TableCell>{item.unit?.name || '—'}</TableCell>
                  <TableCell>{item.status}</TableCell>
                  <TableCell><StepStatusBadge status={item.approval_status} /></TableCell>
                  <TableCell>{item.reviewed_at_step ? 'Подтверждена' : item.approval_status === 'on_approval' ? 'Ожидает проверки' : '—'}</TableCell>
                  <TableCell align="right">{money(item.sum_plan)}</TableCell>
                  <TableCell align="right">{money(item.sum_fact)}</TableCell>
                  <TableCell>{item.reviewed_items_count} / {item.items_count}</TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={0.5}>
                      {item.frozen && <Chip size="small" label="Заморожена" color="warning" variant="outlined" />}
                      {item.fixed && <Chip size="small" label="Зафиксирована ЗГД" color="success" variant="outlined" />}
                    </Stack>
                  </TableCell>
                </TableRow>
              ))}
              {!requests.length && (
                <TableRow>
                  <TableCell colSpan={10} align="center">Для шага пока нет доступных заявок</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Stack>

      <Paper className="surface-pad">
        <Stack spacing={2}>
          <Typography variant="h6">
            {selectedStep?.unit_id ? 'Вернуть сотруднику и разморозить' : 'Вернуть на нижестоящий шаг'}
          </Typography>
          {!selectedStep?.unit_id && (
            <TextField
              select
              label="Непосредственная дочерняя ветка"
              value={childStepId}
              onChange={(event) => setChildStepId(event.target.value)}
              fullWidth
            >
              {selectedStep?.child_step_ids.map((id) => (
                <MenuItem key={id} value={id}>{childLabels.get(id) || id.slice(0, 8)}</MenuItem>
              ))}
            </TextField>
          )}
          <TextField
            label="Комментарий ко всей заявке"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            multiline
            minRows={3}
            required
            helperText="Комментарий будет сохранён в истории шага и каждой выбранной заявки."
          />
          <Box>
            <Button
              variant="outlined"
              color="warning"
              startIcon={<UndoIcon />}
              onClick={() => returnRequests.mutate()}
              disabled={!returnReady || returnRequests.isPending || !['on_approval', 'on_revision'].includes(selectedStep?.status || '')}
            >
              Передать на доработку
            </Button>
          </Box>
        </Stack>
      </Paper>

      <Stack spacing={2}>
        <Typography variant="h6">История шага</Typography>
        <StepLogsTable logs={logs} />
      </Stack>
    </Stack>
  );
}

function ApprovalTaskStep({ step }: { step: ApprovalStep }) {
  const { data: requests = [], isLoading } = useQuery({
    queryKey: ['step-requests', step.id],
    queryFn: async () => (await api.get<StepRequest[]>(`/steps/${step.id}/requests`)).data,
  });
  const stepName = step.unit?.name || step.user?.login || step.id.slice(0, 8);

  return (
    <Paper className="surface-pad" elevation={0}>
      <Stack spacing={1.5}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} justifyContent="space-between" alignItems={{ sm: 'center' }}>
          <Box>
            <Typography variant="h6">{stepName}</Typography>
            <Typography variant="body2" color="text.secondary">
              {step.active_requests_count || 0} {step.active_requests_count === 1 ? 'заявка ожидает' : 'заявок ожидают'} вашего решения
            </Typography>
          </Box>
          <StepStatusBadge status={step.status} />
        </Stack>
        {isLoading ? <CircularProgress size={24} /> : (
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Заявка</TableCell>
                  <TableCell>Подразделение</TableCell>
                  <TableCell>Результат экономиста</TableCell>
                  <TableCell>Ваш шаг</TableCell>
                  <TableCell align="right">План</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {requests.map((request) => (
                  <TableRow key={request.id} hover component={Link} to={`/requests/${request.id}`} sx={{ textDecoration: 'none', color: 'inherit', cursor: 'pointer' }}>
                    <TableCell><Typography color="primary">{request.id.slice(0, 8)}</Typography></TableCell>
                    <TableCell>{request.unit?.name || '—'}</TableCell>
                    <TableCell><RequestStatusBadge status={request.status} /></TableCell>
                    <TableCell><StepStatusBadge status={request.approval_status} /></TableCell>
                    <TableCell align="right">{money(request.sum_plan)}</TableCell>
                  </TableRow>
                ))}
                {!requests.length && (
                  <TableRow><TableCell colSpan={5} align="center">Заявок, ожидающих действий, нет</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Stack>
    </Paper>
  );
}

function SimpleUserApprovalPage({ user }: { user: User }) {
  const { data: steps = [], isLoading } = useQuery({
    queryKey: ['my-approval-steps'],
    queryFn: async () => (await api.get<ApprovalStep[]>('/steps/my')).data,
  });

  if (isLoading) return <CircularProgress />;
  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h5">Мои задачи</Typography>
        <Typography color="text.secondary" sx={{ mt: 0.5 }}>
          Здесь только заявки, которые сейчас ожидают вашей проверки или возврата на доработку.
        </Typography>
      </Box>
      {!steps.length ? (
        <Alert severity="success">Нет заявок, ожидающих ваших действий.</Alert>
      ) : (
        steps.map((step) => <ApprovalTaskStep key={step.id} step={step} />)
      )}
    </Stack>
  );
}

export default function ApprovalPage({ user }: { user: User }) {
  return user.role === 'admin' ? <AdminApprovalPage /> : <UserApprovalPage user={user} />;
}
