<script lang="ts">
  import { tick } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { tabListKeyboard } from '../a11y';
  import Markdown from './Markdown.svelte';
  import { vm } from '../stores/app.svelte';
  import { AI_PROMPT_MAX_CHARS, aiComposerSends, aiErrorView, aiTurnUsage, type AiStepView, type AiTurn } from '../stores/features/ai';
  import { formatSize, statusClass } from '../utils';
  import type { AiBlock } from '../backend';

  type AiTab = 'chat' | 'raw' | 'tests';

  let tab = $state<AiTab>('chat');
  let reply = $state('');
  let scroller = $state<HTMLDivElement>();
  let stickToBottom = $state(true);
  const openThinking = new SvelteSet<string>();
  const rawOpen = new SvelteSet<string>();
  const rawExpanded = new SvelteSet<string>();
  const RAW_PREVIEW_CHARS = 20000;
  const NO_AUTOCORRECT: Record<string, string> = { autocorrect: 'off' };

  const turns = $derived(vm.aiConversations.get(vm.activeRequestId) ?? []);
  const last = $derived(turns.at(-1) ?? null);
  const streaming = $derived(last?.status === 'streaming');
  const http = $derived(last?.response?.http ?? null);
  const lastStep = $derived(last?.steps.at(-1) ?? null);
  const usage = $derived(last ? aiTurnUsage(last) : null);
  const hasUsage = $derived(Boolean(last?.response?.hasUsage || last?.steps.some(step => step.hasUsage)));
  const firstTokenMs = $derived(last?.response?.firstTokenMs || last?.steps[0]?.firstTokenMs || 0);
  const durationMs = $derived(last?.response?.durationMs || last?.steps.reduce((sum, step) => sum + step.durationMs, 0) || 0);
  const tokensPerSecond = $derived.by(() => {
    if (!last || !usage || !usage.output) return 0;
    const generating = last.steps.reduce((sum, step) => sum + Math.max(step.durationMs - step.firstTokenMs, 0), 0);
    return generating > 0 ? Math.round((usage.output / generating) * 1000) : 0;
  });
  const tests = $derived(last?.response?.http?.testResult ?? null);
  const testTotal = $derived(tests?.tests?.length ?? 0);
  const testPassed = $derived(tests?.tests?.filter(test => test.passed).length ?? 0);
  const rawSteps = $derived(last?.response?.steps ?? []);
  const turnKey = $derived(last?.id ?? '');
  const metricsTitle = $derived.by(() => {
    if (!usage) return '';
    const lines = [
      `First token: ${formatMs(firstTokenMs)}`,
      `Total: ${formatMs(durationMs)}`,
      `Input: ${usage.input.toLocaleString('en-US')}`,
      `Output: ${usage.output.toLocaleString('en-US')}`,
    ];
    if (usage.cacheRead) lines.push(`Cache read: ${usage.cacheRead.toLocaleString('en-US')}`);
    if (usage.cacheWrite) lines.push(`Cache write: ${usage.cacheWrite.toLocaleString('en-US')}`);
    if (usage.reasoning) lines.push(`Reasoning: ${usage.reasoning.toLocaleString('en-US')}`);
    if (last && last.steps.length > 1) lines.push(`Steps: ${last.steps.length}`);
    return lines.join('\n');
  });

  $effect(() => {
    void turns;
    void last?.steps;
    if (!stickToBottom || tab !== 'chat') return;
    void tick().then(() => {
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
  });

  function onScroll() {
    if (!scroller) return;
    stickToBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
  }

  function formatMs(ms: number) {
    if (!ms) return '—';
    return ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)} s` : `${ms} ms`;
  }

  function prettyJSON(text: string | undefined) {
    const value = (text ?? '').trim();
    if (!value) return '{}';
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }

  function rawStepOpen(index: number) {
    return rawOpen.has(`${turnKey}:${index}`) !== (index === rawSteps.length - 1);
  }

  function toggleRawStep(index: number) {
    const key = `${turnKey}:${index}`;
    if (rawOpen.has(key)) rawOpen.delete(key);
    else rawOpen.add(key);
  }

  function expandRaw(key: string) {
    rawExpanded.add(key);
  }

  function toolResultFor(step: AiStepView, block: AiBlock) {
    return step.toolResults.find(result => result.id === block.id);
  }

  function serverFor(turn: AiTurn, name: string | undefined) {
    return turn.response?.tools?.find(tool => tool.name === name)?.server ?? '';
  }

  function thinkingKey(turn: AiTurn, step: AiStepView, index: number) {
    return `${turn.id}:${step.index}:${index}`;
  }

  function toggleThinking(key: string) {
    if (openThinking.has(key)) openThinking.delete(key);
    else openThinking.add(key);
  }

  function stopLabel(reason: string) {
    switch (reason) {
      case 'end_turn': return 'end_turn';
      case 'tool_use': return 'tool_use';
      case 'max_tokens': return 'max_tokens';
      default: return reason;
    }
  }

  async function sendReply() {
    const text = reply.trim();
    if (!text || vm.loading) return;
    reply = '';
    stickToBottom = true;
    await vm.sendAiPrompt(text);
  }

  function onReplyKeydown(event: KeyboardEvent) {
    if (!aiComposerSends(event)) return;
    event.preventDefault();
    void sendReply();
  }

  async function raiseMaxTokens() {
    const current = Number(vm.aiMaxTokens) || (vm.aiProvider === 'anthropic' ? 8192 : 1024);
    vm.aiMaxTokens = String(Math.max(current * 2, 4096));
    stickToBottom = true;
    await vm.sendAiPrompt();
  }
</script>

{#snippet errorCard(text: string, note: string)}
  {@const view = aiErrorView(text)}
  <div class="ai-error-card" role="alert">
    <svg class="ai-error-icon" width="0.875rem" height="0.875rem" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" stroke-width="1.3"/>
      <path d="M8 4.75v3.75M8 10.75v.25" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
    </svg>
    <div class="ai-error-body">
      <div class="ai-error-head">
        <strong class="ai-error-title">{view.title}</strong>
        {#if view.status}<span class="ai-error-status">{view.status}</span>{/if}
      </div>
      {#if view.message}<div class="ai-error-message"><Markdown source={view.message} compact /></div>{/if}
      {#if view.hint}<span class="ai-error-hint">{view.hint}</span>{/if}
      {#if note}<span class="ai-error-hint">{note}</span>{/if}
    </div>
  </div>
{/snippet}

{#snippet rawBody(label: string, key: string, text: string)}
  {@const full = rawExpanded.has(key) || text.length <= RAW_PREVIEW_CHARS}
  <div class="ai-raw-label">{label}</div>
  <pre class="ai-raw-body">{full ? text : text.slice(0, RAW_PREVIEW_CHARS)}</pre>
  {#if !full}
    <div class="ai-raw-more">
      <span>Showing {formatSize(RAW_PREVIEW_CHARS)} of {formatSize(text.length)}</span>
      <button class="btn btn-ghost btn-sm" type="button" onclick={() => expandRaw(key)}>Show all</button>
    </div>
  {/if}
{/snippet}

<div class="response-area ai-panel">
  {#if !turns.length}
    {#if vm.requestError}
      <div class="response-placeholder error" role="textbox" aria-readonly="true" tabindex="0">
        <div class="request-error-shell">
          <div class="request-error-title">Could not send the prompt</div>
          <div class="request-error-card">
            <svg width="1.25rem" height="1.25rem" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M10 2l8 14H2L10 2z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
              <path d="M10 7v4M10 14v.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
            <span>{vm.requestError}</span>
          </div>
        </div>
      </div>
    {:else}
      <div class="response-placeholder">
        <span class="response-placeholder-text">Send the prompt to start a conversation.</span>
      </div>
    {/if}
  {:else}
    <div class="response-status-bar">
      <div class="ai-status-row">
      <div class="status-left">
        {#if streaming}
          <span class="ai-live"><span class="ai-live-dot"></span>{lastStep && lastStep.done && lastStep.stopReason === 'tool_use' ? 'Running tools…' : 'Streaming…'}</span>
        {:else if http && http.statusCode}
          <span class="status-badge {statusClass(http.statusCode)}">{http.statusCode} {http.status.replace(/^\d+\s*/, '')}</span>
        {:else if last?.status === 'cancelled'}
          <span class="status-meta">Stopped</span>
        {:else if last?.status === 'error'}
          <span class="status-badge status-5xx">Error</span>
        {/if}
        {#if lastStep?.model}<span class="status-meta ai-model-name" title={lastStep.model}>{lastStep.model}</span>{/if}
      </div>
      <div class="status-right">
        {#if firstTokenMs || hasUsage}
          <span class="ai-metrics" title={metricsTitle}>
            {#if firstTokenMs}<span class="ai-metric-ttft"><span class="ai-metric-key">TTFT</span> {formatMs(firstTokenMs)}</span>{/if}
            {#if tokensPerSecond}<span class="ai-metric-extra"><span class="ai-metric-key">speed</span> {tokensPerSecond} tok/s</span>{/if}
            {#if hasUsage && usage}
              <span><span class="ai-metric-key">in</span> {(usage.input + usage.cacheRead + usage.cacheWrite).toLocaleString('en-US')} <span class="ai-metric-key">out</span> {usage.output.toLocaleString('en-US')}</span>
              {#if usage.cacheRead}<span class="ai-metric-extra"><span class="ai-metric-key">cache</span> {usage.cacheRead.toLocaleString('en-US')}</span>{/if}
            {/if}
          </span>
        {/if}
        <button class="btn btn-secondary btn-sm ai-new-chat" type="button" onclick={() => vm.clearAiConversation()} disabled={streaming} aria-label="New chat" title="Clear the chat. Send starts again from the Prompt tab.">
          <svg width="0.75rem" height="0.75rem" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M6 2v8M2 6h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
          </svg>
          <span class="ai-new-chat-label">New chat</span>
        </button>
      </div>
      </div>
      <div class="tab-bar response-mini-tabs" role="tablist" use:tabListKeyboard>
        <button class="tab" role="tab" type="button" class:active={tab === 'chat'} aria-selected={tab === 'chat'} aria-controls="ai-panel-chat" tabindex={tab === 'chat' ? 0 : -1} onclick={() => (tab = 'chat')}>Chat</button>
        <button class="tab" role="tab" type="button" class:active={tab === 'raw'} aria-selected={tab === 'raw'} aria-controls="ai-panel-raw" tabindex={tab === 'raw' ? 0 : -1} onclick={() => (tab = 'raw')}>Raw</button>
        <button class="tab" role="tab" type="button" class:active={tab === 'tests'} aria-selected={tab === 'tests'} aria-controls="ai-panel-tests" tabindex={tab === 'tests' ? 0 : -1} onclick={() => (tab = 'tests')}>
          Tests{#if testTotal}<span class="badge" class:ai-badge-fail={testPassed < testTotal}>{testPassed}/{testTotal}</span>{/if}
        </button>
      </div>
    </div>

    {#if tab === 'chat'}
      <div class="ai-chat" id="ai-panel-chat" role="tabpanel" bind:this={scroller} onscroll={onScroll}>
        {#each turns as turn (turn.id)}
          <div class="ai-turn">
            <div class="ai-user">{turn.prompt}</div>

            {#each turn.steps as step (step.index)}
              {#each step.blocks as block, blockIndex (blockIndex)}
                {#if block.type === 'thinking' && (block.text ?? '').trim()}
                  {@const key = thinkingKey(turn, step, blockIndex)}
                  <div class="ai-thinking">
                    <button class="btn btn-ghost btn-sm ai-thinking-toggle" type="button" aria-expanded={openThinking.has(key)} onclick={() => toggleThinking(key)}>
                      <svg class:open={openThinking.has(key)} width="0.625rem" height="0.625rem" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                        <path d="M3.5 2l3 3-3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
                      </svg>
                      Thinking
                    </button>
                    {#if openThinking.has(key)}<div class="ai-thinking-text">{block.text}</div>{/if}
                  </div>
                {:else if block.type === 'redacted_thinking'}
                  <div class="ai-thinking"><span class="ai-thinking-toggle">Thinking (redacted by the provider)</span></div>
                {:else if block.type === 'text' && block.text}
                  <div class="ai-text"><Markdown source={block.text} compact live={turn.status === 'streaming' && !step.done} /></div>
                {:else if block.type === 'tool_use'}
                  {@const result = toolResultFor(step, block)}
                  <div class="ai-tool" class:ai-tool-error={result?.isError}>
                    <div class="ai-tool-head">
                      <span class="ai-tool-kind">Tool call</span>
                      <span class="ai-tool-name">{block.name}</span>
                      {#if result?.server || serverFor(turn, block.name)}<span class="ai-tool-server">{result?.server || serverFor(turn, block.name)}</span>{/if}
                      {#if block.id}<span class="ai-tool-id">{block.id}</span>{/if}
                    </div>
                    <pre class="ai-tool-body">{step.done ? prettyJSON(block.input) : (block.input || '')}{#if !step.done}<span class="ai-caret"></span>{/if}</pre>
                    {#if result}
                      <div class="ai-tool-result">
                        <span class="ai-tool-kind">{result.isError ? 'Tool error' : 'Result'}</span>
                        <pre class="ai-tool-body">{result.text}</pre>
                      </div>
                    {:else if step.done && step.stopReason === 'tool_use' && streaming}
                      <div class="ai-tool-result ai-tool-pending"><span class="spinner spinner-inline"></span>Running…</div>
                    {/if}
                  </div>
                {/if}
              {/each}
              {#if !step.done && turn.status === 'streaming' && !step.blocks.some(b => b.type === 'text' || b.type === 'tool_use')}
                <div class="ai-waiting"><span class="ai-caret"></span></div>
              {/if}
              {#if step.error}
                {@render errorCard(step.error, step.blocks.length ? 'The answer above is what arrived before the error.' : '')}
              {/if}
            {/each}

            {#if turn.status === 'streaming' && !turn.steps.length}
              <div class="ai-waiting"><span class="ai-caret"></span></div>
            {/if}

            {#if turn.status === 'error' && turn.error && !turn.steps.some(step => step.error)}
              {@render errorCard(turn.error, '')}
            {/if}

            {#if turn.response?.warnings?.length}
              {#each turn.response.warnings as warning, index (index)}
                <div class="ai-note" role="status">{warning}</div>
              {/each}
            {/if}

            {#if turn.status !== 'streaming' && turn.steps.at(-1)?.stopReason === 'max_tokens'}
              <div class="ai-note ai-note-warn" role="status">
                <span>The answer stopped at the token limit, so it is cut off.</span>
                {#if turn === last}
                  <button class="btn btn-secondary btn-sm" type="button" onclick={raiseMaxTokens} disabled={vm.loading}>Raise the limit and resend</button>
                {/if}
              </div>
            {/if}

            {#if turn.status !== 'streaming' && turn.steps.at(-1)?.stopReason}
              <div class="ai-turn-foot">
                <span class="ai-stop" class:ai-stop-warn={turn.steps.at(-1)?.stopReason !== 'end_turn'}>stop · {stopLabel(turn.steps.at(-1)?.stopReason ?? '')}</span>
                {#if turn.steps.length > 1}<span class="ai-turn-meta">{turn.steps.length} steps</span>{/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>

      <div class="ai-composer">
        <textarea
          class="field field-area ai-reply"
          rows="1"
          placeholder="Message"
          aria-label="Reply"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          {...NO_AUTOCORRECT}
          maxlength={AI_PROMPT_MAX_CHARS}
          bind:value={reply}
          onkeydown={onReplyKeydown}
          disabled={streaming}
        ></textarea>
        <button class="btn btn-primary btn-icon btn-lg ai-send" type="button" onclick={sendReply} disabled={streaming || !reply.trim()} aria-label="Send reply" title="Send (Enter)">
          <svg width="0.875rem" height="0.875rem" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="M7 12V2M2.5 6.5L7 2l4.5 4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>
    {:else if tab === 'raw'}
      <div class="ai-raw" id="ai-panel-raw" role="tabpanel">
        {#if rawSteps.length}
          {#each rawSteps as step, stepIndex (step.index)}
            {@const open = rawStepOpen(stepIndex)}
            <div class="ai-raw-step">
              <button class="btn btn-ghost btn-sm ai-raw-head" type="button" aria-expanded={open} onclick={() => toggleRawStep(stepIndex)}>
                <svg class:open width="0.625rem" height="0.625rem" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                  <path d="M3.5 2l3 3-3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                Step {step.index + 1}{#if step.http.statusCode} · {step.http.status}{/if}
                <span class="ai-raw-size">{formatSize((step.requestBody?.length ?? 0) + (step.http.body?.length ?? 0))}</span>
              </button>
              {#if open}
                {#if step.url}<div class="ai-raw-url"><span class="ai-raw-method">{step.method}</span> {step.url}</div>{/if}
                {#if step.requestBody}
                  {@render rawBody('Request body', `${turnKey}:${step.index}:req`, prettyJSON(step.requestBody))}
                {/if}
                {@render rawBody('Response', `${turnKey}:${step.index}:res`, step.http.body || '(empty body)')}
              {/if}
            </div>
          {/each}
        {:else}
          <div class="test-results-empty">{streaming ? 'The raw stream appears when the answer is complete.' : 'No raw response.'}</div>
        {/if}
      </div>
    {:else}
      <div class="test-results-panel" id="ai-panel-tests" role="tabpanel">
        {#if tests && (tests.tests?.length || tests.error || tests.logs?.length)}
          <div class="script-result-block">
            <div class="script-result-header">
              Tests
              {#if testTotal}
                <span class:script-ok-badge={testPassed === testTotal} class:script-fail-badge={testPassed < testTotal}>{testPassed}/{testTotal} passed</span>
              {/if}
            </div>
            {#if tests.error}<div class="script-error-msg">{tests.error}</div>{/if}
            {#each (tests.tests ?? []) as t, eachIndex (eachIndex)}
              <div class="test-row" class:pass={t.passed} class:fail={!t.passed}>
                <span class="test-icon">{t.passed ? '✓' : '✕'}</span>
                <span class="test-name">{t.name}</span>
                {#if t.error}<span class="test-err">{t.error}</span>{/if}
              </div>
            {/each}
            {#each (tests.logs ?? []) as log, eachIndex (eachIndex)}
              <div class="script-log-row"><span class="log-icon">›</span><span class="log-msg">{log}</span></div>
            {/each}
          </div>
        {:else}
          <div class="test-results-empty">No tests ran. Write them in Scripts → Tests with pm.response.llm().</div>
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .ai-panel {
    container-type: inline-size;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .ai-status-row {
    grid-column: 1 / -1;
    grid-row: 1;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-width: 0;
    height: 100%;
    overflow: hidden;
  }
  .ai-panel .status-left {
    display: contents;
  }
  .ai-panel .status-left :global(.status-badge) {
    flex-shrink: 0;
  }
  .ai-model-name {
    flex: 0 10000 auto;
    font-family: var(--font-mono);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ai-live {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1-5);
    color: var(--text-2);
    font-size: var(--text-label);
  }
  .ai-live-dot {
    width: 0.375rem;
    height: 0.375rem;
    border-radius: var(--radius-full);
    background: var(--accent);
    animation: ai-pulse 1.2s ease-in-out infinite;
  }
  .ai-metrics {
    display: inline-flex;
    gap: var(--space-3);
    color: var(--text-2);
    font-family: var(--font-mono);
    font-size: var(--text-caption);
    cursor: default;
  }
  .ai-panel .status-right {
    flex: 0 1 auto;
    margin-left: auto;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-3);
    min-width: 0;
    overflow: hidden;
  }
  .ai-metrics {
    flex-wrap: nowrap;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
  }
  @container (max-width: 40rem) {
    .ai-metric-extra {
      display: none;
    }
  }
  @container (max-width: 32rem) {
    .ai-model-name,
    .ai-new-chat-label {
      display: none;
    }
  }
  @container (max-width: 24rem) {
    .ai-metrics {
      display: none;
    }
  }
  .ai-new-chat {
    flex: 0 0 auto;
  }
  .ai-metric-key {
    color: var(--text-3);
  }
  .ai-badge-fail {
    color: var(--danger);
  }
  .ai-chat {
    flex: 1 1 auto;
    min-height: 0;
    overflow-x: hidden;
    overflow-y: auto;
    padding: var(--space-4);
  }
  .ai-turn {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
    padding-bottom: var(--space-6);
  }
  .ai-turn + .ai-turn {
    padding-top: var(--space-4);
    border-top: 1px solid var(--border-subtle);
  }
  .ai-user {
    align-self: flex-end;
    max-width: 80%;
    padding: var(--space-2-5) var(--space-3);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-xl);
    background: var(--elevated);
    color: var(--text);
    font-size: var(--text-body);
    line-height: var(--leading-relaxed);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
  }
  .ai-text {
    min-width: 0;
  }
  .ai-thinking-toggle {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1-5);
    height: var(--control-md);
    padding: 0 var(--space-2-5);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-2);
    font-size: var(--text-label);
    font-weight: var(--weight-medium);
  }
  .ai-thinking-toggle svg {
    color: var(--text-3);
    transition: transform var(--dur-fast);
  }
  .ai-thinking-toggle svg.open {
    transform: rotate(90deg);
  }
  .ai-thinking-text {
    margin-top: var(--space-2);
    padding-left: var(--space-3);
    border-left: 1px solid var(--border);
    color: var(--text-2);
    font-size: var(--text-label);
    line-height: var(--leading-relaxed);
    white-space: pre-wrap;
    user-select: text;
  }
  .ai-tool {
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface);
    overflow: hidden;
  }
  .ai-tool-error {
    border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
  }
  .ai-tool-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--border-subtle);
  }
  .ai-tool-kind {
    color: var(--text-3);
    font-size: var(--text-label);
  }
  .ai-tool-name {
    color: var(--text);
    font-family: var(--font-mono);
    font-size: var(--text-code);
    font-weight: var(--weight-medium);
  }
  .ai-tool-server {
    padding: 0 var(--space-1-5);
    border-radius: var(--radius-xs);
    background: var(--elevated);
    color: var(--text-2);
    font-size: var(--text-caption);
  }
  .ai-tool-id {
    margin-left: auto;
    color: var(--text-3);
    font-family: var(--font-mono);
    font-size: var(--text-caption);
  }
  .ai-tool-body {
    margin: 0;
    padding: var(--space-2-5) var(--space-3);
    color: var(--text-2);
    font-family: var(--font-mono);
    font-size: var(--text-code);
    line-height: var(--leading-relaxed);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 18rem;
    overflow: auto;
    user-select: text;
  }
  .ai-tool-result {
    border-top: 1px solid var(--border-subtle);
  }
  .ai-tool-result > .ai-tool-kind {
    display: block;
    padding: var(--space-2) var(--space-3) 0;
  }
  .ai-tool-error .ai-tool-result > .ai-tool-kind {
    color: var(--danger);
  }
  .ai-tool-pending {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    color: var(--text-3);
    font-size: var(--text-label);
  }
  .ai-caret {
    display: inline-block;
    width: 0.4375rem;
    height: 0.875rem;
    margin-left: var(--space-0-5);
    vertical-align: -0.125rem;
    background: var(--accent);
    animation: ai-blink 1s steps(1) infinite;
  }
  .ai-waiting {
    min-height: var(--control-sm);
  }
  .ai-error-card {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: var(--space-2);
    min-width: 0;
    padding: var(--space-2-5) var(--space-3);
    border: 1px solid color-mix(in srgb, var(--danger) 40%, var(--border));
    border-radius: var(--radius-lg);
    background: color-mix(in srgb, var(--danger) 8%, transparent);
    color: var(--text);
    font-size: var(--text-label);
    user-select: text;
  }
  .ai-error-icon {
    margin-top: var(--space-0-5);
    color: var(--danger);
  }
  .ai-error-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
  }
  .ai-error-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-1-5) var(--space-2);
  }
  .ai-error-title {
    color: var(--text);
    font-weight: var(--weight-semibold);
  }
  .ai-error-status {
    padding: 0 var(--space-1-5);
    border-radius: var(--radius-xs);
    background: color-mix(in srgb, var(--danger) 16%, transparent);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: var(--text-caption);
    font-weight: var(--weight-medium);
  }
  .ai-error-message {
    min-width: 0;
    color: var(--text-2);
    overflow-wrap: anywhere;
  }
  .ai-error-message :global(.md) {
    color: inherit;
    font-size: var(--text-label);
  }
  .ai-error-hint {
    color: var(--text-3);
    font-size: var(--text-caption);
    line-height: var(--leading-normal);
  }
  .ai-note {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2) var(--space-3);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    color: var(--text-2);
    font-size: var(--text-label);
  }
  .ai-note-warn {
    border-color: color-mix(in srgb, var(--warning) 40%, var(--border));
    background: color-mix(in srgb, var(--warning) 8%, transparent);
    color: var(--text);
  }
  .ai-turn-foot {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .ai-stop {
    padding: var(--space-0-5) var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-3);
    font-family: var(--font-mono);
    font-size: var(--text-caption);
  }
  .ai-stop-warn {
    border-color: color-mix(in srgb, var(--warning) 40%, var(--border));
    color: var(--warning);
  }
  .ai-turn-meta {
    color: var(--text-3);
    font-size: var(--text-caption);
  }
  .ai-composer {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: end;
    gap: var(--space-2);
    padding: var(--space-2-5) var(--space-4);
    border-top: 1px solid var(--border);
  }
  .ai-composer {
    --ai-composer-h: calc(var(--text-body) * var(--leading-normal) + var(--space-2) * 2 + 0.125rem);
  }
  .ai-send {
    width: var(--ai-composer-h);
    height: var(--ai-composer-h);
  }
  .ai-send:disabled {
    border-color: var(--border);
    background: var(--elevated);
    color: var(--text-3);
    opacity: 1;
  }
  .ai-reply {
    min-height: var(--ai-composer-h);
    font-size: var(--text-body);
    max-height: 8rem;
    resize: none;
    field-sizing: content;
  }
  .ai-raw {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    padding: var(--space-3) var(--space-4);
  }
  .ai-raw-step + .ai-raw-step {
    margin-top: var(--space-4);
  }
  .ai-raw-head {
    display: flex;
    align-items: center;
    gap: var(--space-1-5);
    width: 100%;
    justify-content: flex-start;
    margin-bottom: var(--space-1-5);
    color: var(--text-2);
    font-size: var(--text-label);
    font-weight: var(--weight-medium);
  }
  .ai-raw-head svg {
    color: var(--text-3);
    transition: transform var(--dur-fast);
  }
  .ai-raw-head svg.open {
    transform: rotate(90deg);
  }
  .ai-raw-size {
    margin-left: auto;
    color: var(--text-3);
    font-family: var(--font-mono);
    font-size: var(--text-caption);
    font-weight: var(--weight-regular);
  }
  .ai-raw-more {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-top: var(--space-1);
    color: var(--text-3);
    font-size: var(--text-caption);
  }
  .ai-raw-url {
    margin-bottom: var(--space-2);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: var(--text-code);
    overflow-wrap: anywhere;
    user-select: text;
  }
  .ai-raw-method {
    color: var(--post);
    font-weight: var(--weight-medium);
  }
  .ai-raw-label {
    margin: var(--space-2) 0 var(--space-1);
    color: var(--text-3);
    font-size: var(--text-caption);
  }
  .ai-raw-body {
    margin: 0;
    max-height: 32rem;
    overflow: auto;
    padding: var(--space-2-5) var(--space-3);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--surface);
    color: var(--text-2);
    font-family: var(--font-mono);
    font-size: var(--text-code);
    line-height: var(--leading-relaxed);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
  }
  @keyframes ai-blink {
    50% { opacity: 0; }
  }
  @keyframes ai-pulse {
    50% { opacity: 0.35; }
  }
  @media (prefers-reduced-motion: reduce) {
    .ai-caret,
    .ai-live-dot {
      animation: none;
    }
    .ai-thinking-toggle svg,
    .ai-raw-head svg {
      transition: none;
    }
  }
</style>
