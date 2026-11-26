<script lang="ts">
  import type { RequestType, SavedRequest } from '../types/models';
  import { methodColor, requestBadgeLabel, requestKindFor } from '../utils';
  import RequestTypeIcon from './RequestTypeIcon.svelte';

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

  let isProtocol = $derived(currentKind !== 'http' && currentKind !== 'sse');
  let shortLabel = $derived((variant === 'sidebar' ? SIDEBAR_METHOD_LABELS[currentLabel] : undefined) ?? currentLabel);
  let currentMethodClass = $derived(currentKind === 'http' || currentKind === 'sse' ? methodColor(currentLabel) : '');
</script>

<span
  class="request-kind-badge {invalid ? '' : currentMethodClass}"
  class:request-kind-badge--sidebar={variant === 'sidebar'}
  class:request-kind-badge--tab={variant === 'tab'}
  class:request-kind-badge--search={variant === 'search'}
  class:request-kind-badge--protocol={!invalid && isProtocol}
  class:request-kind-badge--invalid={invalid}
  aria-label={invalid ? 'Invalid request' : currentLabel}
>
  {#if invalid}
    <svg width="1rem" height="1rem" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M9 2.2l7 12.1H2L9 2.2z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
      <path d="M9 7v3.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      <circle cx="9" cy="12.4" r="0.95" fill="currentColor"/>
    </svg>
  {:else if isProtocol}
    <RequestTypeIcon kind={currentKind} />
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
    overflow: clip;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .request-kind-badge--protocol.request-kind-badge--tab {
    width: 1rem;
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
