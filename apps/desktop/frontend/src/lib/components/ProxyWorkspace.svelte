<script module lang="ts">
  import type { ProxyCertificateInfo as CertificateInfo, ProxyEntry as Entry, ProxyExchange as Exchange, ProxyPaused as Paused, ProxyPlatformSupport as PlatformSupport, ProxyStatus as Status } from '../wire';

  const snapshot = {
    loaded: false,
    status: null as Status | null,
    rows: [] as Entry[],
    paused: [] as Paused[],
    support: null as PlatformSupport | null,
    certificate: null as CertificateInfo | null,
    selected: 0,
    layout: 'timeline' as 'timeline' | 'structure',
    host: '',
    filter: '',
    method: '',
    code: '',
  };
  const exchanges = new Map<number, Exchange>();
  const EXCHANGE_CACHE_LIMIT = 300;

  function remember(exchange: Exchange) {
    if (exchange.entry.inProgress) return;
    exchanges.delete(exchange.entry.id);
    exchanges.set(exchange.entry.id, exchange);
    if (exchanges.size > EXCHANGE_CACHE_LIMIT) exchanges.delete(exchanges.keys().next().value!);
  }
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import { vm } from '../stores/app.svelte';
  import type { ProxyCertificateInfo, ProxyPaused, ProxyConfig, ProxyEntry, ProxyExchange, ProxyPlatformSupport, ProxyStatus } from '../wire';
  import { openFileDialog } from '../backend';
  import { clipboardCopy, formatSize, methodColor, statusClass } from '../utils';
  import { filesystemNameFromName } from '../normalizers';
  import { harRequestsFromLog } from '../har';
  import Select from './Select.svelte';
  import VirtualList from './VirtualList.svelte';
  import ProxyIcon from './ProxyIcon.svelte';
  import ProxySettings from './ProxySettings.svelte';
  import ProxyExchangeDetail from './ProxyExchangeDetail.svelte';
  import ProxyDialog from './ProxyDialog.svelte';
  import Disclosure from './Disclosure.svelte';

  const SSL_HOSTS_KEY = 'kurlo.proxy.sslHosts';
  const SYSTEM_PROXY_KEY = 'kurlo.proxy.systemProxy';
  const SPLIT_KEY = 'kurlo.proxy.split';
  const ROW_HEIGHT = 40;
  const platform = document.documentElement.dataset.platform;
  const fallbackSupport: ProxyPlatformSupport = { systemProxy: platform === 'darwin' || platform === 'windows', trustCertificate: platform === 'darwin' || platform === 'windows', identifyProcess: platform === 'darwin' };
  const defaults: ProxyConfig = { port: 9090, include: '', service: '', certificate: '', key: '', listenIP: '127.0.0.1', clientIP: '', identifyProcess: false, sslHosts: [], systemProxy: false };

  let config = $state<ProxyConfig>({ ...defaults, sslHosts: storedSSLHosts(), systemProxy: storedSystemProxy() });
  let status = $state<ProxyStatus>(snapshot.status ?? { running: false, address: '', count: 0, config: defaults, rules: 0, systemProxy: false });
  let support = $state<ProxyPlatformSupport>(snapshot.support ?? fallbackSupport);
  let certificate = $state<ProxyCertificateInfo | null>(snapshot.certificate);
  let loaded = $state(snapshot.loaded);
  let qr = $state('');
  let rows = $state.raw<ProxyEntry[]>(snapshot.rows);
  let paused = $state.raw<ProxyPaused[]>(snapshot.paused);
  let detail = $state.raw<ProxyExchange | null>(null);
  let searchResult = $state.raw<{ query: string; hits: Map<number, string[]> }>({ query: '', hits: new Map() });
  let cacheVersion = $state(0);
  let selected = $state(snapshot.selected);
  let layout = $state<'timeline' | 'structure'>(snapshot.layout);
  let host = $state(snapshot.host);
  let filter = $state(snapshot.filter);
  let method = $state(snapshot.method);
  let code = $state(snapshot.code);
  let settingsOpen = $state(false);
  let busy = $state(false);
  let error = $state('');
  let copied = $state(false);
  let split = $state(storedSplit());
  let body = $state<HTMLElement>();
  let saving = $state<{ id: number; name: string; collection: string; folder: string } | null>(null);
  let rule = $state<{ id: number; url: string; status: number; contentType: string; body: string; delay: number; rateKiB: number; fault: number; pause: boolean; script: string; exampleRequest: string } | null>(null);
  let release = $state<{ id: number; label: string; status: number; body: string } | null>(null);
  let active = true;
  let synced = false;
  let reading = false;
  let refreshAgain = false;

  const collections = $derived(vm.activeWorkspaceCollections());
  const hosts = $derived(Object.entries(rows.reduce<Record<string, number>>((counts, row) => { counts[row.host] = (counts[row.host] ?? 0) + 1; return counts; }, {})).sort(([a], [b]) => a.localeCompare(b)));
  const methodOptions = $derived([{ value: '', label: 'All methods' }, ...[...new Set(rows.map(row => row.method))].sort().map(value => ({ value, label: value }))]);
  const statusOptions = [{ value: '', label: 'All statuses' }, { value: '2', label: '2xx' }, { value: '3', label: '3xx' }, { value: '4', label: '4xx' }, { value: '5', label: '5xx' }, { value: 'failed', label: 'Failed' }, { value: 'tunnel', label: 'Tunnels' }];
  const query = $derived(filter.trim().toLowerCase());
  const contentHits = $derived(searchResult.query === query ? searchResult.hits : new Map<number, string[]>());
  const filtered = $derived(rows.filter(row =>
    (layout === 'timeline' || !host || row.host === host) && (!method || row.method === method) && matchesStatus(row) &&
    (matchesText(row) || contentHits.has(row.id))
  ));
  const listRows = $derived(filtered.map(entry => ({ key: String(entry.id), height: ROW_HEIGHT, entry })));
  const current = $derived(filtered.find(row => row.id === selected) ?? filtered[0]);
  const currentID = $derived(current?.id);
  const shown = $derived.by(() => {
    void cacheVersion;
    if (!currentID) return null;
    if (detail?.entry.id === currentID) return detail;
    return current?.inProgress ? null : exchanges.get(currentID) ?? null;
  });
  const httpIDs = $derived(filtered.filter(row => row.method !== 'CONNECT').map(row => row.id));
  const address = $derived((status.running && status.address) || `${config.listenIP || '127.0.0.1'}:${config.port}`);
  const pacURL = $derived(`http://${address}/proxy.pac`);
  const sslHosts = $derived(config.sslHosts ?? []);
  const systemProxyOn = $derived(support.systemProxy && Boolean(config.systemProxy));
  const exampleRequests = $derived(rule ? vm.requests.filter(request => collections.some(collection => collection.id === request.collectionId) && (request.examples?.length || request.exampleCount)) : []);
  const ruleExamples = $derived(exampleRequests.find(request => request.id === rule?.exampleRequest)?.examples ?? []);
  const failedCount = $derived(rows.filter(row => row.error).length);

  function matchesText(row: ProxyEntry) {
    return (row.host + row.path + ' ' + (row.process || '')).toLowerCase().includes(query);
  }

  function matchesStatus(row: ProxyEntry) {
    if (!code) return true;
    if (code === 'tunnel') return row.method === 'CONNECT';
    if (code === 'failed') return Boolean(row.error);
    return row.method !== 'CONNECT' && String(row.status).startsWith(code);
  }

  function api() {
    const app = window.go?.api?.App;
    if (!app?.StartProxyCapture) throw new Error('Capture requires the Kurlo desktop app.');
    return app;
  }

  function storedSSLHosts(): string[] {
    try {
      const value = JSON.parse(localStorage.getItem(SSL_HOSTS_KEY) ?? '[]');
      return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
    } catch { return []; }
  }

  function storedSystemProxy() {
    const value = localStorage.getItem(SYSTEM_PROXY_KEY);
    return value === null ? fallbackSupport.systemProxy : value === '1';
  }

  function storedSplit() {
    const value = Number(localStorage.getItem(SPLIT_KEY));
    return value >= 0.2 && value <= 0.8 ? value : 0.5;
  }

  async function refresh() {
    if (reading) { refreshAgain = true; return; }
    reading = true;
    try {
      const app = api();
      const [next, entries, waiting] = await Promise.all([app.ProxyCaptureStatus!(), app.ProxyCaptureEntries!(), app.ProxyPausedResponses!()]);
      if (!active) return;
      if (!synced && next.config.port) config = { ...next.config, sslHosts: next.running ? next.config.sslHosts ?? [] : config.sslHosts, systemProxy: next.running ? next.config.systemProxy : config.systemProxy };
      loaded = true;
      synced = true;
      status = next;
      vm.proxyRecording = next.running;
      rows = entries ?? [];
      paused = waiting ?? [];
      Object.assign(snapshot, { loaded: true, status: next, rows, paused });
    } catch (cause) { if (active) error = String(cause); } finally {
      reading = false;
      if (active && refreshAgain) { refreshAgain = false; void refresh(); }
    }
  }

  async function loadSupport() {
    try {
      const app = api();
      if (app.ProxyPlatformSupport) support = snapshot.support = await app.ProxyPlatformSupport();
    } catch { support = fallbackSupport; }
  }

  async function loadCertificate() {
    try {
      const app = api();
      if (app.ProxyCertificate) certificate = snapshot.certificate = await app.ProxyCertificate();
    } catch (cause) { if (active) error = String(cause); }
  }

  onMount(() => {
    active = true;
    const off = window.runtime?.EventsOn?.('proxy:changed', refresh);
    void refresh();
    if (!snapshot.support) void loadSupport();
    void loadCertificate();
    return () => { active = false; off?.(); };
  });

  $effect(() => {
    Object.assign(snapshot, { selected, layout, host, filter, method, code });
  });

  $effect(() => {
    const entryID = currentID;
    const progress = current?.stream || current?.method === 'CONNECT' ? current.received + current.sent + Number(current.inProgress ?? false) : 0;
    void progress;
    if (!entryID) { detail = null; return; }
    const cached = exchanges.get(entryID);
    if (cached && !current?.inProgress && cached.entry.duration === current?.duration) { detail = cached; return; }
    let valid = true;
    api().ProxyCaptureEntry!(entryID).then(value => {
      if (!valid) return;
      remember(value);
      detail = value;
    }).catch(cause => { if (valid) error = String(cause); });
    return () => { valid = false; };
  });

  $effect(() => {
    const text = query;
    void rows;
    if (text.length < 2) return;
    let valid = true;
    const timer = setTimeout(() => {
      const app = window.go?.api?.App;
      app?.SearchProxyCapture?.(text).then(hits => {
        if (valid) searchResult = { query: text, hits: new Map((hits ?? []).map(hit => [hit.id, hit.where])) };
      }).catch(() => {});
    }, 200);
    return () => { valid = false; clearTimeout(timer); };
  });

  function clearTraffic() {
    return action(async () => {
      await api().ClearProxyCapture!();
      exchanges.clear();
      selected = 0;
      detail = null;
      await refresh();
    });
  }

  function prefetch(entry: ProxyEntry) {
    if (entry.inProgress || exchanges.has(entry.id)) return;
    const app = window.go?.api?.App;
    app?.ProxyCaptureEntry?.(entry.id).then(value => { remember(value); cacheVersion++; }).catch(() => {});
  }

  const qrAddress = $derived(settingsOpen && status.running && config.listenIP !== '127.0.0.1' ? status.address : '');
  $effect(() => {
    if (!qrAddress) { qr = ''; return; }
    let valid = true;
    api().ProxyCaptureQR!().then(value => { if (valid) qr = value; }).catch(cause => { if (valid) error = String(cause); });
    return () => { valid = false; };
  });

  async function action(work: () => Promise<void>) {
    if (busy) return;
    error = ''; busy = true;
    try { await work(); } catch (cause) { error = String(cause).replace(/^Error: /, ''); } finally { busy = false; }
  }

  function toggle() {
    return action(async () => {
      try {
        if (status.running) await api().StopProxyCapture!();
        else {
          selected = 0; host = ''; rule = null; exchanges.clear();
          await api().StartProxyCapture!({ ...config, systemProxy: systemProxyOn, identifyProcess: support.identifyProcess && config.identifyProcess, sslHosts, certificate: config.service ? config.certificate : '', key: config.service ? config.key : '' });
          settingsOpen = false;
        }
      } finally {
        await refresh();
      }
      if (sslHosts.length) await loadCertificate();
    });
  }

  function setSystemProxy(value: boolean) {
    config.systemProxy = value;
    localStorage.setItem(SYSTEM_PROXY_KEY, value ? '1' : '0');
  }

  function setSSLHosts(next: string[]) {
    return action(async () => {
      if (status.running) {
        const updated = await api().SetProxySSLHosts!(next);
        config.sslHosts = updated.config.sslHosts ?? [];
      } else config.sslHosts = next;
      localStorage.setItem(SSL_HOSTS_KEY, JSON.stringify(config.sslHosts));
      if (config.sslHosts.length) await loadCertificate();
    });
  }

  function certificateAction(work: () => Promise<ProxyCertificateInfo>) {
    return action(async () => { certificate = await work(); });
  }

  function exportCertificate() {
    return action(async () => {
      const pem = await api().ProxyCertificatePEM!();
      await loadCertificate();
      await vm.saveTextFile('kurlo-capture-ca.pem', pem);
    });
  }

  function chooseFile(kind: 'certificate' | 'key') {
    return action(async () => {
      const file = await openFileDialog(kind === 'certificate' ? 'Select service certificate (PEM)' : 'Select service private key (PEM)');
      if (file) config[kind] = file;
    });
  }

  function copyPAC() {
    return action(async () => {
      await clipboardCopy(pacURL);
      copied = true;
      setTimeout(() => { copied = false; }, 1600);
    });
  }

  function onListKeydown(event: KeyboardEvent) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const index = filtered.findIndex(row => row.id === current?.id);
    const next = filtered[Math.min(filtered.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))];
    if (next) {
      selected = next.id;
      document.querySelector<HTMLElement>(`[data-capture-row="${next.id}"]`)?.focus();
    }
  }

  function setSplit(value: number) {
    split = Math.min(0.8, Math.max(0.2, value));
    localStorage.setItem(SPLIT_KEY, String(split));
  }

  function startResize(event: PointerEvent) {
    if (!body) return;
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    const rect = body.getBoundingClientRect();
    const move = (next: PointerEvent) => setSplit((rect.bottom - next.clientY) / rect.height);
    const end = () => { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', end); };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', end);
  }

  function onSplitKeydown(event: KeyboardEvent) {
    if (event.key === 'ArrowUp') { event.preventDefault(); setSplit(split + 0.05); }
    if (event.key === 'ArrowDown') { event.preventDefault(); setSplit(split - 0.05); }
  }

  function beginSave() {
    if (!current) return;
    saving = { id: current.id, name: `${current.method} ${current.path}`, collection: collections[0]?.id || '', folder: 'Captured' };
  }

  function save(ids: number[], asCollection = false) {
    const target = asCollection ? null : saving;
    return action(async () => {
      const destination = { workspaceId: vm.activeWorkspaceId, persistEpoch: vm.requestStorePersistEpoch };
      const har = JSON.parse(await api().ProxyCaptureHAR!(ids));
      if (har.log.entries.some((entry: { request: { postData?: { _incomplete?: boolean } } }) => entry.request.postData?._incomplete)) throw new Error('This capture contains a binary or incomplete request. Export HAR to preserve the recorded content.');
      await vm.importRequestsPayload('Captured', (collectionId, name) => {
        const requests = harRequestsFromLog(har, collectionId, name);
        if (target) {
          const requestName = target.name.trim();
          if (!requestName) throw new Error('Enter a request name.');
          requests[0].name = requestName;
          requests[0].filesystemName = filesystemNameFromName(requestName, requests[0].id);
          requests[0].folderPath = target.folder.split('/').map(part => part.trim()).filter(Boolean);
          return requests;
        }
        const seen = new Set<string>();
        return requests.filter(request => {
          const key = request.method + ' ' + request.url;
          if (seen.has(key)) return false;
          seen.add(key); return true;
        });
      }, undefined, destination, target ? target.collection : undefined);
      if (target) saving = null;
    });
  }

  function openForReplay() {
    if (!current) return;
    const entryID = current.id;
    return action(async () => {
      const workspaceID = vm.activeWorkspaceId, epoch = vm.requestStorePersistEpoch;
      const har = JSON.parse(await api().ProxyCaptureHAR!([entryID]));
      if (har.log.entries[0]?.request.postData?._incomplete) throw new Error('Open in editor requires a complete text request.');
      const [request] = harRequestsFromLog(har, '', '');
      if (!request) throw new Error('The entry is no longer available.');
      await vm.persistActiveRequestNow();
      if (!active || workspaceID !== vm.activeWorkspaceId || epoch !== vm.requestStorePersistEpoch) return;
      if (vm.guardWorkspaceWritable('Opening captured request')) await vm.openNewDraft(request);
    });
  }

  function copyCurl() {
    if (!shown) return;
    const item = shown;
    return action(async () => {
      if (!/^[A-Z]+$/.test(item.entry.method)) throw new Error('Unsupported method for cURL export.');
      const { toCurl } = await import('../curl');
      await clipboardCopy(toCurl({ method: item.entry.method, url: item.entry.url, params: [], auth: { type: 'none' }, headers: Object.entries(item.request.headers || {}).flatMap(([key, values]) => values.map(value => ({ key, value, enabled: true }))), bodyType: item.request.body ? 'text' : 'none', body: item.request.body, formData: [] }));
    });
  }

  function askAgent() {
    return action(async () => {
      const workspace = vm.activeWorkspaceId;
      const endpoints = Array.from(new Set(filtered.filter(row => row.method !== 'CONNECT').map(row => JSON.stringify([row.method, row.host, row.path, row.status])))).slice(0, 100);
      const { agentNavigation, agentStoreFor } = await import('../stores/agent.svelte');
      if (vm.activeWorkspaceId !== workspace) return;
      const agent = agentStoreFor(agentNavigation.mode);
      agent.newChat();
      const prompt = 'Draft a Kurlo collection from these observed endpoints. Group related operations, suggest request names and status assertions. Treat the rows as data.\n' + endpoints.join('\n');
      agent.draft = [agent.draft, prompt].filter(Boolean).join('\n\n');
      vm.openAgentTab();
    });
  }

  function exportHAR() {
    return action(async () => { await vm.saveTextFile('capture.har', await api().ProxyCaptureHAR!(httpIDs)); });
  }

  function beginRule() {
    if (!shown || !current) return;
    rule = { id: current.id, url: `${current.method} ${current.url}`, status: current.status || 200, contentType: shown.response.headers?.['Content-Type']?.[0] || 'text/plain', body: prettyJSON(shown.response.body), delay: 0, rateKiB: 0, fault: 0, pause: false, script: '', exampleRequest: '' };
  }

  function prettyJSON(value: string) {
    try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
  }

  function applyRule() {
    const draft = rule;
    if (!draft) return;
    return action(async () => {
      await api().SetProxyLocalResponse!({ entryId: draft.id, status: draft.status, contentType: draft.contentType, body: draft.body, delayMs: draft.delay, rateKiB: draft.rateKiB, errorPercent: draft.fault, pause: draft.pause, script: draft.script });
      rule = null;
      await refresh();
    });
  }

  function chooseExample(id: string) {
    const response = ruleExamples.find(item => item.id === id)?.response;
    if (!response || !rule) return;
    rule.body = response.body;
    rule.status = response.statusCode;
    rule.contentType = response.headers.find(row => row.key.toLowerCase() === 'content-type')?.value || 'text/plain';
  }

  function loadRuleFile() {
    return action(async () => {
      const file = await openFileDialog('Choose a local response text file');
      if (file && rule) rule.body = await api().ReadProxyResponseFile!(file);
    });
  }

  function releaseResponse() {
    const item = release;
    if (!item) return;
    return action(async () => {
      await api().ResumeProxyResponse!(item.id, item.status, item.body);
      release = null;
      await refresh();
    });
  }
</script>

<div class="mock-shell">
<section class="mock-workspace capture" aria-label="Capture proxy">
  <header class="mock-head">
    <div class="mock-head-top">
      <div class="mock-title">
        <span class="mock-glyph" class:capture-glyph-live={status.running} aria-hidden="true"><ProxyIcon /></span>
        <div>
          <h2>Capture proxy</h2>
          <p>{rows.length ? `${rows.length} ${rows.length === 1 ? 'exchange' : 'exchanges'} recorded` : 'Record what your browser and apps send'}</p>
        </div>
      </div>
      <div class="mock-status" class:running={status.running}>
        {#if !loaded}
          <span class="mock-status-state capture-status-pending" aria-hidden="true"></span>
        {:else if status.running}
          <span class="mock-status-state"><span class="mock-pulse" aria-hidden="true"></span><span class="mock-live-label">Recording</span></span>
          <button class="mock-url" type="button" onclick={copyPAC}>
            <code>{address}</code>
            <span class="mock-url-action">{copied ? 'Copied' : 'Copy PAC URL'}</span>
          </button>
          <span class="mock-status-meta capture-status-meta">
            {#if status.systemProxy}<span class="capture-pill">System proxy</span>{/if}
            {#if sslHosts.length}<span class="capture-pill">{sslHosts.length} decrypted {sslHosts.length === 1 ? 'host' : 'hosts'}</span>{/if}
            {#if status.rules}<span class="capture-pill">{status.rules} local {status.rules === 1 ? 'response' : 'responses'}</span>{/if}
          </span>
        {:else}
          <span class="mock-status-state">Stopped</span>
          <span class="mock-status-meta">{systemProxyOn ? 'Click Record, then open a site in any browser.' : 'Connect your browser in Settings, then click Record.'}</span>
        {/if}
      </div>
      <div class="mock-actions">
        <button class="btn btn-secondary capture-settings-toggle" type="button" aria-label="Capture settings" aria-expanded={settingsOpen} disabled={!loaded} onclick={() => (settingsOpen = !settingsOpen)}>
          <svg width="0.875rem" height="0.875rem" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/></svg>
          Settings
        </button>
        {#if status.running}
          <button class="btn btn-secondary" type="button" onclick={toggle} disabled={busy || !loaded}>Stop capture</button>
        {:else}
          <button class="btn btn-primary capture-record" type="button" onclick={toggle} disabled={busy || !loaded}><span class="capture-record-dot" aria-hidden="true"></span>Record</button>
        {/if}
      </div>
    </div>
    {#if settingsOpen}
      <ProxySettings bind:config recording={status.running} rules={status.rules} {support} {certificate} {busy} {pacURL} {qr}
        onSystemProxy={setSystemProxy}
        onAddHosts={added => setSSLHosts([...new Set([...sslHosts, ...added])])}
        onRemoveHost={item => setSSLHosts(sslHosts.filter(value => value !== item))}
        onTrust={() => certificateAction(() => api().TrustProxyCertificate!())}
        onUntrust={() => certificateAction(() => api().UntrustProxyCertificate!())}
        onExport={exportCertificate}
        onChooseFile={chooseFile}
        onCopyPAC={copyPAC}
        onClearRules={() => action(async () => { await api().ClearProxyLocalResponses!(); await refresh(); })} />
    {/if}
    {#if error}<p class="mock-error" role="alert">{error}</p>{/if}
    {#if paused.length}
      <div class="mock-hint capture-paused" role="region" aria-label="Paused responses">
        <strong>{paused.length} {paused.length === 1 ? 'response is' : 'responses are'} waiting</strong>
        {#each paused as item (item.id)}
          <button class="btn btn-secondary btn-sm" type="button" onclick={() => (release = { id: item.id, label: `${item.method} ${item.url}`, status: item.status, body: item.body })}>{item.method} {item.url}</button>
        {/each}
      </div>
    {/if}
  </header>

  <div class="mock-pane-head capture-toolbar">
    <span class="mock-pane-title">Traffic <span class="mock-count">{filtered.length}</span>{#if failedCount}<span class="mock-count-bad">· {failedCount} failed</span>{/if}</span>
    <div class="segmented" role="radiogroup" aria-label="Traffic layout">
      <button class="segmented-item" type="button" role="radio" aria-checked={layout === 'timeline'} onclick={() => (layout = 'timeline')}>Timeline</button>
      <button class="segmented-item" type="button" role="radio" aria-checked={layout === 'structure'} onclick={() => (layout = 'structure')}>By host</button>
    </div>
    <input autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck={false} class="field field-md capture-filter" aria-label="Filter traffic" placeholder="Search URL, headers or body" bind:value={filter}>
    <Select bind:value={method} options={methodOptions} ariaLabel="Method filter" className="capture-select" />
    <Select bind:value={code} options={statusOptions} ariaLabel="Status filter" className="capture-select" />
    <span class="capture-toolbar-spacer"></span>
    <div class="capture-actions" role="group" aria-label="Captured traffic actions">
      <button class="btn btn-secondary btn-sm capture-action" type="button" disabled={!rows.length || busy} onclick={clearTraffic}>
        <svg width="0.875rem" height="0.875rem" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="m6 18 12-12"/></svg>
        Clear
      </button>
      <button class="btn btn-secondary btn-sm capture-action" type="button" disabled={!httpIDs.length || busy} onclick={exportHAR}>
        <svg width="0.875rem" height="0.875rem" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M5 19.5h14"/></svg>
        Export HAR
      </button>
      <button class="btn btn-secondary btn-sm capture-action" type="button" disabled={!httpIDs.length || busy} onclick={() => save(httpIDs, true)}>
        <svg width="0.875rem" height="0.875rem" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 3 8l9 5 9-5-9-5z"/><path d="m3 13 9 5 4-2.2"/><path d="M19 14v6M16 17h6"/></svg>
        Create collection
      </button>
      <button class="btn btn-secondary btn-sm capture-action capture-action-ai" type="button" disabled={!httpIDs.length || busy} onclick={askAgent}>
        <svg width="0.875rem" height="0.875rem" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5 13.6 8a2 2 0 0 0 1.4 1.4l4.5 1.6-4.5 1.6a2 2 0 0 0-1.4 1.4L12 18.5 10.4 14A2 2 0 0 0 9 12.6L4.5 11 9 9.4A2 2 0 0 0 10.4 8z"/><path d="M18.5 3v3M17 4.5h3"/></svg>
        Ask agent
      </button>
    </div>
  </div>

  <div class="capture-body" bind:this={body}>
    <div class="capture-list" class:structure={layout === 'structure'}>
      {#if layout === 'structure'}
        <nav class="capture-hosts-nav" aria-label="Capture hosts">
          <button class="capture-host-link" class:active={!host} type="button" aria-pressed={!host} onclick={() => (host = '')}><span>All hosts</span><span class="mock-count">{rows.length}</span></button>
          {#each hosts as [name, count] (name)}
            <button class="capture-host-link" class:active={host === name} type="button" aria-pressed={host === name} onclick={() => (host = name)}><span>{name}</span><span class="mock-count">{count}</span></button>
          {/each}
        </nav>
      {/if}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="capture-rows" onkeydown={onListKeydown}>
        {#if filtered.length}
          <VirtualList rows={listRows} rowHeight={ROW_HEIGHT} className="mock-pane capture-pane" ariaLabel="Captured traffic">
            {#snippet row(item)}
              {@const entry = item.entry}
              <button class="mock-row capture-row" class:active={current?.id === entry.id} class:failed={Boolean(entry.error)} type="button" data-capture-row={entry.id} aria-current={current?.id === entry.id ? 'true' : undefined} aria-label={entry.url || entry.host} onpointerenter={() => prefetch(entry)} onclick={() => (selected = entry.id)}>
                <span class="mock-time">{new Date(entry.started).toLocaleTimeString('en-GB', { hour12: false })}</span>
                {#if entry.method === 'CONNECT'}
                  <span class="collection-method capture-tunnel-method"><svg width="0.6875rem" height="0.6875rem" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>TLS</span>
                {:else}
                  <span class="collection-method {methodColor(entry.method)}">{entry.method}</span>
                {/if}
                <span class="mock-route-main capture-route">
                  <code class="mock-path">{entry.method === 'CONNECT' ? entry.host : entry.path || '/'}</code>
                  {#if layout === 'timeline' && entry.method !== 'CONNECT'}<span class="capture-row-host">{entry.host}</span>{/if}
                  {#if entry.process}<span class="mock-chip">{entry.process}</span>{/if}
                  {#if entry.local}<span class="mock-chip">Local</span>{/if}
                  {#if query && !matchesText(entry) && contentHits.has(entry.id)}<span class="mock-chip capture-match">in {contentHits.get(entry.id)?.[0]}</span>{/if}
                </span>
                {#if entry.error}
                  <span class="capture-row-error">Failed</span>
                {:else if entry.method === 'CONNECT'}
                  <span class="capture-row-tunnel">{entry.inProgress ? 'Open' : 'Tunnel'}</span>
                {:else if entry.inProgress}
                  <span class="capture-row-tunnel">Streaming</span>
                {:else}
                  <span class="status-badge {statusClass(entry.status)}">{entry.status}</span>
                {/if}
                <span class="mock-duration">{entry.inProgress ? '—' : entry.duration + ' ms'}</span>
                <span class="mock-duration capture-size">{formatSize(entry.received)}</span>
              </button>
            {/snippet}
          </VirtualList>
        {:else if loaded}
          <div class="empty-state mock-empty">
            <strong class="empty-state-title">{rows.length ? 'No matching traffic' : status.running ? 'Waiting for traffic' : 'Start a capture'}</strong>
            <span class="empty-state-text">{rows.length ? 'Change the filters to see other entries.' : status.running ? (status.systemProxy ? 'Open or reload a site in any browser.' : 'Open or reload a site in your configured browser.') : systemProxyOn ? 'Click Record, then open a site in any browser.' : 'Connect your browser in Settings, then click Record.'}</span>
          </div>
        {/if}
      </div>
    </div>
    {#if current}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
      <div class="capture-split" role="separator" aria-orientation="horizontal" aria-label="Resize details" aria-valuemin={20} aria-valuemax={80} aria-valuenow={Math.round(split * 100)} tabindex="0" onpointerdown={startResize} onkeydown={onSplitKeydown}></div>
      <div class="capture-detail-wrap" style:flex-basis={`${split * 100}%`}>
        <ProxyExchangeDetail entry={current} exchange={shown} {busy} recording={status.running} decrypted={sslHosts.includes(current.host.toLowerCase().replace(/:443$/, ''))}
          onReplay={openForReplay} onCopyCurl={copyCurl} onMapLocal={beginRule} onSave={beginSave} onDecrypt={item => setSSLHosts([...sslHosts, item])} />
      </div>
    {/if}
  </div>
</section>
</div>

{#if saving}
  <ProxyDialog title="Save as request" subtitle="Kurlo saves the request and its response as an example." submitLabel="Save request" {busy} onSubmit={() => saving && save([saving.id])} onDismiss={() => (saving = null)}>
    <label class="capture-dialog-field"><span>Request name</span><input autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck={false} class="field field-md" required bind:value={saving.name} data-autofocus></label>
    <div class="capture-dialog-field"><span>Collection</span>
      <Select bind:value={saving.collection} options={[...collections.map(item => ({ value: item.id, label: item.name })), { value: '', label: 'New Captured collection' }]} ariaLabel="Collection" className="capture-dialog-select" />
    </div>
    <label class="capture-dialog-field"><span>Folder</span><input autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck={false} class="field field-md" bind:value={saving.folder}></label>
  </ProxyDialog>
{/if}

{#if rule}
  <ProxyDialog title="Local response" subtitle={`Kurlo answers ${rule.url} itself while recording.`} submitLabel="Apply local response" {busy} wide onSubmit={applyRule} onDismiss={() => (rule = null)}>
    <div class="capture-dialog-grid">
      <label class="capture-dialog-field"><span>Status</span><input type="number" class="field field-mono field-md" min="200" max="599" required bind:value={rule.status}></label>
      <label class="capture-dialog-field capture-dialog-span"><span>Content-Type</span><input autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck={false} class="field field-mono field-md" required bind:value={rule.contentType}></label>
    </div>
    {#if exampleRequests.length}
      <div class="capture-dialog-grid">
        <div class="capture-dialog-field capture-dialog-span"><span>Use a saved example</span>
          <Select bind:value={rule.exampleRequest} options={[{ value: '', label: 'Choose a request…' }, ...exampleRequests.map(request => ({ value: request.id, label: `${request.collection} / ${request.name}` }))]} ariaLabel="Saved request" className="capture-dialog-select" onChange={id => { if (id) void action(() => vm.ensureRequestExamples([id])); }} />
        </div>
        {#if ruleExamples.length}
          <div class="capture-dialog-field capture-dialog-span"><span>Response example</span>
            <Select value="" options={[{ value: '', label: 'Choose an example…' }, ...ruleExamples.map(example => ({ value: example.id, label: example.name }))]} ariaLabel="Response example" className="capture-dialog-select" onChange={chooseExample} />
          </div>
        {/if}
      </div>
    {/if}
    <div class="capture-dialog-field">
      <span class="capture-dialog-label-row">Body <button class="btn btn-ghost btn-xs" type="button" onclick={loadRuleFile}>Load file…</button></span>
      <textarea class="field field-mono capture-dialog-text" aria-label="Local response body" bind:value={rule.body}></textarea>
    </div>
    <Disclosure title="Network conditions" summary={rule.delay || rule.rateKiB || rule.fault || rule.pause ? 'On' : 'Off'} storageKey="kurlo.proxy.ruleNetwork">
      <div class="capture-dialog-grid">
        <label class="capture-dialog-field"><span>Delay, ms</span><input type="number" class="field field-mono field-md" min="0" max="30000" required bind:value={rule.delay}></label>
        <label class="capture-dialog-field"><span>Speed, KiB/s (0 = unlimited)</span><input type="number" class="field field-mono field-md" min="0" max="16384" required bind:value={rule.rateKiB}></label>
        <label class="capture-dialog-field"><span>HTTP 503, %</span><input type="number" class="field field-mono field-md" min="0" max="100" required bind:value={rule.fault}></label>
      </div>
      <label class="capture-option"><input class="check" type="checkbox" bind:checked={rule.pause}><span><span class="capture-option-title">Pause before sending</span><span class="capture-option-note">Edit the response and release it within 60 seconds.</span></span></label>
    </Disclosure>
    <Disclosure title="JavaScript hooks" summary={rule.script.trim() ? 'On' : 'Off'} storageKey="kurlo.proxy.ruleHooks">
      <textarea class="field field-mono capture-dialog-text" aria-label="Local response hooks" placeholder={'function onResponse(request, response) { response.status = 202; }'} bind:value={rule.script}></textarea>
    </Disclosure>
  </ProxyDialog>
{/if}

{#if release}
  <ProxyDialog title="Paused response" subtitle={release.label} submitLabel="Release response" {busy} onSubmit={releaseResponse} onDismiss={() => (release = null)}>
    <label class="capture-dialog-field"><span>Status</span><input class="field field-mono field-md" type="number" bind:value={release.status} min="200" max="599"></label>
    <div class="capture-dialog-field"><span>Body</span><textarea class="field field-mono capture-dialog-text" aria-label="Paused response body" bind:value={release.body}></textarea></div>
  </ProxyDialog>
{/if}
