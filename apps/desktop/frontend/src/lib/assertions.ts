import type { RequestType } from './types/models';

export type AssertionOperator =
  | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'notIn'
  | 'contains' | 'notContains' | 'matches' | 'exists' | 'notExists' | 'type' | 'length';

export type AssertionRow = { id: number; enabled: boolean; target: string; operator: AssertionOperator; value: string };

export type AssertionOperatorOption = { value: AssertionOperator; label: string; needsValue: boolean; placeholder: string };

export const ASSERTION_OPERATORS: AssertionOperatorOption[] = [
  { value: 'eq', label: 'equals', needsValue: true, placeholder: '200' },
  { value: 'neq', label: 'does not equal', needsValue: true, placeholder: '500' },
  { value: 'gt', label: 'is greater than', needsValue: true, placeholder: '0' },
  { value: 'gte', label: 'is at least', needsValue: true, placeholder: '1' },
  { value: 'lt', label: 'is less than', needsValue: true, placeholder: '500' },
  { value: 'lte', label: 'is at most', needsValue: true, placeholder: '1000' },
  { value: 'in', label: 'is one of', needsValue: true, placeholder: '200, 201, 204' },
  { value: 'notIn', label: 'is not one of', needsValue: true, placeholder: '500, 502' },
  { value: 'contains', label: 'contains', needsValue: true, placeholder: 'text or item' },
  { value: 'notContains', label: 'does not contain', needsValue: true, placeholder: 'text or item' },
  { value: 'matches', label: 'matches regex', needsValue: true, placeholder: '^[a-f0-9-]{36}$' },
  { value: 'exists', label: 'exists', needsValue: false, placeholder: '' },
  { value: 'notExists', label: 'does not exist', needsValue: false, placeholder: '' },
  { value: 'type', label: 'is of type', needsValue: true, placeholder: 'string, number, boolean, object, array or null' },
  { value: 'length', label: 'has length', needsValue: true, placeholder: '10' },
];

const OPERATORS = new Map(ASSERTION_OPERATORS.map(option => [option.value, option]));

export const ASSERTION_TARGET_SUGGESTIONS = ['status', 'responseTime', 'size', 'header.Content-Type', 'body', 'body.'];

export const MAX_ASSERTIONS = 200;

export function requestTypeSupportsAssertions(type: RequestType | string | undefined) {
  return !type || type === 'http' || type === 'graphql';
}

export function assertionOperatorOption(operator: string): AssertionOperatorOption | undefined {
  return OPERATORS.get(operator as AssertionOperator);
}

export function assertionNeedsValue(operator: string) {
  return assertionOperatorOption(operator)?.needsValue ?? true;
}

let nextAssertionId = 1;

export function newAssertionRow(partial: Partial<Omit<AssertionRow, 'id'>> = {}): AssertionRow {
  return { id: nextAssertionId++, enabled: true, target: '', operator: 'eq', value: '', ...partial };
}

export function normalizeAssertions(raw: unknown): AssertionRow[] {
  if (!Array.isArray(raw)) return [];
  const rows: AssertionRow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const target = typeof record.target === 'string' ? record.target : '';
    const operator = typeof record.operator === 'string' && OPERATORS.has(record.operator as AssertionOperator) ? record.operator as AssertionOperator : 'eq';
    const value = typeof record.value === 'string' ? record.value : typeof record.value === 'number' || typeof record.value === 'boolean' ? String(record.value) : '';
    rows.push(newAssertionRow({ enabled: record.enabled !== false, target, operator, value }));
  }
  return rows;
}

export function assertionsForStore(rows: AssertionRow[] | undefined): AssertionRow[] {
  return (rows ?? []).filter(row => row.target.trim()).map(row => ({ ...row, value: assertionNeedsValue(row.operator) ? row.value : '' }));
}

export function assertionsWithoutUiIds(rows: AssertionRow[] | undefined) {
  return assertionsForStore(rows).map(({ id, ...row }) => row);
}

export function assertionsForSend(rows: AssertionRow[] | undefined, resolve: (value: string) => string) {
  return assertionsForStore(rows).filter(row => row.enabled).map(row => ({
    enabled: true,
    target: resolve(row.target.trim()),
    operator: row.operator,
    value: resolve(row.value),
  }));
}

export function assertionLabel(row: Pick<AssertionRow, 'target' | 'operator' | 'value'>) {
  const option = assertionOperatorOption(row.operator);
  const label = option?.label ?? row.operator;
  return option && !option.needsValue ? `${row.target.trim()} ${label}` : `${row.target.trim()} ${label} ${row.value.trim()}`;
}

function jsString(value: string) {
  return JSON.stringify(value);
}

function postmanSubject(target: string): string | null {
  const trimmed = target.trim();
  const lower = trimmed.toLowerCase();
  if (lower === 'status') return 'pm.response.code';
  if (lower === 'responsetime') return 'pm.response.responseTime';
  if (lower === 'size') return 'pm.response.size().body';
  if (lower.startsWith('header.') || lower.startsWith('headers.')) return `pm.response.headers.get(${jsString(trimmed.slice(trimmed.indexOf('.') + 1))})`;
  if (lower === 'body' || trimmed === '$') return 'pm.response.json()';
  const path = lower.startsWith('body.') || lower.startsWith('body[') ? trimmed.slice(4) : trimmed.startsWith('$.') || trimmed.startsWith('$[') ? trimmed.slice(1) : null;
  if (path === null) return null;
  const accessors = jsPathAccessors(path);
  return accessors === null ? null : `pm.response.json()${accessors}`;
}

function jsPathAccessors(path: string): string | null {
  let out = '';
  for (let i = 0; i < path.length;) {
    if (path[i] === '.') {
      let end = i + 1;
      while (end < path.length && path[end] !== '.' && path[end] !== '[') end++;
      if (end === i + 1) return null;
      out += `[${jsString(path.slice(i + 1, end))}]`;
      i = end;
    } else if (path[i] === '[') {
      const end = path.indexOf(']', i);
      if (end < 0) return null;
      const inner = path.slice(i + 1, end).trim();
      const quoted = inner.length >= 2 && (inner[0] === '"' || inner[0] === "'") && inner.at(-1) === inner[0];
      if (quoted) out += `[${jsString(inner.slice(1, -1))}]`;
      else if (/^-?\d+$/.test(inner)) out += Number(inner) < 0 ? `.at(${inner})` : `[${inner}]`;
      else return null;
      i = end + 1;
    } else {
      return null;
    }
  }
  return out;
}

function postmanLiteral(value: string) {
  const trimmed = value.trim();
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    return jsString(trimmed);
  }
}

function postmanList(value: string) {
  const trimmed = value.trim();
  try {
    if (Array.isArray(JSON.parse(trimmed))) return trimmed;
  } catch {}
  return `[${trimmed.split(',').map(part => part.trim()).filter(Boolean).map(postmanLiteral).join(', ')}]`;
}

function postmanCheck(row: AssertionRow): string | null {
  const subject = postmanSubject(row.target);
  if (!subject) return null;
  const value = row.value;
  const isHeader = /^headers?\./i.test(row.target.trim());
  const literal = (text: string) => isHeader ? jsString(text.trim()) : postmanLiteral(text);
  switch (row.operator) {
    case 'eq': return `pm.expect(${subject}).to.eql(${literal(value)});`;
    case 'neq': return `pm.expect(${subject}).to.not.eql(${literal(value)});`;
    case 'gt': return `pm.expect(Number(${subject})).to.be.above(${Number(value.trim())});`;
    case 'gte': return `pm.expect(Number(${subject})).to.be.at.least(${Number(value.trim())});`;
    case 'lt': return `pm.expect(Number(${subject})).to.be.below(${Number(value.trim())});`;
    case 'lte': return `pm.expect(Number(${subject})).to.be.at.most(${Number(value.trim())});`;
    case 'in': return `pm.expect(${postmanList(value)}).to.deep.include(${subject});`;
    case 'notIn': return `pm.expect(${postmanList(value)}).to.not.deep.include(${subject});`;
    case 'contains': return `pm.expect(${subject}).to.include(${postmanLiteral(value)});`;
    case 'notContains': return `pm.expect(${subject}).to.not.include(${postmanLiteral(value)});`;
    case 'matches': return `pm.expect(String(${subject})).to.match(new RegExp(${jsString(value.trim())}));`;
    case 'exists': return `pm.expect(${subject}).to.not.be.undefined;`;
    case 'notExists': return `pm.expect(${subject}).to.be.undefined;`;
    case 'type': {
      const type = value.trim().toLowerCase();
      if (type === 'null') return `pm.expect(${subject}).to.be.null;`;
      return `pm.expect(${subject}).to.be.a(${jsString(type)});`;
    }
    case 'length': return `pm.expect(${subject}).to.have.lengthOf(${Number(value.trim())});`;
  }
  return null;
}

export function assertionsToPostmanScript(rows: AssertionRow[] | undefined): string {
  const lines: string[] = [];
  for (const row of assertionsForStore(rows)) {
    if (!row.enabled) continue;
    const check = postmanCheck(row);
    if (!check) continue;
    lines.push(`pm.test(${jsString(assertionLabel(row))}, function () {`, `  ${check}`, '});');
  }
  return lines.join('\n');
}
