import type { RequestStore } from './types/models';

function stringIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => typeof id === 'string' && id !== ''))];
}

export function legacyStarredRequestIds(requests: unknown): string[] {
  if (!Array.isArray(requests)) return [];
  return stringIds(requests
    .filter(request => request && typeof request === 'object' && (request as { isPinned?: unknown }).isPinned === true)
    .map(request => (request as { id?: unknown }).id));
}

export function starredRequestIdsFromStore(store: Partial<RequestStore>): string[] {
  if (Array.isArray(store.starredRequestIds)) return stringIds(store.starredRequestIds);
  return legacyStarredRequestIds(store.requests);
}
