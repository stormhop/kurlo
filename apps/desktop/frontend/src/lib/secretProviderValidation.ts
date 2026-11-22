import type { SecretProviderType } from './secretProviderTypes';

export type SecretProviderDraft = {
  id: string; name: string; address: string; namespace: string; authMethod: string; roleId: string; role: string; mount: string;
  tokenPath: string; redirectUri: string; tenantId: string; clientId: string; username: string; roleArn: string; externalId: string; mfaSerial: string; project: string; command: string;
  caCert: string; verifyTls: boolean; account: string; region: string; profile: string; endpoint: string; cacheTtl: string; timeout: string;
};

export type SecretProviderDraftErrors = Partial<Record<keyof SecretProviderDraft, string>>;

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const AWS_REGION_PATTERN = /^[a-z]{2}(-[a-z]+)+-\d$/;
const GCP_PROJECT_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$|^[0-9]{6,20}$/;
const MOUNT_PATTERN = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/;
const GUID_PATTERN = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const DOMAIN_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const DURATION_PATTERN = /^(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+$/;
const DURATION_UNITS: Record<string, number> = { ns: 1e-6, us: 1e-3, 'µs': 1e-3, ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
const SPACE = /\s/;
const ROLE_ARN_PATTERN = /^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]+$/;
const MFA_SERIAL_PATTERN = /^arn:aws[a-z-]*:iam::\d{12}:mfa\/[\w+=,.@/-]+$|^[A-Z0-9]{9,64}$/;

export const MAX_PROVIDER_NAME = 80;

export function urlProblem(value: string): string {
  if (!/^https?:\/\//.test(value)) return 'Start with https:// or http://.';
  if (SPACE.test(value)) return 'Remove the spaces.';
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return 'Enter a URL with a host, like https://vault.example.com.';
  }
  if (!parsed.hostname) return 'Enter a URL with a host, like https://vault.example.com.';
  if (parsed.username || parsed.password) return 'Remove the user name and password. Save credentials on this device instead.';
  if (value.includes('?') || value.includes('#')) return 'Remove the part after ? or #.';
  return '';
}

export function durationMs(value: string): number | null {
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  if (!DURATION_PATTERN.test(text)) return null;
  let total = 0;
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g)) total += Number(match[1]) * DURATION_UNITS[match[2]];
  return total;
}

export function commandProblem(text: string): string {
  if (!text.trim()) return 'Enter the command that prints the secret.';
  let quote = '';
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
    }
  }
  if (quote) return `Close the ${quote === '"' ? 'double' : 'single'} quote.`;
  return '';
}

function redirectProblem(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return 'Enter an http:// address on this computer, like http://localhost:8250/oidc/callback.';
  }
  if (parsed.protocol !== 'http:') return 'Enter an http:// address on this computer, like http://localhost:8250/oidc/callback.';
  if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) return 'Point it to localhost, like http://localhost:8250/oidc/callback.';
  if (!parsed.port) return 'Add a port, like http://localhost:8250/oidc/callback.';
  return '';
}

export function validateSecretProviderDraft(
  draft: SecretProviderDraft,
  type: SecretProviderType,
  options: { isNew: boolean; takenIds: Iterable<string> },
): SecretProviderDraftErrors {
  const errors: SecretProviderDraftErrors = {};
  const value = (key: keyof SecretProviderDraft) => String(draft[key] ?? '').trim();
  const noSpaces = (key: keyof SecretProviderDraft) => {
    if (!errors[key] && SPACE.test(value(key))) errors[key] = 'Remove the spaces.';
  };
  const url = (key: keyof SecretProviderDraft, required: boolean, label: string) => {
    const text = value(key);
    if (!text) {
      if (required) errors[key] = `Enter the ${label}.`;
      return;
    }
    const problem = urlProblem(text);
    if (problem) errors[key] = problem;
  };

  const id = value('id');
  if (!id) errors.id = 'Enter an ID.';
  else if (!ID_PATTERN.test(id)) errors.id = 'Use lowercase letters, digits, - or _, starting with a letter or digit, up to 64 characters.';
  else if (options.isNew && new Set(options.takenIds).has(id)) errors.id = 'Another provider already uses this ID.';

  if (value('name').length > MAX_PROVIDER_NAME) errors.name = `Keep it under ${MAX_PROVIDER_NAME} characters.`;

  const cacheTtl = value('cacheTtl');
  if (cacheTtl && cacheTtl !== 'session') {
    const ms = durationMs(cacheTtl);
    if (ms === null) errors.cacheTtl = 'Use a duration like 30m or 2h.';
    else if (ms > 86_400_000) errors.cacheTtl = 'Use up to 24h, or Session.';
  } else if (!cacheTtl) {
    errors.cacheTtl = 'Enter a duration like 30m.';
  }

  const timeout = value('timeout');
  if (timeout) {
    const ms = durationMs(timeout);
    if (ms === null) errors.timeout = 'Use a duration like 10s or 1m.';
    else if (ms < 1000 || ms > 600_000) errors.timeout = 'Use 1s to 10m.';
  }

  switch (type) {
    case 'vault': {
      url('address', true, 'Vault address');
      const namespace = value('namespace');
      if (namespace.startsWith('/') || namespace.endsWith('/')) errors.namespace = 'Remove the leading and trailing /.';
      noSpaces('namespace');
      const method = draft.authMethod;
      if (method === 'approle') {
        if (!value('roleId')) errors.roleId = 'Enter the role ID.';
        noSpaces('roleId');
      }
      if (method === 'kubernetes' && !value('role')) errors.role = 'Enter the Vault role.';
      if (method === 'kubernetes' || method === 'oidc') noSpaces('role');
      if (method !== 'token') {
        const mount = value('mount').replace(/^\/+|\/+$/g, '');
        if (mount && !MOUNT_PATTERN.test(mount)) errors.mount = 'Use a path like approle or team/approle.';
      }
      if (method === 'ldap' || method === 'userpass') noSpaces('username');
      if (method === 'oidc' && value('redirectUri')) {
        const problem = redirectProblem(value('redirectUri'));
        if (problem) errors.redirectUri = problem;
      }
      break;
    }
    case '1password':
      noSpaces('account');
      break;
    case 'aws-secrets-manager':
    case 'aws-ssm': {
      const region = value('region');
      if (!region) errors.region = 'Enter a region, like eu-central-1.';
      else if (!AWS_REGION_PATTERN.test(region)) errors.region = 'Use an AWS region like eu-central-1.';
      noSpaces('profile');
      url('endpoint', false, 'endpoint');
      const roleArn = value('roleArn');
      if (roleArn && !ROLE_ARN_PATTERN.test(roleArn)) errors.roleArn = 'Use a role ARN like arn:aws:iam::123456789012:role/name.';
      const externalId = value('externalId');
      if (roleArn && externalId && (externalId.length < 2 || externalId.length > 1224)) errors.externalId = 'Use 2 to 1224 characters.';
      if (roleArn) noSpaces('externalId');
      const mfaSerial = value('mfaSerial');
      if (mfaSerial && !MFA_SERIAL_PATTERN.test(mfaSerial)) errors.mfaSerial = 'Use the MFA device ARN like arn:aws:iam::123456789012:mfa/name.';
      break;
    }
    case 'gcp-secret-manager': {
      const project = value('project');
      if (!project) errors.project = 'Enter the project ID or number.';
      else if (!GCP_PROJECT_PATTERN.test(project)) errors.project = 'Use a project ID like my-project-123 or a project number.';
      url('endpoint', false, 'endpoint');
      break;
    }
    case 'azure-key-vault': {
      url('address', true, 'vault URL');
      const tenant = value('tenantId');
      const client = value('clientId');
      if (draft.authMethod === 'client-secret') {
        if (!tenant) errors.tenantId = 'Enter the tenant ID.';
        if (!client) errors.clientId = 'Enter the application (client) ID.';
        else if (!GUID_PATTERN.test(client)) errors.clientId = 'Use the application (client) ID, like 00000000-0000-0000-0000-000000000000.';
      }
      if (tenant && !errors.tenantId && !GUID_PATTERN.test(tenant) && !DOMAIN_PATTERN.test(tenant)) errors.tenantId = 'Use a tenant ID or a domain like contoso.onmicrosoft.com.';
      break;
    }
    case 'bitwarden':
    case 'doppler':
      url('address', false, 'server');
      break;
    case 'infisical':
      url('address', false, 'server');
      if (!value('project')) errors.project = 'Enter the project ID.';
      noSpaces('project');
      if (draft.authMethod === 'universal') {
        if (!value('clientId')) errors.clientId = 'Enter the client ID.';
        noSpaces('clientId');
      }
      break;
    case 'command': {
      const problem = commandProblem(draft.command);
      if (problem) errors.command = problem;
      break;
    }
  }
  return errors;
}

export function secretCredentialProblem(name: string, raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  if (name === 'serviceAccountKey') {
    let key: Record<string, unknown>;
    try {
      key = JSON.parse(value);
    } catch {
      return 'Paste the whole JSON key file downloaded from Google Cloud.';
    }
    if (!key || typeof key !== 'object') return 'Paste the whole JSON key file downloaded from Google Cloud.';
    if (key.type === 'service_account') return key.client_email && key.private_key ? '' : 'The key has no client_email or private_key.';
    if (key.type === 'authorized_user') return key.refresh_token ? '' : 'The key has no refresh_token.';
    return 'Use a service_account or authorized_user key.';
  }
  if (name === 'mfaCode') return /^\d{6}$/.test(value) ? '' : 'Enter the 6 digits from your MFA device.';
  if (name === 'password') return /[\r\n]/.test(value) ? 'Remove the line breaks.' : '';
  if (SPACE.test(value)) return 'Remove the spaces and line breaks.';
  if (value.length > 16384) return 'This value is too long.';
  return '';
}
