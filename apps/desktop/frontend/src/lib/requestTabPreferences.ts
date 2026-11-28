import type { RequestTab, RequestType, SavedRequest } from './types/models';
import type { RequestSection } from './stores/requestFiles.svelte';

const protocolTabs: Record<RequestType, readonly RequestTab[]> = {
  http: ['docs', 'params', 'auth', 'headers', 'vars', 'body', 'scripts', 'examples', 'settings'],
  graphql: ['docs', 'query', 'auth', 'headers', 'vars', 'schema', 'scripts', 'examples'],
  ws: ['docs', 'body', 'params', 'auth', 'headers', 'vars', 'settings'],
  socketio: ['docs', 'body', 'events', 'params', 'auth', 'headers', 'vars', 'settings'],
  kafka: ['docs', 'body', 'auth', 'headers', 'vars', 'scripts', 'settings'],
  mqtt: ['docs', 'body', 'events', 'auth', 'vars', 'properties', 'will', 'settings'],
  grpc: ['docs', 'body', 'auth', 'metadata', 'vars', 'service', 'scripts', 'settings'],
  mcp: ['docs', 'body', 'auth', 'headers', 'vars', 'scripts', 'settings', 'examples'],
  ai: ['docs', 'body', 'auth', 'headers', 'vars', 'tools', 'scripts', 'settings'],
};
const sseTabs = protocolTabs.http.filter(tab => tab !== 'scripts' && tab !== 'examples');
const sections = new Set<string>(['file', ...Object.values(protocolTabs).flat()]);
const volatilePreferences = new Map<string, RequestSection>();

function isSection(value: unknown): value is RequestSection {
  return typeof value === 'string' && sections.has(value);
}

function preferenceKey(root: string, workspaceId: string, requestId: string) {
  return 'kurlo.request-section.v1.' + JSON.stringify([root, workspaceId, requestId]);
}

export function requestSectionPreference(root: string, workspaceId: string, requestId: string): RequestSection | undefined {
  const key = preferenceKey(root, workspaceId, requestId);
  const fallback = volatilePreferences.get(key);
  if (fallback) return fallback;
  try {
    const value = localStorage.getItem(key);
    return isSection(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function saveRequestSectionPreference(root: string, workspaceId: string, requestId: string, section: RequestSection) {
  if (!workspaceId || !requestId) return;
  const key = preferenceKey(root, workspaceId, requestId);
  try {
    localStorage.setItem(key, section);
    volatilePreferences.delete(key);
  } catch {
    volatilePreferences.set(key, section);
  }
}

export function migrateRequestSectionPreferences(
  root: string,
  activeWorkspaceId: string,
  collections: { id: string; workspaceId: string }[],
  requests: Pick<SavedRequest, 'id' | 'collectionId' | 'requestTab'>[],
) {
  const workspaces = new Map(collections.map(item => [item.id, item.workspaceId]));
  for (const request of requests) {
    if (!request || !isSection(request.requestTab)) continue;
    const workspaceId = workspaces.get(request.collectionId) ?? activeWorkspaceId;
    if (!requestSectionPreference(root, workspaceId, request.id)) {
      saveRequestSectionPreference(root, workspaceId, request.id, request.requestTab);
    }
  }
}

export function resolveFormRequestTab(
  protocol: RequestType,
  method: string | undefined,
  preferred?: RequestSection,
  legacy?: RequestTab,
): RequestTab {
  const tabs = protocol === 'http' && method?.toUpperCase() === 'SSE' ? sseTabs : protocolTabs[protocol];
  if (preferred && preferred !== 'file' && tabs.includes(preferred)) return preferred;
  if (legacy && tabs.includes(legacy)) return legacy;
  return protocol === 'graphql' ? 'query' : protocol === 'http' ? 'params' : 'body';
}
