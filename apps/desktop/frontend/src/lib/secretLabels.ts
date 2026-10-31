import type { Collection, Environment, KVRow, SavedRequest, Workspace } from './types/models';

export type SecretLabelContext = {
  requests: SavedRequest[];
  collections: Collection[];
  environments: Environment[];
  workspaces: Workspace[];
  cookies: Array<{ name: string; domain: string }>;
};

export type SecretLabel = {
  key: string;
  groupKey: string;
  groupKind: 'request' | 'collection' | 'environment' | 'cookies' | 'other';
  groupTitle: string;
  groupDetail: string;
  title: string;
  detail: string;
};

const FIELD_LABELS: Record<string, string> = {
  bearerToken: 'Bearer token',
  basicPass: 'Basic auth password',
  apiKeyValue: 'API key',
  oauth2Secret: 'OAuth 2.0 client secret',
  oauth2Token: 'OAuth 2.0 access token',
  oauth2RefreshToken: 'OAuth 2.0 refresh token',
  oauth2Password: 'OAuth 2.0 password',
  oauth2AssertionPrivateKey: 'JWT assertion private key',
  awsAccessKey: 'AWS access key',
  awsSecretKey: 'AWS secret key',
  awsSessionToken: 'AWS session token',
  digestPassword: 'Digest password',
  clientKeyPassword: 'Client key passphrase',
};

const LIST_LABELS: Record<string, string> = {
  headers: 'Header',
  params: 'Query parameter',
  pathParams: 'Path parameter',
  formRows: 'Form field',
  variables: 'Variable',
  sioEvents: 'Socket.IO event',
  grpcMetadata: 'gRPC metadata',
};

const GROUP_ORDER: SecretLabel['groupKind'][] = ['request', 'collection', 'environment', 'cookies', 'other'];

function humanize(field: string): string {
  const words = field.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1).toLowerCase() : field;
}

function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? humanize(field);
}

function rowLabel(list: string, rowId: string, rows: KVRow[] | undefined, hint: string): string {
  const kind = LIST_LABELS[list] ?? humanize(list);
  const row = rows?.find(candidate => String(candidate.id) === rowId);
  const name = row?.key.trim() || hint.trim();
  return name ? `${kind} “${name}”` : kind;
}

function requestRows(request: SavedRequest, list: string): KVRow[] | undefined {
  const value = (request as unknown as Record<string, unknown>)[list];
  return Array.isArray(value) ? value as KVRow[] : undefined;
}

function requestTitle(request: SavedRequest | undefined): string {
  return request?.name.trim() || 'Untitled request';
}

export function describeWorkspaceSecret(key: string, context: SecretLabelContext, rowKey = ''): SecretLabel {
  const parts = key.split('.');
  const base = { key, detail: '' };
  if (parts[0] === 'request' && parts.length >= 4) {
    const request = context.requests.find(candidate => candidate.id === parts[1]);
    const collection = request ? context.collections.find(candidate => candidate.id === request.collectionId) : undefined;
    const location = request ? [collection?.name ?? request.collection, ...(request.folderPath ?? [])].filter(Boolean).join(' / ') : '';
    const group = {
      groupKey: `request:${parts[1]}`,
      groupKind: 'request' as const,
      groupTitle: request ? requestTitle(request) : 'Request no longer in this workspace',
      groupDetail: request ? [request.requestType && request.requestType !== 'http' ? request.requestType.toUpperCase() : request.method, location].filter(Boolean).join(' · ') : '',
    };
    if ((parts[2] === 'auth' || parts[2] === 'settings') && parts.length === 4) return { ...base, ...group, title: fieldLabel(parts[3]) };
    if (parts[3] === 'row' && parts.length >= 5) return { ...base, ...group, title: rowLabel(parts[2], parts[4], request ? requestRows(request, parts[2]) : undefined, rowKey) };
    return { ...base, ...group, title: humanize(parts.slice(2).join(' ')) };
  }
  if (parts[0] === 'collection' && parts.length >= 4) {
    const collection = context.collections.find(candidate => candidate.id === parts[1]);
    const group = {
      groupKey: `collection:${parts[1]}`,
      groupKind: 'collection' as const,
      groupTitle: collection ? `Collection “${collection.name}”` : 'Collection no longer in this workspace',
      groupDetail: 'Shared by all its requests',
    };
    if ((parts[2] === 'auth' || parts[2] === 'settings') && parts.length === 4) return { ...base, ...group, title: fieldLabel(parts[3]) };
    if (parts[3] === 'row' && parts.length >= 5) {
      const rows = collection ? (parts[2] === 'variables' ? collection.defaults.variables : parts[2] === 'headers' ? collection.defaults.headers : undefined) : undefined;
      return { ...base, ...group, title: rowLabel(parts[2], parts[4], rows, rowKey) };
    }
    return { ...base, ...group, title: humanize(parts.slice(2).join(' ')) };
  }
  if (parts[0] === 'environment' && parts[2] === 'row' && parts.length >= 4) {
    const environment = context.environments.find(candidate => candidate.id === parts[1]);
    return {
      ...base,
      groupKey: `environment:${parts[1]}`,
      groupKind: 'environment',
      groupTitle: environment ? `Environment “${environment.name}”` : 'Environment no longer in this workspace',
      groupDetail: '',
      title: rowLabel('variables', parts[3], environment?.values, rowKey),
    };
  }
  if (parts[0] === 'workspace' && parts[2] === 'cookies' && parts.length >= 5) {
    const workspace = context.workspaces.find(candidate => candidate.id === parts[1]);
    const name = parts[3];
    const domains = [...new Set(context.cookies.filter(cookie => cookie.name === name).map(cookie => cookie.domain.replace(/^\./, '')))];
    return {
      ...base,
      groupKey: `cookies:${parts[1]}`,
      groupKind: 'cookies',
      groupTitle: 'Saved cookies',
      groupDetail: workspace ? `Cookie jar of ${workspace.name}` : 'Cookie jar',
      title: `Cookie “${name}”`,
      detail: domains.length === 1 ? domains[0] : '',
    };
  }
  return { ...base, groupKey: 'other', groupKind: 'other', groupTitle: 'Other secrets', groupDetail: '', title: key };
}

export function groupWorkspaceSecrets(refs: Array<{ key: string; rowKey?: string }>, context: SecretLabelContext): Array<{ key: string; kind: SecretLabel['groupKind']; title: string; detail: string; items: SecretLabel[] }> {
  const groups = new Map<string, { key: string; kind: SecretLabel['groupKind']; title: string; detail: string; items: SecretLabel[] }>();
  for (const ref of refs) {
    const label = describeWorkspaceSecret(ref.key, context, ref.rowKey ?? '');
    const group = groups.get(label.groupKey) ?? { key: label.groupKey, kind: label.groupKind, title: label.groupTitle, detail: label.groupDetail, items: [] };
    group.items.push(label);
    groups.set(label.groupKey, group);
  }
  return [...groups.values()].sort((a, b) => GROUP_ORDER.indexOf(a.kind) - GROUP_ORDER.indexOf(b.kind) || a.title.localeCompare(b.title));
}
