<script lang="ts">
  import AddCloseIcon from './AddCloseIcon.svelte';
  import { trapFocus } from '../a11y';
  import type { ChangelogSection } from '../whatsNew';
  import ReleaseNotes from './ReleaseNotes.svelte';
  import { openExternalURL } from '../externalLinks';
  import { normalizeVersion } from '../whatsNew';
  import AgentGlyph from './AgentGlyph.svelte';
  import KurloGlyph from './KurloGlyph.svelte';

  let {
    section,
    onDismiss,
    spotlight = false,
    onTryAgent,
  }: {
    section: ChangelogSection;
    onDismiss: () => void;
    spotlight?: boolean;
    onTryAgent?: () => void;
  } = $props();

  const agents = [
    { id: 'kurlo', name: 'Kurlo agent', text: 'Any model: OpenRouter, your own key, or Ollama and LM Studio on this computer.' },
    { id: 'claude-code', name: 'Claude Code', text: 'The CLI you already use, signed in with your Claude plan.' },
    { id: 'codex', name: 'Codex', text: 'The CLI you already use, signed in with your ChatGPT plan.' },
  ];

  function formatDate(value: string) {
    if (!value) return '';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return parsed.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  }

  let releaseURL = $derived(`https://github.com/stormhop/kurlo/releases/tag/v${normalizeVersion(section.version)}`);

  function onWindowKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault();
      onDismiss();
    }
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div class="dialog-backdrop" role="presentation" onmousedown={(event) => event.target === event.currentTarget && onDismiss()}>
  {#if spotlight}
    <div class="modal whats-new-modal agent-spotlight" role="dialog" aria-modal="true" aria-labelledby="agent-spotlight-title" tabindex="-1" use:trapFocus>
      <button type="button" class="btn btn-ghost btn-icon dialog-close agent-spotlight-close" onclick={onDismiss} aria-label="Close dialog"><AddCloseIcon /></button>
      <div class="whats-new-body agent-spotlight-body">
        <div class="agent-spotlight-hero">
          <span class="agent-spotlight-badge">New in Kurlo {section.version}</span>
          <h2 class="agent-spotlight-title" id="agent-spotlight-title">Meet Agent mode</h2>
          <p class="agent-spotlight-lead">Ask in plain words. The agent runs your requests, explains failures and writes tests, and every change waits for your Apply.</p>
        </div>
        <ul class="agent-spotlight-agents" aria-label="Agents">
          {#each agents as agent (agent.id)}
            <li>
              <span class="agent-spotlight-glyph agent-spotlight-glyph-{agent.id}" aria-hidden="true">
                {#if agent.id === 'kurlo'}<KurloGlyph size="1.125rem" />{:else}<AgentGlyph driver={agent.id} size="1.125rem" />{/if}
              </span>
              <span class="agent-spotlight-agent"><b>{agent.name}</b><span>{agent.text}</span></span>
            </li>
          {/each}
        </ul>
        <p class="agent-spotlight-note">Secrets reach the model only as <code>[secret]</code>, protected environments stay off limits, and chats stay on this computer.</p>
        {#if section.body.trim()}
          <details class="agent-spotlight-notes">
            <summary>All changes in {section.version}</summary>
            <ReleaseNotes body={section.body} />
          </details>
        {/if}
      </div>
      <div class="modal-foot dialog-actions whats-new-actions">
        <button class="btn btn-ghost" type="button" onclick={onDismiss}>Later</button>
        <button class="btn btn-primary btn-lg" type="button" onclick={onTryAgent} data-autofocus>Try Agent mode</button>
      </div>
    </div>
  {:else}
    <div class="modal whats-new-modal" role="dialog" aria-modal="true" aria-labelledby="whats-new-title" tabindex="-1" use:trapFocus>
      <div class="modal-head dialog-head whats-new-head">
        <div class="whats-new-title-group">
          <h2 class="modal-title" id="whats-new-title">What's new in Kurlo {section.version}</h2>
          {#if section.date}
            <span class="whats-new-date">{formatDate(section.date)}</span>
          {/if}
        </div>
        <button type="button" class="btn btn-ghost btn-icon dialog-close" onclick={onDismiss} aria-label="Close dialog"><AddCloseIcon /></button>
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
  {/if}
</div>
