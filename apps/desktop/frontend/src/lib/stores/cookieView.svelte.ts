export type CookieSection = 'domains' | 'sync';

export const cookieView = $state({
  section: 'domains' as CookieSection,
  domain: '',
  filter: '',
  manualDomains: [] as string[],
  newCookieFor: '',
  workspaceId: '',
});

export function selectCookieDomain(domain: string) {
  cookieView.section = 'domains';
  cookieView.domain = domain;
}

export function selectCookieSync() {
  cookieView.section = 'sync';
}

export function syncCookieViewWorkspace(workspaceId: string) {
  if (cookieView.workspaceId === workspaceId) return;
  cookieView.workspaceId = workspaceId;
  cookieView.domain = '';
  cookieView.filter = '';
  cookieView.manualDomains = [];
  cookieView.newCookieFor = '';
}
