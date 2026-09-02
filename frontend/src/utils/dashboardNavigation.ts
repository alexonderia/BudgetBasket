import type { RegistryView } from '../components/approval-register/registryConfig';
import type { RequestStatus, User } from '../types';

export type RegisterDrillParams = {
  view?: RegistryView;
  cfoId?: string;
  articleId?: string;
  search?: string;
  requestStatus?: RequestStatus | '';
  flow?: '' | 'expense' | 'income';
  frozen?: 'frozen' | 'fixed';
};

export type DashboardMetric = 'planned' | 'correction' | 'approved' | 'frozen' | 'processed';

/** Keep the navigation target of a metric card and its caption in one place. */
export function dashboardMetricFilters(
  metric: DashboardMetric,
  options: { view: RegistryView; cfoId?: string; flow: 'expense' | 'income' },
): RegisterDrillParams {
  const scope = {
    view: options.view,
    ...(options.cfoId ? { cfoId: options.cfoId } : {}),
    flow: options.flow,
  };
  if (metric === 'approved' || metric === 'processed') return { ...scope, requestStatus: 'approved' };
  if (metric === 'frozen') return { ...scope, frozen: 'frozen' };
  return scope;
}

export function parseArticleKey(articleKey: string): string | null {
  const separatorIndex = articleKey.indexOf(':');
  return separatorIndex >= 0 ? articleKey.slice(separatorIndex + 1) : null;
}

export function buildRegisterHref(user: User, params: RegisterDrillParams): string {
  const search = new URLSearchParams();
  if (params.view) search.set('register_view', params.view);
  if (params.cfoId) search.set('cfo_id', params.cfoId);
  if (params.articleId) search.set('article_id', params.articleId);
  if (params.search) search.set('search', params.search);
  if (params.requestStatus) search.set('request_status', params.requestStatus);
  if (params.flow) search.set('flow', params.flow);
  if (params.frozen) search.set('frozen', params.frozen);

  if (user.role === 'admin') {
    search.set('view', 'table');
    return `/?${search.toString()}`;
  }

  const query = search.toString();
  return `/requests${query ? `?${query}` : ''}`;
}

export function registerDrillFromSearchParams(searchParams: URLSearchParams): RegisterDrillParams {
  const view = searchParams.get('register_view');
  const knownViews: RegistryView[] = ['cfo', 'module', 'article', 'category', 'request'];
  return {
    view: knownViews.includes(view as RegistryView) ? view as RegistryView : undefined,
    cfoId: searchParams.get('cfo_id') || undefined,
    articleId: searchParams.get('article_id') || undefined,
    search: searchParams.get('search') || undefined,
    requestStatus: (searchParams.get('request_status') as RequestStatus | null) || undefined,
    flow: (searchParams.get('flow') as RegisterDrillParams['flow']) || undefined,
    frozen: (searchParams.get('frozen') as RegisterDrillParams['frozen']) || undefined,
  };
}
