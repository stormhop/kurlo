<script lang="ts">
  import { useClock } from '../clock.svelte';
  const now = useClock();
  import { tabListKeyboard } from '../a11y';
  import { AUTH_OPTIONS, COLLECTION_AUTH_OPTIONS, OAUTH1_SIGNATURE_OPTIONS } from '../constants';
  import { HEADER_PICKER_NAMES, getHeaderValues } from '../headers';
  import { collectionSettingsFingerprint, emptyCollectionDefaults, emptyFolderDefaults, folderDefaultsFingerprint, folderDefaultsFor, inheritedAuthSource, normalizeCollectionDefaults } from '../collectionDefaults';
  import { activeCount, cloneRowsForStore, guardTrailing, removeRow, restoreRows, scriptLineCount } from '../utils';
  import { openFileDialog } from '../backend';
  import type { AuthState, Collection, CollectionDefaults, Environment, FolderDefaults, KVRow, OAuth1AddTo, OAuth1SignatureMethod, RequestSettings, ScriptEngine } from '../types/models';
  import { defaultPinnedEnvironmentId, normalizeCollectionEnvironmentPins } from '../collectionEnvironments';
  import type { VariableSuggestion } from '../variables';
  import CodeEditor from '../CodeEditor.svelte';
  import Select from './Select.svelte';
  import AddCloseIcon from './AddCloseIcon.svelte';
  import SearchPicker from './SearchPicker.svelte';
  import VariableInput from './VariableInput.svelte';
  import CollapsibleMarkdown from './CollapsibleMarkdown.svelte';
  import { markdownSizeLabel, markdownTooLongToPreview } from '../markdown';
  import MenuIcon from './MenuIcon.svelte';
  import { tick } from 'svelte';
  import { relativeTime, type CollectionRunTally } from '../collectionRuns';

  type CollectionSettingsTab = 'overview' | 'headers' | 'vars' | 'auth' | 'script' | 'tests' | 'proxy';
  type CollectionSettingsPatch = Pick<Collection, 'name' | 'description' | 'defaults' | 'environmentIds' | 'defaultEnvironmentId'> & { baseFingerprint?: string };

  const HTTP_VERSION_OPTIONS = [
    { value: 'auto', label: 'Auto' },
    { value: '1.1', label: 'HTTP/1.1' },
    { value: '2', label: 'HTTP/2 preferred' },
  ];



  const AUTOSAVE_DEBOUNCE_MS = 1200;

  let {
    collection,
    environments = [],
    requestCount = 0,
    lastRun = null,
    onOpenRunner,
    collectionSettingsTab = $bindable<CollectionSettingsTab>('overview'),
    autosave = false,
    saveState = 'idle',
    workspaceBlocked = false,
    variableSuggestions = [],
    scriptEngine = 'js',
    onSave,
    onReset,
    onCreateRequest,
    folderPath = [],
    folderRequestCount = 0,
    onSaveFolder = () => false,
    onResetFolder = () => false,
    onCreateRequestInFolder = () => {},
    onExport = () => {},
    onDelete = () => {},
  }: {
    collection: Collection | undefined;
    environments?: Environment[];
    requestCount?: number;
    lastRun?: (CollectionRunTally & { finishedAt: number }) | null;
    onOpenRunner: (collectionId: string) => void;
    collectionSettingsTab: CollectionSettingsTab;
    autosave?: boolean;
    saveState?: 'idle' | 'saving' | 'saved';
    workspaceBlocked?: boolean;
    variableSuggestions?: VariableSuggestion[];
    scriptEngine?: ScriptEngine;
    onSave: (collectionId: string, patch: CollectionSettingsPatch) => boolean | void | Promise<boolean | void>;
    onReset: (collectionId: string) => boolean | Promise<boolean>;
    onCreateRequest: (collectionId: string) => void | Promise<void>;
    folderPath?: string[];
    folderRequestCount?: number;
    onSaveFolder?: (collectionId: string, folder: FolderDefaults, baseFingerprint?: string) => boolean | Promise<boolean>;
    onResetFolder?: (collectionId: string, folderPath: string[]) => boolean | Promise<boolean>;
    onCreateRequestInFolder?: (collectionId: string, folderPath: string[]) => void | Promise<void>;
    onExport?: (collectionId: string) => void | Promise<void>;
    onDelete?: (collectionId: string) => void | Promise<void>;
  } = $props();

  const FOLDER_AUTH_OPTIONS = [
    { value: 'inherit' as const, label: 'Inherit from parent' },
    ...COLLECTION_AUTH_OPTIONS,
  ];

  const isFolder = $derived(folderPath.length > 0);
  const folderName = $derived(folderPath.at(-1) ?? '');
  const authOptions = $derived(isFolder ? FOLDER_AUTH_OPTIONS : COLLECTION_AUTH_OPTIONS);
  const parentAuthSource = $derived.by(() => {
    if (!collection || !isFolder) return '';
    const source = inheritedAuthSource(collection, folderPath.slice(0, -1));
    if (source.kind === 'folder') return `the ${source.folder.path.at(-1)} folder (${AUTH_OPTIONS.find(option => option.value === source.folder.auth.type)?.label ?? source.folder.auth.type})`;
    const type = collection.defaults.auth.type;
    return type === 'none' ? 'the collection, which sets no auth' : `the collection (${AUTH_OPTIONS.find(option => option.value === type)?.label ?? type})`;
  });
  let folderId = $state('');

  function settingsKey(target: Collection | undefined): string {
    return target ? `${target.id}\u001f${folderPath.join('\u001f')}` : '';
  }

  function incomingFingerprint(target: Collection): string {
    return isFolder ? folderDefaultsFingerprint(folderDefaultsFor(target, folderPath)) : collectionSettingsFingerprint(target);
  }

  $effect(() => {
    if (isFolder && (collectionSettingsTab === 'overview' || collectionSettingsTab === 'vars' || collectionSettingsTab === 'proxy')) {
      collectionSettingsTab = 'headers';
    }
  });

  let loadedCollectionId = $state('');
  let loadedFingerprint = $state('');
  let externalUpdate = $state(false);
  let name = $state('');
  let description = $state('');
  let headers = $state<KVRow[]>([]);
  let variables = $state<KVRow[]>([]);
  let auth = $state<AuthState>(emptyCollectionDefaults().auth);
  let preRequestScript = $state('');
  let testScript = $state('');
  let preRequestScriptJs = $state('');
  let testScriptJs = $state('');
  let settings = $state<RequestSettings>(emptyCollectionDefaults().settings);
  let pinnedEnvironmentIds = $state<string[]>([]);
  let defaultEnvironmentId = $state('');
  const pinnedEnvironmentCount = $derived(environments.filter(environment => pinnedEnvironmentIds.includes(environment.id)).length);
  const effectiveDefaultEnvironmentId = $derived(defaultPinnedEnvironmentId({ environmentIds: pinnedEnvironmentIds, defaultEnvironmentId }, environments));
  const pinnedEnvironments = $derived(environments.filter(environment => pinnedEnvironmentIds.includes(environment.id)));
  const unpinnedEnvironmentOptions = $derived(environments.filter(environment => !pinnedEnvironmentIds.includes(environment.id)).map(environment => {
    const count = (environment.values ?? []).filter(row => row.key?.trim()).length;
    return { value: environment.id, label: environment.name, hint: `${count} ${count === 1 ? 'variable' : 'variables'}` };
  }));

  const engineLabel = $derived(scriptEngine === 'js' ? 'JavaScript' : 'Tengo');
  const activePre = $derived(scriptEngine === 'js' ? preRequestScriptJs : preRequestScript);
  const activeTest = $derived(scriptEngine === 'js' ? testScriptJs : testScript);
  let authMenuOpen = $state(false);
  let savingInFlight = $state(false);
  let autosaveTimer: ReturnType<typeof setTimeout> | null = null;

  const saved = $derived(saveState === 'saved');

  $effect(() => {
    if (!collection) return;
    const incoming = incomingFingerprint(collection);
    if (settingsKey(collection) !== loadedCollectionId) {
      loadCollection(collection);
      return;
    }


    if (savingInFlight) return;
    if (incoming !== loadedFingerprint) {
      if (draftFingerprint() === loadedFingerprint) {
        loadCollection(collection);
      } else {
        externalUpdate = true;
      }
    }
  });

  $effect(() => {
    if (!autosave || !collection || workspaceBlocked || externalUpdate || savingInFlight) return;

    if (draftFingerprint() === loadedFingerprint) return;
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

  function loadCollection(next: Collection) {
    loadedCollectionId = settingsKey(next);
    loadedFingerprint = incomingFingerprint(next);
    externalUpdate = false;
    authMenuOpen = false;
    if (isFolder) {
      const folder = folderDefaultsFor(next, folderPath) ?? emptyFolderDefaults(folderPath);
      folderId = folder.id;
      name = next.name;
      description = next.description ?? '';
      headers = restoreRows(folder.headers);
      variables = [];
      auth = { ...folder.auth };
      preRequestScript = folder.preRequestScript;
      testScript = folder.testScript;
      preRequestScriptJs = folder.preRequestScriptJs;
      testScriptJs = folder.testScriptJs;
      return;
    }
    const defaults = normalizeCollectionDefaults(next.defaults);
    name = next.name;
    description = next.description ?? '';
    headers = restoreRows(defaults.headers);
    variables = restoreRows(defaults.variables);
    auth = { ...defaults.auth };
    preRequestScript = defaults.preRequestScript;
    testScript = defaults.testScript;
    preRequestScriptJs = defaults.preRequestScriptJs;
    testScriptJs = defaults.testScriptJs;
    settings = { ...defaults.settings };
    const pins = normalizeCollectionEnvironmentPins(next);
    pinnedEnvironmentIds = [...(pins.environmentIds ?? [])];
    defaultEnvironmentId = pins.defaultEnvironmentId ?? '';
    authMenuOpen = false;
  }

  function togglePinnedEnvironment(environmentId: string, pinned: boolean) {
    pinnedEnvironmentIds = pinned
      ? [...pinnedEnvironmentIds.filter(id => id !== environmentId), environmentId]
      : pinnedEnvironmentIds.filter(id => id !== environmentId);
    if (!pinned && defaultEnvironmentId === environmentId) defaultEnvironmentId = '';
  }

  function pinEnvironment(environmentId: string) {
    if (environmentId) togglePinnedEnvironment(environmentId, true);
  }

  function draftPins() {
    return normalizeCollectionEnvironmentPins({ environmentIds: pinnedEnvironmentIds, defaultEnvironmentId });
  }

  function inputValue(event: Event): string {
    const target = event.currentTarget;
    return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target.value : '';
  }

  function inputNumber(event: Event): number {
    const target = event.currentTarget;
    return target instanceof HTMLInputElement ? Number(target.value) : 0;
  }

  async function pickCollectionCertFile(field: 'clientCertPath' | 'clientKeyPath') {
    const path = await openFileDialog(field === 'clientCertPath' ? 'Select client certificate' : 'Select client key');
    if (path) settings[field] = path;
  }

  function clearCollectionCertField(field: 'clientCertPath' | 'clientKeyPath') {
    settings[field] = '';
    if (field === 'clientCertPath') {
      settings.clientKeyPath = '';
      settings.clientKeyPassword = '';
    }
  }

  function draftDefaults(): CollectionDefaults {
    return normalizeCollectionDefaults({
      headers: cloneRowsForStore(headers),
      variables: cloneRowsForStore(variables),
      auth,
      preRequestScript,
      testScript,
      preRequestScriptJs,
      testScriptJs,
      settings,
    });
  }

  function draftFolder(): FolderDefaults {
    return {
      id: folderId || emptyFolderDefaults(folderPath).id,
      path: [...folderPath],
      headers: cloneRowsForStore(headers),
      auth: { ...auth },
      preRequestScript,
      testScript,
      preRequestScriptJs,
      testScriptJs,
    };
  }

  function savedDescription(): string {
    return description.trim() ? description : '';
  }

  function draftFingerprint(): string {
    if (isFolder) return folderDefaultsFingerprint(draftFolder());
    return collectionSettingsFingerprint({
      name,
      description: savedDescription(),
      defaults: draftDefaults(),
      ...draftPins(),
    });
  }

  async function save() {
    if (!collection || savingInFlight) return;
    const baseFingerprint = loadedFingerprint;
    savingInFlight = true;
    try {
      if (isFolder) {
        const folder = draftFolder();
        folderId = folder.id;
        const didSaveFolder = await onSaveFolder(collection.id, folder, baseFingerprint);
        if (!didSaveFolder) return;
        loadedFingerprint = incomingFingerprint(collection);
        externalUpdate = false;
        return;
      }
      const pins = draftPins();
      const didSave = await onSave(collection.id, {
        name,
        description: savedDescription(),
        defaults: draftDefaults(),
        environmentIds: pins.environmentIds ?? [],
        defaultEnvironmentId: pins.defaultEnvironmentId ?? '',
        baseFingerprint,
      });
      if (didSave === false) return;


      loadedFingerprint = collectionSettingsFingerprint(collection);
      externalUpdate = false;
    } finally {
      savingInFlight = false;
    }
  }

  let renaming = $state(false);
  let nameDraft = $state('');
  let nameInput = $state<HTMLInputElement>();
  let editingDocs = $state(false);
  let docsInput = $state<HTMLTextAreaElement>();
  let docsCollectionId = $state('');
  let moreMenuOpen = $state(false);
  let moreMenuRoot = $state<HTMLElement | null>(null);
  let moreMenuButton = $state<HTMLButtonElement | null>(null);

  $effect(() => {
    const id = loadedCollectionId;
    if (id === docsCollectionId) return;
    docsCollectionId = id;
    editingDocs = false;
    renaming = false;
    moreMenuOpen = false;
  });

  async function startRename() {
    if (workspaceBlocked || isFolder) return;
    nameDraft = name;
    renaming = true;
    await tick();
    nameInput?.select();
  }

  function finishRename(commit: boolean) {
    if (!renaming) return;
    renaming = false;
    const next = nameDraft.trim();
    if (!commit || !next || next === name) return;
    name = next;
    void save();
  }

  function onNameKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      finishRename(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      finishRename(false);
    }
  }

  async function editDocs() {
    editingDocs = true;
    await tick();
    docsInput?.focus();
  }

  function onDocsKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      editingDocs = false;
    }
  }

  function runMenuAction(action: () => unknown) {
    moreMenuOpen = false;
    void action();
  }

  function closeMoreMenuOnFocusOut(event: FocusEvent) {
    const current = event.currentTarget;
    const next = event.relatedTarget;
    if (!(current instanceof HTMLElement) || next === null) return;
    if (next instanceof Node && current.contains(next)) return;
    moreMenuOpen = false;
  }

  function closeMoreMenuOnOutsidePointer(event: PointerEvent) {
    if (moreMenuOpen && event.target instanceof Node && !moreMenuRoot?.contains(event.target)) moreMenuOpen = false;
  }

  function closeMoreMenuOnEscape(event: KeyboardEvent) {
    if (!moreMenuOpen || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    moreMenuOpen = false;
    moreMenuButton?.focus();
  }

  function plural(count: number, word: string): string {
    return `${count} ${word}${count === 1 ? '' : 's'}`;
  }

  const changedSettingsCount = $derived.by(() => {
    const base = emptyCollectionDefaults().settings as Record<string, unknown>;
    const current = settings as Record<string, unknown>;
    return Object.keys(base).filter(key => JSON.stringify(current[key] ?? null) !== JSON.stringify(base[key] ?? null)).length;
  });

  const defaultRows = $derived.by((): Array<{ tab: CollectionSettingsTab; label: string; value: string; set: boolean }> => {
    const headerCount = activeCount(headers);
    const variableCount = activeCount(variables);
    const preLines = scriptLineCount(activePre);
    const testLines = scriptLineCount(activeTest);
    const authSet = auth.type !== 'none' && auth.type !== 'inherit';
    return [
      { tab: 'headers', label: 'Headers', value: headerCount ? plural(headerCount, 'header') : 'None', set: headerCount > 0 },
      { tab: 'vars', label: 'Variables', value: variableCount ? plural(variableCount, 'variable') : 'None', set: variableCount > 0 },
      { tab: 'auth', label: 'Auth', value: authSet ? (AUTH_OPTIONS.find(option => option.value === auth.type)?.label ?? auth.type) : 'None', set: authSet },
      { tab: 'script', label: 'Pre-request script', value: preLines ? plural(preLines, 'line') : 'None', set: preLines > 0 },
      { tab: 'tests', label: 'Tests', value: testLines ? plural(testLines, 'line') : 'None', set: testLines > 0 },
      { tab: 'proxy', label: 'Proxy and settings', value: settings.proxyUrl?.trim() ? `Proxy ${settings.proxyUrl.trim()}` : changedSettingsCount ? `${plural(changedSettingsCount, 'setting')} changed` : 'Defaults', set: Boolean(settings.proxyUrl?.trim()) || changedSettingsCount > 0 },
    ];
  });

  async function reset() {
    if (!collection || savingInFlight) return;
    savingInFlight = true;
    try {
      if (isFolder) {
        const didResetFolder = await onResetFolder(collection.id, folderPath);
        if (!didResetFolder) return;
        const empty = emptyFolderDefaults(folderPath);
        folderId = empty.id;
        headers = restoreRows([]);
        auth = { ...empty.auth };
        preRequestScript = '';
        testScript = '';
        preRequestScriptJs = '';
        testScriptJs = '';
        loadedFingerprint = incomingFingerprint(collection);
        externalUpdate = false;
        return;
      }
      const didReset = await onReset(collection.id);
      if (!didReset) return;
      const defaults = emptyCollectionDefaults();
      headers = restoreRows(defaults.headers);
      variables = restoreRows(defaults.variables);
      auth = { ...defaults.auth };
      preRequestScript = '';
      testScript = '';
      settings = { ...defaults.settings };
      loadedFingerprint = collectionSettingsFingerprint(collection);
      externalUpdate = false;
    } finally {
      savingInFlight = false;
    }
  }
</script>

<svelte:document onpointerdowncapture={closeMoreMenuOnOutsidePointer} onkeydowncapture={closeMoreMenuOnEscape} />

<section class="collection-workspace">
  {#if collection}
    <div class="collection-workspace-head">
      <div class="overview-title">
        {#if isFolder}
          <h1>{folderName}</h1>
          <p>Folder in {[collection.name, ...folderPath.slice(0, -1)].join(' / ')} · {folderRequestCount} request{folderRequestCount === 1 ? '' : 's'} · applies to every request inside, subfolders included</p>
        {:else}
          {#if renaming}
            <input
              class="field overview-name-input"
              bind:this={nameInput}
              bind:value={nameDraft}
              onkeydown={onNameKeydown}
              onblur={() => finishRename(true)}
              aria-label="Collection name"
              spellcheck="false"
            />
          {:else}
            <h1>
              <button class="overview-name" type="button" onclick={startRename} disabled={workspaceBlocked} aria-label={`Rename collection ${name}`}>
                <span>{name}</span>
                <MenuIcon name="rename" />
              </button>
            </h1>
          {/if}
          <p>{requestCount} request{requestCount === 1 ? '' : 's'} · defaults are applied when requests are sent</p>
        {/if}
        {#if lastRun && !isFolder}
          <p class="collection-last-run">
            <span class="collection-last-run-dot" class:fail={lastRun.failed > 0} aria-hidden="true"></span>
            <button class="btn-link collection-last-run-link" type="button" onclick={() => onOpenRunner(collection.id)} disabled={workspaceBlocked}>Last run {relativeTime(lastRun.finishedAt, now())}</button>
            · {lastRun.passed} of {lastRun.total} passed{#if lastRun.failed} · {lastRun.failed} failed{/if}
          </p>
        {/if}
      </div>
      <div class="overview-actions">
        {#if externalUpdate}
          <span class="env-save-indicator">Updated elsewhere</span>
          <button class="btn btn-secondary" type="button" onclick={() => loadCollection(collection)} disabled={workspaceBlocked}>Reload</button>
        {:else if autosave && saveState !== 'idle'}
          <span class="env-save-indicator" class:saved={saveState === 'saved'}>{saveState === 'saving' ? 'Saving changes…' : 'Saved'}</span>
        {/if}
        {#if !isFolder}
          <button class="btn btn-secondary" type="button" onclick={() => onOpenRunner(collection.id)} disabled={workspaceBlocked || requestCount === 0}><MenuIcon name="play" />Run</button>
        {/if}
        <button class="btn btn-secondary" type="button" onclick={() => (isFolder ? onCreateRequestInFolder(collection.id, folderPath) : onCreateRequest(collection.id))} disabled={workspaceBlocked}><AddCloseIcon add /> New request</button>
        {#if !autosave}
          <button class="btn btn-primary" class:feedback-ok={saved} type="button" onclick={save} disabled={workspaceBlocked}>{saved ? 'Saved' : 'Save'}</button>
        {/if}
        <div class="env-more" bind:this={moreMenuRoot} onfocusout={closeMoreMenuOnFocusOut}>
          <button class="btn btn-ghost btn-icon env-more-btn" bind:this={moreMenuButton} type="button" aria-label={isFolder ? 'More folder actions' : 'More collection actions'} aria-haspopup="menu" aria-expanded={moreMenuOpen} onclick={() => (moreMenuOpen = !moreMenuOpen)} disabled={workspaceBlocked}>•••</button>
          {#if moreMenuOpen}
            <div class="menu request-menu env-more-menu" role="menu">
              {#if !isFolder}
                <button class="menu-item" type="button" role="menuitem" onclick={() => runMenuAction(() => onExport(collection.id))}><MenuIcon name="export" />Export…</button>
              {/if}
              <button class="menu-item" type="button" role="menuitem" onclick={() => runMenuAction(reset)}><MenuIcon name="restore" />Reset defaults</button>
              {#if !isFolder}
                <div class="menu-separator" role="separator"></div>
                <button class="menu-item danger" type="button" role="menuitem" onclick={() => runMenuAction(() => onDelete(collection.id))}><MenuIcon name="trash" />Delete collection</button>
              {/if}
            </div>
          {/if}
        </div>
      </div>
    </div>

    <div class="collection-settings-shell">
      <div class="tab-bar tabs collection-tabs" role="tablist" use:tabListKeyboard>
        {#if !isFolder}
        <button class="tab" role="tab" class:active={collectionSettingsTab === 'overview'} aria-selected={collectionSettingsTab === 'overview'} tabindex={collectionSettingsTab === 'overview' ? 0 : -1} type="button" onclick={() => (collectionSettingsTab = 'overview')}>Overview</button>
        {/if}
        <button class="tab" role="tab" class:active={collectionSettingsTab === 'headers'} aria-selected={collectionSettingsTab === 'headers'} tabindex={collectionSettingsTab === 'headers' ? 0 : -1} type="button" onclick={() => (collectionSettingsTab = 'headers')}>Headers{#if activeCount(headers) > 0}<span class="badge">{activeCount(headers)}</span>{/if}</button>
        {#if !isFolder}
        <button class="tab" role="tab" class:active={collectionSettingsTab === 'vars'} aria-selected={collectionSettingsTab === 'vars'} tabindex={collectionSettingsTab === 'vars' ? 0 : -1} type="button" onclick={() => (collectionSettingsTab = 'vars')}>Vars{#if activeCount(variables) > 0}<span class="badge">{activeCount(variables)}</span>{/if}</button>
        {/if}
        <button class="tab" role="tab" class:active={collectionSettingsTab === 'auth'} aria-selected={collectionSettingsTab === 'auth'} tabindex={collectionSettingsTab === 'auth' ? 0 : -1} type="button" onclick={() => (collectionSettingsTab = 'auth')}>Auth{#if auth.type !== 'none' && auth.type !== 'inherit'}<span class="badge badge-on">On</span>{/if}</button>
        <button class="tab" role="tab" class:active={collectionSettingsTab === 'script'} aria-selected={collectionSettingsTab === 'script'} tabindex={collectionSettingsTab === 'script' ? 0 : -1} type="button" onclick={() => (collectionSettingsTab = 'script')}>Script{#if scriptLineCount(activePre) > 0}<span class="badge badge-on">{scriptLineCount(activePre)} lines</span>{/if}</button>
        <button class="tab" role="tab" class:active={collectionSettingsTab === 'tests'} aria-selected={collectionSettingsTab === 'tests'} tabindex={collectionSettingsTab === 'tests' ? 0 : -1} type="button" onclick={() => (collectionSettingsTab = 'tests')}>Tests{#if scriptLineCount(activeTest) > 0}<span class="badge badge-on">{scriptLineCount(activeTest)} lines</span>{/if}</button>
        {#if !isFolder}
        <button class="tab" role="tab" class:active={collectionSettingsTab === 'proxy'} aria-selected={collectionSettingsTab === 'proxy'} tabindex={collectionSettingsTab === 'proxy' ? 0 : -1} type="button" onclick={() => (collectionSettingsTab = 'proxy')}>Proxy</button>
        {/if}
      </div>

      <div class="collection-settings-content">
        {#if collectionSettingsTab === 'overview'}
          <div class="collection-overview-grid">
            <div class="collection-overview-main">
              <section class="overview-section" aria-labelledby="collection-docs-title">
                <div class="overview-section-head">
                  <h2 id="collection-docs-title">Documentation</h2>
                  {#if editingDocs}
                    <button class="btn btn-secondary btn-sm" type="button" onclick={() => (editingDocs = false)}>Done</button>
                  {:else if !editingDocs && description.trim()}
                    <button class="btn btn-ghost btn-sm" type="button" onclick={editDocs} disabled={workspaceBlocked}><MenuIcon name="rename" />Edit</button>
                  {/if}
                </div>
                {#if editingDocs}
                  <textarea
                    class="field field-area collection-docs-input"
                    bind:this={docsInput}
                    value={description}
                    oninput={(event) => (description = inputValue(event))}
                    onkeydown={onDocsKeydown}
                    aria-label="Documentation"
                    placeholder={'# What this collection covers\n\nAuth, base URLs, conventions, links to the API docs.'}
                    spellcheck="false"
                    disabled={workspaceBlocked}
                  ></textarea>
                  {#if markdownTooLongToPreview(description)}
                    <p class="overview-readme-hint error" role="alert">Documentation is {markdownSizeLabel(description)}. Kurlo saves it, but only previews documentation up to 256 KB.</p>
                  {:else}
                    <p class="overview-readme-hint">Markdown. Saved with the collection.</p>
                  {/if}
                {:else if description.trim()}
                  <CollapsibleMarkdown source={description} resetKey={loadedCollectionId} />
                {:else}
                  <div class="overview-readme-empty">
                    <p>Auth, base URLs, conventions, links to the API docs — what someone needs before sending these requests.</p>
                    <button class="btn btn-secondary btn-sm" type="button" onclick={editDocs} disabled={workspaceBlocked}><AddCloseIcon add /> Write documentation</button>
                  </div>
                {/if}
              </section>

              <section class="overview-section collection-environments" aria-labelledby="collection-environments-title">
                <div class="overview-section-head">
                  <h2 id="collection-environments-title">Environments</h2>
                </div>
                {#if environments.length}<p class="collection-environments-hint">{pinnedEnvironmentCount ? 'The switcher lists only these while you work here. Opening the collection selects the default.' : 'Pin environments to list only them in the switcher while you work in this collection.'}</p>{/if}
                {#if environments.length}
                  {#if pinnedEnvironments.length}
                    <div class="collection-environment-list" role="list" aria-label="Pinned environments">
                      {#each pinnedEnvironments as environment (environment.id)}
                        <div class="collection-environment-row" role="listitem">
                          <span class="collection-environment-name">{environment.name}</span>
                          <span class="collection-environment-actions">
                            {#if environment.id === effectiveDefaultEnvironmentId}
                              <span class="collection-environment-default">Default</span>
                            {:else}
                              <button class="btn btn-ghost btn-sm" type="button" onclick={() => (defaultEnvironmentId = environment.id)} disabled={workspaceBlocked}>Set as default</button>
                            {/if}
                            <button class="btn btn-ghost btn-icon btn-sm" type="button" onclick={() => togglePinnedEnvironment(environment.id, false)} aria-label={`Unpin ${environment.name}`} disabled={workspaceBlocked}><AddCloseIcon /></button>
                          </span>
                        </div>
                      {/each}
                    </div>
                  {/if}
                  {#if unpinnedEnvironmentOptions.length}
                    <SearchPicker
                      className="collection-environment-picker"
                      options={unpinnedEnvironmentOptions}
                      placeholder={pinnedEnvironments.length ? 'Pin another environment…' : 'Pin an environment…'}
                      searchPlaceholder="Search environments"
                      ariaLabel="Pin environment"
                      emptyText="No environment matches."
                      disabled={workspaceBlocked}
                      onChoose={pinEnvironment}
                    />
                  {/if}
                {:else}
                  <p class="collection-environment-empty">This workspace has no environments yet.</p>
                {/if}
              </section>
            </div>

            <aside class="overview-section collection-defaults" aria-labelledby="collection-defaults-title">
              <h2 id="collection-defaults-title">Applied to every request</h2>
              <div class="overview-list">
                {#each defaultRows as row (row.tab)}
                  <button class="overview-row collection-default-row" type="button" onclick={() => (collectionSettingsTab = row.tab)}>
                    <span class="overview-row-name">{row.label}</span>
                    <span class="collection-default-value" class:set={row.set}>{row.value}</span>
                    <svg class="collection-default-chevron" width="0.75rem" height="0.75rem" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg>
                  </button>
                {/each}
              </div>
              <p class="collection-defaults-hint">Every request here inherits these. A request header with the same key, or the request's own auth, wins; collection scripts run before the request's.</p>
            </aside>
          </div>
        {:else if collectionSettingsTab === 'headers'}
          <div class="request-section-bar">
            <span class="request-section-title">Default headers</span>
            <span class="request-section-meta">{isFolder ? 'Added to every request in this folder; they override the collection and parent folders, and a request header with the same key overrides them' : 'Request headers with the same key override these defaults'}</span>
          </div>
          <div class="kv-table collection-kv-table" style="--kw: 13.75rem; --vw: 16.25rem">
            <div class="kv-head">
              <span></span>
              <span class="kv-head-cell">Key</span>
              <span class="kv-head-cell">Value</span>
              <span class="kv-head-cell">Description</span>
              <span></span>
            </div>
            {#each headers as row, i (row.id)}
              <div class="kv-row" class:inactive-row={!row.enabled && (row.key || row.value || row.description)}>
                <input type="checkbox" class="check" bind:checked={row.enabled} aria-label="Enable header" disabled={!row.key && !row.value} />
                <VariableInput className="field field-bare kv-input" bind:value={row.key} suggestions={variableSuggestions} placeholder="Header" pickerOptions={HEADER_PICKER_NAMES} pickerLabel="Header names" oninput={() => guardTrailing(headers, i)} />
                <VariableInput className="field field-bare kv-input" bind:value={row.value} suggestions={variableSuggestions} placeholder="Value" pickerOptions={getHeaderValues(row.key)} pickerLabel="Header values" oninput={() => guardTrailing(headers, i)} />
                <input class="field field-bare kv-input kv-desc" bind:value={row.description} placeholder="Description" />
                <button class="btn btn-ghost btn-icon btn-sm kv-del" type="button" onclick={() => removeRow(headers, i)} aria-label="Remove header">✕</button>
              </div>
            {/each}
          </div>
        {:else if collectionSettingsTab === 'vars'}
          <div class="request-section-bar">
            <span class="request-section-title">Collection variables</span>
            <span class="request-section-meta">Use as {'{{variableName}}'}; active environment values take precedence</span>
          </div>
          <div class="environment-editor-card collection-vars-card">
            <div class="kv-head env-kv-head">
              <span></span>
              <span>Variable</span>
              <span>Type</span>
              <span>Value</span>
              <span>Description</span>
              <span></span>
            </div>
            {#each variables as row, i (row.id)}
              <div class="kv-row env-kv-row" class:inactive-row={!row.enabled && (row.key || row.value || row.description)}>
                <input type="checkbox" class="check" bind:checked={row.enabled} aria-label="Enable variable" disabled={!row.key && !row.value} />
                <input class="field field-bare kv-input" bind:value={row.key} placeholder="baseUrl" oninput={() => guardTrailing(variables, i)} spellcheck="false" />
                <button class="env-type-toggle" class:secret={row.secret} type="button" onclick={() => (row.secret = !row.secret)} disabled={!row.key && !row.value}>{row.secret ? 'Secret' : 'Default'}</button>
                <input class="field field-bare kv-input" type={row.secret ? 'password' : 'text'} bind:value={row.value} placeholder="https://api.example.com" oninput={() => guardTrailing(variables, i)} spellcheck="false" autocomplete="off" />
                <input class="field field-bare kv-input kv-desc" bind:value={row.description} placeholder="Description" />
                <button class="btn btn-ghost btn-icon btn-sm kv-del" type="button" onclick={() => removeRow(variables, i)} aria-label="Remove variable">✕</button>
              </div>
            {/each}
          </div>
        {:else if collectionSettingsTab === 'auth'}
          <div class="auth-section collection-auth-section">
            <div class="auth-type-column">
              <span class="field-label">Auth type</span>
              <div class="auth-select">
                <button class="field select-trigger auth-select-trigger" type="button" onclick={() => (authMenuOpen = !authMenuOpen)} aria-label="Auth type" aria-expanded={authMenuOpen}>
                  <span>{authOptions.find(option => option.value === auth.type)?.label ?? 'No auth'}</span>
                  <svg width="0.625rem" height="0.4375rem" viewBox="0 0 10 7" fill="none" aria-hidden="true"><path d="M1.5 2L5 5.5L8.5 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
                </button>
                {#if authMenuOpen}
                  <div class="menu auth-select-menu">
                    {#each authOptions as option, eachIndex (eachIndex)}
                      <button class="menu-item" class:active={auth.type === option.value} type="button" onclick={() => { auth.type = option.value; authMenuOpen = false; }}>
                        {#if auth.type === option.value}<span class="auth-check">✓</span>{:else}<span class="auth-check"></span>{/if}
                        <span>{option.label}</span>
                      </button>
                    {/each}
                  </div>
                {/if}
              </div>
            </div>
            <div class="auth-fields">
              {#if auth.type === 'bearer'}
                <label class="field-label" for="collection-bearer-token">Token</label>
                <input id="collection-bearer-token" class="field field-input field-mono" type="password" bind:value={auth.bearerToken} placeholder="Bearer token" spellcheck="false" />
              {:else if auth.type === 'basic' || auth.type === 'digest' || auth.type === 'ntlm'}
                <label class="field-label" for="collection-auth-user">Username</label>
                <input id="collection-auth-user" class="field field-input" bind:value={auth.basicUser} spellcheck="false" />
                <label class="field-label" for="collection-auth-pass">Password</label>
                <input id="collection-auth-pass" class="field field-input" bind:value={auth.basicPass} type="password" />
              {:else if auth.type === 'apikey'}
                <label class="field-label" for="collection-apikey-name">Key name</label>
                <input id="collection-apikey-name" class="field field-input" bind:value={auth.apiKeyName} spellcheck="false" />
                <label class="field-label" for="collection-apikey-value">Key value</label>
                <input id="collection-apikey-value" class="field field-input field-mono" type="password" bind:value={auth.apiKeyValue} spellcheck="false" />
                <span class="field-label">Add to</span>
                <div class="segmented radio-group" role="radiogroup">
                  <label class="segmented-item radio-label"><input type="radio" bind:group={auth.apiKeyIn} value="header" /> Header</label>
                  <label class="segmented-item radio-label"><input type="radio" bind:group={auth.apiKeyIn} value="query" /> Query string</label>
                </div>
              {:else if auth.type === 'oauth2'}
                <label class="field-label" for="collection-oauth-url">Token URL</label>
                <input id="collection-oauth-url" class="field field-input" bind:value={auth.oauth2TokenURL} spellcheck="false" />
                <label class="field-label" for="collection-oauth-id">Client ID</label>
                <input id="collection-oauth-id" class="field field-input" bind:value={auth.oauth2ClientID} spellcheck="false" />
                <label class="field-label" for="collection-oauth-secret">Client secret</label>
                <input id="collection-oauth-secret" class="field field-input" bind:value={auth.oauth2Secret} type="password" />
                <label class="field-label" for="collection-oauth-scope">Scope</label>
                <input id="collection-oauth-scope" class="field field-input" bind:value={auth.oauth2Scope} spellcheck="false" />
              {:else if auth.type === 'oauth1'}
                <div class="auth-grid-2">
                  <div>
                    <span class="field-label">Signature method</span>
                    <Select value={auth.oauth1SignatureMethod ?? 'HMAC-SHA1'} options={OAUTH1_SIGNATURE_OPTIONS} className="auth-field-select" ariaLabel="Signature method" onChange={value => (auth.oauth1SignatureMethod = value as OAuth1SignatureMethod)} />
                  </div>
                  <div>
                    <span class="field-label">Add parameters to</span>
                    <div class="segmented radio-group" role="radiogroup">
                      {#each [['header', 'Header'], ['query', 'Query'], ['body', 'Body']] as [value, label] (value)}
                        <label class="segmented-item radio-label"><input type="radio" checked={(auth.oauth1AddTo ?? 'header') === value} onchange={() => (auth.oauth1AddTo = value as OAuth1AddTo)} /> {label}</label>
                      {/each}
                    </div>
                  </div>
                  <div><label class="field-label" for="collection-oauth1-key">Consumer key</label><input id="collection-oauth1-key" class="field field-input field-mono" bind:value={auth.oauth1ConsumerKey} spellcheck="false" /></div>
                  {#if (auth.oauth1SignatureMethod ?? '').startsWith('RSA-')}
                    <div class="auth-grid-span"><label class="field-label" for="collection-oauth1-private-key">Private key (PEM)</label><textarea id="collection-oauth1-private-key" class="field field-input field-mono oauth2-key-input" bind:value={auth.oauth1PrivateKey} placeholder="-----BEGIN PRIVATE KEY-----" spellcheck="false"></textarea></div>
                  {:else}
                    <div><label class="field-label" for="collection-oauth1-secret">Consumer secret</label><input id="collection-oauth1-secret" class="field field-input field-mono" bind:value={auth.oauth1ConsumerSecret} type="password" /></div>
                  {/if}
                  <div><label class="field-label" for="collection-oauth1-token">Access token</label><input id="collection-oauth1-token" class="field field-input field-mono" bind:value={auth.oauth1Token} type="password" /></div>
                  {#if !(auth.oauth1SignatureMethod ?? '').startsWith('RSA-')}
                    <div><label class="field-label" for="collection-oauth1-token-secret">Token secret</label><input id="collection-oauth1-token-secret" class="field field-input field-mono" bind:value={auth.oauth1TokenSecret} type="password" /></div>
                  {/if}
                  <div><label class="field-label" for="collection-oauth1-realm">Realm</label><input id="collection-oauth1-realm" class="field field-input" bind:value={auth.oauth1Realm} spellcheck="false" /></div>
                </div>
              {:else if auth.type === 'aws'}
                <div class="auth-grid-2">
                  <div><label class="field-label" for="collection-aws-key">Access key ID</label><input id="collection-aws-key" class="field field-input field-mono" bind:value={auth.awsAccessKey} spellcheck="false" /></div>
                  <div><label class="field-label" for="collection-aws-secret">Secret access key</label><input id="collection-aws-secret" class="field field-input field-mono" bind:value={auth.awsSecretKey} type="password" /></div>
                  <div><label class="field-label" for="collection-aws-region">Region</label><input id="collection-aws-region" class="field field-input" bind:value={auth.awsRegion} spellcheck="false" /></div>
                  <div><label class="field-label" for="collection-aws-service">Service</label><input id="collection-aws-service" class="field field-input" bind:value={auth.awsService} spellcheck="false" /></div>
                </div>
              {:else if auth.type === 'inherit'}
                <p class="auth-none-hint">Requests in this folder that inherit auth take it from {parentAuthSource}.</p>
              {:else if isFolder}
                <p class="auth-none-hint">Requests in this folder that inherit auth are sent without auth, whatever the collection sets.</p>
              {:else}
                <p class="auth-none-hint">Requests in this collection use their own auth unless a default is configured here.</p>
              {/if}
            </div>
          </div>
        {:else if collectionSettingsTab === 'script'}
          <div class="script-section collection-script-section">
            <div class="script-head"><span class="script-hint">{engineLabel} · {isFolder ? 'runs after the collection and parent folder scripts, before each request’s own pre-request script' : 'runs before each request\'s own pre-request script'}</span></div>
            {#if scriptEngine === 'js'}
              <CodeEditor bind:value={preRequestScriptJs} language="javascript" placeholder={'// Collection pre-request script (JavaScript) pm.variables.set("traceId", "kurlo-001")'} minHeight="17.5rem" maxHeight="32.5rem" />
            {:else}
              <CodeEditor bind:value={preRequestScript} language="javascript" placeholder={'// Collection pre-request script (Tengo) pm.variables.set("traceId", "kurlo-001")'} minHeight="17.5rem" maxHeight="32.5rem" />
            {/if}
          </div>
        {:else if collectionSettingsTab === 'tests'}
          <div class="script-section collection-script-section">
            <div class="script-head"><span class="script-hint">{engineLabel} · {isFolder ? 'runs after each request’s own test script, before the parent folder and collection tests' : 'runs after each request\'s own test script, after the response arrives'}</span></div>
            {#if scriptEngine === 'js'}
              <CodeEditor bind:value={testScriptJs} language="javascript" placeholder={'// Collection test script (JavaScript) pm.test("No server error", () => pm.expect(pm.response.code).to.be.below(500))'} minHeight="17.5rem" maxHeight="32.5rem" />
            {:else}
              <CodeEditor bind:value={testScript} language="javascript" placeholder={'// Collection test script (Tengo) pm.test("No server error", pm.response.code < 500)'} minHeight="17.5rem" maxHeight="32.5rem" />
            {/if}
          </div>
        {:else if collectionSettingsTab === 'proxy'}
          <div class="settings-section collection-proxy-section">
            <div class="settings-list">
              <label class="postman-setting">
                <span class="setting-copy"><strong>HTTP version</strong><span>Used when a request keeps its default HTTP version.</span></span>
                <Select bind:value={settings.httpVersion} options={HTTP_VERSION_OPTIONS} className="setting-select" />
              </label>
              <label class="postman-setting">
                <span class="setting-copy"><strong>Enable SSL certificate verification</strong><span>Verify TLS certificates by default for this collection.</span></span>
                <span class="switch-control"><input type="checkbox" bind:checked={settings.enableSSLVerification} /><span class="switch-track"></span><span class="switch-state">{settings.enableSSLVerification ? 'ON' : 'OFF'}</span></span>
              </label>
              <label class="postman-setting">
                <span class="setting-copy"><strong>Automatically follow redirects</strong><span>Follow HTTP 3xx responses unless a request overrides it.</span></span>
                <span class="switch-control"><input type="checkbox" bind:checked={settings.followRedirects} /><span class="switch-track"></span><span class="switch-state">{settings.followRedirects ? 'ON' : 'OFF'}</span></span>
              </label>
              <label class="postman-setting">
                <span class="setting-copy"><strong>Maximum number of redirects</strong><span>Stop following redirects after this many hops.</span></span>
                <input class="field setting-number" type="number" value={settings.maxRedirects} min="0" max="50" step="1" disabled={!settings.followRedirects} oninput={(event) => (settings.maxRedirects = inputNumber(event))} />
              </label>
              <label class="postman-setting">
                <span class="setting-copy"><strong>Request timeout</strong><span>Abort requests when they take longer than this value.</span></span>
                <span class="setting-inline-number"><input class="field setting-number" type="number" value={settings.timeoutMs} min="0" step="1000" oninput={(event) => (settings.timeoutMs = inputNumber(event))} /><span>ms</span></span>
              </label>
              <label class="postman-setting">
                <span class="setting-copy"><strong>Script timeout</strong><span>How long a pre-request or test script may run. 0 keeps the 2000 ms default.</span></span>
                <span class="setting-inline-number"><input class="field setting-number" type="number" value={settings.scriptTimeoutMs} min="0" max="60000" step="500" oninput={(event) => (settings.scriptTimeoutMs = inputNumber(event))} /><span>ms</span></span>
              </label>
              <label class="postman-setting">
                <span class="setting-copy"><strong>Allow pm.sendRequest</strong><span>Let scripts in this collection make their own HTTP calls. Off means the sandbox has no network.</span></span>
                <span class="switch-control"><input type="checkbox" bind:checked={settings.allowSendRequest} /><span class="switch-track"></span><span class="switch-state">{settings.allowSendRequest ? 'ON' : 'OFF'}</span></span>
              </label>
              <label class="postman-setting">
                <span class="setting-copy"><strong>HTTP proxy</strong><span>Route requests through a proxy. Leave empty to use system proxy settings.</span></span>
                <input class="field field-mono kv-input setting-proxy" type="text" placeholder="http://localhost:8080" bind:value={settings.proxyUrl} spellcheck="false" autocomplete="off" />
              </label>
              <div class="postman-setting client-cert-setting">
                <span class="setting-copy">
                  <strong>Client certificate (mTLS)</strong>
                  <span>Presented by every request in this collection that does not set its own.</span>
                </span>
                <div class="client-cert-fields">
                  <div class="client-cert-row">
                    <span class="client-cert-label">Certificate (CRT/PEM)</span>
                    {#if settings.clientCertPath}
                      <span class="client-cert-path">{settings.clientCertPath}</span>
                      <button class="btn btn-secondary" type="button" onclick={() => clearCollectionCertField('clientCertPath')}>Clear</button>
                    {:else}
                      <button class="btn btn-secondary" type="button" onclick={() => pickCollectionCertFile('clientCertPath')}>Choose file…</button>
                    {/if}
                  </div>
                  <div class="client-cert-row">
                    <span class="client-cert-label">Private key (optional)</span>
                    {#if settings.clientKeyPath}
                      <span class="client-cert-path">{settings.clientKeyPath}</span>
                      <button class="btn btn-secondary" type="button" onclick={() => clearCollectionCertField('clientKeyPath')}>Clear</button>
                    {:else}
                      <button class="btn btn-secondary" type="button" onclick={() => pickCollectionCertFile('clientKeyPath')} disabled={!settings.clientCertPath}>Choose file…</button>
                    {/if}
                  </div>
                  <div class="client-cert-row">
                    <span class="client-cert-label">Key passphrase</span>
                    <input
                      class="field field-input client-cert-pass"
                      type="password"
                      placeholder="Leave blank if the key is unencrypted"
                      autocomplete="off"
                      spellcheck="false"
                      bind:value={settings.clientKeyPassword}
                      disabled={!settings.clientCertPath}
                    />
                  </div>
                  <p class="client-cert-hint">The key file defaults to the certificate file when left blank (combined PEM). Use <code>&#123;&#123;variable&#125;&#125;</code> in the passphrase to keep it in workspace secrets.</p>
                </div>
              </div>
              <label class="postman-setting">
                <span class="setting-copy"><strong>Browser request emulation</strong><span>Send browser-like Origin, User-Agent, and Sec-Fetch headers by default.</span></span>
                <span class="switch-control"><input type="checkbox" bind:checked={settings.browserEmulation} /><span class="switch-track"></span><span class="switch-state">{settings.browserEmulation ? 'ON' : 'OFF'}</span></span>
              </label>
              <label class="postman-setting">
                <span class="setting-copy"><strong>Browser origin</strong><span>Default page origin for CORS and CSP checks.</span></span>
                <input class="field field-mono kv-input setting-proxy" type="text" placeholder="http://localhost:5173" bind:value={settings.browserOrigin} spellcheck="false" autocomplete="off" />
              </label>
              <label class="postman-setting">
                <span class="setting-copy"><strong>Include browser credentials</strong><span>Require credentialed CORS rules by default.</span></span>
                <span class="switch-control"><input type="checkbox" bind:checked={settings.browserWithCredentials} /><span class="switch-track"></span><span class="switch-state">{settings.browserWithCredentials ? 'ON' : 'OFF'}</span></span>
              </label>
              <label class="postman-setting">
                <span class="setting-copy"><strong>Enforce CORS</strong><span>Run browser-style preflight and response checks by default.</span></span>
                <span class="switch-control"><input type="checkbox" bind:checked={settings.browserEnforceCORS} /><span class="switch-track"></span><span class="switch-state">{settings.browserEnforceCORS ? 'ON' : 'OFF'}</span></span>
              </label>
              <label class="postman-setting">
                <span class="setting-copy"><strong>Enforce CSP connect-src</strong><span>Block requests that the page policy would reject.</span></span>
                <span class="switch-control"><input type="checkbox" bind:checked={settings.browserEnforceCSP} /><span class="switch-track"></span><span class="switch-state">{settings.browserEnforceCSP ? 'ON' : 'OFF'}</span></span>
              </label>
              <label class="postman-setting postman-setting-tall">
                <span class="setting-copy"><strong>CSP policy</strong><span>Default page Content-Security-Policy for connect-src checks.</span></span>
                <textarea class="field field-area setting-textarea" bind:value={settings.browserCSP} spellcheck="false"></textarea>
              </label>
              <label class="postman-setting">
                <span class="setting-copy"><strong>Disable cookie jar</strong><span>Prevent cookies from being stored and reused by default.</span></span>
                <span class="switch-control"><input type="checkbox" bind:checked={settings.disableCookieJar} /><span class="switch-track"></span><span class="switch-state">{settings.disableCookieJar ? 'ON' : 'OFF'}</span></span>
              </label>
            </div>
          </div>
        {/if}
      </div>
    </div>
  {:else}
    <div class="empty-state environment-empty-main">
      <span class="empty-state-title">No collection selected</span>
      <small class="empty-state-text">Open a collection from the sidebar to edit its defaults.</small>
    </div>
  {/if}
</section>
