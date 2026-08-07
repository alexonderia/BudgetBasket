import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { ApprovalRegisterGroup } from '../types';
import { ANALYTICS_FIELD_LABELS, buildRegisterFilterParams, type AnalyticsFieldKey } from '../utils/analyticsFields';
import type { RegistryFilters } from './approval-register/registryConfig';
import { useAppToast } from './Layout';

function readErrorMessage(error: unknown, fallback: string) {
  const detail = (error as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
  if (detail) return detail;
  if (error instanceof Error && error.message === 'Network Error') return 'Не удалось подключиться к серверу';
  return error instanceof Error ? error.message : fallback;
}

function groupEntityId(group: ApprovalRegisterGroup) {
  const segment = group.id.split('/').at(-1) || '';
  const prefix = `${group.type}:`;
  return segment.startsWith(prefix) ? segment.slice(prefix.length) : '';
}

export function GroupAnalyticsCell({
  group,
  field,
  filters,
  requestId,
}: {
  group: ApprovalRegisterGroup;
  field: AnalyticsFieldKey;
  filters: RegistryFilters;
  requestId?: string;
}) {
  const queryClient = useQueryClient();
  const toast = useAppToast();
  const summary = group.analytics?.fields[field];
  const editable = Boolean(group.analytics?.can_edit);
  const mixed = summary?.mixed ?? false;
  const committed = mixed ? '' : (summary?.value || '');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(committed);

  useEffect(() => {
    if (!editing) setDraft(committed);
  }, [editing, committed]);

  const save = useMutation({
    mutationFn: async () => api.patch(
      `/approval-register/groups/${group.type}/${groupEntityId(group)}/analytics`,
      { [field]: draft },
      { params: buildRegisterFilterParams(filters, { request_id: requestId }) },
    ),
    onSuccess: (response) => {
      setEditing(false);
      const count = (response.data as { updated_count?: number }).updated_count ?? 0;
      toast(`Аналитика применена к ${count} строкам`, 'success');
      queryClient.invalidateQueries({ queryKey: ['approval-register'] });
      queryClient.invalidateQueries({ queryKey: ['approval-register-rows'] });
      queryClient.invalidateQueries({ queryKey: ['approval-register-analytics-filters'] });
    },
    onError: (error) => toast(readErrorMessage(error, 'Не удалось применить аналитику к строкам'), 'error'),
  });

  const commit = () => {
    if (draft === committed && !mixed) {
      setEditing(false);
      return;
    }
    save.mutate();
  };

  const display = mixed ? 'Разные значения' : (committed || '—');

  if (!editable) {
    return (
      <Typography variant="body2" noWrap title={mixed ? 'В строках группы разные значения' : display} sx={{ fontSize: 13, lineHeight: 1.25, fontStyle: mixed ? 'italic' : undefined, color: mixed ? 'text.secondary' : undefined }}>
        {display}
      </Typography>
    );
  }
  if (!editing) {
    return (
      <Box
        component="button"
        type="button"
        onClick={(event) => { event.stopPropagation(); setEditing(true); }}
        onKeyDown={(event) => { if (event.key === 'Enter') setEditing(true); }}
        sx={{
          border: 0,
          bgcolor: 'transparent',
          font: 'inherit',
          fontSize: 13,
          cursor: 'pointer',
          p: 0,
          textAlign: 'left',
          width: '100%',
          color: mixed || !committed ? 'primary.main' : 'text.primary',
          textDecoration: mixed || !committed ? 'underline dotted rgba(37, 99, 235, 0.45)' : 'none',
          fontStyle: mixed ? 'italic' : undefined,
        }}
        title={mixed ? 'Нажмите, чтобы задать одно значение для всех строк группы' : `Нажмите, чтобы изменить ${ANALYTICS_FIELD_LABELS[field].toLowerCase()} для всех строк`}
      >
        {display}
      </Box>
    );
  }
  return (
    <TextField
      autoFocus
      size="small"
      value={draft}
      disabled={save.isPending}
      placeholder={mixed ? 'Новое значение для всех строк' : undefined}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        }
        if (event.key === 'Escape') {
          setDraft(committed);
          setEditing(false);
        }
      }}
      onBlur={commit}
      inputProps={{ 'aria-label': `${ANALYTICS_FIELD_LABELS[field]} для группы` }}
      sx={{ width: '100%', '& .MuiInputBase-input': { py: 0.35, px: 0.75, fontSize: 13 } }}
    />
  );
}
