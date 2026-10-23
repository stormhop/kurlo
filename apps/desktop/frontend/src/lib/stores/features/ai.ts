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

export function aiSettingsError(req: Pick<SavedRequest, 'aiTemperature' | 'aiTopP' | 'aiMaxTokens' | 'aiMaxSteps' | 'aiIdleTimeoutSec'>): string {
  const checks: [string, string | undefined, (n: number) => boolean][] = [
    ['Temperature', req.aiTemperature, n => n >= 0 && n <= 2],
    ['Top P', req.aiTopP, n => n >= 0 && n <= 1],
    ['Max tokens', req.aiMaxTokens, n => Number.isInteger(n) && n > 0],
    ['Step limit', req.aiMaxSteps, n => Number.isInteger(n) && n > 0 && n <= 50],
    ['Stop after silence', req.aiIdleTimeoutSec, n => Number.isInteger(n) && n > 0],
  ];
  for (const [label, raw, valid] of checks) {
    const text = (raw ?? '').trim();
    if (!text) continue;
    const parsed = Number(text);
    if (!Number.isFinite(parsed) || !valid(parsed)) return `${label} has an invalid value: ${text}`;
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
  aiModelsError: string;
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
    if (preset.url || id !== 'custom') this.url = preset.url;
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
      this.aiModelsError = 'Enter the base URL first.';
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
      this.aiModelsError = keyProblem;
      return;
    }
    const resolvedBase = runnable.url.replace(/\/+$/, '').replace(/\/(chat\/completions|messages)$/, '');
    this.aiModelsLoading = true;
    this.aiModelsError = '';
    try {
      const response = await sendHttpRequest({
        ...runnable,
        method: 'GET',
        url: `${resolvedBase}/models`,
        headers,
        bodyType: 'none',
        body: '',
        formData: [],
        preRequestScript: '',
        testScript: '',
      });
      if (response.error) throw new Error(response.error);
      if (response.statusCode < 200 || response.statusCode >= 300) {
        const detail = aiResponseErrorMessage(response.body) || 'the provider refused the model list';
        throw new Error(response.statusCode === 401 || response.statusCode === 403
          ? `The provider did not accept the API key (${response.statusCode}): ${detail}`
          : `${response.status || response.statusCode}: ${detail}`);
      }
      const models = parseModelList(response.body);
      if (!models.length) throw new Error('The provider returned no models.');
      const next = new Map(this.aiModels);
      next.set(key, models);
      this.aiModels = next;
    } catch (error) {
      this.aiModelsError = error instanceof Error ? error.message : String(error);
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
    const previousTurns = followUp === undefined ? [] : this.aiTurns(requestId);
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

export function aiUnresolvedKey(req: Pick<HttpRequest, 'auth'>): string {
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
