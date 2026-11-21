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
