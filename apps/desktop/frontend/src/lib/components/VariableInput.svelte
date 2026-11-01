<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { VariableSuggestion } from '../variables';
  import { variableDisplayValue } from '../variables';
  import { isDynamicVariableName } from '../dynamicVariables';
  import { escapeHtml } from '../utils';
  import type { InputGhost } from '../ghostText';

  type VariableInputElement = HTMLInputElement | HTMLTextAreaElement;

  let {
    value = $bindable(''),
    inputRef = $bindable<VariableInputElement | undefined>(),
    suggestions = [],
    className = '',
    placeholder = '',
    ariaLabel = '',
    list = undefined,
    type = 'text',
    multiline = false,
    disabled = false,
    spellcheck = false,
    validationMessage = '',
    pickerOptions = [],
    pickerLabel = 'Suggestions',
    ghost = undefined,
    oninput,
    onfocus,
    onclick,
    ondblclick,
    onpaste,
    onenter,
  }: {
    value: string;
    inputRef?: VariableInputElement;
    suggestions?: VariableSuggestion[];
    className?: string;
    placeholder?: string;
    ariaLabel?: string;
    list?: string;
    type?: string;
    multiline?: boolean;
    disabled?: boolean;
    spellcheck?: boolean;
    validationMessage?: string;
    pickerOptions?: string[];
    pickerLabel?: string;
    ghost?: (value: string) => InputGhost | null;
    oninput?: (event: Event) => void;
    onfocus?: (event: FocusEvent) => void;
    onclick?: (event: MouseEvent) => void;
    ondblclick?: (event: MouseEvent) => void;
    onpaste?: (event: ClipboardEvent) => void;
    onenter?: () => void;
  } = $props();

  let wrap: HTMLDivElement;
  let backdropEl = $state<HTMLDivElement | undefined>();
  let open = $state(false);
  const validationId = `input-validation-${Math.random().toString(36).slice(2)}`;
  let pickerOpen = $state(false);
  let pickerActiveIndex = $state(0);
  let pickerTop = $state(0);
  let pickerLeft = $state(0);
  let pickerWidth = $state(260);
  let pickerMaxHeight = $state(220);
  let multilineExpanded = $state(false);
  let focused = $state(false);
  let caretAtEnd = $state(true);
  let ghostDismissedFor = $state<string | null>(null);

  const knownKeySet = $derived(new Set(suggestions.map(s => s.key)));

  const activeGhost = $derived.by(() => {
    if (!ghost || !focused || !caretAtEnd || open || pickerOpen || disabled || ghostDismissedFor === value) return null;
    return ghost(value);
  });

  const highlightHtml = $derived.by(() => {
    if (!suggestions.length || !value) return '';
    const VAR_RE = /\{\{([^{}]*)}}/g;
    let result = '';
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = VAR_RE.exec(value)) !== null) {
      result += escapeHtml(value.slice(last, m.index));
      const key = m[1].trim();
      if (knownKeySet.has(key) || isDynamicVariableName(key)) {
        result += escapeHtml(m[0]);
      } else {
        result += `<mark class="var-token-err">${escapeHtml(m[0])}</mark>`;
      }
      last = m.index + m[0].length;
    }
    result += escapeHtml(value.slice(last));
    return result;
  });

  const backdropHtml = $derived.by(() => {
    if (!activeGhost) return highlightHtml;
    return `${highlightHtml || escapeHtml(value)}<span class="ghost-text" data-testid="ghost-text">${escapeHtml(activeGhost.text)}</span>`;
  });

  const hasUnresolved = $derived(
    suggestions.length > 0 && /\{\{/.test(value) && highlightHtml.includes('var-token-err')
  );

  function updateCaret() {
    if (!inputRef) return;
    const end = inputRef.selectionEnd ?? value.length;
    caretAtEnd = inputRef.selectionStart === end && end === inputRef.value.length;
  }

  function acceptGhost(suggestion: InputGhost) {
    value = suggestion.value;
    ghostDismissedFor = null;
    const target = inputRef;
    if (!target) return;
    target.value = suggestion.value;
    target.setSelectionRange(suggestion.value.length, suggestion.value.length);
    target.dispatchEvent(new Event('input', { bubbles: true }));
    setTimeout(() => {
      target.scrollLeft = target.scrollWidth;
      updateCaret();
      syncScroll();
    }, 0);
  }

  const pickerMatches = $derived.by(() => {
    if (!pickerOptions.length) return [];
    const needle = value.trim().toLowerCase();
    const keys = pickerOptions.map(option => option.toLowerCase());
    const options = pickerOptions
      .filter((option, index) => {
        const key = keys[index];
        if (!option.trim() || keys.indexOf(key) !== index) return false;
        return !needle || key.includes(needle);
      });
    if (!needle) return options;
    return options
      .sort((a, b) => {
        const al = a.toLowerCase();
        const bl = b.toLowerCase();
        const ap = needle && al.startsWith(needle) ? 0 : 1;
        const bp = needle && bl.startsWith(needle) ? 0 : 1;
        return ap - bp || a.localeCompare(b);
      });
  });

  function syncScroll() {
    if (!backdropEl || !inputRef) return;
    backdropEl.scrollLeft = inputRef.scrollLeft;
    backdropEl.scrollTop = inputRef.scrollTop;
  }

  $effect(() => {
    if (!inputRef || !backdropEl) return;
    const cs = window.getComputedStyle(inputRef);
    backdropEl.style.paddingLeft = cs.paddingLeft;
    backdropEl.style.paddingRight = cs.paddingRight;
    backdropEl.style.paddingTop = cs.paddingTop;
    backdropEl.style.paddingBottom = cs.paddingBottom;
    backdropEl.style.fontSize = cs.fontSize;
    backdropEl.style.fontFamily = cs.fontFamily;
    backdropEl.style.fontWeight = cs.fontWeight;
    backdropEl.style.letterSpacing = cs.letterSpacing;
    backdropEl.style.lineHeight = cs.lineHeight;
    backdropEl.style.wordSpacing = cs.wordSpacing;
  });

  $effect(() => {
    value;
    multiline;
    multilineExpanded;
    void resizeMultilineInput();
  });

  onMount(() => {
    if (!multiline) return;
    void resizeMultilineInput();
    const observer = typeof ResizeObserver !== 'undefined' && wrap
      ? new ResizeObserver(() => void resizeMultilineInput())
      : undefined;
    observer?.observe(wrap);
    window.addEventListener('resize', resizeMultilineInput);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', resizeMultilineInput);
    };
  });

  async function resizeMultilineInput() {
    if (!multiline) return;
    await tick();
    if (!(inputRef instanceof HTMLTextAreaElement)) return;
    if (!multilineExpanded) {
      inputRef.style.height = '';
      inputRef.style.overflowY = 'hidden';
      inputRef.scrollLeft = 0;
      inputRef.scrollTop = 0;
      syncScroll();
      return;
    }
    const cs = window.getComputedStyle(inputRef);
    const borderHeight = inputRef.offsetHeight - inputRef.clientHeight;
    const minHeight = Number.parseFloat(cs.minHeight) || 0;
    const maxHeight = Number.parseFloat(cs.maxHeight);
    inputRef.style.height = 'auto';
    const contentHeight = inputRef.scrollHeight + borderHeight;
    const nextHeight = Number.isFinite(maxHeight)
      ? Math.min(Math.max(contentHeight, minHeight), maxHeight)
      : Math.max(contentHeight, minHeight);
    inputRef.style.height = `${nextHeight}px`;
    inputRef.style.overflowY = contentHeight > nextHeight + 1 ? 'auto' : 'hidden';
    syncScroll();
  }

  let activeIndex = $state(0);
  let matches = $state<VariableSuggestion[]>([]);
  let suppressRefresh = false;
  let suppressPickerRefresh = false;

  function triggerRange() {
    if (!inputRef) return null;
    const pos = inputRef.selectionStart ?? value.length;
    const before = value.slice(0, pos);
    const start = before.lastIndexOf('{{');
    if (start < 0 || before.lastIndexOf('}}') > start) return null;

    const raw = before.slice(start + 2);
    if (raw.length > 80 || /[{}\r\n]/.test(raw) || !/^\s*[\p{L}\p{N}_.:-]*$/u.test(raw)) return null;
    const prefix = raw.trimStart();
    return { from: start + 2 + raw.length - prefix.length, to: value.slice(pos, pos + 2) === '}}' ? pos + 2 : pos, prefix };
  }

  function filteredSuggestions() {
    const range = triggerRange();
    if (!range) return [];
    const needle = range.prefix.toLowerCase();
    const rows = suggestions.filter(item => item.key.toLowerCase().includes(needle));
    return rows.sort((a, b) => {
      const ap = a.key.toLowerCase().startsWith(needle) ? 0 : 1;
      const bp = b.key.toLowerCase().startsWith(needle) ? 0 : 1;
      return ap - bp || a.key.localeCompare(b.key);
    }).slice(0, 12);
  }

  function refreshMenu() {
    matches = filteredSuggestions();
    open = matches.length > 0;
    if (open) pickerOpen = false;
    activeIndex = Math.min(activeIndex, Math.max(0, matches.length - 1));
  }

  function positionPicker() {
    if (!inputRef) return;
    const rect = inputRef.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const desiredWidth = Math.min(420, Math.max(260, rect.width));
    pickerTop = rect.bottom + 4;
    pickerLeft = Math.max(8, Math.min(rect.left, viewportWidth - desiredWidth - 8));
    pickerWidth = desiredWidth;
    pickerMaxHeight = Math.max(120, Math.min(260, viewportHeight - pickerTop - 12));
  }

  function refreshPicker() {
    if (suppressPickerRefresh || open || triggerRange() || !pickerMatches.length) {
      pickerOpen = false;
      return;
    }
    positionPicker();
    pickerOpen = true;
    pickerActiveIndex = Math.min(pickerActiveIndex, Math.max(0, pickerMatches.length - 1));
  }

  function choose(variable: VariableSuggestion) {
    const range = triggerRange();
    if (!range) return;
    const insert = `${variable.key}}}`;
    value = `${value.slice(0, range.from)}${insert}${value.slice(range.to)}`;
    open = false;
    suppressRefresh = true;
    setTimeout(() => {
      if (!inputRef) {
        suppressRefresh = false;
        return;
      }
      const pos = range.from + insert.length;
      inputRef.focus();
      inputRef.setSelectionRange(pos, pos);
      inputRef.dispatchEvent(new Event('input', { bubbles: true }));
      suppressRefresh = false;
    }, 0);
  }

  function choosePickerOption(option: string) {
    value = option;
    pickerOpen = false;
    suppressPickerRefresh = true;
    setTimeout(() => {
      if (!inputRef) {
        suppressPickerRefresh = false;
        return;
      }
      inputRef.focus();
      inputRef.setSelectionRange(option.length, option.length);
      inputRef.dispatchEvent(new Event('input', { bubbles: true }));
      suppressPickerRefresh = false;
    }, 0);
  }

  function onInput(event: Event) {
    normalizeMultilineValue(event);
    updateCaret();
    oninput?.(event);
    refreshMenu();
    refreshPicker();
  }

  function normalizeMultilineValue(event: Event) {
    if (!multiline) return;
    const target = event.currentTarget;
    if (!(target instanceof HTMLTextAreaElement) || !/[\r\n]/.test(target.value)) return;
    const selectionStart = target.selectionStart ?? target.value.length;
    const normalizedBeforeSelection = target.value.slice(0, selectionStart).replace(/[\r\n]+/g, '');
    const normalized = target.value.replace(/[\r\n]+/g, '');
    target.value = normalized;
    value = normalized;
    target.setSelectionRange(normalizedBeforeSelection.length, normalizedBeforeSelection.length);
  }

  function onFocus(event: FocusEvent) {
    focused = true;
    updateCaret();
    onfocus?.(event);
    if (multiline) {
      multilineExpanded = true;
      void resizeMultilineInput();
    }
    refreshMenu();
    refreshPicker();
  }

  function onClick(event: MouseEvent) {
    updateCaret();
    onclick?.(event);
    if (multiline) {
      multilineExpanded = true;
      void resizeMultilineInput();
    }
    refreshMenu();
    refreshPicker();
  }

  function onKeydown(event: KeyboardEvent) {
    if (open && matches.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        activeIndex = (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
      } else if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        choose(matches[activeIndex]);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        open = false;
      }
      return;
    }

    if (pickerOpen && pickerMatches.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        pickerActiveIndex = (pickerActiveIndex + (event.key === 'ArrowDown' ? 1 : -1) + pickerMatches.length) % pickerMatches.length;
      } else if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        choosePickerOption(pickerMatches[pickerActiveIndex]);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        pickerOpen = false;
      }
      return;
    }

    if (activeGhost && !event.metaKey && !event.ctrlKey && !event.altKey && !event.isComposing) {
      if ((event.key === 'Tab' && !event.shiftKey) || (event.key === 'ArrowRight' && !event.shiftKey)) {
        event.preventDefault();
        acceptGhost(activeGhost);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        ghostDismissedFor = value;
        return;
      }
    }

    if (event.key !== 'Enter' || event.metaKey || event.ctrlKey || event.altKey) return;
    if (multiline) event.preventDefault();
    if (onenter && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      onenter();
    }
  }

  function onFocusOut(event: FocusEvent) {
    const next = event.relatedTarget;
    if (!(next instanceof Node) || !wrap?.contains(next)) {
      focused = false;
      open = false;
      pickerOpen = false;
      if (multiline) {
        multilineExpanded = false;
        void resizeMultilineInput();
      }
    }
  }

  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return {
      destroy() {
        node.remove();
      },
    };
  }
</script>

<div
  class="variable-input-wrap"
  class:multiline
  class:multiline-expanded={multilineExpanded}
  class:has-var-highlights={hasUnresolved}
  class:has-validation-error={Boolean(validationMessage)}
  bind:this={wrap}
  onfocusout={onFocusOut}
>
  {#if backdropHtml}
    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
    <div class="var-backdrop" bind:this={backdropEl} aria-hidden="true">{@html backdropHtml}</div>
  {/if}
  {#if multiline}
    <textarea
      bind:this={inputRef}
      class={className}
      bind:value
      {placeholder}
      aria-label={ariaLabel || undefined}
      aria-invalid={validationMessage ? 'true' : undefined}
      aria-describedby={validationMessage ? validationId : undefined}
      {disabled}
      {spellcheck}
      rows="1"
      wrap="soft"
      oninput={(event) => { onInput(event); void resizeMultilineInput(); }}
      onfocus={onFocus}
      onclick={onClick}
      ondblclick={ondblclick}
      onkeyup={() => { updateCaret(); if (!suppressRefresh) { refreshMenu(); refreshPicker(); } }}
      onkeydown={onKeydown}
      onpaste={(event) => { onpaste?.(event); setTimeout(() => { refreshMenu(); refreshPicker(); void resizeMultilineInput(); }, 0); }}
      onscroll={syncScroll}
      autocomplete="off"
    ></textarea>
  {:else}
    <input
      bind:this={inputRef}
      class={className}
      bind:value
      {type}
      {placeholder}
      aria-label={ariaLabel || undefined}
      aria-invalid={validationMessage ? 'true' : undefined}
      aria-describedby={validationMessage ? validationId : undefined}
      {list}
      {disabled}
      {spellcheck}
      oninput={onInput}
      onfocus={onFocus}
      onclick={onClick}
      ondblclick={ondblclick}
      onkeyup={() => { updateCaret(); if (!suppressRefresh) { refreshMenu(); refreshPicker(); } }}
      onkeydown={onKeydown}
      onpaste={(event) => { onpaste?.(event); setTimeout(() => { refreshMenu(); refreshPicker(); }, 0); }}
      onscroll={syncScroll}
      autocomplete="off"
    />
  {/if}
  {#if validationMessage}
    <button class="input-validation-anchor" type="button" aria-label={validationMessage}>
      <span class="input-validation-icon" aria-hidden="true"></span>
      <span id={validationId} class="input-validation-tooltip" role="tooltip">{validationMessage}</span>
    </button>
  {/if}
  {#if pickerOpen && pickerMatches.length}
    <div
      use:portal
      class="menu variable-menu input-picker-menu"
      role="listbox"
      aria-label={pickerLabel}
      style="--picker-top: {pickerTop}px; --picker-left: {pickerLeft}px; --picker-width: {pickerWidth}px; --picker-max-height: {pickerMaxHeight}px"
    >
      {#each pickerMatches as option, index (option)}
        <button
          class:active={index === pickerActiveIndex}
          class="menu-item input-picker-option"
          type="button"
          role="option"
          aria-selected={index === pickerActiveIndex}
          onmousedown={(event) => event.preventDefault()}
          onclick={() => choosePickerOption(option)}
        >
          <span class="input-picker-value">{option}</span>
        </button>
      {/each}
    </div>
  {/if}
  {#if open && matches.length}
    <div class="menu variable-menu" role="listbox" aria-label="Environment variables">
      {#each matches as variable, index (variable.key)}
        <button class="menu-item"
          class:active={index === activeIndex}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          onmousedown={(event) => event.preventDefault()}
          onclick={() => choose(variable)}
        >
          <span class="variable-menu-key">{variable.key}</span>
          <span class="variable-menu-value">{variableDisplayValue(variable)}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>
