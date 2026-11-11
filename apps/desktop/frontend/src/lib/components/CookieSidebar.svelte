<script lang="ts">
  import AddCloseIcon from './AddCloseIcon.svelte';
  import { vm } from '../stores/app.svelte';
  import { buildCookieDomainGroups, cookieValueIsMissingSecret, normalizeCookieDomain } from '../cookieJar';
  import { cookieCountLabel, cookieSyncShortLabel, cookieSyncState, resolveCookieDomainGroup } from '../cookieSync';
  import { cookieView, selectCookieDomain, selectCookieSync, syncCookieViewWorkspace } from '../stores/cookieView.svelte';

  let { workspaceBlocked }: { workspaceBlocked: boolean } = $props();

  const DOMAIN_STEP = 200;

  let addingDomain = $state(false);
  let newDomainInput = $state('');
  let addError = $state('');
  let domainLimit = $state(DOMAIN_STEP);

  $effect(() => {
    syncCookieViewWorkspace(vm.activeWorkspaceId);
  });

  let allGroups = $derived(buildCookieDomainGroups(vm.cookies, cookieView.manualDomains));
  let groups = $derived(buildCookieDomainGroups(vm.cookies, cookieView.manualDomains, cookieView.filter));
  let visibleGroups = $derived(groups.slice(0, domainLimit));
  let openRequestDomain = $derived(normalizeCookieDomain(vm.cookieJarDefaultDomain));
  let currentDomain = $derived(resolveCookieDomainGroup(allGroups, cookieView.domain, openRequestDomain)?.domain ?? '');
  let onCookiesPage = $derived(vm.topView === 'cookies');
  let syncState = $derived(cookieSyncState(vm.cookieSync));

  function openDomain(domain: string) {
    selectCookieDomain(domain);
    void vm.openCookieJar('domains');
  }

  function openSync() {
    selectCookieSync();
    void vm.openCookieJar('sync');
  }

  function startAddingDomain() {
    addError = '';
    addingDomain = true;
    newDomainInput = openRequestDomain && !allGroups.some(group => group.domain === openRequestDomain) ? openRequestDomain : '';
  }

  function stopAddingDomain() {
    addingDomain = false;
    newDomainInput = '';
    addError = '';
  }

  function addDomain() {
    const domain = normalizeCookieDomain(newDomainInput);
    if (!domain) {
      addError = 'Enter a domain name first.';
      return;
    }
    cookieView.manualDomains = [...new Set([...cookieView.manualDomains, domain])];
    cookieView.filter = '';
    cookieView.newCookieFor = domain;
    stopAddingDomain();
    openDomain(domain);
  }

  function focusOnMount(node: HTMLElement) {
    queueMicrotask(() => node.focus());
  }

  function domainDetail(cookies: { value: string }[]): string {
    if (!cookies.length) return 'No cookies yet';
    const missing = cookies.some(cookie => cookieValueIsMissingSecret(cookie.value));
    return `${cookieCountLabel(cookies.length)}${missing ? ' · some without a value' : ''}`;
  }
</script>

<div class="environment-panel cookie-panel">
  <div class="collections-head">
    <span>Cookies</span>
    <button class="btn btn-ghost btn-icon btn-sm collection-add" type="button" onclick={startAddingDomain} aria-label="Add domain" disabled={workspaceBlocked}><AddCloseIcon add /></button>
  </div>

  <button
    class="environment-globals-item cookie-sync-item"
    class:active={onCookiesPage && cookieView.section === 'sync'}
    type="button"
    onclick={openSync}
    disabled={workspaceBlocked}
  >
    <span class="environment-dot cookie-sync-dot" data-state={syncState} aria-hidden="true"></span>
    <span class="environment-item-text">
      <span>Browser sync</span>
      <small>{cookieSyncShortLabel(vm.cookieSync)}</small>
    </span>
  </button>

  {#if addingDomain}
    <div class="cookie-domain-new">
      <input
        class="field field-sm"
        bind:value={newDomainInput}
        placeholder="example.com"
        spellcheck="false"
        aria-label="New domain"
        use:focusOnMount
        onkeydown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); addDomain(); }
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); stopAddingDomain(); }
        }}
      />
      {#if addError}<span class="cookie-domain-new-error" role="alert">{addError}</span>{/if}
      <div class="cookie-domain-new-actions">
        <button class="btn btn-ghost btn-sm" type="button" onclick={stopAddingDomain}>Cancel</button>
        <button class="btn btn-primary btn-sm" type="button" onclick={addDomain}>Add</button>
      </div>
    </div>
  {/if}

  {#if allGroups.length}
    <div class="field field-md field-wrap sidebar-search">
      <svg width="0.75rem" height="0.75rem" viewBox="0 0 13 13" fill="none" aria-hidden="true">
        <circle cx="5.8" cy="5.8" r="3.8" stroke="currentColor" stroke-width="1.3"/>
        <path d="M8.7 8.7l2.7 2.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
      </svg>
      <input bind:value={cookieView.filter} placeholder="Filter domains" aria-label="Filter domains" spellcheck="false" />
    </div>
  {/if}

  {#if allGroups.length}
    <div class="environment-list cookie-domain-list" role="list" aria-label="Cookie domains">
      {#each visibleGroups as group (group.domain)}
        {@const active = onCookiesPage && cookieView.section === 'domains' && currentDomain === group.domain}
        <div class="environment-item cookie-domain-item" class:active role="listitem">
          <button class="environment-item-main" type="button" aria-current={active ? 'page' : undefined} onclick={() => openDomain(group.domain)} disabled={workspaceBlocked}>
            <span class="environment-dot cookie-domain-dot" class:warning={group.cookies.some(cookie => cookieValueIsMissingSecret(cookie.value))} class:empty={!group.cookies.length} aria-hidden="true"></span>
            <span class="environment-item-text">
              <span>{group.domain}</span>
              <small>{domainDetail(group.cookies)}</small>
            </span>
          </button>
        </div>
      {:else}
        <p class="cookie-domain-none">No domains match “{cookieView.filter}”.</p>
      {/each}
      {#if groups.length > visibleGroups.length}
        <button class="btn btn-ghost btn-sm cookie-domain-more" type="button" onclick={() => (domainLimit += DOMAIN_STEP)}>
          Show {Math.min(DOMAIN_STEP, groups.length - visibleGroups.length)} more of {groups.length}
        </button>
      {/if}
    </div>
  {:else if !addingDomain}
    <p class="cookie-domain-none">No domains yet. Cookies show up here after a response sets one.</p>
  {/if}
</div>
