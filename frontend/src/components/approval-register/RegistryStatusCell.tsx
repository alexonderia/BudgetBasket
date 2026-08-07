import type { ApprovalRegisterRow, RegisterAggregates } from '../../types';
import type { RegistryStatusDisplay } from './registryConfig';
import { groupStatusPresentation, rowStatusPresentation, StatusVisualCell } from './registryStatusVisual';

export function RegistryStatusCell({ status, item }: { status: RegistryStatusDisplay; item?: ApprovalRegisterRow }) {
  return <StatusVisualCell presentation={rowStatusPresentation(status, item)} />;
}

export function RegistryGroupStatusCell({ status, aggregates }: { status: RegistryStatusDisplay; aggregates: RegisterAggregates }) {
  return <StatusVisualCell presentation={groupStatusPresentation(aggregates, status)} />;
}
