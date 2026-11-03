<script lang="ts">
  import { formatSectionBlocks, releaseNoteKind, sectionIntro, stripInlineMarkdown } from '../whatsNew';

  let { body }: { body: string } = $props();

  let blocks = $derived(formatSectionBlocks(body));
  let intro = $derived(blocks.length ? stripInlineMarkdown(sectionIntro(body)) : '');
  let plain = $derived(blocks.length ? [] : String(body || '').split('\n').map(line => stripInlineMarkdown(line.replace(/^#+\s*/, '').trim())).filter(Boolean));
</script>

{#if blocks.length}
  <div class="release-notes">
    {#if intro}
      <p class="release-notes-intro">{intro}</p>
    {/if}
    {#each blocks as block, blockIndex (blockIndex)}
      <section class="release-notes-block">
        {#if block.heading}
          <h3 class="release-notes-heading">
            <span class="release-notes-dot {releaseNoteKind(block.heading)}" aria-hidden="true"></span>
            {block.heading}
          </h3>
        {/if}
        <ul>
          {#each block.items as item, itemIndex (itemIndex)}
            <li>
              {stripInlineMarkdown(item.text)}
              {#if item.children.length}
                <ul class="release-notes-subitems">
                  {#each item.children as child, childIndex (childIndex)}
                    <li>{stripInlineMarkdown(child)}</li>
                  {/each}
                </ul>
              {/if}
            </li>
          {/each}
        </ul>
      </section>
    {/each}
  </div>
{:else if plain.length}
  <div class="release-notes">
    {#each plain as line, lineIndex (lineIndex)}
      <p class="release-notes-plain">{line}</p>
    {/each}
  </div>
{/if}

<style>
  .release-notes {
    display: grid;
    gap: var(--space-4);
    align-content: start;
    -webkit-user-select: text;
    user-select: text;
  }

  .release-notes-heading {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0 0 var(--space-2);
    color: var(--text);
    font-size: var(--text-body);
    font-weight: var(--weight-semibold);
  }

  .release-notes-dot {
    width: 0.375rem;
    height: 0.375rem;
    flex: 0 0 auto;
    border-radius: 50%;
    background: var(--text-3);
  }

  .release-notes-dot.added {
    background: var(--s2xx);
  }

  .release-notes-dot.fixed {
    background: var(--s3xx);
  }

  .release-notes-dot.changed {
    background: var(--s4xx);
  }

  .release-notes-dot.removed {
    background: var(--s5xx);
  }

  ul {
    margin: 0;
    padding: 0 0 0 var(--space-4);
    display: grid;
    gap: var(--space-1-5);
  }

  li {
    color: var(--text-2);
    font-size: var(--text-body);
    line-height: var(--leading-normal);
    overflow-wrap: anywhere;
  }

  li::marker {
    color: var(--text-3);
  }

  .release-notes-subitems {
    margin: var(--space-1-5) 0 0;
    padding-left: var(--space-4);
    gap: var(--space-1);
  }

  .release-notes-subitems li {
    color: var(--text-3);
    font-size: var(--text-label);
  }

  .release-notes-intro {
    margin: 0;
    color: var(--text);
    font-size: var(--text-body);
    line-height: var(--leading-normal);
  }

  .release-notes-plain {
    margin: 0;
    color: var(--text-2);
    font-size: var(--text-body);
    line-height: var(--leading-normal);
  }
</style>
