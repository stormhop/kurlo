import type { CollectionTextFilesResult } from '../../wire';
import { chooseImportFile, hasNativeImportDialog, openDirectoryDialog, readCollectionTextFiles, readImportFile, sendHttpRequest, writeCollectionTextFiles, writeNewCollectionTextFiles } from '../../backend';
import { detectImportSource, isBrunoFolder, isPostmanV3Document, isPostmanV3Folder, type ImportSource } from '../../importSource';
import { emptyAuthConfig, emptyHttpRequest } from '../../wire';
import type { BodyType, Collection, CollectionDefaults, Environment, FolderDefaults, KVRow, RequestHistoryEntry, SavedRequest, Workspace } from '../../types/models';
import { mergeGlobalRowsWithImportedRows } from './globals';
import { mkRow } from '../../constants';
import type { TopView } from '../ui';
import { filesystemNameFromName, makeCollection, normalizeCollection, normalizeEnvironment, normalizeSavedRequest } from '../../normalizers';
import { normalizeCollectionDefaults } from '../../collectionDefaults';
import { downloadTextFile, safeFileName } from '../../utils';
import { requestsHaveExportSecrets } from '../../secretExport';
import { flattenedEnvironment } from '../../environmentInheritance';
import type { OpenApiExportFormat } from '../../openapi';
import type { DialogOption } from '../../types/dialog';

type ImportedCollectionDefaults = { variables?: KVRow[]; auth?: import('../../types/models').AuthState };
type ImportDestination = { workspaceId: string; persistEpoch: number };
type ImportedRequests = { collectionId: string; requestCount: number };

export function normalizeSpecUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed.replace(/^\/+/, '')}`;
}

function headerValue(headers: Array<{ key: string; value: string }> | undefined, name: string): string {
  return headers?.find(header => header.key.toLowerCase() === name.toLowerCase())?.value ?? '';
}

export type UrlImportOptions = { skipTlsVerification?: boolean; keepInSync?: boolean };

export function looksLikeTlsCertificateError(message: string): boolean {
  return /x509|certificate|tls: failed to verify|unknown authority/i.test(message);
}

async function fetchImportDocument(url: string, options: UrlImportOptions = {}): Promise<{ body: string; contentType: string }> {
  const response = await sendHttpRequest({
    ...emptyHttpRequest(),
    requestId: `import-url-${Date.now()}`,
    method: 'GET',
    url,
    headers: [{
      key: 'Accept',
      value: 'application/json, application/yaml, text/yaml, text/plain;q=0.9, */*;q=0.8',
      enabled: true,
      isFile: false,
      fileName: '',
      contentType: '',
    }],
    auth: emptyAuthConfig(),
    bodyType: 'none',
    followRedirects: true,
    maxRedirects: 10,
    timeoutMs: 30000,
    enableSSLVerification: !options.skipTlsVerification,
    encodeUrlAutomatically: true,
    disableCookieJar: true,
  });
  if (response.error && !response.statusCode) {
    if (!options.skipTlsVerification && looksLikeTlsCertificateError(response.error)) {
      throw new Error(`${response.error}. If you trust this server, import again with "Skip TLS certificate check" ticked.`);
    }
    throw new Error(response.error);
  }
  if (response.statusCode >= 400) {
    throw new Error(`That URL answered ${response.status || response.statusCode}.`);
  }
  return { body: response.body ?? '', contentType: headerValue(response.headers, 'content-type') };
}

export type ImportedCollectionBundle = {
  id?: string;
  name: string;
  description: string;
  defaults?: Partial<CollectionDefaults>;
  folderPaths?: string[][];
  folderDefaults?: FolderDefaults[];
  requests: SavedRequest[];
  environments?: Environment[];
};

function fileSegmentForExport(name: string) {
  return safeFileName(name).replace(/\s+/g, '-') || 'collection';
}

type ImportExportHost = {
  ensureCollectionExamples: (collectionId: string) => Promise<void>;
  changeGlobalsEverywhere: (change: (rows: KVRow[]) => KVRow[]) => void;
  collectionImportSource: ImportSource;
  collectionImportToast: string;
  collectionImportSummary: string;
  collections: Collection[];
  folderCollapseState: Record<string, boolean>;
  folderCollapseKey: (collectionId: string, path: string[]) => string;
  requests: SavedRequest[];
  environments: Environment[];
  workspaces: Workspace[];
  activeWorkspaceId: string;
  requestStorePersistEpoch: number;
  activeEnvironmentId: string;
  openRequestIds: string[];
  requestHistory: RequestHistoryEntry[];
  topView: TopView;
  _postmanImportInput: HTMLInputElement | undefined;
  guardWorkspaceWritable: (action?: string) => boolean;
  closeFloatingMenus: () => void;
  openSelectDialog: (title: string, message: string, options: DialogOption[], confirmLabel?: string, cancelLabel?: string) => Promise<string | false | null>;
  openAlertDialog: (title: string, message: string) => Promise<void>;
  openPromptDialog: (title: string, initialValue?: string, message?: string, placeholder?: string, confirmLabel?: string) => Promise<string | null>;
  persistActiveRequestNow: (forceDisk?: boolean) => Promise<void>;
  persistRequestStore: (nextRequests?: SavedRequest[], activeId?: string, nextOpenIds?: string[], nextWorkspaces?: Workspace[], nextCollections?: Collection[], workspaceId?: string, nextHistory?: RequestHistoryEntry[], nextEnvironments?: Environment[], nextActiveEnvId?: string) => Promise<boolean>;
  updateRequestDirtyState: (id: string) => void;
  applySavedRequest: (req: SavedRequest) => void;
  savedRequestIsRealtime: (req: SavedRequest) => boolean;
  savedRequestIsGraphQL: (req: SavedRequest) => boolean;
  stripBodyComments: (source: string, type: BodyType) => string;
  defaultWorkspaceParentForDialogs: () => Promise<string>;
  saveTextFile: (name: string, content: string) => Promise<boolean>;
  isRecord: (value: unknown) => value is Record<string, unknown>;
  importBrunoOpenCollectionFolder: () => Promise<void>;
  importBrunoFolderFiles: (root: string, result: CollectionTextFilesResult) => Promise<void>;
  importDroppedFolder: (path: string) => Promise<boolean>;
  importCollectionFolder: (root: string, preloaded?: CollectionTextFilesResult) => Promise<void>;
  runPostmanV3Import: (files: Array<{ path: string; content: string }>, fallbackName: string) => Promise<void>;
  importPostmanV3Files: (files: Array<{ path: string; content: string }>, fallbackName: string) => Promise<number>;
  importCollectionPayload: (text: string, fileName: string, source: ImportSource, destination?: ImportDestination) => Promise<number>;
  runCollectionFileImport: (text: string, fileName: string, source: ImportSource, destination?: ImportDestination) => Promise<void>;
  importOpenCollectionFiles: (files: Array<{ path: string; content: string }>, fallbackName: string) => Promise<number>;
  importHarPayload: (payload: unknown, fileName: string) => Promise<number>;
  importRequestsPayload: (collectionName: string, buildRequests: (collectionId: string, collectionName: string) => SavedRequest[], collectionDefaults?: ImportedCollectionDefaults | (() => ImportedCollectionDefaults | undefined), destination?: ImportDestination) => Promise<ImportedRequests>;
  importCollectionBundle: (bundle: ImportedCollectionBundle) => Promise<number>;
  importPostmanVariableBundle: (bundle: { scope: 'environment' | 'globals'; name: string; values: KVRow[] }) => Promise<number>;
  globalVariables: KVRow[];
  importHttpFilePayload: (text: string, fileName: string) => Promise<number>;
  importPostmanPayload: (payload: unknown, fileName: string) => Promise<number>;
  importInsomniaPayload: (payload: unknown, fileName: string) => Promise<number>;
  importOpenApiPayload: (payload: unknown, fileName: string, sourceUrl?: string, destination?: ImportDestination) => Promise<ImportedRequests>;
  importOpenApiFromUrl: (specUrl: string, options?: UrlImportOptions) => Promise<number>;
  openPromptWithToggleDialog: (title: string, message: string, placeholder: string, confirmLabel: string, toggle: { label: string; hint?: string; checked?: boolean; warn?: boolean } | Array<{ label: string; hint?: string; checked?: boolean; warn?: boolean }>) => Promise<{ value: string; checked: boolean; checks: boolean[] } | null>;
  linkImportedOpenApiCollection: (collectionId: string, source: { url: string; skipTlsVerification?: boolean }, spec: unknown) => Promise<boolean>;
  openOpenApiUrlImport: () => Promise<void>;
  exportCollectionToOpenCollection: (collectionId: string) => Promise<void>;
  exportCollectionToPostman: (collectionId: string) => Promise<void>;
  exportCollectionToPostmanV3: (collectionId: string) => Promise<void>;
  exportCollectionToInsomnia: (collectionId: string) => Promise<void>;
  exportCollectionToOpenApi: (collectionId: string, format: OpenApiExportFormat) => Promise<void>;
  chooseCollectionSecretExportMode: (reqs: SavedRequest[], title: string) => Promise<boolean | null>;
};

function importDestination(host: ImportExportHost): ImportDestination {
  return { workspaceId: host.activeWorkspaceId || host.workspaces[0]?.id || '', persistEpoch: host.requestStorePersistEpoch };
}

function requireImportDestination(host: ImportExportHost, destination: ImportDestination) {
  const current = importDestination(host);
  if (current.workspaceId !== destination.workspaceId || current.persistEpoch !== destination.persistEpoch) {
    throw new Error('The workspace changed during import. Open the intended workspace and try again.');
  }
  if (!destination.workspaceId) throw new Error('No workspace available');
  if (!host.guardWorkspaceWritable('Importing')) throw new Error('Kurlo could not write to the workspace.');
}

async function confirmImportedRequests(host: ImportExportHost, destination: ImportDestination, requests: SavedRequest[], write: Promise<boolean>) {
  const saved = await write;
  if (destination.persistEpoch !== host.requestStorePersistEpoch) throw new Error('The workspace changed during import.');
  if (saved) return;
  for (const request of requests) host.updateRequestDirtyState(request.id);
  throw new Error('Kurlo could not save the workspace.');
}

function collapseImportedCollection(host: ImportExportHost, collection: Collection, requests: SavedRequest[]) {
  collection.collapsed = true;
  const next = { ...host.folderCollapseState };
  const paths = [
    ...(collection.folderPaths ?? []),
    ...(collection.folderDefaults ?? []).map(folder => folder.path),
    ...requests.map(request => request.folderPath ?? []),
  ];
  for (const path of paths) {
    for (let depth = 1; depth <= path.length; depth += 1) {
      next[host.folderCollapseKey(collection.id, path.slice(0, depth))] = true;
    }
  }
  host.folderCollapseState = next;
}

export const importExportFeature = {
  async openPostmanImport(this: ImportExportHost) {
    if (!this.guardWorkspaceWritable('Importing')) return;
    this.closeFloatingMenus();
    const source = await this.openSelectDialog('Import collection', 'Choose the source format to import:', [
      { value: 'bruno', label: 'Bruno / OpenCollection', icon: 'bruno', description: 'Import a Bruno collection folder with opencollection.yml or legacy .bru files.' },
      { value: 'postman', label: 'Postman collection', icon: 'postman', description: 'Import a Postman v2.0/v2.1 collection, environment, or globals JSON file.' },
      { value: 'postman-v3', label: 'Postman v3 collection folder', icon: 'postman', description: 'Import a Postman v12 collection folder with .request.yaml files, environments and globals.' },
      { value: 'insomnia', label: 'Insomnia export', icon: 'insomnia', description: 'Import an Insomnia workspace or collection export JSON file.' },
      { value: 'openapi', label: 'OpenAPI / Swagger', icon: 'openapi', description: 'Import OpenAPI 3.x or Swagger 2.0 JSON/YAML specs.' },
      { value: 'openapi-url', label: 'OpenAPI / Swagger from URL', icon: 'openapi', description: 'Fetch a spec from a link — https://api.example.com/openapi.json' },
      { value: 'har', label: 'HAR from DevTools', icon: 'har', description: 'Turn captured browser traffic into requests.' },
      { value: 'httpfile', label: '.http / .rest file', icon: 'httpfile', description: 'Import a JetBrains HTTP Client or VS Code REST Client file.' },
    ], 'Import');
    if (!source) return;
    if (source === 'openapi-url') {
      await this.openOpenApiUrlImport();
      return;
    }
    if (source === 'postman-v3') {
      const root = await openDirectoryDialog('Import Postman v3 collection folder');
      if (root) await this.importCollectionFolder(root);
      return;
    }
    this.collectionImportSource = source as ImportSource;
    if (this.collectionImportSource === 'bruno') {
      await this.importBrunoOpenCollectionFolder();
      return;
    }
    if (!hasNativeImportDialog()) {
      this._postmanImportInput?.click();
      return;
    }
    const importSource = this.collectionImportSource;
    const destination = importDestination(this);
    const file = await chooseImportFile(importSource);
    if (file.error) {
      this.collectionImportToast = `Import failed: ${file.error}`;
      setTimeout(() => (this.collectionImportToast = ''), 3200);
      return;
    }
    if (file.path) await this.runCollectionFileImport(file.content, file.name, importSource, destination);
  },
  async importDroppedFiles(this: ImportExportHost, paths: string[]) {
    const destination = importDestination(this);
    for (const path of paths) {
      const file = await readImportFile(path);
      const name = file.name || path.split(/[\\/]/).pop() || path;
      if (file.error && await this.importDroppedFolder(path)) continue;
      if (!file.error && isPostmanV3Document(name, file.content)) {
        await this.runPostmanV3Import([{ path: name, content: file.content }], name.replace(/\.request\.ya?ml$/i, '').replace(/\.ya?ml$/i, ''));
        continue;
      }
      const source = file.error ? null : detectImportSource(name, file.content);
      if (!source) {
        this.collectionImportToast = file.error ? `Import failed: ${file.error}` : `Kurlo can't import ${name}`;
        setTimeout(() => (this.collectionImportToast = ''), 3200);
        continue;
      }
      await this.runCollectionFileImport(file.content, name, source, destination);
    }
  },
  async openOpenApiUrlImport(this: ImportExportHost) {
    if (!this.guardWorkspaceWritable('Importing')) return;
    const entered = await this.openPromptWithToggleDialog(
      'Import from URL',
      'Paste a link to an OpenAPI 3.x or Swagger 2.0 document. Kurlo fetches it and builds a collection from the paths it declares.',
      'https://api.example.com/openapi.json',
      'Import',
      [
        { label: 'Keep in sync with this URL', hint: 'Kurlo checks the spec every 15 minutes and asks before changing requests.', checked: true, warn: false },
        { label: 'Skip TLS certificate check', hint: 'For self-signed or internal certificates. Only use it for a server you trust.' },
      ],
    );
    if (!entered?.value.trim()) return;
    const [keepInSync = false, skipTlsVerification = false] = entered.checks;
    this.collectionImportToast = 'Fetching spec…';
    try {
      const count = await this.importOpenApiFromUrl(entered.value, { skipTlsVerification, keepInSync });
      this.collectionImportToast = this.collectionImportSummary
        || (count ? `Imported ${count} request${count === 1 ? '' : 's'}` : 'Imported empty collection');
      this.collectionImportSummary = '';
    } catch (err) {
      this.collectionImportToast = '';
      await this.openAlertDialog('Import from URL failed', err instanceof Error ? err.message : String(err));
      return;
    } finally {
      this.collectionImportSummary = '';
    }
    setTimeout(() => (this.collectionImportToast = ''), 3200);
  },
  async importOpenApiFromUrl(this: ImportExportHost, specUrl: string, options: UrlImportOptions = {}) {
    const destination = importDestination(this);
    requireImportDestination(this, destination);
    const url = normalizeSpecUrl(specUrl);
    if (!url) throw new Error('Enter a URL to import from.');
    const { parseOpenApiResponse, openApiNameFromUrl } = await import('../../openapi');
    const { body, contentType } = await fetchImportDocument(url, options);
    const spec = parseOpenApiResponse(body, contentType);
    requireImportDestination(this, destination);
    const { collectionId, requestCount } = await this.importOpenApiPayload(spec, openApiNameFromUrl(url), url, destination);
    if (options.keepInSync) {
      const linked = await this.linkImportedOpenApiCollection(collectionId, { url, skipTlsVerification: options.skipTlsVerification }, spec);
      if (!linked) throw new Error('The collection was imported, but Kurlo could not save its OpenAPI sync settings or spec snapshot.');
    }
    return requestCount;
  },
  async onPostmanImportFile(this: ImportExportHost, e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0]; input.value = ''; if (!file) return;
    const source = this.collectionImportSource;
    const destination = importDestination(this);
    await this.runCollectionFileImport(await file.text(), file.name, source, destination);
  },
  async runCollectionFileImport(this: ImportExportHost, text: string, fileName: string, source: ImportSource, destination = importDestination(this)) {
    try {
      this.collectionImportSummary = '';
      const count = await this.importCollectionPayload(text, fileName, source, destination);
      this.collectionImportToast = this.collectionImportSummary
        || (count ? `Imported ${count} request${count === 1 ? '' : 's'}` : 'Imported empty collection');
      this.collectionImportSummary = '';
    } catch (err) {
      this.collectionImportToast = `Import failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally { setTimeout(() => (this.collectionImportToast = ''), 3200); }
  },
  async importCollectionPayload(this: ImportExportHost, text: string, fileName: string, source: ImportSource, destination = importDestination(this)) {
    requireImportDestination(this, destination);
    if (source === 'bruno') {
      return this.importOpenCollectionFiles([{ path: fileName, content: text }], fileName.replace(/\.(bru|ya?ml)$/i, '') || 'Bruno Collection');
    }
    if (source === 'httpfile') return this.importHttpFilePayload(text, fileName);
    if (source === 'postman') return this.importPostmanPayload(JSON.parse(text) as unknown, fileName);
    if (source === 'insomnia') return this.importInsomniaPayload(JSON.parse(text) as unknown, fileName);
    if (source === 'har') return this.importHarPayload(JSON.parse(text) as unknown, fileName);
    const { parseOpenApiDocument } = await import('../../openapi');
    const spec = parseOpenApiDocument(text);
    const { requestCount } = await this.importOpenApiPayload(spec, fileName, '', destination);
    return requestCount;
  },
  async importDroppedFolder(this: ImportExportHost, path: string) {
    const result = await readCollectionTextFiles(path);
    if (result.error || !(isPostmanV3Folder(result.files) || isBrunoFolder(result.files))) return false;
    await this.importCollectionFolder(path, result);
    return true;
  },
  async importCollectionFolder(this: ImportExportHost, root: string, preloaded?: CollectionTextFilesResult) {
    if (!this.guardWorkspaceWritable('Importing')) return;
    const result = preloaded ?? await readCollectionTextFiles(root);
    const name = result.name || root.split(/[\\/]/).pop() || '';
    if (!result.error && isPostmanV3Folder(result.files)) {
      await this.runPostmanV3Import(result.files, name || 'Postman Collection');
      return;
    }
    await this.importBrunoFolderFiles(root, result);
  },
  async runPostmanV3Import(this: ImportExportHost, files: Array<{ path: string; content: string }>, fallbackName: string) {
    try {
      this.collectionImportSummary = '';
      await this.importPostmanV3Files(files, fallbackName);
      this.collectionImportToast = this.collectionImportSummary || 'Imported empty collection';
    } catch (err) {
      this.collectionImportToast = `Import failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      this.collectionImportSummary = '';
      setTimeout(() => (this.collectionImportToast = ''), 3600);
    }
  },
  async importPostmanV3Files(this: ImportExportHost, files: Array<{ path: string; content: string }>, fallbackName: string) {
    if (!this.guardWorkspaceWritable('Importing')) return 0;
    const wsId = this.activeWorkspaceId || this.workspaces[0]?.id; if (!wsId) throw new Error('No workspace available');
    const { postmanV3FromFiles } = await import('../../postmanV3');
    const { postmanCollectionBundle } = await import('../../postman');
    const imported = postmanV3FromFiles(files, fallbackName);
    if (!imported.collections.length && !imported.variableSets.length) {
      const reason = imported.skipped[0] ? `${imported.skipped[0].path}: ${imported.skipped[0].reason}` : 'no Postman v3 collection found';
      throw new Error(reason);
    }
    let requestCount = 0;
    for (const collection of imported.collections) {
      const collectionId = makeCollection(wsId, collection.name).id;
      const bundle = postmanCollectionBundle(collection.payload, collectionId, collection.name);
      requestCount += await this.importCollectionBundle({ ...bundle, id: collectionId });
    }
    const environments = imported.variableSets.filter(set => set.scope === 'environment');
    for (const set of imported.variableSets) {
      await this.importPostmanVariableBundle(set);
    }
    const parts = [`Imported ${requestCount} request${requestCount === 1 ? '' : 's'}`];
    if (imported.collections.length > 1) parts.push(`from ${imported.collections.length} collections`);
    if (environments.length) parts.push(`and ${environments.length} environment${environments.length === 1 ? '' : 's'}`);
    const skipped = imported.skipped.length ? ` · skipped ${imported.skipped.length} unsupported item${imported.skipped.length === 1 ? '' : 's'}` : '';
    this.collectionImportSummary = `${parts.join(' ')}${skipped}`;
    return requestCount;
  },
  async importBrunoOpenCollectionFolder(this: ImportExportHost) {
    if (!this.guardWorkspaceWritable('Importing')) return;
    const root = await openDirectoryDialog('Import Bruno / OpenCollection folder');
    if (!root) return;
    await this.importCollectionFolder(root);
  },
  async importBrunoFolderFiles(this: ImportExportHost, root: string, result: CollectionTextFilesResult) {
    try {
      if (result.error) throw new Error(result.error);
      const count = await this.importOpenCollectionFiles(result.files, result.name || root.split(/[\\/]/).pop() || 'Bruno Collection');
      this.collectionImportToast = count ? `Imported ${count} Bruno request${count === 1 ? '' : 's'}` : 'Imported empty Bruno collection';
    } catch (err) {
      this.collectionImportToast = `Import failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      setTimeout(() => (this.collectionImportToast = ''), 3600);
    }
  },
  async importOpenCollectionFiles(this: ImportExportHost, files: Array<{ path: string; content: string }>, fallbackName: string) {
    if (!this.guardWorkspaceWritable('Importing')) return 0;
    const wsId = this.activeWorkspaceId || this.workspaces[0]?.id; if (!wsId) throw new Error('No workspace available');
    const collectionId = makeCollection(wsId, fallbackName || 'Bruno Collection').id;
    const { openCollectionBundleFromFiles } = await import('../../opencollection');
    return this.importCollectionBundle({ ...openCollectionBundleFromFiles(files, collectionId, fallbackName, wsId), id: collectionId });
  },
  async importCollectionBundle(this: ImportExportHost, bundle: ImportedCollectionBundle & { id?: string }) {
    const destination = importDestination(this);
    requireImportDestination(this, destination);
    await this.persistActiveRequestNow();
    requireImportDestination(this, destination);
    const wsId = destination.workspaceId;
    const collection = makeCollection(wsId, bundle.name);
    const collectionId = bundle.id || collection.id;
    const importedCollection = normalizeCollection({
      ...collection,
      id: collectionId,
      name: bundle.name,
      description: bundle.description,
      filesystemName: filesystemNameFromName(bundle.name, collectionId),
      folderPaths: bundle.folderPaths,
      defaults: normalizeCollectionDefaults(bundle.defaults),
      folderDefaults: bundle.folderDefaults,
    }, wsId);
    const importCollections = [...this.collections, importedCollection];
    const importedReqs = bundle.requests.map(req => normalizeSavedRequest({ ...req, collectionId: importedCollection.id, collection: importedCollection.name }, importCollections, wsId));
    const importedEnvs = (bundle.environments ?? []).map(env => normalizeEnvironment(env, wsId));
    collapseImportedCollection(this, importedCollection, importedReqs);
    const nextCols = [...this.collections, importedCollection];
    const nextReqs = [...this.requests, ...importedReqs];
    const nextEnvs = [...this.environments, ...importedEnvs];
    const first = importedReqs[0];
    const nextOpenIds = first ? [...new Set([...this.openRequestIds, first.id])] : this.openRequestIds;
    this.activeWorkspaceId = wsId; this.collections = nextCols; this.requests = nextReqs; this.environments = nextEnvs; this.openRequestIds = nextOpenIds;
    if (first) {
      this.applySavedRequest(first);
      this.topView = 'request';
    }
    await confirmImportedRequests(this, destination, importedReqs, this.persistRequestStore(nextReqs, first?.id, nextOpenIds, this.workspaces, nextCols, wsId, this.requestHistory, nextEnvs, this.activeEnvironmentId));
    return importedReqs.length;
  },
  async importHarPayload(this: ImportExportHost, payload: unknown, fileName: string) {
    const { harCollectionName, harRequestsFromLog } = await import('../../har');
    const collectionName = harCollectionName(payload, fileName);
    const { requestCount } = await this.importRequestsPayload(collectionName, (collectionId, name) => harRequestsFromLog(payload, collectionId, name));
    return requestCount;
  },
  async importRequestsPayload(this: ImportExportHost, collectionName: string, buildRequests: (collectionId: string, collectionName: string) => SavedRequest[], collectionDefaults?: ImportedCollectionDefaults | (() => ImportedCollectionDefaults | undefined), destination = importDestination(this)) {
    requireImportDestination(this, destination);
    await this.persistActiveRequestNow();
    requireImportDestination(this, destination);
    const wsId = destination.workspaceId;
    const collection = makeCollection(wsId, collectionName);
    const builtRequests = buildRequests(collection.id, collectionName);
    const defaults = typeof collectionDefaults === 'function' ? collectionDefaults() : collectionDefaults;
    if (defaults?.variables?.length) {
      collection.defaults = { ...collection.defaults, variables: defaults.variables };
    }
    if (defaults?.auth) {
      collection.defaults = { ...collection.defaults, auth: defaults.auth };
    }
    const importCollections = [...this.collections, collection];
    const importedReqs = builtRequests
      .map(req => normalizeSavedRequest(req, importCollections, wsId));
    if (!importedReqs.length) throw new Error('No requests found in import file');
    collapseImportedCollection(this, collection, importedReqs);
    const nextCols = [...this.collections, collection]; const nextReqs = [...this.requests, ...importedReqs];
    const first = importedReqs[0]; const nextOpenIds = [...new Set([...this.openRequestIds, first.id])];
    this.activeWorkspaceId = wsId; this.collections = nextCols; this.requests = nextReqs; this.openRequestIds = nextOpenIds;
    this.applySavedRequest(first); this.topView = 'request';
    await confirmImportedRequests(this, destination, importedReqs, this.persistRequestStore(nextReqs, first.id, nextOpenIds, this.workspaces, nextCols, wsId));
    return { collectionId: collection.id, requestCount: importedReqs.length };
  },
  async importPostmanPayload(this: ImportExportHost, payload: unknown, fileName: string) {
    const fallbackName = fileName.replace(/\.postman_(collection|environment|globals)$/i, '').replace(/\.json$/i, '');
    const { postmanCollectionBundle, postmanVariableBundle } = await import('../../postman');
    const variables = postmanVariableBundle(payload, fallbackName || 'Postman Environment');
    if (variables) return this.importPostmanVariableBundle(variables);
    const wsId = this.activeWorkspaceId || this.workspaces[0]?.id; if (!wsId) throw new Error('No workspace available');
    const collectionId = makeCollection(wsId, fallbackName || 'Postman Collection').id;
    const bundle = postmanCollectionBundle(payload, collectionId, fallbackName || 'Postman Collection');
    return this.importCollectionBundle({ ...bundle, id: collectionId });
  },
  async importPostmanVariableBundle(this: ImportExportHost, bundle: { scope: 'environment' | 'globals'; name: string; values: KVRow[] }) {
    const destination = importDestination(this);
    requireImportDestination(this, destination);
    const filled = bundle.values.filter(row => row.key.trim());
    const plural = `${filled.length} variable${filled.length === 1 ? '' : 's'}`;
    if (bundle.scope === 'globals') {
      this.changeGlobalsEverywhere(rows => mergeGlobalRowsWithImportedRows(rows, filled));
      if (!await this.persistRequestStore()) throw new Error('Kurlo could not save the workspace.');
      this.collectionImportSummary = `Imported ${plural} into Globals`;
      return filled.length;
    }
    await this.persistActiveRequestNow();
    requireImportDestination(this, destination);
    const wsId = destination.workspaceId;
    const environment = normalizeEnvironment({ name: bundle.name, values: filled }, wsId);
    const nextEnvs = [...this.environments, environment];
    this.environments = nextEnvs;
    this.activeEnvironmentId = environment.id;
    if (!await this.persistRequestStore(this.requests, undefined, this.openRequestIds, this.workspaces, this.collections, wsId, this.requestHistory, nextEnvs, environment.id)) {
      throw new Error('Kurlo could not save the workspace.');
    }
    this.collectionImportSummary = `Imported environment ${environment.name} (${plural})`;
    return filled.length;
  },
  async importInsomniaPayload(this: ImportExportHost, payload: unknown, fileName: string) {
    const { insomniaCollectionName, insomniaRequestsFromResources } = await import('../../insomnia');
    const collectionName = insomniaCollectionName(payload, fileName);
    const { requestCount } = await this.importRequestsPayload(collectionName, (collectionId, name) => insomniaRequestsFromResources(payload, collectionId, name));
    return requestCount;
  },
  async importOpenApiPayload(this: ImportExportHost, payload: unknown, fileName: string, sourceUrl = '', destination = importDestination(this)) {
    const { openApiCollectionName, openApiImportFromSpec } = await import('../../openapi');
    const collectionName = openApiCollectionName(payload, fileName);
    let defaults: ImportedCollectionDefaults | undefined;
    return this.importRequestsPayload(
      collectionName,
      (collectionId, name) => {
        const imported = openApiImportFromSpec(payload, collectionId, name, sourceUrl);
        defaults = imported.defaults;
        return imported.requests;
      },
      () => defaults,
      destination,
    );
  },
  async importHttpFilePayload(this: ImportExportHost, text: string, fileName: string) {
    const { httpFileCollectionName, parseHttpFile } = await import('../../httpFile');
    const collectionName = httpFileCollectionName(fileName);
    const parsed = parseHttpFile(text, '', collectionName);
    const variables = parsed.variables.map(variable => ({ ...mkRow(), key: variable.key, value: variable.value, enabled: true }));
    const { requestCount } = await this.importRequestsPayload(
      collectionName,
      (collectionId, name) => parsed.requests.map(request => ({ ...request, collectionId, collection: name })),
      { variables },
    );
    return requestCount;
  },
  async exportCollection(this: ImportExportHost, collectionId: string) {
    this.closeFloatingMenus();
    const format = await this.openSelectDialog('Export collection', 'Choose the export format:', [
      { value: 'opencollection', label: 'OpenCollection YAML folder', icon: 'bruno', description: 'Export a Bruno v3-compatible folder with opencollection.yml and request .yml files.' },
      { value: 'postman', label: 'Postman collection v2.1', icon: 'postman', description: 'Export a single Postman collection JSON file.' },
      { value: 'postman-v3', label: 'Postman collection v3 (YAML folder)', icon: 'postman', description: 'Export a folder for Postman Local Files with native gRPC, GraphQL, and HTTP requests.' },
      { value: 'insomnia', label: 'Insomnia Export v4', icon: 'insomnia', description: 'Export an Insomnia workspace JSON file with Kurlo request metadata.' },
      { value: 'openapi3', label: 'OpenAPI 3.0 JSON', icon: 'openapi', description: 'Export HTTP requests as an OpenAPI document.' },
      { value: 'swagger2', label: 'Swagger 2.0 JSON', icon: 'openapi', description: 'Export HTTP requests as a Swagger 2.0 document.' },
    ], 'Export');
    if (!format) return;
    if (format === 'opencollection') return this.exportCollectionToOpenCollection(collectionId);
    if (format === 'postman') return this.exportCollectionToPostman(collectionId);
    if (format === 'postman-v3') return this.exportCollectionToPostmanV3(collectionId);
    if (format === 'insomnia') return this.exportCollectionToInsomnia(collectionId);
    return this.exportCollectionToOpenApi(collectionId, format as OpenApiExportFormat);
  },
  async exportCollectionToOpenCollection(this: ImportExportHost, collectionId: string) {
    await this.ensureCollectionExamples(collectionId);
    const col = this.collections.find(c => c.id === collectionId); if (!col) return;
    const reqs = this.requests.filter(r => r.collectionId === collectionId && !r.isDraft);
    const folderPaths = col.folderPaths ?? [];
    if (!reqs.length && !folderPaths.length) {
      await this.openAlertDialog('OpenCollection export skipped', 'This collection has no requests or folders to export.');
      return;
    }
    const includeSecrets = await this.chooseCollectionSecretExportMode(reqs, 'OpenCollection export');
    if (includeSecrets === null) return;
    const folderName = await this.openPromptDialog('OpenCollection folder', fileSegmentForExport(col.name), 'Kurlo will create this folder inside the parent directory you choose next.');
    if (!folderName) return;
    const parentDir = await openDirectoryDialog(`Choose parent folder for ${folderName}`, await this.defaultWorkspaceParentForDialogs());
    if (!parentDir) return;
    const targetRoot = `${parentDir.replace(/[\\/]$/, '')}/${safeFileName(folderName)}`;
    const envs = this.environments.filter(env => env.workspaceId === col.workspaceId);
    const { buildOpenCollectionFiles } = await import('../../opencollection');
    const files = buildOpenCollectionFiles(col.name, col.description ?? '', col.defaults, reqs, envs, (s, t) => this.stripBodyComments(s, t as BodyType), includeSecrets, folderPaths, col.folderDefaults ?? []);
    const error = await writeCollectionTextFiles(targetRoot, files);
    if (error) {
      this.collectionImportToast = 'OpenCollection export failed';
      setTimeout(() => (this.collectionImportToast = ''), 4200);
      await this.openAlertDialog('OpenCollection export failed', `${error}\n\nNo collection folder was written completely.`);
      return;
    }
    this.collectionImportToast = `Exported ${col.name} as OpenCollection`;
    setTimeout(() => (this.collectionImportToast = ''), 3000);
  },
  async exportCollectionToPostman(this: ImportExportHost, collectionId: string) {
    await this.ensureCollectionExamples(collectionId);
    const col = this.collections.find(c => c.id === collectionId); if (!col) return;
    const reqs = this.requests.filter(r => r.collectionId === collectionId && !r.isDraft);
    if (!reqs.length) {
      await this.openAlertDialog('Postman export skipped', 'This collection has no requests to export.');
      return;
    }
    const includeSecrets = await this.chooseCollectionSecretExportMode(reqs, 'Postman collection export');
    if (includeSecrets === null) return;
    const { buildPostmanCollection } = await import('../../postman');
    const payload = buildPostmanCollection(col.name, col.description ?? '', reqs, (s, t) => this.stripBodyComments(s, t as BodyType), includeSecrets, col.defaults, col.folderDefaults ?? []);
    this.closeFloatingMenus();
    const name = `${safeFileName(col.name)}.postman_collection.json`;
    const content = JSON.stringify(payload, null, 2);
    const successToast = `Exported ${col.name}`;
    try {
      if (!(await this.saveTextFile(name, content))) return;
      this.collectionImportToast = successToast;
    } catch { downloadTextFile(name, content); this.collectionImportToast = successToast; }
    finally { setTimeout(() => (this.collectionImportToast = ''), 2600); }
  },
  async exportCollectionToPostmanV3(this: ImportExportHost, collectionId: string) {
    const { buildPostmanV3Files, isPostmanV3Exportable, postmanV3FolderName } = await import('../../postmanV3Export');
    const col = this.collections.find(c => c.id === collectionId);
    if (!col) return;
    const reqs = this.requests.filter(req => req.collectionId === collectionId && !req.isDraft);
    const supported = reqs.filter(isPostmanV3Exportable);
    if (!supported.length) {
      await this.openAlertDialog('Postman v3 export skipped', 'This collection has no saved HTTP, SSE, GraphQL, or gRPC requests.');
      return;
    }
    const skipped = reqs.length - supported.length;
    if (skipped) {
      const choice = await this.openSelectDialog('Postman v3 export', `${skipped} request(s) use protocols this export does not support.`, [
        { value: 'supported', label: 'Export supported requests' },
      ], 'Continue', 'Cancel');
      if (!choice) return;
    }
    const scopes = [col.defaults, ...(col.folderDefaults ?? [])];
    const secretCandidates = [
      ...supported.map(req => ({
        ...req,
        headers: [...req.headers, ...(req.grpcMetadata ?? []), ...(req.pathParams ?? []), ...(req.vars ?? [])],
        examples: [],
      })),
      ...scopes.map(scope => ({
        ...supported[0], url: '', auth: scope.auth, params: [], formRows: [], examples: [], bodyContent: '',
        headers: [...scope.headers, ...('variables' in scope ? scope.variables : [])],
      })),
    ];
    const includeSecrets = await this.chooseCollectionSecretExportMode(secretCandidates, 'Postman v3 export');
    if (includeSecrets === null) return;
    const name = await this.openPromptDialog('Postman v3 folder', `${postmanV3FolderName(col.name)}-postman-v3`, 'Kurlo will create a new folder inside the parent directory you choose next.');
    if (!name?.trim()) return;
    const folderName = postmanV3FolderName(name);
    const parent = await openDirectoryDialog(`Choose parent folder for ${folderName}`, await this.defaultWorkspaceParentForDialogs());
    if (!parent) return;
    try {
      const files = buildPostmanV3Files(col, supported, (body, type) => this.stripBodyComments(body, type as BodyType), includeSecrets);
      const error = await writeNewCollectionTextFiles(parent, folderName, files);
      if (error) throw new Error(error);
      await this.openAlertDialog('Postman v3 folder exported', `In Postman, go to Workspaces → Local Files → Open Folder and select "${folderName}".`);
    } catch (error) {
      await this.openAlertDialog('Postman v3 export failed', error instanceof Error ? error.message : String(error));
    }
  },
  async exportCollectionToInsomnia(this: ImportExportHost, collectionId: string) {
    await this.ensureCollectionExamples(collectionId);
    const col = this.collections.find(c => c.id === collectionId); if (!col) return;
    const reqs = this.requests.filter(r => r.collectionId === collectionId && !r.isDraft);
    if (!reqs.length) {
      await this.openAlertDialog('Insomnia export skipped', 'This collection has no requests to export.');
      return;
    }
    const includeSecrets = await this.chooseCollectionSecretExportMode(reqs, 'Insomnia export');
    if (includeSecrets === null) return;
    const { buildInsomniaExport } = await import('../../insomnia');
    const payload = buildInsomniaExport(col.name, col.description ?? '', reqs, (s, t) => this.stripBodyComments(s, t as BodyType), includeSecrets);
    this.closeFloatingMenus();
    const name = `${safeFileName(col.name)}.insomnia.json`;
    const content = JSON.stringify(payload, null, 2);
    try {
      if (!(await this.saveTextFile(name, content))) return;
      this.collectionImportToast = `Exported ${col.name}`;
    } catch { downloadTextFile(name, content); this.collectionImportToast = `Exported ${col.name}`; }
    finally { setTimeout(() => (this.collectionImportToast = ''), 2600); }
  },
  async exportCollectionToOpenApi(this: ImportExportHost, collectionId: string, format: OpenApiExportFormat) {
    await this.ensureCollectionExamples(collectionId);
    const col = this.collections.find(c => c.id === collectionId); if (!col) return;
    const reqs = this.requests.filter(r => r.collectionId === collectionId && !r.isDraft);
    this.closeFloatingMenus();
    const label = format === 'swagger2' ? 'Swagger 2.0' : 'OpenAPI 3.0';
    const exportableReqs = reqs.filter(req => !this.savedRequestIsRealtime(req) && !this.savedRequestIsGraphQL(req) && !['grpc', 'mcp', 'ai'].includes(req.requestType ?? 'http'));
    const skippedUnsupported = reqs.length - exportableReqs.length;
    if (!exportableReqs.length) {
      await this.openAlertDialog(`${label} export skipped`, `${label} export only supports HTTP and SSE requests. GraphQL, gRPC, MCP, AI and realtime requests are not written to the spec.`);
      return;
    }
    const includeSecrets = await this.chooseCollectionSecretExportMode(exportableReqs, `${label} export`);
    if (includeSecrets === null) return;
    const name = `${safeFileName(col.name)}.${format === 'swagger2' ? 'swagger' : 'openapi'}.json`;
    let content: string;
    try {
      const { buildOpenApiExport } = await import('../../openapi');
      const payload = buildOpenApiExport(format, col.name, col.description ?? '', exportableReqs, (s, t) => this.stripBodyComments(s, t as BodyType), includeSecrets);
      content = JSON.stringify(payload, null, 2);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.collectionImportToast = `${label} export failed`;
      setTimeout(() => (this.collectionImportToast = ''), 4200);
      await this.openAlertDialog(`${label} export failed`, `${detail}\n\nNo file was written.`);
      return;
    }
    try {
      if (!(await this.saveTextFile(name, content))) return;
      this.collectionImportToast = skippedUnsupported
        ? `Exported ${col.name} as ${label}. Skipped ${skippedUnsupported} unsupported request${skippedUnsupported === 1 ? '' : 's'}`
        : `Exported ${col.name} as ${label}`;
    } catch {
      downloadTextFile(name, content);
      this.collectionImportToast = skippedUnsupported
        ? `Exported ${col.name} as ${label}. Skipped ${skippedUnsupported} unsupported request${skippedUnsupported === 1 ? '' : 's'}`
        : `Exported ${col.name} as ${label}`;
    }
    finally { setTimeout(() => (this.collectionImportToast = ''), 2600); }
  },
  async chooseCollectionSecretExportMode(this: ImportExportHost, reqs: SavedRequest[], title: string): Promise<boolean | null> {
    if (!requestsHaveExportSecrets(reqs)) return false;
    const selected = await this.openSelectDialog(title, 'This collection contains values that look like secrets. Choose how to export it:', [
      { value: 'safe', label: 'Export without secret values' },
      { value: 'include', label: 'Include secret values' },
    ], 'Export', 'Cancel');
    if (!selected) return null;
    return selected === 'include';
  },
  async exportEnvironmentToPostman(this: ImportExportHost, environmentId: string) {
    const own = this.environments.find(e => e.id === environmentId); if (!own) return;
    const env = flattenedEnvironment(this.environments, own);
    const hasSecretValues = env.values.some(row => row.secret && row.value);
    let includeSecrets = false;
    if (hasSecretValues) {
      const selected = await this.openSelectDialog('Export environment', 'This environment contains secret values. Choose how to export it:', [
        { value: 'safe', label: 'Export without secret values' },
        { value: 'include', label: 'Include secret values' },
      ], 'Export', 'Cancel');
      if (!selected) return;
      includeSecrets = selected === 'include';
    }
    const { buildPostmanEnvironment } = await import('../../postman');
    const payload = buildPostmanEnvironment(env, includeSecrets);
    this.closeFloatingMenus();
    const name = `${safeFileName(env.name)}.postman_environment.json`;
    const content = JSON.stringify(payload, null, 2);
    try {
      if (!(await this.saveTextFile(name, content))) return;
      this.collectionImportToast = `Exported ${env.name}`;
    } catch { downloadTextFile(name, content); this.collectionImportToast = `Exported ${env.name}`; }
    finally { setTimeout(() => (this.collectionImportToast = ''), 2600); }
  },
};
