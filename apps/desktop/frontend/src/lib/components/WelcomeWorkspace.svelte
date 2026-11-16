<script lang="ts">
  import MenuIcon from './MenuIcon.svelte';
  import AddCloseIcon from './AddCloseIcon.svelte';
  import Keycaps from './Keycaps.svelte';
  import KurloBird from './KurloBird.svelte';

  let {
    shortcut = '',
    appRuntime = '',
    workspaceBlocked = false,
    onNewRequest,
    onImport,
    onOpenWorkspace,
    onSetUpAgent,
    onExample,
    onDocumentation,
    onDismiss,
  }: {
    shortcut?: string;
    appRuntime?: string;
    workspaceBlocked?: boolean;
    onNewRequest: () => void;
    onImport: () => void;
    onOpenWorkspace: () => void;
    onSetUpAgent: () => void;
    onExample: () => void;
    onDocumentation: () => void;
    onDismiss: () => void;
  } = $props();
</script>

<section class="welcome-workspace" aria-labelledby="welcome-title">
  <div class="welcome-dismiss">
    <button class="btn btn-ghost btn-sm" type="button" onclick={onDismiss}>Skip for now<AddCloseIcon /></button>
  </div>
  <div class="welcome-content">
    <header class="welcome-heading">
      <div class="welcome-heading-copy">
        <span class="welcome-wordmark" aria-hidden="true">kurlo<span>.</span></span>
        <h1 id="welcome-title">Welcome to Kurlo</h1>
        <p>Start a request or bring your collections with you.</p>
      </div>
      <div class="welcome-illustration" aria-hidden="true">
        <KurloBird mode="still" envelope size="6.5rem" />
      </div>
    </header>
    <div class="welcome-actions">
      <button class="btn welcome-action welcome-action-primary" type="button" onclick={onNewRequest} disabled={workspaceBlocked}>
        <span class="welcome-action-icon"><AddCloseIcon add /></span>
        <span class="welcome-action-copy"><strong>New request</strong><span>Paste a URL or a cURL command</span></span>
        {#if shortcut}<Keycaps combo={shortcut} runtime={appRuntime} />{/if}
        <span class="welcome-arrow" aria-hidden="true">→</span>
      </button>
      <button class="btn welcome-action" type="button" onclick={onImport} disabled={workspaceBlocked}>
        <span class="welcome-action-icon"><MenuIcon name="import" /></span>
        <span class="welcome-action-copy"><strong>Import a collection</strong><span>Postman, Insomnia, Bruno, OpenAPI, HAR or .http</span></span>
        <span class="welcome-arrow" aria-hidden="true">→</span>
      </button>
      <button class="btn welcome-action" type="button" onclick={onOpenWorkspace}>
        <span class="welcome-action-icon"><MenuIcon name="folder" /></span>
        <span class="welcome-action-copy"><strong>Open a workspace</strong><span>Use an existing workspace on your computer</span></span>
        <span class="welcome-arrow" aria-hidden="true">→</span>
      </button>
    </div>
    <div class="welcome-agent">
      <span class="welcome-agent-icon" aria-hidden="true">✧</span>
      <div><strong>Let an agent help</strong><p>Use your model, Claude Code or Codex.</p></div>
      <button class="btn btn-secondary btn-sm" type="button" onclick={onSetUpAgent}>Set up<span aria-hidden="true">→</span></button>
    </div>
    <div class="welcome-links">
      <button class="btn-link" type="button" onclick={onExample} disabled={workspaceBlocked}>Try an example<MenuIcon name="open" /></button>
      <button class="btn-link" type="button" onclick={onDocumentation}>Documentation<MenuIcon name="open" /></button>
    </div>
    <p class="welcome-privacy"><MenuIcon name="lock" />No account. No telemetry. Your data stays local.</p>
  </div>
</section>

<style>
  .welcome-workspace {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    overflow: auto;
  }

  .welcome-dismiss {
    display: flex;
    justify-content: flex-end;
    padding: var(--space-3) var(--space-4) 0;
  }

  .welcome-content {
    width: 100%;
    max-width: 33rem;
    margin: auto;
    padding: var(--space-6) var(--space-8) var(--space-10);
  }

  .welcome-heading {
    display: flex;
    align-items: center;
    gap: var(--space-5);
    margin-bottom: var(--space-6);
  }
  .welcome-heading-copy { flex: 1; min-width: 0; }
  .welcome-illustration {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    padding-bottom: var(--space-2);
  }
  .welcome-illustration :global(.kurlo-bird) { transform: scaleX(-1); }
  .welcome-wordmark {
    display: block;
    margin-bottom: var(--space-5);
    font-size: var(--text-display);
    font-weight: var(--weight-semibold);
    letter-spacing: -0.0625rem;
  }
  .welcome-wordmark > span { color: var(--accent-text); }
  .welcome-heading h1 {
    font-size: var(--text-display);
    line-height: var(--leading-tight);
    letter-spacing: -0.03125rem;
  }
  .welcome-heading p {
    margin-top: var(--space-2);
    color: var(--text-2);
    font-size: var(--text-label);
  }
  .welcome-actions { display: flex; flex-direction: column; gap: var(--space-1); }
  .welcome-action {
    width: 100%;
    height: auto;
    min-height: 4.25rem;
    justify-content: flex-start;
    gap: var(--space-3);
    padding: var(--space-2-5) var(--space-3);
    text-align: left;
    white-space: normal;
  }
  .welcome-action-primary {
    background: color-mix(in srgb, var(--accent) 9%, var(--bg));
    border-color: color-mix(in srgb, var(--accent) 35%, var(--border));
  }
  .welcome-action-primary:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 15%, var(--bg)); }
  .welcome-action-icon {
    display: flex;
    width: 1.6875rem;
    flex-shrink: 0;
    justify-content: center;
    color: var(--text-2);
  }
  .welcome-action-primary .welcome-action-icon { color: var(--accent-text); }
  .welcome-action-copy { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: var(--space-1); }
  .welcome-action-copy strong { color: var(--text); font-size: var(--text-body); font-weight: var(--weight-medium); }
  .welcome-action-copy > span { color: var(--text-3); font-size: var(--text-caption); line-height: var(--leading-normal); }
  .welcome-arrow { color: var(--text-3); }
  .welcome-agent {
    display: flex;
    align-items: center;
    gap: var(--space-2-5);
    margin: var(--space-5) var(--space-3) 0;
    padding-top: var(--space-5);
    border-top: 1px solid var(--border);
  }
  .welcome-agent > div { flex: 1; min-width: 0; }
  .welcome-agent strong { font-size: var(--text-label); font-weight: var(--weight-medium); }
  .welcome-agent p { margin-top: var(--space-1); color: var(--text-3); font-size: var(--text-caption); }
  .welcome-agent-icon { font-size: var(--text-heading); color: var(--text-3); }
  .welcome-links { display: flex; flex-wrap: wrap; gap: var(--space-5); margin: var(--space-6) var(--space-3) 0; }
  .welcome-links .btn-link { display: inline-flex; align-items: center; gap: var(--space-1); }
  .welcome-privacy { display: flex; align-items: center; gap: var(--space-1-5); margin: var(--space-8) var(--space-3) 0; color: var(--text-3); font-size: var(--text-caption); }
  @container workspace (max-width: 30rem) {
    .welcome-content { padding: var(--space-5) var(--space-4) var(--space-6); }
    .welcome-heading { gap: var(--space-3); }
    .welcome-illustration { width: 5rem; }
    .welcome-illustration :global(.kurlo-bird) { max-width: 100%; }
    .welcome-action { gap: var(--space-2); padding-inline: var(--space-2); }
    .welcome-action :global(.keycaps) { display: none; }
    .welcome-agent { margin-inline: var(--space-1); }
  }
</style>
