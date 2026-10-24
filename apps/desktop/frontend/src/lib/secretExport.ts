import type { KVRow, SavedRequest } from './types/models';

const TEMPLATE_VALUE_RE = /^\s*(?:(?:Bearer|Basic|Token|JWT|ApiKey|API-Key|Digest)\s+)?\{\{[^{}]+\}\}\s*$/i;
const SENSITIVE_KEY_RE = /(^|[-_\s.])(authorization|cookie|set-cookie|password|passwd|pwd|secret|token|access[-_\s]?token|refresh[-_\s]?token|api[-_\s]?key|apikey|client[-_\s]?secret|private[-_\s]?key|session|jwt)([-_\s.]|$)/i;

export function isTemplateExportValue(value: string) {
  return TEMPLATE_VALUE_RE.test(value.trim());
}

export function isSensitiveExportKey(key: string) {
  const normalized = key.trim().replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  return SENSITIVE_KEY_RE.test(normalized);
}

export function safeExportValue(key: string, value: string, includeSecrets = false, explicitSecret = false) {
  if (includeSecrets || !value) return value;
  if ((explicitSecret || isSensitiveExportKey(key)) && !isTemplateExportValue(value)) return '';
  return value;
}

export function safeExportRow(row: KVRow, includeSecrets = false): KVRow {
  return {
    ...row,
    value: safeExportValue(row.key, row.value, includeSecrets, row.secret === true),
  };
}

export function sanitizeExportExample(value: unknown, includeSecrets = false, keyHint = ''): unknown {
  if (includeSecrets) return value;
  if (typeof value === 'string') return safeExportValue(keyHint, value, false);
  if (Array.isArray(value)) return value.map(item => sanitizeExportExample(item, false, keyHint));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) out[key] = sanitizeExportExample(child, false, key);
    return out;
  }
  return value;
}

function hasRawSecret(key: string, value: string, explicitSecret = false) {
  return Boolean(value && !isTemplateExportValue(value) && (explicitSecret || isSensitiveExportKey(key)));
}

function bodyHasRawSecret(source: string) {
  if (!source.trim()) return false;
  try {
    return exampleHasRawSecret(JSON.parse(source));
  } catch {
    return false;
  }
}

function urlHasRawSecret(source: string) {
  if (!source.trim()) return false;
  try {
    const parsed = new URL(source);
    for (const [key, value] of parsed.searchParams.entries()) {
      if (hasRawSecret(key, value)) return true;
    }
    return false;
  } catch {
    const query = source.split('?')[1]?.split('#')[0] ?? '';
    if (!query) return false;
    for (const part of query.split('&')) {
      const [rawKey, rawValue = ''] = part.split('=');
      const key = safeDecodeQueryPart(rawKey);
      const value = safeDecodeQueryPart(rawValue);
      if (hasRawSecret(key, value)) return true;
    }
    return false;
  }
}

function safeDecodeQueryPart(value: string) {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

function safeDecodeUrlPart(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function urlUserInfoBounds(value: string) {
  const schemeIndex = value.indexOf('://');
  const authorityStart = schemeIndex >= 0 ? schemeIndex + 3 : value.startsWith('//') ? 2 : -1;
  if (authorityStart < 0) return null;
  const authorityEndCandidates = ['/', '?', '#']
    .map(char => value.indexOf(char, authorityStart))
    .filter(index => index >= 0);
  const authorityEnd = authorityEndCandidates.length ? Math.min(...authorityEndCandidates) : value.length;
  const authority = value.slice(authorityStart, authorityEnd);
  const atIndex = authority.lastIndexOf('@');
  if (atIndex < 0) return null;
  return {
    start: authorityStart,
    end: authorityStart + atIndex + 1,
    userInfo: authority.slice(0, atIndex),
  };
}

function urlUserInfoIsTemplate(userInfo: string) {
  return userInfo.split(':').every(part => part && isTemplateExportValue(safeDecodeUrlPart(part)));
}

function urlHasRawUserInfo(value: string) {
  const bounds = urlUserInfoBounds(value);
  return Boolean(bounds?.userInfo && !urlUserInfoIsTemplate(bounds.userInfo));
}

function safeExportUrlUserInfo(value: string) {
  const bounds = urlUserInfoBounds(value);
  if (!bounds?.userInfo || urlUserInfoIsTemplate(bounds.userInfo)) return value;
  return `${value.slice(0, bounds.start)}${value.slice(bounds.end)}`;
}

export function safeExportUrl(value: string, includeSecrets = false) {
  if (includeSecrets || !value.trim()) return value;
  const safeUserInfoUrl = safeExportUrlUserInfo(value);
  const hashIndex = safeUserInfoUrl.indexOf('#');
  const beforeHash = hashIndex >= 0 ? safeUserInfoUrl.slice(0, hashIndex) : safeUserInfoUrl;
  const hash = hashIndex >= 0 ? safeUserInfoUrl.slice(hashIndex) : '';
  const queryIndex = beforeHash.indexOf('?');
  if (queryIndex < 0) return safeUserInfoUrl;
  const base = beforeHash.slice(0, queryIndex);
  const query = beforeHash.slice(queryIndex + 1);
  if (!query) return safeUserInfoUrl;
  const safeQuery = query.split('&').map(part => {
    if (!part) return part;
    const equalsIndex = part.indexOf('=');
    const rawKey = equalsIndex >= 0 ? part.slice(0, equalsIndex) : part;
    const rawValue = equalsIndex >= 0 ? part.slice(equalsIndex + 1) : '';
    const key = safeDecodeQueryPart(rawKey);
    const decodedValue = safeDecodeQueryPart(rawValue);
    const safeValue = safeExportValue(key, decodedValue, false);
    if (safeValue === decodedValue) return part;
    return `${rawKey}${equalsIndex >= 0 ? '=' : ''}${encodeURIComponent(safeValue)}`;
  }).join('&');
  return `${base}?${safeQuery}${hash}`;
}

function exampleHasRawSecret(value: unknown, keyHint = ''): boolean {
  if (typeof value === 'string') return hasRawSecret(keyHint, value);
  if (Array.isArray(value)) return value.some(item => exampleHasRawSecret(item, keyHint));
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([key, child]) => exampleHasRawSecret(child, key));
  }
  return false;
}

function requestHasExportSecrets(req: SavedRequest) {
  const auth = req.auth;
  const authHasSecrets =
    hasRawSecret('token', auth.bearerToken)
    || hasRawSecret('password', auth.basicPass)
    || hasRawSecret('apiKey', auth.apiKeyValue)
    || hasRawSecret('accessToken', auth.oauth2Token)
    || hasRawSecret('refreshToken', auth.oauth2RefreshToken ?? '')
    || hasRawSecret('accessToken', auth.bearerToken)
    || hasRawSecret('clientSecret', auth.oauth2Secret)
    || hasRawSecret('awsSecretKey', auth.awsSecretKey)
    || hasRawSecret('consumerSecret', auth.oauth1ConsumerSecret ?? '')
    || hasRawSecret('token', auth.oauth1Token ?? '')
    || hasRawSecret('tokenSecret', auth.oauth1TokenSecret ?? '')
    || hasRawSecret('privateKey', auth.oauth1PrivateKey ?? '');
  return authHasSecrets
    || req.params.some(row => hasRawSecret(row.key, row.value, row.secret))
    || req.headers.some(row => hasRawSecret(row.key, row.value, row.secret))
    || req.formRows.some(row => hasRawSecret(row.key, row.value, row.secret))
    || urlHasRawUserInfo(req.url)
    || urlHasRawSecret(req.url)
    || bodyHasRawSecret(req.bodyContent);
}

export function requestsHaveExportSecrets(requests: SavedRequest[]) {
  return requests.some(requestHasExportSecrets);
}
