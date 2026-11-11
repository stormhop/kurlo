import { getGlobalVariables, setGlobalVariables } from '../../backend';
import type { KVRow } from '../../types/models';
import { rowHasContent } from '../../utils';
import { changedValues, globalsFingerprint, trackGlobalsEdit } from '../../manualWorkspaceEdits';

export type GlobalVariableChanges = { globalVariableUpdates?: Record<string, string>; globalVariablesRemoved?: string[] };

export function globalValuesAfterChanges(values: Record<string, string>, changes: GlobalVariableChanges) {
  const next = { ...values, ...changes.globalVariableUpdates };
  for (const key of changes.globalVariablesRemoved ?? []) delete next[key];
  return next;
}

type GlobalsHost = {
  globalVariables: KVRow[];
  globalsBaseline: KVRow[] | null;
  globalsSaveState: 'idle' | 'dirty' | 'saving' | 'saved';
  globalsPersistTimer: ReturnType<typeof setTimeout> | null;
  globalsSavedTimer: ReturnType<typeof setTimeout> | null;
  autosave: boolean;
  persistRequestStore: () => Promise<boolean>;
  guardWorkspaceWritable: (action?: string) => boolean;
  globalVariableRows: () => KVRow[];
  globalVariableValues: () => Record<string, string>;
  scheduleGlobalsPersist: (delay?: number) => void;
  editGlobals: (next: KVRow[]) => void;
  changeGlobalsEverywhere: (change: (rows: KVRow[]) => KVRow[]) => void;
};

const GLOBALS_ROW_LIMIT = 5000;

function nextRowId(rows: KVRow[]): number {
  return rows.reduce((max, row) => Math.max(max, row.id), 0) + 1;
}

function blankRow(rows: KVRow[]): KVRow {
  return { id: nextRowId(rows), enabled: true, key: '', value: '', description: '' };
}

export function withTrailingRow(rows: KVRow[]): KVRow[] {
  const trimmed = [...rows];
  while (trimmed.length > 1 && !rowHasContent(trimmed[trimmed.length - 1]) && !rowHasContent(trimmed[trimmed.length - 2])) {
    trimmed.pop();
  }
  if (!trimmed.length || rowHasContent(trimmed[trimmed.length - 1])) {
    trimmed.push(blankRow(trimmed));
  }
  return trimmed.slice(0, GLOBALS_ROW_LIMIT);
}

export function mergeGlobalRowsWithValues(rows: KVRow[], values: Record<string, string>): KVRow[] {
  const seen = new Set<string>();
  const merged = rows.map(row => {
    const key = row.key.trim();
    if (!key || !(key in values)) return row;
    seen.add(key);
    return row.value === values[key] ? row : { ...row, value: values[key] };
  });
  for (const [key, value] of Object.entries(values)) {
    if (!key || seen.has(key)) continue;
    if (merged.some(row => row.key.trim() === key)) continue;
    merged.push({ id: nextRowId(merged), enabled: true, key, value, description: '' });
  }
  return withTrailingRow(merged);
}

export function mergeGlobalRowsWithImportedRows(rows: KVRow[], imported: KVRow[]): KVRow[] {
  const merged = [...rows];
  for (const row of imported) {
    const key = row.key.trim();
    if (!key) continue;
    const index = merged.findIndex(existing => existing.key.trim() === key);
    const patch = {
      key,
      value: row.value,
      enabled: row.enabled,
      ...(row.description ? { description: row.description } : {}),
      ...(row.secret ? { secret: true } : {}),
    };
    if (index >= 0) merged[index] = { ...merged[index], ...patch };
    else merged.push({ id: nextRowId(merged), description: '', ...patch });
  }
  return withTrailingRow(merged);
}

export const globalsFeature = {
  openGlobals(this: GlobalsHost & { topView: string; closeFloatingMenus: () => void }) {
    this.closeFloatingMenus();
    this.topView = 'globals';
  },

  globalVariableRows(this: GlobalsHost): KVRow[] {
    return this.globalVariables.filter(row => row.enabled && row.key.trim() !== '');
  },

  globalVariableValues(this: GlobalsHost): Record<string, string> {
    const values: Record<string, string> = {};
    for (const row of this.globalVariableRows()) values[row.key.trim()] = row.value;
    return values;
  },

  globalVariableCount(this: GlobalsHost): number {
    return this.globalVariableRows().length;
  },

  updateGlobalVariableRow(this: GlobalsHost, index: number, patch: Partial<KVRow>) {
    if (!this.guardWorkspaceWritable('Global variables')) return;
    const rows = this.globalVariables.map((row, i) => (i === index ? { ...row, ...patch } : row));
    this.editGlobals(withTrailingRow(rows));
  },

  removeGlobalVariableRow(this: GlobalsHost, index: number) {
    if (!this.guardWorkspaceWritable('Global variables')) return;
    const rows = this.globalVariables.filter((_, i) => i !== index);
    this.editGlobals(withTrailingRow(rows));
  },

  clearGlobalVariables(this: GlobalsHost) {
    if (!this.guardWorkspaceWritable('Global variables')) return;
    this.editGlobals(withTrailingRow([]));
  },

  editGlobals(this: GlobalsHost, next: KVRow[]) {
    if (!this.autosave) this.globalsBaseline = trackGlobalsEdit(this.globalVariables, next, this.globalsBaseline);
    this.globalVariables = next;
    this.scheduleGlobalsPersist();
  },

  changeGlobalsEverywhere(this: GlobalsHost, change: (rows: KVRow[]) => KVRow[]) {
    this.globalVariables = change(this.globalVariables);
    if (!this.globalsBaseline) return;
    const baseline = change(this.globalsBaseline);
    this.globalsBaseline = globalsFingerprint(baseline) === globalsFingerprint(this.globalVariables) ? null : baseline;
  },

  hasUnsavedGlobalsChanges(this: GlobalsHost) {
    return this.globalsBaseline !== null;
  },

  globalsForStore(this: GlobalsHost) {
    return this.globalsBaseline ?? this.globalVariables;
  },

  discardGlobalsChanges(this: GlobalsHost) {
    if (!this.globalsBaseline) return;
    this.globalVariables = this.globalsBaseline;
    this.globalsBaseline = null;
    if (this.globalsSavedTimer) {
      clearTimeout(this.globalsSavedTimer);
      this.globalsSavedTimer = null;
    }
    this.globalsSaveState = 'idle';
    void setGlobalVariables(this.globalVariableValues());
  },

  scheduleGlobalsPersist(this: GlobalsHost, delay = 360) {
    if (!this.guardWorkspaceWritable('Global variables')) return;
    const clearTimers = () => {
      if (this.globalsPersistTimer) {
        clearTimeout(this.globalsPersistTimer);
        this.globalsPersistTimer = null;
      }
      if (this.globalsSavedTimer) {
        clearTimeout(this.globalsSavedTimer);
        this.globalsSavedTimer = null;
      }
    };
    if (!this.autosave) {
      clearTimers();
      this.globalsSaveState = this.globalsBaseline ? 'dirty' : 'idle';
      return;
    }
    this.globalsSaveState = 'saving';
    clearTimers();
    this.globalsPersistTimer = setTimeout(async () => {
      this.globalsPersistTimer = null;
      const ok = await this.persistRequestStore();
      this.globalsSaveState = ok ? 'saved' : 'dirty';
      if (ok) this.globalsSavedTimer = setTimeout(() => (this.globalsSaveState = 'idle'), 1800);
    }, delay);
  },

  async saveGlobals(this: GlobalsHost) {
    if (!this.guardWorkspaceWritable('Global variables')) return false;
    if (this.globalsPersistTimer) {
      clearTimeout(this.globalsPersistTimer);
      this.globalsPersistTimer = null;
    }
    if (this.globalsSavedTimer) {
      clearTimeout(this.globalsSavedTimer);
      this.globalsSavedTimer = null;
    }
    this.globalsSaveState = 'saving';
    const baseline = this.globalsBaseline;
    this.globalsBaseline = null;
    const ok = await this.persistRequestStore();
    if (!ok && !this.globalsBaseline) this.globalsBaseline = baseline;
    this.globalsSaveState = ok ? 'saved' : this.globalsBaseline ? 'dirty' : 'idle';
    if (ok) this.globalsSavedTimer = setTimeout(() => (this.globalsSaveState = 'idle'), 1800);
    return ok;
  },

  async syncBackendGlobals(this: GlobalsHost) {
    await setGlobalVariables(this.globalVariableValues());
  },

  async syncGlobalsFromBackend(this: GlobalsHost) {
    const values = await getGlobalVariables();
    const next = mergeGlobalRowsWithValues(this.globalVariables, values);
    if (JSON.stringify(next) === JSON.stringify(this.globalVariables)) return false;
    const updates = changedValues(this.globalVariableValues(), values);
    this.changeGlobalsEverywhere(rows => rows === this.globalVariables ? next : mergeGlobalRowsWithValues(rows, updates));
    await this.persistRequestStore();
    return true;
  },

  async applyGlobalVariableChangesFromResponse(this: GlobalsHost, changes: GlobalVariableChanges) {
    const updates = changes.globalVariableUpdates ?? {};
    const removed = new Set(changes.globalVariablesRemoved ?? []);
    if ((!Object.keys(updates).length && !removed.size) || !this.guardWorkspaceWritable('Global variables')) return false;
    const apply = (rows: KVRow[]) => mergeGlobalRowsWithValues(rows.filter(row => !removed.has(row.key.trim())), updates);
    const next = apply(this.globalVariables);
    if (JSON.stringify(next) === JSON.stringify(this.globalVariables)) return false;
    this.changeGlobalsEverywhere(apply);
    await this.persistRequestStore();
    return true;
  },
};
