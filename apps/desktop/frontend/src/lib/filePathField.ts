import type { RequestFileInfo } from './wire';
import type { VariableSuggestion } from './variables';
import { formatSize } from './utils';

export const BINARY_DEFAULT_CONTENT_TYPE = 'application/octet-stream';

const TEMPLATE = /\{\{\s*([^{}]+?)\s*\}\}/g;

export function resolveFilePathTemplate(value: string, suggestions: VariableSuggestion[]): { path: string; unresolved: boolean } {
  let unresolved = false;
  const byKey = new Map(suggestions.map(suggestion => [suggestion.key, suggestion]));
  const path = value.replace(TEMPLATE, (match, key: string) => {
    const suggestion = byKey.get(key);
    if (!suggestion || suggestion.secret || suggestion.linked) {
      unresolved = true;
      return match;
    }
    return suggestion.value;
  });
  return { path: path.trim(), unresolved };
}

export function isRemoteFileSource(value: string) {
  const trimmed = value.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) && !/^file:\/\//i.test(trimmed);
}

export function fileBaseName(path: string) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function requestFileDetails(info: Pick<RequestFileInfo, 'exists' | 'size' | 'contentType'>) {
  if (!info.exists) return '';
  return [formatSize(info.size), info.contentType].filter(Boolean).join(' · ');
}

export type BinaryContentType = { sent: string; fromHeader: boolean; suggestion: string };

export function binaryContentType(header: string | undefined, detected: string | undefined): BinaryContentType {
  const explicit = (header ?? '').trim();
  if (explicit) return { sent: explicit, fromHeader: true, suggestion: '' };
  const guess = (detected ?? '').trim();
  return {
    sent: BINARY_DEFAULT_CONTENT_TYPE,
    fromHeader: false,
    suggestion: guess && guess !== BINARY_DEFAULT_CONTENT_TYPE ? guess : '',
  };
}
