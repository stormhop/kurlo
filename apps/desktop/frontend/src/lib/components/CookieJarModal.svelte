<script lang="ts">
  import AddCloseIcon from './AddCloseIcon.svelte';
  import { useClock } from '../clock.svelte';
  const now = useClock();
  import { openExternalURL } from '../externalLinks';
  import { getAppInfo, installBrowserExtension } from '../backend';
  import type { BrowserExtensionResult } from '../backend';
  import { tabListKeyboard, trapFocus } from '../a11y';
  import type { CookieJarEntry, CookieSyncStatus } from '../backend';
  import Select from './Select.svelte';
  import {
    blankCookieForm,
    buildCookieDomainGroups,
    cookieExpiryLabel,
    cookieFormFromCookie,
    cookieFromForm,
    cookieIsExpired,
    cookieKey,
    normalizeCookieDomain,
    parseRawCookie,
    serializeCookie,
    cookieValueIsMissingSecret,
  } from '../cookieJar';
  import type { CookieForm } from '../cookieJar';

  type CookieDomainGroup = { domain: string; cookies: CookieJarEntry[] };

  let {
    cookies,
    loading,
    saving,
    error,
    defaultDomain,
    sync,
    syncUnreadable,
    syncBusy,
    syncError,
    syncCodeCopied,
    onRefresh,
    onSave,
    onDelete,
    onClear,
    onClose,
    onToggleSync,
    onAddSyncDomain,
    onRemoveSyncDomain,
    onRevokeSync,
    onApproveSync,
    onDenySync,
    onCopySyncCode,
    onSyncPortChange,
  }: {
    cookies: CookieJarEntry[];
    loading: boolean;
    saving: boolean;
    error: string;
    defaultDomain: string;
    sync: CookieSyncStatus;
    syncUnreadable: string[];
    syncBusy: boolean;
    syncError: string;
    syncCodeCopied: boolean;
    onRefresh: () => void;
    onSave: (cookie: CookieJarEntry) => Promise<void>;
    onDelete: (cookie: CookieJarEntry) => Promise<void>;
    onClear: () => Promise<void>;
    onClose: () => void;
    onToggleSync: () => Promise<void> | void;
    onAddSyncDomain: (domain: string) => Promise<void> | void;
    onRemoveSyncDomain: (domain: string) => Promise<void> | void;
    onRevokeSync: () => Promise<void> | void;
    onApproveSync: () => Promise<void> | void;
    onDenySync: () => Promise<void> | void;
    onCopySyncCode: () => Promise<void> | void;
    onSyncPortChange: (port: number) => void;
  } = $props();

  const COOKIE_SYNC_GUIDE_URL = 'https://kurlo.dev/docs/guides/cookies/#connecting-a-browser';

  let tab = $state<'manage' | 'sync'>('manage');
  let syncDomainInput = $state('');
  let domainFilter = $state('');
  let newDomainInput = $state('');
  let addingDomain = $state(false);
  let manualDomains = $state<string[]>([]);
  let activeDomain = $state('');
  let selectedKey = $state('');
  let originalKey = $state('');
  let editingDomain = $state('');
  let editorMode = $state<'fields' | 'raw'>('fields');
  let form = $state<CookieForm>(blankCookieForm(''));
  let rawCookieText = $state('');
  let localError = $state('');
  let draftCookieCounters = $state<Record<string, number>>({});
  let domainPage = $state(0);
  let cookieVisibleByDomain = $state<Record<string, number>>({});
  let pairingCodeShown = $state(false);

  const COOKIE_DOMAIN_PAGE_SIZE = 25;
  const COOKIE_ROW_PAGE_SIZE = 50;
  const SAME_SITE_OPTIONS = [
    { value: '', label: 'Not set' },
    { value: 'lax', label: 'Lax' },
    { value: 'strict', label: 'Strict' },
    { value: 'none', label: 'None' },
  ];

  let allDomainGroups = $derived(buildCookieDomainGroups(cookies, manualDomains));
  let domainGroups = $derived(buildCookieDomainGroups(cookies, manualDomains, domainFilter));
  let domainPageCount = $derived(pageCount(domainGroups.length, COOKIE_DOMAIN_PAGE_SIZE));
  let visibleDomainGroups = $derived(domainGroups.slice(domainPage * COOKIE_DOMAIN_PAGE_SIZE, (domainPage + 1) * COOKIE_DOMAIN_PAGE_SIZE));
  let openRequestDomain = $derived(normalizeCookieDomain(defaultDomain));
  let currentGroup = $derived(
    allDomainGroups.find(group => group.domain === activeDomain)
    ?? allDomainGroups.find(group => group.domain === openRequestDomain)
    ?? allDomainGroups[0],
  );
  let currentCookies = $derived(currentGroup ? currentGroup.cookies.slice(0, cookieVisibleLimit(currentGroup.domain)) : []);
  let selectedCookie = $derived(cookies.find(cookie => cookieKey(cookie) === selectedKey));
  let visibleError = $derived(localError || error);
  let editorDomain = $derived(editingDomain || currentGroup?.domain || '');
  let editorOpen = $derived(Boolean(editingDomain));
  let editorFilled = $derived(editorMode === 'raw' ? Boolean(rawCookieText.trim()) : Boolean(form.name.trim()));
  let canSave = $derived(Boolean(editorDomain && editorFilled && !saving));
  let jarEmpty = $derived(!allDomainGroups.length);
  let syncDomains = $derived(sync.domains ?? []);
  let syncLog = $derived([...(sync.log ?? [])].reverse().slice(0, 6));
  let openRequestDomainListed = $derived(
    !openRequestDomain
    || syncDomains.some(listed => openRequestDomain === listed || openRequestDomain.endsWith(`.${listed}`)),
  );
  let syncPending = $derived(sync.pending?.id ? sync.pending : null);
  let syncHeadline = $derived(syncHeadlineFor(sync));
  let syncDetail = $derived(syncDetailFor(sync));

  function syncHeadlineFor(status: CookieSyncStatus): string {
    if (!status.running) return 'Cookie sync is off';
    if (status.pending?.id) return `${status.pending.browser} wants to connect`;
    if (status.connected) return `${status.browser || 'A browser'} is connected`;
    if (status.paired) return `${status.browser || 'A browser'} is paired but offline`;
    return 'Waiting for a browser';
  }

  function syncDetailFor(status: CookieSyncStatus): string {
    if (!status.running) {
      return 'Turn it on to let a browser extension push its cookies into this workspace.';
    }
    if (status.pending?.id) {
      return 'Check the code below matches the one in the extension, then let it in.';
    }
    if (status.connected) {
      if (status.lastSyncAt) {
        const count = status.lastSyncCount === 1 ? '1 cookie' : `${status.lastSyncCount} cookies`;
        return `${count} synced ${relativeTime(status.lastSyncAt)}.`;
      }
      return 'Live — cookie changes arrive as they happen.';
    }
    if (status.paired) {
      return 'The browser will reconnect on its own when it is open again.';
    }
    return `Listening on ${status.url} — install the extension and press Connect in it.`;
  }

  function relativeTime(timestamp: number): string {
    if (!timestamp) return '';
    const seconds = Math.max(0, Math.round((now() - timestamp) / 1000));
    if (seconds < 5) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return new Date(timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  async function addSyncDomain() {
    const value = syncDomainInput.trim();
    if (!value) return;
    await onAddSyncDomain(value);
    syncDomainInput = '';
  }

  let appVersion = $state('');
  let extensionSetup = $state<BrowserExtensionResult | null>(null);
  let extensionBusy = $state(false);
  let extensionPageCopied = $state(false);

  $effect(() => {
    if (tab === 'sync' && !appVersion) void getAppInfo().then(info => { appVersion = info.version; });
  });

  function versionParts(version: string): number[] {
    return (version.replace(/^v/, '').match(/^\d+(\.\d+)*/)?.[0] ?? '').split('.').filter(Boolean).map(Number);
  }

  function versionOlder(left: string, right: string): boolean {
    const a = versionParts(left);
    const b = versionParts(right);
    if (!a.length || !b.length) return false;
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
      const diff = (a[index] ?? 0) - (b[index] ?? 0);
      if (diff) return diff < 0;
    }
    return false;
  }

  let extensionOutdated = $derived(Boolean(sync.connected && sync.extensionVersion && appVersion && versionOlder(sync.extensionVersion, appVersion)));
  let extensionPage = $derived(extensionSetup?.browser === 'firefox' ? 'about:debugging#/runtime/this-firefox' : 'chrome://extensions');

  async function setUpExtension(browser: 'chromium' | 'firefox') {
    extensionBusy = true;
    try {
      extensionSetup = await installBrowserExtension(browser);
    } finally {
      extensionBusy = false;
    }
  }

  async function copyExtensionPage() {
    try {
      await navigator.clipboard.writeText(extensionPage);
      extensionPageCopied = true;
      setTimeout(() => (extensionPageCopied = false), 1600);
    } catch {}
  }

  function openSyncGuide() {
    openExternalURL(COOKIE_SYNC_GUIDE_URL);
  }

  $effect(() => {
    domainGroups.length;
    if (domainPage >= domainPageCount) domainPage = Math.max(0, domainPageCount - 1);
  });

  $effect(() => {
    if (selectedKey && !selectedCookie) {
      selectedKey = '';
      originalKey = '';
    }
  });

  function focusOnMount(node: HTMLElement) {
    queueMicrotask(() => node.focus());
  }

  function hasMissingValue(group: CookieDomainGroup): boolean {
    return group.cookies.some(cookie => cookieValueIsMissingSecret(cookie.value));
  }

  function cookieCountLabel(count: number): string {
    return `${count} cookie${count === 1 ? '' : 's'}`;
  }

  function selectDomain(domain: string) {
    const normalized = normalizeCookieDomain(domain);
    if (editingDomain && editingDomain !== normalized) cancelEdit();
    activeDomain = normalized;
    const index = domainGroups.findIndex(group => group.domain === normalized);
    if (index >= 0) domainPage = Math.floor(index / COOKIE_DOMAIN_PAGE_SIZE);
  }

  function pageCount(total: number, size: number): number {
    return Math.max(1, Math.ceil(total / size));
  }

  function rangeLabel(page: number, size: number, total: number): string {
    if (!total) return '0 of 0';
    const start = page * size + 1;
    const end = Math.min(total, (page + 1) * size);
    return `${start}–${end} of ${total}`;
  }

  function cookieVisibleLimit(domain: string): number {
    return cookieVisibleByDomain[normalizeCookieDomain(domain)] ?? COOKIE_ROW_PAGE_SIZE;
  }

  function showMoreCookies(domain: string, total: number) {
    const normalized = normalizeCookieDomain(domain);
    const current = cookieVisibleLimit(normalized);
    cookieVisibleByDomain = { ...cookieVisibleByDomain, [normalized]: Math.min(total, current + COOKIE_ROW_PAGE_SIZE) };
  }

  function startAddingDomain() {
    localError = '';
    addingDomain = true;
    newDomainInput = openRequestDomain && !allDomainGroups.some(group => group.domain === openRequestDomain) ? openRequestDomain : '';
  }

  function stopAddingDomain() {
    addingDomain = false;
    newDomainInput = '';
  }

  function addDomain(value = newDomainInput) {
    const domain = normalizeCookieDomain(value);
    if (!domain) {
      localError = 'Enter a domain name first.';
      return;
    }
    manualDomains = [...new Set([...manualDomains, domain])];
    domainFilter = '';
    stopAddingDomain();
    selectDomain(domain);
    addCookie(domain);
  }

  function addCookie(domain: string) {
    const normalizedDomain = normalizeCookieDomain(domain);
    const usedNames = new Set(cookies.filter(cookie => normalizeCookieDomain(cookie.domain) === normalizedDomain).map(cookie => cookie.name));
    let count = Math.max(usedNames.size, draftCookieCounters[normalizedDomain] ?? 0) + 1;
    while (usedNames.has(`Cookie_${count}`)) count += 1;
    draftCookieCounters = { ...draftCookieCounters, [normalizedDomain]: count };
    selectDomain(domain);
    selectedKey = '';
    originalKey = '';
    editingDomain = normalizedDomain;
    form = blankCookieForm(normalizedDomain, `Cookie_${count}`);
    rawCookieText = `Cookie_${count}=value; Path=/`;
    localError = '';
  }

  function selectCookie(cookie: CookieJarEntry) {
    selectDomain(cookie.domain);
    selectedKey = cookieKey(cookie);
    originalKey = cookieKey(cookie);
    editingDomain = normalizeCookieDomain(cookie.domain);
    form = cookieFormFromCookie(cookie);
    rawCookieText = serializeCookie(cookie);
    localError = '';
  }

  function cancelEdit() {
    selectedKey = '';
    originalKey = '';
    editingDomain = '';
    rawCookieText = '';
    form = blankCookieForm('');
    localError = '';
  }

  function switchEditorMode(mode: 'fields' | 'raw') {
    if (mode === editorMode) return;
    localError = '';
    try {
      if (mode === 'raw') {
        if (form.name.trim()) rawCookieText = serializeCookie(cookieFromForm(form, editorDomain));
      } else if (rawCookieText.trim()) {
        form = cookieFormFromCookie(parseRawCookie(rawCookieText, editorDomain));
      }
      editorMode = mode;
    } catch (err) {
      localError = err instanceof Error ? err.message : String(err);
    }
  }

  function editedCookie(): CookieJarEntry {
    return editorMode === 'raw' ? parseRawCookie(rawCookieText, editorDomain) : cookieFromForm(form, editorDomain);
  }

  async function saveCookie() {
    if (!canSave) return;
    localError = '';
    try {
      const next = editedCookie();
      if (selectedCookie && originalKey && originalKey !== cookieKey(next)) {
        await onDelete(selectedCookie);
      }
      await onSave(next);
      cancelEdit();
      manualDomains = manualDomains.filter(domain => normalizeCookieDomain(domain) !== normalizeCookieDomain(next.domain));
      selectDomain(next.domain);
    } catch (err) {
      localError = err instanceof Error ? err.message : String(err);
    }
  }

  function saveShortcut(node: HTMLElement) {
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void saveCookie();
      }
    };
    node.addEventListener('keydown', onKeydown);
    return { destroy: () => node.removeEventListener('keydown', onKeydown) };
  }

  async function deleteCookie(cookie: CookieJarEntry) {
    await onDelete(cookie);
    if (selectedKey === cookieKey(cookie)) cancelEdit();
  }

  async function deleteDomain(domain: string) {
    const domainCookies = cookies.filter(cookie => normalizeCookieDomain(cookie.domain) === normalizeCookieDomain(domain));
    for (const cookie of domainCookies) await onDelete(cookie);
    manualDomains = manualDomains.filter(item => normalizeCookieDomain(item) !== normalizeCookieDomain(domain));
    if (editingDomain === normalizeCookieDomain(domain)) cancelEdit();
    if (activeDomain === normalizeCookieDomain(domain)) activeDomain = '';
  }

  async function clearAll() {
    await onClear();
    manualDomains = [];
    activeDomain = '';
    cancelEdit();
    draftCookieCounters = {};
  }
</script>

<div class="cookie-backdrop" role="presentation" onmousedown={(event) => event.target === event.currentTarget && onClose()}>
  <div class="modal cookie-modal" role="dialog" aria-modal="true" aria-labelledby="cookie-jar-title" tabindex="-1" use:trapFocus>
    <div class="modal-head cookie-head">
      <h2 class="cookie-title" id="cookie-jar-title">Cookies</h2>
      <div class="segmented cookie-tabs" role="tablist" aria-label="Cookie jar sections" use:tabListKeyboard>
        <button
          class="segmented-item"
          class:active={tab === 'manage'}
          type="button"
          role="tab"
          aria-selected={tab === 'manage'}
          aria-controls="cookie-manage-panel"
          tabindex={tab === 'manage' ? 0 : -1}
          onclick={() => (tab = 'manage')}
        >Manage</button>
        <button
          class="segmented-item"
          class:active={tab === 'sync'}
          type="button"
          role="tab"
          aria-selected={tab === 'sync'}
          aria-controls="cookie-sync-panel"
          tabindex={tab === 'sync' ? 0 : -1}
          onclick={() => (tab = 'sync')}
        >
          Sync
          {#if sync.running}
            <span class="cookie-sync-dot" class:live={sync.connected} class:pending={Boolean(syncPending)} aria-hidden="true"></span>
          {/if}
        </button>
      </div>
      <span class="cookie-head-spacer"></span>
      {#if tab === 'manage'}
        <button class="btn btn-ghost" type="button" onclick={() => onRefresh()} disabled={loading}>Refresh</button>
        <button class="btn btn-ghost btn-danger" type="button" onclick={clearAll} disabled={(jarEmpty && !editorOpen) || loading || saving}>Clear all</button>
      {/if}
      <button class="btn btn-ghost btn-icon dialog-close" type="button" onclick={onClose} aria-label="Close cookie jar"><AddCloseIcon /></button>
    </div>

    {#if tab === 'sync'}
      <div class="cookie-sync-panel" id="cookie-sync-panel" role="tabpanel" tabindex="-1">
        {#if syncError}
          <div class="cookie-error" role="alert">{syncError}</div>
        {/if}

        <label class="cookie-sync-status" class:live={sync.connected} class:running={sync.running} class:pending={Boolean(syncPending)}>
          <span class="cookie-sync-indicator" aria-hidden="true"></span>
          <span class="cookie-sync-status-copy">
            <strong>{syncHeadline}</strong>
            <span>{syncDetail}</span>
          </span>
          <span class="switch-control">
            <input type="checkbox" role="switch" aria-label="Cookie sync" checked={sync.running} disabled={syncBusy} onchange={(event) => { (event.currentTarget as HTMLInputElement).checked = sync.running; void onToggleSync(); }} />
            <span class="switch-track"></span>
          </span>
        </label>

        {#if syncPending}
          <section class="cookie-sync-approval" aria-label="Connection request">
            <div class="cookie-sync-approval-copy">
              <strong>{syncPending.browser} asks to sync cookies</strong>
              <span>
                The extension shows this code — let it in only if the numbers match.
                {#if syncPending.extensionId}
                  <span class="cookie-sync-extension-id">Extension {syncPending.extensionId}</span>
                {/if}
              </span>
            </div>
            <span class="cookie-sync-approval-code">{syncPending.code}</span>
            <div class="cookie-sync-approval-actions">
              <button class="btn btn-secondary" type="button" onclick={onDenySync} disabled={syncBusy}>Deny</button>
              <button class="btn btn-primary" type="button" onclick={onApproveSync} disabled={syncBusy}>Allow</button>
            </div>
          </section>
        {/if}

        {#if extensionOutdated}
          <section class="cookie-sync-approval cookie-sync-outdated" role="status">
            <div class="cookie-sync-approval-copy">
              <strong>The extension is older than Kurlo</strong>
              <span>{sync.browser || 'The browser'} runs extension {sync.extensionVersion}, Kurlo is {appVersion}. Refresh its files, then press Reload on Kurlo Cookie Sync in the browser's extensions page.</span>
            </div>
            <div class="cookie-sync-approval-actions">
              <button class="btn btn-secondary" type="button" onclick={() => setUpExtension(sync.browser?.toLowerCase().includes('firefox') ? 'firefox' : 'chromium')} disabled={extensionBusy}>Refresh files</button>
            </div>
          </section>
        {/if}

        <section class="settings-block">
          <h3 class="settings-group-label">Domains the browser may share</h3>
          <div class="settings-group">
            <div class="settings-row cookie-sync-domains">
              <div class="cookie-sync-row">
                <input class="field"
                  bind:value={syncDomainInput}
                  placeholder="example.com"
                  spellcheck="false"
                  aria-label="Domain to share"
                  onkeydown={(event) => event.key === 'Enter' && addSyncDomain()}
                />
                <button class="btn btn-secondary" type="button" onclick={addSyncDomain} disabled={syncBusy}>Add domain</button>
              </div>
              {#if syncDomains.length || (openRequestDomain && !openRequestDomainListed)}
                <div class="cookie-sync-chips">
                  {#each syncDomains as domain (domain)}
                    <span class="cookie-sync-chip" class:unreadable={syncUnreadable.includes(domain)}>
                      {domain}
                      <button class="btn btn-ghost btn-icon btn-xs" type="button" aria-label="Stop syncing {domain}" onclick={() => onRemoveSyncDomain(domain)} disabled={syncBusy}><AddCloseIcon /></button>
                    </span>
                  {/each}
                  {#if openRequestDomain && !openRequestDomainListed}
                    <button class="btn btn-dashed btn-sm cookie-sync-suggest" type="button" onclick={() => onAddSyncDomain(openRequestDomain)} disabled={syncBusy}>
                      <AddCloseIcon add /> Add {openRequestDomain} from the open request
                    </button>
                  {/if}
                </div>
              {/if}
              {#if syncUnreadable.length}
                <p class="cookie-sync-hint cookie-sync-warning">
                  {sync.browser || 'The browser'} is not allowed to read {syncUnreadable.join(', ')} — open the extension
                  and press <em>Grant domain access</em>.
                </p>
              {:else if !syncDomains.length}
                <p class="cookie-sync-hint">Nothing is shared yet — the extension can only read the domains listed here.</p>
              {/if}
            </div>
          </div>
        </section>

        {#if !sync.paired || extensionSetup}
          <section class="settings-block">
            <h3 class="settings-group-label">Browser extension</h3>
            <div class="settings-group">
              {#if extensionSetup?.error}
                <div class="settings-row"><div class="cookie-error" role="alert">{extensionSetup.error}</div></div>
              {/if}
              <div class="settings-row">
                <div class="settings-row-text">
                  <span class="settings-row-title">Install the extension</span>
                  <span class="settings-row-desc">Kurlo ships it. Pick a browser and it puts the files in a folder you can load.</span>
                </div>
                <div class="settings-row-control">
                  <button class="btn btn-secondary" class:btn-primary={extensionSetup?.browser === 'chromium' && !extensionSetup.error} type="button" onclick={() => setUpExtension('chromium')} disabled={extensionBusy}>Chrome, Edge, Brave</button>
                  <button class="btn btn-secondary" class:btn-primary={extensionSetup?.browser === 'firefox' && !extensionSetup.error} type="button" onclick={() => setUpExtension('firefox')} disabled={extensionBusy}>Firefox</button>
                </div>
              </div>
              {#if extensionSetup && !extensionSetup.error}
                <div class="settings-row settings-row-block">
                  <ol class="cookie-sync-steps">
                    <li>
                      Open <code>{extensionPage}</code> in the browser
                      <button class="btn-link cookie-sync-link" type="button" onclick={copyExtensionPage}>{extensionPageCopied ? 'Copied' : 'Copy'}</button>
                    </li>
                    {#if extensionSetup.browser === 'firefox'}
                      <li>Press <strong>Load Temporary Add-on</strong> and pick <code>manifest.json</code> in the folder Kurlo just opened.</li>
                    {:else}
                      <li>Turn on <strong>Developer mode</strong>, press <strong>Load unpacked</strong> and pick the folder Kurlo just opened.</li>
                    {/if}
                    <li>Open the extension and press <strong>Connect</strong>.</li>
                  </ol>
                  <p class="cookie-sync-hint">
                    Version {extensionSetup.version} in <code class="cookie-sync-path">{extensionSetup.path}</code>. Kurlo keeps this folder in step with the app, so after an update the browser picks up the new version the next time it starts, or when you press Reload.
                  </p>
                </div>
              {/if}
            </div>
          </section>
        {/if}

        <section class="settings-block">
          <h3 class="settings-group-label">Connection</h3>
          <div class="settings-group">
            {#if sync.running}
              {#if sync.paired}
                <div class="settings-row">
                  <div class="settings-row-text">
                    <span class="settings-row-title">{sync.browser || 'A browser'}</span>
                    <span class="settings-row-desc">Holds a key to this jar{sync.extensionVersion ? ` · extension ${sync.extensionVersion}` : ''}.</span>
                  </div>
                  <div class="settings-row-control">
                    <button class="btn btn-secondary" type="button" onclick={onRevokeSync} disabled={syncBusy}>Disconnect</button>
                  </div>
                </div>
              {/if}
              <div class="settings-row">
                <div class="settings-row-text">
                  <span class="settings-row-title">Pair manually</span>
                  <span class="settings-row-desc">Only needed when the extension cannot find Kurlo by itself — a non-default port, say. The code carries the port and a secret, so treat it like a password.</span>
                </div>
                <div class="settings-row-control">
                  {#if pairingCodeShown}
                    <code class="cookie-sync-code">{sync.pairingCode}</code>
                    <button class="btn btn-secondary" type="button" onclick={onCopySyncCode}>{syncCodeCopied ? 'Copied' : 'Copy'}</button>
                    <button class="btn btn-ghost" type="button" onclick={() => (pairingCodeShown = false)}>Hide</button>
                  {:else}
                    <button class="btn btn-secondary" type="button" onclick={() => (pairingCodeShown = true)}>Show code</button>
                  {/if}
                </div>
              </div>
            {:else}
              <div class="settings-row">
                <div class="settings-row-text">
                  <span class="settings-row-title">Port</span>
                  <span class="settings-row-desc">The bridge only ever listens on 127.0.0.1.</span>
                </div>
                <div class="settings-row-control">
                  <input
                    class="field field-mono cookie-sync-port"
                    type="number"
                    min="1024"
                    max="65535"
                    value={sync.port || 3199}
                    oninput={(event) => onSyncPortChange(Number((event.currentTarget as HTMLInputElement).value))}
                    aria-label="Cookie sync port"
                  />
                </div>
              </div>
            {/if}
          </div>
        </section>

        {#if syncLog.length}
          <section class="settings-block">
            <h3 class="settings-group-label">Recent activity</h3>
            <ul class="settings-group cookie-sync-log">
              {#each syncLog as entry (entry.id)}
                <li>
                  <span class="cookie-sync-log-when">{relativeTime(entry.timestamp)}</span>
                  <span class="cookie-sync-log-what">
                    {entry.browser || 'Browser'} — {entry.message}{entry.domain ? ` · ${entry.domain}` : ''}
                  </span>
                </li>
              {/each}
            </ul>
          </section>
        {/if}

        <p class="cookie-sync-hint cookie-sync-footnote">
          A sync replaces whatever this jar held for those domains, so signing out in the browser clears the cookie
          here too.
          <button class="btn-link cookie-sync-link" type="button" onclick={openSyncGuide}>How to install the extension</button>
        </p>
      </div>
    {:else}
      <div class="cookie-manage" id="cookie-manage-panel" role="tabpanel">
        {#if loading && jarEmpty}
          <div class="empty-state cookie-empty-state" role="status">
            <p class="empty-state-text">Loading cookies…</p>
          </div>
        {:else if jarEmpty && !addingDomain}
          <div class="empty-state cookie-empty-state" role="status">
            <svg width="2.5rem" height="2.5rem" viewBox="0 0 32 32" fill="none" aria-hidden="true" opacity="0.5">
              <circle cx="16" cy="16" r="12" stroke="currentColor" stroke-width="1.5"/>
              <circle cx="11.5" cy="13" r="1.4" fill="currentColor"/>
              <circle cx="20" cy="13.5" r="1.4" fill="currentColor"/>
              <circle cx="15" cy="20" r="1.4" fill="currentColor"/>
            </svg>
            <p class="empty-state-title">No cookies yet</p>
            <p class="empty-state-text">Cookies appear here after a response sets one. You can also add one by hand or pull them in from your browser.</p>
            {#if visibleError}
              <div class="cookie-error" role="alert">{visibleError}</div>
            {/if}
            <div class="cookie-empty-actions">
              {#if openRequestDomain}
                <button class="btn btn-primary" type="button" onclick={() => addDomain(openRequestDomain)} data-autofocus><AddCloseIcon add /> Add cookie for {openRequestDomain}</button>
                <button class="btn btn-secondary" type="button" onclick={startAddingDomain}>Other domain…</button>
              {:else}
                <button class="btn btn-primary" type="button" onclick={startAddingDomain} data-autofocus><AddCloseIcon add /> Add cookie</button>
              {/if}
              <button class="btn btn-ghost" type="button" onclick={() => (tab = 'sync')}>Sync from browser</button>
            </div>
          </div>
        {:else}
          <aside class="cookie-domains" aria-label="Cookie domains">
            <div class="cookie-domains-top">
              <div class="field-wrap">
                <svg width="0.875rem" height="0.875rem" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 10.5 14 14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
                <input bind:value={domainFilter} placeholder="Filter domains" spellcheck="false" aria-label="Filter domains" />
              </div>
            </div>
            <div class="cookie-domains-label">
              <span>Domains · {allDomainGroups.length}</span>
              <button class="btn btn-ghost btn-icon btn-xs" type="button" onclick={startAddingDomain} aria-label="Add domain"><AddCloseIcon add /></button>
            </div>
            {#if addingDomain}
              <div class="cookie-domain-new">
                <input
                  class="field field-sm"
                  bind:value={newDomainInput}
                  placeholder="example.com"
                  spellcheck="false"
                  aria-label="New domain"
                  use:focusOnMount
                  onkeydown={(event) => {
                    if (event.key === 'Enter') { event.preventDefault(); addDomain(); }
                    if (event.key === 'Escape') { event.stopPropagation(); stopAddingDomain(); }
                  }}
                />
                <div class="cookie-domain-new-actions">
                  <button class="btn btn-ghost btn-sm" type="button" onclick={stopAddingDomain}>Cancel</button>
                  <button class="btn btn-primary btn-sm" type="button" onclick={() => addDomain()}>Add</button>
                </div>
              </div>
            {/if}
            <ul class="cookie-domain-list">
              {#each visibleDomainGroups as group (group.domain)}
                <li>
                  <button
                    class="cookie-domain-item"
                    class:active={currentGroup?.domain === group.domain}
                    class:draft={!group.cookies.length}
                    type="button"
                    aria-current={currentGroup?.domain === group.domain ? 'true' : undefined}
                    onclick={() => selectDomain(group.domain)}
                  >
                    <span class="cookie-domain-name">{group.domain}</span>
                    {#if hasMissingValue(group)}
                      <span class="cookie-domain-warning" aria-label="Has cookies without a value"></span>
                    {/if}
                    <span class="cookie-domain-count">{group.cookies.length}</span>
                  </button>
                </li>
              {:else}
                <li class="cookie-domain-none">No domains match “{domainFilter}”.</li>
              {/each}
            </ul>
            {#if domainPageCount > 1}
              <div class="cookie-domains-foot" aria-label="Cookie domain pages">
                <span>{rangeLabel(domainPage, COOKIE_DOMAIN_PAGE_SIZE, domainGroups.length)}</span>
                <span class="cookie-page-buttons">
                  <button class="btn btn-ghost btn-sm" type="button" onclick={() => (domainPage = Math.max(0, domainPage - 1))} disabled={domainPage === 0}>Prev</button>
                  <button class="btn btn-ghost btn-sm" type="button" onclick={() => (domainPage = Math.min(domainPageCount - 1, domainPage + 1))} disabled={domainPage + 1 >= domainPageCount}>Next</button>
                </span>
              </div>
            {/if}
          </aside>

          <section class="cookie-main" aria-label={currentGroup ? `Cookies for ${currentGroup.domain}` : 'Cookies'}>
            {#if currentGroup}
              <div class="cookie-main-head">
                <h3 class="cookie-main-title">{currentGroup.domain}</h3>
                <span class="cookie-main-count">{cookieCountLabel(currentGroup.cookies.length)}</span>
                <span class="cookie-head-spacer"></span>
                <button class="btn btn-ghost btn-danger btn-sm" type="button" onclick={() => deleteDomain(currentGroup.domain)} disabled={saving}>Delete domain</button>
                <button class="btn btn-primary btn-sm" type="button" onclick={() => addCookie(currentGroup.domain)}><AddCloseIcon add /> Add cookie</button>
              </div>

              {#if visibleError && !editorOpen}
                <div class="cookie-error cookie-main-error" role="alert">{visibleError}</div>
              {/if}

              <div class="cookie-table-scroll">
                {#if currentGroup.cookies.length}
                  <div class="cookie-table" role="table" aria-label="Cookies for {currentGroup.domain}">
                    <div class="cookie-table-head" role="row">
                      <span role="columnheader">Name</span>
                      <span role="columnheader">Value</span>
                      <span role="columnheader">Path</span>
                      <span role="columnheader">Expires</span>
                      <span role="columnheader">Flags</span>
                      <span role="columnheader"><span class="sr-only">Actions</span></span>
                    </div>
                    {#each currentCookies as cookie (cookieKey(cookie))}
                      {@const missing = cookieValueIsMissingSecret(cookie.value)}
                      {@const expired = cookieIsExpired(cookie, now())}
                      <div class="cookie-row" class:selected={cookieKey(cookie) === selectedKey} class:expired role="row">
                        <button class="cookie-row-main" type="button" onclick={() => selectCookie(cookie)} aria-label="Edit cookie {cookie.name}">
                          <span class="cookie-cell cookie-cell-name" role="cell">{cookie.name}</span>
                          <span class="cookie-cell cookie-cell-value" role="cell">
                            {#if missing}
                              <span class="tag tag-warning">no value</span>
                            {:else if cookie.value}
                              {cookie.value}
                            {:else}
                              <span class="cookie-cell-empty">empty</span>
                            {/if}
                          </span>
                          <span class="cookie-cell cookie-cell-path" role="cell">{cookie.path || '/'}</span>
                          <span class="cookie-cell cookie-cell-expires" role="cell">
                            {#if expired}
                              <span class="tag tag-danger">Expired</span>
                            {:else}
                              {cookieExpiryLabel(cookie, now())}
                            {/if}
                          </span>
                          <span class="cookie-cell cookie-cell-flags" role="cell">
                            {#if cookie.httpOnly}<span class="tag">HttpOnly</span>{/if}
                            {#if cookie.secure}<span class="tag">Secure</span>{/if}
                            {#if cookie.sameSite}<span class="tag">{cookie.sameSite[0].toUpperCase()}{cookie.sameSite.slice(1)}</span>{/if}
                            {#if !cookie.hostOnly}<span class="tag">Subdomains</span>{/if}
                          </span>
                        </button>
                        <span class="cookie-row-actions" role="cell">
                          <button class="btn btn-ghost btn-icon btn-xs" type="button" aria-label="Delete cookie {cookie.name}" onclick={() => deleteCookie(cookie)} disabled={saving}><AddCloseIcon /></button>
                        </span>
                      </div>
                    {/each}
                  </div>
                  {#if currentGroup.cookies.length > currentCookies.length}
                    <div class="cookie-table-more">
                      <span>Showing {currentCookies.length} of {currentGroup.cookies.length}</span>
                      <button class="btn btn-ghost btn-sm" type="button" onclick={() => showMoreCookies(currentGroup.domain, currentGroup.cookies.length)}>
                        Show {Math.min(COOKIE_ROW_PAGE_SIZE, currentGroup.cookies.length - currentCookies.length)} more
                      </button>
                    </div>
                  {/if}
                {:else if !editorOpen}
                  <div class="empty-state cookie-domain-empty">
                    <p class="empty-state-title">No cookies for {currentGroup.domain}</p>
                    <p class="empty-state-text">Add one by hand, or send a request to this domain.</p>
                    <button class="btn btn-secondary" type="button" onclick={() => addCookie(currentGroup.domain)}><AddCloseIcon add /> Add cookie</button>
                  </div>
                {/if}
              </div>

              {#if editorOpen}
                <form class="cookie-editor" aria-label="Cookie editor" onsubmit={(event) => { event.preventDefault(); void saveCookie(); }} use:saveShortcut>
                  <div class="cookie-editor-head">
                    <strong class="cookie-editor-title">{selectedCookie ? selectedCookie.name : 'New cookie'}</strong>
                    <span class="cookie-editor-domain">on {editorDomain}</span>
                    <span class="cookie-head-spacer"></span>
                    <div class="segmented" role="group" aria-label="Editor mode">
                      <button class="segmented-item" type="button" aria-pressed={editorMode === 'fields'} onclick={() => switchEditorMode('fields')}>Fields</button>
                      <button class="segmented-item" type="button" aria-pressed={editorMode === 'raw'} onclick={() => switchEditorMode('raw')}>Raw</button>
                    </div>
                  </div>

                  {#if selectedCookie && cookieValueIsMissingSecret(selectedCookie.value)}
                    <p class="cookie-missing-note" role="status">The value of this cookie is not on this computer, so Kurlo does not send it. Replace the {'{{kurloSecret:…}}'} part with the value and save.</p>
                  {/if}

                  {#if editorMode === 'raw'}
                    <textarea class="field field-area field-mono cookie-raw" bind:value={rawCookieText} spellcheck="false" aria-label="Raw cookie" use:focusOnMount></textarea>
                  {:else}
                    <div class="cookie-form-grid">
                      <label class="cookie-form-field">
                        <span>Name</span>
                        <input class="field field-mono" bind:value={form.name} spellcheck="false" use:focusOnMount />
                      </label>
                      <label class="cookie-form-field cookie-form-wide">
                        <span>Value</span>
                        <input class="field field-mono" bind:value={form.value} spellcheck="false" />
                      </label>
                      <label class="cookie-form-field">
                        <span>Path</span>
                        <input class="field field-mono" bind:value={form.path} spellcheck="false" />
                      </label>
                      <label class="cookie-form-field">
                        <span>Expires</span>
                        <input class="field" type="datetime-local" bind:value={form.expires} />
                      </label>
                      <div class="cookie-form-field">
                        <span>SameSite</span>
                        <Select bind:value={form.sameSite} options={SAME_SITE_OPTIONS} ariaLabel="SameSite" />
                      </div>
                    </div>
                    <div class="cookie-form-checks">
                      <label class="check-label"><input class="check" type="checkbox" bind:checked={form.httpOnly} /> HttpOnly</label>
                      <label class="check-label"><input class="check" type="checkbox" bind:checked={form.secure} /> Secure</label>
                      <label class="check-label"><input class="check" type="checkbox" bind:checked={form.subdomains} /> Include subdomains</label>
                      <span class="cookie-form-hint">Leave Expires empty for a session cookie.</span>
                    </div>
                  {/if}

                  {#if visibleError}
                    <div class="cookie-error" role="alert">{visibleError}</div>
                  {/if}

                  <div class="cookie-editor-actions">
                    <span class="cookie-form-hint">{editorMode === 'raw' ? 'Paste a Set-Cookie header value.' : ''}</span>
                    <span class="cookie-head-spacer"></span>
                    <button class="btn btn-secondary" type="button" onclick={cancelEdit} disabled={saving}>Cancel</button>
                    <button class="btn btn-primary" type="submit" disabled={!canSave}>{saving ? 'Saving…' : 'Save'}</button>
                  </div>
                </form>
              {/if}
            {/if}
          </section>
        {/if}
      </div>
    {/if}
  </div>
</div>
