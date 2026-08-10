import type { RegistryView } from '../components/approval-register/registryConfig';
import type { RequestStatus, User } from '../types';

export type RegisterDrillParams = {
  view?: RegistryView;
  cfoId?: string;
  articleId?: string;
  search?: string;
  requestStatus?: RequestStatus | '';
};

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

  if (user.role === 'admin') {
    search.set('view', 'table');
    return `/?${search.toString()}`;
  }

  const query = search.toString();
  return `/requests${query ? `?${query}` : ''}`;
}

export function buildRequestsHref(params: { status?: RequestStatus | ''; frozen?: 'fixed' | 'frozen' | '' } = {}): string {
  const search = new URLSearchParams();
  if (params.status) search.set('status', params.status);
  if (params.frozen) search.set('frozen', params.frozen);
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
  };
}
