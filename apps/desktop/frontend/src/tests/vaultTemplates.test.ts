import { describe, expect, it } from 'vitest';
import { matchVariableSuggestions, templateVariableKey, type VariableSuggestion } from '../lib/variables';
import { requestVariableValues } from '../lib/collectionDefaults';

const suggestions: VariableSuggestion[] = [
  { key: 'baseUrl', value: 'https://api.example.com' },
  { key: 'apiToken', value: '', secret: true, linked: { provider: 'vault-prod', path: 'secret/data/app', field: 'token' } },
  { key: 'dbPassword', value: 'pw', secret: true },
  { key: 'vaultRegion', value: 'eu' },
];

describe('{{vault:name}} templates', () => {
  it('reads the variable after vault:', () => {
    expect(templateVariableKey(' vault: apiToken ')).toBe('apiToken');
    expect(templateVariableKey('vaultRegion')).toBe('vaultRegion');
    expect(templateVariableKey('apiToken')).toBe('apiToken');
  });

  it('suggests secret variables after vault: with linked ones first', () => {
    const result = matchVariableSuggestions(suggestions, 'vault:');
    expect(result.vault).toBe(true);
    expect(result.items.map(item => item.key)).toEqual(['apiToken', 'dbPassword']);
    expect(matchVariableSuggestions(suggestions, 'vault:db').items.map(item => item.key)).toEqual(['dbPassword']);
  });

  it('offers vault: while typing it', () => {
    const result = matchVariableSuggestions(suggestions, 'va');
    expect(result.vault).toBe(false);
    expect(result.items[0]).toMatchObject({ key: 'vault:' });
    expect(result.items[0].description).toMatch(/2 secret variables/);
    expect(result.items.map(item => item.key)).toContain('vaultRegion');
    expect(matchVariableSuggestions([{ key: 'plain', value: '' }], 'va').items).toEqual([]);
    expect(matchVariableSuggestions(suggestions, '').items.map(item => item.key)).not.toContain('vault:');
  });

  it('resolves request variables written with vault:', () => {
    const values = requestVariableValues([{ id: 1, key: 'auth', value: 'Bearer {{vault:apiToken}}', enabled: true, description: '' }], { apiToken: 'T' });
    expect(values.auth).toBe('Bearer T');
  });
});
