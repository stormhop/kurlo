import type { Collection, Environment } from './types/models';

export type CollectionEnvironmentPins = Pick<Collection, 'environmentIds' | 'defaultEnvironmentId'>;

export type EnvironmentMenuGroups = {
  scoped: boolean;
  pinned: Environment[];
  others: Environment[];
  defaultId: string;
};

export function normalizeCollectionEnvironmentPins(input: { environmentIds?: unknown; defaultEnvironmentId?: unknown } | undefined): CollectionEnvironmentPins {
  const ids: string[] = [];
  if (Array.isArray(input?.environmentIds)) {
    for (const value of input.environmentIds) {
      if (typeof value !== 'string') continue;
      const id = value.trim();
      if (id && !ids.includes(id)) ids.push(id);
    }
  }
  const requestedDefault = typeof input?.defaultEnvironmentId === 'string' ? input.defaultEnvironmentId.trim() : '';
  const defaultEnvironmentId = ids.includes(requestedDefault) ? requestedDefault : '';
  return {
    ...(ids.length ? { environmentIds: ids } : {}),
    ...(defaultEnvironmentId ? { defaultEnvironmentId } : {}),
  };
}

export function pinnedEnvironments(collection: CollectionEnvironmentPins | undefined, environments: Environment[]): Environment[] {
  const ids = collection?.environmentIds ?? [];
  if (!ids.length) return [];
  const byId = new Map(environments.map(environment => [environment.id, environment]));
  return ids.map(id => byId.get(id)).filter((environment): environment is Environment => Boolean(environment));
}

export function defaultPinnedEnvironmentId(collection: CollectionEnvironmentPins | undefined, environments: Environment[]): string {
  const pinned = pinnedEnvironments(collection, environments);
  if (!pinned.length) return '';
  const requested = collection?.defaultEnvironmentId ?? '';
  return pinned.some(environment => environment.id === requested) ? requested : pinned[0].id;
}

export function environmentMenuGroups(collection: CollectionEnvironmentPins | undefined, environments: Environment[]): EnvironmentMenuGroups {
  const pinned = pinnedEnvironments(collection, environments);
  if (!pinned.length) return { scoped: false, pinned: [], others: environments, defaultId: '' };
  const pinnedIds = new Set(pinned.map(environment => environment.id));
  return {
    scoped: true,
    pinned,
    others: environments.filter(environment => !pinnedIds.has(environment.id)),
    defaultId: defaultPinnedEnvironmentId(collection, environments),
  };
}

export function environmentForCollectionEntry(collection: CollectionEnvironmentPins | undefined, environments: Environment[], activeEnvironmentId: string): string | null {
  const pinned = pinnedEnvironments(collection, environments);
  if (!pinned.length) return null;
  if (activeEnvironmentId && pinned.some(environment => environment.id === activeEnvironmentId)) return null;
  return defaultPinnedEnvironmentId(collection, environments);
}

export function withoutPinnedEnvironment<T extends CollectionEnvironmentPins>(collection: T, environmentId: string): T {
  if (!collection.environmentIds?.includes(environmentId)) return collection;
  const { environmentIds: _ids, defaultEnvironmentId: _default, ...rest } = collection;
  return {
    ...rest,
    ...normalizeCollectionEnvironmentPins({
      environmentIds: collection.environmentIds.filter(id => id !== environmentId),
      defaultEnvironmentId: collection.defaultEnvironmentId === environmentId ? '' : collection.defaultEnvironmentId,
    }),
  } as T;
}
