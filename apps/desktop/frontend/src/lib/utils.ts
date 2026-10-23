import type { KVRow, BodyType, AuthType, RawBodyType, RequestType, SavedRequest } from './types/models';
import { mkRow } from './constants';
import { clipboardSet } from './backend';

export function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}

export function finiteNumber(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value == null) return '';
  try { return JSON.stringify(value); } catch { return String(value); }
}

export function newRequestId() {
  return crypto.randomUUID?.() ?? `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function newEntityId(prefix: string) {
  return `${prefix}-${newRequestId()}`;
}

export function activeCount(rows: KVRow[]) {
  return rows.filter(r => r.enabled && r.key).length;
}

export function rowHasContent(row: KVRow) {
  return Boolean(row.key || row.value || row.description || row.isFile);
}

function valueKind(value: unknown): string {
  return Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
}

export function sanitizeLike<T extends object>(value: unknown, template: T): Partial<T> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const clean: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const [key, expected] of Object.entries(template)) {
    if (!(key in clean) || expected === undefined || expected === null) continue;
    const actual = clean[key];
    if (valueKind(actual) === valueKind(expected)) continue;
    if (typeof expected === 'string' && (typeof actual === 'number' || typeof actual === 'boolean')) clean[key] = String(actual);
    else if (typeof expected === 'number' && typeof actual === 'string' && actual.trim() !== '' && Number.isFinite(Number(actual))) clean[key] = Number(actual);
    else delete clean[key];
  }
  return clean as Partial<T>;
}

function rowText(value: unknown): string {
  if (typeof value === 'string') return value;
  return typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
}

export function sanitizeRows(rows: unknown): KVRow[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object' && !Array.isArray(row))
    .map(row => {
      const clean: Record<string, unknown> = {
        ...row,
        enabled: typeof row.enabled === 'boolean' ? row.enabled : true,
        key: rowText(row.key),
        value: rowText(row.value),
        description: rowText(row.description),
        fileName: rowText(row.fileName),
        contentType: rowText(row.contentType),
        isFile: row.isFile === true,
        secret: row.secret === true,
      };
      if (typeof row.id !== 'number' || !Number.isFinite(row.id)) delete clean.id;
      return clean as unknown as KVRow;
    });
}

export function cloneRowsForStore(rows: KVRow[]) {
  return sanitizeRows(rows)
    .filter(rowHasContent)
    .map(row => ({
      id: row.id,
      enabled: row.enabled,
      key: row.key,
      value: row.value,
      description: row.description,
      ...(row.isFile ? { isFile: true } : {}),
      ...(row.isFile && row.fileName ? { fileName: row.fileName } : {}),
      ...(row.contentType ? { contentType: row.contentType } : {}),
      ...(row.secret ? { secret: true } : {}),
    }));
}

export function restoreRows(rows: KVRow[] | undefined): KVRow[] {
  const restored = sanitizeRows(rows)
    .filter(rowHasContent)
    .map(row => ({
      ...mkRow(),
      enabled: row.enabled ?? true,
      key: row.key ?? '',
      value: row.value ?? '',
      description: row.description ?? '',
      isFile: row.isFile ?? false,
      fileName: row.fileName ?? '',
      contentType: row.contentType ?? '',
      secret: row.secret ?? false,
    }));
  return [...restored, mkRow()];
}

export function guardTrailing(rows: KVRow[], idx: number) {
  if (idx === rows.length - 1 && (rows[idx].key || rows[idx].value)) rows.push(mkRow());
}

export function removeRow(rows: KVRow[], idx: number) {
  if (rows.length === 1) rows[0] = mkRow();
  else rows.splice(idx, 1);
}

export function scriptLineCount(src: string) {
  return src.trim() ? src.trim().split('\n').length : 0;
}

export function byteLength(text: string) {
  return new TextEncoder().encode(text).length;
}

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function prettyJson(raw: string) {
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
}

const MARKUP_VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

export function prettyMarkup(raw: string) {
  const source = raw.trim();
  if (!source) return raw;

  const tokens = source
    .replace(/>\s+</g, '><')
    .replace(/(<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>)/g, '\n$1\n')
    .replace(/(>)(<)(\/?)/g, '$1\n$2$3')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  let depth = 0;
  const formatted = tokens.map(line => {
    const lower = line.toLowerCase();
    const closingTag = /^<\//.test(line);
    const specialTag = /^<(!|\?)/.test(line);
    const tagName = line.match(/^<\/?\s*([a-zA-Z0-9:-]+)/)?.[1]?.toLowerCase() ?? '';
    const selfClosing = /\/>$/.test(line) || MARKUP_VOID_TAGS.has(tagName);
    const inlineClose = /^<([a-zA-Z0-9:-]+)(?:\s[^>]*)?>[\s\S]*<\/\1>$/.test(line);
    const preserveLine = lower.startsWith('<script') || lower.startsWith('<style') || line.startsWith('<!--') || line.startsWith('<![CDATA[');

    if (closingTag) depth = Math.max(depth - 1, 0);
    const out = `${'  '.repeat(depth)}${line}`;
    if (!closingTag && !specialTag && !selfClosing && !inlineClose && !preserveLine) depth += 1;
    return out;
  }).join('\n');

  return formatted || raw;
}

export function escapeHtml(raw: string) {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function methodColor(m: string) {
  const map: Record<string, string> = {
    GET: 'method-get', POST: 'method-post', PUT: 'method-put',
    PATCH: 'method-patch', DELETE: 'method-delete',
    HEAD: 'method-head', OPTIONS: 'method-options',
    SSE: 'method-sse', GRAPHQL: 'method-graphql', GQL: 'method-graphql',
    WS: 'method-ws', WEBSOCKET: 'method-ws', SIO: 'method-sio', 'SOCKET.IO': 'method-sio', GRPC: 'method-grpc', MCP: 'method-mcp', AI: 'method-ai',
  };
  return map[m.toUpperCase()] ?? '';
}

type RequestKind = 'http' | 'graphql' | 'sse' | 'ws' | 'socketio' | 'grpc' | 'mcp' | 'ai';
export type RequestKindInput = {
  requestType?: RequestType;
  method?: string;
  url?: string;
};

export function requestKindFor(input: RequestKindInput): RequestKind {
  if (input.requestType === 'socketio') return 'socketio';
  if (input.requestType === 'mcp') return 'mcp';
  if (input.requestType === 'ai') return 'ai';
  if (input.requestType === 'grpc') return 'grpc';
  if (input.requestType === 'graphql') return 'graphql';
  if (input.requestType === 'ws' || /^wss?:\/\//i.test(input.url ?? '')) return 'ws';
  if ((input.method ?? '').toUpperCase() === 'SSE') return 'sse';
  return 'http';
}

export function requestBadgeLabel(input: RequestKindInput): string {
  const kind = requestKindFor(input);
  if (kind === 'socketio') return 'Socket.IO';
  if (kind === 'mcp') return 'MCP';
  if (kind === 'ai') return 'AI';
  if (kind === 'grpc') return 'gRPC';
  if (kind === 'ws') return 'WebSocket';
  if (kind === 'graphql') return 'GraphQL';
  if (kind === 'sse') return 'SSE';
  return (input.method ?? '').toUpperCase();
}

export function requestSupportsCurl(input: RequestKindInput): boolean {
  const kind = requestKindFor(input);
  return kind !== 'ws' && kind !== 'socketio' && kind !== 'graphql' && kind !== 'grpc' && kind !== 'mcp' && kind !== 'ai';
}

export function statusClass(code: number) {
  if (code >= 500) return 'status-5xx';
  if (code >= 400) return 'status-4xx';
  if (code >= 300) return 'status-3xx';
  return 'status-2xx';
}

export function normalizeColor(input: unknown, fallback: string) {
  const value = typeof input === 'string' ? input.trim() : '';
  const hex = value.match(/^#?([0-9a-f]{6})$/i);
  if (hex) return `#${hex[1].toLowerCase()}`;
  const rgb = value.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i);
  if (rgb) {
    const parts = rgb.slice(1, 4).map(part => clamp(Number(part), 0, 255).toString(16).padStart(2, '0'));
    return `#${parts.join('')}`;
  }
  return fallback;
}

export function hexRgb(hex: string, fallback: string) {
  const normalized = normalizeColor(hex, fallback).slice(1);
  return {
    r: parseInt(normalized.slice(0, 2), 16),
    g: parseInt(normalized.slice(2, 4), 16),
    b: parseInt(normalized.slice(4, 6), 16),
  };
}

export function normalizeBodyTypeForUi(value: unknown): BodyType {
  const normalized = typeof value === 'string' ? value : 'none';
  if (normalized === 'javascript') return 'text';
  if (['none', 'json', 'text', 'xml', 'html', 'form', 'urlencoded', 'binary', 'graphql'].includes(normalized)) {
    return normalized as BodyType;
  }
  return 'none';
}

export function normalizeRawBodyTypeForUi(value: unknown): RawBodyType {
  const normalized = typeof value === 'string' ? value : 'json';
  if (normalized === 'javascript') return 'text';
  if (['text', 'json', 'html', 'xml'].includes(normalized)) return normalized as RawBodyType;
  return 'json';
}

export function requestTitleFrom(methodValue: string, urlValue: string) {
  const cleanUrl = urlValue.trim();
  if (!cleanUrl) return 'New Request';
  if (methodValue.toLowerCase() === 'grpc' && !/^[a-z][a-z0-9+.-]*:\/\//i.test(cleanUrl)) {
    return `${methodValue} ${cleanUrl.split('/')[0].slice(0, 42)}`;
  }
  try {
    const parsed = new URL(cleanUrl);
    const pathName = parsed.pathname.split('/').filter(Boolean).pop();
    return pathName ? `${methodValue} ${pathName}` : `${methodValue} ${parsed.host}`;
  } catch {
    return `${methodValue} ${cleanUrl.replace(/^(https?|wss?):\/\//, '').slice(0, 42)}`;
  }
}

export function requestTransportLabel(req: { requestType?: string; method: string; url?: string }) {
  if (req.requestType === 'socketio') return 'Socket.IO';
  if (req.requestType === 'mcp') return 'MCP';
  if (req.requestType === 'ai') return 'AI';
  if (req.requestType === 'grpc') return 'gRPC';
  if (req.requestType === 'graphql') return 'GraphQL';
  return req.requestType === 'ws' || /^wss?:\/\//i.test(req.url ?? '') ? 'WS' : req.method;
}

export function requestKindShortLabel(label: string) {
  const short: Record<string, string> = { GraphQL: 'GQL', WebSocket: 'WS', 'Socket.IO': 'SIO' };
  return short[label] ?? label;
}

export function requestTabLabel(req: { name: string; method: string; url: string; requestType?: string }) {
  return req.name || requestTitleFrom(requestTransportLabel(req), req.url);
}

export function emptyAuthState() {
  return {
    type: 'none' as AuthType,
    bearerToken: '', basicUser: '', basicPass: '',
    apiKeyName: 'X-API-Key', apiKeyValue: '', apiKeyIn: 'header' as 'header' | 'query',
    oauth2TokenURL: '', oauth2ClientID: '', oauth2Secret: '', oauth2Scope: '', oauth2Token: '',
    oauth2GrantType: 'client_credentials' as const, oauth2AuthURL: '', oauth2DeviceAuthURL: '',
    oauth2RefreshToken: '', oauth2TokenExpiry: 0, oauth2UsePKCE: true, oauth2Audience: '',
    oauth2Username: '', oauth2Password: '', oauth2ClientAuth: 'basic' as const,
    oauth2AssertionAlgorithm: '', oauth2AssertionPrivateKey: '', oauth2AssertionKeyID: '', oauth2AssertionAudience: '',
    awsAccessKey: '', awsSecretKey: '', awsSessionToken: '', awsRegion: 'us-east-1', awsService: 'execute-api',
  };
}

export function inheritAuthState() {
  return { ...emptyAuthState(), type: 'inherit' as AuthType };
}

export function authStateHasData(auth: SavedRequest['auth'], type: AuthType = auth.type) {
  const has = (...values: string[]) => values.some(value => Boolean(value.trim()));
  if (type === 'bearer') return has(auth.bearerToken);
  if (type === 'basic' || type === 'digest') return has(auth.basicUser, auth.basicPass);
  if (type === 'apikey') return has(auth.apiKeyValue) || auth.apiKeyName.trim() !== 'X-API-Key' || auth.apiKeyIn !== 'header';
  if (type === 'oauth2') {
    return has(
      auth.oauth2TokenURL, auth.oauth2AuthURL ?? '', auth.oauth2DeviceAuthURL ?? '',
      auth.oauth2ClientID, auth.oauth2Secret, auth.oauth2Scope, auth.oauth2Token,
      auth.oauth2RefreshToken ?? '', auth.oauth2Audience ?? '',
      auth.oauth2Username ?? '', auth.oauth2Password ?? '', auth.oauth2AssertionPrivateKey ?? '',
    );
  }
  if (type === 'aws') {
    return has(auth.awsAccessKey, auth.awsSecretKey, auth.awsSessionToken ?? '') || auth.awsRegion.trim() !== 'us-east-1' || auth.awsService.trim() !== 'execute-api';
  }
  return false;
}

export function authForPersistence(auth: SavedRequest['auth'], stored?: SavedRequest['auth']) {
  if (auth.type === 'inherit' || auth.type === 'none') return { ...auth };
  if (auth.type === stored?.type || authStateHasData(auth, auth.type)) return { ...auth };
  return stored ? { ...stored } : { ...emptyAuthState() };
}

export function localDateKey(timestamp: number) {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function historyDayLabel(key: string) {
  const today = localDateKey(Date.now());
  const yesterday = localDateKey(Date.now() - 24 * 60 * 60 * 1000);
  if (key === today) return 'Today';
  if (key === yesterday) return 'Yesterday';
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, (month || 1) - 1, day || 1).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
}

export function safeFileName(name: string) {
  return name.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ') || 'collection';
}

export function downloadTextFile(name: string, content: string) {
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
}

export async function clipboardCopy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    await clipboardSet(text);
  }
}

const ENV_FILE_ESCAPES: Record<string, string> = { n: '\n', t: '\t', '"': '"', '\\': '\\' };

export function parseEnvFile(text: string): Array<{ key: string; value: string }> {
  const result: Array<{ key: string; value: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(key)) continue;
    let value = trimmed.slice(eqIdx + 1);
    const dq = value.startsWith('"') && value.endsWith('"');
    const sq = value.startsWith("'") && value.endsWith("'");
    if (dq || sq) {
      value = value.slice(1, -1);
      if (dq) value = value.replace(/\\([nt"\\])/g, (_, ch: string) => ENV_FILE_ESCAPES[ch]);
    }
    result.push({ key, value });
  }
  return result;
}
