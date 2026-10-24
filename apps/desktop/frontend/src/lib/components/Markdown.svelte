<script lang="ts">
  import { openExternalURL } from '../externalLinks';
  import { parseMarkdown, type MdBlock, type MdInline } from '../markdown';
  import { untrack } from 'svelte';
  import { clipboardCopy } from '../utils';

  const LIVE_PARSE_MS = 120;

  let { source, remoteImages = false, compact = false, live = false }: { source: string; remoteImages?: boolean; compact?: boolean; live?: boolean } = $props();

  let liveSource = $state(untrack(() => source));
  let lastParse = 0;
  $effect(() => {
    const next = source;
    if (!live) {
      liveSource = next;
      return;
    }
    const wait = LIVE_PARSE_MS - (Date.now() - lastParse);
    if (wait <= 0) {
      lastParse = Date.now();
      liveSource = next;
      return;
    }
    const timer = setTimeout(() => {
      lastParse = Date.now();
      liveSource = next;
    }, wait);
    return () => clearTimeout(timer);
  });
  const blocks = $derived(parseMarkdown(live ? liveSource : source));
  let copiedIndex = $state('');

  function openLink(event: MouseEvent, href: string) {
    event.preventDefault();
    openExternalURL(href);
  }

  async function copyCode(key: string, text: string) {
    await clipboardCopy(text);
    copiedIndex = key;
    setTimeout(() => {
      if (copiedIndex === key) copiedIndex = '';
    }, 1200);
  }

  function showsImage(src: string) {
    return remoteImages || src.startsWith('data:');
  }
</script>

{#snippet inline(nodes: MdInline[])}
  {#each nodes as node, index (index)}
    {#if node.type === 'text'}{node.text}{:else if node.type === 'strong'}<strong>{@render inline(node.children)}</strong>{:else if node.type === 'em'}<em>{@render inline(node.children)}</em>{:else if node.type === 'del'}<del>{@render inline(node.children)}</del>{:else if node.type === 'code'}<code class="md-code">{node.text}</code>{:else if node.type === 'link'}<a class="md-link" href={node.href} title={node.href} onclick={(event) => openLink(event, node.href)}>{@render inline(node.children)}</a>{:else if node.type === 'image'}{#if showsImage(node.src)}<img class="md-image" src={node.src} alt={node.alt} loading="lazy" />{:else}<a class="md-link" href={node.src} title={node.src} onclick={(event) => openLink(event, node.src)}>{node.alt || 'Image'}</a>{/if}{:else if node.type === 'break'}<br />{/if}
  {/each}
{/snippet}

{#snippet blockList(items: MdBlock[], path: string)}
  {#each items as block, index (index)}
    {@const key = `${path}.${index}`}
    {#if block.type === 'heading'}
      <svelte:element this={`h${Math.min(block.level + 1, 6)}`} class="md-heading md-h{block.level}">{@render inline(block.children)}</svelte:element>
    {:else if block.type === 'paragraph'}
      <p>{@render inline(block.children)}</p>
    {:else if block.type === 'code'}
      <div class="md-pre">
        <div class="md-pre-head">
          <span>{block.lang || 'code'}</span>
          <button class="btn btn-ghost btn-xs" type="button" onclick={() => copyCode(key, block.text)}>{copiedIndex === key ? 'Copied' : 'Copy'}</button>
        </div>
        <pre><code>{block.text}</code></pre>
      </div>
    {:else if block.type === 'list'}
      <svelte:element this={block.ordered ? 'ol' : 'ul'} class="md-list" start={block.ordered && block.start !== 1 ? block.start : undefined}>
        {#each block.items as item, itemIndex (itemIndex)}
          <li class:md-task={item.checked !== null}>
            {#if item.checked !== null}<input class="check" type="checkbox" checked={item.checked} disabled aria-label={item.checked ? 'Done' : 'Not done'} />{/if}
            {@render blockList(item.children, `${key}.${itemIndex}`)}
          </li>
        {/each}
      </svelte:element>
    {:else if block.type === 'quote'}
      <blockquote>{@render blockList(block.children, key)}</blockquote>
    {:else if block.type === 'table'}
      <div class="md-table-wrap">
        <table>
          <thead>
            <tr>
              {#each block.head as cell, cellIndex (cellIndex)}
                <th style:text-align={block.align[cellIndex] || null}>{@render inline(cell)}</th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each block.rows as row, rowIndex (rowIndex)}
              <tr>
                {#each row as cell, cellIndex (cellIndex)}
                  <td style:text-align={block.align[cellIndex] || null}>{@render inline(cell)}</td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else if block.type === 'hr'}
      <hr />
    {/if}
  {/each}
{/snippet}

<div class="md" class:md-compact={compact}>
  {@render blockList(blocks, 'b')}
</div>

<style>
  .md {
    color: var(--text);
    font-family: var(--font-ui);
    font-size: var(--text-body);
    line-height: var(--leading-relaxed);
    overflow-wrap: anywhere;
    user-select: text;
  }
  .md > :global(:first-child),
  .md :global(li > :first-child),
  .md :global(blockquote > :first-child) {
    margin-top: 0;
  }
  .md > :global(:last-child),
  .md :global(li > :last-child),
  .md :global(blockquote > :last-child) {
    margin-bottom: 0;
  }
  .md p {
    margin: 0 0 var(--space-3);
  }
  .md-heading {
    margin: var(--space-5) 0 var(--space-2);
    color: var(--text);
    font-weight: var(--weight-semibold);
    line-height: var(--leading-tight);
  }
  .md-h1 {
    font-size: var(--text-display);
  }
  .md-h2 {
    font-size: var(--text-heading);
  }
  .md-h3 {
    font-size: var(--text-title);
  }
  .md-h4,
  .md-h5,
  .md-h6 {
    font-size: var(--text-body);
  }
  .md-compact .md-h1,
  .md-compact .md-h2 {
    font-size: var(--text-title);
  }
  .md-compact .md-heading {
    margin-top: var(--space-4);
  }
  .md-code {
    padding: 0 var(--space-1);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-xs);
    background: var(--elevated);
    font-family: var(--font-mono);
    font-size: 0.92em;
  }
  .md-link {
    color: var(--accent);
    text-decoration: none;
    cursor: pointer;
  }
  .md-link:hover {
    text-decoration: underline;
  }
  .md-image {
    display: block;
    max-width: 100%;
    max-height: 28rem;
    margin: var(--space-2) 0;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
  }
  .md-pre {
    margin: 0 0 var(--space-3);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--surface);
    overflow: hidden;
  }
  .md-pre-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    padding: var(--space-0-5) var(--space-1) var(--space-0-5) var(--space-3);
    border-bottom: 1px solid var(--border-subtle);
    color: var(--text-3);
    font-family: var(--font-mono);
    font-size: var(--text-caption);
    user-select: none;
  }
  .md pre {
    margin: 0;
    padding: var(--space-2-5) var(--space-3);
    overflow: auto;
    max-height: 32rem;
    color: var(--text);
    font-family: var(--font-mono);
    font-size: var(--text-code);
    line-height: var(--leading-relaxed);
    white-space: pre;
    overflow-wrap: normal;
  }
  .md-list {
    margin: 0 0 var(--space-3);
    padding-left: var(--space-5);
  }
  .md-list :global(.md-list) {
    margin-bottom: 0;
  }
  .md li + li {
    margin-top: var(--space-1);
  }
  .md li::marker {
    color: var(--text-3);
  }
  .md-task {
    list-style: none;
    margin-left: calc(-1 * var(--space-5));
    display: flex;
    gap: var(--space-2);
    align-items: baseline;
  }
  .md blockquote {
    margin: 0 0 var(--space-3);
    padding-left: var(--space-3);
    border-left: 2px solid var(--border);
    color: var(--text-2);
  }
  .md-table-wrap {
    margin: 0 0 var(--space-3);
    overflow-x: auto;
  }
  .md table {
    border-collapse: collapse;
    font-size: var(--text-label);
  }
  .md th,
  .md td {
    padding: var(--space-1-5) var(--space-3);
    border: 1px solid var(--border-subtle);
    text-align: left;
    vertical-align: top;
  }
  .md th {
    background: var(--elevated);
    font-weight: var(--weight-semibold);
  }
  .md hr {
    margin: var(--space-4) 0;
    border: 0;
    border-top: 1px solid var(--border-subtle);
  }
</style>
