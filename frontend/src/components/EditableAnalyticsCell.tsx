import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAppToast } from './Layout';
import { InlineEditTextCell } from './inlineEdit';
import { ANALYTICS_FIELD_LABELS, type AnalyticsFieldKey } from '../utils/analyticsFields';
import { getApiErrorMessage } from '../utils/apiErrors';

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

  const save = useMutation({
    mutationFn: async (next: string) => api.patch(`/items/${itemId}`, { [field]: next }),
    onSuccess: () => {
      onSaved?.();
      queryClient.invalidateQueries({ queryKey: ['approval-register'] });
      queryClient.invalidateQueries({ queryKey: ['approval-register-rows'] });
      queryClient.invalidateQueries({ queryKey: ['request-details'] });
    },
    onError: (error) => toast(getApiErrorMessage(error, 'Не удалось сохранить аналитику'), 'error'),
  });

  return (
    <InlineEditTextCell
      value={value}
      editable={editable}
      multiline={multiline}
      pending={save.isPending}
      ariaLabel={ANALYTICS_FIELD_LABELS[field]}
      title={`Нажмите, чтобы изменить ${ANALYTICS_FIELD_LABELS[field].toLowerCase()}`}
      onCommit={(next) => save.mutate(next)}
    />
  );
}
