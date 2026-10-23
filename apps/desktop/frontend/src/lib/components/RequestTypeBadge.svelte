<script lang="ts">
  import type { RequestType, SavedRequest } from '../types/models';
  import { methodColor, requestBadgeLabel, requestKindFor } from '../utils';

  type BadgeVariant = 'sidebar' | 'tab' | 'search';

  let {
    request,
    method = '',
    requestType = 'http',
    url = '',
    variant = 'sidebar',
    invalid = false,
  }: {
    request?: Pick<SavedRequest, 'method' | 'requestType' | 'url'>;
    method?: string;
    requestType?: RequestType;
    url?: string;
    variant?: BadgeVariant;
    invalid?: boolean;
  } = $props();

  const SHORT_LABELS: Record<string, string> = {
    sse: 'SSE',
    ws: 'WS',
    graphql: 'GQL',
    socketio: 'SIO',
    grpc: 'gRPC',
    mcp: 'MCP',
    ai: 'AI',
  };

  function input() {
    return {
      method: request?.method ?? method,
      requestType: request?.requestType ?? requestType,
      url: request?.url ?? url,
    };
  }

  let currentKind = $derived(requestKindFor(input()));
  let currentLabel = $derived(requestBadgeLabel(input()));
  const SIDEBAR_METHOD_LABELS: Record<string, string> = {
    DELETE: 'DEL',
    OPTIONS: 'OPT',
  };

  let shortLabel = $derived(SHORT_LABELS[currentKind] ?? (variant === 'sidebar' ? SIDEBAR_METHOD_LABELS[currentLabel] : undefined) ?? currentLabel);
  let currentMethodClass = $derived(currentKind === 'http' || currentKind === 'sse' ? methodColor(currentLabel) : '');
</script>

<span
  class="request-kind-badge {invalid ? '' : currentMethodClass}"
  class:request-kind-badge--sidebar={variant === 'sidebar'}
  class:request-kind-badge--tab={variant === 'tab'}
  class:request-kind-badge--search={variant === 'search'}
  class:request-kind-badge--protocol={!invalid && currentKind !== 'http' && currentKind !== 'sse'}
  class:request-kind-badge--invalid={invalid}
  title={invalid ? 'Invalid request — open the diagnostic for details' : currentLabel}
  aria-label={invalid ? 'Invalid request' : currentLabel}
>
  {#if invalid}
    <svg width="1rem" height="1rem" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M9 2.2l7 12.1H2L9 2.2z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
      <path d="M9 7v3.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      <circle cx="9" cy="12.4" r="0.95" fill="currentColor"/>
    </svg>
  {:else}
    <span class="request-kind-text">{shortLabel}</span>
  {/if}
</span>

<style>
  .request-kind-badge {
    display: inline-flex;
    align-items: center;
    justify-content: flex-start;
    flex: 0 0 auto;
    min-width: 0;
    height: 1.25rem;
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    font-weight: var(--weight-medium);
    letter-spacing: 0.02em;
    line-height: var(--leading-none);
  }

  .request-kind-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .request-kind-badge--protocol {
    color: color-mix(in srgb, var(--accent) 62%, var(--text));
  }

  .request-kind-badge--invalid {
    color: var(--diagnostic-badge-text);
  }

  .request-kind-badge--sidebar {
    width: 2.375rem;
  }

  .request-kind-badge--tab {
    width: auto;
    max-width: 3.375rem;
  }

  .request-kind-badge--search {
    justify-self: center;
    justify-content: center;
    width: 3rem;
  }
</style>
