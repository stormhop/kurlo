import type { Collection } from './types/models';

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
