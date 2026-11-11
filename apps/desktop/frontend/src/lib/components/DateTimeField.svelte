<script lang="ts" module>
  export type DateTimePreset = { label: string; minutes: number };

  export const DEFAULT_DATE_TIME_PRESETS: DateTimePreset[] = [
    { label: 'In 1 hour', minutes: 60 },
    { label: 'Tomorrow', minutes: 1440 },
    { label: 'In 7 days', minutes: 10080 },
    { label: 'In 30 days', minutes: 43200 },
  ];
</script>

<script lang="ts">
  import { tick } from 'svelte';
  import {
    addDays,
    addMonths,
    clampTimePart,
    dayLabel,
    defaultTime,
    formatDateTimeLabel,
    formatDateTimeValue,
    monthGrid,
    monthLabel,
    padTimePart,
    parseDateTimeValue,
    partsFromTimestamp,
    presetValue,
    sameDay,
    weekdayIndex,
    weekdayLabels,
    type DateParts,
  } from '../dateTime';

  let {
    value = $bindable(''),
    ariaLabel,
    placeholder = 'Not set',
    presets = DEFAULT_DATE_TIME_PRESETS,
    disabled = false,
  }: {
    value?: string;
    ariaLabel: string;
    placeholder?: string;
    presets?: DateTimePreset[];
    disabled?: boolean;
  } = $props();

  const EDGE_GAP_REM = 0.5;
  const weekdays = weekdayLabels();

  let root = $state<HTMLElement | null>(null);
  let trigger = $state<HTMLButtonElement | null>(null);
  let grid = $state<HTMLElement | null>(null);
  let popover = $state<HTMLElement | null>(null);
  let open = $state(false);
  let popTop = $state(0);
  let popLeft = $state(0);
  let placed = $state(false);
  let viewYear = $state(0);
  let viewMonth = $state(0);
  let focusDay = $state<DateParts>({ year: 2000, month: 0, day: 1 });
  let hourText = $state('');
  let minuteText = $state('');

  let selected = $derived(parseDateTimeValue(value));
  let today = $derived(partsFromTimestamp(Date.now()));
  let rows = $derived.by(() => {
    const days = monthGrid(viewYear, viewMonth);
    return Array.from({ length: 6 }, (_, row) => days.slice(row * 7, row * 7 + 7));
  });

  function dayKey(day: DateParts): string {
    return `${day.year}-${day.month}-${day.day}`;
  }

  function remToPx(rem: number): number {
    return rem * (Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
  }

  function syncTimeTexts() {
    const time = selected ?? defaultTime(Date.now());
    hourText = padTimePart(time.hour);
    minuteText = padTimePart(time.minute);
  }

  function showMonthOf(day: DateParts) {
    viewYear = day.year;
    viewMonth = day.month;
  }

  async function focusCurrentDay() {
    await tick();
    grid?.querySelector<HTMLElement>(`[data-day="${dayKey(focusDay)}"]`)?.focus();
  }

  async function openPicker() {
    if (disabled) return;
    const start = selected ?? today;
    focusDay = { year: start.year, month: start.month, day: start.day };
    showMonthOf(focusDay);
    syncTimeTexts();
    placed = false;
    open = true;
    await tick();
    placePopover();
    await focusCurrentDay();
  }

  function placePopover() {
    if (!open || !trigger || !popover) return;
    const anchor = trigger.getBoundingClientRect();
    const size = popover.getBoundingClientRect();
    const gap = remToPx(EDGE_GAP_REM);
    const maxTop = Math.max(gap, window.innerHeight - size.height - gap);
    const below = anchor.bottom + gap / 2;
    const above = anchor.top - gap / 2 - size.height;
    const top = below + size.height <= window.innerHeight - gap || above < gap ? below : above;
    popTop = Math.min(Math.max(gap, top), maxTop);
    popLeft = Math.min(Math.max(gap, anchor.left), Math.max(gap, window.innerWidth - size.width - gap));
    placed = true;
  }

  $effect(() => {
    if (!open) return;
    const reposition = () => placePopover();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  });

  function closePicker(returnFocus = true) {
    if (!open) return;
    open = false;
    if (returnFocus) trigger?.focus();
  }

  function currentTime(): { hour: number; minute: number } {
    const fallback = selected ?? defaultTime(Date.now());
    return {
      hour: clampTimePart(hourText, 23) ?? fallback.hour,
      minute: clampTimePart(minuteText, 59) ?? fallback.minute,
    };
  }

  function selectDay(day: DateParts) {
    value = formatDateTimeValue({ year: day.year, month: day.month, day: day.day, ...currentTime() });
    focusDay = { year: day.year, month: day.month, day: day.day };
    if (day.month !== viewMonth || day.year !== viewYear) showMonthOf(day);
  }

  function commitTime() {
    const time = currentTime();
    hourText = padTimePart(time.hour);
    minuteText = padTimePart(time.minute);
    if (selected) value = formatDateTimeValue({ ...selected, ...time });
  }

  function applyPreset(preset: DateTimePreset) {
    value = presetValue(Date.now(), preset.minutes);
    const next = parseDateTimeValue(value);
    if (!next) return;
    focusDay = { year: next.year, month: next.month, day: next.day };
    showMonthOf(focusDay);
    hourText = padTimePart(next.hour);
    minuteText = padTimePart(next.minute);
  }

  function clearValue() {
    value = '';
    closePicker();
  }

  function shiftMonth(delta: number) {
    focusDay = addMonths(focusDay, delta);
    showMonthOf(focusDay);
  }

  function moveFocus(next: DateParts) {
    focusDay = next;
    if (next.month !== viewMonth || next.year !== viewYear) showMonthOf(next);
    void focusCurrentDay();
  }

  function onGridKeydown(event: KeyboardEvent) {
    const moves: Record<string, () => DateParts> = {
      ArrowLeft: () => addDays(focusDay, -1),
      ArrowRight: () => addDays(focusDay, 1),
      ArrowUp: () => addDays(focusDay, -7),
      ArrowDown: () => addDays(focusDay, 7),
      PageUp: () => addMonths(focusDay, -1),
      PageDown: () => addMonths(focusDay, 1),
      Home: () => addDays(focusDay, -weekdayIndex(focusDay)),
      End: () => addDays(focusDay, 6 - weekdayIndex(focusDay)),
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    event.stopPropagation();
    moveFocus(move());
  }

  $effect(() => {
    const node = root;
    if (!node) return;
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !open) return;
      event.preventDefault();
      event.stopPropagation();
      closePicker();
    };
    node.addEventListener('keydown', onKeydown);
    return () => node.removeEventListener('keydown', onKeydown);
  });

  function onTriggerKeydown(event: KeyboardEvent) {
    if (event.key !== 'ArrowDown' || open) return;
    event.preventDefault();
    void openPicker();
  }

  function onTimeKeydown(event: KeyboardEvent, part: 'hour' | 'minute') {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      commitTime();
      closePicker();
      return;
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const step = event.key === 'ArrowUp' ? 1 : -1;
    const time = currentTime();
    if (part === 'hour') hourText = padTimePart((time.hour + step + 24) % 24);
    else minuteText = padTimePart((time.minute + step + 60) % 60);
    commitTime();
  }

  function onOutsidePointer(event: PointerEvent) {
    if (open && event.target instanceof Node && !root?.contains(event.target)) closePicker(false);
  }
</script>

<svelte:document onpointerdowncapture={onOutsidePointer} />

<div class="date-field" bind:this={root}>
  <button
    class="field date-field-trigger"
    class:open
    class:empty={!selected}
    bind:this={trigger}
    type="button"
    aria-label={ariaLabel}
    aria-haspopup="dialog"
    aria-expanded={open}
    {disabled}
    onclick={() => (open ? closePicker() : void openPicker())}
    onkeydown={onTriggerKeydown}
  >
    <span class="date-field-value">{selected ? formatDateTimeLabel(value) : placeholder}</span>
    <svg class="date-field-icon" width="0.875rem" height="0.875rem" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2.25" y="3.25" width="11.5" height="10.5" rx="2" stroke="currentColor" stroke-width="1.3"/>
      <path d="M2.5 6.5h11M5.5 1.75v3M10.5 1.75v3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
    </svg>
  </button>

  {#if open}
    <div class="menu date-picker" bind:this={popover} style:top="{popTop}px" style:left="{popLeft}px" style:visibility={placed ? 'visible' : 'hidden'} role="dialog" aria-label="{ariaLabel} date" tabindex="-1">
      <div class="date-picker-head">
        <button class="btn btn-ghost btn-icon btn-sm" type="button" aria-label="Previous month" onclick={() => shiftMonth(-1)}>
          <svg width="0.75rem" height="0.75rem" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M7.5 2.5 4 6l3.5 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <span class="date-picker-month" aria-live="polite">{monthLabel(viewYear, viewMonth)}</span>
        <button class="btn btn-ghost btn-icon btn-sm" type="button" aria-label="Next month" onclick={() => shiftMonth(1)}>
          <svg width="0.75rem" height="0.75rem" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M4.5 2.5 8 6 4.5 9.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>

      <div class="date-picker-grid" role="grid" aria-label={monthLabel(viewYear, viewMonth)} bind:this={grid} onkeydown={onGridKeydown} tabindex="-1">
        <div class="date-picker-row" role="row">
          {#each weekdays as weekday (weekday)}
            <span class="date-picker-weekday" role="columnheader">{weekday}</span>
          {/each}
        </div>
        {#each rows as row, rowIndex (rowIndex)}
          <div class="date-picker-row" role="row">
            {#each row as day (dayKey(day))}
              <button
                class="date-picker-day"
                class:outside={!day.inMonth}
                class:today={sameDay(day, today)}
                class:selected={sameDay(day, selected)}
                type="button"
                role="gridcell"
                aria-selected={sameDay(day, selected)}
                aria-label={dayLabel(day)}
                tabindex={sameDay(day, focusDay) ? 0 : -1}
                data-day={dayKey(day)}
                onclick={() => selectDay(day)}
              >{day.day}</button>
            {/each}
          </div>
        {/each}
      </div>

      <div class="date-picker-time">
        <span class="date-picker-label">Time</span>
        <input class="field field-sm field-mono date-picker-time-input" bind:value={hourText} inputmode="numeric" maxlength="2" spellcheck="false" aria-label="Hour" onblur={commitTime} onkeydown={(event) => onTimeKeydown(event, 'hour')} />
        <span class="date-picker-colon" aria-hidden="true">:</span>
        <input class="field field-sm field-mono date-picker-time-input" bind:value={minuteText} inputmode="numeric" maxlength="2" spellcheck="false" aria-label="Minute" onblur={commitTime} onkeydown={(event) => onTimeKeydown(event, 'minute')} />
      </div>

      {#if presets.length}
        <div class="date-picker-presets">
          {#each presets as preset (preset.label)}
            <button class="btn btn-secondary btn-sm" type="button" onclick={() => applyPreset(preset)}>{preset.label}</button>
          {/each}
        </div>
      {/if}

      <div class="date-picker-foot">
        <button class="btn btn-ghost btn-sm" type="button" onclick={clearValue} disabled={!selected}>Clear</button>
        <button class="btn btn-primary btn-sm" type="button" onclick={() => { commitTime(); closePicker(); }}>Done</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .date-field {
    position: relative;
    min-width: 0;
  }

  .date-field-trigger {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    text-align: left;
    cursor: pointer;
  }

  .date-field-value {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .date-field-trigger.empty .date-field-value {
    color: var(--text-3);
  }

  .date-field-icon {
    flex-shrink: 0;
    color: var(--text-3);
  }

  .date-picker {
    position: fixed;
    z-index: 200;
    display: flex;
    flex-direction: column;
    gap: var(--space-2-5);
    width: 18rem;
    padding: var(--space-3);
  }

  .date-picker-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .date-picker-month {
    color: var(--text);
    font-size: var(--text-body);
    font-weight: var(--weight-semibold);
  }

  .date-picker-grid {
    display: flex;
    flex-direction: column;
    gap: var(--space-0-5);
    outline: none;
  }

  .date-picker-row {
    display: grid;
    grid-template-columns: repeat(7, minmax(0, 1fr));
    gap: var(--space-0-5);
  }

  .date-picker-weekday {
    padding: var(--space-1) 0;
    color: var(--text-3);
    font-size: var(--text-caption);
    font-weight: var(--weight-medium);
    text-align: center;
  }

  .date-picker-day {
    height: var(--control-lg);
    border: none;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: var(--text-label);
    font-variant-numeric: tabular-nums;
    cursor: pointer;
    transition: background var(--dur-fast), color var(--dur-fast);
  }

  .date-picker-day:hover {
    background: var(--hover);
  }

  .date-picker-day:focus-visible {
    outline: var(--focus-outline);
    outline-offset: -2px;
  }

  .date-picker-day.outside {
    color: var(--text-3);
  }

  .date-picker-day.today {
    color: var(--accent-text);
    font-weight: var(--weight-semibold);
  }

  .date-picker-day.selected {
    background: var(--accent);
    color: var(--on-accent);
    font-weight: var(--weight-semibold);
  }

  .date-picker-time {
    display: flex;
    align-items: center;
    gap: var(--space-1-5);
    padding-top: var(--space-2-5);
    border-top: 1px solid var(--border-subtle);
  }

  .date-picker-label {
    flex: 1;
    color: var(--text-2);
    font-size: var(--text-label);
  }

  .date-picker-time-input {
    width: 2.75rem;
    text-align: center;
  }

  .date-picker-colon {
    color: var(--text-3);
  }

  .date-picker-presets {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-1);
  }

  .date-picker-foot {
    display: flex;
    justify-content: space-between;
    padding-top: var(--space-2-5);
    border-top: 1px solid var(--border-subtle);
  }
</style>
