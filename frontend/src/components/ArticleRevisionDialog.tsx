import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
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
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { canEditRevisionLineDetails } from './approval-register/registryConfig';
import { STATUS_LABELS } from './approval-register/registryConfig';
import { InlineEditMoneyCell, InlineEditTextCell } from './inlineEdit';
import type { ApprovalRegisterRow, User } from '../types';
import { money } from '../utils/labels';

export type RevisionLine = ApprovalRegisterRow & {
  frozen?: boolean;
  fixed?: boolean;
};

type LineDraft = { comment: string; suggested_sum_fact: string };

export type RevisionTarget = {
  groupType: 'cfo' | 'article' | 'category' | 'module';
  groupId: string;
  groupName: string;
};

function errorText(error: unknown) {
  if (error && typeof error === 'object' && 'response' in error) {
    const response = (error as { response?: { data?: { detail?: string } } }).response;
    return response?.data?.detail || 'Не удалось выполнить операцию';
  }
  return 'Не удалось выполнить операцию';
}

const GROUP_TYPE_LABELS: Record<RevisionTarget['groupType'], string> = {
  cfo: 'ЦФО',
  article: 'статью',
  category: 'категорию',
  module: 'модуль',
};

export function ArticleRevisionDialog({
  open,
  onClose,
  onSuccess,
  mode,
  target,
  initialLines,
  requestId,
  positionId,
  user,
}: {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  mode: 'cfo' | 'workflow';
  target?: RevisionTarget | null;
  initialLines?: RevisionLine[];
  requestId?: string;
  positionId?: string;
  user: User;
}) {
  const [comment, setComment] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [lineValues, setLineValues] = useState<Record<string, LineDraft>>({});
  const canEditLines = canEditRevisionLineDetails(user.role);
  const workflowLineEdit = mode === 'workflow' && canEditLines;

  const { data, isLoading, error } = useQuery({
    queryKey: ['revision-lines', target?.groupType, target?.groupId, mode, requestId],
    queryFn: async () => (await api.get<{
      group_name: string;
      mode: 'cfo' | 'workflow';
      lines: RevisionLine[];
    }>(`/approval-register/groups/${target!.groupType}/${target!.groupId}/revision-lines`, {
      params: { mode, request_id: requestId },
    })).data,
    enabled: open && !!target && !initialLines?.length,
  });

  const lines = useMemo(() => initialLines || data?.lines || [], [data?.lines, initialLines]);
  const initialSelection = useMemo(() => {
    // The selection belongs to the active route state, not to a particular
    // role.  When a position has been returned, every current assignee sees
    // its active lines preselected and can adjust the set before handing the
    // position to the next participant.
    const activeRevision = lines
      .filter((line) => line.is_module_revision || line.is_revision)
      .map((line) => line.id);
    return activeRevision.length ? activeRevision : lines.map((line) => line.id);
  }, [lines]);
  const groupName = target?.groupName || data?.group_name || 'группировка';
  useEffect(() => {
    if (!open) return;
    setComment('');
    setSelected(initialSelection);
    setLineValues(Object.fromEntries(lines.map((line) => [
      line.id,
      {
        comment: '',
        suggested_sum_fact: workflowLineEdit
          ? String(line.approved_sum ?? line.requested_sum ?? '')
          : '',
      },
    ])));
  }, [open, lines, initialSelection, workflowLineEdit]);

  const buildRevisionItem = (itemId: string) => ({
    item_id: itemId,
    comment: canEditLines ? (lineValues[itemId]?.comment?.trim() || '') : '',
    ...(workflowLineEdit && lineValues[itemId]?.suggested_sum_fact !== ''
      ? { suggested_sum_fact: Number(lineValues[itemId].suggested_sum_fact) }
      : {}),
  });

  const submit = useMutation({
    mutationFn: async () => {
      const items = selected.map((itemId) => buildRevisionItem(itemId));
      if (mode === 'cfo') {
        if (target) {
          return api.post(`/approval-register/groups/${target.groupType}/${target.groupId}/cfo-revision`, {
            comment: comment.trim(),
            items,
          }, { params: { request_id: requestId } });
        }
        return Promise.all(items.map((item) => api.post(`/items/${item.item_id}/cfo-decision`, {
          decision: 'rejected',
          comment: item.comment || comment.trim(),
        })));
      }
      if (positionId) {
        return api.post(`/cfo-positions/${positionId}/return-for-revision`, {
          comment: comment.trim(),
          items,
        });
      }
      if (!target && initialLines?.length) {
        const selectedLines = initialLines.filter((line) => selected.includes(line.id));
        const byPosition = selectedLines.reduce((result, line) => {
          if (!line.position_id) return result;
          const bucket = result.get(line.position_id) || [];
          bucket.push(line);
          result.set(line.position_id, bucket);
          return result;
        }, new Map<string, RevisionLine[]>());
        return Promise.all([...byPosition.entries()].map(([position, positionLines]) => api.post(
          `/cfo-positions/${position}/return-for-revision`,
          {
            comment: comment.trim(),
            items: positionLines.map((line) => buildRevisionItem(line.id)),
          },
        )));
      }
      if (!target) {
        throw new Error('Для возврата на доработку выберите группировку');
      }
      return api.post(`/approval-register/groups/${target.groupType}/${target.groupId}/workflow-action`, {
        action: 'return_for_revision',
        comment: comment.trim(),
        items,
      }, { params: { request_id: requestId } });
    },
    onSuccess: () => {
      onSuccess();
      onClose();
    },
  });

  const blockHint = canEditLines
    ? (mode === 'cfo'
      ? 'Сообщение будет отправлено в чат с модулем. Комментарии к отдельным строкам также попадут в чат.'
      : user.role === 'economist'
        ? 'Сообщение будет отправлено в чат с модулем. Утверждённую сумму можно изменить прямо в таблице и оставить комментарий к каждой строке.'
        : 'Сообщение попадёт в чат с экономистом ЦФО. Комментарии к строкам доступны экономисту и ответственному по ЦФО.')
    : 'Укажите общее сообщение к блоку. Выбор строк определяет, какие позиции вернуть на доработку; комментарий сохранится в журнале согласования.';

  const tableColSpan = 8 + (canEditLines ? 1 : 0);

  return (
    <Dialog open={open} onClose={submit.isPending ? undefined : onClose} fullWidth maxWidth="lg">
      <DialogTitle>
        Отправить {target ? GROUP_TYPE_LABELS[target.groupType] : 'группировку'} «{groupName}» на доработку
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {(error || submit.error) && (
            <Alert severity="error">{error ? errorText(error) : errorText(submit.error)}</Alert>
          )}
          <Paper variant="outlined" sx={{ p: 1.5, bgcolor: '#F8FAFC' }}>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>Сообщение к блоку</Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
              {blockHint}
            </Typography>
            <TextField
              label="Сообщение к блоку"
              value={comment}
              required
              multiline
              minRows={3}
              fullWidth
              onChange={(event) => setComment(event.target.value)}
            />
          </Paper>
          <Box>
            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>Детализация по строкам</Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
              Выберите строки для доработки. Остальные останутся в текущем блоке и не будут доступны для редактирования.
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
              Выбор можно изменить, пока позиция находится на вашем текущем этапе. После передачи следующему участнику он фиксируется.
            </Typography>
            {isLoading ? (
              <Typography variant="body2" color="text.secondary">Загрузка строк…</Typography>
            ) : (
              <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: 420 }}>
                <Table size="small" stickyHeader>
                  <TableHead>
                    <TableRow>
                      <TableCell padding="checkbox" />
                      <TableCell>Строка</TableCell>
                      <TableCell>Модуль</TableCell>
                      <TableCell>Категория</TableCell>
                      <TableCell>Статья</TableCell>
                      <TableCell align="right">Запрошено</TableCell>
                      <TableCell align="right">{workflowLineEdit ? 'Утверждено' : 'Согласовано'}</TableCell>
                      <TableCell>Статус</TableCell>
                      {canEditLines && <TableCell>Комментарий к строке</TableCell>}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {lines.map((line) => {
                      const checked = selected.includes(line.id);
                      return (
                        <TableRow key={line.id} hover selected={checked}>
                          <TableCell padding="checkbox">
                            <Checkbox
                              checked={checked}
                              onChange={(_, next) => setSelected((current) => (
                                next ? [...current, line.id] : current.filter((id) => id !== line.id)
                              ))}
                            />
                          </TableCell>
                          <TableCell>
                            <Typography variant="body2" sx={{ fontSize: 13 }}>{line.name}</Typography>
                          </TableCell>
                          <TableCell><Typography variant="body2" sx={{ fontSize: 13 }}>{line.module_name}</Typography></TableCell>
                          <TableCell><Typography variant="body2" sx={{ fontSize: 13 }}>{line.category_name}</Typography></TableCell>
                          <TableCell><Typography variant="body2" sx={{ fontSize: 13 }}>{line.article_name}</Typography></TableCell>
                          <TableCell align="right">{money(line.requested_sum)}</TableCell>
                          <TableCell align="right">
                            {workflowLineEdit ? (
                              <InlineEditMoneyCell
                                value={Number(lineValues[line.id]?.suggested_sum_fact ?? line.approved_sum ?? 0)}
                                editable={checked}
                                formatValue={money}
                                parseValue={(raw) => {
                                  const amount = Number(raw.replace(/\s/g, '').replace(',', '.'));
                                  return Number.isFinite(amount) ? amount : null;
                                }}
                                validate={(amount) => amount >= 0}
                                ariaLabel="Согласованная сумма"
                                title="Нажмите, чтобы изменить сумму"
                                onCommit={(amount) => setLineValues((current) => ({
                                  ...current,
                                  [line.id]: {
                                    suggested_sum_fact: String(amount),
                                    comment: current[line.id]?.comment || '',
                                  },
                                }))}
                              />
                            ) : (
                              money(line.approved_sum)
                            )}
                          </TableCell>
                          <TableCell>
                            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                              <Chip size="small" variant="outlined" label={STATUS_LABELS[line.status]} sx={{ height: 22, fontSize: 11 }} />
                              {line.fixed && (
                                <Tooltip title="Зафиксирована после финального согласования" arrow>
                                  <LockOutlinedIcon aria-label="Зафиксирована" color="success" fontSize="small" />
                                </Tooltip>
                              )}
                              {line.frozen && !line.fixed && (
                                <Tooltip title="Заморожена на текущем этапе" arrow>
                                  <LockOutlinedIcon aria-label="Заморожена" color="info" fontSize="small" />
                                </Tooltip>
                              )}
                            </Stack>
                          </TableCell>
                          {canEditLines && (
                            <TableCell>
                              <InlineEditTextCell
                                value={lineValues[line.id]?.comment || ''}
                                editable={checked}
                                placeholder="Комментарий к строке"
                                ariaLabel="Комментарий к строке"
                                title="Нажмите, чтобы добавить комментарий к строке"
                                onCommit={(comment) => setLineValues((current) => ({
                                  ...current,
                                  [line.id]: {
                                    comment,
                                    suggested_sum_fact: current[line.id]?.suggested_sum_fact ?? '',
                                  },
                                }))}
                              />
                            </TableCell>
                          )}
                        </TableRow>
                      );
                    })}
                    {!lines.length && (
                      <TableRow>
                        <TableCell colSpan={tableColSpan}>
                          <Typography variant="body2" color="text.secondary">Нет строк, доступных для доработки.</Typography>
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={submit.isPending}>Отмена</Button>
        <Button
          variant="contained"
          color="warning"
          disabled={
            submit.isPending
            || !comment.trim()
            || !selected.length
            || isLoading
          }
          onClick={() => submit.mutate()}
        >
          {submit.isPending ? 'Отправка…' : 'На доработку'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
