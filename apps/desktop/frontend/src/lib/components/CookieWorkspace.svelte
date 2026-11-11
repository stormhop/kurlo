<script lang="ts">
  import AddCloseIcon from './AddCloseIcon.svelte';
  import MenuIcon from './MenuIcon.svelte';
  import Select from './Select.svelte';
  import DateTimeField from './DateTimeField.svelte';
  import { vm } from '../stores/app.svelte';
  import { useClock } from '../clock.svelte';
  import { openExternalURL } from '../externalLinks';
  import { getAppInfo, installBrowserExtension } from '../backend';
  import type { BrowserExtensionResult, CookieJarEntry } from '../backend';
  import {
    blankCookieForm,
    buildCookieDomainGroups,
    cookieExpiryLabel,
    cookieFormFromCookie,
    cookieForEditing,
    cookieFromForm,
    cookieIsExpired,
    cookieKey,
    cookieValueIsMissingSecret,
    keepMissingSecret,
    normalizeCookieDomain,
    parseRawCookie,
    serializeCookie,
  } from '../cookieJar';
  import type { CookieForm } from '../cookieJar';
  import { cookieCountLabel, cookieSyncHeadline, cookieSyncState, resolveCookieDomainGroup } from '../cookieSync';
  import { cookieView, selectCookieDomain, selectCookieSync, syncCookieViewWorkspace } from '../stores/cookieView.svelte';

  const now = useClock();
  const COOKIE_SYNC_GUIDE_URL = 'https://kurlo.dev/docs/guides/cookies/#connecting-a-browser';
  const COOKIE_ROW_PAGE_SIZE = 50;
  const SAME_SITE_OPTIONS = [
    { value: '', label: 'Not set' },
    { value: 'lax', label: 'Lax' },
    { value: 'strict', label: 'Strict' },
    { value: 'none', label: 'None' },
  ];

  let selectedKey = $state('');
  let originalKey = $state('');
  let editingDomain = $state('');
  let editorMode = $state<'fields' | 'raw'>('fields');
  let form = $state<CookieForm>(blankCookieForm(''));
  let rawCookieText = $state('');
  let localError = $state('');
  let draftCookieCounters = $state<Record<string, number>>({});
  let cookieVisibleByDomain = $state<Record<string, number>>({});
  let emptyDomainInput = $state('');
  let moreMenuOpen = $state(false);
  let moreMenuRoot = $state<HTMLElement | null>(null);
  let moreMenuButton = $state<HTMLButtonElement | null>(null);
  let syncDomainInput = $state('');
  let pairingCodeShown = $state(false);
  let appVersion = $state('');
  let extensionSetup = $state<BrowserExtensionResult | null>(null);
  let extensionBusy = $state(false);
  let extensionPageCopied = $state(false);

  $effect(() => {
    syncCookieViewWorkspace(vm.activeWorkspaceId);
  });

  let cookies = $derived(vm.cookies);
  let saving = $derived(vm.cookieJarSaving);
  let loading = $derived(vm.cookieJarLoading);
  let sync = $derived(vm.cookieSync);
  let syncBusy = $derived(vm.cookieSyncBusy);
  let syncUnreadable = $derived(vm.cookieSyncUnreadableDomains());
  let allDomainGroups = $derived(buildCookieDomainGroups(cookies, cookieView.manualDomains));
  let openRequestDomain = $derived(normalizeCookieDomain(vm.cookieJarDefaultDomain));
  let currentGroup = $derived(resolveCookieDomainGroup(allDomainGroups, cookieView.domain, openRequestDomain));
  let currentCookies = $derived(currentGroup ? currentGroup.cookies.slice(0, cookieVisibleLimit(currentGroup.domain)) : []);
  let selectedCookie = $derived(cookies.find(cookie => cookieKey(cookie) === selectedKey));
  let selectedValueMissing = $derived(Boolean(selectedCookie && cookieValueIsMissingSecret(selectedCookie.value)));
  let visibleError = $derived(localError || vm.cookieJarError);
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
  let syncState = $derived(cookieSyncState(sync));
  let extensionOutdated = $derived(Boolean(sync.connected && sync.extensionVersion && appVersion && versionOlder(sync.extensionVersion, appVersion)));
  let extensionPage = $derived(extensionSetup?.browser === 'firefox' ? 'about:debugging#/runtime/this-firefox' : 'chrome://extensions');
  let domainSummary = $derived.by(() => {
    if (!currentGroup) return '';
    const list = currentGroup.cookies;
    if (!list.length) return 'No cookies yet · add one by hand or send a request to this domain';
    const parts = [cookieCountLabel(list.length)];
    const session = list.filter(cookie => cookie.session || !cookie.expiresAt).length;
    const expired = list.filter(cookie => cookieIsExpired(cookie, now())).length;
    const missing = list.filter(cookie => cookieValueIsMissingSecret(cookie.value)).length;
    if (session) parts.push(`${session} for this session`);
    if (expired) parts.push(`${expired} expired`);
    if (missing) parts.push(`${missing} without a value`);
    return parts.join(' · ');
  });

  $effect(() => {
    if (cookieView.section === 'sync' && !appVersion) void getAppInfo().then(info => { appVersion = info.version; });
  });

  $effect(() => {
    const domain = cookieView.newCookieFor;
    if (!domain) return;
    cookieView.newCookieFor = '';
    addCookie(domain);
  });

  $effect(() => {
    const domain = currentGroup?.domain ?? '';
    if (editingDomain && editingDomain !== domain) cancelEdit();
  });

  $effect(() => {
    currentGroup?.domain;
    cookieView.section;
    moreMenuOpen = false;
  });

  $effect(() => {
    if (selectedKey && !selectedCookie) {
      selectedKey = '';
      originalKey = '';
    }
  });

  function cookieSyncDetail(): string {
    switch (syncState) {
      case 'off': return 'Turn it on to let a browser extension push its cookies into this workspace.';
      case 'pending': return 'Check the code below matches the one in the extension, then let it in.';
      case 'live':
        if (sync.lastSyncAt) return `${cookieCountLabel(sync.lastSyncCount ?? 0)} synced ${relativeTime(sync.lastSyncAt)}.`;
        return 'Live — cookie changes arrive as they happen.';
      case 'offline': return 'The browser will reconnect on its own when it is open again.';
      default: return `Listening on ${sync.url} — install the extension and press Connect in it.`;
    }
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

  async function addSyncDomain() {
    const value = syncDomainInput.trim();
    if (!value) return;
    await vm.addCookieSyncDomain(value);
    syncDomainInput = '';
  }

  function focusOnMount(node: HTMLElement) {
    queueMicrotask(() => node.focus());
  }

  function cookieVisibleLimit(domain: string): number {
    return cookieVisibleByDomain[normalizeCookieDomain(domain)] ?? COOKIE_ROW_PAGE_SIZE;
  }

  function showMoreCookies(domain: string, total: number) {
    const normalized = normalizeCookieDomain(domain);
    cookieVisibleByDomain = { ...cookieVisibleByDomain, [normalized]: Math.min(total, cookieVisibleLimit(normalized) + COOKIE_ROW_PAGE_SIZE) };
  }

  function addDomain(value: string) {
    const domain = normalizeCookieDomain(value);
    if (!domain) {
      localError = 'Enter a domain name first.';
      return;
    }
    cookieView.manualDomains = [...new Set([...cookieView.manualDomains, domain])];
    emptyDomainInput = '';
    addCookie(domain);
  }

  function addCookie(domain: string) {
    const normalizedDomain = normalizeCookieDomain(domain);
    const usedNames = new Set(cookies.filter(cookie => normalizeCookieDomain(cookie.domain) === normalizedDomain).map(cookie => cookie.name));
    let count = Math.max(usedNames.size, draftCookieCounters[normalizedDomain] ?? 0) + 1;
    while (usedNames.has(`Cookie_${count}`)) count += 1;
    draftCookieCounters = { ...draftCookieCounters, [normalizedDomain]: count };
    selectCookieDomain(normalizedDomain);
    selectedKey = '';
    originalKey = '';
    editingDomain = normalizedDomain;
    form = blankCookieForm(normalizedDomain, `Cookie_${count}`);
    rawCookieText = `Cookie_${count}=value; Path=/`;
    localError = '';
  }

  function selectCookie(cookie: CookieJarEntry) {
    selectCookieDomain(normalizeCookieDomain(cookie.domain));
    selectedKey = cookieKey(cookie);
    originalKey = cookieKey(cookie);
    editingDomain = normalizeCookieDomain(cookie.domain);
    form = cookieFormFromCookie(cookieForEditing(cookie));
    rawCookieText = serializeCookie(cookieForEditing(cookie));
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
        if (form.name.trim()) rawCookieText = serializeCookie(cookieForEditing(editedCookie()));
      } else if (rawCookieText.trim()) {
        form = cookieFormFromCookie(cookieForEditing(parseRawCookie(rawCookieText, editorDomain)));
      }
      editorMode = mode;
    } catch (err) {
      localError = err instanceof Error ? err.message : String(err);
    }
  }

  function editedCookie(): CookieJarEntry {
    const next = editorMode === 'raw' ? parseRawCookie(rawCookieText, editorDomain) : cookieFromForm(form, editorDomain);
    return keepMissingSecret(next, selectedCookie);
  }

  async function saveCookie() {
    if (!canSave) return;
    localError = '';
    try {
      const next = editedCookie();
      if (selectedCookie && originalKey && originalKey !== cookieKey(next)) {
        await vm.removeCookie(selectedCookie);
      }
      await vm.saveCookie(next);
      if (vm.cookieJarError) return;
      cancelEdit();
      cookieView.manualDomains = cookieView.manualDomains.filter(domain => normalizeCookieDomain(domain) !== normalizeCookieDomain(next.domain));
      selectCookieDomain(normalizeCookieDomain(next.domain));
    } catch (err) {
      localError = err instanceof Error ? err.message : String(err);
    }
  }

  function editorKeys(node: HTMLElement) {
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void saveCookie();
      } else if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        event.stopPropagation();
        cancelEdit();
      }
    };
    node.addEventListener('keydown', onKeydown);
    return { destroy: () => node.removeEventListener('keydown', onKeydown) };
  }

  async function deleteCookie(cookie: CookieJarEntry) {
    await vm.removeCookie(cookie);
    if (selectedKey === cookieKey(cookie)) cancelEdit();
  }

  async function deleteDomain(domain: string) {
    const normalized = normalizeCookieDomain(domain);
    const domainCookies = cookies.filter(cookie => normalizeCookieDomain(cookie.domain) === normalized);
    for (const cookie of domainCookies) await vm.removeCookie(cookie);
    cookieView.manualDomains = cookieView.manualDomains.filter(item => normalizeCookieDomain(item) !== normalized);
    if (editingDomain === normalized) cancelEdit();
    if (cookieView.domain === normalized) cookieView.domain = '';
  }

  async function clearAll() {
    await vm.clearCookieJar();
    cookieView.manualDomains = [];
    cookieView.domain = '';
    cancelEdit();
    draftCookieCounters = {};
  }

  function runMenuAction(action: () => unknown) {
    moreMenuOpen = false;
    void action();
  }

  function closeMoreMenuOnFocusOut(event: FocusEvent) {
    const current = event.currentTarget;
    const next = event.relatedTarget;
    if (!(current instanceof HTMLElement)) return;
    if (next instanceof Node && current.contains(next)) return;
    if (next === null) return;
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
</script>

<svelte:document onpointerdowncapture={closeMoreMenuOnOutsidePointer} onkeydowncapture={closeMoreMenuOnEscape} />

<section class="environment-workspace cookie-workspace" aria-label="Cookies">
  {#if cookieView.section === 'sync'}
    <div class="environment-workspace-head">
      <div class="environment-title">
        <h1>Browser sync</h1>
        <p>{cookieSyncHeadline(sync)} · {cookieSyncDetail()}</p>
      </div>
      <div class="overview-actions">
        <label class="cookie-sync-toggle">
          <span>{sync.running ? 'On' : 'Off'}</span>
          <span class="switch-control">
            <input type="checkbox" role="switch" aria-label="Cookie sync" checked={sync.running} disabled={syncBusy} onchange={(event) => { (event.currentTarget as HTMLInputElement).checked = sync.running; void vm.toggleCookieSync(); }} />
            <span class="switch-track"></span>
          </span>
        </label>
      </div>
    </div>

    <div class="cookie-sync-panel">
      {#if vm.cookieSyncError}
        <div class="cookie-error" role="alert">{vm.cookieSyncError}</div>
      {/if}

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
            <button class="btn btn-secondary" type="button" onclick={() => vm.denyCookieSyncBrowser()} disabled={syncBusy}>Deny</button>
            <button class="btn btn-primary" type="button" onclick={() => vm.approveCookieSyncBrowser()} disabled={syncBusy}>Allow</button>
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
                    <button class="btn btn-ghost btn-icon btn-xs" type="button" aria-label="Stop syncing {domain}" onclick={() => vm.removeCookieSyncDomain(domain)} disabled={syncBusy}><AddCloseIcon /></button>
                  </span>
                {/each}
                {#if openRequestDomain && !openRequestDomainListed}
                  <button class="btn btn-dashed btn-sm cookie-sync-suggest" type="button" onclick={() => vm.addCookieSyncDomain(openRequestDomain)} disabled={syncBusy}>
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
                  <button class="btn btn-secondary" type="button" onclick={() => vm.revokeCookieSyncBrowser()} disabled={syncBusy}>Disconnect</button>
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
                  <button class="btn btn-secondary" type="button" onclick={() => vm.copyCookieSyncPairingCode()}>{vm.cookieSyncCodeCopied ? 'Copied' : 'Copy'}</button>
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
                  oninput={(event) => (vm.cookieSyncPort = Number((event.currentTarget as HTMLInputElement).value))}
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
        <button class="btn-link cookie-sync-link" type="button" onclick={() => openExternalURL(COOKIE_SYNC_GUIDE_URL)}>How to install the extension</button>
      </p>
    </div>
  {:else if loading && jarEmpty}
    <div class="empty-state cookie-empty-state" role="status">
      <p class="empty-state-text">Loading cookies…</p>
    </div>
  {:else if jarEmpty || !currentGroup}
    <div class="environment-workspace-head">
      <div class="environment-title">
        <h1>Cookies</h1>
        <p>Kurlo keeps cookies per workspace and sends them with matching requests.</p>
      </div>
    </div>
    <div class="empty-state cookie-empty-state" role="status">
      <p class="empty-state-title">No cookies yet</p>
      <p class="empty-state-text">They appear here after a response sets one. You can also add one by hand or pull them in from your browser.</p>
      {#if visibleError}
        <div class="cookie-error" role="alert">{visibleError}</div>
      {/if}
      <div class="cookie-empty-actions">
        {#if openRequestDomain}
          <button class="btn btn-primary" type="button" onclick={() => addDomain(openRequestDomain)}><AddCloseIcon add /> Add cookie for {openRequestDomain}</button>
        {/if}
        <form class="cookie-empty-domain" onsubmit={(event) => { event.preventDefault(); addDomain(emptyDomainInput); }}>
          <input class="field field-md" bind:value={emptyDomainInput} placeholder="example.com" spellcheck="false" aria-label="Cookie domain" />
          <button class="btn btn-secondary" type="submit">Add cookie</button>
        </form>
        <button class="btn btn-ghost" type="button" onclick={selectCookieSync}>Sync from browser</button>
      </div>
    </div>
  {:else}
    <div class="environment-workspace-head">
      <div class="environment-title">
        <h1>{currentGroup.domain}</h1>
        <p>{domainSummary}</p>
      </div>
      <div class="overview-actions">
        <button class="btn btn-primary" type="button" onclick={() => addCookie(currentGroup.domain)}><AddCloseIcon add /> Add cookie</button>
        <div class="env-more" bind:this={moreMenuRoot} onfocusout={closeMoreMenuOnFocusOut}>
          <button class="btn btn-ghost btn-icon env-more-btn" bind:this={moreMenuButton} type="button" aria-label="More cookie actions" aria-haspopup="menu" aria-expanded={moreMenuOpen} onclick={() => (moreMenuOpen = !moreMenuOpen)}>•••</button>
          {#if moreMenuOpen}
            <div class="menu request-menu env-more-menu" role="menu">
              <button class="menu-item" type="button" role="menuitem" onclick={() => runMenuAction(() => vm.refreshCookieJar())} disabled={loading}><MenuIcon name="restore" />Reload from disk</button>
              <div class="menu-separator" role="separator"></div>
              <button class="menu-item danger" type="button" role="menuitem" onclick={() => runMenuAction(() => deleteDomain(currentGroup.domain))} disabled={saving}><MenuIcon name="trash" />Delete {currentGroup.domain}</button>
              <button class="menu-item danger" type="button" role="menuitem" onclick={() => runMenuAction(clearAll)} disabled={saving}><MenuIcon name="trash" />Clear all cookies</button>
            </div>
          {/if}
        </div>
      </div>
    </div>

    {#if visibleError && !editorOpen}
      <div class="cookie-error cookie-main-error" role="alert">{visibleError}</div>
    {/if}

    {#if currentGroup.cookies.length}
      <div class="environment-editor-card cookie-table-card">
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
      </div>
    {:else if !editorOpen}
      <div class="empty-state cookie-domain-empty">
        <p class="empty-state-title">No cookies for {currentGroup.domain}</p>
        <p class="empty-state-text">Add one by hand, or send a request to this domain.</p>
        <button class="btn btn-secondary" type="button" onclick={() => addCookie(currentGroup.domain)}><AddCloseIcon add /> Add cookie</button>
      </div>
    {/if}

    {#if editorOpen}
      <form class="cookie-editor" aria-label="Cookie editor" onsubmit={(event) => { event.preventDefault(); void saveCookie(); }} use:editorKeys>
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
          <p class="cookie-missing-note" role="status">The value of this cookie is kept on the computer that created it, so Kurlo does not send it from here. Type the value and save to use the cookie on this computer.</p>
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
              <input class="field field-mono" bind:value={form.value} spellcheck="false" placeholder={selectedValueMissing ? 'Not on this computer' : ''} />
            </label>
            <label class="cookie-form-field">
              <span>Path</span>
              <input class="field field-mono" bind:value={form.path} spellcheck="false" />
            </label>
            <div class="cookie-form-field">
              <span>Expires</span>
              <DateTimeField bind:value={form.expires} ariaLabel="Expires" placeholder="When the session ends" />
            </div>
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
