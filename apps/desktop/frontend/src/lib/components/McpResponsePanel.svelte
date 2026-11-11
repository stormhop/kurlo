<script lang="ts">
  import Keycaps from './Keycaps.svelte';
  import { tabListKeyboard } from '../a11y';
  import { vm } from '../stores/app.svelte';
  import { formatSize, statusClass } from '../utils';

  type McpTab = 'result' | 'raw' | 'notifications';

  let tab = $state<McpTab>('result');

  const response = $derived(vm.mcpResponse);
  const http = $derived(response?.http ?? null);
  const notificationCount = $derived(response?.notifications.length ?? 0);
  const hasResult = $derived(Boolean(
    response && (
      response.content.length ||
      response.structuredContent ||
      response.inputRequests ||
      response.result
    ),
  ));

  $effect(() => {
    if (!response) return;
    if (tab === 'notifications' && !response.notifications.length) tab = 'result';
  });
</script>

<div class="response-area ws-panel mcp-response-area">
  {#if vm.loading && !response}
    <div class="response-placeholder" role="status">
      <span class="response-spinner"></span>
      <span class="response-placeholder-text">Sending the call…</span>
    </div>

  {:else if vm.requestError && !response}
    <div class="response-placeholder error" role="textbox" aria-readonly="true" tabindex="0">
      <div class="request-error-shell">
        <div class="request-error-title">Could not send the call</div>
        <div class="request-error-card">
          <svg width="1.25rem" height="1.25rem" viewBox="0 0 20 20" fill="none">
            <path d="M10 2l8 14H2L10 2z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
            <path d="M10 7v4M10 14v.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
          <span>{vm.requestError}</span>
        </div>
      </div>
    </div>

  {:else if response}
    <div class="response-status-bar">
      <div class="status-left">
        {#if http}
          <span class="status-badge {statusClass(http.statusCode)}">{http.statusCode || '—'}</span>
          <span class="status-meta">{http.duration} ms</span>
          <span class="status-meta">{formatSize(http.size)}</span>
        {/if}
        {#if response.isError}
          <span class="test-summary-pill">Tool error</span>
        {/if}
        {#if response.resultType === 'input_required'}
          <span class="test-summary-pill">Input required</span>
        {/if}
        {#if response.rpcErrorMessage}
          <span class="test-summary-pill">JSON-RPC {response.rpcErrorCode}</span>
        {/if}
      </div>
      <div class="status-right">
      </div>
      <div class="tab-bar response-mini-tabs" role="tablist" use:tabListKeyboard>
        <button class="tab"
          role="tab"
          type="button"
          class:active={tab === 'result'}
          aria-selected={tab === 'result'}
          aria-controls="mcp-response-result"
          tabindex={tab === 'result' ? 0 : -1}
          onclick={() => (tab = 'result')}
        >
          Result{#if response.content.length}<span class="badge">{response.content.length}</span>{/if}
        </button>
        <button class="tab"
          role="tab"
          type="button"
          class:active={tab === 'raw'}
          aria-selected={tab === 'raw'}
          aria-controls="mcp-response-raw"
          tabindex={tab === 'raw' ? 0 : -1}
          onclick={() => (tab = 'raw')}
        >
          Raw exchange
        </button>
        {#if notificationCount}
          <button class="tab"
            role="tab"
            type="button"
            class:active={tab === 'notifications'}
            aria-selected={tab === 'notifications'}
            aria-controls="mcp-response-notifications"
            tabindex={tab === 'notifications' ? 0 : -1}
            onclick={() => (tab = 'notifications')}
          >
            Notifications<span class="badge">{notificationCount}</span>
          </button>
        {/if}
      </div>
    </div>

    {#if response.warnings.length}
      <div class="mcp-warnings" role="status">
        <svg width="0.875rem" height="0.875rem" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 2l6 11H2L8 2z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
          <path d="M8 6.4v3M8 11.4v.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
        </svg>
        <div class="mcp-warning-lines">
          {#each response.warnings as warning, index (index)}<span>{warning}</span>{/each}
        </div>
      </div>
    {/if}

    {#if tab === 'result'}
      <div class="response-tab-panel mcp-result-panel" id="mcp-response-result" role="tabpanel">
        {#if response.rpcErrorMessage}
          <div class="mcp-block">
            <div class="mcp-block-head mcp-block-head-bad">JSON-RPC error {response.rpcErrorCode}</div>
            <p class="mcp-block-message">{response.rpcErrorMessage}</p>
            {#if response.rpcErrorData}<pre class="mcp-code">{response.rpcErrorData}</pre>{/if}
          </div>
        {/if}

        {#each response.content as block, index (index)}
          <div class="mcp-block">
            <div class="mcp-block-head">
              <span class="mcp-block-kind">{block.type}</span>
              {#if block.mimeType}<span class="mcp-block-meta">{block.mimeType}</span>{/if}
            </div>
            {#if block.uri}<code class="mcp-block-uri">{block.uri}</code>{/if}
            {#if block.text}
              <pre class="mcp-code">{block.text}</pre>
            {:else if block.data}
              <p class="mcp-block-message">{formatSize(block.data.length)} of base64 {block.type} data</p>
            {/if}
          </div>
        {/each}

        {#if response.structuredContent}
          <div class="mcp-block">
            <div class="mcp-block-head"><span class="mcp-block-kind">structuredContent</span></div>
            <pre class="mcp-code">{response.structuredContent}</pre>
          </div>
        {/if}

        {#if response.inputRequests}
          <div class="mcp-block">
            <div class="mcp-block-head"><span>Input required</span></div>
            <p class="mcp-block-message">The server needs more before it can finish. Answer in the Arguments tab and send again.</p>
            <pre class="mcp-code">{response.inputRequests}</pre>
          </div>
        {/if}

        {#if !response.content.length && !response.structuredContent && !response.inputRequests && response.result}
          <div class="mcp-block">
            <div class="mcp-block-head"><span>{response.resultType || 'result'}</span></div>
            <pre class="mcp-code">{response.result}</pre>
          </div>
        {/if}

        {#if !hasResult && !response.rpcErrorMessage}
          <div class="response-placeholder response-empty-state" role="status">
            <span class="response-placeholder-text">The server answered with an empty result</span>
          </div>
        {/if}
      </div>

    {:else if tab === 'raw'}
      <div class="response-tab-panel mcp-result-panel" id="mcp-response-raw" role="tabpanel">
        {#if http?.body}
          <pre class="mcp-code mcp-code-raw">{http.body}</pre>
        {:else}
          <div class="response-placeholder response-empty-state" role="status">
            <span class="response-placeholder-text">The server sent no body</span>
          </div>
        {/if}
      </div>

    {:else}
      <div class="response-tab-panel mcp-result-panel" id="mcp-response-notifications" role="tabpanel">
        {#each response.notifications as notification, index (index)}
          <div class="mcp-block">
            <div class="mcp-block-head"><span>{notification.method}</span></div>
            {#if notification.params}<pre class="mcp-code">{notification.params}</pre>{/if}
          </div>
        {/each}
      </div>
    {/if}

  {:else}
    <div class="response-placeholder response-empty-state" role="status">
      <svg width="2rem" height="2rem" viewBox="0 0 32 32" fill="none" opacity="0.35">
        <circle cx="16" cy="16" r="14" stroke="currentColor" stroke-width="1.5"/>
        <path d="M12 16h8M16 12l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span class="response-placeholder-text">Send a call to see what the server answers</span>
      {#if vm.shortcutCombo('send-request')}<span class="response-placeholder-hint"><Keycaps combo={vm.shortcutCombo('send-request')} runtime={vm.appRuntime} /> to send</span>{/if}
    </div>
  {/if}
</div>

<style>
  .mcp-warnings {
    display: flex;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--border);
    background: var(--warning-bg-subtle);
    color: var(--s4xx);
  }

  .mcp-warnings svg {
    flex: 0 0 auto;
    margin-top: 1px;
  }

  .mcp-warning-lines {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
    font-size: var(--text-label);
    line-height: var(--leading-normal);
  }

  .mcp-result-panel {
    padding: var(--space-3) var(--space-3);
    overflow: auto;
  }

  .mcp-block + .mcp-block {
    margin-top: var(--space-3);
  }

  .mcp-block-head {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    margin-bottom: var(--space-1-5);
    color: var(--text-2);
    font-size: var(--text-label);
    font-weight: var(--weight-medium);
  }

  .mcp-block-kind {
    font-family: var(--font-mono);
    font-size: var(--text-caption);
  }

  .mcp-block-head-bad {
    color: var(--s4xx);
  }

  .mcp-block-meta {
    font-weight: var(--weight-medium);
    letter-spacing: 0;
    text-transform: none;
  }

  .mcp-block-message {
    margin: 0 0 var(--space-1-5);
    color: var(--text-2);
    font-size: var(--text-body);
    line-height: var(--leading-normal);
  }

  .mcp-block-uri {
    display: block;
    margin-bottom: var(--space-1-5);
    color: var(--text-2);
    font-family: var(--font-mono);
    font-size: var(--text-caption);
    word-break: break-all;
  }

  .mcp-code {
    margin: 0;
    padding: var(--space-2-5) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: var(--text-label);
    line-height: var(--leading-normal);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .mcp-code-raw {
    color: var(--text-2);
  }
</style>
