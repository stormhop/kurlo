<script lang="ts">
  import CodeEditor from '../CodeEditor.svelte';
  import { vm } from '../stores/app.svelte';
</script>

<div class="ai-prompt">
  <div class="ai-section">
    <span class="ai-label">System prompt <span class="ai-optional">optional</span></span>
    <div class="ai-editor">
      <CodeEditor
        bind:value={vm.aiSystem}
        language="text"
        prose
        minHeight="3.25rem"
        maxHeight="8rem"
        ariaLabel="System prompt"
        variableSuggestions={vm.variableSuggestions}
        placeholder="How the model should behave in every reply"
      />
    </div>
  </div>

  <div class="ai-section ai-section-grow">
    <span class="ai-label">Prompt</span>
    <div class="ai-editor ai-editor-prompt">
      <CodeEditor
        bind:value={vm.aiPrompt}
        language="text"
        prose
        fillHeight
        testId="ai-prompt-editor"
        ariaLabel="Prompt"
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
    flex-direction: column;
    gap: var(--space-2);
    min-height: 0;
  }
  .ai-section-grow {
    flex: 1 1 auto;
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
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
  }
</style>
