import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { ApprovalRegisterGroup } from '../types';
import { ANALYTICS_FIELD_LABELS, buildRegisterFilterParams, type AnalyticsFieldKey } from '../utils/analyticsFields';
import type { RegistryFilters } from './approval-register/registryConfig';
import { useAppToast } from './Layout';
import { InlineEditTextCell } from './inlineEdit';
import { getApiErrorMessage } from '../utils/apiErrors';

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

  const save = useMutation({
    mutationFn: async (draft: string) => api.patch(
      `/approval-register/groups/${group.type}/${groupEntityId(group)}/analytics`,
      { [field]: draft },
      { params: buildRegisterFilterParams(filters, { request_id: requestId }) },
    ),
    onSuccess: (response) => {
      const count = (response.data as { updated_count?: number }).updated_count ?? 0;
      toast(`Аналитика применена к ${count} строкам`, 'success');
      queryClient.invalidateQueries({ queryKey: ['approval-register'] });
      queryClient.invalidateQueries({ queryKey: ['approval-register-rows'] });
      queryClient.invalidateQueries({ queryKey: ['approval-register-analytics-filters'] });
    },
    onError: (error) => toast(getApiErrorMessage(error, 'Не удалось применить аналитику к строкам'), 'error'),
  });

  const display = mixed ? 'Разные значения' : undefined;

  return (
    <InlineEditTextCell
      value={committed}
      editable={editable}
      displayValue={display}
      fontStyle={mixed ? 'italic' : undefined}
      emphasizedWhenEmpty={mixed || !committed}
      pending={save.isPending}
      ariaLabel={`${ANALYTICS_FIELD_LABELS[field]} для группы`}
      tooltip={mixed
        ? 'Нажмите, чтобы задать одно значение для всех строк группы'
        : `Нажмите, чтобы изменить ${ANALYTICS_FIELD_LABELS[field].toLowerCase()} для всех строк`}
      onCommit={(next) => {
        if (next === committed && !mixed) return;
        save.mutate(next);
      }}
    />
  );
}
