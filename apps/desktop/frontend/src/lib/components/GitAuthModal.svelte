<script lang="ts">
  import AddCloseIcon from './AddCloseIcon.svelte';
  import { vm } from '../stores/app.svelte';
  import { openFileDialog } from '../backend';


  let method = $state<'token' | 'ssh'>('token');
  let username = $state('');
  let token = $state('');
  let sshKeyPath = $state('');
  let lastReqKey = $state('');

  $effect(() => {
    const req = vm.gitAuthRequest;
    if (!req) return;
    const key = `${req.host}|${req.scheme}|${req.tokenRejected}`;
    if (key === lastReqKey) return;
    lastReqKey = key;
    method = req.scheme === 'ssh' ? 'ssh' : 'token';
    username = req.defaultUsername || '';
    token = '';
    sshKeyPath = '';
  });

  async function pickKey() {
    const p = await openFileDialog('Select SSH private key');
    if (p) sshKeyPath = p;
  }

  const canSave = $derived(
    method === 'token' ? token.trim().length > 0 : sshKeyPath.trim().length > 0,
  );

  function save() {
    if (!canSave) return;
    if (method === 'token') {
      vm.resolveGitAuth({ kind: 'token', username: username.trim(), token: token.trim() });
    } else {
      vm.resolveGitAuth({ kind: 'ssh', sshKeyPath: sshKeyPath.trim() });
    }
  }
</script>

{#if vm.gitAuthRequest}
  {@const req = vm.gitAuthRequest}
  <div class="gitauth-backdrop" role="presentation" onmousedown={(e) => e.target === e.currentTarget && vm.resolveGitAuth(null)}>
    <div class="modal gitauth-modal" role="dialog" aria-modal="true" aria-labelledby="gitauth-title">
      <div class="modal-head gitauth-head">
        <svg width="1.0625rem" height="1.0625rem" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M5 7V5a3 3 0 016 0v2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
          <rect x="3" y="7" width="10" height="6.5" rx="1.4" stroke="currentColor" stroke-width="1.4"/>
        </svg>
        <h2 class="modal-title" id="gitauth-title">{req.tokenRejected ? 'Token expired — re-authenticate' : 'Private repository — sign in'}</h2>
        <button class="btn btn-ghost btn-icon gitauth-x" type="button" aria-label="Cancel" onclick={() => vm.resolveGitAuth(null)}><AddCloseIcon /></button>
      </div>

      <p class="gitauth-host">
        {req.host || 'remote'} couldn’t be accessed without credentials.
      </p>

      {#if req.tokenRejected}
        <div class="gitauth-warn">Your previous token was rejected — it likely expired or was revoked.</div>
      {/if}

      <div class="segmented gitauth-tabs" role="tablist">
        <button class="segmented-item gitauth-tab" class:active={method === 'token'} type="button" role="tab" aria-selected={method === 'token'} onclick={() => (method = 'token')}>Access token</button>
        <button class="segmented-item gitauth-tab" class:active={method === 'ssh'} type="button" role="tab" aria-selected={method === 'ssh'} onclick={() => (method = 'ssh')}>SSH key</button>
      </div>

      {#if method === 'token'}
        <label class="gitauth-field">
          <span>Username</span>
          <input class="field" type="text" bind:value={username} spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="(provider default)" autocorrect="off" />
        </label>
        <label class="gitauth-field">
          <span>Personal access token</span>
          <input class="field" type="password" bind:value={token} spellcheck="false" autocomplete="off" placeholder="ghp_… / glpat-…" autocorrect="off" autocapitalize="none" />
        </label>
        <p class="gitauth-hint">Stored encrypted in your OS keychain. Never written to the repo, <code>.git/config</code>, or process arguments.</p>
      {:else}
        <div class="gitauth-field">
          <span>SSH private key</span>
          <button class="gitauth-pick" type="button" onclick={pickKey}>
            {sshKeyPath || 'Choose private key file…'}
          </button>
        </div>
        <p class="gitauth-hint">e.g. <code>~/.ssh/id_ed25519</code>. Used only for this workspace. Tip: a key already loaded into <code>ssh-agent</code> works without choosing a file — just retry.</p>
      {/if}

      <div class="modal-foot gitauth-actions">
        <button class="btn btn-secondary" type="button" onclick={() => vm.resolveGitAuth(null)}>Cancel</button>
        <button class="btn btn-primary" type="button" onclick={save} disabled={!canSave}>Save & retry</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .gitauth-backdrop {
    position: fixed; inset: 0; z-index: 210;
    display: grid; place-items: center; padding: var(--space-6);
    background: var(--scrim);
  }
  .gitauth-modal {
    width: 26.25rem; max-width: calc(100vw - 3rem);
    padding: var(--space-4) var(--space-4) var(--space-4);
    color: var(--text);
  }
  .gitauth-head {
    display: flex; align-items: center; margin-bottom: var(--space-1);
  }
  .gitauth-head svg { color: var(--accent-text); flex-shrink: 0; }
  .gitauth-head h2 { margin-right: auto; }
  .gitauth-host { color: var(--text-2); font-size: var(--text-label); line-height: var(--leading-normal); margin: var(--space-0-5) 0 var(--space-2-5); }
  .gitauth-warn {
    font-size: var(--text-caption); color: var(--danger);
    background: var(--danger-bg);
    border: 1px solid var(--danger-border);
    border-radius: var(--radius-md); padding: var(--space-2) var(--space-2-5); margin-bottom: var(--space-2-5);
  }
  .gitauth-tabs { display: inline-flex; margin-bottom: var(--space-3); }
  .gitauth-field { display: flex; flex-direction: column; gap: var(--space-1-5); margin-bottom: var(--space-2-5); }
  .gitauth-field > span { font-size: var(--text-label); font-weight: var(--weight-medium); color: var(--text-2); }
  .gitauth-pick {
    height: 2.125rem; padding: 0 var(--space-2-5); border: 1px dashed var(--border); border-radius: var(--radius-lg);
    background: var(--surface); color: var(--text-2); text-align: left; font-size: var(--text-body);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .gitauth-pick:hover { border-color: var(--accent-hover); color: var(--text); }
  .gitauth-hint { font-size: var(--text-caption); color: var(--text-3); line-height: var(--leading-normal); margin: calc(var(--space-0-5) * -1) 0 var(--space-3); }
  .gitauth-hint code { font-family: var(--font-mono, monospace); font-size: var(--text-caption); }
  .gitauth-actions { display: flex; justify-content: flex-end; }
</style>
