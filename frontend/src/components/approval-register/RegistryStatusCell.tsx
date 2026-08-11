import { useEffect, useState } from 'react';
import type { ApprovalRegisterRow, RegisterAggregates, RegisterStepDecisionDisplay } from '../../types';
import type { RegistryStatusDisplay } from './registryConfig';
import { InlineEditSelectCell } from '../inlineEdit';
import {
  groupStatusPresentation,
  rowStatusPresentation,
  StatusVisualCell,
} from './registryStatusVisual';
import { WorkflowStepCell } from './registryWorkflowStepVisual';

export type RegistryRowDecision = 'approved' | 'approved_with_changes' | 'rejected';

const STATUS_EDIT_OPTIONS: Array<{ value: RegistryRowDecision; label: string }> = [
  { value: 'approved', label: 'Согласовано' },
  { value: 'approved_with_changes', label: 'Согласовано с корректировкой' },
  { value: 'rejected', label: 'На доработку' },
];

function rowDecisionValue(item: ApprovalRegisterRow): RegistryRowDecision {
  if (item.status === 'rejected') return 'rejected';
  if (item.status === 'approved_with_changes') return 'approved_with_changes';
  return 'approved';
}

export function RegistryStatusCell({ status, item }: { status: RegistryStatusDisplay; item?: ApprovalRegisterRow }) {
  return <StatusVisualCell presentation={rowStatusPresentation(status, item)} />;
}

export function RegistryGroupStatusCell({ status, aggregates }: { status: RegistryStatusDisplay; aggregates: RegisterAggregates }) {
  return <StatusVisualCell presentation={groupStatusPresentation(aggregates, status)} />;
}

export function RegistryWorkflowStepCell({ display }: { display?: RegisterStepDecisionDisplay | null }) {
  return <WorkflowStepCell display={display} />;
}

export function EditableRegistryStatusCell({
  status,
  item,
  active,
  onCommit,
  onDecision,
  compact = false,
}: {
  status: RegistryStatusDisplay;
  item: ApprovalRegisterRow;
  active: boolean;
  onCommit: (decision: RegistryRowDecision) => void;
  onDecision: (decision: RegistryRowDecision) => void;
  compact?: boolean;
}) {
  const presentation = compact
    ? {
        primary: {
          ...rowStatusPresentation(status, item).primary,
          text: status.label === 'Ожидает вашего решения' ? '!' : rowStatusPresentation(status, item).primary.text,
        },
        hint: status.hint,
        primaryIconOnly: true,
        showActionIndicator: false,
      }
    : rowStatusPresentation(status, item);

  if (!active) {
    return <StatusVisualCell presentation={presentation} />;
  }

  return (
    <InlineEditSelectCell
      value={rowDecisionValue(item)}
      editable
      options={STATUS_EDIT_OPTIONS}
      display={<StatusVisualCell presentation={presentation} />}
      ariaLabel="Статус строки"
      title="Нажмите, чтобы изменить статус"
      onCommit={(decision) => {
        if (decision === 'rejected' || decision === 'approved_with_changes') {
          onDecision(decision);
          return;
        }
        onCommit(decision);
      }}
    />
  );
}
