import {
  k6Info,
  lastLoadRun,
  loadRunLog,
  loadRunStatus,
  loadRunSummaryJSON,
  loadTestTargets,
  openFileDialog,
  openLoadRunReport,
  startLoadRun,
  stopLoadRun,
} from '../../backend';
import type { Collection, Environment } from '../../types/models';
import type { K6Info, LoadRunResult, LoadRunState, LoadTest } from '../../wire';
import type { LoadTestTab } from './loadTests';

const K6_PATH_STORAGE_KEY = 'kurlo.k6Path.v1';
const LOAD_RUN_LOG_LIMIT = 500;
const requestedLastRuns = new Set<string>();

export function isLoopbackHost(host: string): boolean {
  const clean = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return clean === 'localhost' || clean.endsWith('.localhost') || clean === '::1' || /^127(\.\d{1,3}){3}$/.test(clean);
}

type LoadRunHost = {
  activeLoadTestId: string;
  collections: Collection[];
  k6Path: string;
  k6Info: K6Info | null;
  k6MissingOpen: boolean;
  loadRun: LoadRunState;
  loadRunLogLines: string[];
  loadRunLogTestId: string;
  loadRunResults: Record<string, LoadRunResult>;
  loadTestTab: LoadTestTab;
  loadTestExportRequestId: string;
  openLoadTest: (collectionId: string, loadTestId: string) => Promise<void>;
  runLoadTest: (collectionId: string, test: LoadTest) => Promise<void>;
  guardWorkspaceWritable: (action?: string) => boolean;
  openAlertDialog: (title: string, message: string) => Promise<void>;
  openConfirmDialog: (title: string, message: string, confirmLabel?: string) => Promise<boolean>;
  openPromptDialog: (title: string, initialValue?: string, message?: string, placeholder?: string, confirmLabel?: string) => Promise<string | null>;
  saveTextFile: (name: string, content: string) => Promise<boolean>;
  loadTestEnvironment: (collection: Collection, test: LoadTest) => Environment | undefined;
  loadTestPayload: (collectionId: string, test: LoadTest) => string | null;
  checkK6: () => Promise<K6Info>;
  loadLastLoadRun: (loadTestId: string) => Promise<void>;
  confirmLoadTargets: (collection: Collection, test: LoadTest, payload: string) => Promise<boolean>;
};

export const loadRunFeature = {
  initLoadRunListeners(this: LoadRunHost) {
    try {
      this.k6Path = localStorage.getItem(K6_PATH_STORAGE_KEY) ?? '';
    } catch {
      this.k6Path = '';
    }
    void loadRunStatus().then(state => {
      this.loadRun = state;
      if (state.running) this.loadRunLogTestId = state.loadTestId;
    });
    let receivedLogs = false;
    let pending: string[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (!pending.length) return;
      this.loadRunLogLines = [...this.loadRunLogLines, ...pending].slice(-LOAD_RUN_LOG_LIMIT);
      pending = [];
    };
    const enqueue = (lines: string[]) => {
      receivedLogs = true;
      pending = [...pending, ...lines.slice(-LOAD_RUN_LOG_LIMIT).map(line => line.slice(0, 4096))].slice(-LOAD_RUN_LOG_LIMIT);
      if (timer === undefined) timer = setTimeout(flush, 100);
    };
    void loadRunLog().then(lines => {
      if (!receivedLogs) this.loadRunLogLines = lines.slice(-LOAD_RUN_LOG_LIMIT);
    });
    const runtime = window.runtime;
    if (!runtime?.EventsOn) return;
    runtime.EventsOn<LoadRunState>('load:progress', state => {
      if (state.running && state.loadTestId !== this.loadRunLogTestId) {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        pending = [];
        receivedLogs = true;
        this.loadRunLogLines = [];
        this.loadRunLogTestId = state.loadTestId;
      }
      this.loadRun = state;
    });
    runtime.EventsOn<string>('load:log', line => enqueue([line]));
    runtime.EventsOn<string[]>('load:logs', lines => enqueue(lines));
    runtime.EventsOn<LoadRunResult>('load:done', result => {
      flush();
      this.loadRunResults = { ...this.loadRunResults, [result.loadTestId]: result };
    });
  },

  async checkK6(this: LoadRunHost): Promise<K6Info> {
    const info = await k6Info(this.k6Path);
    this.k6Info = info;
    return info;
  },

  async chooseK6Binary(this: LoadRunHost) {
    const path = await openFileDialog('Choose the k6 program');
    if (!path) return;
    this.k6Path = path;
    try {
      localStorage.setItem(K6_PATH_STORAGE_KEY, path);
    } catch {
      return;
    }
    await this.checkK6();
  },

  async loadLastLoadRun(this: LoadRunHost, loadTestId: string) {
    if (!loadTestId || this.loadRunResults[loadTestId] || requestedLastRuns.has(loadTestId)) return;
    requestedLastRuns.add(loadTestId);
    const result = await lastLoadRun(loadTestId);
    if (result) this.loadRunResults = { ...this.loadRunResults, [loadTestId]: result };
  },

  async confirmLoadTargets(this: LoadRunHost, collection: Collection, test: LoadTest, payload: string): Promise<boolean> {
    const hosts = await loadTestTargets(payload);
    const remote = hosts.filter(host => !isLoopbackHost(host));
    const environment = this.loadTestEnvironment(collection, test);
    if (environment?.protected && remote.length) {
      const typed = await this.openPromptDialog(
        'Run against a protected environment',
        '',
        `${environment.name} is marked protected. This load test sends traffic to ${remote.join(', ')}. Type ${remote[0]} to run it.`,
        remote[0],
        'Run load test',
      );
      return typed?.trim().toLowerCase() === remote[0].toLowerCase();
    }
    if (!remote.length) return true;
    return this.openConfirmDialog(
      'Run load test',
      `This sends load to ${remote.join(', ')}. Only run it against systems you are allowed to put under load.`,
      'Run load test',
    );
  },

  async runLoadTest(this: LoadRunHost, collectionId: string, test: LoadTest) {
    if (!this.guardWorkspaceWritable('Running a load test')) return;
    if (this.loadRun.running) {
      await this.openAlertDialog('Load test', 'Another load test is running. Stop it first.');
      return;
    }
    const collection = this.collections.find(candidate => candidate.id === collectionId);
    const payload = this.loadTestPayload(collectionId, test);
    if (!collection || !payload) return;
    const info = await this.checkK6();
    if (!info.found) {
      this.k6MissingOpen = true;
      return;
    }
    this.k6MissingOpen = false;
    if (!await this.confirmLoadTargets(collection, test, payload)) return;
    this.loadRunLogLines = [];
    this.loadRunLogTestId = test.id;
    this.loadTestTab = 'results';
    const state = await startLoadRun(payload, this.k6Path);
    if (state.error) {
      await this.openAlertDialog('Load test did not start', state.error);
      return;
    }
    this.loadRun = state;
  },

  async runSavedLoadTest(this: LoadRunHost, collectionId: string, loadTestId: string) {
    const test = this.collections.find(candidate => candidate.id === collectionId)?.loadTests?.find(candidate => candidate.id === loadTestId);
    if (!test) return;
    await this.openLoadTest(collectionId, loadTestId);
    if (this.activeLoadTestId !== loadTestId) return;
    await this.runLoadTest(collectionId, test);
  },

  async exportSavedLoadTest(this: LoadRunHost, collectionId: string, loadTestId: string) {
    await this.openLoadTest(collectionId, loadTestId);
    if (this.activeLoadTestId !== loadTestId) return;
    this.loadTestExportRequestId = loadTestId;
  },

  async stopLoadTest(this: LoadRunHost) {
    if (!this.loadRun.running) return;
    this.loadRun = { ...(await stopLoadRun()), stopping: true };
  },

  async openLoadTestReport(this: LoadRunHost, loadTestId: string) {
    const message = await openLoadRunReport(loadTestId);
    if (message) await this.openAlertDialog('HTML report', message);
  },

  async saveLoadTestSummary(this: LoadRunHost, loadTestId: string, fileName: string) {
    const summary = await loadRunSummaryJSON(loadTestId);
    if (!summary) {
      await this.openAlertDialog('k6 summary', 'This run has no k6 summary.');
      return;
    }
    await this.saveTextFile(fileName, summary);
  },
};
