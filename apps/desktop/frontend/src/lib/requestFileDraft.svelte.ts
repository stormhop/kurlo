import { normalizeRequestType } from './normalizers';
import { patchRequestFileBar, readRequestFileBar, type RequestFileBarChanges } from './requestFileBar';
import { AI_DEFAULT_PRESET } from './stores/features/ai';
import type { RequestType } from './types/models';

export type RequestFileResult = {
  ok: boolean;
  id?: string;
  path?: string;
  content?: string;
  revision?: string;
  error?: string;
  line?: number;
  conflict?: boolean;
};

export type RequestFileRead = () => Promise<RequestFileResult>;
export type RequestFileWrite = (content: string, baseRevision: string) => Promise<RequestFileResult>;

type FileBarIndex = ReturnType<typeof readRequestFileBar>;
type ValidFileBarIndex = Extract<FileBarIndex, { ok: true }>;
type ToolbarBaseline = { content: string; index: ValidFileBarIndex; changes: RequestFileBarChanges };
const largeFileSize = 256 * 1024;

export class RequestFileDraft {
  path = $state('');
  content = $state('');
  revision = $state('');
  ready = $state(false);
  documentGeneration = $state(0);
  savedContent = $state('');
  loading = $state(false);
  saving = $state(false);
  error = $state('');
  errorLine = $state<number | undefined>();
  conflict = $state(false);
  remoteContent = $state<string | undefined>();
  remoteRevision = $state<string | undefined>();
  #errorSource = $state<'load' | 'save' | 'validation' | ''>('');
  barIssue = $state('');
  private indexedBar = $state.raw<{ content: string; index: FileBarIndex }>();
  private largeFile = $derived(this.content.length >= largeFileSize);
  private bar = $derived(!this.ready ? undefined : this.largeFile ? this.indexedBar?.index : readRequestFileBar(this.content));

  #read: RequestFileRead;
  #write: RequestFileWrite;
  #onEdit: (() => void) | undefined;
  #readSequence = 0;
  #writeSequence = 0;
  #editSequence = 0;
  #manualEditSequence = 0;
  #savingJob: Promise<boolean> | null = null;
  #toolbarBaseline: ToolbarBaseline | undefined;

  get needsBarIndex() { return this.ready && this.largeFile && this.indexedBar?.content !== this.content; }

  acceptBarIndex(content: string, index: FileBarIndex) {
    if (content === this.content) this.indexedBar = { content, index };
  }

  releaseBarIndex() {
    this.indexedBar = undefined;
  }

  get barValues() { return this.bar?.ok ? this.bar.values : undefined; }

  private toolbarIndexFor(content: string) {
    return this.indexedBar?.content === content
      ? this.indexedBar.index : readRequestFileBar(content, { includeRanges: true });
  }

  currentBarValues() {
    if (this.needsBarIndex) this.acceptBarIndex(this.content, readRequestFileBar(this.content, { includeRanges: true }));
    return this.barValues;
  }

  get barType() {
    if (!this.bar?.ok || this.bar.fieldErrors.requestType) return undefined;
    return normalizeRequestType(this.bar.values);
  }

  barValue(key: string, saved: string, defaultValue = '') {
    if (!this.bar?.ok || this.bar.fieldErrors[key]) return saved;
    return this.bar.values[key] ?? defaultValue;
  }

  editBar(changes: RequestFileBarChanges) {
    if (!this.ready) return;
    const source = this.content;
    const existingBaseline = this.#toolbarBaseline;
    const baselineIndex = existingBaseline?.index ?? this.toolbarIndexFor(source);
    if (!baselineIndex.ok) {
      this.barIssue = baselineIndex.error;
      return;
    }
    for (const key of Object.keys(changes)) {
      if (baselineIndex.fieldErrors[key]) {
        this.barIssue = baselineIndex.fieldErrors[key];
        return;
      }
    }
    const baseline = existingBaseline ?? {
      content: source,
      index: baselineIndex,
      changes: {},
    };
    const nextTracked = { ...baseline.changes };
    for (const [key, value] of Object.entries(changes)) {
      const normalized = String(value);
      if (normalized === (baseline.index.values[key] ?? '')) delete nextTracked[key];
      else nextTracked[key] = value;
    }
    if (Object.keys(nextTracked).length === 0) {
      this.#toolbarBaseline = undefined;
      if (this.content !== baseline.content) {
        if (this.largeFile) this.indexedBar = { content: baseline.content, index: baseline.index };
        this.applyEdit(baseline.content);
      }
      return;
    }
    if (this.largeFile && this.editIndexedBar(changes, baseline, nextTracked)) {
      this.#toolbarBaseline = { ...baseline, changes: nextTracked };
      return;
    }
    const result = patchRequestFileBar(baseline.content, nextTracked);
    if (!result.ok) {
      this.barIssue = result.error;
      return;
    }
    this.barIssue = '';
    this.#toolbarBaseline = { ...baseline, changes: nextTracked };
    this.applyEdit(result.content);
    if (this.largeFile) this.acceptBarIndex(this.content, readRequestFileBar(this.content, { includeRanges: true }));
  }

  private editIndexedBar(changes: RequestFileBarChanges, baseline: ToolbarBaseline, tracked: RequestFileBarChanges) {
    const entries = Object.entries(changes);
    if (entries.length !== 1) return false;
    const [key, value] = entries[0];
    if (typeof value !== 'string') return false;
    const source = this.content;
    const index = baseline.content === source ? baseline.index : this.toolbarIndexFor(source);
    if (!index.ok || !index.ranges) return false;
    if (!Object.hasOwn(index.ranges, key) || value === index.values[key]) return false;
    const range = index.ranges[key];
    const originalRange = baseline.index.ranges?.[key];
    let replacement = JSON.stringify(value);
    if (!Object.hasOwn(tracked, key)) {
      if (!originalRange) return false;
      replacement = baseline.content.slice(originalRange.from, originalRange.to);
    }
    const next = source.slice(0, range.from) + replacement + source.slice(range.to);
    const delta = next.length - source.length;
    const ranges = { ...index.ranges };
    ranges[key] = { from: range.from, to: range.to + delta };
    for (const [name, other] of Object.entries(index.ranges)) {
      if (other.from >= range.to) ranges[name] = { from: other.from + delta, to: other.to + delta };
    }
    this.barIssue = '';
    this.applyEdit(next);
    this.acceptBarIndex(next, { ...index, ranges, values: { ...index.values, [key]: value } });
    return true;
  }

  changeProtocol(type: RequestType, httpMethod?: string) {
    const fields = this.currentBarValues();
    if (this.barType === type && !httpMethod) return;
    const changes: Record<string, string> = { requestType: type };
    changes.method = type === 'http' ? httpMethod ?? 'GET' : type === 'ws' || type === 'socketio' ? 'GET' : 'POST';
    const url = fields?.url ?? '';
    if (type === 'ws' && /^https?:\/\//i.test(url)) changes.url = url.replace(/^http/i, 'ws');
    if (type !== 'ws' && /^wss?:\/\//i.test(url)) changes.url = url.replace(/^ws/i, 'http');
    if (type === 'graphql') changes.bodyType = 'graphql';
    else if (fields?.bodyType === 'graphql') changes.bodyType = 'json';
    if (type === 'ai' && !url && fields?.aiProvider !== 'kurlo') changes.url = AI_DEFAULT_PRESET.url;
    this.editBar(changes);
  }

  constructor(read: RequestFileRead, write: RequestFileWrite, onEdit?: () => void) {
    this.#read = read;
    this.#write = write;
    this.#onEdit = onEdit;
  }

  get dirty(): boolean {
    return this.content !== this.savedContent;
  }

  get conflicted(): boolean {
    return this.conflict;
  }

  get canRevert(): boolean {
    return this.ready && (this.dirty || Boolean(this.error || this.barIssue));
  }

  get readFailed(): boolean {
    return this.#errorSource === 'load';
  }

  edit(content: string): void {
    if (content === this.content) return;
    this.#manualEditSequence++;
    this.#toolbarBaseline = undefined;
    this.applyEdit(content);
  }

  private applyEdit(content: string): void {
    if (content === this.content) return;
    this.#editSequence++;
    this.barIssue = '';
    this.content = content;
    if (content.length < largeFileSize && this.indexedBar) this.releaseBarIndex();
    if (this.#errorSource !== 'validation') {
      this.error = '';
      this.errorLine = undefined;
      this.#errorSource = '';
    }
    this.#onEdit?.();
  }

  clearValidationError(): void {
    if (this.#errorSource !== 'validation') return;
    this.error = '';
    this.errorLine = undefined;
    this.#errorSource = '';
  }

  async open(): Promise<boolean> {
    if (this.saving) return false;
    const sequence = ++this.#readSequence;
    const writeSequence = this.#writeSequence;
    this.loading = true;
    try {
      const result = await this.#read();
      if (sequence !== this.#readSequence || writeSequence !== this.#writeSequence) return false;
      if (!result.ok) {
        if (this.#errorSource !== 'save') {
          this.error = result.error ?? 'Could not read the request file.';
          this.errorLine = result.line;
          this.#errorSource = 'load';
        }
        return false;
      }
      if (!result.revision) {
        this.ready = false;
        this.error = 'The request file has no revision. Reload it before editing.';
        this.#errorSource = 'load';
        return false;
      }
      if (this.#errorSource === 'load') {
        this.error = '';
        this.errorLine = undefined;
        this.#errorSource = '';
      }
      this.path = result.path ?? this.path;
      const nextContent = result.content ?? '';
      const nextRevision = result.revision ?? '';
      if (!this.dirty) {
        const changedDocument = this.revision !== nextRevision;
        this.content = nextContent;
        this.savedContent = nextContent;
        this.revision = nextRevision;
        this.#toolbarBaseline = undefined;
        this.ready = true;
        if (changedDocument) {
          this.documentGeneration++;
          this.barIssue = '';
        }
        this.remoteContent = undefined;
        this.remoteRevision = undefined;
        this.conflict = false;
      } else if (nextRevision !== this.revision) {
        this.remoteContent = nextContent;
        this.remoteRevision = nextRevision;
        this.conflict = true;
      }
      return true;
    } catch (error) {
      if (sequence !== this.#readSequence) return false;
      this.error = error instanceof Error ? error.message : String(error);
      this.#errorSource = 'load';
      return false;
    } finally {
      if (sequence === this.#readSequence) this.loading = false;
    }
  }

  save(): Promise<boolean> {
    if (this.#savingJob) return this.#savingJob;
    if (!this.ready || !this.dirty || this.conflicted) return Promise.resolve(false);
    const job = this.performSave();
    this.#savingJob = job;
    void job.then(() => {
      if (this.#savingJob === job) this.#savingJob = null;
    });
    return job;
  }

  private async performSave(): Promise<boolean> {
    const submittedContent = this.content;
    const manualEditSequence = this.#manualEditSequence;
    const baseRevision = this.revision;
    this.#writeSequence++;
    this.#readSequence++;
    this.loading = false;
    this.saving = true;
    this.error = '';
    this.errorLine = undefined;
    this.#errorSource = '';
    try {
      const result = await this.#write(submittedContent, baseRevision);
      if (!result.ok) {
        if (result.conflict) {
          this.remoteContent = result.content;
          this.remoteRevision = result.revision;
          this.conflict = true;
        } else {
          this.error = result.error ?? 'Could not save the request file.';
          this.errorLine = result.line;
          this.#errorSource = result.line ? 'validation' : 'save';
        }
        return false;
      }
      if (!result.revision) {
        this.error = 'The saved file has no revision. Reload it before continuing.';
        this.#errorSource = 'save';
        return false;
      }
      const saved = result.content ?? submittedContent;
      this.savedContent = saved;
      this.revision = result.revision;
      if (this.content === submittedContent) {
        this.content = saved;
        this.#toolbarBaseline = undefined;
      } else if (manualEditSequence === this.#manualEditSequence) {
        this.rebaseToolbar(saved);
      }
      this.conflict = false;
      this.remoteContent = undefined;
      this.remoteRevision = undefined;
      return true;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.#errorSource = 'save';
      return false;
    } finally {
      this.saving = false;
    }
  }

  private rebaseToolbar(saved: string) {
    const live = this.toolbarIndexFor(this.content);
    const index = this.toolbarIndexFor(saved);
    this.#toolbarBaseline = undefined;
    if (!live.ok || !index.ok) return;
    const changes: RequestFileBarChanges = {};
    for (const key of Object.keys({ ...index.values, ...live.values })) {
      const value = live.values[key] ?? '';
      if (value === (index.values[key] ?? '')) continue;
      changes[key] = key === 'nameAuto' && (value === 'true' || value === 'false') ? value === 'true' : value;
    }
    if (Object.keys(changes).length) {
      this.#toolbarBaseline = { content: saved, index, changes };
    } else {
      this.content = saved;
    }
  }

  discard(): Promise<boolean> | void {
    if (this.conflicted) return this.reloadRemote();
    if (!this.canRevert) return;
    this.#toolbarBaseline = undefined;
    this.content = this.savedContent;
    this.documentGeneration++;
    this.barIssue = '';
    this.error = '';
    this.errorLine = undefined;
    this.#errorSource = '';
    this.#editSequence++;
    this.#onEdit?.();
  }

  async reloadRemote(): Promise<boolean> {
    return this.refreshForConflict();
  }

  keepLocalChanges(): boolean {
    if (this.remoteRevision === undefined) return false;
    if (this.remoteContent !== undefined) this.savedContent = this.remoteContent;
    this.revision = this.remoteRevision;
    this.remoteContent = undefined;
    this.remoteRevision = undefined;
    this.conflict = false;
    this.error = '';
    this.errorLine = undefined;
    this.#errorSource = '';
    this.ready = true;
    return true;
  }

  private async refreshForConflict(): Promise<boolean> {
    if (this.saving) return false;
    const sequence = ++this.#readSequence;
    const writeSequence = this.#writeSequence;
    const editSequence = this.#editSequence;
    this.loading = true;
    try {
      const result = await this.#read();
      if (sequence !== this.#readSequence || writeSequence !== this.#writeSequence) return false;
      if (!result.ok) {
        this.error = result.error ?? 'Could not reload the request file.';
        this.errorLine = result.line;
        this.#errorSource = 'load';
        return false;
      }
      if (!result.revision) {
        this.error = 'The request file has no revision. Reload it before editing.';
        this.#errorSource = 'load';
        return false;
      }
      if (editSequence !== this.#editSequence) {
        this.remoteContent = result.content ?? '';
        this.remoteRevision = result.revision;
        this.conflict = true;
        this.error = 'Your edits changed while the file was reloading. Review the disk version and choose what to keep.';
        this.#errorSource = 'load';
        return false;
      }
      this.path = result.path ?? this.path;
      const diskContent = result.content ?? '';
      this.revision = result.revision ?? '';
      this.ready = true;
      this.documentGeneration++;
      this.savedContent = diskContent;
      this.content = diskContent;
      this.#toolbarBaseline = undefined;
      this.barIssue = '';
      this.remoteContent = undefined;
      this.remoteRevision = undefined;
      this.conflict = false;
      this.error = '';
      this.errorLine = undefined;
      this.#errorSource = '';
      this.#onEdit?.();
      return true;
    } catch (error) {
      if (sequence !== this.#readSequence) return false;
      this.error = error instanceof Error ? error.message : String(error);
      this.#errorSource = 'load';
      return false;
    } finally {
      if (sequence === this.#readSequence) this.loading = false;
    }
  }
}
