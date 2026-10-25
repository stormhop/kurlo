<script lang="ts">
  import { trapFocus } from '../a11y';
  import type { ChangelogSection } from '../whatsNew';
  import ReleaseNotes from './ReleaseNotes.svelte';
  import { openExternalURL } from '../externalLinks';

  let {
    section,
    onDismiss,
  }: {
    section: ChangelogSection;
    onDismiss: () => void;
  } = $props();

  function formatDate(value: string) {
    if (!value) return '';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return parsed.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  }

  let releaseURL = $derived(`https://github.com/stormhop/kurlo/releases/tag/v${section.version}`);
</script>

<div class="dialog-backdrop" role="presentation" onmousedown={(event) => event.target === event.currentTarget && onDismiss()}>
  <div class="modal whats-new-modal" role="dialog" aria-modal="true" aria-labelledby="whats-new-title" tabindex="-1" use:trapFocus>
    <div class="modal-head dialog-head whats-new-head">
      <div class="whats-new-title-group">
        <h2 class="modal-title" id="whats-new-title">What's new in Kurlo {section.version}</h2>
        {#if section.date}
          <span class="whats-new-date">{formatDate(section.date)}</span>
        {/if}
      </div>
      <button type="button" class="btn btn-ghost btn-icon dialog-close" onclick={onDismiss} aria-label="Close dialog">×</button>
    </div>

    <div class="whats-new-body">
      {#if section.body.trim()}
        <ReleaseNotes body={section.body} />
      {:else}
        <p class="whats-new-empty">This release has no recorded notes.</p>
      {/if}
    </div>

    <div class="modal-foot dialog-actions whats-new-actions">
      <a
        class="whats-new-full-link"
        href={releaseURL}
        onclick={(event) => { event.preventDefault(); openExternalURL(releaseURL); }}
      >
        Full release notes
        <svg width="0.625rem" height="0.625rem" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path d="M3 7l4-4M4 3h3v3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </a>
      <button class="btn btn-primary btn-lg" type="button" onclick={onDismiss} data-autofocus>Got it</button>
    </div>
  </div>
</div>
