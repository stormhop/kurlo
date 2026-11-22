import { describe, expect, it } from 'vitest';
import {
  commandProblem, durationMs, secretCredentialProblem, urlProblem, validateSecretProviderDraft, type SecretProviderDraft,
} from '../lib/secretProviderValidation';
import type { SecretProviderType } from '../lib/secretProviderTypes';

function draft(patch: Partial<SecretProviderDraft> = {}): SecretProviderDraft {
  return {
    id: 'p', name: '', address: '', namespace: '', authMethod: '', roleId: '', role: '', mount: '', tokenPath: '', redirectUri: '',
    tenantId: '', clientId: '', username: '', roleArn: '', externalId: '', mfaSerial: '', project: '', command: '', caCert: '', verifyTls: true, account: '', region: '', profile: '', endpoint: '',
    cacheTtl: '5m', timeout: '', ...patch,
  };
}

function errors(type: SecretProviderType, patch: Partial<SecretProviderDraft> = {}, takenIds: string[] = [], isNew = true) {
  return validateSecretProviderDraft(draft(patch), type, { isNew, takenIds });
}

describe('secret provider validation', () => {
  it('accepts a minimal valid draft for every type', () => {
    expect(errors('env')).toEqual({});
    expect(errors('1password')).toEqual({});
    expect(errors('bitwarden')).toEqual({});
    expect(errors('doppler')).toEqual({});
    expect(errors('vault', { address: 'http://127.0.0.1:8200', authMethod: 'token' })).toEqual({});
    expect(errors('aws-ssm', { region: 'us-gov-west-1', endpoint: 'http://localhost:4566' })).toEqual({});
    expect(errors('gcp-secret-manager', { project: 'my-project-123' })).toEqual({});
    expect(errors('azure-key-vault', { address: 'https://k.vault.azure.net', authMethod: 'cli' })).toEqual({});
    expect(errors('infisical', { project: '6f1c', authMethod: 'token' })).toEqual({});
    expect(errors('command', { command: `pass show '{path}'` })).toEqual({});
  });

  it('checks the id', () => {
    expect(errors('env', { id: '' }).id).toMatch(/Enter an ID/);
    expect(errors('env', { id: 'Vault Prod' }).id).toMatch(/lowercase/);
    expect(errors('env', { id: 'vault' }, ['vault']).id).toMatch(/already uses/);
    expect(errors('env', { id: 'vault' }, ['vault'], false).id).toBeUndefined();
  });

  it('requires the fields each type needs', () => {
    expect(errors('vault').address).toMatch(/Enter the Vault address/);
    expect(errors('aws-secrets-manager').region).toMatch(/Enter a region/);
    expect(errors('gcp-secret-manager').project).toMatch(/project ID or number/);
    expect(errors('azure-key-vault').address).toMatch(/vault URL/);
    expect(errors('infisical').project).toMatch(/project ID/);
    expect(errors('command').command).toMatch(/Enter the command/);
    expect(errors('vault', { address: 'https://v.example.com', authMethod: 'approle' }).roleId).toMatch(/role ID/);
    expect(errors('vault', { address: 'https://v.example.com', authMethod: 'kubernetes' }).role).toMatch(/Vault role/);
    const azure = errors('azure-key-vault', { address: 'https://k.vault.azure.net', authMethod: 'client-secret' });
    expect(azure.tenantId).toMatch(/tenant ID/);
    expect(azure.clientId).toMatch(/client\) ID/);
    expect(errors('infisical', { project: 'x', authMethod: 'universal' }).clientId).toMatch(/client ID/);
  });

  it('rejects values that cannot work', () => {
    expect(errors('aws-ssm', { region: 'Frankfurt' }).region).toMatch(/AWS region/);
    expect(errors('gcp-secret-manager', { project: 'My Project' }).project).toMatch(/project ID like/);
    expect(errors('vault', { address: 'https://v.example.com', namespace: '/team/' }).namespace).toMatch(/leading and trailing/);
    expect(errors('vault', { address: 'https://v.example.com', authMethod: 'approle', roleId: 'r', mount: 'app role' }).mount).toMatch(/path like/);
    expect(errors('vault', { address: 'https://v.example.com', authMethod: 'oidc', redirectUri: 'https://example.com/cb' }).redirectUri).toMatch(/http:\/\/ address/);
    expect(errors('vault', { address: 'https://v.example.com', authMethod: 'oidc', redirectUri: 'http://example.com:8250/cb' }).redirectUri).toMatch(/localhost/);
    expect(errors('vault', { address: 'https://v.example.com', authMethod: 'oidc', redirectUri: 'http://localhost/cb' }).redirectUri).toMatch(/port/);
    expect(errors('azure-key-vault', { address: 'https://k.vault.azure.net', authMethod: 'client-secret', tenantId: 'contoso.onmicrosoft.com', clientId: 'my-app' }).clientId).toMatch(/00000000/);
    expect(errors('azure-key-vault', { address: 'https://k.vault.azure.net', tenantId: 'not a tenant' }).tenantId).toMatch(/tenant ID or a domain/);
    expect(errors('aws-ssm', { region: 'eu-west-1', profile: 'my profile' }).profile).toMatch(/spaces/);
    expect(errors('env', { name: 'x'.repeat(81) }).name).toMatch(/under 80/);
    expect(errors('command', { command: `pass show "{path}` }).command).toMatch(/double quote/);
  });

  it('checks the timeout range', () => {
    expect(errors('env', { timeout: '30' }).timeout).toBeUndefined();
    expect(errors('env', { timeout: '1m30s' }).timeout).toBeUndefined();
    expect(errors('env', { timeout: 'soon' }).timeout).toMatch(/duration/);
    expect(errors('env', { timeout: '500ms' }).timeout).toMatch(/1s to 10m/);
    expect(errors('env', { timeout: '1h' }).timeout).toMatch(/1s to 10m/);
    expect(durationMs('1m30s')).toBe(90_000);
    expect(durationMs('-5s')).toBeNull();
  });

  it('checks URLs', () => {
    expect(urlProblem('https://vault.example.com:8200/proxy')).toBe('');
    expect(urlProblem('vault.example.com')).toMatch(/https:\/\//);
    expect(urlProblem('https://')).toMatch(/host/);
    expect(urlProblem('https://vault example.com')).toMatch(/spaces/);
    expect(urlProblem('https://root:pw@vault.example.com')).toMatch(/user name/);
    expect(urlProblem('https://vault.example.com/?token=x')).toMatch(/after \?/);
    expect(urlProblem('https://vault.example.com:70000')).toMatch(/host/);
  });

  it('checks commands and credentials', () => {
    expect(commandProblem(`op read 'a "b'`)).toBe('');
    expect(commandProblem(`op read 'abc`)).toMatch(/single quote/);
    expect(secretCredentialProblem('token', '  hvs.abc  ')).toBe('');
    expect(secretCredentialProblem('token', 'hvs abc')).toMatch(/spaces/);
    expect(secretCredentialProblem('serviceAccountKey', 'nope')).toMatch(/JSON key file/);
    expect(secretCredentialProblem('serviceAccountKey', '{"type":"external_account"}')).toMatch(/service_account or authorized_user/);
    expect(secretCredentialProblem('serviceAccountKey', '{"type":"service_account","client_email":"a@b"}')).toMatch(/private_key/);
    expect(secretCredentialProblem('serviceAccountKey', '{"type":"service_account","client_email":"a@b","private_key":"k"}')).toBe('');
  });

  it('checks role, MFA, cache and Vault user name fields', () => {
    expect(errors('aws-ssm', { region: 'eu-west-1', roleArn: 'payments' }).roleArn).toMatch(/role ARN/);
    expect(errors('aws-ssm', { region: 'eu-west-1', roleArn: 'arn:aws:iam::123456789012:role/payments-read', externalId: 'x' }).externalId).toMatch(/2 to 1224/);
    expect(errors('aws-ssm', { region: 'eu-west-1', roleArn: 'arn:aws:iam::123456789012:role/payments-read', mfaSerial: 'arn:aws:iam::123456789012:mfa/ada' })).toEqual({});
    expect(errors('aws-ssm', { region: 'eu-west-1', mfaSerial: 'my phone' }).mfaSerial).toMatch(/MFA device ARN/);
    expect(errors('vault', { address: 'https://v.example.com', authMethod: 'ldap', username: 'ada lovelace' }).username).toMatch(/spaces/);
    expect(errors('env', { cacheTtl: '2h' }).cacheTtl).toBeUndefined();
    expect(errors('env', { cacheTtl: '0' }).cacheTtl).toBeUndefined();
    expect(errors('env', { cacheTtl: 'session' }).cacheTtl).toBeUndefined();
    expect(errors('env', { cacheTtl: '48h' }).cacheTtl).toMatch(/24h/);
    expect(errors('env', { cacheTtl: 'later' }).cacheTtl).toMatch(/duration/);
    expect(errors('env', { cacheTtl: '' }).cacheTtl).toMatch(/Enter a duration/);
    expect(secretCredentialProblem('mfaCode', '12345')).toMatch(/6 digits/);
    expect(secretCredentialProblem('mfaCode', '123456')).toBe('');
    expect(secretCredentialProblem('password', 'with spaces')).toBe('');
  });
});
