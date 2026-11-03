import {
  agentChatPage, agentChats, agentPendingApprovals, answerAgentApproval, deleteAgentChat,
  onAgentEvent, renameAgentChat, sendAgentMessage, stopAgent,
  type AgentContext, type AgentApproval, type AgentApprovalClosed, type AgentChat, type AgentChatSummary,
  type AiBlock, type AiStep, type AiUsage,
} from '../backend';
import { agentHistoryPage, mergeAgentHistory } from '../agentHistory';
import { SvelteMap } from 'svelte/reactivity';
import { applyAiDeltas, emptyAiUsage, emptyStepView, stepViewFrom, type AiDelta, type AiTurn } from './features/ai';

export type AgentNotes = { chatId: string; error: string; warnings: string[] };

type WorkspaceChatView = {
  activeChatId: string;
  activeChat: AgentChat | null;
  draft: string;
  collection: string;
  environment: string;
  connectionId: string;
  model: string;
  effort: string;
  context: AgentContext | null;
  notes: AgentNotes | null;
  loadError: string;
};

function newTurnId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `turn-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export class AgentStore {
 constructor(readonly driver = '') {}
 model = $state('');
 effort = $state('');
  context = $state<AgentContext | null>(null);
  chats = $state<AgentChatSummary[]>([]);
  chatsLoaded = $state(false);
  activeChatId = $state('');
  activeChat = $state<AgentChat | null>(null);
  live = $state<AiTurn | null>(null);
  liveChatId = $state('');
  approvals = $state<AgentApproval[]>([]);
  notes = $state<AgentNotes | null>(null);
  collection = $state('');
  environment = $state('');
  connectionId = $state('');
  draft = $state('');
  loadError = $state('');
  historyError = $state('');
  loadingEarlier = $state(false);
  compacting = $state(false);
  private historyRequest = 0;
  workspaceId = $state('');

  private listening = false;
  private generation = 0;
  private refreshId = 0;
  private stopRequested = '';
  private liveWorkspaceId = '';
  private liveContext: AgentContext | null = null;
  private views = new SvelteMap<string, WorkspaceChatView>();
  private collectionNames: string[] = [];
  private environmentNames: string[] = [];

  syncWorkspaceSelection(workspaceId: string, collections: string[], environments: string[], activeEnvironment: string) {
    this.collectionNames = collections;
    this.environmentNames = environments;
    if (this.workspaceId !== workspaceId) {
      if (this.workspaceId) this.views.set(this.workspaceId, this.captureView(true));
      this.historyRequest++;
      this.loadingEarlier = false;
      this.historyError = '';
      this.workspaceId = workspaceId;
      const saved = this.views.get(workspaceId);
      if (saved) this.restoreView(saved);
      else {
        this.newChat();
        this.draft = '';
        this.collection = '';
        this.environment = activeEnvironment;
      }
      if (this.liveWorkspaceId === workspaceId) this.context = this.liveContext;
      this.chats = [];
      this.chatsLoaded = false;
      void this.refreshChats();
    }
    if (this.collection && !collections.includes(this.collection)) this.collection = '';
    if (this.environment && !environments.includes(this.environment)) this.environment = '';
  }

  private captureView(trimHistory = false): WorkspaceChatView {
    return {
      activeChatId: this.activeChatId, activeChat: trimHistory && this.activeChat ? agentHistoryPage(this.activeChat) : this.activeChat, draft: this.draft,
      collection: this.collection, environment: this.environment, connectionId: this.connectionId,
      model: this.model, effort: this.effort, context: this.context, notes: this.notes, loadError: this.loadError,
    };
  }

  private restoreView(view: WorkspaceChatView) {
    this.activeChatId = view.activeChatId;
    this.activeChat = view.activeChat;
    this.draft = view.draft;
    this.collection = view.collection;
    this.environment = view.environment;
    this.connectionId = view.connectionId;
    this.model = view.model;
    this.effort = view.effort;
    this.context = view.context;
    this.notes = view.notes;
    this.loadError = view.loadError;
  }

  private updateView(workspaceId: string, generation: number, change: (view: WorkspaceChatView) => void) {
    if (generation !== this.generation) return;
    const current = this.workspaceId === workspaceId;
    const view = current ? this.captureView() : this.views.get(workspaceId);
    if (!view) return;
    change(view);
    if (current) this.restoreView(view);
    else this.views.set(workspaceId, { ...view, activeChat: view.activeChat ? agentHistoryPage(view.activeChat) : null });
  }

  get running(): boolean {
    return this.live?.status === 'streaming';
  }

  get liveInActiveChat(): boolean {
    return Boolean(this.live) && this.liveWorkspaceId === this.workspaceId && this.liveChatId === this.activeChatId;
  }

  get activeApprovals(): AgentApproval[] {
    return this.approvals.filter(approval => approval.chatId === this.activeChatId || (!this.activeChatId && this.liveWorkspaceId === this.workspaceId && approval.turnId === this.live?.id));
  }

  get usage(): AiUsage {
    return this.activeChat?.usage ?? emptyAiUsage();
  }

  init() {
    if (this.listening) return;
    this.listening = true;
    onAgentEvent<{ sessionId: string; turnId?: string; deltas: AiDelta[] }>('ai:deltas', payload => {
      if (!this.matches(payload.sessionId, payload.turnId) || !payload.deltas?.length) return;
      this.updateLive(turn => applyAiDeltas(turn, payload.deltas));
    });
    onAgentEvent<{ sessionId: string; turnId?: string; step: AiStep }>('ai:step', payload => {
      if (!this.matches(payload.sessionId, payload.turnId)) return;
      this.updateLive(turn => {
        const steps = turn.steps.slice();
        while (steps.length <= payload.step.index) steps.push(emptyStepView(steps.length));
        steps[payload.step.index] = { ...stepViewFrom(payload.step), toolResults: steps[payload.step.index].toolResults };
        return { ...turn, steps };
      });
    });
    onAgentEvent<{ sessionId: string; turnId?: string; step: number; block: AiBlock }>('ai:tool', payload => {
      if (!this.matches(payload.sessionId, payload.turnId)) return;
      this.updateLive(turn => {
        const steps = turn.steps.slice();
        while (steps.length <= payload.step) steps.push(emptyStepView(steps.length));
        steps[payload.step] = { ...steps[payload.step], toolResults: [...steps[payload.step].toolResults, payload.block] };
        return { ...turn, steps };
      });
    });
    onAgentEvent<{ chatId: string; turnId: string; active: boolean }>('agent:compaction', payload => {
      if (!this.matches(payload.chatId, payload.turnId)) return;
      this.compacting = payload.active;
    });
    onAgentEvent<AgentContext>('agent:context', context => {
      if (!this.matches(context.chatId, context.turnId)) return;
      this.liveContext = context;
      if (this.liveWorkspaceId === this.workspaceId) this.context = context;
    });
    onAgentEvent<AgentApproval>('agent:approval', approval => {
      if (!this.matches(approval.chatId, approval.turnId)) return;
      if (this.approvals.some(existing => existing.id === approval.id)) return;
      this.approvals = [...this.approvals, approval];
    });
    onAgentEvent<AgentApprovalClosed>('agent:approval-closed', closed => {
      this.approvals = this.approvals.filter(approval => approval.id !== closed.id);
    });
  }

  private matches(sessionId: string, turnId?: string): boolean {
    const live = this.live;
    if (!live || live.status !== 'streaming' || !turnId || turnId !== live.id) return false;
    if (this.liveChatId && sessionId && this.liveChatId !== sessionId) return false;
    if (!this.liveChatId && sessionId) {
      this.liveChatId = sessionId;
      if (this.stopRequested === live.id) void stopAgent(sessionId, live.id);
      this.updateView(this.liveWorkspaceId, this.generation, view => {
        if (!view.activeChatId) view.activeChatId = sessionId;
      });
      void this.refreshChats();
    }
    return true;
  }

  private updateLive(change: (turn: AiTurn) => AiTurn) {
    if (this.live) this.live = change(this.live);
  }

  async refreshChats() {
    const workspaceId = this.workspaceId;
    const generation = this.generation;
    const refreshId = ++this.refreshId;
    try {
      const chats = await agentChats(workspaceId);
      if (this.workspaceId !== workspaceId || this.generation !== generation || this.refreshId !== refreshId) return;
      this.chats = chats.filter(chat => chat.workspaceId === workspaceId && (chat.driver ?? '') === this.driver);
    } finally {
      if (this.workspaceId === workspaceId && this.generation === generation && this.refreshId === refreshId) this.chatsLoaded = true;
    }
  }

  newChat() {
    this.historyRequest++;
    this.loadingEarlier = false;
    this.historyError = '';
    this.context = null;
    this.activeChatId = '';
    this.activeChat = null;
    this.notes = null;
    this.loadError = '';
  }

  async openChat(id: string) {
    if (!id) return this.newChat();
    const workspaceId = this.workspaceId;
    const generation = this.generation;
    const collectionNames = this.collectionNames;
    const environmentNames = this.environmentNames;
    this.historyRequest++;
    this.loadingEarlier = false;
    this.historyError = '';
    this.activeChatId = id;
    this.notes = this.notes?.chatId === id ? this.notes : null;
    this.loadError = '';
    try {
      const chat = await agentChatPage(id);
      if (chat.workspaceId !== workspaceId) throw new Error('This chat belongs to another workspace.');
      this.updateView(workspaceId, generation, view => {
        if (view.activeChatId !== id) return;
        view.activeChat = chat;
        view.model = chat.model;
        view.effort = chat.effort ?? '';
        view.collection = (this.workspaceId === workspaceId ? this.collectionNames : collectionNames).includes(chat.collection) ? chat.collection : '';
        view.environment = (this.workspaceId === workspaceId ? this.environmentNames : environmentNames).includes(chat.environment) ? chat.environment : '';
        if (chat.connectionId) view.connectionId = chat.connectionId;
      });
      const pending = await agentPendingApprovals(id);
      if (generation !== this.generation) return;
      const known = this.approvals.map(approval => approval.id);
      this.approvals = [...this.approvals, ...pending.filter(approval => !known.includes(approval.id))];
    } catch (error) {
      this.updateView(workspaceId, generation, view => {
        if (view.activeChatId !== id) return;
        view.activeChat = null;
        view.loadError = error instanceof Error ? error.message : String(error);
      });
    }
  }

  async loadEarlier(): Promise<boolean> {
    const chat = this.activeChat;
    if (!chat || !chat.messageOffset || this.loadingEarlier) return false;
    const workspaceId = this.workspaceId;
    const request = ++this.historyRequest;
    this.loadingEarlier = true;
    this.historyError = '';
    try {
      const page = await agentChatPage(chat.id, chat.messageOffset);
      if (request !== this.historyRequest || this.workspaceId !== workspaceId || this.activeChatId !== chat.id || this.activeChat !== chat) return false;
      if (page.workspaceId !== workspaceId || page.id !== chat.id || (page.messageOffset ?? 0) >= chat.messageOffset || (page.messageOffset ?? 0) + page.messages.length !== chat.messageOffset) throw new Error('Could not load earlier messages. Try again.');
      this.activeChat = mergeAgentHistory(chat, page);
      return true;
    } catch (error) {
      if (request === this.historyRequest) this.historyError = error instanceof Error ? error.message : String(error);
      return false;
    } finally {
      if (request === this.historyRequest) this.loadingEarlier = false;
    }
  }

  async send(text = this.draft): Promise<boolean> {
    const prompt = text.trim();
    if (!prompt || this.running) return false;
    if (text === this.draft) this.draft = '';
    const chatId = this.activeChatId;
    const workspaceId = this.workspaceId;
    const generation = this.generation;
    const turn: AiTurn = { id: newTurnId(), prompt, startedAt: Date.now(), status: 'streaming', steps: [], response: null, error: '' };
    this.context = null;
    this.stopRequested = '';
    this.compacting = false;
    this.live = turn;
    this.liveChatId = chatId;
    this.liveWorkspaceId = workspaceId;
    this.liveContext = null;
    this.notes = null;
    try {
      const result = await sendAgentMessage({
        chatId,
        workspaceId,
        turnId: turn.id,
        text: prompt,
        collection: this.collection,
        environment: this.environment,
        connectionId: this.connectionId,
        model: this.model,
        ...(this.driver ? { driver: this.driver, effort: this.effort } : {}),
      });
      const resultChatId = result.chat?.id || this.liveChatId;
      const stopped = /cancel/i.test(result.error ?? '');
      this.updateView(workspaceId, generation, view => {
        if (result.chat?.id && result.chat.workspaceId === workspaceId && (view.activeChatId === chatId || view.activeChatId === resultChatId)) {
          view.activeChatId = result.chat.id;
          view.activeChat = mergeAgentHistory(view.activeChat, result.chat);
        }
        view.notes = { chatId: resultChatId, error: stopped ? '' : (result.error ?? ''), warnings: result.warnings ?? [] };
        if (!result.chat?.id && !chatId && !view.draft) view.draft = prompt;
      });
    } catch (error) {
      this.updateView(workspaceId, generation, view => {
        view.notes = { chatId, error: error instanceof Error ? error.message : String(error), warnings: [] };
        if (!chatId && !view.draft) view.draft = prompt;
      });
    } finally {
      if (this.live?.id === turn.id) {
        this.compacting = false;
        this.live = null;
        this.liveChatId = '';
        this.liveWorkspaceId = '';
        this.liveContext = null;
      }
      this.approvals = this.approvals.filter(approval => approval.turnId !== turn.id);
      void this.refreshChats();
    }
    return true;
  }

  async stop() {
    const turnId = this.live?.id ?? '';
    this.stopRequested = turnId;
    await stopAgent(this.liveChatId || this.activeChatId, turnId);
  }

  async answer(id: string, decision: 'allow' | 'allow_chat' | 'reject') {
    const result = await answerAgentApproval(id, decision);
    if (!result.ok) throw new Error(result.error || 'Could not send your decision. Try again.');
  }

  async rename(id: string, title: string): Promise<string> {
    const workspaceId = this.workspaceId;
    const generation = this.generation;
    const name = title.trim().replace(/\s+/g, ' ');
    if (!name) return 'Enter a name for the chat.';
    const result = await renameAgentChat(id, name);
    if (!result.ok) return result.error ?? 'Kurlo could not rename the chat.';
    this.chats = this.chats.map(chat => chat.id === id ? { ...chat, title: name } : chat);
    this.updateView(workspaceId, generation, view => {
      if (view.activeChat?.id === id) view.activeChat = { ...view.activeChat, title: name };
    });
    return '';
  }

  async retry(): Promise<boolean> {
    const turns = this.activeChat?.messages ?? [];
    const last = [...turns].reverse().find(message => message.role === 'user');
    const text = (last?.blocks ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join('\n');
    return text ? this.send(text) : this.send();
  }

  async remove(id: string) {
    const workspaceId = this.workspaceId;
    const generation = this.generation;
    const result = await deleteAgentChat(id);
    if (!result.ok) return;
    this.chats = this.chats.filter(chat => chat.id !== id);
    this.updateView(workspaceId, generation, view => {
      if (view.activeChatId !== id) return;
      view.activeChatId = '';
      view.activeChat = null;
      view.context = null;
      view.notes = null;
      view.loadError = '';
    });
  }

  reset() {
    if (this.running) void this.stop();
    this.generation++;
    this.workspaceId = '';
    this.views.clear();
    this.compacting = false;
    if (!this.driver) workspaceModes.clear();
    this.live = null;
    this.liveChatId = '';
    this.liveWorkspaceId = '';
    this.liveContext = null;
    this.collection = '';
    this.environment = '';
    this.draft = '';
    this.chats = [];
    this.chatsLoaded = false;
    this.newChat();
    this.approvals = [];
    if (this.listening) void this.refreshChats();
  }
}

export const agentStore = new AgentStore();

export const codexAgentStore = new AgentStore('codex');
export const claudeAgentStore = new AgentStore('claude-code');
export type AgentMode = 'kurlo' | 'external' | 'claude';

const AGENT_DETAILS_KEY = 'kurlo.agentDetails.v1';

function savedAgentDetails(): boolean {
  try {
    return localStorage.getItem(AGENT_DETAILS_KEY) === '1';
  } catch {
    return false;
  }
}

export const agentNavigation = $state({ mode: 'kurlo' as AgentMode, detailsOpen: savedAgentDetails() });

const workspaceModes = new SvelteMap<string, AgentMode>();

export function syncAgentWorkspace(workspaceId: string, collections: string[], environments: string[], activeEnvironment: string) {
  if (agentStore.workspaceId !== workspaceId) {
    if (agentStore.workspaceId) workspaceModes.set(agentStore.workspaceId, agentNavigation.mode);
    agentNavigation.mode = workspaceModes.get(workspaceId) ?? agentNavigation.mode;
  }
  for (const store of [agentStore, codexAgentStore, claudeAgentStore]) store.syncWorkspaceSelection(workspaceId, collections, environments, activeEnvironment);
}

export function toggleAgentDetails() {
  agentNavigation.detailsOpen = !agentNavigation.detailsOpen;
  try {
    localStorage.setItem(AGENT_DETAILS_KEY, agentNavigation.detailsOpen ? '1' : '0');
  } catch {}
}

export function agentStoreFor(mode: AgentMode): AgentStore {
  return mode === 'external' ? codexAgentStore : mode === 'claude' ? claudeAgentStore : agentStore;
}

export function agentModeFor(driver: string | undefined): AgentMode {
  return driver === 'codex' ? 'external' : driver === 'claude-code' ? 'claude' : 'kurlo';
}

export function switchAgent(mode: AgentMode) {
  if (agentNavigation.mode === mode) return;
  const from = agentStoreFor(agentNavigation.mode);
  const to = agentStoreFor(mode);
  if (!from.activeChatId) {
    to.newChat();
    if (from.draft) to.draft = from.draft;
    from.draft = '';
    to.collection = from.collection;
    to.environment = from.environment;
  }
  agentNavigation.mode = mode;
}
