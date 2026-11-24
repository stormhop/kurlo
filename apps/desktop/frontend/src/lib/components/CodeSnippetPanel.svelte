<script lang="ts">
  import Select from './Select.svelte';
  import {
    SNIPPET_LABELS,
    SNIPPET_LANGUAGES,
    type SnippetLanguage,
  } from '../stores/ui';

  type RenderedSnippetLine = {
    number: number;
    html: string;
  };

  let {
    lines,
    codePanelOpen,
    snippetLanguage,
    copiedSnippet,
    onSnippetLanguageChange,
    onCopy,
    onResizeStart,
    onDividerKeydown,
  }: {
    lines: RenderedSnippetLine[];
    codePanelOpen: boolean;
    snippetLanguage: SnippetLanguage;
    copiedSnippet: boolean;
    onSnippetLanguageChange: (language: SnippetLanguage) => void;
    onCopy: () => void;
    onResizeStart: (event: MouseEvent) => void;
    onDividerKeydown: (event: KeyboardEvent) => void;
  } = $props();

</script>

<div class="code-snippet-content">
  {#if codePanelOpen}
    <button
      class="code-panel-resizer"
      type="button"
      onmousedown={onResizeStart}
      onkeydown={onDividerKeydown}
      aria-label="Resize code snippet panel"
    ></button>
  {/if}
  <div class="code-panel-toolbar">
    <Select
      className="snippet-select"
      size="md"
      ariaLabel="Snippet language"
      value={snippetLanguage}
      options={SNIPPET_LANGUAGES.map(language => ({ value: language, label: SNIPPET_LABELS[language] }))}
      onChange={language => onSnippetLanguageChange(language as SnippetLanguage)}
    />
    <button class="btn btn-ghost code-copy-btn" class:feedback-ok={copiedSnippet} onclick={onCopy} type="button">
      {#if copiedSnippet}
        <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none"><path d="M2 6.5l3 3 6-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Copied
      {:else}
        <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none"><rect x="3" y="1" width="8" height="9" rx="1.2" stroke="currentColor" stroke-width="1.2"/><path d="M1 3.5v7a1.2 1.2 0 001.2 1.2H8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
        Copy
      {/if}
    </button>
  </div>

  <div class="curl-preview">
    {#each lines as line, eachIndex (eachIndex)}
      <div class="curl-line">
        <span class="curl-line-no">{line.number}</span>
        <!-- eslint-disable-next-line svelte/no-at-html-tags -->
        <code>{@html line.html}</code>
      </div>
    {/each}
  </div>
</div>
