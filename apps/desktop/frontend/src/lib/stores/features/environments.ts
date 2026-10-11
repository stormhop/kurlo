import { getEnvironment, setEnvironment } from '../../backend';
import { makeEnvironment } from '../../normalizers';
import { mkRow } from '../../constants';
import type { Environment, KVRow, Workspace } from '../../types/models';
import type { VariableSuggestion } from '../../variables';
import { variableTemplate } from '../../variables';
import { resolveDynamicVariable } from '../../dynamicVariables';
import { parseEnvFile } from '../../utils';
import {
  addMatrixKey,
  buildEnvironmentMatrix,
  matrixKeyProblem,
  removeMatrixKey,
  renameMatrixKey,
  secretFor,
  setMatrixSecret,
  setMatrixValue,
  unsetMatrixValue,
} from '../../environmentMatrix';

export type EnvironmentView = 'single' | 'matrix';
export const ENVIRONMENT_VIEW_KEY = 'kurlo.environmentView.v1';

export function readEnvironmentView(): EnvironmentView {
  try {
    return localStorage.getItem(ENVIRONMENT_VIEW_KEY) === 'single' ? 'single' : 'matrix';
  } catch {
    return 'matrix';
  }
}

const VARIABLE_RESOLUTION_DEPTH = 20;

type EnvironmentHost = {
  activeEnvironmentId: string;
  activeWorkspaceId: string;
  autosave: boolean;
  environmentMenuOpen: boolean;
  environmentToast: string;
  environmentToastTimer: ReturnType<typeof setTimeout> | null;
  environmentSaveState: 'idle' | 'dirty' | 'saving' | 'saved';
  environmentPersistTimer: ReturnType<typeof setTimeout> | null;
  environmentSavedTimer: ReturnType<typeof setTimeout> | null;
  environments: Environment[];
  environmentView: EnvironmentView;
  workspaces: Workspace[];
  sidebarView: 'collections' | 'environments' | 'history';
  topView: string;
  activeEnvironment: Environment | undefined;
  activeWorkspaceEnvironments: Environment[];
  openPromptDialog: (title: string, initialValue?: string, message?: string) => Promise<string | null>;
  openConfirmDialog: (title: string, message: string, confirmLabel?: string) => Promise<boolean>;
  guardWorkspaceWritable: (action?: string) => boolean;
  persistRequestStore: () => Promise<boolean>;
  syncActiveEnvironmentFromBackend: () => Promise<void>;
  syncBackendEnvironment: () => Promise<void>;
  environmentValuesFor: (environmentId: string) => Record<string, string>;
  activeEnvironmentValues: () => Record<string, string>;
  environmentVariableSuggestions: (environmentId?: string) => VariableSuggestion[];
  activeSecretEnvironmentKeys: () => string[];
  activeSecretEnvironmentValues: () => string[];
  redactedActiveEnvironmentValues: () => Record<string, string>;
  selectEnvironment: (environmentId: string) => Promise<void>;
  resolveTemplate: (value: string, values?: Record<string, string>) => string;
  environmentRowsWithTrailing: (rows: KVRow[]) => KVRow[];
  scheduleEnvironmentPersist: (delay?: number) => void;
  saveEnvironment: () => Promise<boolean>;
  mergeActiveEnvironmentValues: (values: Record<string, string>) => Promise<boolean>;
  updateWorkspaceEnvironments: (change: (environment: Environment) => KVRow[], onlyId?: string) => void;
};

export function mergeEnvironmentRowsWithValues(rows: KVRow[], values: Record<string, string>) {
  const remaining = new Map(Object.entries(values));
  const next: KVRow[] = [];
  const trailing = rows.at(-1);
  const trailingIsBlank = Boolean(trailing && !trailing.key && !trailing.value && !trailing.description && !trailing.isFile);
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    if (!row.enabled) {
      next.push(row);
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(values, key)) continue;
    next.push({ ...row, key, value: values[key], enabled: true });
    remaining.delete(key);
  }
  for (const [key, value] of remaining) {
    next.push({ ...mkRow(), key, value, enabled: true });
  }
  return [...next, trailingIsBlank ? trailing! : mkRow()];
}

export const environmentFeature = {
  environmentLabel(this: EnvironmentHost) {
    return this.activeEnvironment?.name ?? 'No environment';
  },
  environmentValuesFor(this: EnvironmentHost, environmentId: string) {
    const values: Record<string, string> = {};
    const environment = this.environments.find(candidate => candidate.id === environmentId && candidate.workspaceId === this.activeWorkspaceId);
    if (!environment) return values;
    for (const row of environment.values) {
      if (row.enabled && row.key.trim()) values[row.key.trim()] = row.value;
    }
    return values;
  },
  activeEnvironmentValues(this: EnvironmentHost) {
    return this.environmentValuesFor(this.activeEnvironmentId);
  },
  environmentVariableSuggestions(this: EnvironmentHost, environmentId = this.activeEnvironmentId): VariableSuggestion[] {
    const environment = this.environments.find(candidate => candidate.id === environmentId && candidate.workspaceId === this.activeWorkspaceId);
    if (!environment) return [];
    const seen = new Set<string>();
    return environment.values
      .filter(row => row.enabled && row.key.trim())
      .map(row => ({
        key: row.key.trim(),
        value: row.value,
        description: row.description,
        secret: row.secret ?? false,
      }))
      .filter(row => {
        if (seen.has(row.key)) return false;
        seen.add(row.key);
        return true;
      });
  },
  activeSecretEnvironmentKeys(this: EnvironmentHost) {
    return this.environmentVariableSuggestions()
      .filter(row => row.secret)
      .map(row => row.key);
  },
  activeSecretEnvironmentValues(this: EnvironmentHost) {
    return this.environmentVariableSuggestions()
      .filter(row => row.secret && row.value)
      .map(row => row.value);
  },
  redactedActiveEnvironmentValues(this: EnvironmentHost) {
    const values = this.activeEnvironmentValues();
    const redacted = { ...values };
    for (const key of this.activeSecretEnvironmentKeys()) {
      redacted[key] = variableTemplate(key);
    }
    return redacted;
  },
  resolveTemplate(this: EnvironmentHost, value: string, values = this.activeEnvironmentValues()) {
    if (!value || !value.includes('{{')) return value;
    const substitute = (input: string) => input.replace(/\{\{([^{}]*)\}\}/g, (match, raw: string) => {
      const key = raw.trim();
      if (!key) return match;
      if (Object.prototype.hasOwnProperty.call(values, key)) return values[key];
      return resolveDynamicVariable(key) ?? match;
    });
    let resolved = substitute(value);
    for (let depth = 1; depth < VARIABLE_RESOLUTION_DEPTH && resolved.includes('{{'); depth += 1) {
      const next = substitute(resolved);
      if (next === resolved) break;
      resolved = next;
    }
    return resolved;
  },
  resolveRows(this: EnvironmentHost, rows: KVRow[], values = this.activeEnvironmentValues()) {
    return rows.map(row => ({ ...row, key: this.resolveTemplate(row.key, values), value: this.resolveTemplate(row.value, values) }));
  },
  environmentHasValues(this: EnvironmentHost, environment: Environment) {
    return environment.values.some(row => row.enabled && row.key.trim());
  },
  environmentValueCount(this: EnvironmentHost, environment: Environment) {
    return environment.values.filter(row => row.enabled && row.key.trim()).length;
  },
  async selectEnvironment(this: EnvironmentHost, environmentId: string) {
    if (!this.guardWorkspaceWritable('Environment selection')) return;
    this.activeEnvironmentId = environmentId;
    this.environmentMenuOpen = false;
    await setEnvironment(this.environmentValuesFor(environmentId));
    await this.persistRequestStore();
  },
  async useEnvironment(this: EnvironmentHost, environmentId: string) {
    await this.selectEnvironment(environmentId);
    const name = this.environments.find(environment => environment.id === environmentId)?.name ?? 'No environment';
    const message = environmentId ? `Using ${name}` : 'No environment selected';
    if (this.environmentToastTimer) clearTimeout(this.environmentToastTimer);
    this.environmentToast = message;
    this.environmentToastTimer = setTimeout(() => {
      if (this.environmentToast === message) this.environmentToast = '';
      this.environmentToastTimer = null;
    }, 1800);
  },
  async createEnvironment(this: EnvironmentHost) {
    if (!this.guardWorkspaceWritable('Creating environments')) return;
    const workspaceId = this.activeWorkspaceId || this.workspaces[0]?.id;
    if (!workspaceId) return;
    const name = await this.openPromptDialog('New environment', `Environment ${this.activeWorkspaceEnvironments.length + 1}`, 'Create a set of variables reusable as {{name}} in requests.');
    if (!name) return;
    const environment = makeEnvironment(workspaceId, name);
    this.environments = [...this.environments, environment];
    this.activeEnvironmentId = environment.id;
    this.sidebarView = 'environments';
    this.topView = 'environment';
    await this.persistRequestStore();
  },
  async renameEnvironment(this: EnvironmentHost, environmentId: string) {
    if (!this.guardWorkspaceWritable('Renaming environments')) return;
    const environment = this.environments.find(candidate => candidate.id === environmentId);
    if (!environment) return;
    const name = await this.openPromptDialog('Rename environment', environment.name);
    if (!name) return;
    this.environments = this.environments.map(candidate => candidate.id === environmentId ? { ...candidate, name } : candidate);
    await this.persistRequestStore();
  },
  async deleteEnvironment(this: EnvironmentHost, environmentId: string) {
    if (!this.guardWorkspaceWritable('Deleting environments')) return;
    const environment = this.environments.find(candidate => candidate.id === environmentId);
    if (!environment) return;
    const confirmed = await this.openConfirmDialog('Delete environment', `Delete "${environment.name}" from this workspace?`);
    if (!confirmed) return;
    this.environments = this.environments.filter(candidate => candidate.id !== environmentId);
    if (this.activeEnvironmentId === environmentId) this.activeEnvironmentId = '';
    if (this.topView === 'environment') this.topView = 'overview';
    await this.persistRequestStore();
  },
  async openEnvironment(this: EnvironmentHost, environmentId: string) {
    if (!this.guardWorkspaceWritable('Environment editing')) return;
    this.activeEnvironmentId = environmentId;
    this.sidebarView = 'environments';
    this.topView = 'environment';
    await this.persistRequestStore();
  },
  environmentRowsWithTrailing(this: EnvironmentHost, rows: KVRow[]) {
    const next = rows.length ? rows : [mkRow()];
    const last = next.at(-1);
    return last && (last.key || last.value || last.description || last.isFile) ? [...next, mkRow()] : next;
  },
  scheduleEnvironmentPersist(this: EnvironmentHost, delay = 360) {
    if (!this.guardWorkspaceWritable('Environment changes')) return;
    if (!this.autosave) {
      if (this.environmentPersistTimer) {
        clearTimeout(this.environmentPersistTimer);
        this.environmentPersistTimer = null;
      }
      if (this.environmentSavedTimer) {
        clearTimeout(this.environmentSavedTimer);
        this.environmentSavedTimer = null;
      }
      this.environmentSaveState = 'dirty';
      return;
    }
    this.environmentSaveState = 'saving';
    if (this.environmentPersistTimer) clearTimeout(this.environmentPersistTimer);
    if (this.environmentSavedTimer) clearTimeout(this.environmentSavedTimer);
    this.environmentPersistTimer = setTimeout(async () => {
      this.environmentPersistTimer = null;
      const ok = await this.persistRequestStore();
      this.environmentSaveState = ok ? 'saved' : 'dirty';
      if (ok) this.environmentSavedTimer = setTimeout(() => (this.environmentSaveState = 'idle'), 1800);
    }, delay);
  },
  async saveEnvironment(this: EnvironmentHost) {
    if (!this.guardWorkspaceWritable('Saving environment')) return false;
    if (this.environmentPersistTimer) {
      clearTimeout(this.environmentPersistTimer);
      this.environmentPersistTimer = null;
    }
    if (this.environmentSavedTimer) {
      clearTimeout(this.environmentSavedTimer);
      this.environmentSavedTimer = null;
    }
    this.environmentSaveState = 'saving';
    const ok = await this.persistRequestStore();
    this.environmentSaveState = ok ? 'saved' : 'dirty';
    if (ok) this.environmentSavedTimer = setTimeout(() => (this.environmentSaveState = 'idle'), 1800);
    return ok;
  },
  updateEnvironmentRow(this: EnvironmentHost, environmentId: string, index: number, patch: Partial<KVRow>) {
    if (!this.guardWorkspaceWritable('Environment changes')) return;
    this.environments = this.environments.map(environment => {
      if (environment.id !== environmentId) return environment;
      const next = environment.values.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row);
      return { ...environment, values: this.environmentRowsWithTrailing(next) };
    });
    this.scheduleEnvironmentPersist();
  },
  setEnvironmentView(this: EnvironmentHost, view: EnvironmentView) {
    this.environmentView = view;
    try {
      localStorage.setItem(ENVIRONMENT_VIEW_KEY, view);
    } catch {}
  },
  updateWorkspaceEnvironments(this: EnvironmentHost, change: (environment: Environment) => KVRow[], onlyId = '') {
    if (!this.guardWorkspaceWritable('Environment changes')) return;
    this.environments = this.environments.map(environment => {
      if (environment.workspaceId !== this.activeWorkspaceId) return environment;
      if (onlyId && environment.id !== onlyId) return environment;
      const values = change(environment);
      return values === environment.values ? environment : { ...environment, values };
    });
    this.scheduleEnvironmentPersist();
  },
  setEnvironmentMatrixValue(this: EnvironmentHost, environmentId: string, key: string, value: string) {
    const secret = secretFor(this.activeWorkspaceEnvironments, key);
    this.updateWorkspaceEnvironments(environment => setMatrixValue(environment, key, value, secret), environmentId);
  },
  unsetEnvironmentMatrixValue(this: EnvironmentHost, environmentId: string, key: string) {
    this.updateWorkspaceEnvironments(environment => unsetMatrixValue(environment, key), environmentId);
  },
  setEnvironmentVariableSecret(this: EnvironmentHost, key: string, secret: boolean) {
    this.updateWorkspaceEnvironments(environment => setMatrixSecret(environment, key, secret));
  },
  renameEnvironmentVariable(this: EnvironmentHost, from: string, to: string): string {
    const next = to.trim();
    if (next === from) return '';
    const problem = matrixKeyProblem(buildEnvironmentMatrix(this.activeWorkspaceEnvironments).map(row => row.key), next, from);
    if (problem) return problem;
    this.updateWorkspaceEnvironments(environment => renameMatrixKey(environment, from, next));
    return '';
  },
  async addEnvironmentVariable(this: EnvironmentHost) {
    if (!this.guardWorkspaceWritable('Environment changes')) return;
    const existing = buildEnvironmentMatrix(this.activeWorkspaceEnvironments).map(row => row.key);
    let message = 'Added to every environment, empty. Fill in the value each one should use.';
    let draft = '';
    for (;;) {
      const name = await this.openPromptDialog('New variable', draft, message);
      if (name === null) return;
      const problem = matrixKeyProblem(existing, name);
      if (!problem) {
        this.updateWorkspaceEnvironments(environment => addMatrixKey(environment, name.trim()));
        return;
      }
      message = problem;
      draft = name;
    }
  },
  async removeEnvironmentVariable(this: EnvironmentHost, key: string) {
    if (!this.guardWorkspaceWritable('Environment changes')) return;
    const ok = await this.openConfirmDialog('Delete variable', `Remove ${key} from every environment in this workspace?`, 'Delete');
    if (!ok) return;
    this.updateWorkspaceEnvironments(environment => removeMatrixKey(environment, key));
  },
  removeEnvironmentRow(this: EnvironmentHost, environmentId: string, index: number) {
    if (!this.guardWorkspaceWritable('Environment changes')) return;
    this.environments = this.environments.map(environment => {
      if (environment.id !== environmentId) return environment;
      const next = environment.values.length <= 1 ? [mkRow()] : environment.values.filter((_, rowIndex) => rowIndex !== index);
      return { ...environment, values: this.environmentRowsWithTrailing(next) };
    });
    this.scheduleEnvironmentPersist();
  },
  async syncBackendEnvironment(this: EnvironmentHost) {
    await setEnvironment(this.activeEnvironmentValues());
  },
  async mergeActiveEnvironmentValues(this: EnvironmentHost, values: Record<string, string>) {
    if (!this.guardWorkspaceWritable('Environment sync')) return false;
    const environment = this.environments.find(candidate => candidate.id === this.activeEnvironmentId && candidate.workspaceId === this.activeWorkspaceId);
    if (!environment) return false;
    const nextValues = mergeEnvironmentRowsWithValues(environment.values, values);
    if (JSON.stringify(environment.values) === JSON.stringify(nextValues)) return false;
    this.environments = this.environments.map(candidate => candidate.id === environment.id ? { ...candidate, values: nextValues } : candidate);
    await this.persistRequestStore();
    return true;
  },
  async applyEnvironmentChangesFromResponse(this: EnvironmentHost, resp: { environmentUpdates?: Record<string, string>; environmentRemoved?: string[] }, environmentId: string) {
    if (environmentId === this.activeEnvironmentId) {
      await this.syncActiveEnvironmentFromBackend();
      return;
    }
    const updates = resp.environmentUpdates ?? {};
    const removed = new Set(resp.environmentRemoved ?? []);
    const environment = this.environments.find(candidate => candidate.id === environmentId);
    if (environment && (Object.keys(updates).length || removed.size) && this.guardWorkspaceWritable('Environment sync')) {
      const values: Record<string, string> = {};
      for (const row of environment.values) {
        const key = row.key.trim();
        if (key && row.enabled && !removed.has(key)) values[key] = row.value;
      }
      Object.assign(values, updates);
      const nextValues = mergeEnvironmentRowsWithValues(environment.values, values);
      this.environments = this.environments.map(candidate => candidate.id === environment.id ? { ...candidate, values: nextValues } : candidate);
      await this.persistRequestStore();
    }
    await this.syncBackendEnvironment();
  },
  async syncActiveEnvironmentFromBackend(this: EnvironmentHost) {
    await this.mergeActiveEnvironmentValues(await getEnvironment());
  },
  async importEnvFromFile(this: EnvironmentHost, environmentId: string) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.env,.txt,text/plain';
    await new Promise<void>(resolve => {
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) { resolve(); return; }
        const text = await file.text();
        const pairs = parseEnvFile(text);
        if (!pairs.length) { resolve(); return; }
        this.environments = this.environments.map(environment => {
          if (environment.id !== environmentId) return environment;
          const existing = new Map(environment.values.filter(r => r.key).map(r => [r.key, r]));
          for (const { key, value } of pairs) {
            if (existing.has(key)) {
              existing.set(key, { ...existing.get(key)!, value });
            } else {
              existing.set(key, { ...mkRow(), key, value });
            }
          }
          const merged = Array.from(existing.values());
          return { ...environment, values: this.environmentRowsWithTrailing(merged) };
        });
        this.scheduleEnvironmentPersist();
        resolve();
      };
      input.click();
    });
  },
};
