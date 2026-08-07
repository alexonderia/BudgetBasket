import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import Box from '@mui/material/Box';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAppToast } from './Layout';
import { ANALYTICS_FIELD_LABELS, type AnalyticsFieldKey } from '../utils/analyticsFields';

function readErrorMessage(error: unknown, fallback: string) {
  const detail = (error as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
  if (detail) return detail;
  if (error instanceof Error && error.message === 'Network Error') return 'Не удалось подключиться к серверу';
  return error instanceof Error ? error.message : fallback;
}

export function EditableAnalyticsCell({
  itemId,
  field,
  value,
  editable,
  multiline = false,
  onSaved,
}: {
  itemId: string;
  field: AnalyticsFieldKey;
  value: string;
  editable: boolean;
  multiline?: boolean;
  onSaved?: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useAppToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [editing, value]);

  const save = useMutation({
    mutationFn: async () => api.patch(`/items/${itemId}`, { [field]: draft }),
    onSuccess: () => {
      setEditing(false);
      onSaved?.();
      queryClient.invalidateQueries({ queryKey: ['approval-register'] });
      queryClient.invalidateQueries({ queryKey: ['approval-register-rows'] });
      queryClient.invalidateQueries({ queryKey: ['request-details'] });
    },
    onError: (error) => toast(readErrorMessage(error, 'Не удалось сохранить аналитику'), 'error'),
  });

  const commit = () => {
    if (draft === value) {
      setEditing(false);
      return;
    }
    save.mutate();
  };

  const display = value || '—';
  if (!editable) {
    return <Typography variant="body2" noWrap title={display} sx={{ fontSize: 13, lineHeight: 1.25 }}>{display}</Typography>;
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
          color: value ? 'text.primary' : 'primary.main',
          textDecoration: value ? 'none' : 'underline dotted rgba(37, 99, 235, 0.45)',
        }}
        title={`Нажмите, чтобы заполнить ${ANALYTICS_FIELD_LABELS[field].toLowerCase()}`}
      >
        {display}
      </Box>
    );
  }
  return (
    <TextField
      autoFocus
      size="small"
      multiline={multiline}
      minRows={multiline ? 2 : undefined}
      value={draft}
      disabled={save.isPending}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !multiline) {
          event.preventDefault();
          commit();
        }
        if (event.key === 'Escape') {
          setDraft(value);
          setEditing(false);
        }
      }}
      onBlur={commit}
      inputProps={{ 'aria-label': ANALYTICS_FIELD_LABELS[field] }}
      sx={{ width: '100%', '& .MuiInputBase-input': { py: 0.35, px: 0.75, fontSize: 13 } }}
    />
  );
}
