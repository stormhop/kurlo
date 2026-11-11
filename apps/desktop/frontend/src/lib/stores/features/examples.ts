import type { HttpResponse } from '../../backend';
import { cloneRequestExample, exampleFromResponse, exampleHasRawSecret, mediaTypeOf } from '../../examples';
import type { RequestExample, RequestTab, SavedRequest } from '../../types/models';

type ExamplesHost = {
  requestExamples: RequestExample[];
  selectedExampleId: string;
  requestTab: RequestTab;
  response: HttpResponse | null;
  requestError: string;
  collectionImportToast: string;
  snapshotActiveRequest: () => SavedRequest;
  activeSecretEnvironmentValues: () => string[];
  scheduleActiveRequestPersist: () => void;
  guardWorkspaceWritable: (action?: string) => boolean;
  openConfirmDialog: (title: string, message: string, confirmLabel?: string) => Promise<boolean>;
  openPromptDialog: (title: string, initialValue?: string, message?: string) => Promise<string | null>;
  openNameDialog: (title: string, initialValue?: string, message?: string) => Promise<string | null>;
  addCapturedExample: (example: RequestExample) => void;
  selectedExample: () => RequestExample | null;
  selectExample: (id: string) => void;
  saveResponseAsExample: () => Promise<void>;
  renameExample: (id: string) => Promise<void>;
  deleteExample: (id: string) => Promise<void>;
  moveExample: (id: string, delta: number) => void;
  updateExample: (id: string, patch: Partial<RequestExample>) => void;
  updateExampleResponse: (id: string, patch: Partial<RequestExample['response']>) => void;
  exampleWarning: (example: RequestExample) => string;
};

const EXAMPLE_TOAST_MS = 2200;
const EXAMPLE_WARNING_TOAST_MS = 5000;

function showExampleToast(host: ExamplesHost, message: string, ms: number) {
  host.collectionImportToast = message;
  setTimeout(() => {
    if (host.collectionImportToast === message) host.collectionImportToast = '';
  }, ms);
}

function uniqueExampleName(existing: RequestExample[], desired: string): string {
  const taken = new Set(existing.map(example => example.name));
  if (!taken.has(desired)) return desired;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${desired} (${suffix})`;
    if (!taken.has(candidate)) return candidate;
  }
}

export const examplesFeature = {
  selectedExample(this: ExamplesHost): RequestExample | null {
    if (!this.requestExamples.length) return null;
    return this.requestExamples.find(example => example.id === this.selectedExampleId) ?? this.requestExamples[0];
  },

  selectExample(this: ExamplesHost, id: string) {
    this.selectedExampleId = id;
  },

  addCapturedExample(this: ExamplesHost, example: RequestExample) {
    const captured = cloneRequestExample(example);
    captured.requestId = this.snapshotActiveRequest().id;
    captured.name = uniqueExampleName(this.requestExamples, captured.name || String(captured.response.statusCode));

    this.requestExamples = [...this.requestExamples, captured];
    this.selectedExampleId = captured.id;
    this.requestTab = 'examples';
    this.scheduleActiveRequestPersist();
    if (exampleHasRawSecret(captured)) {
      showExampleToast(this, `Saved “${captured.name}” — check it for credentials before committing`, EXAMPLE_WARNING_TOAST_MS);
    } else {
      showExampleToast(this, `Saved “${captured.name}” as an example`, EXAMPLE_TOAST_MS);
    }
  },

  async saveResponseAsExample(this: ExamplesHost) {
    if (!this.guardWorkspaceWritable('Saving an example')) return;
    const response = this.response;
    if (!response) return;

    this.addCapturedExample(exampleFromResponse(this.snapshotActiveRequest(), response, {
      secretValues: this.activeSecretEnvironmentValues(),
    }));
  },

  async renameExample(this: ExamplesHost, id: string) {
    const example = this.requestExamples.find(item => item.id === id);
    if (!example) return;
    if (!this.guardWorkspaceWritable('Renaming an example')) return;
    const next = await this.openNameDialog('Rename example', example.name);
    const trimmed = next?.trim();
    if (!trimmed || trimmed === example.name) return;
    this.updateExample(id, { name: uniqueExampleName(this.requestExamples.filter(item => item.id !== id), trimmed) });
  },

  async deleteExample(this: ExamplesHost, id: string) {
    const example = this.requestExamples.find(item => item.id === id);
    if (!example) return;
    if (!this.guardWorkspaceWritable('Deleting an example')) return;
    const confirmed = await this.openConfirmDialog(
      'Delete example',
      `Delete “${example.name}”? Its saved response goes with it.`,
      'Delete',
    );
    if (!confirmed) return;
    const remaining = this.requestExamples.filter(item => item.id !== id);
    this.requestExamples = remaining;
    if (this.selectedExampleId === id) this.selectedExampleId = remaining[0]?.id ?? '';
    this.scheduleActiveRequestPersist();
  },

  moveExample(this: ExamplesHost, id: string, delta: number) {
    const index = this.requestExamples.findIndex(item => item.id === id);
    if (index < 0) return;
    const target = index + delta;
    if (target < 0 || target >= this.requestExamples.length) return;
    const next = [...this.requestExamples];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    this.requestExamples = next;
    this.scheduleActiveRequestPersist();
  },

  updateExample(this: ExamplesHost, id: string, patch: Partial<RequestExample>) {
    this.requestExamples = this.requestExamples.map(example =>
      example.id === id ? { ...cloneRequestExample(example), ...patch } : example,
    );
    this.scheduleActiveRequestPersist();
  },

  updateExampleResponse(this: ExamplesHost, id: string, patch: Partial<RequestExample['response']>) {
    this.requestExamples = this.requestExamples.map(example => {
      if (example.id !== id) return example;
      const next = cloneRequestExample(example);
      next.response = { ...next.response, ...patch };
      const contentType = next.response.headers.find(row => row.key.toLowerCase() === 'content-type')?.value ?? '';
      if (contentType) next.response.bodyMediaType = mediaTypeOf(contentType);
      return next;
    });
    this.scheduleActiveRequestPersist();
  },

  exampleWarning(this: ExamplesHost, example: RequestExample): string {
    return exampleHasRawSecret(example)
      ? 'This example holds something that looks like a credential. It is written to the workspace as-is.'
      : '';
  },
};
