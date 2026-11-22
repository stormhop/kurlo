import vault from './assets/secret-providers/vault.svg';
import onePassword from './assets/secret-providers/1password.svg';
import awsSecretsManager from './assets/secret-providers/aws-secrets-manager.svg';
import awsParameterStore from './assets/secret-providers/aws-ssm.svg';
import gcpSecretManager from './assets/secret-providers/gcp-secret-manager.svg';
import azureKeyVault from './assets/secret-providers/azure-key-vault.svg';
import bitwarden from './assets/secret-providers/bitwarden.svg';
import doppler from './assets/secret-providers/doppler.svg';
import infisical from './assets/secret-providers/infisical.svg';

export type SecretProviderLogo = { src: string; mono: boolean };

const LOGOS: Record<string, SecretProviderLogo> = {
  vault: { src: vault, mono: true },
  '1password': { src: onePassword, mono: true },
  'aws-secrets-manager': { src: awsSecretsManager, mono: false },
  'aws-ssm': { src: awsParameterStore, mono: false },
  'gcp-secret-manager': { src: gcpSecretManager, mono: false },
  'azure-key-vault': { src: azureKeyVault, mono: false },
  bitwarden: { src: bitwarden, mono: true },
  doppler: { src: doppler, mono: false },
  infisical: { src: infisical, mono: true },
};

export function secretProviderLogo(type: string): SecretProviderLogo | undefined {
  return LOGOS[type];
}
