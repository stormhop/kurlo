import { parseGraphQLPayload, serializeGraphQLPayload } from './graphql';
import { splitUrl, urlWithParams } from './queryParams';
import type { KVRow, SavedRequest } from './types/models';

export type FindOptions = { matchCase: boolean; wholeWord: boolean; regex: boolean };

export type FindField = { id: string; label: string; value: string };

export type FindMatch = {
  key: string;
  requestId: string;
  fieldId: string;
  fieldLabel: string;
  start: number;
  end: number;
  text: string;
  line: number;
  before: string;
  after: string;
};

export type FindResult = { matches: FindMatch[]; total: number; truncated: boolean; error: string };

export const MAX_FIND_MATCHES = 2000;
export const FIND_DEBOUNCE_MS = 200;
const CONTEXT_BEFORE = 24;
const CONTEXT_AFTER = 80;

const ROW_FIELDS = [
  ['params', 'Query'],
  ['pathParams', 'Path variable'],
  ['headers', 'Header'],
  ['formRows', 'Form field'],
  ['grpcMetadata', 'Metadata'],
] as const;

type RowField = typeof ROW_FIELDS[number][0];

const TEXT_FIELDS = [
  ['mcpArguments', 'MCP arguments'],
  ['aiSystem', 'System prompt'],
  ['aiPrompt', 'Prompt'],
  ['preRequestScriptJs', 'Pre-request script'],
  ['testScriptJs', 'Test script'],
  ['preRequestScript', 'Pre-request script (Tengo)'],
  ['testScript', 'Test script (Tengo)'],
  ['requestNotes', 'Docs'],
] as const;

const AUTH_FIELDS = [
  ['basicUser', 'Username'],
  ['apiKeyName', 'API key name'],
  ['oauth2AuthURL', 'Authorization URL'],
  ['oauth2TokenURL', 'Token URL'],
  ['oauth2DeviceAuthURL', 'Device authorization URL'],
  ['oauth2ClientID', 'Client ID'],
  ['oauth2Scope', 'Scope'],
  ['oauth2Audience', 'Audience'],
  ['oauth2Username', 'Username'],
  ['oauth2AssertionAudience', 'Assertion audience'],
  ['awsRegion', 'Region'],
  ['awsService', 'Service'],
  ['oauth1ConsumerKey', 'Consumer key'],
  ['oauth1Realm', 'Realm'],
  ['oauth1Callback', 'Callback URL'],
] as const;

const AUTH_FIELDS_BY_TYPE: Record<string, string[]> = {
  basic: ['basicUser'],
  digest: ['basicUser'],
  apikey: ['apiKeyName'],
  oauth2: ['oauth2AuthURL', 'oauth2TokenURL', 'oauth2DeviceAuthURL', 'oauth2ClientID', 'oauth2Scope', 'oauth2Audience', 'oauth2Username', 'oauth2AssertionAudience'],
  aws: ['awsRegion', 'awsService'],
  oauth1: ['oauth1ConsumerKey', 'oauth1Realm', 'oauth1Callback'],
};

const RAW_BODY_TYPES = new Set(['json', 'text', 'xml', 'html']);

function isGraphQL(req: SavedRequest) {
  return req.requestType === 'graphql' || req.bodyType === 'graphql';
}

function rowLabel(base: string, row: KVRow, index: number) {
  return row.key ? `${base} “${row.key}”` : `${base} ${index + 1}`;
}

export function findFields(req: SavedRequest): FindField[] {
  const fields: FindField[] = [{ id: 'url', label: 'URL', value: splitUrl(req.url ?? '').head }];
  for (const [field, label] of ROW_FIELDS) {
    (req[field] ?? []).forEach((row, index) => {
      if (field !== 'pathParams') fields.push({ id: `${field}.${index}.key`, label: `${rowLabel(label, row, index)} · name`, value: row.key ?? '' });
      if (!row.secret && !row.isFile) fields.push({ id: `${field}.${index}.value`, label: `${rowLabel(label, row, index)} · value`, value: row.value ?? '' });
    });
  }
  if (isGraphQL(req)) {
    const payload = parseGraphQLPayload(req.bodyContent ?? '');
    fields.push({ id: 'graphql.query', label: 'GraphQL query', value: payload.query });
    fields.push({ id: 'graphql.variables', label: 'GraphQL variables', value: payload.variables });
  } else if (RAW_BODY_TYPES.has(req.bodyType)) {
    fields.push({ id: 'bodyContent', label: 'Body', value: req.bodyContent ?? '' });
  }
  for (const [field, label] of TEXT_FIELDS) {
    const value = req[field];
    if (typeof value === 'string') fields.push({ id: field, label, value });
  }
  const authFields = new Set(AUTH_FIELDS_BY_TYPE[req.auth?.type ?? ''] ?? []);
  for (const [field, label] of AUTH_FIELDS) {
    const value = req.auth?.[field];
    if (authFields.has(field) && typeof value === 'string') fields.push({ id: `auth.${field}`, label: `Auth · ${label}`, value });
  }
  return fields.filter(field => field.value !== '');
}

export function setFindField(req: SavedRequest, fieldId: string, value: string): SavedRequest {
  const [head, second, third] = fieldId.split('.');
  if (head === 'url') {
    const { query, hash } = splitUrl(req.url ?? '');
    return { ...req, url: `${value}${query ? `?${query}` : ''}${hash}` };
  }
  if (head === 'bodyContent') return { ...req, bodyContent: value };
  if (head === 'graphql') {
    const payload = parseGraphQLPayload(req.bodyContent ?? '');
    const next = second === 'query' ? { ...payload, query: value } : { ...payload, variables: value };
    return { ...req, bodyContent: serializeGraphQLPayload(next) };
  }
  if (head === 'auth') return { ...req, auth: { ...req.auth, [second]: value } };
  if (ROW_FIELDS.some(([field]) => field === head)) {
    const field = head as RowField;
    const rows = (req[field] ?? []).map((row, index) => index === Number(second) ? { ...row, [third === 'key' ? 'key' : 'value']: value } : row);
    if (field === 'params' && req.requestType !== 'grpc') return { ...req, params: rows, url: urlWithParams(req.url ?? '', rows) };
    return { ...req, [field]: rows };
  }
  if (TEXT_FIELDS.some(([field]) => field === head)) return { ...req, [head]: value };
  return req;
}

function escapeRegExp(source: string) {
  return source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildFindRegExp(query: string, options: FindOptions): RegExp {
  let source = options.regex ? query : escapeRegExp(query);
  if (options.wholeWord) source = `(?<![A-Za-z0-9_])(?:${source})(?![A-Za-z0-9_])`;
  return new RegExp(source, options.matchCase ? 'g' : 'gi');
}

function forEachMatch(value: string, re: RegExp, visit: (match: RegExpExecArray) => boolean | void) {
  re.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(value))) {
    if (match[0] === '') {
      re.lastIndex++;
      continue;
    }
    if (visit(match) === false) return;
  }
}

function lineCounter(value: string) {
  let position = 0;
  let line = 1;
  return (start: number) => {
    for (let index = value.indexOf('\n', position); index >= 0 && index < start; index = value.indexOf('\n', index + 1)) line++;
    position = start;
    return line;
  };
}

function lineContext(value: string, start: number, end: number, line: number) {
  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
  const lineEndIndex = value.indexOf('\n', end);
  const lineEnd = lineEndIndex < 0 ? value.length : lineEndIndex;
  const before = value.slice(Math.max(lineStart, start - CONTEXT_BEFORE), start);
  const after = value.slice(end, Math.min(lineEnd, end + CONTEXT_AFTER));
  return {
    line,
    before: (start - CONTEXT_BEFORE > lineStart ? '…' : '') + before,
    after: after + (end + CONTEXT_AFTER < lineEnd ? '…' : ''),
  };
}

export function findInRequests(requests: SavedRequest[], query: string, options: FindOptions, limit = MAX_FIND_MATCHES): FindResult {
  if (!query) return { matches: [], total: 0, truncated: false, error: '' };
  let re: RegExp;
  try {
    re = buildFindRegExp(query, options);
  } catch (error) {
    return { matches: [], total: 0, truncated: false, error: error instanceof Error ? error.message : String(error) };
  }
  const matches: FindMatch[] = [];
  let total = 0;
  for (const req of requests) {
    for (const field of findFields(req)) {
      const lineAt = lineCounter(field.value);
      forEachMatch(field.value, re, match => {
        total++;
        if (matches.length >= limit) return;
        const start = match.index;
        const end = start + match[0].length;
        matches.push({
          key: `${req.id}:${field.id}:${start}`,
          requestId: req.id,
          fieldId: field.id,
          fieldLabel: field.label,
          start,
          end,
          text: match[0],
          ...lineContext(field.value, start, end, lineAt(start)),
        });
      });
    }
  }
  return { matches, total, truncated: total > matches.length, error: '' };
}

export function expandReplacement(template: string, match: RegExpExecArray): string {
  return template.replace(/\$(\$|&|<([^>]+)>|(\d{1,2}))/g, (whole, token: string, name?: string, digits?: string) => {
    if (token === '$') return '$';
    if (token === '&') return match[0];
    if (name !== undefined) return match.groups?.[name] ?? '';
    const index = Number(digits);
    if (index > 0 && index < match.length) return match[index] ?? '';
    if (digits && digits.length === 2) {
      const single = Number(digits[0]);
      if (single > 0 && single < match.length) return (match[single] ?? '') + digits[1];
    }
    return whole;
  });
}

function replaceInValue(value: string, re: RegExp, replacement: string, options: FindOptions, onlyAt?: number) {
  let out = '';
  let last = 0;
  let count = 0;
  forEachMatch(value, re, match => {
    if (onlyAt !== undefined && match.index !== onlyAt) return match.index < onlyAt;
    out += value.slice(last, match.index) + (options.regex ? expandReplacement(replacement, match) : replacement);
    last = match.index + match[0].length;
    count++;
    return onlyAt === undefined;
  });
  return { value: out + value.slice(last), count };
}

export type ReplaceResult = { requests: SavedRequest[]; replaced: number; error: string };

export function replaceMatches(
  requests: SavedRequest[],
  query: string,
  replacement: string,
  options: FindOptions,
  matches?: FindMatch[],
): ReplaceResult {
  let re: RegExp;
  try {
    re = buildFindRegExp(query, options);
  } catch (error) {
    return { requests: [], replaced: 0, error: error instanceof Error ? error.message : String(error) };
  }
  const wanted = matches ? new Map<string, FindMatch[]>() : null;
  for (const match of matches ?? []) {
    const key = `${match.requestId}\n${match.fieldId}`;
    wanted!.set(key, [...(wanted!.get(key) ?? []), match]);
  }
  const changed: SavedRequest[] = [];
  let replaced = 0;
  for (const original of requests) {
    let req = original;
    for (const field of findFields(original)) {
      const picked = wanted?.get(`${original.id}\n${field.id}`);
      if (wanted && !picked) continue;
      let value = field.value;
      let count = 0;
      if (picked) {
        for (const match of [...picked].sort((a, b) => b.start - a.start)) {
          if (value.slice(match.start, match.end) !== match.text) continue;
          const result = replaceInValue(value, re, replacement, options, match.start);
          value = result.value;
          count += result.count;
        }
      } else {
        const result = replaceInValue(value, re, replacement, options);
        value = result.value;
        count = result.count;
      }
      if (count && value !== field.value) {
        req = setFindField(req, field.id, value);
        replaced += count;
      }
    }
    if (req !== original) changed.push(req);
  }
  return { requests: changed, replaced, error: '' };
}
