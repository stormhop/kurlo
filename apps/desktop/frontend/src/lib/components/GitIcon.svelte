<script lang="ts">
  import BirdSpinner from './BirdSpinner.svelte';
  type GitIconName =
    | 'archive'
    | 'branch'
    | 'branch-plus'
    | 'check'
    | 'check-square'
    | 'clone'
    | 'commit'
    | 'download'
    | 'edit'
    | 'expand'
    | 'eye'
    | 'fetch'
    | 'folder-open'
    | 'folder-plus'
    | 'force-push'
    | 'hard-drive'
    | 'history'
    | 'init'
    | 'link'
    | 'merge'
    | 'play'
    | 'pull-request'
    | 'pull'
    | 'push'
    | 'rebase'
    | 'refresh'
    | 'save'
    | 'trash'
    | 'x';

  let { name, busy = false, size = 14 }: { name: GitIconName; busy?: boolean; size?: number } = $props();
</script>

{#if busy}
  <BirdSpinner />
{:else}
  <svg class="git-action-icon" width="{size / 16}rem" height="{size / 16}rem" viewBox="0 0 16 16" aria-hidden="true">
    {#if name === 'refresh'}
      <path d="M13 5V2h-3" />
      <path d="M12.3 5A5 5 0 0 0 3.6 3.8" />
      <path d="M3 11v3h3" />
      <path d="M3.7 11A5 5 0 0 0 12.4 12.2" />
    {:else if name === 'fetch'}
      <path d="M8 2v8" />
      <path d="M5 7l3 3 3-3" />
      <path d="M3 13h10" />
    {:else if name === 'pull'}
      <path d="M8 2v8" />
      <path d="M5 7l3 3 3-3" />
      <circle cx="8" cy="13" r="1.5" />
    {:else if name === 'push'}
      <path d="M8 14V6" />
      <path d="M5 9l3-3 3 3" />
      <path d="M3 3h10" />
    {:else if name === 'force-push'}
      <path d="M8 14V6" />
      <path d="M5 9l3-3 3 3" />
      <path d="M3 3h10" />
      <path d="M13 10v2" />
      <path d="M13 14h.01" />
    {:else if name === 'merge'}
      <path d="M4 2v8" />
      <path d="M4 6c0 3 2 4 5 4h3" />
      <path d="M10 7l3 3-3 3" />
      <circle cx="4" cy="3" r="1.4" />
      <circle cx="4" cy="13" r="1.4" />
    {:else if name === 'pull-request'}
      <circle cx="4" cy="3.5" r="1.5" />
      <circle cx="4" cy="12.5" r="1.5" />
      <circle cx="12" cy="12.5" r="1.5" />
      <path d="M4 5v6" />
      <path d="M12 11V6.5a2 2 0 0 0-2-2H7" />
      <path d="M8.5 3 7 4.5 8.5 6" />
    {:else if name === 'rebase'}
      <path d="M5 14V2" />
      <path d="M11 2v12" />
      <path d="M8 5l3-3 3 3" />
      <path d="M2 11l3 3 3-3" />
    {:else if name === 'branch'}
      <path d="M5 3v7" />
      <path d="M5 7h3a3 3 0 0 0 3-3V3" />
      <circle cx="5" cy="3" r="1.6" />
      <circle cx="5" cy="13" r="1.6" />
      <circle cx="11" cy="3" r="1.6" />
    {:else if name === 'branch-plus'}
      <path d="M4 3v8" />
      <path d="M4 7h3a3 3 0 0 0 3-3V3" />
      <circle cx="4" cy="3" r="1.4" />
      <circle cx="4" cy="13" r="1.4" />
      <path d="M11 10v4" />
      <path d="M9 12h4" />
    {:else if name === 'commit'}
      <path d="M2 8h4" />
      <path d="M10 8h4" />
      <circle cx="8" cy="8" r="2.2" />
    {:else if name === 'history'}
      <path d="M4 5H2V3" />
      <path d="M3 5a5 5 0 1 1-.2 5" />
      <path d="M8 5v3l2 1" />
    {:else if name === 'eye'}
      <path d="M1.8 8s2.2-4 6.2-4 6.2 4 6.2 4-2.2 4-6.2 4-6.2-4-6.2-4Z" />
      <circle cx="8" cy="8" r="1.8" />
    {:else if name === 'trash'}
      <path d="M3 4h10" />
      <path d="M6 4V2.8h4V4" />
      <path d="M5 6l.4 7h5.2L11 6" />
      <path d="M7 7.5v4" />
      <path d="M9 7.5v4" />
    {:else if name === 'check-square'}
      <path d="M3 3h10v10H3z" />
      <path d="M5.5 8.2 7.2 10 10.8 6" />
    {:else if name === 'check'}
      <path d="M3 8.5 6.4 12 13 4" />
    {:else if name === 'x'}
      <path d="M4 4l8 8" />
      <path d="M12 4l-8 8" />
    {:else if name === 'play'}
      <path d="M5 3.5v9l7-4.5-7-4.5Z" />
    {:else if name === 'save'}
      <path d="M3 3h8l2 2v8H3z" />
      <path d="M5 3v4h6" />
      <path d="M5 13V9h6v4" />
    {:else if name === 'edit'}
      <path d="M9 3.5 12.5 7l-7 7H2v-3.5l7-7Z" />
      <path d="M8 4.5 11.5 8" />
    {:else if name === 'expand'}
      <path d="M6 3H3v3" />
      <path d="M10 3h3v3" />
      <path d="M6 13H3v-3" />
      <path d="M10 13h3v-3" />
    {:else if name === 'download'}
      <path d="M8 2v8" />
      <path d="M5 7l3 3 3-3" />
      <path d="M3 13h10" />
    {:else if name === 'archive'}
      <path d="M3 4h10v3H3z" />
      <path d="M4 7v6h8V7" />
      <path d="M6.5 9h3" />
    {:else if name === 'folder-plus'}
      <path d="M2 5h5l1.2 1.5H14v6.5H2z" />
      <path d="M8 8.3v3.4" />
      <path d="M6.3 10h3.4" />
    {:else if name === 'folder-open'}
      <path d="M2 6h4.8L8 7.5h6" />
      <path d="M2 12.5 3.2 7.5H14l-1.2 5H2z" />
    {:else if name === 'clone'}
      <path d="M5 5h8v8H5z" />
      <path d="M3 11V3h8" />
    {:else if name === 'init'}
      <path d="M4 13V3" />
      <path d="M4 7h4a3 3 0 0 0 3-3V3" />
      <circle cx="4" cy="13" r="1.4" />
      <path d="M10.5 9v4" />
      <path d="M8.5 11h4" />
    {:else if name === 'link'}
      <path d="M6.8 5.2 8 4a3 3 0 0 1 4.2 4.2l-1.4 1.4" />
      <path d="M9.2 10.8 8 12a3 3 0 0 1-4.2-4.2l1.4-1.4" />
      <path d="M6.5 9.5l3-3" />
    {:else if name === 'hard-drive'}
      <path d="M3 4h10l1 5H2z" />
      <path d="M2 9v3h12V9" />
      <path d="M11.5 11h.01" />
    {/if}
  </svg>
{/if}
