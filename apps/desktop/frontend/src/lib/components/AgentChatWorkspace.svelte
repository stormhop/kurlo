<script lang="ts">
  import BirdSpinner from './BirdSpinner.svelte';
  import AddCloseIcon from './AddCloseIcon.svelte';
  import { autoSizeTextarea } from '../textareaSizing';
  import { agentEffortChoice, agentEffortToStore } from '../agent';
  import { onMount, tick } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import VirtualAgentHistory from './VirtualAgentHistory.svelte';
  import Markdown from './Markdown.svelte';
  import Select from './Select.svelte';
  import { environmentColorVar } from '../environmentColors';
  import Disclosure from './Disclosure.svelte';
  import MenuIcon from './MenuIcon.svelte';
  import { agentNotesEditor } from '../stores/agentNotes.svelte';
  import { focusFirstMenuItem, handleMenuKeydown } from '../menuKeyboard';
  import AgentApprovalCard from './AgentApprovalCard.svelte';
  import AgentAttachmentViewer from './AgentAttachmentViewer.svelte';
  import AgentPicker from './AgentPicker.svelte';
  import { vm } from '../stores/app.svelte';
  import { rem } from '../uiScale';
  import { shellLayout } from '../shellLayout.svelte';
  import { agentNavigation, agentStore as defaultAgentStore, toggleAgentDetails, type AgentStore } from '../stores/agent.svelte';
  import { codexConnectionStore } from '../stores/codex.svelte';
  import { claudeConnectionStore } from '../stores/claude.svelte';
  import { aiConnectionsStore } from '../stores/aiConnections.svelte';
  import { gitPullRequestUrl, startOpenRouterConnect, type AgentApproval, type AgentAttachment, type AiBlock } from '../backend';
  import { openExternalURL } from '../externalLinks';
  import { AI_PROMPT_MAX_CHARS, aiComposerSends, aiErrorView, aiConnectionProblem, type AiStepView } from '../stores/features/ai';
  import { AGENT_STARTERS, AGENT_TEMPLATES, AGENT_WRITE_TOOLS, agentEffortLabel, agentStepSummary, agentTurnSegments, agentContextPercent, agentQuotaWindows, agentFindRequest, agentTemplatePlaceholder, agentToolLabel, agentToolTarget, agentTurnAnswer, agentTurnsFromMessages, type AgentTemplate, type AgentToolTarget, type AgentTurnView } from '../agent';
  import { agentWorkspaceNotes, clipboardSet, openDirectoryDialog, openFileDialog } from '../backend';

  let { workspaceBlocked = false, agentStore = defaultAgentStore, codexReady = false }: { workspaceBlocked?: boolean; agentStore?: AgentStore; codexReady?: boolean } = $props();

  let scroller = $state<HTMLDivElement>();
  let workspaceElement = $state<HTMLDivElement>();
  let detailsCover = $state(false);
  let pullRequestBusy = $state(false);
  let pullRequestError = $state('');
  let wasRunning = false;

  async function openPullRequest() {
    pullRequestBusy = true;
    pullRequestError = '';
    try {
      const result = await gitPullRequestUrl();
      if (result.url) openExternalURL(result.url);
      else pullRequestError = result.error || 'Kurlo could not build a pull request link.';
    } finally {
      pullRequestBusy = false;
    }
  }

  $effect(() => {
    const running = agentStore.running;
    if (wasRunning && !running) void vm.refreshGitQuietly();
    wasRunning = running;
  });
  let detailsPanel = $state<HTMLElement>();
  let stickToBottom = $state(true);
  let retrying = $state(false);
  let copiedKey = $state('');
  let templatesOpen = $state(false);
  let composerInput = $state<HTMLTextAreaElement>();
  let composerBox = $state<HTMLDivElement>();
  let selectingContext = $state(false);
  const attachmentLimit = 4;
  const attachmentDisabled = $derived(workspaceBlocked || agentStore.running || selectingContext);

  $effect(() => {
    const box = composerBox;
    const runtime = window.runtime;
    if (!box || !runtime?.OnFileDrop) return;
    runtime.OnFileDrop((x, y, paths) => {
      if (attachmentDisabled || !box.contains(document.elementFromPoint(x, y))) return;
      addAttachments(paths);
    }, true);
    return () => runtime.OnFileDropOff?.();
  });
  let templatesMenu = $state<HTMLDivElement>();
  let composerContext = $state<HTMLDivElement>();
  let composerActions = $state<HTMLDivElement>();
  let composerBar = $state<HTMLDivElement>();
  let composerCompact = $state(false);
  let composerTight = $state(false);
  let contextMin = $state(0);
  let compactNeed = 0;

  function contentWidth(container: HTMLElement): number {
    const items = ([...container.children] as HTMLElement[]).filter(item => getComputedStyle(item).position !== 'absolute');
    const gap = Number.parseFloat(getComputedStyle(container).columnGap) || 0;
    return items.reduce((total, item) => total + item.getBoundingClientRect().width, 0) + gap * Math.max(0, items.length - 1);
  }

  function labelDeficit(chip: HTMLElement): number {
    const label = chip.querySelector<HTMLElement>('.app-select-trigger > span');
    if (!label) return 0;
    const width = chip.getBoundingClientRect().width;
    const natural = Math.min(width - label.clientWidth + label.scrollWidth, Number.parseFloat(getComputedStyle(chip).maxWidth) || Infinity);
    return Math.max(0, natural - width);
  }

  function measureComposer() {
    const bar = composerBar;
    const context = composerContext;
    const actions = composerActions;
    if (!bar || !context || !actions) return;
    if (composerCompact) {
      if (bar.clientWidth >= compactNeed) {
        composerCompact = false;
        composerTight = false;
        contextMin = 0;
        return;
      }
      const next = Math.ceil(contentWidth(context));
      if (Math.abs(next - contextMin) > 1) {
        contextMin = next;
        void tick().then(measureComposer);
      }
      const style = getComputedStyle(bar);
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const inner = bar.clientWidth - (Number.parseFloat(style.paddingLeft) || 0) - (Number.parseFloat(style.paddingRight) || 0);
      const picker = actions.querySelector<HTMLElement>('.agent-picker');
      const actionsMin = contentWidth(actions) - (picker ? picker.getBoundingClientRect().width - 4 * rem : 0);
      const tight = next + actionsMin + (Number.parseFloat(style.columnGap) || 0) > inner + 1;
      if (tight !== composerTight) composerTight = tight;
      return;
    }
    let deficit = 0;
    for (const chip of bar.querySelectorAll<HTMLElement>('.agent-composer-chip')) deficit += labelDeficit(chip);
    deficit += Math.max(0, contentWidth(context) - context.clientWidth);
    deficit += Math.max(0, contentWidth(actions) - actions.clientWidth);
    if (deficit > 1) {
      compactNeed = bar.clientWidth + deficit;
      composerCompact = true;
      void tick().then(measureComposer);
    }
  }

  $effect(() => {
    const bar = composerBar;
    if (!bar) return;
    const observer = new ResizeObserver(() => measureComposer());
    observer.observe(bar);
    return () => observer.disconnect();
  });

  $effect(() => {
    void collectionLabel;
    void environmentLabel;
    void modeLabel;
    void vm.gitStatus.isRepo;
    void agentStore.driver;
    composerCompact = false;
    composerTight = false;
    contextMin = 0;
    void tick().then(measureComposer);
  });
  let titleDraft = $state('');
  const titlePlaceholder = 'Untitled chat';
  let attachmentError = $state('');
  let openAttachment = $state<AgentAttachment>();
  let titleError = $state('');
  let titleInput = $state<HTMLInputElement>();
  let history = $state<{ captureAnchor: () => void }>();
  let lastChatId = '';
  const openTools = new SvelteSet<string>();
  const openThinking = new SvelteSet<string>();
  const NO_AUTOCORRECT: Record<string, string> = { autocorrect: 'off' };

  const connections = $derived(aiConnectionsStore.list);
  const needsConnection = $derived(!agentStore.driver && aiConnectionsStore.loaded && codexConnectionStore.loaded && connections.length === 0 && !codexReady);
  const starters = AGENT_STARTERS.map(id => AGENT_TEMPLATES.find(template => template.id === id)).filter((template): template is AgentTemplate => Boolean(template));
  const starterLabels: Record<string, string> = { debug: 'Explain failure', check: 'Check collection', tests: 'Write tests', cover: 'Cover endpoint' };
  const persisted = $derived<AgentTurnView[]>(agentStore.activeChat && agentStore.activeChat.id === agentStore.activeChatId ? agentTurnsFromMessages(agentStore.activeChat.messages, '', agentStore.activeChat.messageOffset ?? 0) : []);
  const live = $derived(agentStore.liveInActiveChat ? agentStore.live : null);
  const draftAttachments = $derived(live && agentStore.liveAttachments.length ? [] : agentStore.attachmentPaths);
  const persistedRows = $derived(persisted.map(turn => ({ ...turn, live: false })));
  const turns = $derived.by<Array<AgentTurnView & { live: boolean }>>(() => {
    if (!live) return persistedRows;
    const chat = chatLoaded ? agentStore.activeChat : null;
    const nextMessage = chat?.messageCount ?? (chat?.messageOffset ?? 0) + (chat?.messages.length ?? 0);
    return [...persistedRows, { id: `:${nextMessage}`, prompt: live.prompt, attachments: agentStore.liveAttachments, steps: live.steps, live: true }];
  });
  const notes = $derived(agentStore.notes && agentStore.notes.chatId === agentStore.activeChatId ? agentStore.notes : null);
  const lastPersisted = $derived(persisted.at(-1) ?? null);
  const activeSummary = $derived(agentStore.chats.find(chat => chat.id === agentStore.activeChatId));
  const archived = $derived(Boolean(activeSummary ? activeSummary.archivedAt : (agentStore.activeChat?.id === agentStore.activeChatId && agentStore.activeChat?.archivedAt)));
  const canRetry = $derived(!archived && !agentStore.running && Boolean((lastPersisted && (!agentTurnAnswer(lastPersisted.steps) || notes?.error)) || (notes?.error && agentStore.draft.trim())));
  const approvals = $derived(agentStore.activeApprovals);
  const chatLoaded = $derived(Boolean(agentStore.activeChat && agentStore.activeChat.id === agentStore.activeChatId));
  const chatSaved = $derived(Boolean(agentStore.activeChatId));
  const title = $derived(chatLoaded ? agentStore.activeChat?.title ?? '' : agentStore.chats.find(chat => chat.id === agentStore.activeChatId)?.title ?? '');
  const usage = $derived(agentStore.activeChat && agentStore.activeChat.id === agentStore.activeChatId ? agentStore.usage : null);
  const liveContext = $derived(agentStore.running && agentStore.context?.chatId === agentStore.activeChatId ? agentStore.context : null);
  const driverModels = $derived(agentStore.driver === 'codex' ? codexConnectionStore.status.models : agentStore.driver === 'claude-code' ? claudeConnectionStore.status.models : []);
  const driverModelId = $derived(agentStore.driver === 'codex' ? codexConnectionStore.status.model : agentStore.driver === 'claude-code' ? claudeConnectionStore.status.model : '');
  const savedContext = $derived(agentStore.driver === 'claude-code' || agentStore.activeChat?.model === (agentStore.model || driverModelId) ? agentStore.activeChat : null);
  const contextTokens = $derived(liveContext?.tokens ?? savedContext?.contextTokens ?? 0);
  const contextWindow = $derived(liveContext?.window ?? savedContext?.contextWindow ?? 0);
  const contextPercent = $derived(agentContextPercent(contextTokens, contextWindow));
  const checkingCodex = $derived(agentStore.driver === 'codex' && codexConnectionStore.checking);
  const quotaWindows = $derived(agentQuotaWindows((agentStore.driver === 'codex' ? codexConnectionStore.status.rateLimits : agentStore.driver === 'claude-code' ? claudeConnectionStore.status.rateLimits : []) ?? []));
  const planName = $derived(agentStore.driver === 'claude-code' ? 'Claude' : 'Codex');
  const headerAgent = $derived.by(() => {
    if (agentStore.driver === 'claude-code') {
      const id = agentStore.activeChat?.model || agentStore.model || claudeConnectionStore.status.model;
      const name = id ? claudeConnectionStore.modelName(id) : '';
      return name ? `Claude Code · ${name}` : 'Claude Code';
    }
    if (agentStore.driver === 'codex') {
      const id = agentStore.activeChat?.model || agentStore.model || codexConnectionStore.status.model;
      const name = codexConnectionStore.status.models.find(model => model.id === id)?.name || id;
      return name ? `Codex · ${name}` : 'Codex';
    }
    const connection = connections.find(item => item.id === (agentStore.activeChat?.connectionId || agentStore.connectionId)) ?? aiConnectionsStore.defaultConnection;
    const chosen = (agentStore.activeChat?.id === agentStore.activeChatId ? agentStore.activeChat?.model : '') || agentStore.model || connection?.model;
    return connection ? `${connection.label} · ${chosen || 'default model'}` : 'Kurlo agent';
  });
  const selectedEnvironment = $derived(vm.activeWorkspaceEnvironments.find(environment => environment.name === agentStore.environment));
  const environmentProtected = $derived(Boolean(selectedEnvironment?.protected));
  const environmentColor = $derived(environmentColorVar(selectedEnvironment));
  const contextRuns = $derived.by(() => turns.flatMap(turn => turn.steps.flatMap(step => step.blocks.filter(block => block.type === 'tool_use' && (block.name === 'run_request' || block.name === 'send_request')).flatMap(block => {
    const result = step.toolResults.find(item => item.id === block.id);
    if (!result) return [];
    const summary = agentStepSummary(block, result);
    return [{ method: summary.detail.split(' ')[0] || 'REQ', name: summary.target || summary.detail || agentToolLabel(block.name), status: summary.status }];
  }))).slice(-6));
  const contextChanges = $derived.by(() => {
    const waiting = approvals.flatMap(approval => approval.kind === 'write' && approval.changes.length ? approval.changes.map(change => ({ name: change.path, label: '', waiting: true })) : [{ name: approval.tool, label: '', waiting: true }]);
    const done = turns.flatMap(turn => turn.steps.flatMap(step => step.blocks.filter(block => block.type === 'tool_use' && AGENT_WRITE_TOOLS.includes(block.name ?? '')).flatMap(block => {
      const result = step.toolResults.find(item => item.id === block.id);
      if (!result || result.isError) return [];
      const summary = agentStepSummary(block, result);
      return [{ name: summary.target || agentToolLabel(block.name), label: agentToolLabel(block.name).toLowerCase(), waiting: false }];
    })));
    return [...done.slice(-6), ...waiting];
  });
  const tightestQuota = $derived(quotaWindows.reduce<(typeof quotaWindows)[number] | null>((low, window) => !low || window.remaining < low.remaining ? window : low, null));
  const selectedCodexDefaultEffort = $derived(driverModels.find(model => model.id === (agentStore.activeChat?.model || agentStore.model || driverModelId))?.defaultEffort ?? '');
  const effortModel = $derived(driverModels.find(model => model.id === (agentStore.model || driverModelId)));
  const effortValues = $derived(effortModel?.efforts ?? []);
  const effortOptions = $derived(effortValues.map(value => ({ value, label: agentEffortLabel(value) })));
  const effortChoice = $derived(agentEffortChoice(agentStore.effort, effortValues, effortModel?.defaultEffort ?? ''));
  const runningElsewhere = $derived(agentStore.running && !agentStore.liveInActiveChat);
  const modeOptions = [
    { value: 'ask', label: 'Ask always' },
    { value: '', label: 'Ask for changes' },
    { value: 'auto', label: 'Auto' },
  ];
  const AGENT_BUDGET_MAX_TOKENS = 1_000_000_000;
  const AGENT_BUDGET_MAX_REQUESTS = 100_000;
  const modeLabel = $derived(modeOptions.find(option => option.value === agentStore.mode)?.label ?? 'Ask for changes');
  const requestsSent = $derived(agentStore.activeChat?.id === agentStore.activeChatId ? agentStore.activeChat?.requestsSent ?? 0 : 0);
  const contextSummary = $derived(`${agentStore.collection || 'Any collection'} · ${agentStore.environment || 'No environment'}`);
  const permissionsSummary = $derived(agentStore.mode === 'ask' ? modeLabel : `${modeLabel} · ${agentStore.allowedHosts.length} ${agentStore.allowedHosts.length === 1 ? 'host' : 'hosts'}`);
  const budgetSummary = $derived.by(() => {
    const parts: string[] = [];
    if (agentStore.budgetTokens) parts.push(`${formatTokens(chatTokens)} / ${formatTokens(agentStore.budgetTokens)}`);
    if (agentStore.budgetRequests) parts.push(`${requestsSent} / ${agentStore.budgetRequests} req`);
    return parts.join(' · ') || 'No limit';
  });
  const gitSummary = $derived(agentStore.ownBranch ? `${vm.gitStatus.branch || 'None'} · agent branch` : vm.gitStatus.branch || 'None');
  const usageSummary = $derived(usage ? [`${formatTokens(usage.input + usage.output + usage.cacheRead + usage.cacheWrite)} tokens`, usage.cost ? formatCost(usage.cost) : ''].filter(Boolean).join(' · ') : '');
  const changesSummary = $derived.by(() => {
    const waiting = contextChanges.filter(change => change.waiting).length;
    return waiting ? `${waiting} waiting` : String(contextChanges.length);
  });
  function digitsOnly(event: Event & { currentTarget: HTMLInputElement }) {
    const clean = event.currentTarget.value.replace(/\D+/g, '');
    if (clean !== event.currentTarget.value) event.currentTarget.value = clean;
  }
  const modeNote = $derived(agentStore.mode === 'ask'
    ? 'Only reading runs on its own. Every request and change waits for you.'
    : agentStore.mode === 'auto'
      ? 'Requests and workspace changes run on their own. Unsafe requests to other hosts and git push still wait for you.'
      : 'Reads and GET requests run on their own. Changes and unsafe requests wait for you.');
  let hostsDraft = $derived(agentStore.allowedHosts.join(', '));
  function commitHosts() {
    agentStore.allowedHosts = hostsDraft.split(/[\s,]+/).map(host => host.trim()).filter(Boolean);
  }
  function budgetValue(value: string, limit: number): number {
    const parsed = Number.parseInt(value.replace(/\D+/g, ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, limit) : 0;
  }
  function commitTokenBudget(event: Event & { currentTarget: HTMLInputElement }) {
    agentStore.budgetTokens = budgetValue(event.currentTarget.value, AGENT_BUDGET_MAX_TOKENS);
    event.currentTarget.value = agentStore.budgetTokens ? String(agentStore.budgetTokens) : '';
  }
  function commitRequestBudget(event: Event & { currentTarget: HTMLInputElement }) {
    agentStore.budgetRequests = budgetValue(event.currentTarget.value, AGENT_BUDGET_MAX_REQUESTS);
    event.currentTarget.value = agentStore.budgetRequests ? String(agentStore.budgetRequests) : '';
  }
  const chatTokens = $derived(usage ? usage.input + usage.output + usage.cacheRead + usage.cacheWrite : 0);

  const collectionOptions = $derived([
    { value: '', label: 'Any collection' },
    ...vm.activeWorkspaceCollections().map(collection => ({ value: collection.name, label: collection.name })),
  ]);
  const environmentOptions = $derived([
    { value: '', label: 'No environment' },
    ...vm.activeWorkspaceEnvironments.map(environment => ({ value: environment.name, label: environment.protected ? `${environment.name} (protected)` : environment.name, color: environmentColorVar(environment) })),
  ]);
  const collectionLabel = $derived(collectionOptions.find(option => option.value === agentStore.collection)?.label ?? agentStore.collection);
  const environmentLabel = $derived(environmentOptions.find(option => option.value === agentStore.environment)?.label ?? agentStore.environment);
  $effect(() => {
    agentStore.init();
  });

  onMount(() => {
    void aiConnectionsStore.refresh();
    if (!agentStore.chatsLoaded) void agentStore.refreshChats();
    const observer = new ResizeObserver(() => {
      if (!workspaceElement) return;
      detailsCover = workspaceElement.clientWidth < 44 * parseFloat(getComputedStyle(document.documentElement).fontSize);
    });
    if (workspaceElement) observer.observe(workspaceElement);
    return () => observer.disconnect();
  });

  $effect(() => {
    if (!agentNavigation.detailsOpen || !detailsCover) return;
    void tick().then(() => detailsPanel?.querySelector<HTMLButtonElement>('.agent-details-close')?.focus());
  });

  function escapeKey(node: HTMLElement, handler: (event: KeyboardEvent) => void) {
    node.addEventListener('keydown', handler);
    return { destroy: () => node.removeEventListener('keydown', handler) };
  }

  function onDetailsKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    void closeDetails();
  }

  async function closeDetails() {
    if (!agentNavigation.detailsOpen) return;
    toggleAgentDetails();
    await tick();
    document.querySelector<HTMLButtonElement>('[aria-label="Toggle chat details"]')?.focus();
  }

  $effect(() => {
    if (agentStore.driver) return;
    if (agentStore.connectionId && connections.some(connection => connection.id === agentStore.connectionId)) return;
    const fallback = aiConnectionsStore.defaultConnection;
    if (fallback && agentStore.connectionId !== fallback.id) agentStore.connectionId = fallback.id;
  });

  $effect(() => {
    titleDraft = title;
    titleError = '';
  });

  $effect(() => {
    if (agentStore.activeChatId === lastChatId) return;
    const assignedLiveChat = !lastChatId && agentStore.liveInActiveChat;
    lastChatId = agentStore.activeChatId;
    if (assignedLiveChat) return;
    openAttachment = undefined;
    openTools.clear();
    openThinking.clear();
    copiedKey = '';
    stickToBottom = true;
  });


  let approvalCount = 0;
  $effect(() => {
    const count = approvals.length;
    if (count > approvalCount) stickToBottom = true;
    approvalCount = count;
  });

  const EARLIER_EDGE = 160;

  function loadEarlier() {
    history?.captureAnchor();
    stickToBottom = false;
    void agentStore.loadEarlier();
  }

  function onScroll() {
    if (!scroller) return;
    stickToBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
    if (!stickToBottom && scroller.scrollTop < EARLIER_EDGE && !agentStore.historyError) void agentStore.loadEarlier();
  }

  $effect(() => {
    const node = scroller;
    const offset = agentStore.activeChat?.messageOffset ?? 0;
    turns.length;
    if (!node || !offset || agentStore.loadingEarlier || agentStore.historyError) return;
    const frame = requestAnimationFrame(() => {
      if (node.scrollHeight - node.clientHeight < EARLIER_EDGE) void agentStore.loadEarlier();
    });
    return () => cancelAnimationFrame(frame);
  });

  function prettyJSON(text: string | undefined) {
    const value = (text ?? '').trim();
    if (!value) return '{}';
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }

  function resultFor(step: AiStepView, block: AiBlock) {
    return step.toolResults.find(result => result.id === block.id);
  }

  function approvalFor(block: AiBlock): AgentApproval | undefined {
    return approvals.find(approval => approval.toolUseId && approval.toolUseId === block.id);
  }

  function toggle(set: SvelteSet<string>, key: string) {
    if (set.has(key)) set.delete(key);
    else set.add(key);
  }

  const savedRequestList = $derived(vm.requests.filter(request => !request.isDraft).map(request => ({
    id: request.id,
    name: request.name ?? '',
    path: [vm.collectionNameById(request.collectionId), ...(request.folderPath ?? []), request.name ?? ''].filter(Boolean).join('/'),
  })));

  function targetLabel(target: AgentToolTarget): string {
    if (target.kind === 'history') return 'Open entry';
    if (target.kind === 'environment') return 'Open environment';
    return 'Open request';
  }

  function canOpen(target: AgentToolTarget): boolean {
    if (target.kind === 'history') return vm.requestHistory.some(entry => entry.id === target.id);
    if (target.kind === 'environment') return vm.activeWorkspaceEnvironments.some(environment => environment.name.toLowerCase() === target.name.toLowerCase());
    return Boolean(agentFindRequest(savedRequestList, target.ref));
  }

  function openTarget(target: AgentToolTarget) {
    if (target.kind === 'history') {
      void vm.openHistoryDetail(target.id);
      return;
    }
    if (target.kind === 'environment') {
      const environment = vm.activeWorkspaceEnvironments.find(candidate => candidate.name.toLowerCase() === target.name.toLowerCase());
      if (environment) void vm.openEnvironment(environment.id);
      return;
    }
    const request = agentFindRequest(savedRequestList, target.ref);
    if (request) void vm.switchRequest(request.id);
  }

  function contextName(path: string) {
    return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
  }

  function addAttachments(paths: string[]) {
    const attachments = [...new Set([...agentStore.attachmentPaths, ...paths.filter(Boolean)])];
    agentStore.attachmentPaths = attachments.slice(0, attachmentLimit);
    attachmentError = attachments.length > attachmentLimit ? 'Attach up to four files per message.' : '';
  }

  function removeAttachment(file: string) {
    agentStore.attachmentPaths = agentStore.attachmentPaths.filter(path => path !== file);
    attachmentError = '';
  }

  async function chooseAgentContext(kind: 'project' | 'file') {
    if (selectingContext) return;
    const store = agentStore;
    const workspaceId = store.workspaceId;
    const chatId = store.activeChatId;
    selectingContext = true;
    attachmentError = '';
    try {
      const selected = kind === 'project'
        ? await openDirectoryDialog('Connect a read-only project folder', store.projectRoot)
        : await openFileDialog('Attach a file to this message');
      if (!selected || store !== agentStore || store.workspaceId !== workspaceId || store.activeChatId !== chatId) return;
      if (kind === 'project') {
        store.projectRoot = selected;
      } else {
        addAttachments([selected]);
      }
    } catch (error) {
      attachmentError = error instanceof Error ? error.message : String(error);
    } finally {
      selectingContext = false;
    }
  }

  async function send() {
    if (!agentStore.draft.trim() || agentStore.running) return;
    stickToBottom = true;
    await agentStore.send();
  }

  function onKeydown(event: KeyboardEvent) {
    if (!aiComposerSends(event)) return;
    event.preventDefault();
    void send();
  }

  async function connectOpenRouter() {
    await startOpenRouterConnect();
    vm.openSettings('ai');
  }

  function openConnectionSettings(intent: '' | 'key' | 'local') {
    aiConnectionsStore.intent = intent;
    vm.openSettings('ai');
  }

  async function copyText(key: string, text: string) {
    if (!text) return;
    await clipboardSet(text);
    copiedKey = key;
    setTimeout(() => { if (copiedKey === key) copiedKey = ''; }, 1500);
  }

  async function commitTitle() {
    const id = agentStore.activeChat?.id;
    if (!id || titleDraft.trim() === title.trim()) {
      titleDraft = title;
      return;
    }
    titleError = await agentStore.rename(id, titleDraft);
    if (titleError) titleDraft = title;
  }



  function onTitleKeydown(event: KeyboardEvent) {
    const input = event.currentTarget as HTMLInputElement;
    if (event.key === 'Enter') {
      event.preventDefault();
      input.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      titleDraft = title;
      input.blur();
    }
  }

  let workspaceTemplates = $state<AgentTemplate[]>([]);
  let notesExist = $state(true);
  let branching = $state(false);
  let branchError = $state('');
  let compactError = $state('');
  let summaryOpen = $state(false);
  const compactedAt = $derived(chatLoaded && agentStore.activeChat?.summary && agentStore.activeChat.summaryBefore ? agentStore.activeChat.summaryBefore : null);
  const messageTotal = $derived(chatLoaded ? agentStore.activeChat?.messageCount ?? (agentStore.activeChat?.messageOffset ?? 0) + (agentStore.activeChat?.messages.length ?? 0) : 0);
  const compacting = $derived(Boolean(agentStore.compactingChat) && agentStore.compactingChat === agentStore.activeChatId);
  const historySummary = $derived(compactedAt !== null ? `${compactedAt} compacted` : `${messageTotal} ${messageTotal === 1 ? 'message' : 'messages'}`);

  async function compactChat() {
    compactError = await agentStore.compact();
  }

  async function editMessage(index: number, text: string) {
    agentStore.startEdit(index, text);
    await tick();
    composerInput?.focus();
    composerInput?.setSelectionRange(text.length, text.length);
  }

  async function branchFrom(index: number, text: string) {
    branching = true;
    branchError = await agentStore.branchFrom(index, text);
    branching = false;
    if (!branchError) {
      await tick();
      composerInput?.focus();
    }
  }

  async function toggleTemplates() {
    templatesOpen = !templatesOpen;
    if (!templatesOpen) return;
    try {
      const notes = await agentWorkspaceNotes();
      workspaceTemplates = notes.templates.map((template, index) => ({ id: `workspace:${index}`, title: template.title, summary: '', text: template.text }));
      notesExist = notes.exists;
    } catch {
      workspaceTemplates = [];
    }
    await tick();
    focusFirstMenuItem(templatesMenu);
  }

  function editNotes() {
    templatesOpen = false;
    void agentNotesEditor.show();
  }

  async function useTemplate(template: AgentTemplate) {
    templatesOpen = false;
    agentStore.draft = template.text;
    await tick();
    if (!composerInput) return;
    composerInput.focus();
    const range = agentTemplatePlaceholder(template.text);
    if (range) composerInput.setSelectionRange(range.start, range.end);
    else composerInput.setSelectionRange(template.text.length, template.text.length);
  }

  function onTemplatesKeydown(event: KeyboardEvent) {
    handleMenuKeydown(event, () => {
      templatesOpen = false;
      composerInput?.focus();
    });
  }

  function onWindowPointerDown(event: PointerEvent) {
    if (!templatesOpen) return;
    const target = event.target;
    if (target instanceof Element && target.closest('.agent-templates-menu, .agent-templates-btn')) return;
    templatesOpen = false;
    composerInput?.focus();
  }

  async function retry() {
    if (retrying || checkingCodex) return;
    stickToBottom = true;
    const store = agentStore;
    const workspaceId = store.workspaceId;
    const chatId = store.activeChatId;
    retrying = true;
    try {
      if (store.driver === 'codex') {
        await codexConnectionStore.refresh();
        if (store !== agentStore || store.workspaceId !== workspaceId || store.activeChatId !== chatId) return;
        if (codexConnectionStore.status.error) {
          store.notes = { chatId, error: codexConnectionStore.status.error, warnings: [] };
          return;
        }
      }
      await store.retry();
    } finally {
      retrying = false;
    }
  }

  function formatCost(value: number) {
    return value < 0.01 ? '<$0.01' : `$${value.toFixed(2)}`;
  }

  function formatTokens(value: number) {
    if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
    return value >= 10000 ? `${(value / 1000).toFixed(value >= 100000 ? 0 : 1)}k` : value.toLocaleString('en-US');
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

{#snippet copyButton(key: string, text: string, label: string)}
  <button class="btn btn-ghost btn-icon btn-xs agent-copy" type="button" onclick={() => void copyText(key, text)} aria-label={copiedKey === key ? 'Copied' : label}>
    {#if copiedKey === key}
      <svg width="0.75rem" height="0.75rem" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2.5 6.5 5 9l4.5-6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
    {:else}
      <svg width="0.75rem" height="0.75rem" viewBox="0 0 12 12" fill="none" aria-hidden="true"><rect x="3.75" y="3.75" width="6.5" height="6.5" rx="1.25" stroke="currentColor" stroke-width="1.2"/><path d="M8.25 2.5v-.25c0-.55-.45-1-1-1h-4.5c-.55 0-1 .45-1 1v4.5c0 .55.45 1 1 1H3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
    {/if}
  </button>
{/snippet}


{#snippet sparkle(size: string)}
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5 13.6 8a2 2 0 0 0 1.4 1.4l4.5 1.6-4.5 1.6a2 2 0 0 0-1.4 1.4L12 18.5 10.4 14A2 2 0 0 0 9 12.6L4.5 11 9 9.4A2 2 0 0 0 10.4 8z"/><path d="M18.5 3v3M17 4.5h3"/></svg>
{/snippet}

{#snippet starterIcon(id: string)}
  <svg width="1rem" height="1rem" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    {#if id === 'check'}<path d="M7 5l12 7-12 7z"/>
    {:else if id === 'tests'}<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 12l2 2 4-4"/>
    {:else if id === 'cover'}<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10v6M9 13h6"/>
    {:else}<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>{/if}
  </svg>
{/snippet}

{#snippet errorCard(text: string)}
  {@const view = aiErrorView(text)}
  <div class="agent-error" role="alert">
    <strong>{view.title}</strong>
    {#if view.status}<span class="agent-error-status">{view.status}</span>{/if}
    {#if view.message}<div class="agent-error-message"><Markdown source={view.message} compact /></div>{/if}
    {#if view.hint}<span class="agent-error-hint">{view.hint}</span>{/if}
    {#if aiConnectionProblem(text)}<details><summary>Technical details</summary><div class="agent-error-message"><Markdown source={text} compact /></div></details>{/if}
  </div>
{/snippet}

<div class="agent-workspace" bind:this={workspaceElement}>
  {#if needsConnection && !archived}
    <div class="agent-onboarding">
      <h2 class="agent-onboarding-title">Connect a model to start</h2>
      <p class="agent-onboarding-text">The agent runs on your own key or a model on this computer. It reads and runs your requests, explains failures and edits the collection, and asks before it sends anything that changes data or writes a file.</p>
      <div class="agent-onboarding-cards">
        <button class="option-card agent-onboarding-card" type="button" onclick={connectOpenRouter}>
          <strong>Connect OpenRouter</strong>
          <span>Sign in once in the browser. One account gives you Claude, GPT and hundreds of other models.</span>
        </button>
        <button class="option-card agent-onboarding-card" type="button" onclick={() => openConnectionSettings('key')}>
          <strong>Your API key</strong>
          <span>Paste an Anthropic, OpenAI or other compatible key. It is kept in the system keychain.</span>
        </button>
        <button class="option-card agent-onboarding-card" type="button" onclick={() => openConnectionSettings('local')}>
          <strong>Local model</strong>
          <span>Use Ollama or LM Studio. Nothing leaves this computer; small models are weak at tool calls.</span>
        </button>
        <button class="option-card agent-onboarding-card" type="button" onclick={() => openConnectionSettings('')}>
          <strong>Codex on this computer</strong>
          <span>Use the Codex CLI with your ChatGPT plan. Kurlo connects it to this workspace.</span>
        </button>
      </div>
    </div>
  {:else}
    {#if chatSaved}
      <div class="agent-header">
        <div class="agent-title-field">
          <span class="request-title-input agent-title-measure" aria-hidden="true">{titleDraft || titlePlaceholder}{'\u00a0'}</span>
          <input
            class="request-title-input agent-title-input"
            bind:value={titleDraft}
            bind:this={titleInput}
            placeholder={titlePlaceholder}
            spellcheck="false"
            maxlength="120"
            aria-label="Chat name"
            aria-invalid={titleError ? 'true' : undefined}
            onblur={() => void commitTitle()}
            onkeydown={onTitleKeydown}
            disabled={workspaceBlocked}
            readonly={archived}
          />
        </div>
        {#if titleError}<span class="agent-title-error" role="alert">{titleError}</span>{/if}
      </div>
    {/if}

    <div class="agent-body" class:details-open={agentNavigation.detailsOpen} class:details-cover={detailsCover} style:--agent-details-w={detailsCover ? `calc(100vw - var(--rail-w) - ${rem(shellLayout.sidebarWidth)})` : undefined}>
      <div class="agent-main-slot" class:covered={agentNavigation.detailsOpen && detailsCover} inert={agentNavigation.detailsOpen && detailsCover}>
      <div class="agent-main">
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div class="agent-chat" bind:this={scroller} role="region" aria-label="Conversation" tabindex="0">
          {#if agentStore.loadError}
            {@render errorCard(agentStore.loadError)}
          {:else if !turns.length && !agentStore.activeChatId}
            <div class="agent-empty">
              <span class="agent-empty-icon" aria-hidden="true">{@render sparkle('1.375rem')}</span>
              <h2 class="agent-empty-title">What should we check?</h2>
              <p class="agent-empty-text">The agent sees the requests, collections and environments in this workspace.</p>
              <div class="agent-empty-rules">
                <span><svg width="0.875rem" height="0.875rem" viewBox="0 0 12 12" fill="none" aria-hidden="true" class="agent-rule-ok"><path d="M2.5 6.5 5 9l4.5-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>Reads and GET requests run on their own</span>
                <span><svg width="0.875rem" height="0.875rem" viewBox="0 0 16 16" fill="none" aria-hidden="true" class="agent-rule-wait"><path d="M8 1.75 2.75 4v3.6c0 3.2 2.2 5.7 5.25 6.65 3.05-.95 5.25-3.45 5.25-6.65V4L8 1.75Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>Changes to data or files wait for you</span>
              </div>
              <div class="agent-starters">
                {#each starters as template (template.id)}
                  <button class="option-card agent-starter" type="button" aria-label={template.title} onclick={() => void useTemplate(template)} disabled={workspaceBlocked}>
                    <span class="agent-starter-icon" aria-hidden="true">{@render starterIcon(template.id)}</span>
                    <span class="agent-starter-copy">
                      <span class="agent-starter-title agent-starter-title-full">{template.title}</span>
                      <span class="agent-starter-title agent-starter-title-short" aria-hidden="true">{starterLabels[template.id]}</span>
                      <span class="agent-starter-text">{template.summary}</span>
                    </span>
                  </button>
                {/each}
              </div>
            </div>
          {/if}

          {#if agentStore.activeChat?.messageOffset && agentStore.loadingEarlier}
            <div class="agent-earlier"><BirdSpinner size="1.5rem" label="Loading earlier messages" /></div>
          {/if}
          {#if agentStore.historyError}<div class="agent-note agent-history-error"><span role="alert">{agentStore.historyError}</span><button class="btn btn-ghost btn-sm" type="button" onclick={loadEarlier}>Retry</button></div>{/if}
          {#key `${agentStore.workspaceId}:${agentStore.activeChatId}`}
          <VirtualAgentHistory bind:this={history} items={turns} {scroller} follow={stickToBottom} {onScroll}>
            {#snippet children(turn)}
            <div class="agent-turn">
              {#if turn.attachments.length}
                <ul class="agent-message-files" aria-label="Attachments">
                  {#each turn.attachments as file, index (file.id || `${index}:${file.name}`)}
                    <li class="agent-message-file">
                      {#if file.preview || (file.id && file.mediaType)}
                        <button class="btn btn-secondary agent-file-button" class:agent-image-file={file.preview} type="button" aria-label={`Open ${file.name}`} onclick={event => { event.currentTarget.focus(); openAttachment = file; }}>
                          {#if file.preview}
                            <img src={file.preview} alt={`Preview of ${file.name}`} draggable="false" class:vector={file.mediaType === 'image/svg+xml'} />
                          {:else}
                            {@render attachmentName(file.name)}
                          {/if}
                        </button>
                      {:else}
                        <div class="agent-file-label">{@render attachmentName(file.name)}</div>
                      {/if}
                    </li>
                  {/each}
                </ul>
              {/if}
              {#if compactedAt !== null && turn.messageIndex === compactedAt}
                <div class="agent-compact-divider" role="separator">Messages above are compacted. The agent works from their summary.</div>
              {/if}
              {#if turn.prompt}
                <div class="agent-user-row" class:editing={agentStore.editing !== null && turn.messageIndex !== undefined && agentStore.editing.index === turn.messageIndex}>
                  <div class="agent-message-actions">
                    {#if !turn.live && !agentStore.driver && !archived && turn.messageIndex !== undefined}
                      {@const index = turn.messageIndex}
                      <button class="btn btn-ghost btn-icon btn-sm agent-copy" type="button" aria-label="Edit message" disabled={agentStore.running} onclick={() => void editMessage(index, turn.prompt)}>
                        <svg width="0.75rem" height="0.75rem" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10.5 2.75 13.25 5.5 5.75 13H3v-2.75l7.5-7.5Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>
                      </button>
                      <button class="btn btn-ghost btn-icon btn-sm agent-copy" type="button" aria-label="Branch from here" disabled={agentStore.running || branching} onclick={() => void branchFrom(index, turn.prompt)}>
                        <svg width="0.75rem" height="0.75rem" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="4.5" cy="3.5" r="1.75" stroke="currentColor" stroke-width="1.4"/><circle cx="4.5" cy="12.5" r="1.75" stroke="currentColor" stroke-width="1.4"/><circle cx="11.5" cy="5.5" r="1.75" stroke="currentColor" stroke-width="1.4"/><path d="M4.5 5.25v5.5M11.5 7.25c0 2.5-2 3-5.5 3.75" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
                      </button>
                    {/if}
                    {@render copyButton(`${turn.id}:prompt`, turn.prompt, 'Copy message')}
                  </div>
                  <div class="agent-user">{turn.prompt}</div>
                </div>
              {/if}
              {#each agentTurnSegments(turn.steps) as segment, segmentIndex (segmentIndex)}
                {#if segment.kind === 'error'}
                  {@render errorCard(segment.error)}
                {:else if segment.kind === 'block' && segment.block.type === 'thinking'}
                  {@const key = `${turn.id}:${segment.step.index}:${segment.blockIndex}`}
                  <div>
                    <button class="btn btn-ghost btn-sm agent-step-toggle" type="button" aria-expanded={openThinking.has(key)} onclick={() => toggle(openThinking, key)}>
                      <svg class:open={openThinking.has(key)} width="0.625rem" height="0.625rem" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M3.5 2l3 3-3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
                      Thinking
                    </button>
                    {#if openThinking.has(key)}<div class="agent-thinking">{segment.block.text}</div>{/if}
                  </div>
                {:else if segment.kind === 'block'}
                  <div class="agent-text"><Markdown source={segment.block.text ?? ''} compact live={turn.live && !segment.step.done} /></div>
                {:else if segment.kind === 'tools'}
                  <div class="agent-steps">
                    {#each segment.items as item (`${item.step.index}:${item.blockIndex}`)}
                      {@const result = resultFor(item.step, item.block)}
                      {@const key = `${turn.id}:${item.step.index}:${item.blockIndex}`}
                      {@const target = item.step.done ? agentToolTarget(item.block, result) : null}
                      {@const approval = turn.live ? approvalFor(item.block) : undefined}
                      {@const summary = agentStepSummary(item.block, result)}
                      <div class="agent-tool" class:agent-tool-error={result?.isError}>
                        <div class="agent-tool-row">
                          <button class="agent-tool-toggle" type="button" aria-expanded={openTools.has(key)} onclick={() => toggle(openTools, key)}>
                            {#if result?.isError}
                              <span class="agent-tool-state agent-tool-failed" role="img" aria-label="Failed"><svg width="0.875rem" height="0.875rem" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></span>
                            {:else if result}
                              <span class="agent-tool-state agent-tool-done" role="img" aria-label="Done"><svg width="0.875rem" height="0.875rem" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
                            {:else if approval}
                              <span class="agent-tool-state agent-tool-waiting" role="img" aria-label="Waiting for you"><svg width="0.875rem" height="0.875rem" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 1.75 2.75 4v3.6c0 3.2 2.2 5.7 5.25 6.65 3.05-.95 5.25-3.45 5.25-6.65V4L8 1.75Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg></span>
                            {:else if turn.live}
                              <span class="agent-tool-state" role="img" aria-label="Running"><span class="spinner spinner-inline"></span></span>
                            {:else}
                              <span class="agent-tool-state" aria-hidden="true"></span>
                            {/if}
                            <span class="agent-tool-label">{agentToolLabel(item.block.name)}</span>
                            {#if summary.target}<span class="agent-tool-target">{summary.target}</span>{/if}
                            <span class="agent-tool-name">{summary.detail || item.block.name}</span>
                            {#if summary.status}<span class="agent-tool-status" class:ok={summary.status < 300} class:warn={summary.status >= 300 && summary.status < 500} class:bad={summary.status >= 500}>{summary.status}</span>{/if}
                            {#if summary.durationMs}<span class="agent-tool-time">{summary.durationMs} ms</span>{/if}
                            <svg class="agent-tool-chevron" class:open={openTools.has(key)} width="0.625rem" height="0.625rem" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M3.5 2l3 3-3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
                          </button>
                          {#if target && canOpen(target)}
                            <button class="btn-link agent-tool-open" type="button" onclick={() => openTarget(target)}>{targetLabel(target)}</button>
                          {/if}
                        </div>
                        {#if openTools.has(key)}
                          <pre class="agent-tool-body">{item.step.done ? prettyJSON(item.block.input) : (item.block.input || '')}</pre>
                          {#if result}<pre class="agent-tool-body agent-tool-result">{result.text}</pre>{/if}
                        {/if}
                        {#if approval}
                          <div class="agent-tool-approval"><AgentApprovalCard {approval} onAnswer={(decision) => agentStore.answer(approval.id, decision)} /></div>
                        {/if}
                      </div>
                    {/each}
                  </div>
                {/if}
              {/each}
              {#if turn.live && !agentStore.compacting && !turn.steps.some(step => step.blocks.length)}
                <div class="agent-waiting"><span class="spinner spinner-inline"></span>Thinking…</div>
              {/if}
              {#if !turn.live && agentTurnAnswer(turn.steps)}
                <div class="agent-message-actions agent-answer-actions">{@render copyButton(`${turn.id}:answer`, agentTurnAnswer(turn.steps), 'Copy answer')}</div>
              {/if}
            </div>
            {/snippet}
          </VirtualAgentHistory>
          {#if compactedAt !== null && compactedAt >= messageTotal && !agentStore.running}
            <div class="agent-compact-divider" role="separator">Messages above are compacted. The agent works from their summary.</div>
          {/if}
          {/key}

          {#each approvals.filter(approval => !approval.toolUseId || !live || !live.steps.some(step => step.blocks.some(block => block.id === approval.toolUseId))) as approval (approval.id)}
            <AgentApprovalCard {approval} onAnswer={(decision) => agentStore.answer(approval.id, decision)} />
          {/each}

          {#if notes && !agentStore.running}
            {#if notes.error}{@render errorCard(notes.error)}{/if}
            {#each notes.warnings as warning, index (index)}
              <div class="agent-note" role="status">{warning}</div>
            {/each}
          {/if}
          {#if canRetry}
            <div class="agent-turn-actions">
              <button class="btn btn-secondary btn-sm" type="button" onclick={() => void retry()} disabled={workspaceBlocked || retrying || checkingCodex}>{checkingCodex ? 'Connecting…' : agentStore.driver === 'codex' && notes?.error ? 'Reconnect and retry' : 'Retry'}</button>
            </div>
          {/if}
        </div>

        {#if archived}
          <div class="agent-composer"><div class="agent-note" role="status">Archived chat. Restore it from the chat menu to continue.</div></div>
        {:else}
          <div class="agent-composer">
            {#if runningElsewhere}
              <div class="agent-note" role="status">The agent is working in another chat. You can send here when it finishes.</div>
            {:else if agentStore.compacting && agentStore.liveInActiveChat}
              <div class="agent-status" role="status"><span class="spinner spinner-inline"></span>Compacting context…</div>
            {:else if approvals.length && agentStore.liveInActiveChat}
              <div class="agent-status agent-status-wait" role="status"><span class="agent-status-dot"></span>{agentStore.driver === 'codex' ? 'Codex' : agentStore.driver === 'claude-code' ? 'Claude Code' : 'The agent'} is waiting for your approval</div>
            {/if}
            <div class="agent-composer-box" class:disabled={workspaceBlocked} bind:this={composerBox} style:--wails-drop-target={attachmentDisabled ? 'none' : 'drop'}>
              <textarea
                class="agent-input"
                rows="1"
                placeholder="Ask to run, explain or change something"
                aria-label="Message the agent"
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
                {...NO_AUTOCORRECT}
                maxlength={AI_PROMPT_MAX_CHARS}
                bind:this={composerInput}
                bind:value={agentStore.draft}
                use:autoSizeTextarea={agentStore.draft}
                onkeydown={onKeydown}
                disabled={workspaceBlocked}
              ></textarea>
              {#if agentStore.projectRoot || draftAttachments.length}
                <div class="agent-context-files" aria-label="Project and attachments">
                  {#if agentStore.projectRoot}
                    <button class="btn btn-secondary btn-sm agent-context-file" type="button" aria-label={`Disconnect project ${contextName(agentStore.projectRoot)}`} disabled={agentStore.running || workspaceBlocked} onclick={() => (agentStore.projectRoot = '')}>
                      <span>Project · {contextName(agentStore.projectRoot)}</span><span aria-hidden="true">×</span>
                    </button>
                  {/if}
                  {#each draftAttachments as file (file)}
                    <button class="btn btn-secondary btn-sm agent-context-file" type="button" aria-label={`Remove attachment ${contextName(file)}`} disabled={agentStore.running || workspaceBlocked} onclick={() => removeAttachment(file)}>
                      <span>{contextName(file)}</span><span aria-hidden="true">×</span>
                    </button>
                  {/each}
                </div>
              {/if}
              {#if attachmentError}<div class="agent-note" role="alert">{attachmentError}</div>{/if}
              {#if branchError}<div class="agent-note" role="alert">{branchError}</div>{/if}
              {#if agentStore.editing}
                <div class="agent-edit-note" role="status">
                  <span>Editing an earlier message. Sending replaces it and everything after it.</span>
                  <button class="btn-link" type="button" onclick={() => agentStore.cancelEdit()}>Cancel</button>
                </div>
              {/if}
              <div class="agent-composer-bar" class:compact={composerCompact} class:tight={composerTight} bind:this={composerBar}>
                <div class="agent-composer-context" bind:this={composerContext} style:min-width={composerCompact && contextMin ? `${contextMin}px` : undefined}>
                  <span class="agent-composer-chip" class:compact={composerCompact}>
                    <svg class="agent-composer-chip-icon" width="0.875rem" height="0.875rem" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 3 8l9 5 9-5-9-5z"/><path d="m3 13 9 5 9-5"/></svg>
                    <Select value={agentStore.collection} options={collectionOptions} className="agent-chip" ariaLabel="Collection" disabled={agentStore.running} onChange={(value) => (agentStore.collection = value)} />
                  </span>
                  <span class="agent-composer-chip" class:compact={composerCompact}>
                    <svg class="agent-composer-chip-icon" style:color={environmentColor} width="0.875rem" height="0.875rem" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/></svg>
                    <Select value={agentStore.environment} options={environmentOptions} className="agent-chip" searchable={environmentOptions.length > 8} searchPlaceholder="Search environments" ariaLabel="Environment" disabled={agentStore.running} onChange={(value) => (agentStore.environment = value)} />
                  </span>
                  {#if vm.gitStatus.isRepo}
                    <button class="btn btn-ghost btn-sm agent-branch-toggle" class:on={agentStore.ownBranch} type="button" aria-pressed={agentStore.ownBranch} aria-label="Agent branch" disabled={agentStore.running || workspaceBlocked} onclick={() => (agentStore.ownBranch = !agentStore.ownBranch)}>
                      <svg width="0.75rem" height="0.75rem" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="4.5" cy="3.5" r="1.75" stroke="currentColor" stroke-width="1.4"/><circle cx="4.5" cy="12.5" r="1.75" stroke="currentColor" stroke-width="1.4"/><circle cx="11.5" cy="5.5" r="1.75" stroke="currentColor" stroke-width="1.4"/><path d="M4.5 5.25v5.5M11.5 7.25c0 2.5-2 3-5.5 3.75" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
                      <span class="agent-branch-label">Branch</span>
                    </button>
                  {/if}
                  <button class="btn btn-ghost btn-icon btn-sm agent-templates-btn" type="button" aria-label="Connect project folder" disabled={workspaceBlocked || agentStore.running || selectingContext} onclick={() => void chooseAgentContext('project')}>
                    <svg width="0.875rem" height="0.875rem" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M1.75 4A1.25 1.25 0 0 1 3 2.75h3L7.5 4H13a1.25 1.25 0 0 1 1.25 1.25V12A1.25 1.25 0 0 1 13 13.25H3A1.25 1.25 0 0 1 1.75 12V4Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/></svg>
                  </button>
                  <button class="btn btn-ghost btn-icon btn-sm agent-templates-btn" type="button" aria-label="Attach file" disabled={attachmentDisabled || agentStore.attachmentPaths.length >= attachmentLimit} onclick={() => void chooseAgentContext('file')}>
                    <svg width="0.875rem" height="0.875rem" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m6 8.5 3.5-3.6a1.5 1.5 0 0 1 2.1 2.1L7 11.7a2.6 2.6 0 0 1-3.7-3.7l5-5" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/></svg>
                  </button>
                  <div class="agent-templates">
                    <button class="btn btn-ghost btn-icon btn-sm agent-templates-btn" type="button" aria-label="Templates" aria-haspopup="menu" aria-expanded={templatesOpen} onclick={() => void toggleTemplates()} disabled={workspaceBlocked}>
                      <svg width="0.875rem" height="0.875rem" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2 2.75h8M2 6h8M2 9.25h5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
                    </button>
                    {#if templatesOpen}
                      <div class="menu agent-templates-menu" role="menu" tabindex="-1" aria-label="Templates" bind:this={templatesMenu} onkeydown={onTemplatesKeydown}>
                        {#if workspaceTemplates.length}
                          <div class="menu-section-label agent-template-group" role="presentation">From kurlo-agent.md</div>
                          {#each workspaceTemplates as template (template.id)}
                            <button class="menu-item agent-template" type="button" role="menuitem" onclick={() => void useTemplate(template)}>
                              <span class="agent-template-title">{template.title}</span>
                              <span class="agent-template-text">{template.text}</span>
                            </button>
                          {/each}
                          <div class="menu-section-label agent-template-group" role="presentation">Built in</div>
                        {/if}
                        {#each AGENT_TEMPLATES as template (template.id)}
                          <button class="menu-item agent-template" type="button" role="menuitem" onclick={() => void useTemplate(template)}>
                            <span class="agent-template-title">{template.title}</span>
                            <span class="agent-template-text">{template.text}</span>
                          </button>
                        {/each}
                        <div class="menu-separator" role="separator"></div>
                        <button class="menu-item" type="button" role="menuitem" onclick={editNotes}><MenuIcon name="rename" />{notesExist ? 'Edit kurlo-agent.md…' : 'Create kurlo-agent.md…'}</button>
                      </div>
                    {/if}
                  </div>
                </div>
                <div class="agent-composer-actions" bind:this={composerActions}>
                  {#if !agentStore.driver}
                    <span class="agent-composer-chip agent-mode-chip" class:compact={composerCompact}>
                      <svg class="agent-composer-chip-icon" width="0.875rem" height="0.875rem" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 1.75 2.75 4v3.6c0 3.2 2.2 5.7 5.25 6.65 3.05-.95 5.25-3.45 5.25-6.65V4L8 1.75Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
                      <Select value={agentStore.mode} options={modeOptions} className="agent-chip" ariaLabel="Approvals" disabled={agentStore.running || workspaceBlocked} onChange={value => (agentStore.mode = value)} />
                    </span>
                  {/if}
                  <AgentPicker disabled={agentStore.running || workspaceBlocked} />
                  {#if agentStore.driver && effortOptions.length}
                    <Select value={effortChoice} options={effortOptions} className="agent-effort" ariaLabel="Effort" disabled={agentStore.running || workspaceBlocked} onChange={value => (agentStore.effort = agentEffortToStore(value, effortModel?.defaultEffort ?? ''))} />
                  {/if}
                  {#if agentStore.liveInActiveChat && agentStore.running}
                    <button class="btn btn-secondary btn-icon agent-stop" type="button" onclick={() => void agentStore.stop()} aria-label="Stop the agent">
                      <svg width="0.625rem" height="0.625rem" viewBox="0 0 12 12" fill="none" aria-hidden="true"><rect x="2" y="2" width="8" height="8" rx="1.25" fill="currentColor"/></svg>
                    </button>
                  {:else}
                    <button class="btn btn-primary btn-icon agent-send" type="button" onclick={send} disabled={workspaceBlocked || agentStore.running || !agentStore.draft.trim()} aria-label="Send">
                      <svg width="0.875rem" height="0.875rem" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M7 12V2M2.5 6.5L7 2l4.5 4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
                    </button>
                  {/if}
                </div>
              </div>
            </div>
            <div class="agent-session-status">
              {#if usage && (usage.input || usage.output)}
                <span class="agent-usage" aria-label={`${usage.input.toLocaleString('en-US')} input and ${usage.output.toLocaleString('en-US')} output tokens in this chat`}>
                  {formatTokens(usage.input + usage.cacheRead + usage.cacheWrite)} in · {formatTokens(usage.output)} out
                </span>
              {/if}
              {#if agentStore.driver && tightestQuota}
                <button class="btn-link agent-plan-mini" class:low={tightestQuota.remaining < 30} type="button" onclick={toggleAgentDetails} aria-label={`${planName} plan: ${tightestQuota.remaining}% left in the ${tightestQuota.duration} window. Show chat details`}>Plan {tightestQuota.remaining}% left</button>
              {/if}
              <span class="agent-composer-hint" aria-hidden="true"><kbd>↵</kbd> send · <kbd>⇧↵</kbd> new line</span>
            </div>
          </div>
        {/if}
      </div>

      </div>
      <div class="agent-details-shell" class:closed={!agentNavigation.detailsOpen} aria-hidden={!agentNavigation.detailsOpen} inert={!agentNavigation.detailsOpen}>
        <aside class="agent-context-panel" class:cover={detailsCover} aria-label="Chat details" tabindex="-1" bind:this={detailsPanel} use:escapeKey={onDetailsKeydown}>
          <div class="agent-details-head">
            <span>Chat details</span>
            <button class="btn btn-ghost btn-icon btn-sm agent-details-close" type="button" aria-label="Close chat details" onclick={closeDetails}>
              <AddCloseIcon />
            </button>
          </div>
          <Disclosure title="Context" summary={contextSummary} storageKey="agent-details-context">
            <div class="agent-kv"><span>Collection</span><span>{agentStore.collection || 'Any'}</span></div>
            <div class="agent-kv"><span>Environment</span><span>{#if environmentColor}<span class="env-color-dot" style:--env-color={environmentColor} aria-hidden="true"></span>{/if}{agentStore.environment || 'None'}{#if environmentProtected}<svg class="agent-kv-lock" width="0.6875rem" height="0.6875rem" viewBox="0 0 16 16" fill="none" aria-label="Protected" role="img"><rect x="3.5" y="7" width="9" height="7" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" stroke="currentColor" stroke-width="1.4"/></svg>{/if}</span></div>
            <div class="agent-kv"><span>Agent</span><span>{headerAgent}</span></div>
            <div class="agent-kv"><span>Team notes</span><span><button class="btn-link agent-notes-link" type="button" onclick={() => void agentNotesEditor.show()} disabled={workspaceBlocked}>kurlo-agent.md</button></span></div>
            {#if agentStore.driver}<div class="agent-kv"><span>Effort</span><span>{agentEffortLabel(agentStore.effort || selectedCodexDefaultEffort)}</span></div>{/if}
          </Disclosure>

          {#if !agentStore.driver}
            <Disclosure title="Permissions" summary={permissionsSummary} storageKey="agent-details-permissions">
              <p class="agent-detail-note">{modeNote} Change it next to the model in the message box.</p>
              <label class="agent-detail-field agent-detail-stack">
                <span>Trusted hosts</span>
                <input class="field field-sm" type="text" value={hostsDraft} placeholder="localhost, *.staging.example.com" spellcheck="false" aria-label="Trusted hosts" disabled={agentStore.running || agentStore.mode === 'ask'} oninput={event => (hostsDraft = event.currentTarget.value)} onchange={commitHosts} />
              </label>
              <p class="agent-detail-note">POST, PUT, PATCH and DELETE to these hosts, and any request in a sandbox environment, run without asking.</p>
            </Disclosure>
            <Disclosure title="Budget" summary={budgetSummary} storageKey="agent-details-budget">
              <label class="agent-detail-field">
                <span>Tokens</span>
                <input class="field field-sm agent-detail-number" type="text" inputmode="numeric" maxlength="13" value={agentStore.budgetTokens ? String(agentStore.budgetTokens) : ''} placeholder="No limit" aria-label="Token budget" disabled={agentStore.running} oninput={digitsOnly} onchange={commitTokenBudget} onblur={commitTokenBudget} />
              </label>
              <label class="agent-detail-field">
                <span>Sent requests</span>
                <input class="field field-sm agent-detail-number" type="text" inputmode="numeric" maxlength="7" value={agentStore.budgetRequests ? String(agentStore.budgetRequests) : ''} placeholder="No limit" aria-label="Request budget" disabled={agentStore.running} oninput={digitsOnly} onchange={commitRequestBudget} onblur={commitRequestBudget} />
              </label>
              {#if agentStore.activeChat && agentStore.activeChat.id === agentStore.activeChatId}
                <div class="agent-kv"><span>Used</span><span>{formatTokens(chatTokens)} tokens · {requestsSent} {requestsSent === 1 ? 'request' : 'requests'}</span></div>
              {/if}
              <p class="agent-detail-note">The agent stops when the chat reaches either limit, up to {AGENT_BUDGET_MAX_TOKENS.toLocaleString('en-US')} tokens or {AGENT_BUDGET_MAX_REQUESTS.toLocaleString('en-US')} requests. Changes apply from your next message.</p>
            </Disclosure>
            {#if chatLoaded}
              <Disclosure title="History" summary={historySummary} storageKey="agent-details-history">
                <p class="agent-detail-note">{compactedAt !== null ? 'The agent sees a summary instead of the compacted messages. They stay in the chat for you.' : 'Compacting replaces the messages so far with a summary for the agent, so a long chat costs fewer tokens. The messages stay in the chat for you.'}</p>
                {#if compactedAt !== null}
                  <button class="btn-link agent-summary-toggle" type="button" aria-expanded={summaryOpen} onclick={() => (summaryOpen = !summaryOpen)}>{summaryOpen ? 'Hide summary' : 'Show summary'}</button>
                  {#if summaryOpen}<div class="agent-summary-text" role="region" aria-label="Chat summary">{agentStore.activeChat?.summary}</div>{/if}
                {/if}
                <button class="btn btn-secondary btn-sm agent-compact" type="button" onclick={() => void compactChat()} disabled={archived || agentStore.running || compacting || messageTotal - (compactedAt ?? 0) < 2}>{compacting ? 'Compacting…' : 'Compact chat'}</button>
                {#if compactError}<p class="agent-detail-note agent-detail-error" role="alert">{compactError}</p>{/if}
              </Disclosure>
            {/if}
          {/if}

          {#if vm.gitStatus.isRepo}
            <Disclosure title="Git" summary={gitSummary} storageKey="agent-details-git">
              <div class="agent-kv"><span>Current branch</span><span class="agent-kv-mono">{vm.gitStatus.branch || 'None'}</span></div>
              <div class="agent-kv"><span>Agent branch</span><span class:agent-kv-mono={agentStore.ownBranch && Boolean(agentStore.activeChat?.branch)}>{agentStore.ownBranch ? agentStore.activeChat?.branch || 'Created on the first change' : 'Off'}</span></div>
              <p class="agent-detail-note">{agentStore.ownBranch ? 'Each change you approve is committed to the agent branch. Pushing still needs your approval.' : 'Turn on Branch in the message box to commit each approved change to a branch of its own.'}</p>
              {#if vm.workspaces.length > 1}<p class="agent-detail-note">Git works on the whole folder: a branch switch or commit here also applies to its other {vm.workspaces.length - 1} {vm.workspaces.length === 2 ? 'workspace' : 'workspaces'}.</p>{/if}
              <button class="btn btn-secondary btn-sm agent-pull-request" type="button" onclick={() => void openPullRequest()} disabled={pullRequestBusy}>Open pull request</button>
              {#if pullRequestError}<p class="agent-detail-note agent-detail-error" role="alert">{pullRequestError}</p>{/if}
            </Disclosure>
          {/if}

          {#if usage && (usage.input || usage.output)}
            <Disclosure title="Usage" summary={usageSummary} storageKey="agent-details-usage" defaultOpen>
              <div class="agent-kv"><span>Input</span><span>{usage.input.toLocaleString('en-US')}</span></div>
              {#if usage.cacheRead || usage.cacheWrite}<div class="agent-kv"><span>Cached</span><span>{(usage.cacheRead + usage.cacheWrite).toLocaleString('en-US')}</span></div>{/if}
              <div class="agent-kv"><span>Output</span><span>{usage.output.toLocaleString('en-US')}</span></div>
              {#if usage.reasoning}<div class="agent-kv"><span>Reasoning</span><span>{usage.reasoning.toLocaleString('en-US')}</span></div>{/if}
              {#if usage.cost}<div class="agent-kv"><span>Cost at API prices</span><span>{formatCost(usage.cost)}</span></div>{/if}
              {#if contextPercent !== null}
                <div class="agent-context agent-detail-meter" aria-label="Last reported context">
                  <span class="agent-detail-meter-head"><span>Context (last request)</span><span>{contextPercent}%</span></span>
                  <span class="agent-quota-bar agent-quota-bar-wide" aria-hidden="true"><span class="agent-quota-fill" style:width={`${contextPercent}%`}></span></span>
                  <span class="agent-detail-meter-note">{formatTokens(contextTokens)} / {formatTokens(contextWindow)} tokens</span>
                </div>
              {/if}
            </Disclosure>
          {/if}

          {#if agentStore.driver && quotaWindows.length}
            <Disclosure title={`${planName} plan`} summary={tightestQuota ? `${tightestQuota.remaining}% left` : ''} storageKey="agent-details-plan" defaultOpen>
              <div class="agent-limits">
                {#each quotaWindows as window, index (`${window.label}:${index}`)}
                  <div class="agent-detail-meter">
                    <span class="agent-detail-meter-head"><span>{window.duration === '5h' ? '5-hour window' : window.duration === '7d' ? 'Weekly' : window.label}</span><span>{window.remaining}% left</span></span>
                    <span class="agent-quota-bar agent-quota-bar-wide" aria-hidden="true"><span class="agent-quota-fill" class:low={window.remaining < 30} style:width={`${window.remaining}%`}></span></span>
                    {#if window.resetsAt > 0}<span class="agent-detail-meter-note agent-limit-resets">resets {new Date(window.resetsAt * 1000).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>{/if}
                  </div>
                {/each}
              </div>
              <p class="agent-detail-note">Shared with your other {agentStore.driver === 'claude-code' ? 'Claude Code' : 'Codex'} sessions.</p>
            </Disclosure>
          {/if}

          {#if contextChanges.length}
            <Disclosure title="Changes" summary={changesSummary} storageKey="agent-details-changes" defaultOpen>
              {#each contextChanges as change, index (index)}
                <div class="agent-context-item"><span class="agent-dot" class:wait={change.waiting}></span><span class="agent-context-item-name">{change.name}</span><span class="agent-context-item-meta" class:wait={change.waiting}>{change.waiting ? 'waiting' : change.label}</span></div>
              {/each}
            </Disclosure>
          {/if}

          {#if contextRuns.length}
            <Disclosure title="Runs" summary={String(contextRuns.length)} storageKey="agent-details-runs">
              {#each contextRuns as run, index (index)}
                <div class="agent-context-item"><span class="agent-context-method">{run.method}</span><span class="agent-context-item-name">{run.name}</span>{#if run.status}<span class="agent-tool-status" class:ok={run.status < 300} class:warn={run.status >= 300 && run.status < 500} class:bad={run.status >= 500}>{run.status}</span>{/if}</div>
              {/each}
            </Disclosure>
          {/if}
        </aside>
      </div>
    </div>
{/if}
</div>

{#snippet attachmentName(name: string)}
  <svg width="0.875rem" height="0.875rem" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 2h5l3 3v9H4zM9 2v3h3" stroke="currentColor" stroke-linejoin="round"/></svg>
  <span>{name}</span>
{/snippet}

{#if openAttachment}
  <AgentAttachmentViewer file={openAttachment} chatId={agentStore.activeChatId} workspaceId={agentStore.workspaceId} onClose={() => (openAttachment = undefined)} />
{/if}

<style>
  .agent-workspace {
    position: relative;
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--bg);
    container: agent / inline-size;
  }
  .agent-header {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: var(--space-3);
    min-height: 3.25rem;
    padding: 0 var(--space-6);
    border-bottom: 1px solid var(--border-subtle);
  }
  .agent-title-field {
    position: relative;
    min-width: 0;
    max-width: 32rem;
    margin-left: calc(var(--space-1-5) * -1);
  }
  .agent-title-field .request-title-input {
    max-width: none;
    font-size: var(--text-title);
    font-weight: var(--weight-semibold);
  }
  .agent-title-field .agent-title-measure {
    display: block;
    width: auto;
    visibility: hidden;
    white-space: pre;
  }
  .agent-title-input {
    position: absolute;
    inset: 0;
    width: 100%;
  }
  .agent-title-input:focus {
    text-overflow: clip;
  }
  .agent-title-error {
    color: var(--danger);
    font-size: var(--text-caption);
  }
  .agent-body {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 0rem;
    grid-template-rows: minmax(0, 1fr);
    --agent-details-w: 16rem;
    transition: grid-template-columns var(--panel-slide-dur) var(--panel-slide-ease);
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
  }
  .agent-body.details-open {
    grid-template-columns: minmax(0, 1fr) var(--agent-details-w);
  }
  .agent-main-slot,
  .agent-details-shell {
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }
  .agent-main-slot {
    display: flex;
  }
  .agent-details-shell.closed,
  .agent-main-slot.covered {
    visibility: hidden;
    pointer-events: none;
    transition: visibility 0s linear var(--panel-slide-dur);
  }
  .agent-body.details-cover .agent-main {
    min-width: var(--agent-details-w);
  }
  .agent-main {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    container: agent-main / inline-size;
    --agent-column: 47.5rem;
    --agent-gutter: max(var(--space-6), calc((100% - var(--agent-column)) / 2));
  }
  .agent-usage {
    flex: 0 0 auto;
    color: var(--text-3);
    font-size: var(--text-caption);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .agent-chat {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: var(--space-4);
    min-height: 0;
    overflow-x: hidden;
    overflow-y: auto;
    overflow-anchor: none;
    padding: var(--space-6) var(--agent-gutter) calc(var(--space-4) + var(--space-2));
  }
  .agent-empty {
    display: flex;
    flex: 0 0 auto;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    max-width: 40rem;
    margin: auto;
    padding: var(--space-4) 0;
    text-align: center;
  }

  .agent-empty-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2.25rem;
    height: 2.25rem;
    border-radius: var(--radius-lg);
    background: var(--accent-dim);
    color: var(--accent-text);
  }

  .agent-empty-title {
    margin: 0;
    color: var(--text);
    font-size: var(--text-heading);
    font-weight: var(--weight-semibold);
    letter-spacing: -0.01em;
  }
  .agent-empty-text {
    margin: 0;
    color: var(--text-2);
    font-size: var(--text-label);
  }
  .agent-empty-rules {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--space-1) var(--space-4);
    color: var(--text-3);
    font-size: var(--text-caption);
  }
  .agent-empty-rules span {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1-5);
  }
  .agent-rule-ok {
    color: var(--s2xx);
  }
  .agent-rule-wait {
    color: var(--s4xx);
  }
  .agent-starters {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr));
    gap: var(--space-2);
    width: 100%;
    margin-top: var(--space-3);
  }

  .agent-starter {
    display: flex;
    align-items: center;
    gap: var(--space-2-5);
    min-width: 0;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-lg);
    background: var(--bg);
    text-align: left;
  }

  .agent-starter:hover:not(:disabled) {
    border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
    background: color-mix(in srgb, var(--accent) 3%, var(--bg));
  }
  .agent-starter:focus-visible {
    outline: var(--focus-outline);
    outline-offset: 1px;
  }
  .agent-starter:disabled {
    opacity: var(--opacity-disabled);
    cursor: not-allowed;
  }
  .agent-starter-icon {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    border-radius: var(--radius-md);
    background: var(--elevated);
    color: var(--text-2);
  }

  .agent-starter-copy {
    display: flex;
    flex-direction: column;
    gap: 0;
    min-width: 0;
  }

  .agent-starter-title {
    overflow: hidden;
    color: var(--text);
    font-size: var(--text-label);
    font-weight: var(--weight-medium);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .agent-starter-text {
    overflow: hidden;
    color: var(--text-3);
    font-size: var(--text-caption);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .agent-starter-title-short {
    display: none;
  }
  .agent-turn {
    display: flex;
    flex: 0 0 auto;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
  }
  .agent-template-group {
    padding: var(--space-1-5) var(--space-2) var(--space-0-5);
    color: var(--text-3);
    font-size: var(--text-caption);
  }
  .agent-edit-note {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    margin: var(--space-2) var(--space-3) 0;
    color: var(--text-2);
    font-size: var(--text-label);
  }
  .agent-user-row.editing .agent-user {
    outline: 1px dashed var(--accent);
    outline-offset: 2px;
  }
  .agent-user-row {
    display: flex;
    align-items: flex-end;
    justify-content: flex-end;
    gap: var(--space-1-5);
  }
  .agent-user {
    min-width: 0;
    max-width: 80%;
    padding: var(--space-2-5) var(--space-3);
    border-radius: var(--radius-xl) var(--radius-xl) var(--radius-sm) var(--radius-xl);
    background: var(--elevated);
    color: var(--text);
    font-size: var(--text-title);
    line-height: var(--leading-relaxed);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    -webkit-user-select: text;
    user-select: text;
    cursor: text;
  }
  .agent-message-files {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: flex-end;
    align-self: flex-end;
    max-width: 100%;
    gap: var(--space-2);
    list-style: none;
  }
  .agent-message-file {
    min-width: 0;
    max-width: min(100%, 16rem);
  }
  .agent-file-button, .agent-file-label {
    display: flex;
    align-items: center;
    gap: var(--space-1-5);
    min-width: 0;
    max-width: 100%;
    height: auto;
    padding: var(--space-1-5) var(--space-2);
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--bg);
    color: var(--text-2);
    font-size: var(--text-label);
  }
  .agent-image-file {
    width: 6rem;
    height: 6rem;
    padding: 0;
    cursor: zoom-in;
  }
  .agent-image-file:hover:not(:disabled) {
    border-color: var(--text-3);
  }
  .agent-image-file img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .agent-image-file img.vector {
    padding: var(--space-3);
    object-fit: contain;
  }
  .agent-file-button svg, .agent-file-label svg {
    flex: 0 0 auto;
  }
  .agent-file-button span, .agent-file-label span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .agent-message-actions {
    display: flex;
    opacity: 0;
    transition: opacity var(--dur-fast);
  }
  .agent-user-row:hover .agent-message-actions,
  .agent-turn:hover .agent-answer-actions,
  .agent-message-actions:focus-within {
    opacity: 1;
  }
  .agent-copy {
    color: var(--text-3);
  }
  .agent-copy:hover:not(:disabled) {
    color: var(--text);
  }
  .agent-text {
    min-width: 0;
    font-size: var(--text-title);
    -webkit-user-select: text;
    user-select: text;
  }
  .agent-step-toggle {
    gap: var(--space-1-5);
    color: var(--text-2);
  }
  .agent-step-toggle svg {
    flex: 0 0 auto;
    color: var(--text-3);
    transition: transform var(--dur-fast);
  }
  .agent-step-toggle svg.open {
    transform: rotate(90deg);
  }
  .agent-thinking {
    margin-top: var(--space-1-5);
    padding-left: var(--space-3);
    border-left: 1px solid var(--border);
    color: var(--text-2);
    font-size: var(--text-label);
    line-height: var(--leading-relaxed);
    white-space: pre-wrap;
    -webkit-user-select: text;
    user-select: text;
  }
  .agent-steps {
    display: flex;
    flex-direction: column;
    min-width: 0;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    background: var(--bg);
  }
  .agent-tool {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .agent-tool + .agent-tool {
    border-top: 1px solid var(--border-subtle);
  }
  .agent-tool-row {
    display: flex;
    align-items: center;
    min-width: 0;
  }
  .agent-tool-toggle {
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
    min-height: 2.25rem;
    padding: var(--space-1-5) var(--space-3);
    border: none;
    border-radius: var(--radius-lg);
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: var(--text-body);
    text-align: left;
    cursor: pointer;
  }
  .agent-tool-toggle:hover {
    background: var(--hover);
  }
  .agent-tool-toggle:focus-visible {
    outline: var(--focus-outline);
    outline-offset: -2px;
  }
  .agent-tool-state {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    width: 1rem;
    color: var(--text-3);
  }
  .agent-tool-done {
    color: var(--s2xx);
  }
  .agent-tool-failed {
    color: var(--danger);
  }
  .agent-tool-waiting {
    color: var(--accent-text);
  }
  .agent-tool-label {
    flex: 0 1 auto;
    min-width: 0;
    max-width: 50%;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text-2);
    white-space: nowrap;
  }
  .agent-tool-target {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    font-weight: var(--weight-medium);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .agent-tool-name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    color: var(--text-3);
    font-family: var(--font-mono);
    font-size: var(--text-caption);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .agent-tool-status {
    flex: 0 0 auto;
    padding: 0 var(--space-1-5);
    border-radius: var(--radius-sm);
    background: var(--elevated);
    color: var(--text-2);
    font-family: var(--font-mono);
    font-size: var(--text-caption);
    font-weight: var(--weight-medium);
    line-height: 1.6;
  }
  .agent-tool-status.ok {
    background: var(--success-bg);
    color: var(--s2xx);
  }
  .agent-tool-status.warn {
    background: var(--warning-bg);
    color: var(--s4xx);
  }
  .agent-tool-status.bad {
    background: var(--danger-bg);
    color: var(--s5xx);
  }
  .agent-tool-time {
    flex: 0 0 auto;
    color: var(--text-3);
    font-family: var(--font-mono);
    font-size: var(--text-caption);
  }
  .agent-tool-chevron {
    flex: 0 0 auto;
    color: var(--text-3);
    transition: transform var(--dur-fast);
  }
  .agent-tool-chevron.open {
    transform: rotate(90deg);
  }
  .agent-tool-open {
    flex: 0 0 auto;
    margin: 0 var(--space-3) 0 var(--space-1);
    font-size: var(--text-caption);
  }
  .agent-tool-body {
    margin: 0 var(--space-3) var(--space-2-5) calc(var(--space-3) + 1rem + var(--space-2));
    max-height: 18rem;
    overflow: auto;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    background: var(--surface);
    color: var(--text-2);
    font-family: var(--font-mono);
    font-size: var(--text-code);
    line-height: var(--leading-relaxed);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    -webkit-user-select: text;
    user-select: text;
  }
  .agent-tool-result {
    color: var(--text);
  }
  .agent-tool-approval {
    padding: 0 var(--space-3) var(--space-3);
  }
  .agent-waiting {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--text-3);
    font-size: var(--text-label);
  }
  .agent-error {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-1) var(--space-2);
    padding: var(--space-2-5) var(--space-3);
    border: 1px solid var(--danger-border);
    border-radius: var(--radius-lg);
    background: var(--danger-bg-subtle);
    color: var(--text);
    font-size: var(--text-label);
    -webkit-user-select: text;
    user-select: text;
  }
  .agent-error strong {
    font-weight: var(--weight-semibold);
  }
  .agent-error-status {
    font-family: var(--font-mono);
    font-size: var(--text-caption);
  }
  .agent-error-message {
    flex: 1 1 100%;
    min-width: 0;
    color: var(--text-2);
  }
  .agent-error-hint {
    flex: 1 1 100%;
    color: var(--text-3);
    font-size: var(--text-caption);
  }
  .agent-note {
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    color: var(--text-2);
    font-size: var(--text-label);
  }
  .agent-composer {
    position: relative;
    z-index: 1;
    display: flex;
    flex: 0 0 auto;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
    margin-top: calc(var(--space-2) * -1);
    padding: var(--space-2) var(--agent-gutter) var(--space-3);
    pointer-events: none;
  }
  .agent-composer > * {
    pointer-events: auto;
  }
  .agent-status {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 0 var(--space-1);
    font-size: var(--text-label);
  }
  .agent-status-wait {
    color: var(--s4xx);
  }
  .agent-status-dot {
    flex: 0 0 auto;
    width: 0.5rem;
    height: 0.5rem;
    border-radius: var(--radius-full);
    background: currentColor;
  }
  .agent-composer-box {
    position: relative;
    display: flex;
    flex-direction: column;
    min-width: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-xl);
    background: var(--bg);
    box-shadow: var(--shadow-composer);
    transition: border-color var(--dur-fast), box-shadow var(--dur-fast);
  }
  .agent-composer-box:focus-within {
    border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
  }
  .agent-composer-box:global(.wails-drop-target-active) {
    border-color: var(--accent);
  }
  .agent-composer-box.disabled {
    opacity: var(--opacity-disabled);
  }
  .agent-input {
    min-height: calc(var(--text-body) * var(--leading-normal) + var(--space-3) * 2);
    max-height: clamp(3rem, 20vh, 12rem);
    min-width: 0;
    width: 100%;
    padding: var(--space-3) var(--space-4);
    border: none;
    outline: none;
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: var(--text-body);
    line-height: var(--leading-normal);
    resize: none;
    scrollbar-gutter: stable;
  }

  @supports (hanging-punctuation: first) {
    .agent-input,
    .agent-chat,
    .agent-context-panel {
      overflow-y: scroll;
    }
  }
  .agent-input::placeholder {
    color: var(--text-3);
  }
  .agent-context-files {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    padding: 0 var(--space-2) var(--space-1);
  }

  .agent-context-file {
    gap: var(--space-1);
    max-width: 100%;
  }

  .agent-context-file span:first-child {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .agent-composer-bar {
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    gap: var(--space-1) var(--space-2);
    min-width: 0;
    padding: 0 var(--space-2) var(--space-2);
  }

  .agent-composer-context {
    display: flex;
    flex: 1 1 10rem;
    align-items: center;
    gap: var(--space-1);
    min-width: 0;
  }

  .agent-composer-chip {
    position: relative;
    display: inline-flex;
    flex: 0 1 auto;
    min-width: 2.5rem;
    max-width: 11rem;
  }
  .agent-composer-chip-icon {
    display: none;
    position: absolute;
    z-index: 1;
    top: 50%;
    left: var(--space-2);
    color: var(--text-2);
    pointer-events: none;
    transform: translateY(-50%);
  }
  .agent-composer-chip.compact {
    flex: 0 0 auto;
    min-width: 0;
  }
  .agent-composer-chip.compact .agent-composer-chip-icon {
    display: block;
  }
  .agent-composer-chip.compact:hover .agent-composer-chip-icon {
    color: var(--text);
  }
  .agent-composer-chip.compact :global(.agent-chip .app-select-trigger) {
    gap: 0;
    padding-left: calc(var(--space-2) + 0.875rem + var(--space-1));
  }
  .agent-composer-chip.compact :global(.agent-chip .app-select-trigger > span) {
    display: none;
  }

  .agent-composer-chip :global(.agent-chip) {
    min-width: 0;
    width: 100%;
  }
  .agent-composer-chip :global(.agent-chip .app-select-trigger) {
    height: var(--control-md);
    max-width: 100%;
    width: 100%;
    padding: 0 var(--space-2);
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    color: var(--text-2);
    font-size: var(--text-label);
  }
  .agent-composer-chip :global(.agent-chip .app-select-trigger:not(.env-colored)) {
    background: transparent;
  }
  .agent-composer-chip :global(.agent-chip .app-select-trigger > span:not(.env-color-dot)) {
    flex: 1 1 auto;
    text-align: left;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .agent-composer :global(.agent-chip .app-select-check) {
    display: none;
  }
  .agent-composer :global(.agent-effort .app-select-trigger) {
    min-width: 0;
    max-width: 100%;
    width: 100%;
    height: var(--control-md);
    padding: 0 var(--space-2);
    border-color: transparent;
    background: transparent;
    font-size: var(--text-label);
  }
  .agent-composer :global(.agent-effort) {
    flex: 0 0 auto;
    min-width: 0;
    max-width: 7rem;
  }
  .agent-composer-bar.compact .agent-branch-label {
    display: none;
  }
  .agent-composer-bar.tight {
    flex-wrap: wrap;
  }
  .agent-composer-bar.compact :global(.agent-picker) {
    min-width: 4rem;
  }
  .agent-composer :global(.agent-effort .app-select-trigger > span) {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .agent-composer-actions {
    display: flex;
    flex: 0 1 auto;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-1);
    min-width: 0;
    margin-left: auto;
  }
  .agent-composer-chip :global(.agent-chip .app-select-trigger:hover:not(:disabled):not(.env-colored)),
  .agent-composer :global(.agent-effort .app-select-trigger:hover:not(:disabled)) {
    background: var(--hover);
    color: var(--text);
  }
  .agent-composer-actions :global(.agent-picker) {
    flex: 0 1 auto;
    max-width: 16rem;
  }
  .agent-composer-actions :global(.agent-picker-trigger) {
    height: var(--control-md);
    border-color: transparent;
    background: transparent;
  }
  .agent-composer-actions :global(.agent-picker-trigger:hover:not(:disabled)) {
    background: var(--hover);
  }
  .agent-send,
  .agent-stop {
    flex: 0 0 auto;
    width: var(--control-md);
    height: var(--control-md);
    border-radius: var(--radius-full);
  }

  .agent-templates {
    flex: 0 0 auto;
  }

  .agent-templates-btn {
    color: var(--text-2);
  }

  .agent-templates-menu {
    position: absolute;
    bottom: calc(100% + var(--space-1));
    left: 0;
    z-index: 140;
    width: min(26rem, 100%);
    max-height: min(24rem, 50vh);
    overflow-y: auto;
  }
  .agent-template {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-0-5);
    width: 100%;
    height: auto;
    padding-top: var(--space-1-5);
    padding-bottom: var(--space-1-5);
    white-space: normal;
    text-align: left;
  }
  .agent-template-title {
    color: var(--text);
  }
  .agent-template-text {
    color: var(--text-3);
    font-size: var(--text-caption);
    line-height: var(--leading-normal);
  }
  .agent-composer-hint {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    color: var(--text-3);
    font-size: var(--text-caption);
    text-align: right;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .agent-composer-hint kbd {
    font-family: var(--font-mono);
  }
  .agent-session-status { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1) var(--space-3); padding: 0 var(--space-1); color: var(--text-3); font-size: var(--text-caption); font-variant-numeric: tabular-nums; }
  .agent-plan-mini { color: var(--text-3); font-size: var(--text-caption); text-decoration: none; }
  .agent-plan-mini:hover { color: var(--text); }
  .agent-plan-mini.low { color: var(--s4xx); }
  .agent-quota-bar { display: inline-block; width: 3rem; height: 0.25rem; overflow: hidden; border-radius: var(--radius-full); background: var(--border-subtle); }
  .agent-quota-bar-wide { display: block; width: 100%; height: 0.375rem; }
  .agent-quota-fill { display: block; height: 100%; background: var(--accent); }
  .agent-quota-fill.low { background: var(--s4xx); }
  .agent-detail-meter { display: flex; flex-direction: column; gap: var(--space-1); font-size: var(--text-label); }
  .agent-detail-meter-head { display: flex; justify-content: space-between; gap: var(--space-2); color: var(--text-3); }
  .agent-detail-meter-head > span:last-child { color: var(--text); font-variant-numeric: tabular-nums; }
  .agent-detail-meter-note { color: var(--text-3); font-size: var(--text-caption); }
  .agent-detail-note { margin: 0; color: var(--text-3); font-size: var(--text-caption); }
  .agent-detail-field {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    font-size: var(--text-label);
  }
  .agent-detail-field > span {
    flex: 0 0 auto;
    color: var(--text-3);
  }
  .agent-detail-stack {
    flex-direction: column;
    align-items: stretch;
    gap: var(--space-1);
  }
  .agent-detail-field :global(.agent-detail-select) {
    min-width: 0;
    max-width: 10rem;
  }
  .agent-detail-number {
    width: 7rem;
    text-align: right;
  }
  .agent-send:disabled {
    background: var(--elevated);
    color: var(--text-3);
    opacity: 1;
  }
  .agent-turn-actions {
    display: flex;
    gap: var(--space-1-5);
  }
  .agent-compact-divider {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: var(--space-2) 0 var(--space-4);
    color: var(--text-3);
    font-size: var(--text-caption);
  }
  .agent-compact-divider::before,
  .agent-compact-divider::after {
    content: '';
    flex: 1 1 auto;
    height: 1px;
    background: var(--border-subtle);
  }
  .agent-compact {
    align-self: flex-start;
  }
  .agent-summary-toggle {
    align-self: flex-start;
    font-size: var(--text-caption);
  }
  .agent-summary-text {
    max-height: 16rem;
    overflow: auto;
    padding: var(--space-2);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    color: var(--text-2);
    font-size: var(--text-caption);
    line-height: var(--leading-normal);
    white-space: pre-wrap;
    user-select: text;
    -webkit-user-select: text;
  }
  .agent-earlier {
    display: flex;
    justify-content: center;
    padding: var(--space-2) 0;
  }
  .agent-history-error {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .agent-context-panel {
    display: flex;
    width: var(--agent-details-w);
    height: 100%;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-4);
    border-left: 1px solid var(--border-subtle);
    background: var(--bg);
  }
  .agent-context-panel:focus {
    outline: none;
  }
  .agent-context-panel.cover {
    border-left: none;
  }


  .agent-branch-toggle {
    gap: var(--space-1);
    color: var(--text-3);
  }
  .agent-branch-toggle.on {
    background: var(--accent-dim);
    color: var(--accent-text);
  }
  .agent-kv-mono {
    font-family: var(--font-mono);
    font-size: var(--text-code);
    overflow-wrap: anywhere;
  }
  .agent-pull-request {
    align-self: flex-start;
  }
  .agent-detail-note.agent-detail-error {
    color: var(--danger);
  }
  .agent-details-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-2);
    color: var(--text);
    font-size: var(--text-body);
    font-weight: var(--weight-semibold);
  }


  .agent-limits {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .agent-context-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .agent-context-label {
    margin: 0;
    color: var(--text-3);
    font-size: var(--text-caption);
    font-weight: var(--weight-medium);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .agent-kv {
    display: flex;
    justify-content: space-between;
    gap: var(--space-2);
    font-size: var(--text-label);
  }
  .agent-kv > span:first-child {
    flex: 0 0 auto;
    color: var(--text-3);
  }
  .agent-kv > span:last-child {
    min-width: 0;
    color: var(--text);
    text-align: right;
    overflow-wrap: anywhere;
  }
  .agent-kv-lock {
    margin-left: var(--space-1);
    color: var(--s4xx);
    vertical-align: -0.0625rem;
  }
  .agent-context-item {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
    font-size: var(--text-label);
  }
  .agent-context-item-name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    color: var(--text);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .agent-context-item-meta {
    flex: 0 0 auto;
    color: var(--text-3);
  }
  .agent-context-item-meta.wait {
    color: var(--s4xx);
  }
  .agent-dot {
    flex: 0 0 auto;
    width: 0.375rem;
    height: 0.375rem;
    border-radius: var(--radius-full);
    background: var(--s2xx);
  }
  .agent-dot.wait {
    background: var(--s4xx);
  }
  .agent-context-method {
    flex: 0 0 auto;
    color: var(--get);
    font-family: var(--font-mono);
    font-size: var(--text-caption);
    font-weight: var(--weight-medium);
  }
  .agent-context-quota {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--text-2);
    font-size: var(--text-label);
    font-variant-numeric: tabular-nums;
  }
  .agent-onboarding {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    width: min(44rem, calc(100% - var(--space-8)));
    margin: auto;
  }
  .agent-onboarding-title {
    margin: 0;
    color: var(--text);
    font-size: var(--text-title);
    font-weight: var(--weight-semibold);
  }
  .agent-onboarding-text {
    margin: 0;
    color: var(--text-2);
    font-size: var(--text-label);
    line-height: var(--leading-relaxed);
  }
  .agent-onboarding-cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr));
    gap: var(--space-2-5);
    margin-top: var(--space-2);
  }
  .agent-onboarding-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-1-5);
    padding: var(--space-3);
  }
  .agent-onboarding-card strong {
    color: var(--text);
    font-size: var(--text-body);
    font-weight: var(--weight-medium);
  }
  .agent-onboarding-card span {
    color: var(--text-2);
    font-size: var(--text-caption);
    line-height: var(--leading-normal);
  }
  @container agent (max-width: 36rem) {
    .agent-header {
      min-height: 2.75rem;
      gap: var(--space-2);
      padding-inline: var(--space-3);
    }
  }
  @container agent-main (max-width: 40rem) {
    .agent-chat {
      padding: var(--space-4) var(--space-3) calc(var(--space-3) + var(--space-2));
    }
    .agent-composer {
      padding: var(--space-2) var(--space-3) var(--space-3);
    }
  }
  @container agent-main (max-width: 30rem) {
    .agent-starters {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .agent-starter {
      justify-content: center;
      min-height: 2.25rem;
      text-align: center;
    }
    .agent-starter-title-short {
      display: block;
    }
    .agent-starter-text,
    .agent-starter-title-full,
    .agent-starter-icon,
    .agent-composer-hint,
    .agent-tool-time {
      display: none;
    }
  }
  @media (max-height: 44rem) {
    .agent-starter-text {
      display: none;
    }
  }
  @media (max-height: 36rem) {
    .agent-empty {
      padding-block: var(--space-2);
    }
    .agent-empty-icon,
    .agent-empty-rules {
      display: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .agent-step-toggle svg,
    .agent-tool-chevron {
      transition: none;
    }
  }
</style>
