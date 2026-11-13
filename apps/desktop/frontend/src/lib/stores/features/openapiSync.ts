import { deleteOpenApiBaseSpec, readOpenApiBaseSpec, readOpenApiSourceFile, sendHttpRequest, writeOpenApiBaseSpec } from '../../backend';
import { emptyAuthConfig, emptyHttpRequest } from '../../wire';
import type { Collection, OpenApiSource, PersistRequestStore, SavedRequest, Workspace } from '../../types/models';
import { normalizeOpenApiSource, openApiSourceIsUrl } from '../../openapiSource';
import { normalizeSavedRequest } from '../../normalizers';
import type { OpenApiSelection, OpenApiSyncPlan } from '../../openapiSync';
import type { TopView } from '../ui';

export type OpenApiSyncState = 'idle' | 'checking' | 'in-sync' | 'updates' | 'skipped' | 'error';

export type OpenApiSyncStatus = {
  state: OpenApiSyncState;
  message: string;
  checkedAt: number;
  summary: string;
  pending: number;
};

export type OpenApiReviewState = {
  collectionId: string;
  plan: OpenApiSyncPlan;
  selection: OpenApiSelection;
  hash: string;
  firstSync: boolean;
  applying: boolean;
};

type LocalSyncRecord = {
  lastCheckedAt?: number;
  etag?: string;
  lastModified?: string;
  skippedHash?: string;
};

type FetchedSpec = { kind: 'unchanged' } | { kind: 'spec'; spec: unknown; text: string; hash: string; etag: string; lastModified: string; sourceUrl: string };

const LOCAL_KEY = 'kurlo.openapiSync.v1';
const TICK_MS = 60_000;

const pendingSpecs = new Map<string, { spec: unknown; text: string; hash: string; sourceUrl: string }>();
const inFlight = new Map<string, Promise<void>>();
let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let schedulerListener: (() => void) | null = null;

function readLocal(): Record<string, LocalSyncRecord> {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, LocalSyncRecord> : {};
  } catch {
    return {};
  }
}

function localRecord(collectionId: string): LocalSyncRecord {
  return readLocal()[collectionId] ?? {};
}

function writeLocal(collectionId: string, patch: LocalSyncRecord | null) {
  try {
    const all = readLocal();
    if (patch === null) delete all[collectionId];
    else all[collectionId] = { ...all[collectionId], ...patch };
    localStorage.setItem(LOCAL_KEY, JSON.stringify(all));
  } catch {
    return;
  }
}

function header(headers: Array<{ key: string; value: string }> | undefined, name: string) {
  return headers?.find(item => item.key.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function requestHeader(key: string, value: string) {
  return { key, value, enabled: true, isFile: false, fileName: '', contentType: '' };
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

type OpenApiSyncHost = {
  collections: Collection[];
  requests: SavedRequest[];
  workspaces: Workspace[];
  activeWorkspaceId: string;
  activeRequestId: string;
  openRequestIds: string[];
  topView: TopView;
  collectionImportToast: string;
  collectionSettingsTab: string;
  openApiSync: Record<string, OpenApiSyncStatus>;
  openApiReview: OpenApiReviewState | null;
  guardWorkspaceWritable: (action?: string) => boolean;
  persistActiveRequestNow: (forceDisk?: boolean) => Promise<void>;
  persistRequestStore: PersistRequestStore;
  ensureCollectionExamples: (collectionId: string) => Promise<void>;
  applySavedRequest: (request: SavedRequest) => void;
  trashRequest: (request: SavedRequest, workspaceId: string) => void;
  removeDirtyRequest: (id: string) => void;
  activeEnvironmentValues: () => Record<string, string>;
  resolveTemplate: (value: string, values?: Record<string, string>) => string;
  openAlertDialog: (title: string, message: string) => Promise<void>;
  openCollectionSettings: (collectionId: string) => Promise<void>;
  setOpenApiStatus: (collectionId: string, patch: Partial<OpenApiSyncStatus>) => void;
  fetchOpenApiSpec: (collection: Collection, conditional: boolean) => Promise<FetchedSpec>;
  checkOpenApiSync: (collectionId: string, options?: { manual?: boolean; review?: boolean }) => Promise<void>;
  runOpenApiCheck: (collectionId: string, manual: boolean, review: boolean) => Promise<void>;
  openApiPlanFor: (collection: Collection, spec: unknown, sourceUrl: string) => Promise<{ plan: OpenApiSyncPlan; firstSync: boolean }>;
  storeOpenApiBase: (collectionId: string, text: string) => Promise<boolean>;
  saveOpenApiSource: (collectionId: string, source: OpenApiSource | undefined) => Promise<boolean>;
  openApiSchedulerTick: () => void;
};

export const openApiSyncFeature = {
  setOpenApiStatus(this: OpenApiSyncHost, collectionId: string, patch: Partial<OpenApiSyncStatus>) {
    const current = this.openApiSync[collectionId] ?? { state: 'idle', message: '', checkedAt: localRecord(collectionId).lastCheckedAt ?? 0, summary: '', pending: 0 };
    this.openApiSync = { ...this.openApiSync, [collectionId]: { ...current, ...patch } };
  },

  openApiStatus(this: OpenApiSyncHost, collectionId: string): OpenApiSyncStatus {
    return this.openApiSync[collectionId] ?? { state: 'idle', message: '', checkedAt: localRecord(collectionId).lastCheckedAt ?? 0, summary: '', pending: 0 };
  },

  openApiHasUpdates(this: OpenApiSyncHost, collectionId: string): boolean {
    return this.openApiSync[collectionId]?.state === 'updates';
  },

  async fetchOpenApiSpec(this: OpenApiSyncHost, collection: Collection, conditional: boolean): Promise<FetchedSpec> {
    const source = collection.openapi;
    if (!source) throw new Error('This collection has no OpenAPI source.');
    const values: Record<string, string> = {};
    for (const row of collection.defaults.variables ?? []) if (row.enabled && row.key.trim()) values[row.key] = row.value;
    Object.assign(values, this.activeEnvironmentValues());
    const resolved = this.resolveTemplate(source.source, values).trim();
    const { parseOpenApiResponse } = await import('../../openapi');
    const { openApiSpecHash } = await import('../../openapiSync');
    if (!openApiSourceIsUrl(resolved)) {
      const file = await readOpenApiSourceFile(resolved);
      if (file.error) throw new Error(file.error);
      const hash = await openApiSpecHash(file.content);
      if (conditional && hash === localRecord(collection.id).etag) return { kind: 'unchanged' };
      return { kind: 'spec', spec: parseOpenApiResponse(file.content, ''), text: file.content, hash, etag: hash, lastModified: '', sourceUrl: '' };
    }
    const local = localRecord(collection.id);
    const headers = [requestHeader('Accept', 'application/json, application/yaml, text/yaml, text/plain;q=0.9, */*;q=0.8')];
    for (const row of source.headers ?? []) {
      if (row.enabled === false || !row.key.trim()) continue;
      headers.push(requestHeader(this.resolveTemplate(row.key, values), this.resolveTemplate(row.value, values)));
    }
    if (conditional && local.etag) headers.push(requestHeader('If-None-Match', local.etag));
    if (conditional && local.lastModified) headers.push(requestHeader('If-Modified-Since', local.lastModified));
    const response = await sendHttpRequest({
      ...emptyHttpRequest(),
      requestId: `openapi-sync-${collection.id}-${Date.now()}`,
      method: 'GET',
      url: resolved,
      headers,
      auth: emptyAuthConfig(),
      bodyType: 'none',
      followRedirects: true,
      maxRedirects: 10,
      timeoutMs: 30000,
      enableSSLVerification: !source.skipTlsVerification,
      encodeUrlAutomatically: true,
      disableCookieJar: true,
    });
    if (response.error && !response.statusCode) throw new Error(response.error);
    if (response.statusCode === 304) return { kind: 'unchanged' };
    if (response.statusCode >= 400) throw new Error(`The spec URL answered ${response.status || response.statusCode}.`);
    const body = response.body ?? '';
    const spec = parseOpenApiResponse(body, header(response.headers, 'content-type'));
    const hash = await openApiSpecHash(body);
    return { kind: 'spec', spec, text: body, hash, etag: header(response.headers, 'etag'), lastModified: header(response.headers, 'last-modified'), sourceUrl: resolved };
  },

  async openApiPlanFor(this: OpenApiSyncHost, collection: Collection, spec: unknown, sourceUrl: string) {
    const { planOpenApiSync } = await import('../../openapiSync');
    const { parseOpenApiDocument } = await import('../../openapi');
    const base = await readOpenApiBaseSpec(collection.id);
    if (base.error) throw new Error(base.error);
    let baseSpec: unknown = null;
    if (base.exists && base.content.trim()) {
      try {
        baseSpec = parseOpenApiDocument(base.content);
      } catch {
        baseSpec = null;
      }
    }
    await this.ensureCollectionExamples(collection.id);
    const plan = planOpenApiSync({ collection, requests: this.requests, baseSpec, nextSpec: spec, sourceUrl });
    return { plan, firstSync: baseSpec === null };
  },

  async storeOpenApiBase(this: OpenApiSyncHost, collectionId: string, text: string) {
    const error = await writeOpenApiBaseSpec(collectionId, text);
    if (error) {
      this.setOpenApiStatus(collectionId, { state: 'error', message: `Could not save the spec snapshot: ${error}` });
      return false;
    }
    return true;
  },

  checkOpenApiSync(this: OpenApiSyncHost, collectionId: string, options: { manual?: boolean; review?: boolean } = {}) {
    const running = inFlight.get(collectionId);
    if (running) return running;
    const task = this.runOpenApiCheck(collectionId, options.manual ?? false, options.review ?? false)
      .finally(() => inFlight.delete(collectionId));
    inFlight.set(collectionId, task);
    return task;
  },

  async runOpenApiCheck(this: OpenApiSyncHost, collectionId: string, manual: boolean, review: boolean) {
    const collection = this.collections.find(candidate => candidate.id === collectionId);
    if (!collection?.openapi || collection.isInvalid) return;
    this.setOpenApiStatus(collectionId, { state: 'checking', message: '' });
    const checkedAt = Date.now();
    try {
      const cached = pendingSpecs.get(collectionId);
      const fetched = await this.fetchOpenApiSpec(collection, !manual && !review);
      if (fetched.kind === 'unchanged') {
        writeLocal(collectionId, { lastCheckedAt: checkedAt });
        const previous = this.openApiSync[collectionId];
        this.setOpenApiStatus(collectionId, { state: previous?.state === 'updates' || previous?.state === 'skipped' ? previous.state : 'in-sync', checkedAt });
        if (!review || !cached) return;
      }
      const current = fetched.kind === 'spec' ? fetched : { ...cached!, etag: '', lastModified: '' };
      writeLocal(collectionId, { lastCheckedAt: checkedAt, etag: current.etag || undefined, lastModified: current.lastModified || undefined });
      const latest = this.collections.find(candidate => candidate.id === collectionId);
      if (!latest?.openapi) return;
      if (review) await this.persistActiveRequestNow();
      const { canonicalSpecText, openApiPlanIsEmpty, openApiPlanSummary, defaultOpenApiSelection } = await import('../../openapiSync');
      const { plan, firstSync } = await this.openApiPlanFor(latest, current.spec, current.sourceUrl);
      const baseText = canonicalSpecText(current.spec);
      if (openApiPlanIsEmpty(plan) && !plan.links.length) {
        pendingSpecs.delete(collectionId);
        await this.storeOpenApiBase(collectionId, baseText);
        writeLocal(collectionId, { skippedHash: undefined });
        this.setOpenApiStatus(collectionId, { state: 'in-sync', message: '', summary: 'In sync', pending: 0, checkedAt });
        if (review) this.openApiReview = null;
        return;
      }
      pendingSpecs.set(collectionId, { spec: current.spec, text: baseText, hash: current.hash, sourceUrl: current.sourceUrl });
      const summary = openApiPlanSummary(plan);
      const pending = plan.endpoints.length + (plan.collection ? 1 : 0);
      const skipped = !manual && !review && localRecord(collectionId).skippedHash === current.hash;
      this.setOpenApiStatus(collectionId, { state: skipped ? 'skipped' : 'updates', message: '', summary, pending, checkedAt });
      if (review || (manual && pending)) {
        this.openApiReview = { collectionId, plan, selection: defaultOpenApiSelection(plan), hash: current.hash, firstSync, applying: false };
        return;
      }
      if (!skipped && pending) {
        const toast = `${latest.name}: ${summary}. Review in the collection's OpenAPI tab.`;
        this.collectionImportToast = toast;
        setTimeout(() => { if (this.collectionImportToast === toast) this.collectionImportToast = ''; }, 6000);
      }
    } catch (err) {
      writeLocal(collectionId, { lastCheckedAt: checkedAt });
      this.setOpenApiStatus(collectionId, { state: 'error', message: err instanceof Error ? err.message : String(err), checkedAt });
    }
  },

  async reviewOpenApiChanges(this: OpenApiSyncHost, collectionId: string) {
    if (!this.guardWorkspaceWritable('Syncing with OpenAPI')) return;
    await this.checkOpenApiSync(collectionId, { manual: true, review: true });
    const status = this.openApiSync[collectionId];
    if (status?.state === 'error') await this.openAlertDialog('OpenAPI sync failed', status.message);
  },

  setOpenApiReviewSelection(this: OpenApiSyncHost, selection: OpenApiSelection) {
    if (!this.openApiReview) return;
    this.openApiReview = { ...this.openApiReview, selection };
  },

  closeOpenApiReview(this: OpenApiSyncHost) {
    this.openApiReview = null;
  },

  skipOpenApiReview(this: OpenApiSyncHost) {
    const review = this.openApiReview;
    if (!review) return;
    writeLocal(review.collectionId, { skippedHash: review.hash });
    this.setOpenApiStatus(review.collectionId, { state: 'skipped' });
    this.openApiReview = null;
  },

  async applyOpenApiReview(this: OpenApiSyncHost, mode: 'selected' | 'all' = 'selected') {
    const review = this.openApiReview;
    if (!review || review.applying) return;
    if (!this.guardWorkspaceWritable('Syncing with OpenAPI')) return;
    const collection = this.collections.find(candidate => candidate.id === review.collectionId);
    const pending = pendingSpecs.get(review.collectionId);
    if (!collection?.openapi || !pending) {
      this.openApiReview = null;
      return;
    }
    this.openApiReview = { ...review, applying: true };
    try {
      const { acceptAllOpenApiSelection, applyOpenApiPlan } = await import('../../openapiSync');
      await this.persistActiveRequestNow();
      const selection = mode === 'all' ? acceptAllOpenApiSelection(review.plan) : review.selection;
      const result = applyOpenApiPlan(review.plan, selection, this.requests, collection);
      const workspaceId = collection.workspaceId;
      for (const request of result.removed) {
        this.trashRequest(request, workspaceId);
        this.removeDirtyRequest(request.id);
      }
      const removedIds = new Set(result.removed.map(request => request.id));
      const nextCollections = this.collections.map(candidate => candidate.id !== collection.id ? candidate : {
        ...candidate,
        ...(result.defaults ? { defaults: result.defaults } : {}),
        openapi: normalizeOpenApiSource({ ...candidate.openapi, ignored: result.ignored }) ?? candidate.openapi,
      });
      const nextRequests = result.requests.map(request => result.added.includes(request)
        ? normalizeSavedRequest(request, nextCollections, workspaceId)
        : request);
      this.collections = nextCollections;
      this.requests = nextRequests;
      this.openRequestIds = this.openRequestIds.filter(id => !removedIds.has(id));
      const active = nextRequests.find(request => request.id === this.activeRequestId);
      if (removedIds.has(this.activeRequestId)) this.activeRequestId = '';
      else if (active && active.collectionId === collection.id) this.applySavedRequest(active);
      const saved = await this.persistRequestStore(nextRequests, undefined, this.openRequestIds, this.workspaces, nextCollections);
      if (!saved) throw new Error('Kurlo could not save the workspace.');
      if (!await this.storeOpenApiBase(collection.id, pending.text)) return;
      pendingSpecs.delete(collection.id);
      writeLocal(collection.id, { skippedHash: undefined });
      this.setOpenApiStatus(collection.id, { state: 'in-sync', message: '', summary: 'In sync', pending: 0, checkedAt: Date.now() });
      this.openApiReview = null;
      const parts = [
        result.added.length ? `${plural(result.added.length, 'request')} added` : '',
        result.removed.length ? `${result.removed.length} removed` : '',
        result.applied - result.added.length - result.removed.length > 0 ? `${result.applied - result.added.length - result.removed.length} updated` : '',
      ].filter(Boolean);
      const toast = `${collection.name}: ${parts.join(', ') || 'synced with the spec'}`;
      this.collectionImportToast = toast;
      setTimeout(() => { if (this.collectionImportToast === toast) this.collectionImportToast = ''; }, 3200);
    } catch (err) {
      if (this.openApiReview) this.openApiReview = { ...this.openApiReview, applying: false };
      await this.openAlertDialog('OpenAPI sync failed', err instanceof Error ? err.message : String(err));
    }
  },

  async saveOpenApiSource(this: OpenApiSyncHost, collectionId: string, source: OpenApiSource | undefined) {
    if (!this.guardWorkspaceWritable('Changing the OpenAPI source')) return false;
    const collection = this.collections.find(candidate => candidate.id === collectionId);
    if (!collection || collection.isInvalid) return false;
    const next = normalizeOpenApiSource(source);
    const sourceChanged = (collection.openapi?.source ?? '') !== (next?.source ?? '');
    this.collections = this.collections.map(candidate => {
      if (candidate.id !== collectionId) return candidate;
      const { openapi: _old, ...rest } = candidate;
      return next ? { ...rest, openapi: next } : rest;
    });
    const ok = await this.persistRequestStore();
    if (!ok) return false;
    if (sourceChanged) {
      pendingSpecs.delete(collectionId);
      writeLocal(collectionId, { etag: undefined, lastModified: undefined, skippedHash: undefined });
      this.setOpenApiStatus(collectionId, { state: 'idle', message: '', summary: '', pending: 0 });
    }
    return true;
  },

  async connectOpenApiSource(this: OpenApiSyncHost, collectionId: string, source: OpenApiSource) {
    const saved = await this.saveOpenApiSource(collectionId, source);
    if (!saved) return false;
    await this.checkOpenApiSync(collectionId, { manual: true, review: true });
    const status = this.openApiSync[collectionId];
    if (status?.state === 'error') await this.openAlertDialog('Could not read the spec', status.message);
    return status?.state !== 'error';
  },

  async disconnectOpenApiSource(this: OpenApiSyncHost, collectionId: string) {
    if (!this.guardWorkspaceWritable('Disconnecting the OpenAPI source')) return;
    const ok = await this.saveOpenApiSource(collectionId, undefined);
    if (!ok) return;
    await deleteOpenApiBaseSpec(collectionId);
    pendingSpecs.delete(collectionId);
    writeLocal(collectionId, null);
    const { [collectionId]: _removed, ...rest } = this.openApiSync;
    this.openApiSync = rest;
    if (this.openApiReview?.collectionId === collectionId) this.openApiReview = null;
  },

  async linkImportedOpenApiCollection(this: OpenApiSyncHost, collectionId: string, source: { url: string; skipTlsVerification?: boolean }, spec: unknown) {
    const { canonicalSpecText } = await import('../../openapiSync');
    const saved = await this.saveOpenApiSource(collectionId, {
      source: source.url,
      intervalMinutes: 15,
      ...(source.skipTlsVerification ? { skipTlsVerification: true } : {}),
    });
    if (!saved) return;
    if (await this.storeOpenApiBase(collectionId, canonicalSpecText(spec))) {
      writeLocal(collectionId, { lastCheckedAt: Date.now() });
      this.setOpenApiStatus(collectionId, { state: 'in-sync', summary: 'In sync', pending: 0, checkedAt: Date.now() });
    }
  },

  openApiSchedulerTick(this: OpenApiSyncHost) {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const now = Date.now();
    for (const collection of this.collections) {
      const interval = collection.openapi?.intervalMinutes ?? 0;
      if (!collection.openapi || !interval || collection.isInvalid) continue;
      if (collection.workspaceId !== this.activeWorkspaceId) continue;
      const last = Math.max(localRecord(collection.id).lastCheckedAt ?? 0, this.openApiSync[collection.id]?.checkedAt ?? 0);
      if (now - last < interval * 60_000) continue;
      void this.checkOpenApiSync(collection.id);
    }
  },

  startOpenApiScheduler(this: OpenApiSyncHost) {
    if (schedulerTimer || typeof window === 'undefined') return;
    schedulerTimer = setInterval(() => this.openApiSchedulerTick(), TICK_MS);
    schedulerListener = () => this.openApiSchedulerTick();
    window.addEventListener('focus', schedulerListener);
    document.addEventListener('visibilitychange', schedulerListener);
    setTimeout(() => this.openApiSchedulerTick(), 5000);
  },

  stopOpenApiScheduler() {
    if (schedulerTimer) clearInterval(schedulerTimer);
    schedulerTimer = null;
    if (schedulerListener && typeof window !== 'undefined') {
      window.removeEventListener('focus', schedulerListener);
      document.removeEventListener('visibilitychange', schedulerListener);
    }
    schedulerListener = null;
  },

  async openOpenApiSettings(this: OpenApiSyncHost, collectionId: string) {
    await this.openCollectionSettings(collectionId);
    if (this.topView === 'collection') this.collectionSettingsTab = 'openapi';
  },
};
