<script lang="ts">
  type MenuIconName = 'request' | 'folder' | 'settings' | 'rename' | 'export' | 'import' | 'trash' | 'duplicate' | 'star' | 'copy' | 'play' | 'open' | 'example' | 'collection' | 'collection-add' | 'lock' | 'replace';

  let { name }: { name: MenuIconName } = $props();
</script>

<svg class="menu-icon" width="0.9375rem" height="0.9375rem" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  {#if name === 'request'}
    <path d="M4 2.5h5l3 3v8H4z"/><path d="M9 2.5v3h3M8 8v4M6 10h4"/>
  {:else if name === 'folder'}
    <path d="M2 4.2h4l1.2 1.3H14v7a1 1 0 01-1 1H3a1 1 0 01-1-1z"/><path d="M8 7.6v3.8M6.1 9.5h3.8"/>
  {:else if name === 'settings'}
    <path d="M3 5h5.5M11.5 5H13M3 11h1.5M7.5 11H13"/><circle cx="10" cy="5" r="1.6"/><circle cx="6" cy="11" r="1.6"/>
  {:else if name === 'replace'}
    <circle cx="6.5" cy="6.5" r="3.6"/><path d="M9.2 9.2l3.8 3.8"/>
  {:else if name === 'rename'}
    <path d="M9.8 3.2l3 3L6 13H3v-3z"/><path d="M8.5 4.5l3 3"/>
  {:else if name === 'export'}
    <path d="M8 10V2.5M5.2 5.2L8 2.4l2.8 2.8"/><path d="M3 9.5V13h10V9.5"/>
  {:else if name === 'import'}
    <path d="M8 2.5V10M5.2 7.2L8 10l2.8-2.8"/><path d="M3 9.5V13h10V9.5"/>
  {:else if name === 'open'}
    <path d="M9.5 2.5h4v4M13.5 2.5L8 8"/><path d="M12 9.5v3a1 1 0 01-1 1H3.5a1 1 0 01-1-1V5a1 1 0 011-1h3"/>
  {:else if name === 'example'}
    <path d="M4.5 2.5h7a.5.5 0 01.5.5v10.5L8 11l-4 2.5V3a.5.5 0 01.5-.5z"/>
  {:else if name === 'collection'}
    <path d="M8 2.5L2.5 5.5 8 8.5l5.5-3z"/><path d="M2.5 8.5L8 11.5l5.5-3"/>
  {:else if name === 'collection-add'}
    <path d="M7 2.5L2 5.3l5 2.8 5-2.8z"/><path d="M2 8.4l5 2.8"/><path d="M12 9v4.5M9.8 11.2h4.4"/>
  {:else if name === 'trash'}
    <path d="M2.8 4.5h10.4M6.2 4.5V3h3.6v1.5M4.2 4.5l.6 8.5h6.4l.6-8.5"/>
  {:else if name === 'duplicate'}
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.3"/><path d="M10.5 5.5V3.8a1.3 1.3 0 00-1.3-1.3H3.8a1.3 1.3 0 00-1.3 1.3v5.4a1.3 1.3 0 001.3 1.3h1.7"/>
  {:else if name === 'star'}
    <path d="M8 2.3l1.7 3.5 3.8.5-2.8 2.7.7 3.8L8 11l-3.4 1.8.7-3.8-2.8-2.7 3.8-.5z"/>
  {:else if name === 'copy'}
    <path d="M5 4.5L2 8l3 3.5M11 4.5L14 8l-3 3.5M9.2 3l-2.4 10"/>
  {:else if name === 'play'}
    <path d="M5 3.2v9.6L12.5 8z"/>
  {:else if name === 'lock'}
    <rect x="3.5" y="7" width="9" height="6.5" rx="1.2"/><path d="M5.5 7V5a2.5 2.5 0 015 0v2"/>
  {/if}
</svg>
