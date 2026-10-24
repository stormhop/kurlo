<script lang="ts">
  import { vm } from '../stores/app.svelte';
  import { aiSettingErrors } from '../stores/features/ai';

  const servers = $derived(vm.aiToolServerOptions());
  const selected = $derived(new Set(vm.aiToolRequestIds));
  const stepError = $derived(aiSettingErrors({ aiMaxSteps: vm.aiMaxSteps }).aiMaxSteps ?? '');
  const missing = $derived(vm.aiToolRequestIds.filter(id => !servers.some(server => server.id === id)));
</script>

<div class="ai-tools">
  <p class="ai-tools-intro">
    Give the model the tools of MCP servers saved in this workspace. When it calls one, Kurlo runs the call with that request's URL, auth and headers and sends the result back, until the model answers or the step limit is reached.
  </p>

  {#if servers.length}
    <div class="ai-tools-list" role="group" aria-label="MCP servers">
      {#each servers as server (server.id)}
        <label class="ai-tool-row">
          <input class="check" type="checkbox" checked={selected.has(server.id)} onchange={() => vm.toggleAiToolServer(server.id)} />
          <span class="ai-tool-main">
            <span class="ai-tool-name">{server.name}</span>
            <span class="ai-tool-url">{server.url}</span>
          </span>
          {#if server.collection}<span class="ai-tool-collection">{server.collection}</span>{/if}
        </label>
      {/each}
    </div>
  {:else}
    <div class="empty-state">
      <p class="empty-state-title">No MCP servers yet</p>
      <p class="empty-state-text">Save an MCP request with the server's URL and auth, then pick it here.</p>
      <button class="btn btn-secondary" type="button" onclick={() => vm.createDraftRequest('mcp')}>New MCP request</button>
    </div>
  {/if}

  {#if missing.length}
    <p class="ai-tools-warning" role="status">{missing.length === 1 ? 'One selected server no longer exists' : `${missing.length} selected servers no longer exist`} and will be skipped.</p>
  {/if}

  <label class="ai-tools-steps">
    <span>Step limit</span>
    <input class="field field-md field-mono" class:ai-invalid={stepError} inputmode="numeric" placeholder="8" aria-invalid={Boolean(stepError)} bind:value={vm.aiMaxSteps} />
    <span class="ai-tools-hint">Model calls in one send, counting each round of tool calls.</span>
    {#if stepError}<span class="ai-field-error" role="alert">{stepError}</span>{/if}
  </label>
</div>

<style>
  .ai-tools {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    height: 100%;
    min-height: 0;
    padding: var(--space-3) var(--space-4) var(--space-4);
    overflow: auto;
  }
  .ai-tools-intro {
    margin: 0;
    max-width: 40rem;
    color: var(--text-2);
    font-size: var(--text-body);
    line-height: var(--leading-normal);
  }
  .ai-tools-list {
    display: flex;
    flex-direction: column;
    border-top: 1px solid var(--border-subtle);
  }
  .ai-tool-row {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--space-3);
    min-height: var(--control-xl);
    padding: var(--space-1-5) var(--space-1);
    border-bottom: 1px solid var(--border-subtle);
    cursor: pointer;
  }
  .ai-tool-row:hover {
    background: var(--hover);
  }
  .ai-tool-main {
    display: flex;
    flex-direction: column;
    gap: var(--space-0-5);
    min-width: 0;
  }
  .ai-tool-name {
    color: var(--text);
    font-size: var(--text-body);
    font-weight: var(--weight-medium);
  }
  .ai-tool-url,
  .ai-tool-collection {
    min-width: 0;
    overflow: hidden;
    color: var(--text-3);
    font-size: var(--text-caption);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ai-tool-url {
    font-family: var(--font-mono);
  }
  .ai-tools-warning {
    margin: 0;
    color: var(--warning);
    font-size: var(--text-label);
  }
  .ai-tools-steps {
    display: grid;
    grid-template-columns: auto 5rem minmax(0, 1fr);
    align-items: center;
    gap: var(--space-2);
    color: var(--text-2);
    font-size: var(--text-label);
  }
  .ai-invalid,
  .ai-invalid:focus {
    border-color: var(--danger);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--danger) 35%, transparent);
  }
  .ai-field-error {
    grid-column: 2 / -1;
    color: var(--danger);
    font-size: var(--text-caption);
  }
  .ai-tools-hint {
    color: var(--text-3);
    font-size: var(--text-caption);
  }
</style>
