<script lang="ts">
  import type { AgentChatSummary, UpdateInfo } from '../backend';
  import { agentStore, codexAgentStore, claudeAgentStore, agentModeFor, agentNavigation, agentStoreFor } from '../stores/agent.svelte';
  import type { SavedRequest, ShortcutId } from '../types/models';
  import { requestSupportsCurl, requestTabLabel } from '../utils';
  import { buildPaletteCommands } from '../commandPalette';
  import { vm } from '../stores/app.svelte';
  import { appLazyComponents as lazy } from '../stores/lazyComponents.svelte';
  import AppDialog from './AppDialog.svelte';
  import GitAuthModal from './GitAuthModal.svelte';
  import FindReplaceModal from './FindReplaceModal.svelte';
  import MissingSecretsModal from './MissingSecretsModal.svelte';
  import OpenApiReviewModal from './OpenApiReviewModal.svelte';
  import WorkspaceYAMLEditor from './WorkspaceYAMLEditor.svelte';

  $effect(() => {
    if (!vm.globalSearchOpen) return;
    void agentStore.refreshChats();
    void codexAgentStore.refreshChats();
    void claudeAgentStore.refreshChats();
  });

  function openChat(chat: AgentChatSummary) {
    vm.openAgentTab();
    agentNavigation.mode = agentModeFor(chat.driver);
    void agentStoreFor(agentNavigation.mode).openChat(chat.id);
  }

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

{#if vm.openApiReview}
  <OpenApiReviewModal
    review={vm.openApiReview}
    collectionName={vm.collections.find(collection => collection.id === vm.openApiReview?.collectionId)?.name ?? 'Collection'}
    onSelection={vm.setOpenApiReviewSelection}
    onApply={() => void vm.applyOpenApiReview('selected')}
    onAcceptAll={() => void vm.applyOpenApiReview('all')}
    onSkip={vm.skipOpenApiReview}
    onClose={vm.closeOpenApiReview}
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
      autosaveDelayMs={vm.autosaveDelayMs}
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
      setAutosaveDelay={vm.setAutosaveDelay}
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
      chats={[...agentStore.chats, ...codexAgentStore.chats, ...claudeAgentStore.chats].filter(chat => !chat.archivedAt).sort((a, b) => b.updatedAt - a.updatedAt)}
      onOpenChat={openChat}
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
