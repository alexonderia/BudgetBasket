import FactCheckOutlinedIcon from '@mui/icons-material/FactCheckOutlined';
import ForumOutlinedIcon from '@mui/icons-material/ForumOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { type ReactNode, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { CfoRequestReviewDialog } from '../components/CfoRequestReviewDialog';
import type {
  ApprovalStep,
  BudgetItem,
  BudgetRequest,
  CfoPositionComment,
  CfoPosition,
  ItemStatus,
  User,
} from '../types';

const positionStatus: Record<string, string> = {
  waiting: 'Ожидает передачи',
  on_review: 'На проверке',
  on_approval: 'На согласовании',
  approved: 'Проверена',
  on_revision: 'На доработке',
};

const itemStatus: Record<string, string> = {
  on_review: 'Без решения',
  approved: 'Одобрено',
  approved_with_changes: 'Одобрено с изменениями',
  rejected: 'Отклонено',
  deleted: 'Удалено',
};

const money = (value: number | null | undefined) =>
  new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value || 0);

function errorText(error: unknown) {
  if (axios.isAxiosError(error)) {
    const detail = error.response?.data?.detail;
    if (typeof detail === 'string') return detail;
    if (detail?.message) return detail.message;
  }
  return error instanceof Error ? error.message : 'Не удалось выполнить действие';
}

function DecisionDialog({
  open,
  title,
  allowChanges,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  allowChanges: boolean;
  onClose: () => void;
  onSubmit: (decision: ItemStatus, comment: string, sumFact?: number) => void;
}) {
  const [decision, setDecision] = useState<ItemStatus>('approved');
  const [comment, setComment] = useState('');
  const [sumFact, setSumFact] = useState('');
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <FormControl fullWidth>
            <InputLabel>Решение</InputLabel>
            <Select
              value={decision}
              label="Решение"
              onChange={(event) => setDecision(event.target.value as ItemStatus)}
            >
              <MenuItem value="approved">Одобрить</MenuItem>
              {allowChanges && <MenuItem value="approved_with_changes">Одобрить с изменениями</MenuItem>}
              <MenuItem value="rejected">Отклонить</MenuItem>
            </Select>
          </FormControl>
          {decision === 'approved_with_changes' && (
            <TextField
              label="Новая согласованная сумма"
              type="number"
              value={sumFact}
              onChange={(event) => setSumFact(event.target.value)}
            />
          )}
          <TextField
            label={decision === 'approved' ? 'Комментарий (необязательно)' : 'Комментарий'}
            multiline
            minRows={3}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Отмена</Button>
        <Button
          variant="contained"
          disabled={
            (decision !== 'approved' && !comment.trim()) ||
            (decision === 'approved_with_changes' && !sumFact)
          }
          onClick={() => onSubmit(
            decision,
            comment.trim(),
            sumFact ? Number(sumFact) : undefined,
          )}
        >
          Сохранить решение
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function PositionDetails({
  position,
  user,
  steps,
  onClose,
}: {
  position: CfoPosition | null;
  user: User;
  steps: ApprovalStep[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [comment, setComment] = useState('');
  const [positionComment, setPositionComment] = useState('');
  const [targetItem, setTargetItem] = useState<BudgetItem | null>(null);
  const currentStep = steps.find((step) => step.id === position?.current_step_id);
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['cfo-positions'] });
    queryClient.invalidateQueries({ queryKey: ['my-approval-steps'] });
  };
  const { data: positionComments = [] } = useQuery({
    queryKey: ['cfo-position-comments', position?.id],
    queryFn: async () => (await api.get<CfoPositionComment[]>(`/cfo-positions/${position!.id}/comments`)).data,
    enabled: !!position,
  });
  const addPositionComment = useMutation({
    mutationFn: () => api.post(`/cfo-positions/${position!.id}/comments`, { comment: positionComment.trim() }),
    onSuccess: () => {
      setPositionComment('');
      queryClient.invalidateQueries({ queryKey: ['cfo-position-comments', position?.id] });
    },
  });
  const action = useMutation({
    mutationFn: async (kind: string) => {
      if (!position) return;
      if (kind === 'submit') return api.post(`/cfo-positions/${position.id}/submit-to-economist`, { comment });
      if (kind === 'complete') return api.post(`/cfo-positions/${position.id}/complete-review`, { comment });
      if (kind === 'freeze') return api.post(`/cfo-positions/${position.id}/freeze`, { comment });
      if (kind === 'unfreeze') return api.post(`/cfo-positions/${position.id}/unfreeze`, { comment });
      if (kind === 'approve') {
        return api.post(`/steps/${position.current_step_id}/positions/${position.id}/approve`, { comment });
      }
      const target = currentStep?.child_step_ids?.[0];
      return api.post(`/steps/${position.current_step_id}/positions/${position.id}/return`, {
        target_step_id: target,
        comment,
      });
    },
    onSuccess: refresh,
  });
  const openChat = useMutation({
    mutationFn: async () => (await api.get<{ id: string }>(`/cfo-positions/${position!.id}/chat`)).data,
    onSuccess: (chat) => window.dispatchEvent(new CustomEvent('budgetbasket:open-chat', { detail: { chatId: chat.id } })),
  });
  const decide = useMutation({
    mutationFn: ({ decision, item, sumFact, decisionComment }: {
      decision: ItemStatus;
      item: BudgetItem;
      sumFact?: number;
      decisionComment: string;
    }) => api.post(`/cfo-positions/${position!.id}/items/${item.id}/decision`, {
      decision,
      comment: decisionComment,
      ...(sumFact !== undefined ? { sum_fact: sumFact } : {}),
    }),
    onSuccess: () => {
      setTargetItem(null);
      refresh();
    },
  });
  if (!position) return null;
  const isEconomist = user.role === 'economist';
  const isCfoResponsible = user.role === 'employee';
  const isReviewer = user.role === 'approver' || user.role === 'zgd';
  return (
    <>
      <Dialog open onClose={onClose} fullWidth maxWidth="lg">
        <DialogTitle>
          {position.article?.name || 'Позиция ЦФО'} · {position.cfo?.name}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            {(action.error || decide.error || addPositionComment.error || openChat.error) && (
              <Alert severity="error">{errorText(action.error || decide.error || addPositionComment.error || openChat.error)}</Alert>
            )}
            <Stack direction="row" spacing={1} flexWrap="wrap">
              <Chip label={positionStatus[position.status]} />
              <Chip label={`План: ${money(position.sum_plan)}`} />
              <Chip label={`Согласовано: ${money(position.sum_fact)}`} />
              {position.frozen && <Chip color="info" label="Заморожена" />}
              {position.fixed && <Chip color="success" label="Зафиксирована" />}
            </Stack>
            <TableContainer component={Paper} variant="outlined">
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Строка</TableCell>
                    <TableCell>Модуль / заявка</TableCell>
                    <TableCell align="right">План</TableCell>
                    <TableCell align="right">Решение</TableCell>
                    <TableCell>Статус</TableCell>
                    {isEconomist && <TableCell />}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {position.contributions.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell>{item.name}</TableCell>
                      <TableCell>
                        {item.module?.name || '—'} ·{' '}
                        <Link to={`/requests/${item.request_id}`}>{item.request_id.slice(0, 8)}</Link>
                      </TableCell>
                      <TableCell align="right">{money(item.sum_plan)}</TableCell>
                      <TableCell align="right">{money(item.sum_fact)}</TableCell>
                      <TableCell><Chip size="small" label={itemStatus[item.status]} /></TableCell>
                      {isEconomist && (
                        <TableCell>
                          <Button
                            size="small"
                            disabled={position.frozen || position.current_step?.unit_id !== position.cfo_unit_id}
                            onClick={() => setTargetItem(item)}
                          >
                            Решение
                          </Button>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
            <Paper variant="outlined" sx={{ p: 1.5 }}>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>Комментарии к статье ЦФО</Typography>
              {positionComments.length ? (
                <Stack spacing={1} sx={{ mb: isReviewer ? 1.5 : 0 }}>
                  {positionComments.map((entry) => {
                    const profile = entry.user?.profile;
                    const author = [profile?.last_name, profile?.name, profile?.second_name].filter(Boolean).join(' ') || entry.user?.login || 'Пользователь';
                    return <Box key={entry.id} sx={{ borderLeft: 2, borderColor: 'divider', pl: 1.25 }}>
                      <Typography variant="body2">{entry.comment}</Typography>
                      <Typography variant="caption" color="text.secondary">{author} · {entry.created_at ? new Date(entry.created_at).toLocaleString('ru-RU') : '—'}</Typography>
                    </Box>;
                  })}
                </Stack>
              ) : <Typography variant="body2" color="text.secondary" sx={{ mb: isReviewer ? 1.5 : 0 }}>Комментариев пока нет.</Typography>}
              {isReviewer && <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'flex-end' }}>
                <TextField
                  fullWidth
                  size="small"
                  label="Комментарий к статье ЦФО"
                  value={positionComment}
                  multiline
                  minRows={2}
                  onChange={(event) => setPositionComment(event.target.value)}
                />
                <Button variant="outlined" disabled={!positionComment.trim() || addPositionComment.isPending} onClick={() => addPositionComment.mutate()}>
                  Добавить комментарий
                </Button>
              </Stack>}
            </Paper>
            <TextField
              label="Комментарий к действию"
              value={comment}
              multiline
              minRows={2}
              onChange={(event) => setComment(event.target.value)}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          {(isCfoResponsible || isEconomist) && <Button startIcon={<ForumOutlinedIcon />} onClick={() => openChat.mutate()} disabled={openChat.isPending}>Открыть чат</Button>}
          <Button onClick={onClose}>Закрыть</Button>
          {isCfoResponsible && ['waiting', 'on_revision'].includes(position.status) && !position.frozen && (
            <Button variant="contained" onClick={() => action.mutate('submit')}>
              Передать экономисту
            </Button>
          )}
          {isEconomist && !position.frozen && position.status === 'on_approval' && (
            <Button onClick={() => action.mutate('complete')}>Завершить проверку строк</Button>
          )}
          {isEconomist && !position.frozen && position.status === 'approved' && (
            <Button variant="contained" onClick={() => action.mutate('freeze')}>
              Заморозить и передать
            </Button>
          )}
          {isEconomist && position.frozen && position.status === 'on_revision' && (
            <Button variant="contained" onClick={() => action.mutate('unfreeze')}>
              Разморозить для доработки
            </Button>
          )}
          {isReviewer && position.current_step_id && (
            <>
              {!!currentStep?.child_step_ids?.length && (
                <Button
                  color="warning"
                  disabled={!comment.trim()}
                  onClick={() => action.mutate('return')}
                >
                  Вернуть
                </Button>
              )}
              <Button variant="contained" onClick={() => action.mutate('approve')}>
                {user.role === 'zgd' ? 'Зафиксировать' : 'Согласовать'}
              </Button>
            </>
          )}
        </DialogActions>
      </Dialog>
      <DecisionDialog
        open={!!targetItem}
        title={targetItem?.name || 'Решение экономиста'}
        allowChanges
        onClose={() => setTargetItem(null)}
        onSubmit={(decision, decisionComment, sumFact) => {
          if (targetItem) decide.mutate({
            decision,
            item: targetItem,
            sumFact,
            decisionComment,
          });
        }}
      />
    </>
  );
}

export default function CfoPositionsPage({ user, renderRouteGraph }: { user: User; renderRouteGraph: (steps: ApprovalStep[]) => ReactNode }) {
  const queryClient = useQueryClient();
  const [request, setRequest] = useState<BudgetRequest | null>(null);
  const [position, setPosition] = useState<CfoPosition | null>(null);
  const { data: incoming = [], isLoading: requestsLoading } = useQuery({
    queryKey: ['cfo-incoming-requests'],
    queryFn: async () => (
      await api.get<BudgetRequest[]>('/cfo/incoming-requests')
    ).data,
    enabled: user.role === 'employee',
  });
  const { data: positions = [], isLoading: positionsLoading } = useQuery({
    queryKey: ['cfo-positions'],
    queryFn: async () => (await api.get<CfoPosition[]>('/cfo-positions')).data,
  });
  const { data: routeSteps = [] } = useQuery({
    queryKey: ['cfo-approval-route'],
    queryFn: async () => (await api.get<ApprovalStep[]>('/approval-route')).data,
    enabled: true,
  });
  const { data: steps = [] } = useQuery({
    queryKey: ['my-approval-steps'],
    queryFn: async () => (await api.get<ApprovalStep[]>('/steps/my')).data,
    enabled: ['economist', 'approver', 'zgd'].includes(user.role),
  });
  const visiblePositions = useMemo(() => {
    if (user.role === 'approver' || user.role === 'zgd') {
      const stepIds = new Set(steps.map((step) => step.id));
      return positions.filter((item) => item.current_step_id && stepIds.has(item.current_step_id));
    }
    return positions;
  }, [positions, steps, user.role]);
  if (requestsLoading || positionsLoading) return <CircularProgress />;
  return (
    <Stack spacing={3}>
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Box>
          <Typography variant="h5">Маршрут обработки заявок и позиций ЦФО</Typography>
          <Typography color="text.secondary">
            На схеме: модуль → ответственный ЦФО → экономист → следующие этапы. После проверки заявки объединяются в позиции ЦФО и далее проходят по этому маршруту.
          </Typography>
        </Box>
        <Button
          startIcon={<RefreshIcon />}
          onClick={() => {
            queryClient.invalidateQueries({ queryKey: ['cfo-incoming-requests'] });
            queryClient.invalidateQueries({ queryKey: ['cfo-positions'] });
            queryClient.invalidateQueries({ queryKey: ['cfo-approval-route'] });
          }}
        >
          Обновить
        </Button>
      </Stack>
      {renderRouteGraph(routeSteps)}
      {user.role === 'employee' && (
        <Paper sx={{ p: 2 }}>
          <Typography variant="h6" gutterBottom>Входящие заявки ЦФО</Typography>
          {!incoming.length ? <Alert severity="info">Новых заявок на проверку нет.</Alert> : (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Заявка</TableCell>
                  <TableCell>Год</TableCell>
                  <TableCell align="right">План</TableCell>
                  <TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {incoming.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>{item.id.slice(0, 8)}</TableCell>
                    <TableCell>{item.budget_year}</TableCell>
                    <TableCell align="right">{money(item.sum_plan)}</TableCell>
                    <TableCell align="right">
                      <Button startIcon={<FactCheckOutlinedIcon />} onClick={() => setRequest(item)}>
                        Проверить
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Paper>
      )}
      <Paper sx={{ p: 2 }}>
        <Typography variant="h6" gutterBottom>Позиции ЦФО</Typography>
        {!visiblePositions.length ? <Alert severity="info">Доступных позиций пока нет.</Alert> : (
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Год</TableCell>
                  <TableCell>ЦФО</TableCell>
                  <TableCell>Статья / инвестпроект</TableCell>
                  <TableCell align="right">План</TableCell>
                  <TableCell align="right">Согласовано</TableCell>
                  <TableCell>Состояние</TableCell>
                  <TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {visiblePositions.map((item) => (
                  <TableRow key={item.id} hover>
                    <TableCell>{item.budget_year}</TableCell>
                    <TableCell>{item.cfo?.name || item.cfo_unit_id}</TableCell>
                    <TableCell>{item.article?.name || '—'}</TableCell>
                    <TableCell align="right">{money(item.sum_plan)}</TableCell>
                    <TableCell align="right">{money(item.sum_fact)}</TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        color={item.fixed ? 'success' : item.frozen ? 'info' : 'default'}
                        label={positionStatus[item.status]}
                      />
                    </TableCell>
                    <TableCell align="right">
                      <Button onClick={() => setPosition(item)}>Открыть</Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Paper>
      <CfoRequestReviewDialog
        request={request}
        open={!!request}
        onClose={() => setRequest(null)}
      />
      <PositionDetails
        position={position}
        user={user}
        steps={steps}
        onClose={() => setPosition(null)}
      />
    </Stack>
  );
}
