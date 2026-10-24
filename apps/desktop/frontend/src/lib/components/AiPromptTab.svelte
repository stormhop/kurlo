<script lang="ts">
  import CodeEditor from '../CodeEditor.svelte';
  import { vm } from '../stores/app.svelte';
  import { AI_PROMPT_MAX_CHARS, AI_SYSTEM_MAX_CHARS } from '../stores/features/ai';

  const COUNTER_FROM = 0.8;
  const hasChat = $derived((vm.aiConversations.get(vm.activeRequestId)?.length ?? 0) > 0);
</script>

{#snippet counter(length: number, max: number)}
  {#if length >= max * COUNTER_FROM}
    <span class="ai-counter" class:ai-counter-full={length >= max} aria-live="polite">{length.toLocaleString('en-US')} / {max.toLocaleString('en-US')}</span>
  {/if}
{/snippet}

<div class="ai-prompt">
  <div class="ai-section">
    <span class="ai-label-row">
      <span class="ai-label">System prompt <span class="ai-optional">optional · sent with every message</span></span>
      {@render counter(vm.aiSystem.length, AI_SYSTEM_MAX_CHARS)}
    </span>
    <div class="ai-editor">
      <CodeEditor
        bind:value={vm.aiSystem}
        language="text"
        prose
        minHeight="3.25rem"
        maxHeight="8rem"
        ariaLabel="System prompt"
        maxLength={AI_SYSTEM_MAX_CHARS}
        variableSuggestions={vm.variableSuggestions}
        placeholder="How the model should behave in every reply"
      />
    </div>
  </div>

  <div class="ai-section ai-section-grow">
    <span class="ai-label-row">
      <span class="ai-label">Prompt <span class="ai-optional">{hasChat ? 'Send starts a new chat with it. To continue the chat, write below the answer.' : 'the first message. Replies go in the chat.'}</span></span>
      {@render counter(vm.aiPrompt.length, AI_PROMPT_MAX_CHARS)}
    </span>
    <div class="ai-editor ai-editor-prompt">
      <CodeEditor
        bind:value={vm.aiPrompt}
        language="text"
        prose
        minHeight="9rem"
        maxHeight="none"
        testId="ai-prompt-editor"
        ariaLabel="Prompt"
        maxLength={AI_PROMPT_MAX_CHARS}
        variableSuggestions={vm.variableSuggestions}
        placeholder={'What to ask the model. {{variables}} come from the environment.'}
      />
    </div>
  </div>
</div>

<style>
  .ai-prompt {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    height: 100%;
    min-height: 0;
    padding: var(--space-3) var(--space-4) var(--space-4);
    overflow: hidden;
  }
  .ai-section {
    display: flex;
    flex: 0 0 auto;
    flex-direction: column;
    gap: var(--space-2);
    min-height: 0;
  }
  .ai-section-grow {
    flex: 0 1 auto;
  }
  .ai-label-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
  }
  .ai-counter {
    flex: 0 0 auto;
    color: var(--text-3);
    font-family: var(--font-mono);
    font-size: var(--text-caption);
  }
  .ai-counter-full {
    color: var(--danger);
  }
  .ai-label {
    color: var(--text);
    font-size: var(--text-label);
    font-weight: var(--weight-semibold);
  }
  .ai-optional {
    margin-left: var(--space-1-5);
    color: var(--text-3);
    font-weight: var(--weight-regular);
  }
  .ai-editor {
    min-height: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  .ai-editor:focus-within {
    border-color: var(--accent);
  }
  .ai-editor-prompt {
    flex: 0 1 auto;
    display: flex;
    flex-direction: column;
  }
  .ai-editor-prompt :global(.cm-wrap) {
    display: flex;
    flex-direction: column;
    flex: 0 1 auto;
    min-height: 0;
  }
  .ai-editor-prompt :global(.cm-editor) {
    flex: 0 1 auto;
    min-height: 0;
  }
  .ai-editor-prompt :global(.cm-scroller) {
    flex: 0 1 auto;
    min-height: 0;
  }
</style>
