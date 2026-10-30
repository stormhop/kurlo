<script lang="ts">
  import { tabListKeyboard } from '../a11y';
  import { loadTestFingerprint, normalizeLoadTest } from '../loadTests';
  import type { LoadTestTab } from '../stores/features/loadTests';
  import type { Collection, Environment, SavedRequest } from '../types/models';
  import type { LoadDataPreview, K6ExportResult, K6Info, LoadRunResult, LoadRunState, LoadTest } from '../wire';
  import K6MissingDialog from './K6MissingDialog.svelte';
  import LoadRunPanel from './LoadRunPanel.svelte';
  import K6ExportModal from './K6ExportModal.svelte';
  import LoadDataTab from './LoadDataTab.svelte';
  import LoadFlowEditor from './LoadFlowEditor.svelte';
  import LoadProfileEditor from './LoadProfileEditor.svelte';
  import Select from './Select.svelte';

  const AUTOSAVE_DEBOUNCE_MS = 1200;
  const VALIDATE_DEBOUNCE_MS = 300;

  let {
    collection,
    loadTest,
    requests,
    environments,
    loadTestTab = $bindable<LoadTestTab>('flow'),
    autosave = false,
    saveState = 'idle',
    workspaceBlocked = false,
    onSave,
    onValidate,
    onOpenRequest,
    onDuplicate,
    onDelete,
    onExport,
    onSaveScript,
    onChooseData,
    onPreviewData,
    onSaveFolder,
    onCopy,
    run,
    logLines,
    logTestId,
    result,
    k6Info,
    k6MissingOpen = $bindable(false),
    onRun,
    onStop,
    onLoadResult,
    onOpenDashboard,
    onOpenReport,
    onSaveSummary,
    onChooseK6,
    onCheckK6,
    onOpenK6Guide,
  }: {
    collection: Collection | undefined;
    loadTest: LoadTest | undefined;
    requests: SavedRequest[];
    environments: Environment[];
    loadTestTab: LoadTestTab;
    autosave?: boolean;
    saveState?: 'idle' | 'saving' | 'saved';
    workspaceBlocked?: boolean;
    onSave: (collectionId: string, draft: LoadTest, baseFingerprint: string) => Promise<boolean>;
    onValidate: (collectionId: string, draft: LoadTest) => Promise<string[]>;
    onOpenRequest: (requestId: string) => void;
    onDuplicate: (collectionId: string, loadTestId: string) => void;
    onDelete: (collectionId: string, loadTestId: string) => void;
    onExport: (collectionId: string, draft: LoadTest, inlineSecrets: boolean, folder: boolean) => Promise<K6ExportResult>;
    onChooseData: () => Promise<LoadDataPreview | null>;
    onPreviewData: (path: string) => Promise<LoadDataPreview>;
    onSaveFolder: (collectionId: string, draft: LoadTest, inlineSecrets: boolean) => Promise<boolean>;
    onSaveScript: (fileName: string, script: string) => Promise<boolean>;
    onCopy: (text: string) => void;
    run: LoadRunState;
    logLines: string[];
    logTestId: string;
    result: LoadRunResult | null;
    k6Info: K6Info | null;
    k6MissingOpen: boolean;
    onRun: (collectionId: string, draft: LoadTest) => void;
    onStop: () => void;
    onLoadResult: (loadTestId: string) => void;
    onOpenDashboard: (url: string) => void;
    onOpenReport: (loadTestId: string) => void;
    onSaveSummary: (loadTestId: string, fileName: string) => void;
    onChooseK6: () => void;
    onCheckK6: () => void;
    onOpenK6Guide: () => void;
  } = $props();

  let draft = $state<LoadTest>({ id: '', name: '', scenarios: [], settings: {} });
  let loadedId = $state('');
  let loadedFingerprint = $state('');
  let externalUpdate = $state(false);
  let savingInFlight = $state(false);
  let problems = $state<string[]>([]);
  let exportOpen = $state(false);
  let autosaveTimer: ReturnType<typeof setTimeout> | null = null;

  const saved = $derived(saveState === 'saved');
  const runningHere = $derived(run.running && run.loadTestId === loadTest?.id);
  const runningElsewhere = $derived(run.running && run.loadTestId !== loadTest?.id);
  const ready = $derived(Boolean(loadedId) && draft.id === loadedId);
  const draftFingerprint = $derived(ready ? loadTestFingerprint(draft) : '');
  const dirty = $derived(ready && draftFingerprint !== loadedFingerprint);
  const stepCount = $derived(draft.scenarios[0]?.steps.length ?? 0);
  const thresholdCount = $derived(draft.thresholds?.length ?? 0);
  const environmentOptions = $derived([
    { value: '', label: 'Active environment' },
    ...environments.map(environment => ({ value: environment.name, label: environment.name })),
  ]);

  $effect(() => {
    if (!loadTest) return;
    const incoming = loadTestFingerprint(loadTest);
    if (loadTest.id !== loadedId) {
      load(loadTest);
      return;
    }
    if (savingInFlight || incoming === loadedFingerprint) return;
    if (!dirty) load(loadTest);
    else externalUpdate = true;
  });

  $effect(() => {
    if (!autosave || !ready || !collection || workspaceBlocked || externalUpdate || savingInFlight || !dirty) return;
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      autosaveTimer = null;
      void save();
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => {
      if (autosaveTimer) {
        clearTimeout(autosaveTimer);
        autosaveTimer = null;
      }
    };
  });

  $effect(() => {
    if (!ready || !collection) return;
    const collectionId = collection.id;
    const snapshot = $state.snapshot(draft) as LoadTest;
    void draftFingerprint;
    const timer = setTimeout(() => {
      void onValidate(collectionId, snapshot).then(result => (problems = result));
    }, VALIDATE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    if (loadTest?.id) onLoadResult(loadTest.id);
  });

  function runDraft() {
    if (!collection) return;
    onRun(collection.id, $state.snapshot(draft) as LoadTest);
  }

  function summaryName() {
    return `${(loadTest?.name ?? 'load-test').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'load-test'}-summary.json`;
  }

  function load(next: LoadTest) {
    draft = normalizeLoadTest(JSON.parse(JSON.stringify(next)));
    loadedId = next.id;
    loadedFingerprint = loadTestFingerprint(next);
    externalUpdate = false;
  }

  async function save() {
    if (!ready || !collection || savingInFlight) return;
    savingInFlight = true;
    try {
      const ok = await onSave(collection.id, $state.snapshot(draft) as LoadTest, loadedFingerprint);
      if (ok && loadTest) {
        loadedFingerprint = loadTestFingerprint(loadTest);
        draft = normalizeLoadTest(JSON.parse(JSON.stringify(loadTest)));
        externalUpdate = false;
      }
    } finally {
      savingInFlight = false;
    }
  }

  function inputValue(event: Event): string {
    return event.currentTarget instanceof HTMLInputElement ? event.currentTarget.value : '';
  }

  function setEnvironment(value: string) {
    const settings = { ...draft.settings };
    delete settings.environment;
    draft.settings = value ? { ...settings, environment: value } : settings;
  }

  function selectTab(tab: LoadTestTab) {
    loadTestTab = tab;
  }
</script>

<section class="loadtest-workspace" aria-label="Load test">
  {#if collection && loadTest && ready}
    <header class="loadtest-head">
      <div class="loadtest-title">
        <span class="loadtest-crumb">{collection.name} / Load tests</span>
        <input
          class="field field-bare loadtest-name"
          value={draft.name}
          aria-label="Load test name"
          spellcheck="false"
          disabled={workspaceBlocked}
          oninput={(event) => (draft.name = inputValue(event))}
        />
      </div>
      <div class="loadtest-actions">
        {#if externalUpdate}
          <span class="env-save-indicator">Updated elsewhere</span>
          <button class="btn btn-secondary" type="button" onclick={() => loadTest && load(loadTest)} disabled={workspaceBlocked}>Reload</button>
        {:else if autosave && saveState !== 'idle'}
          <span class="env-save-indicator" class:saved>{saveState === 'saving' ? 'Saving changes…' : 'Saved'}</span>
        {:else if !autosave && dirty}
          <span class="env-save-indicator dirty">Unsaved changes</span>
        {/if}
        <Select
          className="loadtest-environment"
          ariaLabel="Environment"
          value={draft.settings.environment ?? ''}
          options={environmentOptions}
          disabled={workspaceBlocked}
          onChange={setEnvironment}
        />
        <button class="btn btn-secondary" type="button" onclick={() => (exportOpen = true)}>Export k6 script</button>
        <button class="btn btn-ghost" type="button" onclick={() => onDuplicate(collection.id, loadTest.id)} disabled={workspaceBlocked}>Duplicate</button>
        <button class="btn btn-ghost btn-danger" type="button" onclick={() => onDelete(collection.id, loadTest.id)} disabled={workspaceBlocked}>Delete</button>
        {#if !autosave}
          <button class="btn btn-secondary" class:feedback-ok={saved && !dirty} type="button" onclick={save} disabled={workspaceBlocked || !dirty}>{saved && !dirty ? 'Saved' : 'Save'}</button>
        {/if}
        {#if runningHere}
          <button class="btn btn-secondary btn-danger" type="button" disabled={run.stopping} onclick={onStop}>{run.stopping ? 'Stopping…' : 'Stop'}</button>
        {:else}
          <button class="btn btn-primary" type="button" disabled={workspaceBlocked || runningElsewhere} title={runningElsewhere ? 'Another load test is running' : ''} onclick={runDraft}>Run with k6</button>
        {/if}
      </div>
    </header>

    {#if problems.length}
      <div class="loadtest-problems" role="status">
        <span class="tag tag-warning">{problems.length} to fix</span>
        <ul>
          {#each problems as problem (problem)}
            <li>{problem}</li>
          {/each}
        </ul>
      </div>
    {/if}

    <div class="tab-bar tabs loadtest-tabs" role="tablist" use:tabListKeyboard>
      <button class="tab" role="tab" aria-selected={loadTestTab === 'flow'} tabindex={loadTestTab === 'flow' ? 0 : -1} type="button" onclick={() => selectTab('flow')}>Flow{#if stepCount}<span class="badge">{stepCount}</span>{/if}</button>
      <button class="tab" role="tab" aria-selected={loadTestTab === 'load'} tabindex={loadTestTab === 'load' ? 0 : -1} type="button" onclick={() => selectTab('load')}>Load &amp; thresholds{#if thresholdCount}<span class="badge">{thresholdCount}</span>{/if}</button>
      <button class="tab" role="tab" aria-selected={loadTestTab === 'data'} tabindex={loadTestTab === 'data' ? 0 : -1} type="button" onclick={() => selectTab('data')}>Data &amp; options</button>
      <button class="tab" role="tab" aria-selected={loadTestTab === 'results'} tabindex={loadTestTab === 'results' ? 0 : -1} type="button" onclick={() => selectTab('results')}>Results{#if runningHere}<span class="badge badge-on">running</span>{/if}</button>
    </div>

    <div class="loadtest-content" role="tabpanel">
      {#if loadTestTab === 'flow'}
        <LoadFlowEditor bind:draft {requests} disabled={workspaceBlocked} {onOpenRequest} />
      {:else if loadTestTab === 'load'}
        <LoadProfileEditor bind:draft disabled={workspaceBlocked} {requests} />
      {:else if loadTestTab === 'data'}
        <LoadDataTab bind:draft disabled={workspaceBlocked} onChoose={onChooseData} onPreview={onPreviewData} />
      {:else}
        <LoadRunPanel
          loadTest={draft}
          {requests}
          {run}
          logLines={logTestId === loadTest.id ? logLines : []}
          {result}
          otherRunning={runningElsewhere}
          disabled={workspaceBlocked}
          onRun={runDraft}
          {onStop}
          {onOpenDashboard}
          onOpenReport={() => onOpenReport(loadTest.id)}
          onSaveSummary={() => onSaveSummary(loadTest.id, summaryName())}
        />
      {/if}
    </div>
    {#if k6MissingOpen}
      <K6MissingDialog
        info={k6Info}
        onChoose={onChooseK6}
        onCheckAgain={onCheckK6}
        onExportOnly={() => { k6MissingOpen = false; exportOpen = true; }}
        onOpenGuide={onOpenK6Guide}
        {onCopy}
        onClose={() => (k6MissingOpen = false)}
      />
    {/if}
    {#if exportOpen}
      {@const snapshot = $state.snapshot(draft) as LoadTest}
      <K6ExportModal
        loadTest={snapshot}
        onExport={(inlineSecrets, folder) => onExport(collection.id, snapshot, inlineSecrets, folder)}
        onSaveFolder={(inlineSecrets) => onSaveFolder(collection.id, snapshot, inlineSecrets)}
        runDisabled={workspaceBlocked || run.running}
        onRun={() => { exportOpen = false; runDraft(); }}
        onSave={onSaveScript}
        {onCopy}
        onClose={() => (exportOpen = false)}
      />
    {/if}
  {:else}
    <div class="empty-state">
      <p class="empty-state-title">This load test is gone</p>
      <p class="empty-state-text">It was deleted or its collection was removed. Pick another load test in the sidebar.</p>
    </div>
  {/if}
</section>
