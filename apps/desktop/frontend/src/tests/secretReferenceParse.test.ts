import { describe, expect, it } from 'vitest';
import { matchReferenceProvider, parseSecretReference } from '../lib/secretReferenceParse';

describe('pasted secret references', () => {
  it('recognizes each provider format', () => {
    expect(parseSecretReference('op://Payments/Stripe/credential')).toMatchObject({ type: '1password', path: 'op://Payments/Stripe/credential' });
    expect(parseSecretReference('arn:aws:secretsmanager:eu-central-1:123456789012:secret:prod/db-AbCdEf#password')).toMatchObject({
      type: 'aws-secrets-manager', path: 'arn:aws:secretsmanager:eu-central-1:123456789012:secret:prod/db-AbCdEf', field: 'password', region: 'eu-central-1',
    });
    expect(parseSecretReference('arn:aws:ssm:us-east-1:123456789012:parameter/prod/api-key')).toMatchObject({ type: 'aws-ssm', path: '/prod/api-key', region: 'us-east-1' });
    expect(parseSecretReference('projects/my-project/secrets/db/versions/3')).toMatchObject({ type: 'gcp-secret-manager', path: 'projects/my-project/secrets/db', version: '3' });
    expect(parseSecretReference('projects/my-project/secrets/db/versions/latest')?.version).toBeUndefined();
    expect(parseSecretReference('https://team.vault.azure.net/secrets/db-password/0b1c2d')).toMatchObject({ type: 'azure-key-vault', path: 'db-password', version: '0b1c2d', host: 'team.vault.azure.net' });
    expect(parseSecretReference('https://vault.example.com:8200/v1/secret/data/app#token')).toMatchObject({ type: 'vault', path: 'secret/data/app', field: 'token', host: 'vault.example.com:8200' });
    expect(parseSecretReference('https://vault.example.com/ui/vault/secrets/secret/kv/team%2Fapp/details?version=2')).toMatchObject({ type: 'vault', path: 'secret/data/team/app', version: '2' });
  });

  it('ignores plain paths and text', () => {
    for (const text of ['secret/data/app', 'prod/db', 'STRIPE_KEY', 'https://example.com/api', 'op read x', '']) expect(parseSecretReference(text)).toBeNull();
  });

  it('matches the provider by host or region', () => {
    const providers = [
      { id: 'vault-a', type: 'vault', config: { address: 'https://vault-a.example.com' } },
      { id: 'vault-b', type: 'vault', config: { address: 'https://vault-b.example.com/' } },
      { id: 'aws-us', type: 'aws-secrets-manager', config: { region: 'us-east-1' } },
      { id: 'aws-eu', type: 'aws-secrets-manager', config: { region: 'eu-central-1' } },
    ];
    expect(matchReferenceProvider(parseSecretReference('https://vault-b.example.com/v1/kv/x')!, providers)?.id).toBe('vault-b');
    expect(matchReferenceProvider(parseSecretReference('https://other.example.com/v1/kv/x')!, providers)).toBeUndefined();
    expect(matchReferenceProvider(parseSecretReference('arn:aws:secretsmanager:eu-central-1:123456789012:secret:x')!, providers)?.id).toBe('aws-eu');
    expect(matchReferenceProvider(parseSecretReference('op://a/b/c')!, providers)).toBeUndefined();
  });
});
