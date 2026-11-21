import type { SecretProviderStatus, SecretProviderView } from './wire';

export type SecretProviderType =
  | 'vault' | '1password' | 'aws-secrets-manager' | 'aws-ssm' | 'gcp-secret-manager' | 'azure-key-vault'
  | 'bitwarden' | 'doppler' | 'infisical' | 'command' | 'env';

export type SecretProviderTypeInfo = {
  type: SecretProviderType;
  name: string;
  short: string;
  monogram: string;
  description: string;
  pathPlaceholder: string;
  pathHint: string;
  fieldHint: string;
  versionHint: string;
  idSuggestion: string;
  sourceHint: string;
  sourcePlaceholder?: string;
  browse: boolean;
};

export const SECRET_PROVIDER_TYPES: SecretProviderTypeInfo[] = [
  {
    type: 'vault', name: 'HashiCorp Vault', short: 'Vault', monogram: 'V',
    description: 'Also OpenBao. KV v1/v2 and dynamic secrets. Token, AppRole, Kubernetes or OIDC.',
    pathPlaceholder: 'secret/data/app', pathHint: 'Full API path, with data/ for KV v2.', fieldHint: 'Key inside the secret', versionHint: 'KV v2 version', idSuggestion: 'vault',
    sourceHint: 'A KV secret. Each key becomes a variable.', browse: true,
  },
  {
    type: '1password', name: '1Password', short: '1Password', monogram: '1P',
    description: 'Uses the op CLI and the desktop app, or a service account in CI.',
    pathPlaceholder: 'op://Payments/Stripe/credential', pathHint: 'op://Vault/Item/field, or op://Vault/Item and a field.', fieldHint: 'Field label', versionHint: '', idSuggestion: 'op',
    sourceHint: 'op://Vault/Item. Each field of the item becomes a variable.', sourcePlaceholder: 'op://Payments/Checkout', browse: true,
  },
  {
    type: 'aws-secrets-manager', name: 'AWS Secrets Manager', short: 'AWS', monogram: 'AWS',
    description: 'Profile, SSO or environment credentials. JSON fields.',
    pathPlaceholder: 'prod/orders/db', pathHint: 'Secret name or ARN.', fieldHint: 'JSON key', versionHint: 'AWSCURRENT, AWSPREVIOUS or a version id', idSuggestion: 'aws',
    sourceHint: 'A JSON secret. Each key becomes a variable.', browse: true,
  },
  {
    type: 'aws-ssm', name: 'AWS Parameter Store', short: 'SSM', monogram: 'SSM',
    description: 'SecureString parameters, decrypted on read.',
    pathPlaceholder: '/prod/orders/api-key', pathHint: 'Parameter name.', fieldHint: 'JSON key, if the value is JSON', versionHint: 'Parameter version', idSuggestion: 'ssm',
    sourceHint: 'A parameter that holds JSON. Each key becomes a variable.', browse: true,
  },
  {
    type: 'gcp-secret-manager', name: 'Google Secret Manager', short: 'GCP', monogram: 'GCP',
    description: 'Application default credentials, gcloud or a service account key.',
    pathPlaceholder: 'orders-db', pathHint: 'Secret name, or projects/<project>/secrets/<name>.', fieldHint: 'JSON key, if the value is JSON', versionHint: 'Version number', idSuggestion: 'gcp',
    sourceHint: 'A JSON secret. Each key becomes a variable.', browse: true,
  },
  {
    type: 'azure-key-vault', name: 'Azure Key Vault', short: 'Azure', monogram: 'AZ',
    description: 'Azure CLI sign-in or an app registration with a client secret.',
    pathPlaceholder: 'orders-db-password', pathHint: 'Secret name.', fieldHint: 'JSON key, if the value is JSON', versionHint: 'Version id', idSuggestion: 'azure',
    sourceHint: 'A secret that holds JSON. Each key becomes a variable.', browse: true,
  },
  {
    type: 'bitwarden', name: 'Bitwarden Secrets Manager', short: 'Bitwarden', monogram: 'BW',
    description: 'Uses the bws CLI with a machine account access token.',
    pathPlaceholder: 'STRIPE_KEY', pathHint: 'Secret id or name, or projects/<project id> with a field.', fieldHint: 'Secret name, for a project', versionHint: '', idSuggestion: 'bitwarden',
    sourceHint: 'projects/<project id>. Each secret of the project becomes a variable.', sourcePlaceholder: 'projects/…', browse: true,
  },
  {
    type: 'doppler', name: 'Doppler', short: 'Doppler', monogram: 'DP',
    description: 'Service token, DOPPLER_TOKEN or the doppler CLI sign-in.',
    pathPlaceholder: 'backend/prd', pathHint: 'project/config with a field, or project/config/NAME.', fieldHint: 'Secret name', versionHint: '', idSuggestion: 'doppler',
    sourceHint: 'project/config. Each secret of the config becomes a variable.', browse: true,
  },
  {
    type: 'infisical', name: 'Infisical', short: 'Infisical', monogram: 'IN',
    description: 'Machine identity (universal auth) or a token. Cloud or self-hosted.',
    pathPlaceholder: 'prod/backend', pathHint: 'Environment slug and an optional folder.', fieldHint: 'Secret name', versionHint: '', idSuggestion: 'infisical',
    sourceHint: 'An environment and folder. Each secret in it becomes a variable.', browse: true,
  },
  {
    type: 'command', name: 'Command', short: 'Command', monogram: '>_',
    description: 'Runs a program you choose, like pass or a company helper, and reads its output.',
    pathPlaceholder: 'team/orders-db', pathHint: 'Passed to the command as {path}.', fieldHint: 'JSON key, if the output is JSON', versionHint: 'Passed as {version}', idSuggestion: 'command',
    sourceHint: 'A path whose output is JSON. Each key becomes a variable.', browse: false,
  },
  {
    type: 'env', name: 'Environment variables', short: 'Env', monogram: '$',
    description: 'Reads variables of the Kurlo process. Handy in CI.',
    pathPlaceholder: 'KURLO_CI_TOKEN', pathHint: 'Variable name.', fieldHint: 'JSON key, if the value is JSON', versionHint: '', idSuggestion: 'env',
    sourceHint: 'A variable that holds JSON. Each key becomes a variable.', browse: false,
  },
];

export function secretProviderTypeInfo(type: string): SecretProviderTypeInfo | undefined {
  return SECRET_PROVIDER_TYPES.find(item => item.type === type);
}

export function secretProviderMonogram(type: string) {
  return secretProviderTypeInfo(type)?.monogram ?? '?';
}

export type SecretProviderState = 'ok' | 'ready' | 'signin' | 'untrusted' | 'nocli' | 'error' | 'checking' | 'unknown' | 'invalid';

export const SECRET_PROVIDER_STATE_LABELS: Record<SecretProviderState, string> = {
  ok: 'Connected',
  ready: 'Ready',
  signin: 'Sign in required',
  untrusted: 'Not trusted on this device',
  nocli: 'CLI not installed',
  error: 'Error',
  checking: 'Checking…',
  unknown: 'Not checked',
  invalid: 'Invalid settings',
};

export function secretProviderState(provider: SecretProviderView, status: SecretProviderStatus | 'checking' | undefined): SecretProviderState {
  if (!provider.valid) return 'invalid';
  if (!provider.trusted) return 'untrusted';
  if (status === 'checking') return 'checking';
  if (!status) return 'unknown';
  if (status.ok) return provider.type === 'env' || provider.type === 'command' ? 'ready' : 'ok';
  return secretKindState(status.kind ?? '');
}

export function secretKindState(kind: string): SecretProviderState {
  switch (kind) {
    case 'not_authenticated': return 'signin';
    case 'untrusted': return 'untrusted';
    case 'tool_missing': return 'nocli';
    default: return 'error';
  }
}

export function secretKindAction(kind: string): 'signin' | 'trust' | 'install' | 'open' | 'edit' | 'retry' {
  switch (kind) {
    case 'not_authenticated': return 'signin';
    case 'untrusted': return 'trust';
    case 'tool_missing': return 'install';
    case 'forbidden': return 'open';
    case 'not_found':
    case 'invalid_ref': return 'edit';
    default: return 'retry';
  }
}

export function secretProviderSummary(provider: SecretProviderView) {
  const config = provider.config as Record<string, unknown>;
  const text = (key: string) => (typeof config[key] === 'string' ? (config[key] as string) : '');
  const info = secretProviderTypeInfo(provider.type);
  switch (provider.type) {
    case 'vault': {
      const method = (config.auth as Record<string, unknown> | undefined)?.method;
      const auth = ({ approle: 'AppRole', kubernetes: 'Kubernetes', oidc: 'OIDC' } as Record<string, string>)[typeof method === 'string' ? method : ''] ?? 'token';
      return [info?.name, text('address').replace(/^https?:\/\//, ''), text('namespace') && `namespace ${text('namespace')}`, auth].filter(Boolean).join(' · ');
    }
    case '1password':
      return [info?.name, text('account') || 'default account', 'op CLI'].filter(Boolean).join(' · ');
    case 'aws-secrets-manager':
    case 'aws-ssm':
      return [info?.name, text('region'), text('profile') ? `profile ${text('profile')}` : 'default credentials'].filter(Boolean).join(' · ');
    case 'gcp-secret-manager':
      return [info?.name, text('project'), 'default credentials'].filter(Boolean).join(' · ');
    case 'azure-key-vault': {
      const method = (config.auth as Record<string, unknown> | undefined)?.method === 'client-secret' ? 'client secret' : 'Azure CLI';
      return [info?.name, text('address').replace(/^https?:\/\//, '').replace(/\/$/, ''), method].filter(Boolean).join(' · ');
    }
    case 'bitwarden':
      return [info?.name, text('address').replace(/^https?:\/\//, '') || 'bitwarden.com', 'bws CLI'].filter(Boolean).join(' · ');
    case 'doppler':
      return [info?.name, text('address').replace(/^https?:\/\//, '') || 'api.doppler.com'].filter(Boolean).join(' · ');
    case 'infisical': {
      const method = (config.auth as Record<string, unknown> | undefined)?.method === 'universal' ? 'machine identity' : 'token';
      return [info?.name, text('address').replace(/^https?:\/\//, '') || 'app.infisical.com', `project ${text('project')}`, method].filter(Boolean).join(' · ');
    }
    case 'command':
      return `Runs ${joinCommand(commandList(config.command))}`;
    case 'env':
      return 'Environment variables of the Kurlo process';
    default:
      return provider.type;
  }
}

export function commandList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value === 'string') return splitCommand(value);
  return [];
}

export function splitCommand(text: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | '' = '';
  let started = false;
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = '';
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) out.push(current);
      current = '';
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) out.push(current);
  return out;
}

export function joinCommand(args: string[]): string {
  return args.map(arg => (arg === '' || /[\s"']/.test(arg) ? `'${arg.replace(/'/g, "'\"'\"'")}'` : arg)).join(' ');
}

export const SECRET_TOOL_INSTALL_URLS: Record<string, string> = {
  '1password': 'https://developer.1password.com/docs/cli/get-started/',
  'azure-key-vault': 'https://learn.microsoft.com/cli/azure/install-azure-cli',
  bitwarden: 'https://bitwarden.com/help/secrets-manager-cli/',
  'gcp-secret-manager': 'https://cloud.google.com/sdk/docs/install',
  'aws-secrets-manager': 'https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html',
  'aws-ssm': 'https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html',
};
