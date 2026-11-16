export type VariableSuggestion = {
  key: string;
  value: string;
  description?: string;
  secret?: boolean;
};

const SECRET_MASK = '••••••';

export function variableDisplayValue(variable: VariableSuggestion) {
  return variable.secret ? SECRET_MASK : variable.value;
}

export function variableTemplate(key: string) {
  return `{{${key}}}`;
}

export function isVariableReferenceOnly(value: string | undefined) {
  return !!value && /^(\s*\{\{[^{}]+}}\s*)+$/.test(value);
}
