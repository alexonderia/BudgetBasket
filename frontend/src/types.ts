export type Role = 'admin' | 'economist' | 'employee' | 'approver' | 'zgd';
export type RequestStatus = 'draft' | 'on_review' | 'approved' | 'rejected' | 'cancelled';
export type ItemStatus = 'on_review' | 'rejected' | 'approved_with_changes' | 'approved' | 'deleted';
export type StepStatus = 'waiting' | 'on_approval' | 'on_revision' | 'approved' | 'closed';
export type CfoPositionStatus = 'waiting' | 'on_review' | 'on_approval' | 'approved' | 'on_revision';

export interface User {
  id: string;
  login: string;
  role: Role;
  profile?: Profile;
  unit_ids?: string[];
}

export interface Profile {
  user_id: string;
  name: string;
  second_name: string;
  last_name: string;
  phone: string;
  email: string;
  max_link: string;
}

export interface Unit {
  id: string;
  parent_id: string | null;
  name: string;
  type?: 'department' | 'cfo' | 'module';
  is_active: boolean;
  uses_invest_projects: boolean;
  annual_budget: number;
  children?: Unit[];
}

export interface CatalogItem {
  id: string;
  parent_id: string | null;
  unit_id: string | null;
  name: string;
  is_active: boolean;
}

export interface BudgetRequest {
  id: string;
  unit_id: string;
  budget_year: number;
  /** Display alias for legacy request lists; equals sum_plan. */
  sum: number;
  sum_plan: number;
  sum_fact: number;
  status: RequestStatus;
  /** Workflow flags live on CfoPosition; kept optional for old read-only widgets. */
  frozen?: boolean;
  fixed?: boolean;
  cfo_unit_id?: string;
  available_actions?: string[];
  total_approved_sum?: number;
  summary?: RequestSummary;
  package_id?: string;
  package_name?: string;
  my_step_statuses?: MyApprovalStepStatus[];
}

export interface MyApprovalStepStatus {
  step_id: string;
  status: StepStatus;
  reviewed: boolean;
}

export interface RequestSummary {
  request_id: string;
  planned_sum: number;
  approved_sum: number;
  income_planned_sum: number;
  income_approved_sum: number;
  items_count: number;
  accepted_count: number;
  rejected_count: number;
  in_review_count: number;
}

export interface BudgetItem {
  id: string;
  request_id: string;
  cfo_position_id?: string | null;
  dds_id?: string;
  invest_id?: string;
  is_income: boolean;
  sum_plan: number;
  sum_fact: number | null;
  name: string;
  justification: string;
  status: ItemStatus;
  comment: string | null;
  month_plans: ItemMonthPlan[];
}

export type RegisterAggregateStatus = 'approved' | 'rejected' | 'partially_approved' | 'on_review' | 'in_progress' | 'no_data';

export interface RegisterAggregates {
  requested_sum: number;
  approved_sum: number;
  difference: number;
  total_rows: number;
  approved_rows: number;
  rejected_rows: number;
  pending_rows: number;
  requests_count: number;
  modules_count: number;
  aggregate_status: RegisterAggregateStatus;
  collecting_requests: number;
  cfo_review_requests: number;
  cfo_review_actionable_requests: number;
  in_approval_positions: number;
  actionable_positions: number;
}

export interface ApprovalRegisterGroup {
  id: string;
  type: 'cfo' | 'category' | 'article' | 'module';
  name: string;
  label: string;
  module_id: string;
  request_ids: string[];
  aggregates: RegisterAggregates;
  children: ApprovalRegisterGroup[];
  can_load_rows: boolean;
}

export interface ApprovalRegisterResponse {
  view: 'cfo' | 'category' | 'article' | 'module';
  groups: ApprovalRegisterGroup[];
  aggregates: RegisterAggregates;
}

export interface ApprovalRegisterRow {
  id: string;
  request_id: string;
  request_status: RequestStatus;
  budget_year: number;
  module_id: string;
  module_name: string;
  cfo_id: string;
  cfo_name: string;
  category_id: string;
  category_name: string;
  article_id: string;
  article_name: string;
  kind: 'dds' | 'invest';
  name: string;
  justification: string;
  comment: string;
  files_count: number;
  requested_sum: number;
  approved_sum: number;
  status: ItemStatus;
  updated_at: string;
  is_collecting: boolean;
  is_cfo_review: boolean;
  is_cfo_review_actionable: boolean;
  position_id: string | null;
  is_in_approval: boolean;
  is_approval_actionable: boolean;
  approval_stage: string | null;
}

export interface ApprovalRegisterRowsResponse {
  items: ApprovalRegisterRow[];
  group: { module_id: string; aggregates: RegisterAggregates };
  pagination: { page: number; page_size: number; total_items: number; total_pages: number; has_next: boolean; has_previous: boolean };
}

export interface ItemMonthPlan {
  month: number;
  sum_plan: number | string;
}

export interface FileAttachment {
  id: number;
  id_storage_object: number;
  original_name: string;
}

export interface ApprovalStep {
  id: string;
  user_id: string | null;
  unit_id: string | null;
  status: StepStatus;
  user: User | null;
  unit: Unit | null;
  cfo: Unit | null;
  department: Unit | null;
  is_economist_step?: boolean;
  cfo_unit_id?: string | null;
  cfo_unit_ids?: string[];
  cfo_names?: string[];
  unit_path: string[];
  responsible: User | null;
  modules?: Array<{
    id: string;
    name: string;
    responsible: User | null;
    request_statuses: Array<{
      status: RequestStatus;
      count: number;
    }>;
  }>;
  parent_step_ids: string[];
  child_step_ids: string[];
  request_status?: StepStatus;
  active_positions_count?: number;
  active_requests_count?: number;
}

export interface CfoPosition {
  id: string;
  budget_year: number;
  cfo_unit_id: string;
  dds_id?: string | null;
  invest_id?: string | null;
  status: CfoPositionStatus;
  current_step_id: string | null;
  frozen: boolean;
  fixed: boolean;
  sum_plan: number;
  sum_fact: number;
  items_count: number;
  cfo?: Unit | null;
  article?: CatalogItem | null;
  current_step?: ApprovalStep | null;
  contributions: Array<BudgetItem & {
    request: BudgetRequest;
    module?: Unit | null;
    author?: User | null;
  }>;
}

export interface CfoPositionComment {
  id: number;
  created_at: string;
  comment: string;
  step_id: string | null;
  user: User | null;
}

export interface StepRequest extends BudgetRequest {
  unit: Unit | null;
  approval_status: StepStatus;
  reviewed_at_step?: boolean;
  items_count: number;
  reviewed_items_count: number;
  sum_plan: number;
  sum_fact: number;
  package_id?: string;
  package_name?: string;
}

export interface StepLog {
  id: number;
  step_id: string | null;
  user_id: string;
  created_at: string;
  user: User | null;
  log: {
    action: string;
    entity: string;
    entity_id: string;
    event_id: string;
    changes?: Record<string, { from: unknown; to: unknown }>;
    comment?: string | null;
    child_step_id?: string;
    request_ids?: string[];
    targets?: { child_step_id: string; request_ids: string[] }[];
  };
}

export const CLOSED_REQUEST_STATUSES: RequestStatus[] = ['approved', 'rejected', 'cancelled'];
export const EXPORTABLE_REQUEST_STATUSES: RequestStatus[] = ['approved'];
