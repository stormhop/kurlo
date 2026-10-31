<script lang="ts">
  import type { UpdateInfo } from '../backend';
  import type { SavedRequest, ShortcutId } from '../types/models';
  import { requestSupportsCurl, requestTabLabel } from '../utils';
  import { buildPaletteCommands } from '../commandPalette';
  import { vm } from '../stores/app.svelte';
  import { appLazyComponents as lazy } from '../stores/lazyComponents.svelte';
  import AppDialog from './AppDialog.svelte';
  import GitAuthModal from './GitAuthModal.svelte';
  import FindReplaceModal from './FindReplaceModal.svelte';
  import MissingSecretsModal from './MissingSecretsModal.svelte';
  import WorkspaceYAMLEditor from './WorkspaceYAMLEditor.svelte';

  type Props = {
    startupUpdateInfo: UpdateInfo | null;
    startupUpdateReady: boolean;
    autoUpdateInstall: boolean;
    autoUpdateInstalling: boolean;
    setAutoUpdateInstall: (value: boolean) => void;
    appRuntime: string;
    onUpdateInstalled: (info: UpdateInfo) => void;
    whatsNewAvailable: boolean;
    onShowWhatsNew: () => void;
  };

  let {
    startupUpdateInfo,
    startupUpdateReady,
    autoUpdateInstall,
    autoUpdateInstalling,
    setAutoUpdateInstall,
    appRuntime,
    onUpdateInstalled,
    whatsNewAvailable,
    onShowWhatsNew,
  }: Props = $props();

  let paletteCommands = $derived(vm.globalSearchOpen ? buildPaletteCommands({
    hasActiveRequest: vm.topView === 'request' && Boolean(vm.activeRequest),
    canCopyCurl: Boolean(vm.activeRequest && requestSupportsCurl(vm.activeRequest)),
    autosave: vm.autosave,
    codePanelAvailable: vm.codePanelAvailable,
    codePanelOpen: vm.codePanelOpen,
    sidebarHidden: vm.sidebarHidden,
    responseLayout: vm.responseLayout,
    themeMode: vm.appTheme.mode,
    whatsNewAvailable,
    showSidebarView: (view) => {
      vm.sidebarView = view;
      vm.sidebarHidden = false;
    },
    openGlobals: () => vm.openGlobals(),
    openCollectionRunner: () => vm.openCollectionRunner(),
    openMockServer: () => vm.openMockServerTab(),
    openGit: () => vm.openGitTab(),
    openCookies: () => vm.openCookieJar(),
    openSettings: (tab) => vm.openSettings(tab),
    runShortcut: (id) => vm.runShortcut(id),
    createRequest: (type) => vm.createNewRequest(undefined, type),
    createCollection: () => vm.createCollection(),
    createEnvironment: () => vm.createEnvironment(),
    importCollection: vm.openPostmanImport,
    copyCurl: () => vm.copyRequestCurl(vm.activeRequestId),
    findReplaceInCollection: vm.activeRequest && !vm.activeRequest.isDraft
      ? () => { if (vm.activeRequest) void vm.openFindReplace(vm.activeRequest.collectionId, vm.activeRequest.folderPath ?? []); }
      : undefined,
    setResponseLayout: (layout) => vm.setResponseLayout(layout),
    setThemeMode: (mode) => vm.setThemeMode(mode),
    showWhatsNew: onShowWhatsNew,
  }) : []);
</script>

{#if vm.findReplaceScope}
  <FindReplaceModal
    scopeLabel={vm.findReplaceScopeLabel()}
    requests={vm.findReplaceRequests()}
    unsavedIds={vm.findReplaceUnsavedIds()}
    undo={vm.findReplaceUndo}
    requestLabel={requestTabLabel}
    onApply={vm.applyFindReplace}
    onUndo={vm.undoFindReplace}
    onOpenRequest={(id: string) => { vm.closeFindReplace(); vm.switchRequest(id); }}
    onClose={vm.closeFindReplace}
  />
{/if}

{#if vm.missingSecrets.length}
  <MissingSecretsModal
    secrets={vm.missingSecrets}
    values={vm.missingSecretValues}
    saving={vm.missingSecretsSaving}
    error={vm.missingSecretsError}
    context={{ requests: vm.requests, collections: vm.collections, environments: vm.environments, workspaces: vm.workspaces, cookies: vm.cookies }}
    onUpdate={vm.updateMissingSecretValue}
    onSave={vm.saveMissingSecrets}
    onDismiss={vm.dismissMissingSecretsWizard}
  />
{/if}

{#if vm.settingsOpen}
  {#if lazy.SettingsModalComponent}
    <lazy.SettingsModalComponent
      bind:settingsTab={vm.settingsTab}
      {whatsNewAvailable}
      {onShowWhatsNew}
      shortcutCaptureMessage={vm.shortcutCaptureMessage}
      shortcutEditingId={vm.shortcutEditingId}
      {appRuntime}
      appTheme={vm.appTheme}
      autosave={vm.autosave}
      startupView={vm.startupView}
      setStartupView={vm.setStartupView}
      scriptEngine={vm.scriptEngine}
      setScriptEngine={vm.setScriptEngine}
      shortcutGroups={vm.shortcutGroups}
      shortcutCombo={vm.shortcutCombo}
      startShortcutCapture={vm.startShortcutCapture}
      resetShortcut={vm.resetShortcut}
      resetAllShortcuts={vm.resetAllShortcuts}
      setThemeMode={vm.setThemeMode}
      setThemeVariant={vm.setThemeVariant}
      proxyConfig={vm.proxyConfig}
      setProxyConfig={vm.setProxyConfig}
      setAutosave={vm.setAutosave}
      defaultWorkspaceLocationDraft={vm.defaultWorkspaceLocationDraft}
      defaultWorkspaceLocationStatus={vm.defaultWorkspaceLocationStatus}
      setDefaultWorkspaceLocationDraft={vm.setDefaultWorkspaceLocationDraft}
      saveDefaultWorkspaceLocation={vm.saveDefaultWorkspaceLocation}
      browseDefaultWorkspaceLocation={vm.browseDefaultWorkspaceLocation}
      exportAllData={vm.exportAllData}
      importAllData={vm.importAllData}
      dataTransferStatus={vm.dataTransferStatus}
      onClose={vm.closeSettings}
      {startupUpdateInfo}
      {startupUpdateReady}
      {autoUpdateInstall}
      {autoUpdateInstalling}
      {setAutoUpdateInstall}
      {onUpdateInstalled}
    />
  {/if}
{/if}

{#if vm.globalSearchOpen}
  {#if lazy.GlobalSearchModalComponent}
    <lazy.GlobalSearchModalComponent
      bind:query={vm.globalSearchQuery}
      results={vm.globalSearchResults}
      commands={paletteCommands}
      shortcutCombo={(id: ShortcutId) => vm.shortcutCombo(id)}
      activeRequestId={vm.activeRequestId}
      {requestTabLabel}
      collectionLabel={(request: SavedRequest) => vm.collectionNameById(request.collectionId) || request.collection}
      {appRuntime}
      onSwitchRequest={vm.switchRequest}
      onClose={vm.closeGlobalSearch}
    />
  {/if}
{/if}

{#if vm.cookieJarOpen}
  {#if lazy.CookieJarModalComponent}
    <lazy.CookieJarModalComponent
      cookies={vm.cookies}
      loading={vm.cookieJarLoading}
      saving={vm.cookieJarSaving}
      error={vm.cookieJarError}
      defaultDomain={vm.cookieJarDefaultDomain}
      onRefresh={vm.refreshCookieJar}
      onSave={vm.saveCookie}
      onDelete={vm.removeCookie}
      onClear={vm.clearCookieJar}
      onClose={vm.closeCookieJar}
      sync={vm.cookieSync}
      syncUnreadable={vm.cookieSyncUnreadableDomains()}
      syncBusy={vm.cookieSyncBusy}
      syncError={vm.cookieSyncError}
      syncCodeCopied={vm.cookieSyncCodeCopied}
      onToggleSync={vm.toggleCookieSync}
      onAddSyncDomain={vm.addCookieSyncDomain}
      onRemoveSyncDomain={vm.removeCookieSyncDomain}
      onRevokeSync={vm.revokeCookieSyncBrowser}
      onApproveSync={vm.approveCookieSyncBrowser}
      onDenySync={vm.denyCookieSyncBrowser}
      onCopySyncCode={vm.copyCookieSyncPairingCode}
      onSyncPortChange={(port: number) => (vm.cookieSyncPort = port)}
    />
  {/if}
{/if}

{#if vm.yamlEditorOpen}
  <WorkspaceYAMLEditor />
{/if}

{#if vm.appDialog}
  <AppDialog
    dialog={vm.appDialog}
    bind:inputValue={vm.dialogInputValue}
    bind:selectOpen={vm.dialogSelectOpen}
    onCancel={vm.cancelDialog}
    onDismiss={vm.dismissDialog}
    onAlt={vm.altDialog}
    onSubmit={vm.submitDialog}
    onInputKeydown={vm.onDialogKeydown}
    onSelectKeydown={vm.onDialogSelectKeydown}
    selectLabel={vm.dialogSelectLabel}
    onChooseOption={vm.chooseDialogOption}
  />
{/if}

<GitAuthModal />
