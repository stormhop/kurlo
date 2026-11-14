<script lang="ts">
  import BirdSpinner from './BirdSpinner.svelte';
  import { NAME_MAX_LENGTH } from '../constants';
  import { onMount } from 'svelte';
  import Select from './Select.svelte';
  import Disclosure from './Disclosure.svelte';
  import { agentMcpServers, cancelAgentMcpSignIn, deleteAgentMcpServer, saveAgentMcpServer, signInAgentMcpServer, signOutAgentMcpServer, testAgentMcpServer, type AgentMcpPair, type AgentMcpServer } from '../backend';

  const KIND_OPTIONS = [
    { value: 'http', label: 'HTTP' },
    { value: 'stdio', label: 'Local command' },
  ];
  const AUTH_OPTIONS = [
    { value: '', label: 'Headers' },
    { value: 'oauth', label: 'OAuth sign-in' },
  ];

  let servers = $state<AgentMcpServer[]>([]);
  let listError = $state('');
  let editing = $state<AgentMcpServer | null>(null);
  let name = $state('');
  let kind = $state('http');
  let url = $state('');
  let command = $state('');
  let args = $state('');
  let pairs = $state('');
  let busy = $state(false);
  let formError = $state('');
  let tested = $state('');
  let pendingRemove = $state('');
  let authMode = $state('');
  let clientId = $state('');
  let signingIn = $state('');
  const summary = $derived.by(() => {
    if (!servers.length) return 'None';
    const off = servers.filter(server => !server.enabled).length;
    const names = servers.filter(server => server.enabled).map(server => server.name).join(', ');
    return off ? `${names || 'None on'}${names ? ` · ${off} off` : ''}` : names;
  });

  async function refresh() {
    const state = await agentMcpServers();
    servers = state.servers;
    listError = state.error ?? '';
  }

  function pairsText(list: AgentMcpPair[]): string {
    return list.map(pair => `${pair.key}=`).join('\n');
  }

  function open(server: AgentMcpServer | null) {
    editing = server ?? { id: '', name: '', kind: 'http', url: '', command: '', args: [], headers: [], env: [], enabled: true, auth: '', oauthClientId: '' };
    authMode = editing.auth ?? '';
    clientId = editing.oauthClientId ?? '';
    name = editing.name;
    kind = editing.kind || 'http';
    url = editing.url ?? '';
    command = editing.command ?? '';
    args = (editing.args ?? []).join('\n');
    pairs = pairsText(kind === 'http' ? editing.headers : editing.env);
    formError = '';
    tested = '';
  }

  function parsePairs(text: string, saved: AgentMcpPair[]): AgentMcpPair[] {
    const known = new Set(saved.filter(pair => pair.set).map(pair => pair.key));
    const out: AgentMcpPair[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const separator = kind === 'http' && !trimmed.includes('=') ? trimmed.indexOf(':') : trimmed.indexOf('=');
      const key = (separator >= 0 ? trimmed.slice(0, separator) : trimmed).trim();
      const value = separator >= 0 ? trimmed.slice(separator + 1).trim() : '';
      if (!key) continue;
      out.push(value ? { key, value } : { key, set: known.has(key) });
    }
    return out;
  }

  function draft(): AgentMcpServer {
    const base = editing!;
    const saved = kind === 'http' ? base.headers : base.env;
    const parsed = parsePairs(pairs, saved);
    return {
      id: base.id,
      name: name.trim(),
      kind,
      url: url.trim(),
      command: command.trim(),
      args: args.split('\n').map(arg => arg.trim()).filter(Boolean),
      headers: kind === 'http' ? parsed : [],
      env: kind === 'stdio' ? parsed : [],
      enabled: base.enabled,
      auth: kind === 'http' ? authMode : '',
      oauthClientId: kind === 'http' && authMode === 'oauth' ? clientId.trim() : '',
    };
  }

  function testedText(tools: number, resources: boolean, prompts: boolean): string {
    const parts = [tools === 1 ? '1 tool' : `${tools} tools`];
    if (resources) parts.push('resources');
    if (prompts) parts.push('prompts');
    return `Connected. ${parts.join(', ')} available.`;
  }

  async function signIn(server: AgentMcpServer) {
    signingIn = server.id;
    listError = '';
    try {
      const state = await signInAgentMcpServer(server.id);
      servers = state.servers;
      listError = state.error ?? '';
    } finally {
      signingIn = '';
    }
  }

  async function signOut(server: AgentMcpServer) {
    const state = await signOutAgentMcpServer(server.id);
    servers = state.servers;
    listError = state.error ?? '';
  }

  async function test() {
    busy = true;
    formError = '';
    tested = '';
    try {
      const result = await testAgentMcpServer(draft());
      if (result.ok) tested = testedText(result.tools.length, Boolean(result.resources), Boolean(result.prompts));
      else formError = result.error || 'Kurlo could not reach the server.';
    } finally {
      busy = false;
    }
  }

  async function save() {
    busy = true;
    formError = '';
    try {
      const state = await saveAgentMcpServer(draft());
      if (state.error) {
        formError = state.error;
        return;
      }
      servers = state.servers;
      editing = null;
    } finally {
      busy = false;
    }
  }

  async function toggle(server: AgentMcpServer) {
    const state = await saveAgentMcpServer({ ...server, enabled: !server.enabled, headers: server.headers.map(pair => ({ key: pair.key, set: pair.set })), env: server.env.map(pair => ({ key: pair.key, set: pair.set })) });
    servers = state.servers;
    listError = state.error ?? '';
  }

  async function remove(server: AgentMcpServer) {
    if (pendingRemove !== server.id) {
      pendingRemove = server.id;
      return;
    }
    pendingRemove = '';
    const state = await deleteAgentMcpServer(server.id);
    servers = state.servers;
    listError = state.error ?? '';
  }

  onMount(() => {
    void refresh();
  });
</script>

<Disclosure title="MCP servers for the agent" summary={summary} storageKey="settings-ai-mcp" forceOpen={editing !== null} variant="settings">
  {#if listError}<p class="settings-group-note error" role="alert">{listError}</p>{/if}
  {#if editing}
    <form class="settings-group agent-mcp-form" aria-label={editing.id ? `Edit ${editing.name}` : 'Add an MCP server'} onsubmit={event => { event.preventDefault(); void save(); }}>
      <div class="agent-mcp-row">
        <label class="agent-mcp-label" for="agent-mcp-name">Name</label>
        <input id="agent-mcp-name" class="field agent-mcp-input" type="text" maxlength={NAME_MAX_LENGTH} spellcheck="false" autocomplete="off" placeholder="GitHub" bind:value={name} autocorrect="off" autocapitalize="none" />
      </div>
      <div class="agent-mcp-row">
        <span class="agent-mcp-label">Type</span>
        <Select value={kind} options={KIND_OPTIONS} className="agent-mcp-select" ariaLabel="Server type" onChange={value => { kind = value; pairs = ''; tested = ''; }} />
      </div>
      {#if kind === 'http'}
        <div class="agent-mcp-row">
          <label class="agent-mcp-label" for="agent-mcp-url">URL</label>
          <input id="agent-mcp-url" class="field agent-mcp-input agent-mcp-mono" type="url" spellcheck="false" autocomplete="off" placeholder="https://mcp.example.com/mcp" bind:value={url} autocorrect="off" autocapitalize="none" />
        </div>
        <div class="agent-mcp-row">
          <span class="agent-mcp-label">Sign-in</span>
          <Select value={authMode} options={AUTH_OPTIONS} className="agent-mcp-select" ariaLabel="Sign-in" onChange={value => { authMode = value; tested = ''; }} />
        </div>
        {#if authMode === 'oauth'}
          <div class="agent-mcp-row">
            <label class="agent-mcp-label" for="agent-mcp-client">Client ID</label>
            <input id="agent-mcp-client" class="field agent-mcp-input agent-mcp-mono" type="text" spellcheck="false" autocomplete="off" placeholder="Optional" bind:value={clientId} autocorrect="off" autocapitalize="none" />
          </div>
          <p class="agent-mcp-note">Save, then choose Sign in. Kurlo finds the server's sign-in page and registers itself there; enter a client ID only if the server asks for one you created.</p>
        {/if}
        <div class="agent-mcp-row agent-mcp-top">
          <label class="agent-mcp-label" for="agent-mcp-pairs">Headers</label>
          <textarea id="agent-mcp-pairs" class="field agent-mcp-input agent-mcp-mono" rows="3" spellcheck="false" placeholder="Authorization: Bearer …" bind:value={pairs}></textarea>
        </div>
      {:else}
        <div class="agent-mcp-row">
          <label class="agent-mcp-label" for="agent-mcp-command">Command</label>
          <input id="agent-mcp-command" class="field agent-mcp-input agent-mcp-mono" type="text" spellcheck="false" autocomplete="off" placeholder="npx" bind:value={command} autocorrect="off" autocapitalize="none" />
        </div>
        <div class="agent-mcp-row agent-mcp-top">
          <label class="agent-mcp-label" for="agent-mcp-args">Arguments</label>
          <textarea id="agent-mcp-args" class="field agent-mcp-input agent-mcp-mono" rows="3" spellcheck="false" placeholder={'-y\n@modelcontextprotocol/server-github'} bind:value={args}></textarea>
        </div>
        <div class="agent-mcp-row agent-mcp-top">
          <label class="agent-mcp-label" for="agent-mcp-pairs">Environment</label>
          <textarea id="agent-mcp-pairs" class="field agent-mcp-input agent-mcp-mono" rows="3" spellcheck="false" placeholder="GITHUB_TOKEN=…" bind:value={pairs}></textarea>
        </div>
      {/if}
      <p class="agent-mcp-note">One per line. Values are encrypted on this computer; a line with an empty value keeps the saved one.</p>
      {#if tested}<p class="agent-mcp-ok" role="status">{tested}</p>{/if}
      {#if formError}<p class="agent-mcp-error" role="alert">{formError}</p>{/if}
      <div class="agent-mcp-actions">
        <button class="btn btn-ghost btn-sm" type="button" onclick={() => (editing = null)}>Cancel</button>
        <button class="btn btn-secondary btn-sm" type="button" disabled={busy} onclick={() => void test()}>{#if busy}<BirdSpinner />{/if}Test</button>
        <button class="btn btn-primary btn-sm" type="submit" disabled={busy}>Save</button>
      </div>
    </form>
  {:else}
    <ul class="settings-group agent-mcp-list" aria-label="Agent MCP servers">
      {#each servers as server (server.id)}
        <li class="settings-row">
          <div class="settings-row-text">
            <span class="settings-row-title">{server.name}{#if !server.enabled}<span class="settings-pill">Off</span>{/if}{#if server.auth === 'oauth'}<span class="settings-pill">{server.signedIn ? 'Signed in' : 'Not signed in'}</span>{/if}</span>
            <span class="settings-row-desc agent-mcp-detail">{server.kind === 'http' ? server.url : [server.command, ...server.args].join(' ')}</span>
          </div>
          <div class="settings-row-control">
            {#if server.auth === 'oauth'}
              {#if signingIn === server.id}
                <button class="btn btn-ghost btn-sm" type="button" onclick={() => void cancelAgentMcpSignIn(server.id)}>Cancel sign-in</button>
              {:else if server.signedIn}
                <button class="btn btn-ghost btn-sm" type="button" onclick={() => void signOut(server)}>Sign out</button>
              {:else}
                <button class="btn btn-secondary btn-sm" type="button" disabled={Boolean(signingIn)} onclick={() => void signIn(server)}>Sign in</button>
              {/if}
            {/if}
            <button class="btn btn-ghost btn-sm" type="button" onclick={() => void toggle(server)}>{server.enabled ? 'Turn off' : 'Turn on'}</button>
            <button class="btn btn-ghost btn-sm" type="button" onclick={() => open(server)}>Edit</button>
            <button class="btn btn-ghost btn-sm" class:btn-danger={pendingRemove === server.id} type="button" onclick={() => void remove(server)} onblur={() => pendingRemove === server.id && (pendingRemove = '')}>{pendingRemove === server.id ? 'Remove?' : 'Remove'}</button>
          </div>
        </li>
      {/each}
      <li class="settings-row">
        <div class="settings-row-text">
          <span class="settings-row-title">{servers.length ? 'Add another server' : 'Add a server'}</span>
          <span class="settings-row-desc">GitHub, Jira, a database or your own service, over HTTP or as a local command.</span>
        </div>
        <div class="settings-row-control">
          <button class="btn btn-secondary btn-sm" type="button" onclick={() => open(null)}>Add MCP server</button>
        </div>
      </li>
    </ul>
  {/if}
  <p class="settings-group-note">Every tool call waits for your approval unless you allow that tool for the chat. Reading a server's resources and prompts runs without asking. Answers are treated as data, not instructions.</p>
</Disclosure>

<style>
  .agent-mcp-detail {
    overflow: hidden;
    font-family: var(--font-mono);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .agent-mcp-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3);
  }
  .agent-mcp-row {
    display: grid;
    grid-template-columns: 7rem minmax(0, 1fr);
    align-items: center;
    gap: var(--space-2);
  }
  .agent-mcp-top {
    align-items: start;
  }
  .agent-mcp-label {
    color: var(--text-2);
    font-size: var(--text-label);
  }
  .agent-mcp-input {
    width: 100%;
    min-width: 0;
  }
  textarea.agent-mcp-input {
    height: auto;
    padding-block: var(--space-1-5);
    resize: vertical;
  }
  .agent-mcp-mono {
    font-family: var(--font-mono);
    font-size: var(--text-label);
  }
  .agent-mcp-row :global(.agent-mcp-select) {
    max-width: 12rem;
  }
  .agent-mcp-note {
    margin: 0;
    color: var(--text-3);
    font-size: var(--text-caption);
  }
  .agent-mcp-ok {
    margin: 0;
    color: var(--s2xx);
    font-size: var(--text-label);
  }
  .agent-mcp-error {
    margin: 0;
    color: var(--danger);
    font-size: var(--text-label);
    overflow-wrap: anywhere;
  }
  .agent-mcp-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-1);
  }
</style>
