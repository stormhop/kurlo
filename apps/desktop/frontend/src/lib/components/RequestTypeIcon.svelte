<script lang="ts">
  import type { RequestKind } from '../utils';

  let { kind, size = '1rem', label = '' }: { kind: RequestKind; size?: string; label?: string } = $props();
</script>

<svg class="request-type-icon request-type-icon--{kind}" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" role={label ? 'img' : undefined} aria-label={label || undefined} aria-hidden={label ? undefined : 'true'} data-kind={kind}>
  {#if kind === 'graphql'}
    <path d="M8 2.2l5 2.9v5.8l-5 2.9-5-2.9V5.1z" />
    <path d="M8 2.2l5 8.7H3z" />
    <circle cx="8" cy="2.2" r="1.15" fill="currentColor" stroke="none" />
    <circle cx="13" cy="5.1" r="1.15" fill="currentColor" stroke="none" />
    <circle cx="13" cy="10.9" r="1.15" fill="currentColor" stroke="none" />
    <circle cx="8" cy="13.8" r="1.15" fill="currentColor" stroke="none" />
    <circle cx="3" cy="10.9" r="1.15" fill="currentColor" stroke="none" />
    <circle cx="3" cy="5.1" r="1.15" fill="currentColor" stroke="none" />
  {:else if kind === 'ws'}
    <circle cx="8" cy="8" r="1.3" fill="currentColor" stroke="none" />
    <path d="M5.2 5.2a4 4 0 0 0 0 5.6M10.8 5.2a4 4 0 0 1 0 5.6M3.2 3.2a6.8 6.8 0 0 0 0 9.6M12.8 3.2a6.8 6.8 0 0 1 0 9.6" />
  {:else if kind === 'socketio'}
    <circle cx="8" cy="8" r="6.1" />
    <path d="M9.1 3.9L5.6 8.7h2.6l-1.3 3.4 3.5-4.8H7.8z" fill="currentColor" stroke-width="0.6" />
  {:else if kind === 'grpc'}
    <path d="M5.2 3.8L1.9 8l3.3 4.2M10.8 3.8L14.1 8l-3.3 4.2" />
    <path d="M6.6 8h2.8M8.2 6.6L9.6 8 8.2 9.4" />
  {:else if kind === 'kafka'}
    <path d="M6 4.1v2.2M6 9.7v2.2M7.5 7.2l2.6-1.4M7.5 8.8l2.6 1.4" />
    <circle cx="6" cy="8" r="1.75" />
    <circle cx="6" cy="2.6" r="1.35" />
    <circle cx="6" cy="13.4" r="1.35" />
    <circle cx="11.5" cy="5" r="1.35" />
    <circle cx="11.5" cy="11" r="1.35" />
  {:else if kind === 'mcp'}
    <path d="M6 1.9v3.3M10 1.9v3.3" />
    <path d="M3.9 5.2h8.2v2.3a4.1 4.1 0 0 1-8.2 0z" />
    <path d="M8 11.6v2.5" />
  {:else if kind === 'ai'}
    <path d="M8 1.9c.55 3.4 2.05 4.95 5.6 6.1-3.55 1.15-5.05 2.7-5.6 6.1-.55-3.4-2.05-4.95-5.6-6.1 3.55-1.15 5.05-2.7 5.6-6.1z" />
  {:else if kind === 'sse'}
    <path d="M2.5 8h2l1.5-4 2.5 8 1.5-4h3.5" />
  {:else}
    <path d="M2.5 8h11M10.5 5l3 3-3 3" />
  {/if}
</svg>

<style>
  .request-type-icon {
    flex: 0 0 auto;
    color: var(--text-2);
  }

  .request-type-icon--graphql { color: var(--proto-graphql); }
  .request-type-icon--ws { color: var(--proto-ws); }
  .request-type-icon--socketio { color: var(--proto-sio); }
  .request-type-icon--grpc { color: var(--proto-grpc); }
  .request-type-icon--kafka { color: var(--proto-kafka); }
  .request-type-icon--mcp { color: var(--proto-mcp); }
  .request-type-icon--ai { color: var(--proto-ai); }
  .request-type-icon--sse { color: var(--head); }
</style>
