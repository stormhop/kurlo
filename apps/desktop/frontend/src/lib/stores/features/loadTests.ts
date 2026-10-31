import { exportLoadTestK6, openDirectoryDialog, openFileDialog, previewLoadTestData, saveLoadTestK6Folder, validateLoadTest } from '../../backend';
import { loadTestFingerprint, normalizeLoadTest } from '../../loadTests';
import { presetExecutor } from '../../loadPresets';
import { filesystemNameFromName } from '../../normalizers';
import type { Collection, Environment, KVRow, PersistRequestStore, SavedRequest, SidebarView } from '../../types/models';
import { newEntityId, requestTabLabel } from '../../utils';
import type { K6ExportResult, LoadDataPreview, LoadStep, LoadTest } from '../../wire';
import type { TopView } from '../ui';

export type LoadTestTab = 'flow' | 'load' | 'data' | 'results';

const LOAD_TEST_REQUEST_TYPES = new Set(['', 'http', 'graphql']);

type LoadTestHost = {
  activeLoadTestId: string;
  activeLoadTestCollectionId: string;
  activeEnvironmentId: string;
  activeRequestId: string;
  activeWorkspaceId: string;
  collections: Collection[];
  environments: Environment[];
  globalVariables: KVRow[];
  loadTestSaveState: 'idle' | 'saving' | 'saved';
  loadTestSavedTimer: ReturnType<typeof setTimeout> | null;
  loadTestTab: LoadTestTab;
  requests: SavedRequest[];
  requestForEditing: (id: string) => SavedRequest | undefined;
  sidebarView: SidebarView;
  topView: TopView;
  closeFloatingMenus: () => void;
  guardWorkspaceWritable: (action?: string) => boolean;
  openAlertDialog: (title: string, message: string) => Promise<void>;
  openConfirmDialog: (title: string, message: string, confirmLabel?: string) => Promise<boolean>;
  openLoadTest: (collectionId: string, loadTestId: string) => Promise<void>;
  persistActiveRequestNow: (forceDisk?: boolean) => Promise<void>;
  persistRequestStore: PersistRequestStore;
  updateCollectionLoadTests: (collectionId: string, update: (tests: LoadTest[]) => LoadTest[]) => Promise<boolean>;
};

export function uniqueLoadTestName(base: string, existing: LoadTest[]): string {
  const names = new Set(existing.map(test => test.name.trim().toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base} ${n}`;
    if (!names.has(candidate.toLowerCase())) return candidate;
  }
}

export function loadTestStep(requestId: string, once = false): LoadStep {
  return { id: newEntityId('step'), requestId, ...(once ? { once: true } : {}) };
}

export function newLoadTest(name: string, requestIds: string[] = []): LoadTest {
  return {
    id: newEntityId('loadtest'),
    name,
    filesystemName: filesystemNameFromName(name, 'load-test'),
    scenarios: [{
      id: newEntityId('scenario'),
      name: 'Flow',
      executor: presetExecutor('smoke', 'vus'),
      steps: requestIds.map(requestId => loadTestStep(requestId)),
    }],
    thresholds: [
      { metric: 'http_req_duration', stat: 'p(95)', op: '<', value: 500 },
      { metric: 'http_req_failed', stat: 'rate', op: '<', value: 0.01 },
    ],
    settings: {},
  };
}

export const loadTestFeature = {
  loadTestRequestOptions(this: LoadTestHost, collectionId: string): SavedRequest[] {
    return this.requests.map(request => this.requestForEditing(request.id) ?? request).filter(request =>
      !request.isDraft && !request.isInvalid && request.collectionId === collectionId && LOAD_TEST_REQUEST_TYPES.has(request.requestType ?? ''));
  },

  loadTestRequestLabel(this: LoadTestHost, requestId: string): string {
    const request = this.requestForEditing(requestId);
    return request ? requestTabLabel(request) : '';
  },

  activeLoadTest(this: LoadTestHost): { collection: Collection; loadTest: LoadTest } | null {
    const collection = this.collections.find(candidate => candidate.id === this.activeLoadTestCollectionId);
    const loadTest = collection?.loadTests?.find(candidate => candidate.id === this.activeLoadTestId);
    return collection && loadTest ? { collection, loadTest } : null;
  },

  async validateLoadTestDraft(this: LoadTestHost, collectionId: string, test: LoadTest): Promise<string[]> {
    const targets = this.requests
      .filter(request => !request.isDraft && !request.isInvalid && request.collectionId === collectionId)
      .map(request => ({ id: request.id, requestType: request.requestType ?? '' }));
    return validateLoadTest(normalizeLoadTest(JSON.parse(JSON.stringify(test))), targets);
  },

  loadTestEnvironment(this: LoadTestHost, collection: Collection, test: LoadTest): Environment | undefined {
    const environments = this.environments.filter(environment => environment.workspaceId === collection.workspaceId);
    const name = test.settings.environment;
    if (name) return environments.find(environment => environment.name === name);
    return environments.find(environment => environment.id === this.activeEnvironmentId);
  },

  loadTestPayload(this: LoadTestHost & { loadTestEnvironment: (collection: Collection, test: LoadTest) => Environment | undefined }, collectionId: string, test: LoadTest): string | null {
    const collection = this.collections.find(candidate => candidate.id === collectionId);
    if (!collection) return null;
    const requestIds = new Set((test.scenarios[0]?.steps ?? []).map(step => step.requestId));
    const environment = this.loadTestEnvironment(collection, test);
    const { loadTests: _loadTests, ...collectionWithoutTests } = collection;
    return JSON.stringify({
      loadTest: test,
      collection: collectionWithoutTests,
      requests: this.requests.map(request => this.requestForEditing(request.id) ?? request).filter(request => requestIds.has(request.id) && request.collectionId === collectionId),
      environment: environment ? { name: environment.name, values: environment.values } : null,
      globals: this.globalVariables,
    });
  },

  async exportLoadTestK6(this: LoadTestHost & { loadTestPayload: (collectionId: string, test: LoadTest) => string | null }, collectionId: string, test: LoadTest, inlineSecrets: boolean, folder = false): Promise<K6ExportResult> {
    const payload = this.loadTestPayload(collectionId, test);
    if (!payload) return { script: '', fileName: '', warnings: [], steps: [], error: 'The collection of this load test is gone.' };
    return exportLoadTestK6(payload, inlineSecrets, folder);
  },

  async chooseLoadTestData(): Promise<LoadDataPreview | null> {
    const path = await openFileDialog('Choose CSV or JSON data inside the workspace folder');
    return path ? previewLoadTestData(path) : null;
  },

  async previewLoadTestData(path: string): Promise<LoadDataPreview> {
    return previewLoadTestData(path);
  },

  async saveLoadTestK6Folder(this: LoadTestHost & { loadTestPayload: (collectionId: string, test: LoadTest) => string | null }, collectionId: string, test: LoadTest, inlineSecrets: boolean): Promise<boolean> {
    const payload = this.loadTestPayload(collectionId, test);
    if (!payload) return false;
    const parent = await openDirectoryDialog('Choose a parent folder for the k6 export');
    if (!parent) return false;
    const error = await saveLoadTestK6Folder(payload, inlineSecrets, parent);
    if (error) await this.openAlertDialog('Could not export k6 folder', error);
    return !error;
  },

  async openLoadTest(this: LoadTestHost, collectionId: string, loadTestId: string) {
    const collection = this.collections.find(candidate => candidate.id === collectionId);
    if (!collection?.loadTests?.some(test => test.id === loadTestId)) return;
    this.closeFloatingMenus();
    await this.persistActiveRequestNow();
    if (this.activeLoadTestId !== loadTestId) this.loadTestTab = 'flow';
    this.activeWorkspaceId = collection.workspaceId;
    this.activeLoadTestCollectionId = collectionId;
    this.activeLoadTestId = loadTestId;
    this.sidebarView = 'collections';
    this.topView = 'loadtest';
  },

  closeLoadTestTab(this: LoadTestHost) {
    this.activeLoadTestId = '';
    this.activeLoadTestCollectionId = '';
    this.topView = this.activeRequestId ? 'request' : 'overview';
  },

  async updateCollectionLoadTests(this: LoadTestHost, collectionId: string, update: (tests: LoadTest[]) => LoadTest[]): Promise<boolean> {
    const collection = this.collections.find(candidate => candidate.id === collectionId);
    if (!collection || collection.isInvalid) return false;
    const loadTests = update(collection.loadTests ?? []);
    this.collections = this.collections.map(candidate => {
      if (candidate.id !== collectionId) return candidate;
      const next: Collection = { ...candidate, loadTests };
      if (!loadTests.length) delete next.loadTests;
      return next;
    });
    return this.persistRequestStore();
  },

  async createLoadTest(this: LoadTestHost, collectionId: string, requestIds: string[] = []) {
    if (!this.guardWorkspaceWritable('Creating a load test')) return;
    const collection = this.collections.find(candidate => candidate.id === collectionId);
    if (!collection || collection.isInvalid) return;
    const request = requestIds.length === 1 ? this.requestForEditing(requestIds[0]) : undefined;
    const base = request ? `${requestTabLabel(request)} load test` : 'New load test';
    const test = newLoadTest(uniqueLoadTestName(base, collection.loadTests ?? []), requestIds);
    if (!await this.updateCollectionLoadTests(collectionId, tests => [...tests, test])) return;
    await this.openLoadTest(collectionId, test.id);
  },

  async createLoadTestFromRequest(this: LoadTestHost & { createLoadTest: (collectionId: string, requestIds?: string[]) => Promise<void> }, requestId: string) {
    await this.persistActiveRequestNow();
    const request = this.requestForEditing(requestId);
    if (!request || request.isDraft || !request.collectionId) return;
    if (!LOAD_TEST_REQUEST_TYPES.has(request.requestType ?? '')) {
      await this.openAlertDialog('Load test', 'Load tests run HTTP and GraphQL requests only.');
      return;
    }
    await this.createLoadTest(request.collectionId, [request.id]);
  },

  async renameLoadTest(this: LoadTestHost & { openPromptDialog: (title: string, value: string) => Promise<string | null> }, collectionId: string, loadTestId: string, nextName?: string) {
    if (!this.guardWorkspaceWritable('Renaming a load test')) return;
    this.closeFloatingMenus();
    const test = this.collections.find(collection => collection.id === collectionId)?.loadTests?.find(candidate => candidate.id === loadTestId);
    if (!test) return;
    const name = (nextName ?? await this.openPromptDialog('Rename load test', test.name))?.trim();
    if (!name || name === test.name) return;
    await this.updateCollectionLoadTests(collectionId, tests => tests.map(candidate => candidate.id === loadTestId
      ? { ...candidate, name, filesystemName: filesystemNameFromName(name, 'load-test') } : candidate));
  },

  async duplicateLoadTest(this: LoadTestHost, collectionId: string, loadTestId: string) {
    if (!this.guardWorkspaceWritable('Duplicating a load test')) return;
    const collection = this.collections.find(candidate => candidate.id === collectionId);
    const source = collection?.loadTests?.find(test => test.id === loadTestId);
    if (!collection || !source) return;
    const name = uniqueLoadTestName(`${source.name} copy`, collection.loadTests ?? []);
    const copy: LoadTest = {
      ...normalizeLoadTest(JSON.parse(JSON.stringify(source))),
      id: newEntityId('loadtest'),
      name,
      filesystemName: filesystemNameFromName(name, 'load-test'),
    };
    if (!await this.updateCollectionLoadTests(collectionId, tests => {
      const index = tests.findIndex(test => test.id === loadTestId);
      return [...tests.slice(0, index + 1), copy, ...tests.slice(index + 1)];
    })) return;
    await this.openLoadTest(collectionId, copy.id);
  },

  async deleteLoadTest(this: LoadTestHost, collectionId: string, loadTestId: string) {
    if (!this.guardWorkspaceWritable('Deleting a load test')) return;
    this.closeFloatingMenus();
    const test = this.collections.find(candidate => candidate.id === collectionId)?.loadTests?.find(candidate => candidate.id === loadTestId);
    if (!test) return;
    if (!await this.openConfirmDialog('Delete load test', `Delete "${test.name}"? Its file is removed from the workspace.`, 'Delete')) return;
    if (!await this.updateCollectionLoadTests(collectionId, tests => tests.filter(candidate => candidate.id !== loadTestId))) return;
    if (this.activeLoadTestId === loadTestId) {
      this.activeLoadTestId = '';
      this.activeLoadTestCollectionId = '';
      if (this.topView === 'loadtest') this.topView = this.activeRequestId ? 'request' : 'overview';
    }
  },

  async saveLoadTest(this: LoadTestHost, collectionId: string, draft: LoadTest, baseFingerprint?: string): Promise<boolean> {
    if (!this.guardWorkspaceWritable('Saving a load test')) return false;
    const collection = this.collections.find(candidate => candidate.id === collectionId);
    const current = collection?.loadTests?.find(test => test.id === draft.id);
    if (!collection || !current) return false;
    if (baseFingerprint && loadTestFingerprint(current) !== baseFingerprint) {
      await this.openAlertDialog(
        'Load test changed',
        'This load test was updated outside the open editor. Reload it before saving so the newer changes are not overwritten.',
      );
      return false;
    }
    const name = draft.name.trim() || current.name;
    const next = normalizeLoadTest(JSON.parse(JSON.stringify({ ...draft, name, filesystemName: filesystemNameFromName(name, 'load-test') })));
    this.loadTestSaveState = 'saving';
    if (this.loadTestSavedTimer) {
      clearTimeout(this.loadTestSavedTimer);
      this.loadTestSavedTimer = null;
    }
    const ok = await this.updateCollectionLoadTests(collectionId, tests => tests.map(test => test.id === draft.id ? next : test));
    this.loadTestSaveState = ok ? 'saved' : 'idle';
    if (ok) {
      this.loadTestSavedTimer = setTimeout(() => {
        this.loadTestSaveState = 'idle';
        this.loadTestSavedTimer = null;
      }, 1800);
    }
    return ok;
  },
};
