<script lang="ts">
  import { tick } from 'svelte';
  import type { AiConnectionModel } from '../backend';

  let {
    models = [],
    value = '',
    loading = false,
    error = '',
    ariaLabel = 'Model',
    placeholder = 'Choose a model',
    onOpen = () => {},
    onChange = () => {},
  }: {
    models: AiConnectionModel[];
    value: string;
    loading?: boolean;
    error?: string;
    ariaLabel?: string;
    placeholder?: string;
    onOpen?: () => void;
    onChange?: (value: string) => void;
  } = $props();

  const MENU_HEIGHT = 360;
  const MENU_WIDTH_REM = 28;
  let menuStyle = $state('');
  let open = $state(false);
  let upward = $state(false);
  let query = $state('');
  let highlighted = $state(0);
  let wrap = $state<HTMLDivElement>();
  let search = $state<HTMLInputElement>();

  const selected = $derived(models.find(model => model.id === value));
  const label = $derived(selected?.name || value);
  const filtered = $derived.by(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return models;
    return models.filter(model => {
      const text = `${model.name} ${model.id}`.toLowerCase();
      return terms.every(term => text.includes(term));
    });
  });

  function clipBox(element: HTMLElement) {
    let box = { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth };
    let node = element.parentElement;
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
        const rect = node.getBoundingClientRect();
        const left = rect.left + node.clientLeft;
        const top = rect.top + node.clientTop;
        box = {
          top: Math.max(box.top, top),
          bottom: Math.min(box.bottom, top + node.clientHeight),
          left: Math.max(box.left, left),
          right: Math.min(box.right, left + node.clientWidth),
        };
      }
      node = node.parentElement;
    }
    return box;
  }

  function placeMenu(element: HTMLElement) {
    const rect = element.getBoundingClientRect();
    const box = clipBox(element);
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const gutter = rem * 0.5;
    const spaceRight = box.right - rect.left - gutter;
    const spaceLeft = rect.right - box.left - gutter;
    const anchorRight = spaceLeft > spaceRight;
    const width = Math.max(rect.width, Math.min(MENU_WIDTH_REM * rem, anchorRight ? spaceLeft : spaceRight));
    menuStyle = anchorRight ? `left: auto; right: 0; width: ${width}px;` : `left: 0; right: auto; width: ${width}px;`;
    upward = box.bottom - rect.bottom < MENU_HEIGHT && rect.top - box.top > box.bottom - rect.bottom;
  }

  async function toggle() {
    open = !open;
    if (!open) return;
    if (wrap) placeMenu(wrap);
    query = '';
    highlighted = Math.max(0, models.findIndex(model => model.id === value));
    onOpen();
    await tick();
    search?.focus({ preventScroll: true });
  }

  function choose(model: AiConnectionModel) {
    open = false;
    onChange(model.id);
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      open = false;
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      highlighted = Math.min(filtered.length - 1, highlighted + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      highlighted = Math.max(0, highlighted - 1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const model = filtered[highlighted];
      if (model) choose(model);
    }
  }

  function closeOnFocusOut(event: FocusEvent) {
    const next = event.relatedTarget;
    if (next instanceof Node && wrap?.contains(next)) return;
    open = false;
  }
</script>

<div class="ai-combo" bind:this={wrap} onfocusout={closeOnFocusOut}>
  <button class="field ai-combo-trigger" type="button" aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} onclick={toggle}>
    <span class="ai-combo-value" class:ai-combo-placeholder={!label}>{label || placeholder}</span>
    <svg width="0.625rem" height="0.375rem" viewBox="0 0 10 6" fill="none" aria-hidden="true">
      <path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>
  </button>
  {#if open}
    <div class="ai-combo-menu" class:ai-combo-up={upward} style={menuStyle} role="dialog" aria-label={ariaLabel} tabindex="-1" onkeydown={onKeydown}>
      <input
        class="field ai-combo-search"
        bind:this={search}
        bind:value={query}
        oninput={() => (highlighted = 0)}
        placeholder="Search models"
        aria-label="Search models"
        autocomplete="off"
        spellcheck="false"
      />
      {#if loading}
        <div class="ai-combo-empty"><span class="spinner spinner-inline"></span> Loading models…</div>
      {:else if error}
        <div class="ai-combo-empty ai-combo-error" role="alert">{error}</div>
      {:else if !filtered.length}
        <div class="ai-combo-empty">{models.length ? 'No model matches.' : 'This connection listed no models.'}</div>
      {:else}
        <div class="ai-combo-list" role="listbox" aria-label="Models">
          {#each filtered as model, index (model.id)}
            <button
              class="ai-combo-option"
              class:active={index === highlighted}
              class:selected={model.id === value}
              role="option"
              aria-selected={model.id === value}
              type="button"
              onmouseenter={() => (highlighted = index)}
              onclick={() => choose(model)}
            >
              <span class="ai-combo-option-main">
                <span class="ai-combo-option-name">{model.name}</span>
                {#if model.name !== model.id}<span class="ai-combo-option-id">{model.id}</span>{/if}
              </span>
              {#if model.recommended}
                <span class="ai-combo-tag ai-combo-tag-good">Recommended</span>
              {:else if model.weakTools}
                <span class="ai-combo-tag">No tools</span>
              {/if}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .ai-combo {
    position: relative;
    min-width: 0;
    width: 100%;
  }
  .ai-combo-trigger {
    width: 100%;
    display: flex;
    align-items: center;
    gap: var(--space-1-5);
    text-align: left;
    cursor: pointer;
    color: var(--text);
  }
  .ai-combo-trigger svg { flex: 0 0 auto; color: var(--text-3); }
  .ai-combo-value {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ai-combo-placeholder { color: var(--text-3); }
  .ai-combo-menu {
    box-sizing: border-box;
    position: absolute;
    z-index: 30;
    top: calc(100% + var(--space-1));
    left: 0;
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: var(--space-1-5);
    padding: var(--space-1-5);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg);
    box-shadow: var(--shadow-popover);
  }
  .ai-combo-up {
    top: auto;
    bottom: calc(100% + var(--space-1));
    flex-direction: column-reverse;
  }
  .ai-combo-search { width: 100%; }
  .ai-combo-list {
    max-height: 20rem;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }
  .ai-combo-option {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    width: 100%;
    padding: var(--space-1-5) var(--space-2);
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text);
    text-align: left;
    cursor: pointer;
  }
  .ai-combo-option.active { background: var(--hover); }
  .ai-combo-option.selected .ai-combo-option-name { color: var(--accent-text); }
  .ai-combo-option-main {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .ai-combo-option-name { line-height: 1.4; }
  .ai-combo-option-id {
    word-break: break-all;
    line-height: 1.35;
    font-family: var(--font-mono);
    font-size: var(--text-caption);
    color: var(--text-3);
  }
  .ai-combo-tag {
    flex: 0 0 auto;
    margin-top: var(--space-0-5);
    font-size: var(--text-micro);
    padding: 0 var(--space-1-5);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    color: var(--text-3);
  }
  .ai-combo-tag-good {
    border-color: transparent;
    background: var(--accent-dim);
    color: var(--accent-text);
  }
  .ai-combo-empty {
    display: flex;
    align-items: center;
    gap: var(--space-1-5);
    padding: var(--space-2);
    color: var(--text-2);
    font-size: var(--text-label);
  }
  .ai-combo-error {
    align-items: flex-start;
    color: var(--s5xx);
    overflow-wrap: anywhere;
    max-height: 10rem;
    overflow-y: auto;
  }
</style>
