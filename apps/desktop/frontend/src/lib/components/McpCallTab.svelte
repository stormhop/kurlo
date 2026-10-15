<script lang="ts">
  import CodeEditor from '../CodeEditor.svelte';
  import Select from './Select.svelte';
  import { vm } from '../stores/app.svelte';
  import {
    MCP_METHODS,
    mcpMethodNeedsName,
    mcpMethodTakesArguments,
    mcpNameLabelFor,
    mcpSessionProtocolVersion,
  } from '../stores/features/mcp';

  const METHOD_OPTIONS = MCP_METHODS.map(method => ({ value: method, label: method }));

  const catalog = $derived(vm.mcpCatalog);
  const needsName = $derived(mcpMethodNeedsName(vm.mcpMethod));
  const takesArguments = $derived(mcpMethodTakesArguments(vm.mcpMethod));
  const nameLabel = $derived(mcpNameLabelFor(vm.mcpMethod));
  const argumentsError = $derived(vm.mcpArgumentsError());
  const selectedTool = $derived(vm.mcpSelectedTool());
  const rejection = $derived(vm.mcpSelectedToolRejection());

  const nameOptions = $derived.by(() => {
    const empty = { value: '', label: `Choose a ${nameLabel.toLowerCase()}` };
    if (vm.mcpMethod === 'tools/call') {
      return [empty, ...(catalog?.tools ?? []).map(tool => ({
        value: tool.name,
        label: tool.rejected ? `${tool.title || tool.name} — unusable` : (tool.title || tool.name),
      }))];
    }
    if (vm.mcpMethod === 'resources/read') {
      return [empty, ...(catalog?.resources ?? []).map(resource => ({
        value: resource.uri,
        label: resource.title || resource.name || resource.uri,
      }))];
    }
    if (vm.mcpMethod === 'prompts/get') {
      return [empty, ...(catalog?.prompts ?? []).map(prompt => ({
        value: prompt.name,
        label: prompt.title || prompt.name,
      }))];
    }
    return [];
  });

  const counts = $derived.by(() => {
    if (!catalog) return [];
    const rows: string[] = [];
    const push = (count: number, one: string, many: string) => {
      if (count) rows.push(`${count} ${count === 1 ? one : many}`);
    };
    push(catalog.tools.length, 'tool', 'tools');
    push(catalog.resources.length, 'resource', 'resources');
    push(catalog.prompts.length, 'prompt', 'prompts');
    return rows;
  });

  const detail = $derived(
    (needsName ? selectedTool?.description : '') || catalog?.instructions || '',
  );

  const sessionProtocol = $derived(mcpSessionProtocolVersion(catalog));

  const summaryTitle = $derived([
    catalog?.serverName,
    catalog?.serverVersion,
    sessionProtocol && `MCP ${sessionProtocol}`,
    counts.join(' · '),
    detail,
  ].filter(Boolean).join(' · '));

  function chooseName(value: string) {
    if (vm.mcpMethod === 'tools/call') vm.selectMcpTool(value);
    else vm.mcpName = value;
  }
</script>

<div class="mcp-call">
  <div class="mcp-call-bar">
    <div class="mcp-field mcp-field-method">
      <span class="mcp-field-label">Method</span>
      <Select
        value={vm.mcpMethod}
        options={METHOD_OPTIONS}
        className="mcp-select"
        onChange={value => vm.selectMcpMethod(value)}
      />
    </div>

    {#if needsName}
      <div class="mcp-field mcp-field-name">
        <span class="mcp-field-label">{nameLabel}</span>
        {#if nameOptions.length > 1}
          <Select
            value={vm.mcpName}
            options={nameOptions}
            className="mcp-select"
            onChange={chooseName}
          />
        {:else}
          <input
            class="field field-md mcp-name-input"
            type="text"
            spellcheck="false"
            autocomplete="off"
            aria-label={nameLabel}
            placeholder={vm.mcpMethod === 'resources/read' ? 'file:///path/to/resource' : 'Discover the server, or type a name'}
            bind:value={vm.mcpName}
          />
        {/if}
      </div>
    {/if}

    <button
      class="btn btn-secondary btn-lg mcp-discover"
      type="button"
      onclick={() => void vm.discoverMcpServer()}
      disabled={vm.mcpCatalogLoading}
    >
      {#if vm.mcpCatalogLoading}<span class="spinner spinner-inline"></span>{/if}
      Discover
    </button>
  </div>

  {#if vm.mcpCatalogError}
    <p class="mcp-notice mcp-notice-bad" role="alert">{vm.mcpCatalogError}</p>
  {:else if needsName && rejection}
    <p class="mcp-notice mcp-notice-bad" role="alert">Kurlo will not call this tool: {rejection}</p>
  {:else if catalog}
    <p class="mcp-server" title={summaryTitle}>
      <span class="mcp-server-name">{catalog.serverName || 'This server'}</span>
      {#if catalog.serverVersion}<span class="mcp-server-version">{catalog.serverVersion}</span>{/if}
      {#if sessionProtocol}<span class="mcp-server-meta" title="This server predates stateless MCP, so Kurlo talks to it in a session">· MCP {sessionProtocol}</span>{/if}
      {#if counts.length}<span class="mcp-server-meta">· {counts.join(' · ')}</span>{/if}
      {#if detail}<span class="mcp-server-detail">— {detail}</span>{/if}
    </p>
  {/if}

  {#if takesArguments}
    <div class="mcp-arguments">
      <div class="mcp-arguments-head">
        <span class="mcp-field-label">Arguments</span>
        {#if selectedTool?.inputSchema}
          <span class="mcp-arguments-hint">checked against the tool's input schema</span>
        {/if}
      </div>
      <div class="mcp-editor" class:invalid={Boolean(argumentsError)}>
        <CodeEditor
          bind:value={vm.mcpArguments}
          language="json"
          fillHeight
          ariaLabel="Tool arguments"
          variableSuggestions={vm.variableSuggestions}
          placeholder={'{\n  "key": "value"\n}'}
        />
      </div>
      {#if argumentsError}
        <p class="mcp-notice mcp-notice-bad" role="alert">{argumentsError}</p>
      {/if}
    </div>
  {:else}
    <p class="mcp-notice">{vm.mcpMethod} takes no arguments — press Send to call it.</p>
  {/if}
</div>

<style>
  .mcp-call {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-height: 0;
    height: 100%;
    padding: var(--space-3) var(--space-4) var(--space-4);
    overflow: hidden;
  }

  .mcp-call-bar {
    display: flex;
    align-items: flex-end;
    gap: var(--space-2-5);
    flex: 0 0 auto;
    flex-wrap: wrap;
  }

  .mcp-field {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
  }

  .mcp-field-method {
    flex: 0 0 auto;
    width: 11.25rem;
  }

  .mcp-field-name {
    flex: 1 1 16.25rem;
  }

  .mcp-field-label {
    color: var(--text);
    font-size: var(--text-label);
    font-weight: var(--weight-semibold);
  }

  .mcp-call :global(.mcp-select),
  .mcp-call :global(.mcp-select .app-select-trigger) {
    width: 100%;
  }

  .mcp-name-input {
    width: 100%;
    font: inherit;
  }

  .mcp-discover {
    flex: 0 0 auto;
    min-width: 6.75rem;
  }

  .mcp-discover:disabled {
    opacity: var(--opacity-disabled);
    cursor: default;
  }

  .mcp-server {
    flex: 0 0 auto;
    margin: 0;
    color: var(--text-3);
    font-size: var(--text-label);
    line-height: var(--leading-normal);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .mcp-server-name {
    color: var(--text-2);
    font-weight: var(--weight-semibold);
  }

  .mcp-server-version {
    font-family: var(--font-mono);
    font-size: var(--text-caption);
  }

  .mcp-server-meta,
  .mcp-server-detail {
    color: var(--text-3);
  }

  .mcp-notice {
    display: -webkit-box;
    flex: 0 0 auto;
    margin: 0;
    color: var(--text-3);
    font-size: var(--text-label);
    line-height: var(--leading-normal);
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
  }

  .mcp-notice-bad {
    color: var(--s4xx);
  }

  .mcp-arguments {
    display: flex;
    flex-direction: column;
    gap: var(--space-1-5);
    flex: 1 1 auto;
    min-height: 0;
  }

  .mcp-arguments-head {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    margin-bottom: var(--space-0-5);
  }

  .mcp-arguments-hint {
    color: var(--text-3);
    font-size: var(--text-caption);
  }

  .mcp-editor {
    flex: 1 1 auto;
    min-height: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }

  .mcp-editor.invalid {
    border-color: color-mix(in srgb, var(--s4xx) 55%, var(--border));
  }

</style>
