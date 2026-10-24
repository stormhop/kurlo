import { sendAiRequest, sendHttpRequest } from '../../backend';
import { emptyHttpResponse } from '../../wire';
import type { AiBlock, AiMessage, AiRequest, AiResponse, AiStep, AiUsage, HttpRequest, HttpResponse } from '../../backend';
import type { AuthType, RequestTab, RequestType, SavedRequest } from '../../types/models';
import { newRequestId } from '../../utils';

export type AiPresetId = 'openai' | 'anthropic' | 'openrouter' | 'groq' | 'ollama' | 'lmstudio' | 'custom';

export type AiPreset = {
  id: AiPresetId;
  label: string;
  provider: 'openai' | 'anthropic';
  url: string;
  auth: { type: AuthType; variable?: string };
  modelExample: string;
};

export const AI_PRESETS: AiPreset[] = [
  { id: 'openai', label: 'OpenAI', provider: 'openai', url: 'https://api.openai.com/v1', auth: { type: 'bearer', variable: 'openaiApiKey' }, modelExample: 'gpt-4o-mini' },
  { id: 'anthropic', label: 'Anthropic', provider: 'anthropic', url: 'https://api.anthropic.com/v1', auth: { type: 'apikey', variable: 'anthropicApiKey' }, modelExample: 'claude-sonnet-5-5' },
  { id: 'openrouter', label: 'OpenRouter', provider: 'openai', url: 'https://openrouter.ai/api/v1', auth: { type: 'bearer', variable: 'openrouterApiKey' }, modelExample: 'openai/gpt-4o-mini' },
  { id: 'groq', label: 'Groq', provider: 'openai', url: 'https://api.groq.com/openai/v1', auth: { type: 'bearer', variable: 'groqApiKey' }, modelExample: 'llama-3.3-70b-versatile' },
  { id: 'ollama', label: 'Ollama', provider: 'openai', url: 'http://localhost:11434/v1', auth: { type: 'none' }, modelExample: 'llama3.2' },
  { id: 'lmstudio', label: 'LM Studio', provider: 'openai', url: 'http://localhost:1234/v1', auth: { type: 'none' }, modelExample: 'qwen2.5-7b-instruct' },
  { id: 'custom', label: 'Custom URL', provider: 'openai', url: '', auth: { type: 'bearer', variable: 'apiKey' }, modelExample: 'the model name your server expects' },
];

export const AI_DEFAULT_PRESET = AI_PRESETS[0];

export function aiPresetFor(url: string, provider: string): AiPreset {
  const clean = url.trim().replace(/\/+$/, '').toLowerCase();
  const match = AI_PRESETS.find(preset => preset.url && clean === preset.url.toLowerCase());
  if (match) return match;
  if (provider === 'anthropic') return AI_PRESETS.find(preset => preset.id === 'anthropic')!;
  return AI_PRESETS.find(preset => preset.id === 'custom')!;
}

export type AiStepView = {
  index: number;
  blocks: AiBlock[];
  toolResults: AiBlock[];
  stopReason: string;
  rawStopReason: string;
  model: string;
  usage: AiUsage;
  hasUsage: boolean;
  firstTokenMs: number;
  durationMs: number;
  error: string;
  done: boolean;
};

export type AiTurnStatus = 'streaming' | 'done' | 'error' | 'cancelled';

export type AiTurn = {
  id: string;
  prompt: string;
  startedAt: number;
  status: AiTurnStatus;
  steps: AiStepView[];
  response: AiResponse | null;
  error: string;
};

type AiDelta = { sessionId: string; step: number; index: number; type: string; text?: string; id?: string; name?: string; input?: string };

export function emptyAiUsage(): AiUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

function emptyStepView(index: number): AiStepView {
  return { index, blocks: [], toolResults: [], stopReason: '', rawStopReason: '', model: '', usage: emptyAiUsage(), hasUsage: false, firstTokenMs: 0, durationMs: 0, error: '', done: false };
}

function stepViewFrom(step: AiStep): AiStepView {
  return {
    index: step.index,
    blocks: step.blocks ?? [],
    toolResults: step.toolResults ?? [],
    stopReason: step.stopReason ?? '',
    rawStopReason: step.rawStopReason ?? '',
    model: step.model ?? '',
    usage: step.usage ?? emptyAiUsage(),
    hasUsage: step.hasUsage ?? false,
    firstTokenMs: step.firstTokenMs ?? 0,
    durationMs: step.durationMs ?? 0,
    error: step.error ?? '',
    done: true,
  };
}

export function applyAiDeltas(turn: AiTurn, deltas: AiDelta[]): AiTurn {
  const steps = turn.steps.slice();
  for (const delta of deltas) {
    while (steps.length <= delta.step) steps.push(emptyStepView(steps.length));
    const step = { ...steps[delta.step], blocks: steps[delta.step].blocks.slice() };
    while (step.blocks.length <= delta.index) step.blocks.push({ type: '' });
    const current = step.blocks[delta.index];
    const block: AiBlock = { ...current, type: current.type || delta.type };
    if (delta.id && !block.id) block.id = delta.id;
    if (delta.name && !block.name) block.name = delta.name;
    if (delta.text) block.text = (block.text ?? '') + delta.text;
    if (delta.input) block.input = (block.input ?? '') + delta.input;
    step.blocks[delta.index] = block;
    steps[delta.step] = step;
  }
  return { ...turn, steps };
}

export function aiTurnMessages(turn: AiTurn): AiMessage[] {
  const out: AiMessage[] = [{ role: 'user', blocks: [{ type: 'text', text: turn.prompt }] }];
  return out.concat(turn.response?.messages ?? []);
}

export function compactAiTurn(turn: AiTurn): AiTurn {
  const response = turn.response;
  if (!response) return turn;
  return {
    ...turn,
    response: {
      ...response,
      steps: (response.steps ?? []).map(step => ({ ...step, requestBody: '', http: step.http ? { ...step.http, body: '' } : step.http })),
      http: response.http ? { ...response.http, body: '' } : response.http,
    } as AiResponse,
  };
}

export function aiConversationHistory(turns: AiTurn[]): AiMessage[] {
  const out: AiMessage[] = [];
  for (const turn of turns) {
    if (!turn.response?.messages?.length) continue;
    out.push(...aiTurnMessages(turn));
  }
  return out;
}

export function aiTurnUsage(turn: AiTurn): AiUsage {
  if (turn.response) return turn.response.usage ?? emptyAiUsage();
  const total = emptyAiUsage();
  for (const step of turn.steps) {
    total.input += step.usage.input;
    total.output += step.usage.output;
    total.cacheRead += step.usage.cacheRead;
    total.cacheWrite += step.usage.cacheWrite;
    total.reasoning += step.usage.reasoning;
  }
  return total;
}

function optionalNumber(value: string | undefined): number | undefined {
  const text = (value ?? '').trim();
  if (!text) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export const AI_PROMPT_MAX_CHARS = 200_000;
export const AI_SYSTEM_MAX_CHARS = 50_000;

export function aiPromptLengthError(req: Pick<SavedRequest, 'aiSystem' | 'aiPrompt'>, promptLabel = 'prompt'): string {
  if ((req.aiSystem ?? '').length > AI_SYSTEM_MAX_CHARS) return `The system prompt is longer than ${AI_SYSTEM_MAX_CHARS.toLocaleString('en-US')} characters. Shorten it before sending.`;
  if ((req.aiPrompt ?? '').length > AI_PROMPT_MAX_CHARS) return `The ${promptLabel} is longer than ${AI_PROMPT_MAX_CHARS.toLocaleString('en-US')} characters. Shorten it before sending.`;
  return '';
}

export type AiSettingField = 'aiTemperature' | 'aiTopP' | 'aiMaxTokens' | 'aiMaxSteps' | 'aiIdleTimeoutSec';

const AI_SETTING_CHECKS: [AiSettingField, string, string, (n: number) => boolean][] = [
  ['aiTemperature', 'Temperature', 'Use a number from 0 to 2.', n => n >= 0 && n <= 2],
  ['aiTopP', 'Top P', 'Use a number from 0 to 1.', n => n >= 0 && n <= 1],
  ['aiMaxTokens', 'Max tokens', 'Use a whole number above 0.', n => Number.isInteger(n) && n > 0],
  ['aiMaxSteps', 'Step limit', 'Use a whole number from 1 to 50.', n => Number.isInteger(n) && n > 0 && n <= 50],
  ['aiIdleTimeoutSec', 'Stop after silence', 'Use a whole number of seconds above 0.', n => Number.isInteger(n) && n > 0],
];

export function aiSettingErrors(req: Pick<SavedRequest, AiSettingField>): Partial<Record<AiSettingField, string>> {
  const errors: Partial<Record<AiSettingField, string>> = {};
  for (const [field, , hint, valid] of AI_SETTING_CHECKS) {
    const text = (req[field] ?? '').trim();
    if (!text) continue;
    const parsed = Number(text);
    if (!Number.isFinite(parsed) || !valid(parsed)) errors[field] = hint;
  }
  return errors;
}

export function aiSettingsError(req: Pick<SavedRequest, AiSettingField>): string {
  const errors = aiSettingErrors(req);
  for (const [field, label, hint] of AI_SETTING_CHECKS) {
    if (errors[field]) return `${label}: ${(req[field] ?? '').trim()} is not valid. ${hint}`;
  }
  return '';
}

type AiHost = {
  activeRequestId: string;
  requestType: RequestType;
  requestTab: RequestTab;
  requestError: string;
  loading: boolean;
  url: string;
  authType: AuthType;
  bearerToken: string;
  apiKeyName: string;
  apiKeyValue: string;
  apiKeyIn: 'header' | 'query';
  aiProvider: string;
  aiModel: string;
  aiPrompt: string;
  aiToolRequestIds: string[];
  aiConversations: Map<string, AiTurn[]>;
  aiModels: Map<string, string[]>;
  aiModelsLoading: boolean;
  aiModelsError: AiModelsProblem | null;
  requests: SavedRequest[];
  inFlightRequestIds: Set<string>;
  guardWorkspaceWritable: (action?: string) => boolean;
  snapshotActiveRequest: (options?: { forPersistence?: boolean }) => SavedRequest;
  activeEnvironmentValues: () => Record<string, string>;
  activeSecretEnvironmentKeys: () => string[];
  activeSecretEnvironmentValues: () => string[];
  savedRequestToRunnableHttpRequest: (req: SavedRequest, envValues?: Record<string, string>, secretEnvironmentValues?: string[], secretEnvironmentKeys?: string[], requestId?: string) => HttpRequest;
  savedRequestToRunnableAiRequest: (req: SavedRequest, messages: AiMessage[], envValues?: Record<string, string>, secretEnvironmentValues?: string[], secretEnvironmentKeys?: string[], requestId?: string) => AiRequest;
  markRequestLoading: (requestId: string, loading: boolean) => void;
  requestIsActive: (requestId: string) => boolean;
  cancelActiveRequest: () => Promise<void>;
  persistActiveRequestNow: () => Promise<void>;
  syncBackendEnvironment: () => Promise<void>;
  syncActiveEnvironmentFromBackend: () => Promise<void>;
  applyEnvironmentChangesFromResponse: (resp: HttpResponse, environmentId: string) => Promise<void>;
  activeEnvironmentId: string;
  recordRequestHistory: (response: HttpResponse, req?: SavedRequest) => Promise<void>;
  setActiveResponse: (response: HttpResponse | null, requestId?: string) => void;
  aiTurns: (requestId?: string) => AiTurn[];
  setAiTurns: (requestId: string, turns: AiTurn[]) => void;
  updateAiTurn: (requestId: string, turnId: string, update: (turn: AiTurn) => AiTurn) => void;
};

export const aiFeature = {
  aiTurns(this: AiHost, requestId = this.activeRequestId): AiTurn[] {
    return this.aiConversations.get(requestId) ?? [];
  },

  setAiTurns(this: AiHost, requestId: string, turns: AiTurn[]) {
    if (!requestId) return;
    const next = new Map(this.aiConversations);
    if (turns.length) next.set(requestId, turns);
    else next.delete(requestId);
    this.aiConversations = next;
  },

  updateAiTurn(this: AiHost, requestId: string, turnId: string, update: (turn: AiTurn) => AiTurn) {
    const turns = this.aiConversations.get(requestId);
    if (!turns) return;
    const index = turns.findIndex(turn => turn.id === turnId);
    if (index < 0) return;
    const nextTurns = turns.slice();
    nextTurns[index] = update(turns[index]);
    this.setAiTurns(requestId, nextTurns);
  },

  clearAiConversation(this: AiHost, requestId = this.activeRequestId) {
    if (this.inFlightRequestIds.has(requestId)) return;
    this.setAiTurns(requestId, []);
  },

  selectAiPreset(this: AiHost, id: AiPresetId) {
    const preset = AI_PRESETS.find(entry => entry.id === id);
    if (!preset) return;
    const previous = aiPresetFor(this.url, this.aiProvider);
    const authUntouched = authLooksLikePreset(this, previous);
    this.aiProvider = preset.provider;
    this.url = preset.url;
    if (authUntouched) applyPresetAuth(this, preset);
    if (previous.id !== preset.id) this.aiModel = '';
  },

  aiCurrentPreset(this: AiHost): AiPreset {
    return aiPresetFor(this.url, this.aiProvider);
  },

  aiModelOptions(this: AiHost): string[] {
    return this.aiModels.get(aiModelsKey(this.url, this.aiProvider)) ?? [];
  },

  async loadAiModels(this: AiHost) {
    if (this.aiModelsLoading) return;
    const base = this.url.trim().replace(/\/+$/, '');
    if (!base) {
      this.aiModelsError = aiModelsProblem({ kind: 'no-url' });
      return;
    }
    const key = aiModelsKey(this.url, this.aiProvider);
    const snapshot = this.snapshotActiveRequest();
    const envValues = this.activeEnvironmentValues();
    const runnable = this.savedRequestToRunnableHttpRequest(
      snapshot, envValues, this.activeSecretEnvironmentValues(), this.activeSecretEnvironmentKeys(),
      `ai-models-${snapshot.id || newRequestId()}-${Date.now()}`,
    );
    const headers = runnable.headers.slice();
    if (this.aiProvider === 'anthropic' && !headers.some(h => h.key.toLowerCase() === 'anthropic-version')) {
      headers.push({ key: 'anthropic-version', value: '2023-06-01', enabled: true, isFile: false, fileName: '', contentType: '' });
    }
    const keyProblem = aiUnresolvedKey(runnable);
    if (keyProblem) {
      this.aiModelsError = aiModelsProblem({ kind: 'no-key', message: keyProblem });
      return;
    }
    this.aiModelsLoading = true;
    this.aiModelsError = null;
    const url = aiModelsURL(runnable.url, this.aiProvider);
    try {
      const response = await sendHttpRequest({
        ...runnable,
        method: 'GET',
        url,
        headers,
        bodyType: 'none',
        body: '',
        formData: [],
        preRequestScript: '',
        testScript: '',
      });
      if (response.error) {
        this.aiModelsError = aiModelsProblem({ kind: 'network', url, error: response.error });
        return;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        this.aiModelsError = aiModelsProblem({ kind: 'status', url, statusCode: response.statusCode, status: response.status, body: response.body });
        return;
      }
      const models = parseModelList(response.body);
      if (!models.length) {
        this.aiModelsError = aiModelsProblem({ kind: 'empty', url });
        return;
      }
      const next = new Map(this.aiModels);
      next.set(key, models);
      this.aiModels = next;
    } catch (error) {
      this.aiModelsError = aiModelsProblem({ kind: 'network', url, error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.aiModelsLoading = false;
    }
  },

  aiToolServerOptions(this: AiHost): SavedRequest[] {
    return this.requests.filter(req => req.requestType === 'mcp' && !req.isDraft);
  },

  toggleAiToolServer(this: AiHost, requestId: string) {
    const current = new Set(this.aiToolRequestIds);
    if (current.has(requestId)) current.delete(requestId);
    else current.add(requestId);
    this.aiToolRequestIds = [...current];
  },

  async sendAiPrompt(this: AiHost, followUp?: string) {
    if (!this.guardWorkspaceWritable('Sending requests')) return;
    const requestId = this.activeRequestId || newRequestId();
    if (this.inFlightRequestIds.has(requestId)) {
      await this.cancelActiveRequest();
      return;
    }
    const snapshot = this.snapshotActiveRequest();
    const prompt = followUp === undefined ? (snapshot.aiPrompt ?? '') : followUp;
    if (!prompt.trim()) {
      this.requestError = followUp === undefined ? 'Write a prompt before sending.' : 'Write a message before sending.';
      if (followUp === undefined) this.requestTab = 'body';
      return;
    }
    const lengthError = followUp === undefined
      ? aiPromptLengthError(snapshot)
      : aiPromptLengthError({ aiSystem: snapshot.aiSystem, aiPrompt: prompt }, 'message');
    if (lengthError) {
      this.requestError = lengthError;
      if (followUp === undefined) this.requestTab = 'body';
      return;
    }
    if (!(snapshot.aiModel ?? '').trim()) {
      this.requestError = 'Choose a model before sending.';
      return;
    }
    const settingsError = aiSettingsError(snapshot);
    if (settingsError) {
      this.requestError = settingsError;
      this.requestTab = 'settings';
      return;
    }

    const envValues = this.activeEnvironmentValues();
    const history = followUp === undefined ? [] : aiConversationHistory(this.aiTurns(requestId));
    const turn: AiTurn = { id: newRequestId(), prompt, startedAt: Date.now(), status: 'streaming', steps: [], response: null, error: '' };
    const previousTurns = followUp === undefined ? [] : this.aiTurns(requestId).map(compactAiTurn);
    this.setAiTurns(requestId, [...previousTurns, turn]);
    const messages: AiMessage[] = [...history, { role: 'user', blocks: [{ type: 'text', text: prompt }] }];

    this.markRequestLoading(requestId, true);
    this.requestError = '';
    this.setActiveResponse(null, requestId);
    const environmentId = this.activeEnvironmentId;
    try {
      await this.persistActiveRequestNow();
      try { await this.syncBackendEnvironment(); } catch {  }
      const runnable = this.savedRequestToRunnableAiRequest(
        snapshot, messages, envValues, this.activeSecretEnvironmentValues(), this.activeSecretEnvironmentKeys(), requestId,
      );
      const keyProblem = aiUnresolvedKey(runnable.http);
      if (keyProblem) throw new Error(keyProblem);
      const response = await sendAiRequest(runnable);
      try { await this.applyEnvironmentChangesFromResponse(response.http, environmentId); } catch {  }
      try { await this.syncActiveEnvironmentFromBackend(); } catch {  }
      const status: AiTurnStatus = response.error === 'Cancelled' ? 'cancelled' : response.error ? 'error' : 'done';
      this.updateAiTurn(requestId, turn.id, current => ({
        ...current,
        status,
        steps: (response.steps ?? []).map(stepViewFrom),
        response,
        error: response.error ?? '',
      }));
      if (this.requestIsActive(requestId) && status === 'error' && !(response.steps ?? []).length) {
        this.requestError = response.error ?? '';
      }
      await this.recordRequestHistory({
        ...emptyHttpResponse(),
        ...response.http,
        statusCode: response.http?.statusCode ?? 0,
        status: response.http?.status || 'AI',
        headers: response.http?.headers ?? [],
        body: response.text || response.http?.body || '',
        duration: response.durationMs ?? response.http?.duration ?? 0,
        error: response.error ?? '',
      }, snapshot);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.updateAiTurn(requestId, turn.id, current => ({ ...current, status: 'error', error: message }));
      if (this.requestIsActive(requestId)) this.requestError = message;
    } finally {
      this.markRequestLoading(requestId, false);
    }
  },

  initAiListeners(this: AiHost) {
    const runtime = window.runtime;
    if (!runtime?.EventsOn) return;
    runtime.EventsOn('ai:deltas', (payload: { sessionId: string; deltas: AiDelta[] }) => {
      const turns = this.aiConversations.get(payload.sessionId);
      const turn = turns?.at(-1);
      if (!turn || turn.status !== 'streaming' || !payload.deltas?.length) return;
      this.updateAiTurn(payload.sessionId, turn.id, current => applyAiDeltas(current, payload.deltas));
    });
    runtime.EventsOn('ai:step', (payload: { sessionId: string; step: AiStep }) => {
      const turns = this.aiConversations.get(payload.sessionId);
      const turn = turns?.at(-1);
      if (!turn || turn.status !== 'streaming') return;
      this.updateAiTurn(payload.sessionId, turn.id, current => {
        const steps = current.steps.slice();
        while (steps.length <= payload.step.index) steps.push(emptyStepView(steps.length));
        steps[payload.step.index] = { ...stepViewFrom(payload.step), toolResults: steps[payload.step.index].toolResults };
        return { ...current, steps };
      });
    });
    runtime.EventsOn('ai:tool', (payload: { sessionId: string; step: number; block: AiBlock }) => {
      const turns = this.aiConversations.get(payload.sessionId);
      const turn = turns?.at(-1);
      if (!turn || turn.status !== 'streaming') return;
      this.updateAiTurn(payload.sessionId, turn.id, current => {
        const steps = current.steps.slice();
        while (steps.length <= payload.step) steps.push(emptyStepView(steps.length));
        steps[payload.step] = { ...steps[payload.step], toolResults: [...steps[payload.step].toolResults, payload.block] };
        return { ...current, steps };
      });
    });
  },
};

export function aiComposerSends(event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'isComposing'> & { keyCode?: number }): boolean {
  if (event.key !== 'Enter' || event.shiftKey || event.altKey) return false;
  return !event.isComposing && event.keyCode !== 229;
}

export type AiErrorView = { title: string; status: string; message: string; hint: string };

const AI_STATUS_HINTS: Record<number, string> = {
  400: 'Check the model name and the settings the provider accepts.',
  401: 'Check the API key in the Auth tab or in the environment.',
  402: 'Add credits at the provider, or lower Max tokens in Settings.',
  403: 'Check that the API key may use this model.',
  404: 'Check the base URL and the model name.',
  413: 'Shorten the prompt or the conversation.',
  429: 'The provider is limiting requests. Wait a moment and send again.',
};

export function aiErrorView(text: string): AiErrorView {
  const value = text.trim();
  const match = /^(\d{3})((?: [^:\n]+)?)(?::\s*([\s\S]*))?$/.exec(value);
  if (!match) return { title: 'The request failed', status: '', message: value, hint: '' };
  const code = Number(match[1]);
  const hint = AI_STATUS_HINTS[code] ?? (code >= 500 ? 'The provider had a problem on its side. Try again in a moment.' : '');
  return { title: 'The provider returned an error', status: `${match[1]}${match[2]}`, message: (match[3] ?? '').trim(), hint };
}

export type AiEndpointParts = { base: string; suffix: string; query: string };

export function aiEndpointParts(url: string, provider: string): AiEndpointParts {
  const suffix = provider === 'anthropic' ? '/messages' : '/chat/completions';
  let base = url.trim();
  let query = '';
  const index = base.indexOf('?');
  if (index >= 0) {
    query = base.slice(index);
    base = base.slice(0, index);
  }
  base = base.replace(/\/+$/, '');
  return base.endsWith(suffix) ? { base, suffix: '', query } : { base, suffix, query };
}

export function aiModelsURL(url: string, provider: string): string {
  const { base, suffix, query } = aiEndpointParts(url, provider);
  const root = suffix ? base : base.slice(0, base.length - (provider === 'anthropic' ? '/messages' : '/chat/completions').length);
  return `${root}/models${query}`;
}

const ANTHROPIC_API_VERSION = '2023-06-01';
const ANTHROPIC_DEFAULT_MAX_TOKENS = 8192;

function aiUsesCompletionTokens(url: string): boolean {
  try {
    return new URL(url.trim()).hostname.toLowerCase() === 'api.openai.com';
  } catch {
    return false;
  }
}

export function aiHttpPreview(ai: AiRequest): { url: string; headers: HttpRequest['headers']; body: string } {
  const { base, suffix, query } = aiEndpointParts(ai.http.url, ai.provider);
  const text = (ai.messages ?? []).filter(message => message.role === 'user')
    .flatMap(message => message.blocks.filter(block => block.type === 'text' && block.text).map(block => block.text ?? ''))
    .join('\n\n');
  const settings = ai.settings ?? { maxTokens: 0, stream: true, thinking: '', idleTimeoutSec: 0 };
  const maxTokens = settings.maxTokens ?? 0;
  const body: Record<string, unknown> = { model: ai.model };
  const headers = [...(ai.http.headers ?? [])];
  if (ai.provider === 'anthropic') {
    body.messages = text ? [{ role: 'user', content: [{ type: 'text', text }] }] : [];
    body.stream = settings.stream;
    body.max_tokens = maxTokens > 0 ? maxTokens : ANTHROPIC_DEFAULT_MAX_TOKENS;
    if (ai.system.trim()) body.system = ai.system;
    if (settings.temperature !== undefined) body.temperature = settings.temperature;
    if (settings.topP !== undefined) body.top_p = settings.topP;
    if (settings.thinking === 'summarized') body.thinking = { type: 'adaptive', display: 'summarized' };
    if (!headers.some(h => h.enabled && h.key.toLowerCase() === 'anthropic-version')) {
      headers.push({ key: 'anthropic-version', value: ANTHROPIC_API_VERSION, enabled: true, isFile: false, fileName: '', contentType: '' });
    }
  } else {
    const messages: { role: string; content: string }[] = [];
    if (ai.system.trim()) messages.push({ role: 'system', content: ai.system });
    if (text) messages.push({ role: 'user', content: text });
    body.messages = messages;
    body.stream = settings.stream;
    if (settings.stream) body.stream_options = { include_usage: true };
    if (maxTokens > 0) body[aiUsesCompletionTokens(ai.http.url) ? 'max_completion_tokens' : 'max_tokens'] = maxTokens;
    if (settings.temperature !== undefined) body.temperature = settings.temperature;
    if (settings.topP !== undefined) body.top_p = settings.topP;
  }
  return { url: `${base}${suffix}${query}`, headers, body: JSON.stringify(body, null, 2) };
}

export type AiModelsProblem = { title: string; status: string; detail: string; hint: string };

function displayURL(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split('?')[0];
  }
}

export function aiModelsProblem(outcome:
  | { kind: 'no-url' }
  | { kind: 'no-key'; message: string }
  | { kind: 'network'; url: string; error: string }
  | { kind: 'status'; url: string; statusCode: number; status: string; body: string }
  | { kind: 'empty'; url: string },
): AiModelsProblem {
  switch (outcome.kind) {
    case 'no-url':
      return { title: 'Enter the base URL first', status: '', detail: '', hint: 'Kurlo reads the model list from the base URL.' };
    case 'no-key':
      return { title: 'The API key is not set', status: '', detail: outcome.message, hint: '' };
    case 'network':
      return { title: 'Could not reach the provider', status: '', detail: `GET ${displayURL(outcome.url)}\n${outcome.error}`, hint: 'Check the base URL and that the server is running. You can still type the model name.' };
    case 'empty':
      return { title: 'The provider listed no models', status: '', detail: `GET ${displayURL(outcome.url)}`, hint: 'Type the model name instead.' };
    case 'status': {
      const status = outcome.status || String(outcome.statusCode);
      const message = aiResponseErrorMessage(outcome.body).trim();
      const repeatsStatus = !message || status.toLowerCase().replace(/^\d+\s*/, '') === message.toLowerCase();
      const detail = `GET ${displayURL(outcome.url)}${repeatsStatus ? '' : `\n${message}`}`;
      if (outcome.statusCode === 401 || outcome.statusCode === 403) {
        return { title: 'The API key was not accepted', status, detail, hint: 'Check the key in the Auth tab or in the environment.' };
      }
      if (outcome.statusCode === 404) {
        return { title: 'This server has no model list', status, detail, hint: 'Check the base URL, or type the model name: some servers do not list their models.' };
      }
      return { title: 'The provider refused the model list', status, detail, hint: 'You can still type the model name.' };
    }
  }
}

export function aiUnresolvedKey(req: Pick<HttpRequest, 'auth' | 'headers'>): string {
  const keyHeader = (req.headers ?? []).some(h => h.enabled !== false && /^(authorization|x-api-key|api-key)$/i.test(h.key.trim()) && h.value.trim() && !h.value.includes('{{'));
  if (keyHeader) return '';
  const value = req.auth?.type === 'bearer' ? req.auth.token : req.auth?.type === 'apikey' ? req.auth.keyValue : '';
  const match = /\{\{\s*([^{}\s]+)\s*\}\}/.exec(value ?? '');
  if (!match) return '';
  return `The API key comes from {{${match[1]}}}, which the active environment does not set. Add ${match[1]} to an environment (mark it secret), or put the key in the Auth tab.`;
}

function aiModelsKey(url: string, provider: string) {
  return `${provider}|${url.trim().replace(/\/+$/, '').toLowerCase()}`;
}

function authLooksLikePreset(host: AiHost, preset: AiPreset): boolean {
  if (host.authType === 'none' || host.authType === 'inherit') return true;
  const variable = preset.auth.variable ? `{{${preset.auth.variable}}}` : '';
  if (host.authType === 'bearer') return !host.bearerToken.trim() || host.bearerToken.trim() === variable;
  if (host.authType === 'apikey') return !host.apiKeyValue.trim() || host.apiKeyValue.trim() === variable;
  return false;
}

function applyPresetAuth(host: AiHost, preset: AiPreset) {
  const variable = preset.auth.variable ? `{{${preset.auth.variable}}}` : '';
  host.authType = preset.auth.type;
  if (preset.auth.type === 'bearer') host.bearerToken = variable;
  if (preset.auth.type === 'apikey') {
    host.apiKeyName = 'x-api-key';
    host.apiKeyValue = variable;
    host.apiKeyIn = 'header';
  }
}

export function aiDefaultAuthFor(presetId: AiPresetId = 'openai'): { type: AuthType; bearerToken: string; apiKeyName: string; apiKeyValue: string; apiKeyIn: 'header' } {
  const preset = AI_PRESETS.find(entry => entry.id === presetId) ?? AI_DEFAULT_PRESET;
  const variable = preset.auth.variable ? `{{${preset.auth.variable}}}` : '';
  return {
    type: preset.auth.type,
    bearerToken: preset.auth.type === 'bearer' ? variable : '',
    apiKeyName: preset.auth.type === 'apikey' ? 'x-api-key' : '',
    apiKeyValue: preset.auth.type === 'apikey' ? variable : '',
    apiKeyIn: 'header',
  };
}

export function parseModelList(body: string): string[] {
  try {
    const parsed = JSON.parse(body) as { data?: { id?: unknown }[]; models?: { id?: unknown; name?: unknown }[] };
    const rows = Array.isArray(parsed.data) ? parsed.data : Array.isArray(parsed.models) ? parsed.models : [];
    const ids = rows
      .map(row => (typeof row?.id === 'string' ? row.id : typeof (row as { name?: unknown })?.name === 'string' ? String((row as { name?: unknown }).name) : ''))
      .filter(Boolean);
    return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export function aiResponseErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === 'string') return parsed.error;
    if (parsed.error && typeof parsed.error === 'object') {
      const message = (parsed.error as { message?: unknown }).message;
      if (typeof message === 'string') return message;
    }
    if (typeof parsed.message === 'string') return parsed.message;
  } catch {  }
  return '';
}

export function aiOptionalNumber(value: string | undefined): number | undefined {
  return optionalNumber(value);
}
