import type { KVRow, SecretRef, SecretSource } from './types/models';
import type { InheritedRow } from './environmentInheritance';

const MARKER_PREFIX = '{{kurloRef:';
const MARKER_SUFFIX = '}}';

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeSecretRef(raw: unknown): SecretRef | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const input = raw as Record<string, unknown>;
  const provider = text(input.provider);
  const path = text(input.path);
  if (!provider || !path) return undefined;
  const field = text(input.field);
  const version = text(input.version);
  return { provider, path, ...(field ? { field } : {}), ...(version ? { version } : {}) };
}

function base64Url(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function linkedSecretMarker(ref: SecretRef) {
  const payload: Record<string, string> = { p: ref.provider, path: ref.path };
  if (ref.field) payload.f = ref.field;
  if (ref.version) payload.v = ref.version;
  return MARKER_PREFIX + base64Url(JSON.stringify(payload)) + MARKER_SUFFIX;
}

export function isLinkedSecretMarker(value: string | undefined) {
  return Boolean(value && value.startsWith(MARKER_PREFIX) && value.endsWith(MARKER_SUFFIX));
}

export function linkedSecretRef(row: Pick<KVRow, 'secretRef'>) {
  return normalizeSecretRef(row.secretRef);
}

export function environmentRowValue(row: Pick<KVRow, 'value' | 'secretRef'>) {
  const ref = linkedSecretRef(row);
  return ref ? linkedSecretMarker(ref) : row.value;
}

export function normalizeSecretSource(raw: unknown): SecretSource | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const input = raw as Record<string, unknown>;
  const provider = text(input.provider);
  const path = text(input.path);
  if (!provider || !path) return undefined;
  const version = text(input.version);
  const prefix = text(input.prefix);
  const keys = Array.isArray(input.keys)
    ? [...new Set(input.keys.map(text).filter(Boolean))]
    : undefined;
  return { provider, path, ...(version ? { version } : {}), ...(prefix ? { prefix } : {}), ...(keys ? { keys } : {}) };
}

export function normalizeSecretSources(raw: unknown): SecretSource[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeSecretSource).filter((source): source is SecretSource => Boolean(source));
}

export function secretSourceId(source: Pick<SecretSource, 'provider' | 'path' | 'version'>) {
  return `${source.provider}\u0000${source.path}\u0000${source.version ?? ''}`;
}

export function sameSecretSource(a: Pick<SecretSource, 'provider' | 'path' | 'version'>, b: Pick<SecretSource, 'provider' | 'path' | 'version'>) {
  return secretSourceId(a) === secretSourceId(b);
}

export function secretSourceLabel(source: Pick<SecretSource, 'provider' | 'path' | 'version'>) {
  return `${source.provider} · ${source.path}${source.version ? `@${source.version}` : ''}`;
}

export function secretSourceVariables(source: SecretSource, loadedKeys: string[] | undefined) {
  const keys = source.keys ?? loadedKeys ?? [];
  return keys.map(key => ({ key, variable: `${source.prefix ?? ''}${key}` }));
}

export function secretSourceRow(source: SecretSource, key: string, index: number): KVRow {
  const ref: SecretRef = { provider: source.provider, path: source.path, field: key, ...(source.version ? { version: source.version } : {}) };
  return { id: -(index + 1), enabled: true, key: `${source.prefix ?? ''}${key}`, value: '', description: '', secret: true, secretRef: ref };
}

export type SecretSourceKeyState = 'imported' | 'skipped' | 'row' | 'replaced' | 'missing';
export type SecretSourceKeyItem = { key: string; variable: string; included: boolean; state: SecretSourceKeyState; detail: string };

export function secretSourceMapping(
  source: SecretSource,
  loadedKeys: string[] | undefined,
  effective: Map<string, InheritedRow>,
  environmentId: string,
): SecretSourceKeyItem[] {
  const keys = [...(loadedKeys ?? [])];
  for (const key of source.keys ?? []) if (!keys.includes(key)) keys.push(key);
  return keys.map(key => {
    const variable = `${source.prefix ?? ''}${key}`;
    const included = source.keys ? source.keys.includes(key) : true;
    if (!included) return { key, variable, included, state: 'skipped', detail: 'skipped' };
    if (loadedKeys && !loadedKeys.includes(key)) return { key, variable, included, state: 'missing', detail: 'Not in the secret' };
    const winner = effective.get(variable);
    if (winner && !winner.imported) {
      return { key, variable, included, state: 'row', detail: winner.sourceId === environmentId ? 'The variable row wins' : `The row in ${winner.sourceName} wins` };
    }
    if (winner?.imported && !sameSecretSource(winner.imported, source)) {
      return { key, variable, included, state: 'replaced', detail: `${secretSourceLabel(winner.imported)} wins` };
    }
    return { key, variable, included, state: 'imported', detail: 'from source' };
  });
}

export function toggleSecretSourceKey(source: SecretSource, key: string, include: boolean, loadedKeys: string[] | undefined): SecretSource {
  const all = loadedKeys ?? source.keys ?? [];
  const current = source.keys ?? all;
  const next = include ? [...new Set([...current, key])] : current.filter(item => item !== key);
  const { keys: _keys, ...rest } = source;
  if (loadedKeys && loadedKeys.every(item => next.includes(item)) && next.every(item => loadedKeys.includes(item))) return rest;
  return { ...rest, keys: all.filter(item => next.includes(item)).concat(next.filter(item => !all.includes(item))) };
}
