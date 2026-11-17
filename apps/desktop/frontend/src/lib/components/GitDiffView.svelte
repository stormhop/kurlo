<script lang="ts">
  import VirtualList from './VirtualList.svelte';
  import { GIT_DIFF_VIRTUAL_ROWS, gitDiffItems, type GitDiffItem, type GitDiffRow, type GitDiffSection } from '../gitDiffRows';

  let { sections, expanded = false, ariaLabel }: { sections: GitDiffSection[]; expanded?: boolean; ariaLabel: string } = $props();

  let scroller = $state<HTMLElement | undefined>();
  const rowCount = $derived(sections.reduce((sum, section) => sum + section.rows.length, 0));
  const virtual = $derived(rowCount > GIT_DIFF_VIRTUAL_ROWS);
  const items = $derived(virtual ? gitDiffItems(sections, expanded) : []);

  function fileBlocks(rows: GitDiffRow[]): Array<{ file: string; rows: GitDiffRow[] }> {
    const blocks: Array<{ file: string; rows: GitDiffRow[] }> = [];
    for (const row of rows) {
      if (row.kind === 'file') blocks.push({ file: row.text, rows: [] });
      else if (blocks.length) blocks[blocks.length - 1].rows.push(row);
      else blocks.push({ file: '', rows: [row] });
    }
    return blocks;
  }
</script>

{#snippet diffLine(row: { kind: GitDiffItem['kind']; text: string; line: number | null })}
  {#if row.kind === 'hunk'}
    <div class="git-diff-line hunk"><span class="git-diff-line-no">⋯</span><span class="git-diff-sign"></span><code>{row.text}</code></div>
  {:else if row.kind === 'note'}
    <div class="git-diff-line note"><span class="git-diff-line-no"></span><span class="git-diff-sign"></span><code>{row.text}</code></div>
  {:else}
    <div class="git-diff-line" class:added={row.kind === 'added'} class:removed={row.kind === 'removed'}>
      <span class="git-diff-line-no">{row.line}</span>
      <span class="git-diff-sign" aria-hidden="true">{row.kind === 'added' ? '+' : row.kind === 'removed' ? '−' : ''}</span>
      <code>{row.text || ' '}</code>
    </div>
  {/if}
{/snippet}

{#snippet diffItem(item: GitDiffItem)}
  {#if item.kind === 'section'}
    <div class="git-diff-section-label">{item.text}</div>
  {:else if item.kind === 'file'}
    <div class="git-diff-file flat" class:first={item.first}>{item.text}</div>
  {:else}
    {@render diffLine(item)}
  {/if}
{/snippet}

<div class="git-diff-code" class:expanded bind:this={scroller} role="region" aria-label={ariaLabel}>
  {#if virtual}
    <VirtualList rows={items} row={diffItem} rowHeight={expanded ? 18 : 16.5} {scroller} className="git-diff-virtual" />
  {:else}
    {#each sections as section, sectionIndex (sectionIndex)}
      {#if section.rows.length}
        {#if section.label}<div class="git-diff-section-label">{section.label}</div>{/if}
        {#each fileBlocks(section.rows) as block, blockIndex (blockIndex)}
          <div class="git-diff-file-block">
            {#if block.file}<div class="git-diff-file">{block.file}</div>{/if}
            {#each block.rows as row, index (index)}{@render diffLine(row)}{/each}
          </div>
        {/each}
      {/if}
    {/each}
  {/if}
</div>
