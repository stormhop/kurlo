<script lang="ts">
  import { tabListKeyboard } from '../a11y';
  import { loadTestFingerprint, normalizeLoadTest } from '../loadTests';
  import { executorDurationMs, executorModel, executorPeak, formatDuration } from '../loadPresets';
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
  import RequestSaveActions from './RequestSaveActions.svelte';
  import LoadValidationMessages from './LoadValidationMessages.svelte';

  const AUTOSAVE_DEBOUNCE_MS = 1200;
  const VALIDATE_DEBOUNCE_MS = 300;

  let {
    collection,
    loadTest,
    isDraft = false,
    requests,
    environments,
    loadTestTab = $bindable<LoadTestTab>('flow'),
    autosave = false,
    saveState = 'idle',
    workspaceBlocked = false,
    onSave,
    onValidate,
    onOpenRequest,
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
    exportRequestId = '',
    onExportRequestHandled = () => {},
    pendingEdits = null,
    onEdits = () => {},
  }: {
    collection: Collection | undefined;
    loadTest: LoadTest | undefined;
    isDraft?: boolean;
    requests: SavedRequest[];
    environments: Environment[];
    loadTestTab: LoadTestTab;
    autosave?: boolean;
    saveState?: 'idle' | 'saving' | 'saved';
    workspaceBlocked?: boolean;
    onSave: (collectionId: string, draft: LoadTest, baseFingerprint: string) => Promise<boolean>;
    onValidate: (collectionId: string, draft: LoadTest) => Promise<string[]>;
    onOpenRequest: (requestId: string) => void;
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
    exportRequestId?: string;
    onExportRequestHandled?: () => void;
    pendingEdits?: LoadTest | null;
    onEdits?: (collectionId: string, test: LoadTest, dirty: boolean) => void;
  } = $props();

  const DATA_MODES: Record<string, string> = {
    'per-vu': 'one row per user',
    'per-iteration': 'next row each iteration',
    random: 'random row',
  };
  const RESULT_LABELS: Record<string, string> = { passed: 'passed', failed: 'failed', stopped: 'stopped', error: 'did not finish' };

  let draft = $state<LoadTest>({ id: '', name: '', scenarios: [], settings: {} });
  let loadedId = $state('');
  let loadedFingerprint = $state('');
  let externalUpdate = $state(false);
  let savingInFlight = $state(false);
  let problems = $state<string[]>([]);
  let exportOpen = $state(false);
  let autosaveTimer: ReturnType<typeof setTimeout> | null = null;

  const runningHere = $derived(run.running && run.loadTestId === loadTest?.id);
  const runningElsewhere = $derived(run.running && run.loadTestId !== loadTest?.id);
  const ready = $derived(Boolean(loadedId) && draft.id === loadedId);
  const draftFingerprint = $derived(ready ? loadTestFingerprint(draft) : '');
  const dirty = $derived(ready && draftFingerprint !== loadedFingerprint);
  const stepCount = $derived(draft.scenarios[0]?.steps.length ?? 0);
  const thresholdCount = $derived(draft.thresholds?.length ?? 0);
  const nameProblems = $derived<string[]>(problems.filter(problem => problem === 'The load test needs a name.'));
  const dataProblems = $derived(problems.filter(problem => /data|timeout/i.test(problem)));
  const profileProblems = $derived(problems.filter(problem => /^(Set |Stage |Threshold |Add at least one stage|Unknown load model|The rate time unit|The virtual user limit)/.test(problem)));
  const flowProblems = $derived(problems.filter(problem => !nameProblems.includes(problem) && !dataProblems.includes(problem) && !profileProblems.includes(problem)));

  const executor = $derived(draft.scenarios[0]?.executor);
  const peak = $derived(executor ? executorPeak(executor) : 0);
  const totalMs = $derived(executor ? executorDurationMs(executor) : 0);
  const loadUnit = $derived(executor && executorModel(executor) === 'rate' ? 'iterations/s' : 'users');
  const ramps = $derived(Boolean(executor?.stages?.length));
  const dataName = $derived(draft.data?.path.trim().split(/[\\/]/).at(-1) ?? '');

  const environmentOptions = $derived([
    { value: '', label: 'Active environment' },
    ...environments.map(environment => ({ value: environment.name, label: environment.name })),
  ]);

  $effect(() => {
    if (!loadTest) return;
    const incoming = loadTestFingerprint(loadTest);
    if (loadTest.id !== loadedId) {
      load(loadTest, true);
      return;
    }
    if (savingInFlight || incoming === loadedFingerprint) return;
    if (!dirty) load(loadTest);
    else externalUpdate = true;
  });

  $effect(() => {
    if (isDraft || !autosave || !ready || !collection || workspaceBlocked || externalUpdate || savingInFlight || !dirty) return;
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
    let cancelled = false;
    const timer = setTimeout(() => {
      void onValidate(collectionId, snapshot).then(result => { if (!cancelled) problems = result; });
    }, VALIDATE_DEBOUNCE_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  });

  $effect(() => {
    if (loadTest?.id) onLoadResult(loadTest.id);
  });

  $effect(() => {
    if (!ready || !collection) return;
    void draftFingerprint;
    onEdits(collection.id, $state.snapshot(draft) as LoadTest, dirty);
  });

  $effect(() => {
    if (!exportRequestId || !ready || exportRequestId !== loadTest?.id) return;
    exportOpen = true;
    onExportRequestHandled();
  });

  function runDraft() {
    if (!collection) return;
    onRun(collection.id, $state.snapshot(draft) as LoadTest);
  }

  function summaryName() {
    return `${(loadTest?.name ?? 'load-test').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'load-test'}-summary.json`;
  }

  function load(next: LoadTest, restore = false) {
    const source = restore && pendingEdits?.id === next.id ? pendingEdits : next;
    draft = normalizeLoadTest(JSON.parse(JSON.stringify(source)));
    loadedId = next.id;
    loadedFingerprint = loadTestFingerprint(next);
    externalUpdate = false;
    problems = [];
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
      <div class="loadtest-head-main">
        <div class="loadtest-title">
          <span class="loadtest-crumb">{collection.name} / Load tests</span>
          <div class="request-meta loadtest-meta">
            <input
              class="request-title-input"
              value={draft.name}
              title={draft.name}
              aria-label="Load test name"
              aria-invalid={nameProblems.length > 0}
              spellcheck="false"
              disabled={workspaceBlocked}
              oninput={(event) => (draft.name = inputValue(event))}
              onkeydown={(event) => {
                if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
              }}
            />
            {#if isDraft}
              <span class="loadtest-draft-note" title={`Saving adds it to ${collection.name}`}>Unsaved draft</span>
              <RequestSaveActions saveDirty={true} canRevert={dirty} disabled={workspaceBlocked || savingInFlight} onSave={save} onRevert={() => load(loadTest)} />
            {:else if !autosave}
              <RequestSaveActions saveDirty={dirty} canRevert={dirty} disabled={workspaceBlocked || savingInFlight} onSave={save} onRevert={() => load(loadTest)} />
            {:else}
              <span class="loadtest-save-status">{saveState === 'saving' ? 'Saving changes…' : 'Saved'}</span>
            {/if}
          </div>
          <LoadValidationMessages problems={nameProblems} />
        </div>
        <div class="loadtest-actions">
          {#if runningHere}<span class="loadtest-locked">Editing is locked while k6 runs</span>{/if}
          <Select
            className="loadtest-environment"
            ariaLabel="Environment"
            value={draft.settings.environment ?? ''}
            options={environmentOptions}
            disabled={workspaceBlocked}
            onChange={setEnvironment}
          />
          <button class="btn btn-secondary" type="button" onclick={() => (exportOpen = true)}>Export k6 script</button>
          {#if runningHere}
            <button class="btn btn-secondary btn-danger loadtest-run-action" type="button" disabled={run.stopping} onclick={onStop}>{run.stopping ? 'Stopping…' : 'Stop'}</button>
          {:else}
            <button class="btn btn-primary loadtest-run-action" type="button" disabled={workspaceBlocked || runningElsewhere} title={runningElsewhere ? 'Another load test is running' : ''} onclick={runDraft}>
              <svg width="0.75rem" height="0.75rem" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5v14l11-7z"/></svg>
              Run with k6
            </button>
          {/if}
        </div>
      </div>
      {#if externalUpdate}
        <div class="loadtest-row">
          <span class="loadtest-hint">Updated elsewhere</span>
          <button class="btn btn-secondary btn-sm" type="button" onclick={() => load(loadTest)} disabled={workspaceBlocked}>Reload</button>
        </div>
      {/if}
      <div class="loadtest-plan" role="group" aria-label="Test plan">
        <span class="loadtest-plan-label">Plan</span>
        <button class="btn btn-ghost btn-xs loadtest-plan-chip" type="button" onclick={() => selectTab('flow')}><b>{stepCount}</b> {stepCount === 1 ? 'step' : 'steps'}</button>
        {#if peak}
          <button class="btn btn-ghost btn-xs loadtest-plan-chip" type="button" onclick={() => selectTab('load')}>{ramps ? 'up to ' : ''}<b>{peak}</b> {loadUnit}</button>
        {/if}
        {#if totalMs}
          <button class="btn btn-ghost btn-xs loadtest-plan-chip" type="button" onclick={() => selectTab('load')}><b>{formatDuration(totalMs)}</b> total</button>
        {/if}
        {#if thresholdCount}
          <button class="btn btn-ghost btn-xs loadtest-plan-chip" type="button" onclick={() => selectTab('load')}><b>{thresholdCount}</b> pass {thresholdCount === 1 ? 'criterion' : 'criteria'}</button>
        {/if}
        {#if dataName}
          <button class="btn btn-ghost btn-xs loadtest-plan-chip" type="button" onclick={() => selectTab('data')}><code>{dataName}</code> · {DATA_MODES[draft.data?.mode ?? 'per-vu'] ?? 'one row per user'}</button>
        {/if}
      </div>
    </header>
    <div class="tab-bar tabs loadtest-tabs" role="tablist" use:tabListKeyboard>
      <button class="tab" role="tab" aria-selected={loadTestTab === 'flow'} tabindex={loadTestTab === 'flow' ? 0 : -1} type="button" onclick={() => selectTab('flow')}>Flow{#if stepCount}<span class="badge">{stepCount}</span>{/if}{#if flowProblems.some(problem => problem !== 'Add at least one request to the flow.') || nameProblems.length}<span class="loadtest-tab-issue" title="Has problems to fix"></span>{/if}</button>
      <button class="tab" role="tab" aria-selected={loadTestTab === 'load'} tabindex={loadTestTab === 'load' ? 0 : -1} type="button" onclick={() => selectTab('load')}>Load &amp; thresholds{#if thresholdCount}<span class="badge">{thresholdCount}</span>{/if}{#if profileProblems.length}<span class="loadtest-tab-issue" title="Has problems to fix"></span>{/if}</button>
      <button class="tab" role="tab" aria-selected={loadTestTab === 'data'} tabindex={loadTestTab === 'data' ? 0 : -1} type="button" onclick={() => selectTab('data')}>Data &amp; options{#if dataProblems.length}<span class="loadtest-tab-issue" title="Has problems to fix"></span>{/if}</button>
      <button class="tab" role="tab" aria-selected={loadTestTab === 'results'} tabindex={loadTestTab === 'results' ? 0 : -1} type="button" onclick={() => selectTab('results')}>Results{#if runningHere}<span class="badge badge-on">running</span>{:else if result}<span class="loadtest-result-badge {result.status}">{RESULT_LABELS[result.status] ?? result.status}</span>{/if}</button>
    </div>
    <div class="loadtest-content" role="tabpanel">
      {#if loadTestTab === 'flow'}
        <LoadFlowEditor bind:draft {requests} problems={flowProblems} disabled={workspaceBlocked} {onOpenRequest} />
      {:else if loadTestTab === 'load'}
        <LoadProfileEditor bind:draft problems={profileProblems} disabled={workspaceBlocked} {requests} />
      {:else if loadTestTab === 'data'}
        <LoadDataTab bind:draft problems={dataProblems} disabled={workspaceBlocked} onChoose={onChooseData} onPreview={onPreviewData} />
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
