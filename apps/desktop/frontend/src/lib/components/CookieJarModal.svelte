<script lang="ts">
  import { openExternalURL } from '../externalLinks';
  import { getAppInfo, installBrowserExtension } from '../backend';
  import type { BrowserExtensionResult } from '../backend';
  import { tabListKeyboard, trapFocus } from '../a11y';
  import type { CookieJarEntry, CookieSyncStatus } from '../backend';
  import {
    buildCookieDomainGroups,
    cookieKey,
    normalizeCookieDomain,
    parseRawCookie,
    serializeCookie,
  } from '../cookieJar';

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
  let domainInput = $state('');
  let manualDomains = $state<string[]>([]);
  let activeDomain = $state('');
  let selectedKey = $state('');
  let rawCookieText = $state('');
  let originalKey = $state('');
  let editingDomain = $state('');
  let localError = $state('');
  let defaultDomainSeeded = $state(false);
  let draftCookieCounters = $state<Record<string, number>>({});
  let domainPage = $state(0);
  let cookieVisibleByDomain = $state<Record<string, number>>({});

  const COOKIE_DOMAIN_PAGE_SIZE = 25;
  const COOKIE_CHIP_PAGE_SIZE = 50;
  let domainGroups = $derived(buildCookieDomainGroups(cookies, manualDomains, domainInput));
  let domainPageCount = $derived(pageCount(domainGroups.length, COOKIE_DOMAIN_PAGE_SIZE));
  let visibleDomainGroups = $derived(domainGroups.slice(domainPage * COOKIE_DOMAIN_PAGE_SIZE, (domainPage + 1) * COOKIE_DOMAIN_PAGE_SIZE));
  let selectedCookie = $derived(cookies.find(cookie => cookieKey(cookie) === selectedKey));
  let visibleError = $derived(localError || error);
  let editorDomain = $derived(editingDomain || activeDomain);
  let editorOpen = $derived(Boolean(editingDomain));
  let canSave = $derived(Boolean(editorDomain && rawCookieText.trim() && !saving));
  let syncDomains = $derived(sync.domains ?? []);
  let syncLog = $derived([...(sync.log ?? [])].reverse().slice(0, 6));
  let openRequestDomain = $derived(normalizeCookieDomain(defaultDomain));
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
    const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
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
    if (!defaultDomainSeeded && !activeDomain && defaultDomain) {
      manualDomains = [...new Set([...manualDomains, defaultDomain])];
      activeDomain = defaultDomain;
      defaultDomainSeeded = true;
    }
  });

  $effect(() => {
    if (selectedCookie && cookieKey(selectedCookie) === originalKey && rawCookieText === '') {
      rawCookieText = serializeCookie(selectedCookie);
    }
    if (selectedKey && !selectedCookie) {
      selectedKey = '';
      originalKey = '';
    }
  });

  function selectDomain(domain: string) {
    activeDomain = domain;
    const index = domainGroups.findIndex(group => group.domain === normalizeCookieDomain(domain));
    if (index >= 0) domainPage = Math.floor(index / COOKIE_DOMAIN_PAGE_SIZE);
  }

  function pageCount(total: number, size: number): number {
    return Math.max(1, Math.ceil(total / size));
  }

  function rangeLabel(page: number, size: number, total: number): string {
    if (!total) return '0 of 0';
    const start = page * size + 1;
    const end = Math.min(total, (page + 1) * size);
    return `${start}-${end} of ${total}`;
  }

  function cookieVisibleLimit(domain: string): number {
    return cookieVisibleByDomain[normalizeCookieDomain(domain)] ?? COOKIE_CHIP_PAGE_SIZE;
  }

  function visibleCookiesFor(group: CookieDomainGroup): CookieJarEntry[] {
    return group.cookies.slice(0, cookieVisibleLimit(group.domain));
  }

  function showMoreCookies(domain: string, total: number) {
    const normalized = normalizeCookieDomain(domain);
    const current = cookieVisibleLimit(normalized);
    cookieVisibleByDomain = { ...cookieVisibleByDomain, [normalized]: Math.min(total, current + COOKIE_CHIP_PAGE_SIZE) };
  }

  function addDomain() {
    const domain = normalizeCookieDomain(domainInput || defaultDomain);
    if (!domain) {
      localError = 'Enter a domain name first.';
      return;
    }
    manualDomains = [...new Set([...manualDomains, domain])];
    selectDomain(domain);
    addCookie(domain);
    domainInput = '';
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
    rawCookieText = `Cookie_${count}=value; Path=/`;
    localError = '';
  }

  function selectCookie(cookie: CookieJarEntry) {
    selectDomain(cookie.domain);
    selectedKey = cookieKey(cookie);
    originalKey = cookieKey(cookie);
    editingDomain = normalizeCookieDomain(cookie.domain);
    rawCookieText = serializeCookie(cookie);
    localError = '';
  }

  function cancelEdit() {
    selectedKey = '';
    originalKey = '';
    editingDomain = '';
    rawCookieText = '';
    localError = '';
  }

  async function saveRawCookie() {
    if (!canSave) return;
    localError = '';
    try {
      const next = parseRawCookie(rawCookieText, editorDomain);
      if (selectedCookie && originalKey && originalKey !== cookieKey(next)) {
        await onDelete(selectedCookie);
      }
      await onSave(next);
      selectedKey = '';
      originalKey = '';
      editingDomain = '';
      rawCookieText = '';
      manualDomains = manualDomains.filter(domain => normalizeCookieDomain(domain) !== normalizeCookieDomain(next.domain));
      selectDomain(next.domain);
    } catch (err) {
      localError = err instanceof Error ? err.message : String(err);
    }
  }

  async function deleteCookie(cookie: CookieJarEntry) {
    await onDelete(cookie);
    if (selectedKey === cookieKey(cookie)) cancelEdit();
  }

  async function deleteDomain(domain: string) {
    const domainCookies = cookies.filter(cookie => normalizeCookieDomain(cookie.domain) === normalizeCookieDomain(domain));
    for (const cookie of domainCookies) await onDelete(cookie);
    manualDomains = manualDomains.filter(item => normalizeCookieDomain(item) !== normalizeCookieDomain(domain));
    if (activeDomain === domain) {
      activeDomain = '';
      selectedKey = '';
      originalKey = '';
      editingDomain = '';
      rawCookieText = '';
    }
  }

  async function clearAll() {
    await onClear();
    manualDomains = [];
    activeDomain = '';
    selectedKey = '';
    originalKey = '';
    editingDomain = '';
    rawCookieText = '';
    localError = '';
    draftCookieCounters = {};
    defaultDomainSeeded = true;
  }
</script>

<div class="cookie-backdrop" role="presentation" onmousedown={(event) => event.target === event.currentTarget && onClose()}>
  <div class="modal cookie-modal postman-cookie-modal" role="dialog" aria-modal="true" aria-labelledby="cookie-jar-title" tabindex="-1" use:trapFocus>
    <div class="modal-head cookie-head postman-cookie-head">
      <h2 class="modal-title" id="cookie-jar-title">Cookies</h2>
      <button class="btn btn-ghost btn-icon dialog-close" type="button" onclick={onClose} aria-label="Close cookie jar">×</button>
    </div>

    <div class="segmented cookie-tabs" role="tablist" aria-label="Cookie jar sections" use:tabListKeyboard>
      <button
        class="segmented-item cookie-tab"
        class:active={tab === 'manage'}
        type="button"
        role="tab"
        aria-selected={tab === 'manage'}
        aria-controls="cookie-manage-panel"
        tabindex={tab === 'manage' ? 0 : -1}
        onclick={() => (tab = 'manage')}
      >Manage cookies</button>
      <button
        class="segmented-item cookie-tab"
        class:active={tab === 'sync'}
        type="button"
        role="tab"
        aria-selected={tab === 'sync'}
        aria-controls="cookie-sync-panel"
        tabindex={tab === 'sync' ? 0 : -1}
        onclick={() => (tab = 'sync')}
      >
        Sync cookies
        {#if sync.running}
          <span class="cookie-sync-dot" class:live={sync.paired} aria-hidden="true"></span>
        {/if}
      </button>
    </div>

    {#if tab === 'sync'}
      <div class="cookie-sync-panel" id="cookie-sync-panel" role="tabpanel" tabindex="-1">
        {#if syncError}
          <div class="cookie-error">{syncError}</div>
        {/if}

        <div class="cookie-sync-status" class:live={sync.connected} class:running={sync.running}>
          <span class="cookie-sync-indicator" aria-hidden="true"></span>
          <div class="cookie-sync-status-copy">
            <strong>{syncHeadline}</strong>
            <span>{syncDetail}</span>
          </div>
          <button class="btn" class:btn-secondary={sync.running} class:btn-primary={!sync.running} type="button" onclick={onToggleSync} disabled={syncBusy}>
            {sync.running ? 'Turn off' : 'Turn on'}
          </button>
        </div>

        {#if syncPending}
          <section class="cookie-sync-approval">
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
              <button class="btn btn-secondary btn-lg" type="button" onclick={onDenySync} disabled={syncBusy}>Deny</button>
              <button class="btn btn-primary btn-lg" type="button" onclick={onApproveSync} disabled={syncBusy}>Allow</button>
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
              <button class="btn btn-secondary btn-lg" type="button" onclick={() => setUpExtension(sync.browser?.toLowerCase().includes('firefox') ? 'firefox' : 'chromium')} disabled={extensionBusy}>Refresh files</button>
            </div>
          </section>
        {/if}

        {#if !sync.paired || extensionSetup}
          <section class="cookie-sync-block cookie-sync-extension">
            <h3>Browser extension</h3>
            {#if extensionSetup && !extensionSetup.error}
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
            {:else}
              {#if extensionSetup?.error}
                <div class="cookie-error">{extensionSetup.error}</div>
              {/if}
              <p class="cookie-sync-hint">Kurlo ships the extension. Pick your browser and it puts the files in a folder you can load.</p>
              <div class="cookie-sync-row">
                <button class="btn btn-secondary btn-lg" type="button" onclick={() => setUpExtension('chromium')} disabled={extensionBusy}>Chrome, Edge, Brave</button>
                <button class="btn btn-secondary btn-lg" type="button" onclick={() => setUpExtension('firefox')} disabled={extensionBusy}>Firefox</button>
              </div>
            {/if}
          </section>
        {/if}

        {#if sync.running}
          {#if sync.paired}
            <section class="cookie-sync-block">
              <h3>Paired browser</h3>
              <div class="cookie-sync-row">
                <span class="cookie-sync-hint">
                  {sync.browser || 'A browser'} holds a key to this jar.
                </span>
                <button class="btn btn-secondary btn-lg" type="button" onclick={onRevokeSync} disabled={syncBusy}>Disconnect it</button>
              </div>
            </section>
          {/if}

          <details class="cookie-sync-manual">
            <summary>Pair manually</summary>
            <div class="cookie-sync-row">
              <code class="cookie-sync-code">{sync.pairingCode}</code>
              <button class="btn btn-secondary btn-lg" type="button" onclick={onCopySyncCode}>{syncCodeCopied ? 'Copied' : 'Copy'}</button>
            </div>
            <p class="cookie-sync-hint">
              Only needed when the extension cannot find Kurlo by itself — a non-default port, say. The code carries
              the port and a secret, so treat it like a password.
            </p>
          </details>
        {:else}
          <section class="cookie-sync-block">
            <h3>Port</h3>
            <div class="cookie-sync-row">
              <input
                class="field cookie-sync-port"
                type="number"
                min="1024"
                max="65535"
                value={sync.port || 3199}
                oninput={(event) => onSyncPortChange(Number((event.currentTarget as HTMLInputElement).value))}
                aria-label="Cookie sync port"
              />
              <span class="cookie-sync-hint">The bridge only ever listens on 127.0.0.1.</span>
            </div>
          </section>
        {/if}

        <section class="cookie-sync-block">
          <h3>Domains the browser may share</h3>
          <div class="cookie-sync-row">
            <input class="field"
              bind:value={syncDomainInput}
              placeholder="example.com"
              spellcheck="false"
              onkeydown={(event) => event.key === 'Enter' && addSyncDomain()}
            />
            <button class="btn btn-secondary btn-lg" type="button" onclick={addSyncDomain} disabled={syncBusy}>Add domain</button>
          </div>
          {#if syncDomains.length}
            <div class="cookie-sync-chips">
              {#each syncDomains as domain (domain)}
                <span class="cookie-sync-chip" class:unreadable={syncUnreadable.includes(domain)}>
                  {domain}
                  <button class="btn btn-ghost btn-icon btn-xs" type="button" aria-label="Stop syncing {domain}" onclick={() => onRemoveSyncDomain(domain)} disabled={syncBusy}>×</button>
                </span>
              {/each}
            </div>
            {#if syncUnreadable.length}
              <p class="cookie-sync-hint cookie-sync-warning">
                {sync.browser || 'The browser'} is not allowed to read {syncUnreadable.join(', ')} — open the extension
                and press <em>Grant domain access</em>.
              </p>
            {/if}
          {:else}
            <p class="cookie-sync-hint">Nothing is shared yet — the extension can only read the domains listed here.</p>
          {/if}
          {#if openRequestDomain && !openRequestDomainListed}
            <button class="cookie-add-chip" type="button" onclick={() => onAddSyncDomain(openRequestDomain)} disabled={syncBusy}>
              <span>＋</span> Add {openRequestDomain} from the open request
            </button>
          {/if}
        </section>

        {#if syncLog.length}
          <section class="cookie-sync-block">
            <h3>Recent activity</h3>
            <ul class="cookie-sync-log">
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
    <div class="cookie-toolbar postman-cookie-toolbar">
      <input class="field" bind:value={domainInput} placeholder="Type a domain name" spellcheck="false" onkeydown={(event) => event.key === 'Enter' && addDomain()} data-autofocus />
      <button class="btn btn-secondary btn-lg" type="button" onclick={addDomain}>Add domain</button>
    </div>

    {#if visibleError}
      <div class="cookie-error">{visibleError}</div>
    {/if}

    <div class="cookie-body postman-cookie-body" id="cookie-manage-panel" role="tabpanel">
      {#if loading}
        <div class="cookie-empty">Loading cookies...</div>
      {:else if domainGroups.length}
        {#if domainGroups.length > COOKIE_DOMAIN_PAGE_SIZE}
          <div class="cookie-pagination" aria-label="Cookie domain pages">
            <span>Domains {rangeLabel(domainPage, COOKIE_DOMAIN_PAGE_SIZE, domainGroups.length)}</span>
            <div class="cookie-page-buttons">
              <button class="btn btn-secondary btn-sm" type="button" onclick={() => (domainPage = Math.max(0, domainPage - 1))} disabled={domainPage === 0}>Prev</button>
              <span>{domainPage + 1}/{domainPageCount}</span>
              <button class="btn btn-secondary btn-sm" type="button" onclick={() => (domainPage = Math.min(domainPageCount - 1, domainPage + 1))} disabled={domainPage + 1 >= domainPageCount}>Next</button>
            </div>
          </div>
        {/if}
        <div class="cookie-domain-list">
          {#each visibleDomainGroups as group (group.domain)}
            {@const visibleCookies = visibleCookiesFor(group)}
            <section class="cookie-domain-card" class:active={activeDomain === group.domain}>
              <div class="cookie-domain-head">
                <button class="cookie-domain-title" type="button" onclick={() => selectDomain(group.domain)}>
                  <strong>{group.domain}</strong>
                  <span>{group.cookies.length} cookie{group.cookies.length === 1 ? '' : 's'}</span>
                </button>
                <button class="btn btn-ghost btn-icon cookie-domain-delete" type="button" onclick={() => deleteDomain(group.domain)} aria-label="Delete domain cookies">×</button>
              </div>

              <div class="cookie-chip-row">
                {#each visibleCookies as cookie (cookieKey(cookie))}
                  <span class="cookie-chip" class:active={cookieKey(cookie) === selectedKey}>
                    <button class="cookie-chip-select" type="button" onclick={() => selectCookie(cookie)}>{cookie.name}</button>
                    <button class="cookie-chip-delete" type="button" aria-label="Delete cookie" onclick={() => deleteCookie(cookie)}>×</button>
                  </span>
                {/each}
                {#if group.cookies.length > visibleCookies.length}
                  <button class="cookie-add-chip cookie-more-chip" type="button" onclick={() => showMoreCookies(group.domain, group.cookies.length)}>
                    Show {Math.min(COOKIE_CHIP_PAGE_SIZE, group.cookies.length - visibleCookies.length)} more
                  </button>
                {/if}
                <button class="cookie-add-chip" type="button" onclick={() => addCookie(group.domain)}>
                  <span>＋</span> Add cookie
                </button>
              </div>

              {#if editingDomain === group.domain && editorOpen}
                <div class="cookie-raw-editor">
                  <textarea class="field field-area" bind:value={rawCookieText} spellcheck="false" aria-label="Raw cookie"></textarea>
                  <div class="cookie-raw-actions">
                    <button class="btn btn-secondary btn-lg" type="button" onclick={cancelEdit} disabled={saving}>Cancel</button>
                    <button class="btn btn-primary btn-lg" type="button" onclick={saveRawCookie} disabled={!canSave}>{saving ? 'Saving...' : 'Save'}</button>
                  </div>
                </div>
              {/if}
            </section>
          {/each}
        </div>
      {:else}
        <div class="empty-state cookie-empty cookie-empty-state" role="status">
          <svg width="2.5rem" height="2.5rem" viewBox="0 0 32 32" fill="none" aria-hidden="true" opacity="0.4">
            <circle cx="16" cy="16" r="12" stroke="currentColor" stroke-width="1.5"/>
            <circle cx="11.5" cy="13" r="1.4" fill="currentColor"/>
            <circle cx="20" cy="13.5" r="1.4" fill="currentColor"/>
            <circle cx="15" cy="20" r="1.4" fill="currentColor"/>
          </svg>
          <p class="empty-state-title cookie-empty-title">No cookies yet</p>
          <p class="empty-state-text cookie-empty-hint">Cookies appear here automatically after you send a request that sets one — or add a domain above to enter one manually.</p>
        </div>
      {/if}
    </div>

    <div class="modal-foot cookie-footer-actions">
      <button class="btn btn-secondary btn-danger btn-lg" type="button" onclick={clearAll} disabled={(!cookies.length && !manualDomains.length && !rawCookieText) || loading || saving}>
        Clear all cookies
      </button>
      <button class="btn btn-secondary btn-lg" type="button" onclick={() => onRefresh()} disabled={loading}>Refresh</button>
    </div>
    {/if}
  </div>
</div>
