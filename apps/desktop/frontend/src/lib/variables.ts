export type VariableSuggestion = {
  key: string;
  value: string;
  description?: string;
  secret?: boolean;
  linked?: { provider: string; path: string; field?: string };
};

const SECRET_MASK = '••••••';

export function variableDisplayValue(variable: VariableSuggestion) {
  if (variable.linked) return `${variable.linked.provider} · ${variable.linked.path}${variable.linked.field ? `#${variable.linked.field}` : ''}`;
  return variable.secret ? SECRET_MASK : variable.value;
}

export function variableTemplate(key: string) {
  return `{{${key}}}`;
}

export function isVariableReferenceOnly(value: string | undefined) {
  return !!value && /^(\s*\{\{[^{}]+}})+\s*$/.test(value);
}

export function isWorkspaceSecretReference(value: string | undefined): boolean {
  return !!value && /^\{\{kurloSecret:[^{}]+\}\}$/.test(value);
}

export const VAULT_TEMPLATE_PREFIX = 'vault:';

export function templateVariableKey(raw: string) {
  const key = raw.trim();
  return key.startsWith(VAULT_TEMPLATE_PREFIX) ? key.slice(VAULT_TEMPLATE_PREFIX.length).trim() : key;
}

export function isVaultSuggestion(variable: VariableSuggestion) {
  return Boolean(variable.linked || variable.secret);
}

export function vaultPrefixSuggestion(suggestions: VariableSuggestion[]): VariableSuggestion | null {
  const count = suggestions.filter(isVaultSuggestion).length;
  if (!count) return null;
  return { key: VAULT_TEMPLATE_PREFIX, value: '', description: `${count} secret ${count === 1 ? 'variable' : 'variables'}, as in Postman Vault` };
}

export function matchVariableSuggestions(suggestions: VariableSuggestion[], prefix: string, limit = 12) {
  const vault = prefix.trimStart().startsWith(VAULT_TEMPLATE_PREFIX);
  const needle = (vault ? prefix.trimStart().slice(VAULT_TEMPLATE_PREFIX.length).trimStart() : prefix).toLowerCase();
  const pool = vault ? suggestions.filter(isVaultSuggestion) : suggestions;
  const items = pool
    .filter(item => item.key.toLowerCase().includes(needle))
    .sort((a, b) => {
      const ap = a.key.toLowerCase().startsWith(needle) ? 0 : 1;
      const bp = b.key.toLowerCase().startsWith(needle) ? 0 : 1;
      const al = a.linked ? 0 : 1;
      const bl = b.linked ? 0 : 1;
      return ap - bp || (vault ? al - bl : 0) || a.key.localeCompare(b.key);
    })
    .slice(0, limit);
  if (!vault && needle && VAULT_TEMPLATE_PREFIX.startsWith(needle)) {
    const entry = vaultPrefixSuggestion(suggestions);
    if (entry) items.unshift(entry);
  }
  return { vault, items };
}
