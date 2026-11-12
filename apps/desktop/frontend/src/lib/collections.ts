import type { Collection, SavedRequest } from './types/models';

export type DropPlacement = 'before' | 'after';

const FOLDER_PATH_SEPARATOR = '\u001f';

export function normalizeFolderPath(path: string[] | undefined): string[] {
  return (path ?? []).map(part => String(part).trim()).filter(Boolean);
}

export function folderPathKey(path: string[] | undefined): string {
  return normalizeFolderPath(path).join(FOLDER_PATH_SEPARATOR);
}

export function folderPathStartsWith(path: string[] | undefined, prefix: string[] | undefined): boolean {
  const normalized = normalizeFolderPath(path);
  const normalizedPrefix = normalizeFolderPath(prefix);
  return normalizedPrefix.length > 0
    && normalizedPrefix.every((part, index) => normalized[index] === part);
}

export function normalizeCollectionFolderPaths(paths: string[][] | undefined): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const path of Array.isArray(paths) ? paths : []) {
    if (!Array.isArray(path)) continue;
    const normalized = normalizeFolderPath(path);
    if (!normalized.length) continue;
    const key = folderPathKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

export function folderCollapsedByDefault(path: string[] | undefined): boolean {
  return normalizeFolderPath(path).length > 1;
}

export function addCollectionFolderPath(collection: Collection, path: string[] | undefined): Collection {
  const normalized = normalizeFolderPath(path);
  if (!normalized.length) return collection;
  const folderPaths = normalizeCollectionFolderPaths([...(collection.folderPaths ?? []), normalized]);
  return { ...collection, folderPaths };
}

export function renameCollectionFolderPath(collection: Collection, oldPath: string[], newPath: string[]): Collection {
  const normalizedOld = normalizeFolderPath(oldPath);
  const normalizedNew = normalizeFolderPath(newPath);
  if (!normalizedOld.length || !normalizedNew.length) return collection;
  const renamed = normalizeCollectionFolderPaths(collection.folderPaths).map(path =>
    folderPathStartsWith(path, normalizedOld)
      ? [...normalizedNew, ...path.slice(normalizedOld.length)]
      : path
  );
  return { ...collection, folderPaths: normalizeCollectionFolderPaths(renamed) };
}

export function removeCollectionFolderPathTree(collection: Collection, path: string[]): Collection {
  const normalized = normalizeFolderPath(path);
  if (!normalized.length) return collection;
  return {
    ...collection,
    folderPaths: normalizeCollectionFolderPaths(collection.folderPaths).filter(folderPath => !folderPathStartsWith(folderPath, normalized)),
  };
}

export function reorderWorkspaceCollections(
  collections: Collection[],
  workspaceId: string,
  sourceId: string,
  targetId: string,
  placement: DropPlacement,
): Collection[] {
  if (!workspaceId || sourceId === targetId) return collections;

  const workspaceCollections = collections.filter(c => c.workspaceId === workspaceId);
  const source = workspaceCollections.find(c => c.id === sourceId);
  const target = workspaceCollections.find(c => c.id === targetId);
  if (!source || !target) return collections;

  const withoutSource = workspaceCollections.filter(c => c.id !== sourceId);
  const targetIndex = withoutSource.findIndex(c => c.id === targetId);
  if (targetIndex < 0) return collections;

  const insertAt = placement === 'after' ? targetIndex + 1 : targetIndex;
  const reorderedWorkspace = [
    ...withoutSource.slice(0, insertAt),
    source,
    ...withoutSource.slice(insertAt),
  ];

  let nextIndex = 0;
  return collections.map(collection => (
    collection.workspaceId === workspaceId
      ? reorderedWorkspace[nextIndex++]
      : collection
  ));
}

export function canReorderRequests(source: SavedRequest | undefined, target: SavedRequest | undefined): boolean {
  return Boolean(source && target
    && source.id !== target.id
    && source.collectionId
    && source.collectionId === target.collectionId
    && folderPathKey(source.folderPath) === folderPathKey(target.folderPath)
    && !source.isDraft && !target.isDraft
    && !source.isInvalid && !target.isInvalid);
}

export function reorderCollectionRequests(
  requests: SavedRequest[],
  sourceId: string,
  targetId: string,
  placement: DropPlacement,
): SavedRequest[] {
  const source = requests.find(request => request.id === sourceId);
  const target = requests.find(request => request.id === targetId);
  if (!source || !target || !canReorderRequests(source, target)) return requests;
  const siblings = requests.filter(request => request.collectionId === source.collectionId
    && folderPathKey(request.folderPath) === folderPathKey(source.folderPath));
  const withoutSource = siblings.filter(request => request.id !== sourceId);
  const targetIndex = withoutSource.findIndex(request => request.id === targetId);
  const insertAt = targetIndex + (placement === 'after' ? 1 : 0);
  const reordered = [...withoutSource.slice(0, insertAt), source, ...withoutSource.slice(insertAt)];
  if (reordered.every((request, index) => request === siblings[index])) return requests;
  let nextIndex = 0;
  const siblingIds = new Set(siblings.map(request => request.id));
  return requests.map(request => siblingIds.has(request.id) ? reordered[nextIndex++] : request);
}
