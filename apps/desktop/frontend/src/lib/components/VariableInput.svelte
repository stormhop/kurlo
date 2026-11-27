<script lang="ts">
  import type { VariableSuggestion } from '../variables';
  import { VAULT_TEMPLATE_PREFIX, dynamicVariableDescription, matchVariableSuggestions, templateVariableKey, variableDisplayValue, variableSourceLabel } from '../variables';
  import { isDynamicVariableName, resolveDynamicVariable } from '../dynamicVariables';
  import { variableEditor } from '../variableEditor';
  import { tick } from 'svelte';
  import { escapeHtml } from '../utils';
  import type { InputGhost } from '../ghostText';
  import { horizontalWheel } from '../horizontalWheel';

  let {
    value = $bindable(''),
    id = undefined,
    inputRef = $bindable<HTMLInputElement | undefined>(),
    suggestions = [],
    className = '',
    placeholder = '',
    ariaLabel = '',
    list = undefined,
    type = 'text',
    disabled = false,
    spellcheck = false,
    wheelScroll = false,
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
    value?: string;
    id?: string;
    inputRef?: HTMLInputElement;
    suggestions?: VariableSuggestion[];
    className?: string;
    placeholder?: string;
    ariaLabel?: string;
    list?: string;
    type?: string;
    disabled?: boolean;
    spellcheck?: boolean;
    wheelScroll?: boolean;
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
  let focused = $state(false);
  let caretAtEnd = $state(true);
  let ghostDismissedFor = $state<string | null>(null);

  const knownKeySet = $derived(new Set(suggestions.map(s => s.key)));
  const suggestionByKey = $derived(new Map(suggestions.map(s => [s.key, s] as const)));

  const activeGhost = $derived.by(() => {
    if (!ghost || !focused || !caretAtEnd || open || pickerOpen || disabled || ghostDismissedFor === value) return null;
    return ghost(value);
  });

  const highlightHtml = $derived.by(() => {
    if (!value || !value.includes('{{')) return '';
    const VAR_RE = /\{\{([^{}]*)}}/g;
    let result = '';
    let last = 0;
    let m: RegExpExecArray | null;
    let index = 0;
    while ((m = VAR_RE.exec(value)) !== null) {
      result += escapeHtml(value.slice(last, m.index));
      const key = templateVariableKey(m[1]);
      const known = knownKeySet.has(key) || isDynamicVariableName(key);
      result += `<mark class="${known ? 'var-token' : 'var-token var-token-err'}" data-var-key="${escapeHtml(key)}" data-var-index="${index}">${escapeHtml(m[0])}</mark>`;
      index += 1;
      last = m.index + m[0].length;
    }
    result += escapeHtml(value.slice(last));
    return result;
  });

  const backdropHtml = $derived.by(() => {
    if (type === 'password') return '';
    if (!activeGhost) return highlightHtml;
    return `${highlightHtml || escapeHtml(value)}<span class="ghost-text" data-testid="ghost-text">${escapeHtml(activeGhost.text)}</span>`;
  });

  const hasUnresolved = $derived(highlightHtml.includes('var-token-err'));

  type VariableHover = { key: string; index: number; top: number; bottom: number; left: number };
  const NEW_VARIABLE_KEY = /^[\p{L}\p{N}_.-]+$/u;
  let hover = $state<VariableHover | null>(null);
  let hoverDraft = $state('');
  let hoverSaved = $state<'' | 'Saved' | 'Removed'>('');
  let popoverEl = $state<HTMLDivElement | undefined>();
  let hoverShowTimer: ReturnType<typeof setTimeout> | undefined;
  let hoverHideTimer: ReturnType<typeof setTimeout> | undefined;
  let hoverSavedTimer: ReturnType<typeof setTimeout> | undefined;

  const hoverSuggestion = $derived(hover ? suggestionByKey.get(hover.key) : undefined);
  const hoverDynamic = $derived(Boolean(hover && !hoverSuggestion && isDynamicVariableName(hover.key)));
  const hoverEditor = $derived(hover ? variableEditor() : null);
  const hoverEditable = $derived(Boolean(hoverEditor && hoverSuggestion?.source && !hoverSuggestion.source.readonly && !hoverSuggestion.linked));
  const hoverAddTarget = $derived(hover && hoverEditor && !hoverSuggestion && !hoverDynamic && NEW_VARIABLE_KEY.test(hover.key) ? hoverEditor.addTarget() : null);
  const hoverDirty = $derived(hoverEditable ? hoverDraft !== (hoverSuggestion?.value ?? '') : hoverDraft !== '');
  const hoverRemoves = $derived(hoverEditable && hoverDraft === '');
  const popoverLeft = $derived.by(() => {
    if (!hover) return 0;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    return Math.max(8, Math.min(hover.left, viewportWidth - 328));
  });
  const popoverPlacement = $derived.by(() => {
    if (!hover) return '';
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    if (hover.bottom + 200 > viewportHeight && hover.top > 220) return `bottom: ${viewportHeight - hover.top + 6}px`;
    return `top: ${hover.bottom + 6}px`;
  });

  function clearHoverTimers() {
    clearTimeout(hoverShowTimer);
    clearTimeout(hoverHideTimer);
  }

  function tokenAt(x: number, y: number): VariableHover | null {
    if (!backdropEl || !wrap) return null;
    const bounds = wrap.getBoundingClientRect();
    if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return null;
    for (const mark of backdropEl.querySelectorAll<HTMLElement>('mark[data-var-index]')) {
      for (const rect of mark.getClientRects()) {
        if (x >= rect.left && x <= rect.right && y >= rect.top - 2 && y <= rect.bottom + 2) {
          return { key: mark.dataset.varKey ?? '', index: Number(mark.dataset.varIndex), top: rect.top, bottom: rect.bottom, left: rect.left };
        }
      }
    }
    return null;
  }

  function showHover(next: VariableHover) {
    if (hover && hover.index === next.index && hover.key === next.key) {
      hover = next;
      return;
    }
    hover = next;
    hoverSaved = '';
    const suggestion = suggestionByKey.get(next.key);
    hoverDraft = suggestion?.source && !suggestion.source.readonly && !suggestion.linked ? suggestion.value : '';
  }

  function scheduleHide() {
    clearTimeout(hoverShowTimer);
    clearTimeout(hoverHideTimer);
    if (!hover) return;
    hoverHideTimer = setTimeout(() => {
      if (popoverEl?.matches(':hover') || popoverEl?.contains(document.activeElement)) return;
      hover = null;
    }, 220);
  }

  function onWrapMouseMove(event: MouseEvent) {
    if (open || pickerOpen || type === 'password') return;
    const next = tokenAt(event.clientX, event.clientY);
    if (!next) {
      scheduleHide();
      return;
    }
    clearHoverTimers();
    if (hover) {
      if (!hoverDirty || !popoverEl?.contains(document.activeElement)) showHover(next);
      return;
    }
    hoverShowTimer = setTimeout(() => showHover(next), 350);
  }

  function closeHover(refocus = false) {
    clearHoverTimers();
    hover = null;
    if (refocus) inputRef?.focus();
  }

  async function saveHover(event: SubmitEvent) {
    event.preventDefault();
    const editor = variableEditor();
    if (!hover || !editor) return;
    let outcome: 'Saved' | 'Removed';
    if (hoverEditable && hoverSuggestion?.source && hoverRemoves) {
      await editor.remove(hover.key, hoverSuggestion.source);
      outcome = 'Removed';
    } else if (!hoverDirty) {
      return;
    } else if (hoverEditable && hoverSuggestion?.source) {
      await editor.save(hover.key, hoverDraft, hoverSuggestion.source);
      outcome = 'Saved';
    } else if (hoverAddTarget) {
      await editor.save(hover.key, hoverDraft, hoverAddTarget);
      outcome = 'Saved';
    } else {
      return;
    }
    await tick();
    hoverSaved = outcome;
    clearTimeout(hoverSavedTimer);
    hoverSavedTimer = setTimeout(() => (hoverSaved = ''), 1600);
    const saved = suggestionByKey.get(hover.key);
    hoverDraft = saved?.source && !saved.source.readonly && !saved.linked ? saved.value : '';
  }

  function onPopoverKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    closeHover(true);
  }

  function onPopoverFocusOut(event: FocusEvent) {
    const next = event.relatedTarget;
    if (next instanceof Node && popoverEl?.contains(next)) return;
    scheduleHide();
  }

  $effect(() => () => {
    clearHoverTimers();
    clearTimeout(hoverSavedTimer);
  });

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
    const filled = pickerOptions.filter(option => option.trim());
    const firstIndex = new Map(filled.map((option, index) => [option.toLowerCase(), index] as const).reverse());
    const options = filled.filter((option, index) => {
      const key = option.toLowerCase();
      return firstIndex.get(key) === index && (!needle || key.includes(needle));
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

  function wheelScrollAction(node: HTMLInputElement) {
    return wheelScroll ? horizontalWheel(node, syncScroll) : undefined;
  }

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
    return matchVariableSuggestions(suggestions, range.prefix).items;
  }

  function refreshMenu() {
    matches = filteredSuggestions();
    open = matches.length > 0;
    if (open) {
      pickerOpen = false;
      if (hover) closeHover();
    }
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
    if (hover) closeHover();
    pickerActiveIndex = Math.min(pickerActiveIndex, Math.max(0, pickerMatches.length - 1));
  }

  function choose(variable: VariableSuggestion) {
    const range = triggerRange();
    if (!range) return;
    const prefixOnly = variable.key === VAULT_TEMPLATE_PREFIX;
    const vault = !prefixOnly && range.prefix.startsWith(VAULT_TEMPLATE_PREFIX);
    const insert = prefixOnly ? VAULT_TEMPLATE_PREFIX : `${vault ? VAULT_TEMPLATE_PREFIX : ''}${variable.key}}}`;
    value = `${value.slice(0, range.from)}${insert}${value.slice(prefixOnly ? range.from + range.prefix.length : range.to)}`;
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
      if (prefixOnly) refreshMenu();
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
    if (hover) closeHover();
    updateCaret();
    oninput?.(event);
    refreshMenu();
    refreshPicker();
  }

  function onFocus(event: FocusEvent) {
    focused = true;
    updateCaret();
    onfocus?.(event);
    refreshMenu();
    refreshPicker();
  }

  function onClick(event: MouseEvent) {
    updateCaret();
    onclick?.(event);
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
  class:has-var-highlights={hasUnresolved}
  class:has-validation-error={Boolean(validationMessage)}
  bind:this={wrap}
  onfocusout={onFocusOut}
  onmousemove={onWrapMouseMove}
  onmouseleave={scheduleHide}
  role="presentation"
>
  {#if backdropHtml}
    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
    <div class="var-backdrop" bind:this={backdropEl} aria-hidden="true">{@html backdropHtml}</div>
  {/if}
  <input
    bind:this={inputRef}
    {id}
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
    autocomplete="off"
    autocorrect="off"
    autocapitalize="none"
    oninput={onInput}
    onfocus={onFocus}
    onclick={onClick}
    ondblclick={ondblclick}
    onkeyup={() => { updateCaret(); if (!suppressRefresh) { refreshMenu(); refreshPicker(); } }}
    onkeydown={onKeydown}
    onpaste={(event) => { onpaste?.(event); setTimeout(() => { refreshMenu(); refreshPicker(); }, 0); }}
    onscroll={syncScroll}
    use:wheelScrollAction
  />
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
  {#if hover}
    <div
      use:portal
      bind:this={popoverEl}
      class="var-popover"
      role="dialog"
      aria-label={`Variable ${hover.key}`}
      style="left: {popoverLeft}px; {popoverPlacement}"
      tabindex="-1"
      onmouseenter={() => clearTimeout(hoverHideTimer)}
      onmouseleave={scheduleHide}
      onkeydown={onPopoverKeydown}
      onfocusout={onPopoverFocusOut}
    >
      <div class="var-popover-head">
        <code class="var-popover-key">{`{{${hover.key}}}`}</code>
        <span class="var-popover-source" class:missing={!hoverSuggestion && !hoverDynamic}>
          {#if hoverSuggestion?.source}{variableSourceLabel(hoverSuggestion.source)}{:else if hoverSuggestion}{hoverSuggestion.description || 'Defined'}{:else if hoverDynamic}Dynamic{:else}Not defined{/if}
        </span>
      </div>
      {#if hoverDynamic}
        <p class="var-popover-note">{dynamicVariableDescription(hover.key)}</p>
        <p class="var-popover-note">A new value is generated on every send, for example <code>{resolveDynamicVariable(hover.key)}</code>.</p>
      {:else if hoverSuggestion && hoverEditable}
        <form class="var-popover-form" onsubmit={saveHover}>
          <input
            class="field field-input field-mono"
            type={hoverSuggestion.secret ? 'password' : 'text'}
            bind:value={hoverDraft}
            aria-label={`Value of ${hover.key}`}
            spellcheck="false"
            autocomplete="off"
            autocorrect="off"
            autocapitalize="none"
          />
          {#if hoverRemoves}
            <button class="btn btn-danger btn-sm" type="submit">Remove</button>
          {:else}
            <button class="btn btn-primary btn-sm" type="submit" disabled={!hoverDirty}>Save</button>
          {/if}
        </form>
        {#if hoverSaved}<p class="var-popover-note var-popover-saved" role="status">{hoverSaved}</p>{/if}
        {#if hoverRemoves}
          <p class="var-popover-note">Removes <code>{hover.key}</code> from {hoverSuggestion.source ? variableSourceLabel(hoverSuggestion.source) : 'this scope'}.</p>
        {/if}
      {:else if hoverSuggestion}
        <p class="var-popover-value">{variableDisplayValue(hoverSuggestion) || 'Empty'}</p>
        {#if hoverSuggestion.linked || hoverSuggestion.source?.readonly}
          <p class="var-popover-note">Read from a secret provider. Change it in Environments.</p>
        {/if}
      {:else}
        <p class="var-popover-note">No environment, collection, global or request variable has this name.</p>
        {#if hoverSaved === 'Removed'}<p class="var-popover-note var-popover-saved" role="status">Removed</p>{/if}
        {#if hoverAddTarget}
          <form class="var-popover-form" onsubmit={saveHover}>
            <input
              class="field field-input field-mono"
              type="text"
              bind:value={hoverDraft}
              placeholder="Value"
              aria-label={`Value of ${hover.key}`}
              spellcheck="false"
              autocomplete="off"
              autocorrect="off"
              autocapitalize="none"
            />
            <button class="btn btn-primary btn-sm" type="submit" disabled={!hoverDirty}>Add to {hoverAddTarget.name}</button>
          </form>
        {/if}
      {/if}
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
          <span class="variable-menu-value">{variable.key === VAULT_TEMPLATE_PREFIX ? variable.description : variableDisplayValue(variable)}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>
