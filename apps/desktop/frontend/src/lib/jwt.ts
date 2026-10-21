export type JwtObject = Record<string, unknown>;

export type JwtDecodeResult =
  | { ok: true; header: JwtObject; payload: JwtObject; signature: string; token: string }
  | { ok: false; error: string };

export type JwtTokenState = {
  state: 'valid' | 'expired' | 'not-yet-valid';
  label: string;
};

const NUMERIC_DATE_CLAIMS = new Set(['exp', 'iat', 'nbf']);
const REGISTERED_CLAIM_ORDER = ['iss', 'sub', 'aud', 'exp', 'nbf', 'iat', 'jti'];
const HEADER_ORDER = ['alg', 'typ', 'cty', 'kid', 'x5t'];

export function extractJwtToken(input: string) {
  return input.trim().replace(/^Bearer\s+/i, '');
}

function decodeBase64Url(value: string) {
  if (!value) throw new Error('JWT part is empty');
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  if (normalized.length % 4 === 1) throw new Error('Invalid base64url length');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  const binary = globalThis.atob(padded);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function decodeJsonObject(value: string, label: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeBase64Url(value));
  } catch (error) {
    throw new Error(`Invalid ${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid ${label}: expected a JSON object`);
  }
  return parsed as JwtObject;
}

export function decodeJwt(input: string): JwtDecodeResult {
  const token = extractJwtToken(input);
  if (!token) return { ok: false, error: 'Token is empty' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, error: 'JWT must contain header, payload, and signature' };
  try {
    return {
      ok: true,
      header: decodeJsonObject(parts[0], 'header'),
      payload: decodeJsonObject(parts[1], 'payload'),
      signature: parts[2],
      token,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function orderedEntries(obj: JwtObject, preferredOrder: string[]) {
  const entries = Object.entries(obj);
  const rank = new Map(preferredOrder.map((key, index) => [key, index]));
  return entries.sort(([a], [b]) => {
    const aRank = rank.get(a);
    const bRank = rank.get(b);
    if (aRank !== undefined || bRank !== undefined) return (aRank ?? 1000) - (bRank ?? 1000);
    return a.localeCompare(b);
  });
}

export function jwtHeaderRows(header: JwtObject) {
  return orderedEntries(header, HEADER_ORDER);
}

export function jwtClaimRows(payload: JwtObject) {
  return orderedEntries(payload, REGISTERED_CLAIM_ORDER);
}

export function formatJwtClaimValue(value: unknown) {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value, null, 2);
}

export function formatJwtNumericDate(key: string, value: unknown) {
  if (!NUMERIC_DATE_CLAIMS.has(key) || typeof value !== 'number' || !Number.isFinite(value)) return '';
  return new Date(value * 1000).toLocaleString();
}

export function jwtTokenState(payload: JwtObject, nowSeconds = Math.floor(Date.now() / 1000)): JwtTokenState {
  const exp = payload.exp;
  if (typeof exp === 'number' && Number.isFinite(exp) && exp <= nowSeconds) {
    return { state: 'expired', label: 'Expired' };
  }
  const nbf = payload.nbf;
  if (typeof nbf === 'number' && Number.isFinite(nbf) && nbf > nowSeconds) {
    return { state: 'not-yet-valid', label: 'Not yet valid' };
  }
  return { state: 'valid', label: 'Valid time window' };
}
