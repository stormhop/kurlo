<script lang="ts">
  import { vm } from '../stores/app.svelte';
  import { AUTH_OPTIONS, OAUTH1_SIGNATURE_OPTIONS } from '../constants';
  import Select from './Select.svelte';
  import { decodeJwt, formatJwtClaimValue, formatJwtNumericDate, jwtClaimRows, jwtHeaderRows, jwtTokenState } from '../jwt';

  let jwtInspectorOpen = $state(false);
  let bearerTokenVisible = $state(false);
  let bearerTokenForJwt = $derived(vm.resolveTemplate(vm.bearerToken, vm.activeEnvironmentValues()));
  let jwtDecoded = $derived(decodeJwt(bearerTokenForJwt));
  let jwtState = $derived(jwtDecoded.ok ? jwtTokenState(jwtDecoded.payload) : null);
  const GRPC_AUTH_OPTIONS = [
    { value: 'apikey', label: 'API key' },
    { value: 'basic', label: 'Basic auth' },
    { value: 'bearer', label: 'Bearer token' },
    { value: 'oauth2', label: 'OAuth 2.0' },
    { value: 'none', label: 'No auth' },
  ] as const;
  let authOptions = $derived(vm.requestType === 'grpc' ? GRPC_AUTH_OPTIONS : AUTH_OPTIONS);
  const OAUTH2_GRANT_OPTIONS = [
    { value: 'client_credentials', label: 'Client credentials' },
    { value: 'authorization_code', label: 'Authorization code' },
    { value: 'device_code', label: 'Device code' },
    { value: 'password', label: 'Password' },
  ];
  const OAUTH2_CLIENT_AUTH_OPTIONS = [
    { value: 'basic', label: 'Send as Basic auth header' },
    { value: 'body', label: 'Send client credentials in body' },
    { value: 'client_secret_jwt', label: 'Client secret JWT (HS256)' },
    { value: 'private_key_jwt', label: 'Private key JWT (RS256 / ES256)' },
  ];

  let oauth1UsesRsa = $derived(vm.oauth1.signatureMethod.startsWith('RSA-'));

  let oauth2ActionLabel = $derived.by(() => {
    switch (vm.oauth2GrantType) {
      case 'authorization_code': return 'Authorize in browser';
      case 'device_code': return vm.oauth2Loading ? 'Waiting for approval…' : 'Start device sign-in';
      default: return 'Get access token';
    }
  });

  let oauth2ExpiryLabel = $derived.by(() => {
    if (!vm.oauth2TokenExpiry) return '';
    const ms = vm.oauth2TokenExpiry - Date.now();
    if (ms <= 0) return 'Token expired — it will refresh on the next send';
    const minutes = Math.round(ms / 60000);
    if (minutes >= 60) return `Expires in ~${Math.round(minutes / 60)}h`;
    if (minutes >= 1) return `Expires in ~${minutes}m`;
    return 'Expires in <1m';
  });

  function selectInputText(event: MouseEvent) {
    const target = event.currentTarget;
    if (target instanceof HTMLInputElement) target.select();
  }
</script>

<div class="auth-section">
  <div class="auth-type-column">
    <span class="field-label">Auth type</span>
    <div class="auth-select">
      <button class="field select-trigger auth-select-trigger" type="button" onclick={vm.toggleAuthMenu} aria-label="Auth type" aria-expanded={vm.authMenuOpen}>
        <span>{vm.authLabel()}</span>
        <svg width="0.625rem" height="0.4375rem" viewBox="0 0 10 7" fill="none" aria-hidden="true">
          <path d="M1.5 2L5 5.5L8.5 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </button>
      {#if vm.authMenuOpen}
        <div class="menu auth-select-menu" class:grpc-auth-menu={vm.requestType === 'grpc'}>
          {#each authOptions as option, eachIndex (eachIndex)}
            <button class="menu-item" class:active={vm.authType === option.value} class:auth-option-separated={vm.requestType === 'grpc' && option.value === 'none'} type="button" onclick={() => vm.selectAuthType(option.value)}>
              {#if vm.authType === option.value}<span class="auth-check">✓</span>{:else}<span class="auth-check"></span>{/if}
              <span>{option.label}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </div>
  <div class="auth-fields">
    {#if vm.authType === 'bearer'}
      <label class="field-label" for="bearer-token">Token</label>
      <div class="bearer-token-row">
        <div class="bearer-token-input-wrap">
          <input id="bearer-token" class="field field-input field-mono" type={bearerTokenVisible ? 'text' : 'password'} bind:value={vm.bearerToken} placeholder="Enter bearer token" spellcheck="false" />
          <button
            class="btn btn-ghost btn-icon btn-xs token-visibility-btn"
            type="button"
            aria-label={bearerTokenVisible ? 'Hide token' : 'Show token'}
            aria-pressed={bearerTokenVisible}
            title={bearerTokenVisible ? 'Hide token' : 'Show token'}
            onclick={() => (bearerTokenVisible = !bearerTokenVisible)}
          >
            {#if bearerTokenVisible}
              <svg width="0.9375rem" height="0.9375rem" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M2 2l12 12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
                <path d="M6.2 6.4a2.1 2.1 0 002.9 2.9M9.4 5.1A2.1 2.1 0 0111 7.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
                <path d="M6.9 3.4A7.5 7.5 0 018 3.3c3.4 0 5.7 2.5 6.5 3.7a1.2 1.2 0 010 1.3 10.6 10.6 0 01-1.6 1.8M4.6 4.3A10.8 10.8 0 001.5 7a1.2 1.2 0 000 1.3c.8 1.2 3.1 3.7 6.5 3.7a7.4 7.4 0 003-.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            {:else}
              <svg width="0.9375rem" height="0.9375rem" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M1.5 7.2C2.3 6 4.6 3.5 8 3.5s5.7 2.5 6.5 3.7a1.2 1.2 0 010 1.3c-.8 1.2-3.1 3.7-6.5 3.7S2.3 9.7 1.5 8.5a1.2 1.2 0 010-1.3z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
                <path d="M8 9.8a2.1 2.1 0 100-4.2 2.1 2.1 0 000 4.2z" stroke="currentColor" stroke-width="1.4"/>
              </svg>
            {/if}
          </button>
        </div>
        <button class="btn btn-secondary" type="button" onclick={() => (jwtInspectorOpen = !jwtInspectorOpen)}>
          {jwtInspectorOpen ? 'Hide' : 'Decode'}
        </button>
      </div>
      {#if jwtInspectorOpen}
        <div class="jwt-inspector" class:jwt-inspector-error={!jwtDecoded.ok}>
          {#if jwtDecoded.ok}
            <div class="jwt-inspector-top">
              <span class="tag tag-accent jwt-badge">JWT</span>
              {#if jwtState}
                <span class="tag jwt-state" class:tag-success={jwtState.state !== 'expired' && jwtState.state !== 'not-yet-valid'} class:tag-danger={jwtState.state === 'expired' || jwtState.state === 'not-yet-valid'} class:expired={jwtState.state === 'expired'} class:not-yet-valid={jwtState.state === 'not-yet-valid'}>{jwtState.label}</span>
              {/if}
              <span class="jwt-note">Signature not verified</span>
            </div>
            <div class="jwt-sections">
              <section class="jwt-section">
                <h3>Header</h3>
                <div class="jwt-claims">
                  {#each jwtHeaderRows(jwtDecoded.header) as [key, value], eachIndex (eachIndex)}
                    <div class="jwt-claim-row">
                      <span class="jwt-claim-key">{key}</span>
                      <span class="jwt-claim-value">{formatJwtClaimValue(value)}</span>
                    </div>
                  {/each}
                </div>
              </section>
              <section class="jwt-section">
                <h3>Claims</h3>
                <div class="jwt-claims">
                  {#each jwtClaimRows(jwtDecoded.payload) as [key, value], eachIndex (eachIndex)}
                    <div class="jwt-claim-row">
                      <span class="jwt-claim-key">{key}</span>
                      <span class="jwt-claim-value">
                        {formatJwtClaimValue(value)}
                        {#if formatJwtNumericDate(key, value)}
                          <small>{formatJwtNumericDate(key, value)}</small>
                        {/if}
                      </span>
                    </div>
                  {/each}
                </div>
              </section>
            </div>
          {:else}
            <div class="jwt-error-message">{jwtDecoded.error}</div>
          {/if}
        </div>
      {/if}

    {:else if vm.authType === 'basic' || vm.authType === 'digest'}
      <label class="field-label" for="auth-user">Username</label>
      <input id="auth-user" class="field field-input" bind:value={vm.basicUser} placeholder="Enter username" spellcheck="false" />
      <label class="field-label" for="auth-pass">Password</label>
      <input id="auth-pass" class="field field-input" bind:value={vm.basicPass} type="password" placeholder="Enter password" />

    {:else if vm.authType === 'apikey'}
      <label class="field-label" for="apikey-name">Key name</label>
      <input id="apikey-name" class="field field-input" bind:value={vm.apiKeyName} placeholder="e.g. X-API-Key" spellcheck="false" />
      <label class="field-label" for="apikey-val">Key value</label>
      <input id="apikey-val" class="field field-input field-mono" type="password" bind:value={vm.apiKeyValue} placeholder="Enter value" spellcheck="false" />
      <span class="field-label">Add to</span>
      <div class="segmented radio-group" role="radiogroup">
        {#if vm.requestType === 'grpc'}
          <label class="segmented-item radio-label"><input type="radio" bind:group={vm.apiKeyIn} value="header" /> Metadata</label>
        {:else}
          <label class="segmented-item radio-label"><input type="radio" bind:group={vm.apiKeyIn} value="header" /> Header</label>
          <label class="segmented-item radio-label"><input type="radio" bind:group={vm.apiKeyIn} value="query" /> Query string</label>
        {/if}
      </div>

    {:else if vm.authType === 'oauth2'}
      <span class="field-label">Grant type</span>
      <Select bind:value={vm.oauth2GrantType} options={OAUTH2_GRANT_OPTIONS} className="auth-field-select" ariaLabel="Grant type" />
      {#if vm.oauth2GrantType === 'authorization_code'}
        <label class="field-label" for="oauth2-auth-url">Authorization URL</label>
        <input id="oauth2-auth-url" class="field field-input" bind:value={vm.oauth2AuthURL} placeholder="https://auth.example.com/oauth/authorize" spellcheck="false" />
      {/if}
      {#if vm.oauth2GrantType === 'device_code'}
        <label class="field-label" for="oauth2-device-url">Device authorization URL</label>
        <input id="oauth2-device-url" class="field field-input" bind:value={vm.oauth2DeviceAuthURL} placeholder="https://auth.example.com/oauth/device/code" spellcheck="false" />
      {/if}
      <label class="field-label" for="oauth2-url">Token URL</label>
      <input id="oauth2-url" class="field field-input" bind:value={vm.oauth2TokenURL} placeholder="https://auth.example.com/oauth/token" spellcheck="false" />
      {#if vm.oauth2GrantType === 'password'}
        <div class="auth-grid-2">
          <div>
            <label class="field-label" for="oauth2-username">Username</label>
            <input id="oauth2-username" class="field field-input" bind:value={vm.oauth2Username} spellcheck="false" />
          </div>
          <div>
            <label class="field-label" for="oauth2-password">Password</label>
            <input id="oauth2-password" class="field field-input" bind:value={vm.oauth2Password} type="password" />
          </div>
        </div>
      {/if}
      <label class="field-label" for="oauth2-id">Client ID</label>
      <input id="oauth2-id" class="field field-input" bind:value={vm.oauth2ClientID} spellcheck="false" />
      <span class="field-label">Client authentication</span>
      <Select bind:value={vm.oauth2ClientAuth} options={OAUTH2_CLIENT_AUTH_OPTIONS} className="auth-field-select" ariaLabel="Client authentication method" />
      {#if vm.oauth2ClientAuth !== 'private_key_jwt'}
        <label class="field-label" for="oauth2-secret">Client secret{#if vm.oauth2GrantType === 'authorization_code'} <span class="field-label-hint">(optional with PKCE)</span>{/if}</label>
        <input id="oauth2-secret" class="field field-input" bind:value={vm.oauth2Secret} type="password" />
      {/if}
      {#if vm.oauth2ClientAuth === 'private_key_jwt'}
        <label class="field-label" for="oauth2-private-key">Private key (PEM) <span class="field-label-hint">— accepts a {'{{variable}}'} so it can live in workspace secrets</span></label>
        <textarea id="oauth2-private-key" class="field field-input field-mono oauth2-key-input" bind:value={vm.oauth2AssertionPrivateKey} placeholder="-----BEGIN PRIVATE KEY-----" spellcheck="false"></textarea>
        <div class="auth-grid-2">
          <div>
            <label class="field-label" for="oauth2-kid">Key ID <span class="field-label-hint">(optional)</span></label>
            <input id="oauth2-kid" class="field field-input field-mono" bind:value={vm.oauth2AssertionKeyID} spellcheck="false" />
          </div>
          <div>
            <label class="field-label" for="oauth2-alg">Algorithm <span class="field-label-hint">(auto)</span></label>
            <input id="oauth2-alg" class="field field-input field-mono" bind:value={vm.oauth2AssertionAlgorithm} placeholder="RS256" spellcheck="false" />
          </div>
        </div>
      {/if}
      {#if vm.oauth2ClientAuth === 'client_secret_jwt' || vm.oauth2ClientAuth === 'private_key_jwt'}
        <label class="field-label" for="oauth2-assertion-aud">Assertion audience <span class="field-label-hint">(defaults to the token URL)</span></label>
        <input id="oauth2-assertion-aud" class="field field-input" bind:value={vm.oauth2AssertionAudience} placeholder="https://auth.example.com/oauth/token" spellcheck="false" />
      {/if}
      <label class="field-label" for="oauth2-scope">Scope</label>
      <input id="oauth2-scope" class="field field-input" bind:value={vm.oauth2Scope} placeholder="e.g. read write" spellcheck="false" />
      <label class="field-label" for="oauth2-audience">Audience <span class="field-label-hint">(optional — required by some providers)</span></label>
      <input id="oauth2-audience" class="field field-input" bind:value={vm.oauth2Audience} placeholder="https://api.example.com" spellcheck="false" />
      {#if vm.oauth2GrantType === 'authorization_code'}
        <label class="check-label oauth2-pkce-row"><input class="check" type="checkbox" bind:checked={vm.oauth2UsePKCE} /> Use PKCE (recommended)</label>
      {/if}
      {#if vm.oauth2DevicePrompt}
        <div class="oauth2-device-prompt">
          <p class="oauth2-device-lead">Sign in on another device, then enter this code:</p>
          <output class="oauth2-device-code">{vm.oauth2DevicePrompt.userCode}</output>
          <p class="oauth2-device-uri">{vm.oauth2DevicePrompt.verificationUri}</p>
        </div>
      {/if}
      <div class="oauth2-token-row">
        <button class="btn btn-secondary" type="button" disabled={vm.oauth2Loading} onclick={vm.fetchOAuth2Token}>
          {#if vm.oauth2Loading}<span class="spinner-sm"></span>{/if}
          {oauth2ActionLabel}
        </button>
        {#if vm.oauth2RefreshToken}
          <button class="btn btn-secondary" type="button" disabled={vm.oauth2Loading} onclick={vm.refreshOAuth2Token}>Refresh token</button>
        {/if}
        {#if vm.oauth2Token}<span class="oauth2-token-badge">Token acquired ✓</span>{/if}
      </div>
      {#if vm.oauth2Token}
        <span class="field-label">Current token</span>
        <input class="field field-input field-mono" type="password" readonly value={vm.oauth2Token} onclick={selectInputText} />
        {#if oauth2ExpiryLabel}<span class="oauth2-expiry-hint">{oauth2ExpiryLabel}</span>{/if}
      {/if}

    {:else if vm.authType === 'oauth1'}
      <div class="auth-grid-2">
        <div>
          <span class="field-label">Signature method</span>
          <Select bind:value={vm.oauth1.signatureMethod} options={OAUTH1_SIGNATURE_OPTIONS} className="auth-field-select" ariaLabel="Signature method" />
        </div>
        <div>
          <span class="field-label">Add parameters to</span>
          <div class="segmented radio-group" role="radiogroup" aria-label="Add OAuth 1.0 parameters to">
            <label class="segmented-item radio-label"><input type="radio" bind:group={vm.oauth1.addTo} value="header" /> Header</label>
            <label class="segmented-item radio-label"><input type="radio" bind:group={vm.oauth1.addTo} value="query" /> Query</label>
            <label class="segmented-item radio-label"><input type="radio" bind:group={vm.oauth1.addTo} value="body" /> Body</label>
          </div>
        </div>
        <div>
          <label class="field-label" for="oauth1-consumer-key">Consumer key</label>
          <input id="oauth1-consumer-key" class="field field-input field-mono" bind:value={vm.oauth1.consumerKey} spellcheck="false" />
        </div>
        {#if !oauth1UsesRsa}
          <div>
            <label class="field-label" for="oauth1-consumer-secret">Consumer secret</label>
            <input id="oauth1-consumer-secret" class="field field-input field-mono" bind:value={vm.oauth1.consumerSecret} type="password" />
          </div>
        {/if}
        {#if oauth1UsesRsa}
          <div class="auth-grid-span">
            <label class="field-label" for="oauth1-private-key">Private key (PEM) <span class="field-label-hint">— accepts a {'{{variable}}'} so it can live in workspace secrets</span></label>
            <textarea id="oauth1-private-key" class="field field-input field-mono oauth2-key-input" bind:value={vm.oauth1.privateKey} placeholder="-----BEGIN PRIVATE KEY-----" spellcheck="false"></textarea>
          </div>
        {/if}
        <div>
          <label class="field-label" for="oauth1-token">Access token <span class="field-label-hint">(optional)</span></label>
          <input id="oauth1-token" class="field field-input field-mono" bind:value={vm.oauth1.token} type="password" />
        </div>
        {#if !oauth1UsesRsa}
          <div>
            <label class="field-label" for="oauth1-token-secret">Token secret <span class="field-label-hint">(optional)</span></label>
            <input id="oauth1-token-secret" class="field field-input field-mono" bind:value={vm.oauth1.tokenSecret} type="password" />
          </div>
        {/if}
      </div>
      <details class="oauth1-advanced">
        <summary class="field-label">Advanced</summary>
        <div class="auth-grid-2">
          <div>
            <label class="field-label" for="oauth1-realm">Realm</label>
            <input id="oauth1-realm" class="field field-input" bind:value={vm.oauth1.realm} spellcheck="false" />
          </div>
          <div>
            <label class="field-label" for="oauth1-callback">Callback URL</label>
            <input id="oauth1-callback" class="field field-input" bind:value={vm.oauth1.callback} placeholder="https://example.com/callback" spellcheck="false" />
          </div>
          <div>
            <label class="field-label" for="oauth1-verifier">Verifier</label>
            <input id="oauth1-verifier" class="field field-input field-mono" bind:value={vm.oauth1.verifier} spellcheck="false" />
          </div>
          <div>
            <label class="field-label" for="oauth1-version">Version</label>
            <input id="oauth1-version" class="field field-input field-mono" bind:value={vm.oauth1.version} placeholder="1.0" spellcheck="false" />
          </div>
          <div>
            <label class="field-label" for="oauth1-timestamp">Timestamp</label>
            <input id="oauth1-timestamp" class="field field-input field-mono" bind:value={vm.oauth1.timestamp} placeholder="Generated on send" spellcheck="false" />
          </div>
          <div>
            <label class="field-label" for="oauth1-nonce">Nonce</label>
            <input id="oauth1-nonce" class="field field-input field-mono" bind:value={vm.oauth1.nonce} placeholder="Generated on send" spellcheck="false" />
          </div>
        </div>
        <div class="oauth1-checks">
          <label class="check-label"><input class="check" type="checkbox" bind:checked={vm.oauth1.includeBodyHash} /> Include body hash <span class="field-label-hint">(oauth_body_hash)</span></label>
          <label class="check-label"><input class="check" type="checkbox" bind:checked={vm.oauth1.addEmptyParams} /> Sign empty parameters</label>
        </div>
      </details>

    {:else if vm.authType === 'aws'}
      <div class="auth-grid-2">
        <div>
          <label class="field-label" for="aws-key">Access key ID</label>
          <input id="aws-key" class="field field-input field-mono" bind:value={vm.awsAccessKey} spellcheck="false" />
        </div>
        <div>
          <label class="field-label" for="aws-secret">Secret access key</label>
          <input id="aws-secret" class="field field-input field-mono" bind:value={vm.awsSecretKey} type="password" />
        </div>
        <div class="auth-grid-span">
          <label class="field-label" for="aws-session-token">Session token <span class="field-label-hint">(temporary credentials from STS / SSO)</span></label>
          <input id="aws-session-token" class="field field-input field-mono" bind:value={vm.awsSessionToken} type="password" />
        </div>
        <div>
          <label class="field-label" for="aws-region">Region</label>
          <input id="aws-region" class="field field-input" bind:value={vm.awsRegion} placeholder="us-east-1" spellcheck="false" />
        </div>
        <div>
          <label class="field-label" for="aws-service">Service</label>
          <input id="aws-service" class="field field-input" bind:value={vm.awsService} placeholder="execute-api" spellcheck="false" />
        </div>
      </div>

    {:else}
      <p class="auth-none-hint">No authentication will be added to this request.</p>
    {/if}
  </div>
</div>
