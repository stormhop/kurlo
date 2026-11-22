import type { SecretProviderType } from './secretProviderTypes';

export type ParsedSecretReference = {
  type: SecretProviderType;
  path: string;
  field?: string;
  version?: string;
  host?: string;
  region?: string;
  label: string;
};

export type ReferenceProvider = { id: string; type: string; config?: Record<string, unknown> };

function decode(part: string) {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

function splitField(text: string): { path: string; field?: string } {
  const hash = text.lastIndexOf('#');
  if (hash <= 0) return { path: text };
  const field = text.slice(hash + 1).trim();
  return field ? { path: text.slice(0, hash), field } : { path: text.slice(0, hash) };
}

export function parseSecretReference(raw: string): ParsedSecretReference | null {
  const text = raw.trim();
  if (!text || /\s/.test(text)) return null;

  if (/^op:\/\/[^/]+\/[^/]+/.test(text)) return { type: '1password', path: text, label: '1Password secret reference' };

  let match = /^arn:aws[a-z-]*:secretsmanager:([a-z0-9-]+):\d{12}:secret:(.+)$/.exec(text);
  if (match) {
    const { path, field } = splitField(text);
    return { type: 'aws-secrets-manager', path, field, region: match[1], label: 'AWS Secrets Manager ARN' };
  }
  match = /^arn:aws[a-z-]*:ssm:([a-z0-9-]+):\d{12}:parameter(\/.+)$/.exec(text);
  if (match) {
    const { path, field } = splitField(match[2]);
    return { type: 'aws-ssm', path, field, region: match[1], label: 'AWS Parameter Store ARN' };
  }

  match = /^projects\/([^/#]+)\/secrets\/([^/#]+)(?:\/versions\/([^/#]+))?(?:#(.+))?$/.exec(text);
  if (match) {
    const version = match[3] && match[3] !== 'latest' ? match[3] : undefined;
    return { type: 'gcp-secret-manager', path: `projects/${match[1]}/secrets/${match[2]}`, version, field: match[4], label: 'Google Cloud secret name' };
  }

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.host.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean).map(decode);
  const field = url.hash ? decode(url.hash.slice(1)) || undefined : undefined;

  if (/\.vault\.(azure\.net|azure\.cn|usgovcloudapi\.net|microsoftazure\.de)$/.test(url.hostname) && segments[0] === 'secrets' && segments[1]) {
    return { type: 'azure-key-vault', path: segments[1], version: segments[2] || undefined, field, host, label: 'Azure Key Vault secret identifier' };
  }
  if (segments[0] === 'v1' && segments.length > 1) {
    return { type: 'vault', path: segments.slice(1).join('/'), field, version: url.searchParams.get('version') ?? undefined, host, label: 'Vault API URL' };
  }
  const ui = segments.indexOf('ui');
  if (ui >= 0 && segments[ui + 1] === 'vault' && segments[ui + 2] === 'secrets' && segments[ui + 3]) {
    const mount = segments[ui + 3];
    const rest = segments.slice(ui + 4).filter(part => part !== 'details' && part !== 'show');
    if (rest[0] === 'kv' && rest.length > 1) {
      return { type: 'vault', path: [mount, 'data', ...rest.slice(1)].join('/'), field, version: url.searchParams.get('version') ?? undefined, host, label: 'Vault UI link' };
    }
    if (rest.length) return { type: 'vault', path: [mount, ...rest].join('/'), field, host, label: 'Vault UI link' };
  }
  return null;
}

function hostOf(value: unknown) {
  if (typeof value !== 'string' || !value) return '';
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return '';
  }
}

export function matchReferenceProvider<T extends ReferenceProvider>(parsed: ParsedSecretReference, providers: T[], preferredId = ''): T | undefined {
  const candidates = providers.filter(provider => provider.type === parsed.type);
  if (!candidates.length) return undefined;
  const exact = candidates.filter(provider => {
    const config = provider.config ?? {};
    if (parsed.host) return hostOf(config.address) === parsed.host;
    if (parsed.region) return config.region === parsed.region;
    return true;
  });
  const pool = exact.length ? exact : parsed.host ? [] : candidates;
  return pool.find(provider => provider.id === preferredId) ?? pool[0];
}
