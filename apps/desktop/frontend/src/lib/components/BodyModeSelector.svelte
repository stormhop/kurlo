<script lang="ts">
  import Select from './Select.svelte';
  import Chevron from './Chevron.svelte';
  import CheckIcon from './CheckIcon.svelte';
  import type { BodyMode, RawBodyType } from '../types/models';
  import BeautifyButton from './BeautifyButton.svelte';

  let {
    rawBodyType,
    rawBodyTypes,
    bodyModeIs,
    setBodyMode,
    rawTypeLabel,
    setRawBodyType,
    showBeautify = false,
    beautified = false,
    beautifyDisabled = false,
    onBeautify,
  }: {
    rawBodyType: RawBodyType;
    rawBodyTypes: RawBodyType[];
    bodyModeIs: (mode: BodyMode) => boolean;
    setBodyMode: (mode: BodyMode) => void;
    rawTypeLabel: (type?: RawBodyType) => string;
    setRawBodyType: (type: RawBodyType) => void;
    showBeautify?: boolean;
    beautified?: boolean;
    beautifyDisabled?: boolean;
    onBeautify?: () => void;
  } = $props();

  let bodyModeMenuOpen = $state(false);

  const bodyModes: { mode: BodyMode; label: string }[] = [
    { mode: 'none', label: 'None' },
    { mode: 'form', label: 'Form data' },
    { mode: 'urlencoded', label: 'URL-encoded' },
    { mode: 'raw', label: 'Raw' },
    { mode: 'binary', label: 'Binary' },
  ];

  let activeBodyMode = $derived(bodyModes.find(({ mode }) => bodyModeIs(mode)) ?? bodyModes[0]);

  function chooseBodyMode(mode: BodyMode) {
    setBodyMode(mode);
    bodyModeMenuOpen = false;
  }


  function closeBodyModeMenuOnFocusOut(event: FocusEvent) {
    const current = event.currentTarget;
    const next = event.relatedTarget;

    if (!(current instanceof HTMLElement)) return;
    if (!(next instanceof Node) || !current.contains(next)) bodyModeMenuOpen = false;
  }
</script>

<div class="body-mode-row">
  <div class="body-mode-compact-menu" onfocusout={closeBodyModeMenuOnFocusOut}>
    <button
      class="field field-sm select-trigger body-mode-compact-trigger"
      class:open={bodyModeMenuOpen}
      type="button"
      aria-label="Body type"
      aria-haspopup="listbox"
      aria-expanded={bodyModeMenuOpen}
      onclick={() => (bodyModeMenuOpen = !bodyModeMenuOpen)}
    >
      <span>{activeBodyMode.label}</span>
      <Chevron />
    </button>
    {#if bodyModeMenuOpen}
      <div class="menu body-mode-compact-list" role="listbox" aria-label="Body types">
        {#each bodyModes as item, eachIndex (eachIndex)}
          <button class="menu-item"
            class:active={bodyModeIs(item.mode)}
            role="option"
            aria-selected={bodyModeIs(item.mode)}
            type="button"
            onclick={() => chooseBodyMode(item.mode)}
          >
            <span class="body-mode-check">{#if bodyModeIs(item.mode)}<CheckIcon />{/if}</span>
            <span>{item.label}</span>
          </button>
        {/each}
      </div>
    {/if}
  </div>
  <div class="segmented body-mode-segments" role="radiogroup" aria-label="Body type">
    <label class="segmented-item body-mode-label" class:active={bodyModeIs('none')}>
      <input type="radio" name="bodyMode" value="none" checked={bodyModeIs('none')} onchange={() => setBodyMode('none')} />
      None
    </label>
    <label class="segmented-item body-mode-label" class:active={bodyModeIs('form')}>
      <input type="radio" name="bodyMode" value="form" checked={bodyModeIs('form')} onchange={() => setBodyMode('form')} />
      Form data
    </label>
    <label class="segmented-item body-mode-label" class:active={bodyModeIs('urlencoded')}>
      <input type="radio" name="bodyMode" value="urlencoded" checked={bodyModeIs('urlencoded')} onchange={() => setBodyMode('urlencoded')} />
      URL-encoded
    </label>
    <label class="segmented-item body-mode-label" class:active={bodyModeIs('raw')}>
      <input type="radio" name="bodyMode" value="raw" checked={bodyModeIs('raw')} onchange={() => setBodyMode('raw')} />
      Raw
    </label>
    <label class="segmented-item body-mode-label" class:active={bodyModeIs('binary')}>
      <input type="radio" name="bodyMode" value="binary" checked={bodyModeIs('binary')} onchange={() => setBodyMode('binary')} />
      Binary
    </label>
  </div>
  {#if bodyModeIs('raw')}
    <Select
      className="raw-type-menu"
      size="sm"
      ariaLabel="Raw body type"
      value={rawBodyType}
      options={rawBodyTypes.map(type => ({ value: type, label: rawTypeLabel(type) }))}
      onChange={type => setRawBodyType(type as RawBodyType)}
    />
  {/if}
  {#if showBeautify}
    <div class="body-mode-beautify">
      <BeautifyButton onbeautify={() => onBeautify?.()} beautified={beautified} disabled={beautifyDisabled} title="Beautify body" />
    </div>
  {/if}
</div>

<style>

  .body-mode-beautify {
    display: flex;
    align-items: center;
    margin-left: auto;
  }
</style>
