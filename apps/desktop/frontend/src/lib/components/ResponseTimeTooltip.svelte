<script lang="ts">
  import type { ResponseTimings } from '../backend';

  type TimingRow = {
    label: string;
    value: number;
    valueText?: string;
    color: string;
  };

  let {
    timings = null,
    total = 0,
    label = '',
    streaming = false,
  }: {
    timings?: ResponseTimings | null;
    total?: number;
    label?: string;
    streaming?: boolean;
  } = $props();

  function numeric(value: number | undefined | null): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
  }

  function formatDuration(ms: number): string {
    const safe = numeric(ms);
    if (safe >= 1000) {
      const seconds = safe / 1000;
      return `${seconds >= 10 ? seconds.toFixed(1) : seconds.toFixed(2)} s`;
    }
    if (safe > 0 && safe < 1) return `${safe.toFixed(2)} ms`;
    if (safe > 0 && safe < 10) return `${safe.toFixed(2).replace(/\.?0+$/, '')} ms`;
    return `${Math.round(safe)} ms`;
  }

  function rowsFor(source: ResponseTimings | null | undefined): TimingRow[] {
    return [
      { label: 'Prepare', value: numeric(source?.prepare), color: 'var(--text-3)' },
      { label: 'Socket Initialization', value: numeric(source?.socketInitialization), color: 'var(--s4xx)' },
      { label: 'DNS Lookup', value: numeric(source?.dnsLookup), color: 'var(--s4xx)' },
      { label: 'TCP Handshake', value: numeric(source?.tcpHandshake), color: 'var(--s3xx)' },
      { label: 'TLS Handshake', value: numeric(source?.tlsHandshake), color: 'var(--s3xx)' },
      { label: 'Waiting (TTFB)', value: numeric(source?.waitingTTFB), color: 'var(--s5xx)' },
      {
        label: 'Download',
        value: streaming ? 0 : numeric(source?.download),
        valueText: streaming ? 'Stream' : undefined,
        color: 'var(--s2xx)',
      },
      { label: 'Process', value: numeric(source?.process), color: 'var(--text-3)' },
    ];
  }

  let rows = $derived(rowsFor(timings));
  let maxValue = $derived(Math.max(1, ...rows.map((row) => row.value)));
  let triggerLabel = $derived(label || formatDuration(numeric(timings?.total) || total));
  let totalLabel = $derived(formatDuration(numeric(timings?.total) || total));

  function barWidth(value: number): number {
    return Math.max(0, Math.min(100, (numeric(value) / maxValue) * 100));
  }
</script>

<span class="response-time">
  <button class="response-time-trigger" type="button" aria-label="Response time details">{triggerLabel}</button>
  <span class="response-time-popover" role="tooltip">
    <span class="rt-header">
      <span class="rt-title">
        <svg width="1.0625rem" height="1.0625rem" viewBox="0 0 18 18" fill="none" aria-hidden="true">
          <circle cx="9" cy="9" r="7" stroke="currentColor" stroke-width="1.4"/>
          <path d="M9 4.8V9l2.8 1.7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        Response time
      </span>
      <span class="rt-total">{totalLabel}</span>
    </span>

    <span class="rt-rows">
      {#each rows as row, eachIndex (eachIndex)}
        <span class="rt-row">
          <span class="rt-label">{row.label}</span>
          <span class="rt-track">
            <span
              class="rt-bar"
              style={`--bar-width: ${barWidth(row.value)}%; --bar-color: ${row.color};`}
            ></span>
          </span>
          <span class="rt-value">{row.valueText ?? formatDuration(row.value)}</span>
        </span>
      {/each}
    </span>
  </span>
</span>

<style>
  .response-time {
    position: relative;
    display: inline-flex;
    align-items: center;
    min-width: 0;
    padding-bottom: var(--space-2-5);
    margin-bottom: calc(var(--space-2-5) * -1);
  }

  .response-time-trigger {
    padding: 0;
    border: none;
    background: transparent;
    color: var(--text-3);
    font-family: var(--font-mono);
    font-size: var(--text-code);
    line-height: var(--leading-none);
    cursor: default;
    outline: none;
    white-space: nowrap;
  }

  .response-time-trigger:hover,
  .response-time-trigger:focus-visible {
    color: var(--text-2);
  }

  .response-time-popover {
    position: absolute;
    top: calc(100% + 0.625rem);
    left: 0;
    z-index: 50;
    display: none;
    width: min(26.875rem, calc(100vw - 1.5rem));
    padding: var(--space-4) var(--space-4) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: color-mix(in srgb, var(--surface) 94%, var(--bg));
    box-shadow: var(--shadow-popover);
    color: var(--text-2);
    font-family: var(--font-ui);
  }

  .response-time-popover::before {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    bottom: 100%;
    height: 0.625rem;
  }

  .response-time:hover .response-time-popover,
  .response-time:focus-within .response-time-popover {
    display: block;
  }

  .rt-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    margin-bottom: var(--space-2-5);
    color: var(--text);
    font-size: var(--text-body);
    font-weight: var(--weight-semibold);
  }

  .rt-title {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }

  .rt-title svg {
    flex: 0 0 auto;
    color: var(--text-3);
  }

  .rt-total {
    flex: 0 0 auto;
    font-family: var(--font-mono);
    font-size: var(--text-body);
  }

  .rt-rows {
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .rt-row {
    display: grid;
    grid-template-columns: minmax(7.875rem, 0.85fr) minmax(7.5rem, 1.25fr) minmax(4.125rem, auto);
    align-items: center;
    gap: var(--space-2-5);
    min-height: 1.5rem;
  }

  .rt-label {
    overflow: hidden;
    color: var(--text-2);
    font-size: var(--text-label);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .rt-track {
    position: relative;
    height: 0.875rem;
    border-left: 1px solid color-mix(in srgb, var(--text-3) 25%, transparent);
    border-right: 1px solid color-mix(in srgb, var(--text-3) 14%, transparent);
    background: var(--success-bg-subtle);
    overflow: hidden;
  }

  .rt-bar {
    display: block;
    width: var(--bar-width);
    height: 100%;
    background: var(--bar-color);
    min-width: 0;
  }

  .rt-value {
    color: var(--text-3);
    font-family: var(--font-mono);
    font-size: var(--text-caption);
    text-align: right;
    white-space: nowrap;
  }

  @media (max-width: 700px) {
    .response-time-popover {
      padding: var(--space-3);
    }

    .rt-row {
      grid-template-columns: minmax(6.75rem, 0.7fr) minmax(5rem, 1fr) minmax(3.625rem, auto);
      gap: var(--space-2);
    }
  }
</style>
