import { openDirectoryDialog, readCollectionTextFiles, sendHttpRequest, writeCollectionTextFiles } from '../../backend';
import { emptyAuthConfig, emptyHttpRequest } from '../../wire';
import type { BodyType, Collection, CollectionDefaults, Environment, KVRow, RequestHistoryEntry, SavedRequest, ScriptEngine, Workspace } from '../../types/models';
import { mergeGlobalRowsWithImportedRows } from './globals';
import { mkRow } from '../../constants';
import type { TopView } from '../ui';
import { filesystemNameFromName, makeCollection, normalizeCollection, normalizeEnvironment, normalizeSavedRequest } from '../../normalizers';
import { normalizeCollectionDefaults } from '../../collectionDefaults';
import { routeImportedScripts, withActiveScripts } from '../../scriptEngine';
import { downloadTextFile, safeFileName } from '../../utils';
import { requestsHaveExportSecrets } from '../../secretExport';
import type { OpenApiExportFormat } from '../../openapi';

type ImportedCollectionDefaults = { variables?: KVRow[]; auth?: import('../../types/models').AuthState };

type ImportSource = 'bruno' | 'postman' | 'insomnia' | 'openapi' | 'har' | 'httpfile';

type DialogOptionInput = { value: string; label: string; icon?: string; description?: string };

export function normalizeSpecUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed.replace(/^\/+/, '')}`;
}

function headerValue(headers: Array<{ key: string; value: string }> | undefined, name: string): string {
  return headers?.find(header => header.key.toLowerCase() === name.toLowerCase())?.value ?? '';
}

async function fetchImportDocument(url: string): Promise<{ body: string; contentType: string }> {
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
    enableSSLVerification: true,
    encodeUrlAutomatically: true,
    disableCookieJar: true,
  });
  if (response.error && !response.statusCode) throw new Error(response.error);
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
  requests: SavedRequest[];
  environments?: Environment[];
};

function fileSegmentForExport(name: string) {
  return safeFileName(name).replace(/\s+/g, '-') || 'collection';
}

type ImportExportHost = {
  collectionImportSource: ImportSource;
  collectionImportToast: string;
  collectionImportSummary: string;
  collections: Collection[];
  requests: SavedRequest[];
  environments: Environment[];
  workspaces: Workspace[];
  activeWorkspaceId: string;
  activeEnvironmentId: string;
  openRequestIds: string[];
  requestHistory: RequestHistoryEntry[];
  topView: TopView;
  scriptEngine: ScriptEngine;
  _postmanImportInput: HTMLInputElement | undefined;
  guardWorkspaceWritable: (action?: string) => boolean;
  closeFloatingMenus: () => void;
  openSelectDialog: (title: string, message: string, options: DialogOptionInput[], confirmLabel?: string, cancelLabel?: string) => Promise<string>;
  openAlertDialog: (title: string, message: string) => Promise<void>;
  openPromptDialog: (title: string, initialValue?: string, message?: string, placeholder?: string, confirmLabel?: string) => Promise<string>;
  persistActiveRequestNow: (forceDisk?: boolean) => Promise<void>;
  persistRequestStore: (nextRequests?: SavedRequest[], activeId?: string, nextOpenIds?: string[], nextWorkspaces?: Workspace[], nextCollections?: Collection[], workspaceId?: string, nextHistory?: RequestHistoryEntry[], nextEnvironments?: Environment[], nextActiveEnvId?: string) => Promise<boolean>;
  applySavedRequest: (req: SavedRequest) => void;
  savedRequestIsRealtime: (req: SavedRequest) => boolean;
  savedRequestIsGraphQL: (req: SavedRequest) => boolean;
  stripBodyComments: (source: string, type: BodyType) => string;
  defaultWorkspaceParentForDialogs: () => Promise<string>;
  saveTextFile: (name: string, content: string) => Promise<boolean>;
  isRecord: (value: unknown) => value is Record<string, unknown>;
  importBrunoOpenCollectionFolder: () => Promise<void>;
  importCollectionPayload: (text: string, fileName: string, source: ImportSource) => Promise<number>;
  importOpenCollectionFiles: (files: Array<{ path: string; content: string }>, fallbackName: string) => Promise<number>;
  importHarPayload: (payload: unknown, fileName: string) => Promise<number>;
  importRequestsPayload: (collectionName: string, buildRequests: (collectionId: string, collectionName: string) => SavedRequest[], collectionDefaults?: ImportedCollectionDefaults | (() => ImportedCollectionDefaults | undefined)) => Promise<number>;
  importCollectionBundle: (bundle: ImportedCollectionBundle) => Promise<number>;
  importPostmanVariableBundle: (bundle: { scope: 'environment' | 'globals'; name: string; values: KVRow[] }) => Promise<number>;
  globalVariables: KVRow[];
  importHttpFilePayload: (text: string, fileName: string) => Promise<number>;
  importPostmanPayload: (payload: unknown, fileName: string) => Promise<number>;
  importInsomniaPayload: (payload: unknown, fileName: string) => Promise<number>;
  importOpenApiPayload: (payload: unknown, fileName: string) => Promise<number>;
  importOpenApiFromUrl: (specUrl: string) => Promise<number>;
  openOpenApiUrlImport: () => Promise<void>;
  exportCollectionToOpenCollection: (collectionId: string) => Promise<void>;
  exportCollectionToPostman: (collectionId: string) => Promise<void>;
  exportCollectionToInsomnia: (collectionId: string) => Promise<void>;
  exportCollectionToOpenApi: (collectionId: string, format: OpenApiExportFormat) => Promise<void>;
  chooseCollectionSecretExportMode: (reqs: SavedRequest[], title: string) => Promise<boolean | null>;
};

export const importExportFeature = {
  async openPostmanImport(this: ImportExportHost) {
    if (!this.guardWorkspaceWritable('Importing')) return;
    this.closeFloatingMenus();
    const source = await this.openSelectDialog('Import collection', 'Choose the source format to import:', [
      { value: 'bruno', label: 'Bruno / OpenCollection', icon: 'bruno', description: 'Import a Bruno collection folder with opencollection.yml or legacy .bru files.' },
      { value: 'postman', label: 'Postman collection', icon: 'postman', description: 'Import a Postman v2.1 collection, environment, or globals JSON file.' },
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
    this.collectionImportSource = source as ImportSource;
    if (this.collectionImportSource === 'bruno') {
      await this.importBrunoOpenCollectionFolder();
      return;
    }
    this._postmanImportInput?.click();
  },
  async openOpenApiUrlImport(this: ImportExportHost) {
    if (!this.guardWorkspaceWritable('Importing')) return;
    const entered = await this.openPromptDialog(
      'Import from URL',
      '',
      'Paste a link to an OpenAPI 3.x or Swagger 2.0 document. Kurlo fetches it and builds a collection from the paths it declares.',
      'https://api.example.com/openapi.json',
      'Import',
    );
    if (!entered?.trim()) return;
    this.collectionImportToast = 'Fetching spec…';
    try {
      const count = await this.importOpenApiFromUrl(entered);
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
  async importOpenApiFromUrl(this: ImportExportHost, specUrl: string) {
    if (!this.guardWorkspaceWritable('Importing')) return 0;
    const url = normalizeSpecUrl(specUrl);
    if (!url) throw new Error('Enter a URL to import from.');
    const { parseOpenApiResponse, openApiNameFromUrl } = await import('../../openapi');
    const { body, contentType } = await fetchImportDocument(url);
    const spec = parseOpenApiResponse(body, contentType);
    return this.importOpenApiPayload(spec, openApiNameFromUrl(url));
  },
  async onPostmanImportFile(this: ImportExportHost, e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0]; input.value = ''; if (!file) return;
    try {
      const text = await file.text();
      this.collectionImportSummary = '';
      const count = await this.importCollectionPayload(text, file.name, this.collectionImportSource);
      this.collectionImportToast = this.collectionImportSummary
        || (count ? `Imported ${count} request${count === 1 ? '' : 's'}` : 'Imported empty collection');
      this.collectionImportSummary = '';
    } catch (err) {
      this.collectionImportToast = `Import failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally { setTimeout(() => (this.collectionImportToast = ''), 3200); }
  },
  async importCollectionPayload(this: ImportExportHost, text: string, fileName: string, source: ImportSource) {
    if (!this.guardWorkspaceWritable('Importing')) return 0;
    if (source === 'bruno') {
      return this.importOpenCollectionFiles([{ path: fileName, content: text }], fileName.replace(/\.(bru|ya?ml)$/i, '') || 'Bruno Collection');
    }
    if (source === 'httpfile') return this.importHttpFilePayload(text, fileName);
    if (source === 'postman') return this.importPostmanPayload(JSON.parse(text) as unknown, fileName);
    if (source === 'insomnia') return this.importInsomniaPayload(JSON.parse(text) as unknown, fileName);
    if (source === 'har') return this.importHarPayload(JSON.parse(text) as unknown, fileName);
    const { parseOpenApiDocument } = await import('../../openapi');
    const spec = parseOpenApiDocument(text);
    return this.importOpenApiPayload(spec, fileName);
  },
  async importBrunoOpenCollectionFolder(this: ImportExportHost) {
    if (!this.guardWorkspaceWritable('Importing')) return;
    const root = await openDirectoryDialog('Import Bruno / OpenCollection folder');
    if (!root) return;
    try {
      const result = await readCollectionTextFiles(root);
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
    if (!this.guardWorkspaceWritable('Importing')) return 0;
    const wsId = this.activeWorkspaceId || this.workspaces[0]?.id; if (!wsId) throw new Error('No workspace available');
    await this.persistActiveRequestNow();
    const collection = makeCollection(wsId, bundle.name);
    const collectionId = bundle.id || collection.id;
    const importedCollection = normalizeCollection({
      ...collection,
      id: collectionId,
      name: bundle.name,
      description: bundle.description,
      filesystemName: filesystemNameFromName(bundle.name, collectionId),
      folderPaths: bundle.folderPaths,
      defaults: routeImportedScripts(normalizeCollectionDefaults(bundle.defaults)),
    }, wsId);
    const importCollections = [...this.collections, importedCollection];
    const importedReqs = bundle.requests.map(req => routeImportedScripts(normalizeSavedRequest({ ...req, collectionId: importedCollection.id, collection: importedCollection.name }, importCollections, wsId)));
    const importedEnvs = (bundle.environments ?? []).map(env => normalizeEnvironment(env, wsId));
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
    await this.persistRequestStore(nextReqs, first?.id, nextOpenIds, this.workspaces, nextCols, wsId, this.requestHistory, nextEnvs, this.activeEnvironmentId);
    return importedReqs.length;
  },
  async importHarPayload(this: ImportExportHost, payload: unknown, fileName: string) {
    const { harCollectionName, harRequestsFromLog } = await import('../../har');
    const collectionName = harCollectionName(payload, fileName);
    return this.importRequestsPayload(collectionName, (collectionId, name) => harRequestsFromLog(payload, collectionId, name));
  },
  async importRequestsPayload(this: ImportExportHost, collectionName: string, buildRequests: (collectionId: string, collectionName: string) => SavedRequest[], collectionDefaults?: ImportedCollectionDefaults | (() => ImportedCollectionDefaults | undefined)) {
    if (!this.guardWorkspaceWritable('Importing')) return 0;
    const wsId = this.activeWorkspaceId || this.workspaces[0]?.id; if (!wsId) throw new Error('No workspace available');
    await this.persistActiveRequestNow();
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
      .map(req => routeImportedScripts(normalizeSavedRequest(req, importCollections, wsId)));
    if (!importedReqs.length) throw new Error('No requests found in import file');
    const nextCols = [...this.collections, collection]; const nextReqs = [...this.requests, ...importedReqs];
    const first = importedReqs[0]; const nextOpenIds = [...new Set([...this.openRequestIds, first.id])];
    this.activeWorkspaceId = wsId; this.collections = nextCols; this.requests = nextReqs; this.openRequestIds = nextOpenIds;
    this.applySavedRequest(first); this.topView = 'request';
    await this.persistRequestStore(nextReqs, first.id, nextOpenIds, this.workspaces, nextCols, wsId);
    return importedReqs.length;
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
    if (!this.guardWorkspaceWritable('Importing')) return 0;
    const filled = bundle.values.filter(row => row.key.trim());
    const plural = `${filled.length} variable${filled.length === 1 ? '' : 's'}`;
    if (bundle.scope === 'globals') {
      this.globalVariables = mergeGlobalRowsWithImportedRows(this.globalVariables, filled);
      await this.persistRequestStore();
      this.collectionImportSummary = `Imported ${plural} into Globals`;
      return filled.length;
    }
    const wsId = this.activeWorkspaceId || this.workspaces[0]?.id; if (!wsId) throw new Error('No workspace available');
    await this.persistActiveRequestNow();
    const environment = normalizeEnvironment({ name: bundle.name, values: filled }, wsId);
    const nextEnvs = [...this.environments, environment];
    this.environments = nextEnvs;
    this.activeEnvironmentId = environment.id;
    await this.persistRequestStore(this.requests, undefined, this.openRequestIds, this.workspaces, this.collections, wsId, this.requestHistory, nextEnvs, environment.id);
    this.collectionImportSummary = `Imported environment ${environment.name} (${plural})`;
    return filled.length;
  },
  async importInsomniaPayload(this: ImportExportHost, payload: unknown, fileName: string) {
    const { insomniaCollectionName, insomniaRequestsFromResources } = await import('../../insomnia');
    const collectionName = insomniaCollectionName(payload, fileName);
    return this.importRequestsPayload(collectionName, (collectionId, name) => insomniaRequestsFromResources(payload, collectionId, name));
  },
  async importOpenApiPayload(this: ImportExportHost, payload: unknown, fileName: string) {
    const { openApiCollectionName, openApiImportFromSpec } = await import('../../openapi');
    const collectionName = openApiCollectionName(payload, fileName);
    let defaults: ImportedCollectionDefaults | undefined;
    return this.importRequestsPayload(
      collectionName,
      (collectionId, name) => {
        const imported = openApiImportFromSpec(payload, collectionId, name);
        defaults = imported.defaults;
        return imported.requests;
      },
      () => defaults,
    );
  },
  async importHttpFilePayload(this: ImportExportHost, text: string, fileName: string) {
    const { httpFileCollectionName, parseHttpFile } = await import('../../httpFile');
    const collectionName = httpFileCollectionName(fileName);
    const parsed = parseHttpFile(text, '', collectionName);
    const variables = parsed.variables.map(variable => ({ ...mkRow(), key: variable.key, value: variable.value, enabled: true }));
    return this.importRequestsPayload(
      collectionName,
      (collectionId, name) => parsed.requests.map(request => ({ ...request, collectionId, collection: name })),
      { variables },
    );
  },
  async exportCollection(this: ImportExportHost, collectionId: string) {
    this.closeFloatingMenus();
    const format = await this.openSelectDialog('Export collection', 'Choose the export format:', [
      { value: 'opencollection', label: 'OpenCollection YAML folder', icon: 'bruno', description: 'Export a Bruno v3-compatible folder with opencollection.yml and request .yml files.' },
      { value: 'postman', label: 'Postman collection v2.1', icon: 'postman', description: 'Export a single Postman collection JSON file.' },
      { value: 'insomnia', label: 'Insomnia Export v4', icon: 'insomnia', description: 'Export an Insomnia workspace JSON file with Kurlo request metadata.' },
      { value: 'openapi3', label: 'OpenAPI 3.0 JSON', icon: 'openapi', description: 'Export HTTP requests as an OpenAPI document.' },
      { value: 'swagger2', label: 'Swagger 2.0 JSON', icon: 'openapi', description: 'Export HTTP requests as a Swagger 2.0 document.' },
    ], 'Export');
    if (!format) return;
    if (format === 'opencollection') return this.exportCollectionToOpenCollection(collectionId);
    if (format === 'postman') return this.exportCollectionToPostman(collectionId);
    if (format === 'insomnia') return this.exportCollectionToInsomnia(collectionId);
    return this.exportCollectionToOpenApi(collectionId, format as OpenApiExportFormat);
  },
  async exportCollectionToOpenCollection(this: ImportExportHost, collectionId: string) {
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
    const exportDefaults = withActiveScripts(col.defaults, 'js');
    const exportReqs = reqs.map(r => withActiveScripts(r, 'js'));
    const { buildOpenCollectionFiles } = await import('../../opencollection');
    const files = buildOpenCollectionFiles(col.name, col.description ?? '', exportDefaults, exportReqs, envs, (s, t) => this.stripBodyComments(s, t as BodyType), includeSecrets, folderPaths);
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
    const col = this.collections.find(c => c.id === collectionId); if (!col) return;
    const reqs = this.requests.filter(r => r.collectionId === collectionId && !r.isDraft);
    if (!reqs.length) {
      await this.openAlertDialog('Postman export skipped', 'This collection has no requests to export.');
      return;
    }
    const includeSecrets = await this.chooseCollectionSecretExportMode(reqs, 'Postman collection export');
    if (includeSecrets === null) return;
    const exportReqs = reqs.map(r => withActiveScripts(r, 'js'));
    const { buildPostmanCollection } = await import('../../postman');
    const payload = buildPostmanCollection(col.name, col.description ?? '', exportReqs, (s, t) => this.stripBodyComments(s, t as BodyType), includeSecrets, withActiveScripts(col.defaults, 'js'));
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
  async exportCollectionToInsomnia(this: ImportExportHost, collectionId: string) {
    const col = this.collections.find(c => c.id === collectionId); if (!col) return;
    const reqs = this.requests.filter(r => r.collectionId === collectionId && !r.isDraft);
    if (!reqs.length) {
      await this.openAlertDialog('Insomnia export skipped', 'This collection has no requests to export.');
      return;
    }
    const includeSecrets = await this.chooseCollectionSecretExportMode(reqs, 'Insomnia export');
    if (includeSecrets === null) return;
    const exportReqs = reqs.map(r => withActiveScripts(r, 'js'));
    const { buildInsomniaExport } = await import('../../insomnia');
    const payload = buildInsomniaExport(col.name, col.description ?? '', exportReqs, (s, t) => this.stripBodyComments(s, t as BodyType), includeSecrets);
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
    const env = this.environments.find(e => e.id === environmentId); if (!env) return;
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
