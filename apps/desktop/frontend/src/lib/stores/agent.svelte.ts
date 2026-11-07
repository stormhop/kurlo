import {
  agentChatPage, agentChats, agentPendingApprovals, answerAgentApproval, branchAgentChat, compactAgentChat, deleteAgentChat,
  onAgentEvent, renameAgentChat, sendAgentMessage, setAgentChatArchived, stopAgent,
  type AgentContext, type AgentApproval, type AgentApprovalClosed, type AgentAttachment, type AgentChat, type AgentChatSummary,
  type AiBlock, type AiStep, type AiUsage,
} from '../backend';
import { agentHistoryPage, mergeAgentHistory } from '../agentHistory';
import { SvelteMap } from 'svelte/reactivity';
import { applyAiDeltas, emptyAiUsage, emptyStepView, isAiStepIndex, stepViewFrom, type AiDelta, type AiTurn } from './features/ai';

export type AgentNotes = { chatId: string; error: string; warnings: string[] };

type LiveTurn = {
  turn: AiTurn;
  chatId: string;
  workspaceId: string;
  composer: symbol;
  history: AgentChat | null;
  context: AgentContext | null;
  attachments: AgentAttachment[];
  compacting: boolean;
  stopRequested: boolean;
};

export type AgentEditTarget = { index: number; text: string };

type WorkspaceChatView = {
  activeChatId: string;
  activeChat: AgentChat | null;
  composer: symbol;
  projectRoot: string;
  attachmentPaths: string[];
  collection: string;
  environment: string;
  ownBranch: boolean;
  connectionId: string;
  model: string;
  effort: string;
  mode: string;
  allowedHosts: string[];
  budgetTokens: number;
  budgetRequests: number;
  editing: AgentEditTarget | null;
  context: AgentContext | null;
  notes: AgentNotes | null;
  loadError: string;
};

function chatMessageCount(chat: AgentChat | null | undefined): number {
  return chat?.messageCount ?? (chat?.messageOffset ?? 0) + (chat?.messages?.length ?? 0);
}

export function agentChatBefore(chat: AgentChat, index: number): AgentChat {
  const offset = chat.messageOffset ?? 0;
  const keep = Math.max(0, index - offset);
  return { ...chat, messages: chat.messages.slice(0, keep), messageCount: Math.min(chatMessageCount(chat), index) };
}

const AGENT_DRAFTS_KEY = 'kurlo.agentDrafts.v1';

function savedAgentDrafts(): Record<string, string> {
  try {
    const value = JSON.parse(localStorage.getItem(AGENT_DRAFTS_KEY) ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

const agentDrafts = new SvelteMap<string, string>(Object.entries(savedAgentDrafts()).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[1])));

function storeAgentDrafts() {
  try {
    if (agentDrafts.size) localStorage.setItem(AGENT_DRAFTS_KEY, JSON.stringify(Object.fromEntries(agentDrafts)));
    else localStorage.removeItem(AGENT_DRAFTS_KEY);
  } catch {}
}

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
  turns = new SvelteMap<string, LiveTurn>();
  approvals = $state<AgentApproval[]>([]);
  notes = $state<AgentNotes | null>(null);
  collection = $state('');
  environment = $state('');
  ownBranch = $state(false);
  mode = $state('');
  allowedHosts = $state<string[]>(['localhost', '127.0.0.1']);
  budgetTokens = $state(0);
  budgetRequests = $state(0);
  editing = $state<AgentEditTarget | null>(null);
  connectionId = $state('');
  projectRoot = $state('');
  attachmentPaths = $state<string[]>([]);
  loadError = $state('');
  historyError = $state('');
  loadingEarlier = $state(false);
  compactingChat = $state('');
  private historyRequest = 0;
  private chatLoads = new SvelteMap<string, symbol>();
  workspaceId = $state('');

  private composer = $state(Symbol());
  private listening = false;
  private generation = 0;
  private refreshId = 0;
  private views = new SvelteMap<string, WorkspaceChatView>();
  private collectionNames: string[] = [];
  private environmentNames: string[] = [];

  get draft(): string {
    return this.draftFor(this.workspaceId, this.activeChatId);
  }

  set draft(text: string) {
    this.setDraftFor(this.workspaceId, this.activeChatId, text);
  }

  private draftKey(workspaceId: string, chatId: string): string {
    return `${this.driver}\n${workspaceId}\n${chatId}`;
  }

  private draftFor(workspaceId: string, chatId: string): string {
    return agentDrafts.get(this.draftKey(workspaceId, chatId)) ?? '';
  }

  private setDraftFor(workspaceId: string, chatId: string, text: string) {
    const key = this.draftKey(workspaceId, chatId);
    if ((agentDrafts.get(key) ?? '') === text) return;
    if (text) agentDrafts.set(key, text);
    else agentDrafts.delete(key);
    storeAgentDrafts();
  }

  private adoptNewChatDraft(workspaceId: string, chatId: string) {
    const text = this.draftFor(workspaceId, '');
    if (!text || !chatId) return;
    this.setDraftFor(workspaceId, '', '');
    if (!this.draftFor(workspaceId, chatId)) this.setDraftFor(workspaceId, chatId, text);
  }

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
        this.collection = '';
        this.environment = activeEnvironment;
      }
      const active = this.activeTurn;
      if (active) this.context = active.context;
      this.chats = [];
      this.chatsLoaded = false;
      void this.refreshChats();
    }
    if (this.collection && !collections.includes(this.collection)) this.collection = '';
    if (this.environment && !environments.includes(this.environment)) this.environment = '';
  }

  private captureView(trimHistory = false): WorkspaceChatView {
    return {
      activeChatId: this.activeChatId, activeChat: trimHistory && this.activeChat ? agentHistoryPage(this.activeChat) : this.activeChat, composer: this.composer,
      collection: this.collection, environment: this.environment, ownBranch: this.ownBranch, connectionId: this.connectionId,
      mode: this.mode, allowedHosts: [...this.allowedHosts], budgetTokens: this.budgetTokens, budgetRequests: this.budgetRequests, editing: this.editing,
      projectRoot: this.projectRoot, attachmentPaths: [...this.attachmentPaths],
      model: this.model, effort: this.effort, context: this.context, notes: this.notes, loadError: this.loadError,
    };
  }

  private restoreView(view: WorkspaceChatView) {
    this.activeChatId = view.activeChatId;
    this.activeChat = view.activeChat;
    this.composer = view.composer;
    this.projectRoot = view.projectRoot;
    this.attachmentPaths = view.attachmentPaths;
    this.collection = view.collection;
    this.environment = view.environment;
    this.ownBranch = view.ownBranch;
    this.mode = view.mode;
    this.allowedHosts = view.allowedHosts;
    this.budgetTokens = view.budgetTokens;
    this.budgetRequests = view.budgetRequests;
    this.editing = view.editing;
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

  private get activeTurn(): LiveTurn | null {
    for (const entry of this.turns.values()) {
      if (entry.workspaceId !== this.workspaceId) continue;
      if (this.activeChatId ? entry.chatId === this.activeChatId : !entry.chatId && entry.composer === this.composer) return entry;
    }
    return null;
  }

  get live(): AiTurn | null {
    return this.activeTurn?.turn ?? null;
  }

  get liveAttachments(): AgentAttachment[] {
    return this.activeTurn?.attachments ?? [];
  }

  get liveChatId(): string {
    return this.activeTurn?.chatId ?? '';
  }

  get compacting(): boolean {
    return this.activeTurn?.compacting ?? false;
  }

  get anyRunning(): boolean {
    for (const entry of this.turns.values()) if (entry.turn.status === 'streaming') return true;
    return false;
  }

  get running(): boolean {
    if (this.driver) return this.anyRunning;
    return this.live?.status === 'streaming';
  }

  get liveInActiveChat(): boolean {
    return Boolean(this.activeTurn);
  }

  #runningKey = $derived([...this.turns.values()].filter(entry => entry.chatId && entry.turn.status === 'streaming').map(entry => entry.chatId).sort().join('\n'));
  #runningChats = $derived(this.#runningKey ? this.#runningKey.split('\n') : []);
  #waitingKey = $derived(this.approvals.map(approval => approval.chatId).filter((chatId, index, all) => chatId && all.indexOf(chatId) === index).sort().join('\n'));
  #waitingChats = $derived(this.#waitingKey ? this.#waitingKey.split('\n') : []);

  isRunning(chatId: string): boolean {
    return this.#runningChats.includes(chatId);
  }

  isWaiting(chatId: string): boolean {
    return this.#waitingChats.includes(chatId);
  }

  get activeApprovals(): AgentApproval[] {
    const turnId = this.activeTurn?.turn.id;
    return this.approvals.filter(approval => (this.activeChatId && approval.chatId === this.activeChatId) || (turnId && approval.turnId === turnId));
  }

  get usage(): AiUsage {
    return this.activeChat?.usage ?? emptyAiUsage();
  }

  init() {
    if (this.listening) return;
    this.listening = true;
    onAgentEvent<{ sessionId: string; turnId?: string; deltas: AiDelta[]; attachments?: AgentAttachment[] }>('ai:deltas', payload => {
      const entry = this.matches(payload.sessionId, payload.turnId);
      if (!entry) return;
      if (payload.attachments) this.updateEntry(entry, value => ({ ...value, attachments: payload.attachments ?? [] }));
      if (payload.deltas?.length) this.updateLive(entry, turn => applyAiDeltas(turn, payload.deltas));
    });
    onAgentEvent<{ sessionId: string; turnId?: string; step: AiStep }>('ai:step', payload => {
      const entry = this.matches(payload.sessionId, payload.turnId);
      if (!entry || !isAiStepIndex(payload.step.index)) return;
      this.updateLive(entry, turn => {
        const steps = turn.steps.slice();
        while (steps.length <= payload.step.index) steps.push(emptyStepView(steps.length));
        steps[payload.step.index] = { ...stepViewFrom(payload.step), toolResults: steps[payload.step.index].toolResults };
        return { ...turn, steps };
      });
    });
    onAgentEvent<{ sessionId: string; turnId?: string; step: number; block: AiBlock }>('ai:tool', payload => {
      const entry = this.matches(payload.sessionId, payload.turnId);
      if (!entry || !isAiStepIndex(payload.step)) return;
      this.updateLive(entry, turn => {
        const steps = turn.steps.slice();
        while (steps.length <= payload.step) steps.push(emptyStepView(steps.length));
        steps[payload.step] = { ...steps[payload.step], toolResults: [...steps[payload.step].toolResults, payload.block] };
        return { ...turn, steps };
      });
    });
    onAgentEvent<{ chatId: string; turnId: string; active: boolean }>('agent:compaction', payload => {
      const entry = this.matches(payload.chatId, payload.turnId);
      if (entry) this.updateEntry(entry, value => ({ ...value, compacting: payload.active }));
    });
    onAgentEvent<AgentContext>('agent:context', context => {
      const entry = this.matches(context.chatId, context.turnId);
      if (!entry) return;
      this.updateEntry(entry, value => ({ ...value, context }));
      if (this.activeTurn?.turn.id === entry.turn.id) this.context = context;
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

  private matches(sessionId: string, turnId?: string): LiveTurn | null {
    if (!turnId) return null;
    const entry = this.turns.get(turnId);
    if (!entry || entry.turn.status !== 'streaming') return null;
    if (entry.chatId && sessionId && entry.chatId !== sessionId) return null;
    if (!entry.chatId && sessionId) {
      const assigned = { ...entry, chatId: sessionId };
      this.turns.set(turnId, assigned);
      if (entry.stopRequested) void stopAgent(sessionId, turnId);
      this.updateView(entry.workspaceId, this.generation, view => {
        if (view.activeChatId || view.composer !== entry.composer) return;
        view.activeChatId = sessionId;
        this.adoptNewChatDraft(entry.workspaceId, sessionId);
      });
      void this.refreshChats();
      return assigned;
    }
    return entry;
  }

  private updateEntry(entry: LiveTurn, change: (entry: LiveTurn) => LiveTurn) {
    const current = this.turns.get(entry.turn.id);
    if (current) this.turns.set(entry.turn.id, change(current));
  }

  private updateLive(entry: LiveTurn, change: (turn: AiTurn) => AiTurn) {
    this.updateEntry(entry, value => ({ ...value, turn: change(value.turn) }));
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
    agentNavigation.activity = false;
    this.cancelEdit();
    this.composer = Symbol();
    this.chatLoads.delete(this.workspaceId);
    this.historyRequest++;
    this.loadingEarlier = false;
    this.historyError = '';
    this.context = null;
    this.activeChatId = '';
    this.activeChat = null;
    this.projectRoot = '';
    this.attachmentPaths = [];
    this.notes = null;
    this.loadError = '';
    this.editing = null;
  }

  async openChat(id: string) {
    agentNavigation.activity = false;
    if (!id) return this.newChat();
    if (this.activeChatId !== id) this.cancelEdit();
    const workspaceId = this.workspaceId;
    const generation = this.generation;
    const collectionNames = this.collectionNames;
    const environmentNames = this.environmentNames;
    const request = Symbol();
    this.chatLoads.set(workspaceId, request);
    this.historyRequest++;
    this.loadingEarlier = false;
    this.historyError = '';
    if (this.activeChatId !== id) {
      this.projectRoot = '';
      this.attachmentPaths = [];
    }
    this.activeChatId = id;
    this.notes = this.notes?.chatId === id ? this.notes : null;
    this.loadError = '';
    const liveEntry = [...this.turns.values()].find(entry => entry.workspaceId === workspaceId && entry.chatId === id && entry.turn.status === 'streaming');
    const reopeningLive = Boolean(liveEntry);
    this.editing = null;
    if (liveEntry) {
      this.activeChat = liveEntry.history;
      this.context = liveEntry.context;
    }
    try {
      const chat = liveEntry ? liveEntry.history : await agentChatPage(id);
      if (!chat || this.chatLoads.get(workspaceId) !== request) return;
      if (chat.workspaceId !== workspaceId) throw new Error('This chat belongs to another workspace.');
      this.updateView(workspaceId, generation, view => {
        if (view.activeChatId !== id) return;
        view.activeChat = chat;
        view.projectRoot = chat.projectRoot ?? '';
        view.model = chat.model;
        view.effort = chat.effort ?? '';
        view.collection = (this.workspaceId === workspaceId ? this.collectionNames : collectionNames).includes(chat.collection) ? chat.collection : '';
        view.environment = (this.workspaceId === workspaceId ? this.environmentNames : environmentNames).includes(chat.environment) ? chat.environment : '';
        view.ownBranch = Boolean(chat.ownBranch);
        view.mode = chat.mode ?? '';
        view.allowedHosts = chat.allowedHosts ?? [];
        view.budgetTokens = chat.budgetTokens ?? 0;
        view.budgetRequests = chat.budgetRequests ?? 0;
        if (chat.connectionId) view.connectionId = chat.connectionId;
      });
      if (reopeningLive) return;
      const pending = await agentPendingApprovals(id);
      if (generation !== this.generation) return;
      const known = this.approvals.map(approval => approval.id);
      this.approvals = [...this.approvals, ...pending.filter(approval => !known.includes(approval.id))];
    } catch (error) {
      if (this.chatLoads.get(workspaceId) !== request) return;
      this.updateView(workspaceId, generation, view => {
        if (view.activeChatId !== id) return;
        view.activeChat = null;
        view.loadError = error instanceof Error ? error.message : String(error);
      });
    } finally {
      if (this.chatLoads.get(workspaceId) === request) this.chatLoads.delete(workspaceId);
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
      const active = this.activeTurn;
      if (active) this.updateEntry(active, value => ({ ...value, history: this.activeChat }));
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
    if (!prompt || this.running || this.activeChat?.archivedAt || this.chats.some(chat => chat.id === this.activeChatId && chat.archivedAt)) return false;
    if (text === this.draft) this.draft = '';
    const chatId = this.activeChatId;
    const composer = this.composer;
    const workspaceId = this.workspaceId;
    const generation = this.generation;
    const editing = chatId ? this.editing : null;
    this.editing = null;
    const history = this.activeChat?.id === chatId ? this.activeChat : null;
    const messageCount = chatMessageCount(history);
    this.chatLoads.delete(workspaceId);
    this.historyRequest++;
    this.loadingEarlier = false;
    const turn: AiTurn = { id: newTurnId(), prompt, startedAt: Date.now(), status: 'streaming', steps: [], response: null, error: '' };
    if (editing && history) this.activeChat = agentChatBefore(history, editing.index);
    this.context = null;
    this.notes = null;
    this.turns.set(turn.id, { turn, chatId, workspaceId, composer, history: this.activeChat?.id === chatId ? this.activeChat : history, context: null, attachments: [], compacting: false, stopRequested: false });
    try {
      const result = await sendAgentMessage({
        chatId,
        workspaceId,
        turnId: turn.id,
        text: prompt,
        ...(this.projectRoot || history?.projectRoot ? { projectRoot: this.projectRoot } : {}),
        ...(this.attachmentPaths.length ? { attachments: [...this.attachmentPaths] } : {}),
        ...(editing ? { editFrom: editing.index } : {}),
        collection: this.collection,
        environment: this.environment,
        ownBranch: this.ownBranch,
        connectionId: this.connectionId,
        model: this.model,
        mode: this.mode,
        allowedHosts: [...this.allowedHosts],
        budgetTokens: this.budgetTokens,
        budgetRequests: this.budgetRequests,
        ...(this.driver ? { driver: this.driver, effort: this.effort } : {}),
      });
      const resultChatId = result.chat?.id || this.turns.get(turn.id)?.chatId || chatId;
      const stopped = /cancel/i.test(result.error ?? '');
      this.updateView(workspaceId, generation, view => {
        const originalChat = view.activeChatId
          ? view.activeChatId === chatId || view.activeChatId === resultChatId
          : !chatId && view.composer === composer;
        if (originalChat && result.chat?.id && result.chat.workspaceId === workspaceId) {
          if (!view.activeChatId) this.adoptNewChatDraft(workspaceId, result.chat.id);
          view.activeChatId = result.chat.id;
          view.activeChat = editing ? result.chat : mergeAgentHistory(view.activeChat, result.chat);
          if (!result.error) view.attachmentPaths = [];
        }
        if (originalChat) view.notes = { chatId: resultChatId, error: stopped ? '' : (result.error ?? ''), warnings: result.warnings ?? [] };
        if (originalChat && result.error && !stopped && !this.draftFor(workspaceId, view.activeChatId) && chatMessageCount(result.chat) <= messageCount) this.setDraftFor(workspaceId, view.activeChatId, text);
      });
    } catch (error) {
      const failedChatId = this.turns.get(turn.id)?.chatId || chatId;
      this.updateView(workspaceId, generation, view => {
        const originalChat = view.activeChatId ? view.activeChatId === failedChatId : !chatId && view.composer === composer;
        if (!originalChat) return;
        if (editing && history && view.activeChat?.id === history.id) view.activeChat = history;
        view.notes = { chatId: failedChatId, error: error instanceof Error ? error.message : String(error), warnings: [] };
        if (!this.draftFor(workspaceId, view.activeChatId)) this.setDraftFor(workspaceId, view.activeChatId, text);
      });
    } finally {
      this.turns.delete(turn.id);
      this.approvals = this.approvals.filter(approval => approval.turnId !== turn.id);
      void this.refreshChats();
    }
    return true;
  }

  async stop() {
    const entry = this.activeTurn ?? (this.driver ? [...this.turns.values()].find(candidate => candidate.workspaceId === this.workspaceId) : undefined);
    if (!entry) return;
    this.updateEntry(entry, value => ({ ...value, stopRequested: true }));
    await stopAgent(entry.chatId || this.activeChatId, entry.turn.id);
  }

  startEdit(index: number, text: string) {
    if (this.running) return;
    this.editing = { index, text };
    this.draft = text;
  }

  cancelEdit() {
    if (this.editing && this.draft === this.editing.text) this.draft = '';
    this.editing = null;
  }

  async branchFrom(index: number, text: string): Promise<string> {
    const chatId = this.activeChatId;
    if (!chatId) return '';
    try {
      const chat = await branchAgentChat(chatId, this.workspaceId, index);
      await this.refreshChats();
      await this.openChat(chat.id);
      this.draft = text;
      return '';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async compact(): Promise<string> {
    const chatId = this.activeChatId;
    if (!chatId || this.running || this.compactingChat) return '';
    const workspaceId = this.workspaceId;
    const generation = this.generation;
    this.compactingChat = chatId;
    try {
      const chat = await compactAgentChat(chatId, workspaceId);
      this.updateView(workspaceId, generation, view => {
        if (view.activeChat?.id !== chatId) return;
        view.activeChat = {
          ...view.activeChat, summary: chat.summary, summaryBefore: chat.summaryBefore, usage: chat.usage,
          contextTokens: chat.contextTokens, contextWindow: chat.contextWindow, updatedAt: chat.updatedAt,
        };
      });
      void this.refreshChats();
      return '';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    } finally {
      if (this.compactingChat === chatId) this.compactingChat = '';
    }
  }

  async answer(id: string, decision: 'allow' | 'allow_chat' | 'reject') {
    const result = await answerAgentApproval(id, decision);
    if (!result.ok) throw new Error(result.error || 'Could not send your decision. Try again.');
    this.approvals = this.approvals.filter(approval => approval.id !== id);
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

  async setArchived(id: string, archived: boolean) {
    const workspaceId = this.workspaceId;
    const generation = this.generation;
    const summary = await setAgentChatArchived(id, workspaceId, archived);
    if (generation !== this.generation || workspaceId !== this.workspaceId) return;
    this.chats = this.chats.map(chat => chat.id === id ? summary : chat);
    this.updateView(workspaceId, generation, view => {
      if (view.activeChat?.id === id) view.activeChat = { ...view.activeChat, archivedAt: summary.archivedAt, updatedAt: summary.updatedAt };
    });
    await this.refreshChats();
  }

  async remove(id: string) {
    const workspaceId = this.workspaceId;
    const generation = this.generation;
    const result = await deleteAgentChat(id);
    if (!result.ok) throw new Error(result.error || 'Kurlo could not delete the chat.');
    this.setDraftFor(workspaceId, id, '');
    if (generation !== this.generation) return;
    this.chats = this.chats.filter(chat => chat.id !== id);
    this.approvals = this.approvals.filter(approval => approval.chatId !== id);
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
    for (const entry of this.turns.values()) void stopAgent(entry.chatId, entry.turn.id);
    this.generation++;
    if (!this.driver && this.workspaceId) workspaceModes.set(this.workspaceId, agentNavigation.mode);
    this.workspaceId = '';
    this.views.clear();
    this.chatLoads.clear();
    this.turns.clear();
    this.collection = '';
    this.environment = '';
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

export const agentNavigation = $state({ mode: 'kurlo' as AgentMode, detailsOpen: savedAgentDetails(), activity: false });

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
