<script lang="ts">
  import CodeEditor from '../CodeEditor.svelte';
  import { vm } from '../stores/app.svelte';

  let systemOpen = $state(Boolean(vm.aiSystem.trim()));
</script>

<div class="ai-prompt">
  <div class="ai-section" class:ai-section-collapsed={!systemOpen}>
    <button class="btn btn-ghost btn-sm ai-section-toggle" type="button" aria-expanded={systemOpen} onclick={() => (systemOpen = !systemOpen)}>
      <svg class:open={systemOpen} width="0.625rem" height="0.625rem" viewBox="0 0 10 10" fill="none" aria-hidden="true">
        <path d="M3.5 2l3 3-3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span class="ai-label">System prompt</span>
      {#if !systemOpen && vm.aiSystem.trim()}<span class="ai-preview">{vm.aiSystem.trim()}</span>{/if}
    </button>
    {#if systemOpen}
      <div class="ai-editor ai-editor-system">
        <CodeEditor
          bind:value={vm.aiSystem}
          language="text"
          minHeight="4.5rem"
          maxHeight="10rem"
          ariaLabel="System prompt"
          variableSuggestions={vm.variableSuggestions}
          placeholder="How the model should behave, for every message in the conversation"
        />
      </div>
    {/if}
  </div>

  <div class="ai-section ai-section-grow">
    <span class="ai-label">Prompt</span>
    <div class="ai-editor ai-editor-prompt">
      <CodeEditor
        bind:value={vm.aiPrompt}
        language="text"
        fillHeight
        testId="ai-prompt-editor"
        ariaLabel="Prompt"
        variableSuggestions={vm.variableSuggestions}
        placeholder={'Ask the model something. {{variables}} are filled in from the environment.'}
      />
    </div>
  </div>
</div>

<style>
  .ai-prompt {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    height: 100%;
    min-height: 0;
    padding: var(--space-3) var(--space-4) var(--space-4);
    overflow: hidden;
  }
  .ai-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-height: 0;
  }
  .ai-section-grow {
    flex: 1 1 auto;
  }
  .ai-section-toggle {
    display: flex;
    align-self: flex-start;
    justify-content: flex-start;
    align-items: center;
    gap: var(--space-1-5);
    min-width: 0;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--text);
    text-align: left;
    cursor: pointer;
  }
  .ai-section-toggle svg {
    flex: none;
    color: var(--text-3);
    transition: transform var(--dur-fast);
  }
  .ai-section-toggle svg.open {
    transform: rotate(90deg);
  }
  .ai-label {
    color: var(--text);
    font-size: var(--text-label);
    font-weight: var(--weight-semibold);
  }
  .ai-preview {
    min-width: 0;
    overflow: hidden;
    color: var(--text-3);
    font-size: var(--text-label);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ai-editor {
    min-height: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  .ai-editor-prompt {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
  }
  @media (prefers-reduced-motion: reduce) {
    .ai-section-toggle svg {
      transition: none;
    }
  }
</style>
