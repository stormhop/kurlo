import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/backend', async () => {
  const wire = await import('../lib/wire');
  return { ...wire, sendAiRequest: vi.fn(), sendHttpRequest: vi.fn() };
});

import * as backend from '../lib/backend';
import type { AiResponse } from '../lib/backend';
import { emptyHttpRequest, emptyHttpResponse } from '../lib/wire';
import { buildSnippet } from '../lib/snippets';
import { toCurl } from '../lib/curl';
import {
  AI_PRESETS,
  aiHttpPreview,
  AI_PROMPT_MAX_CHARS,
  AI_SYSTEM_MAX_CHARS,
  aiPromptLengthError,
  aiModelsProblem,
  aiErrorView,
  aiEndpointParts,
  aiModelsURL,
  aiComposerSends,
  aiConversationHistory,
  aiFeature,
  aiPresetFor,
  aiSettingErrors,
  aiSettingsError,
  aiUnresolvedKey,
  applyAiDeltas,
  compactAiTurn,
  parseModelList,
  type AiTurn,
} from '../lib/stores/features/ai';
import { normalizeSavedRequest } from '../lib/normalizers';
import { requestSerializationFeature } from '../lib/stores/features/requestSerialization';
import { requestKindFor, requestBadgeLabel, requestSupportsCurl } from '../lib/utils';
import type { SavedRequest } from '../lib/types/models';

function turn(overrides: Partial<AiTurn> = {}): AiTurn {
  return { id: 't1', prompt: 'Hi', startedAt: 0, status: 'streaming', steps: [], response: null, error: '', ...overrides };
}

function aiResponse(overrides: Partial<AiResponse> = {}): AiResponse {
  return {
    steps: [], messages: [], text: '', stopReason: 'end_turn',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    hasUsage: false, firstTokenMs: 0, durationMs: 0, tools: [], warnings: [], error: '',
    http: { ...emptyHttpResponse(), statusCode: 200, status: '200 OK' },
    ...overrides,
  } as AiResponse;
}

describe('ai request type', () => {
  it('is its own kind with an AI badge and no cURL export', () => {
    expect(requestKindFor({ requestType: 'ai', method: 'POST' })).toBe('ai');
    expect(requestBadgeLabel({ requestType: 'ai', method: 'POST' })).toBe('AI');
    expect(requestSupportsCurl({ requestType: 'ai', method: 'POST' })).toBe(false);
  });

  it('normalizes saved AI requests with their defaults', () => {
    const req = normalizeSavedRequest({ id: 'a', requestType: 'ai', url: 'https://api.openai.com/v1', aiModel: 'm', requestTab: 'params' }, [], '');
    expect(req.requestType).toBe('ai');
    expect(req.method).toBe('POST');
    expect(req.requestTab).toBe('body');
    expect(req.aiProvider).toBe('openai');
    expect(req.aiStream).toBe(true);
    expect(req.aiToolRequestIds).toEqual([]);
  });

  it('keeps the tools tab only on AI requests', () => {
    expect(normalizeSavedRequest({ id: 'a', requestType: 'ai', requestTab: 'tools' }, [], '').requestTab).toBe('tools');
    expect(normalizeSavedRequest({ id: 'b', requestType: 'http', requestTab: 'tools' }, [], '').requestTab).toBe('params');
  });
});

describe('ai presets', () => {
  it('recognizes a preset from its base URL', () => {
    expect(aiPresetFor('https://api.anthropic.com/v1/', 'anthropic').id).toBe('anthropic');
    expect(aiPresetFor('http://localhost:11434/v1', 'openai').id).toBe('ollama');
    expect(aiPresetFor('https://llm.internal/v1', 'openai').id).toBe('custom');
  });

  it('switches provider, URL and untouched auth together', () => {
    const host = {
      url: AI_PRESETS[0].url, aiProvider: 'openai', aiModel: 'gpt-x',
      authType: 'bearer', bearerToken: '{{openaiApiKey}}', apiKeyName: '', apiKeyValue: '', apiKeyIn: 'header',
    };
    aiFeature.selectAiPreset.call(host as never, 'anthropic');
    expect(host).toMatchObject({
      url: 'https://api.anthropic.com/v1', aiProvider: 'anthropic', aiModel: '',
      authType: 'apikey', apiKeyName: 'x-api-key', apiKeyValue: '{{anthropicApiKey}}',
    });
  });

  it('leaves a hand-written key alone when the preset changes', () => {
    const host = {
      url: AI_PRESETS[0].url, aiProvider: 'openai', aiModel: '',
      authType: 'bearer', bearerToken: '{{myOwnKey}}', apiKeyName: '', apiKeyValue: '', apiKeyIn: 'header',
    };
    aiFeature.selectAiPreset.call(host as never, 'openrouter');
    expect(host.authType).toBe('bearer');
    expect(host.bearerToken).toBe('{{myOwnKey}}');
    expect(host.url).toBe('https://openrouter.ai/api/v1');
  });

  it('clears the URL when Custom URL is chosen so the preset changes', () => {
    const host = {
      url: 'https://api.groq.com/openai/v1', aiProvider: 'openai', aiModel: 'x',
      authType: 'bearer', bearerToken: '{{groqApiKey}}', apiKeyName: '', apiKeyValue: '', apiKeyIn: 'header',
    };
    aiFeature.selectAiPreset.call(host as never, 'custom');
    expect(host.url).toBe('');
    expect(aiPresetFor(host.url, host.aiProvider).id).toBe('custom');
    expect(host.bearerToken).toBe('{{apiKey}}');
  });

  it('reads model lists from OpenAI, Anthropic and Ollama style answers', () => {
    expect(parseModelList('{"data":[{"id":"b"},{"id":"a"},{"id":"a"}]}')).toEqual(['a', 'b']);
    expect(parseModelList('{"models":[{"name":"llama3"}]}')).toEqual(['llama3']);
    expect(parseModelList('not json')).toEqual([]);
  });

  it('names the variable when the API key is not set', () => {
    expect(aiUnresolvedKey({ auth: { type: 'bearer', token: '{{openaiApiKey}}' } } as never)).toContain('openaiApiKey');
    expect(aiUnresolvedKey({ auth: { type: 'apikey', keyValue: '{{ anthropicApiKey }}' } } as never)).toContain('anthropicApiKey');
    expect(aiUnresolvedKey({ auth: { type: 'bearer', token: 'sk-real' } } as never)).toBe('');
    expect(aiUnresolvedKey({ auth: { type: 'none' } } as never)).toBe('');
    expect(aiUnresolvedKey({ auth: { type: 'bearer', token: '{{apiKey}}' }, headers: [{ key: 'Authorization', value: 'Bearer sk-x', enabled: true }] } as never)).toBe('');
    for (const key of ['x-auth-token', 'anthropic-api-key', 'x-goog-api-key', 'X-Api-Key']) {
      expect(aiUnresolvedKey({ auth: { type: 'bearer', token: '{{apiKey}}' }, headers: [{ key, value: 'sk-x', enabled: true }] } as never)).toBe('');
    }
    expect(aiUnresolvedKey({ auth: { type: 'bearer', token: '{{apiKey}}' }, headers: [{ key: 'Accept', value: 'json', enabled: true }] } as never)).toContain('apiKey');
  });

  it('builds the request a code snippet shows from the prompt, the model and the settings', () => {
    const http = { ...emptyHttpRequest(), url: 'https://openrouter.ai/api/v1' };
    const user = [{ role: 'user', blocks: [{ type: 'text', text: 'Say hi' }] }];
    const openai = aiHttpPreview({
      http, provider: 'openai', model: 'openai/gpt-4o-mini', system: 'Be brief', messages: user,
      settings: { maxTokens: 50, temperature: 0.2, stream: true, thinking: '', idleTimeoutSec: 0 }, toolServers: [], maxSteps: 0,
    } as never);
    expect(openai.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(JSON.parse(openai.body)).toEqual({
      model: 'openai/gpt-4o-mini',
      messages: [{ role: 'system', content: 'Be brief' }, { role: 'user', content: 'Say hi' }],
      stream: true, stream_options: { include_usage: true }, max_tokens: 50, temperature: 0.2,
    });
    expect(JSON.parse(aiHttpPreview({
      http: { ...http, url: 'https://api.openai.com/v1' }, provider: 'openai', model: 'gpt-5', system: '', messages: user,
      settings: { maxTokens: 10, stream: false, thinking: '', idleTimeoutSec: 0 }, toolServers: [], maxSteps: 0,
    } as never).body)).toEqual({ model: 'gpt-5', messages: [{ role: 'user', content: 'Say hi' }], stream: false, max_completion_tokens: 10 });

    const anthropic = aiHttpPreview({
      http: { ...http, url: 'https://api.anthropic.com/v1' }, provider: 'anthropic', model: 'claude-x', system: 'Be brief', messages: user,
      settings: { maxTokens: 0, stream: true, thinking: 'summarized', idleTimeoutSec: 0 }, toolServers: [], maxSteps: 0,
    } as never);
    expect(anthropic.url).toBe('https://api.anthropic.com/v1/messages');
    expect(anthropic.headers).toContainEqual(expect.objectContaining({ key: 'anthropic-version', value: '2023-06-01' }));
    expect(JSON.parse(anthropic.body)).toEqual({
      model: 'claude-x', messages: [{ role: 'user', content: [{ type: 'text', text: 'Say hi' }] }], stream: true, max_tokens: 8192,
      system: 'Be brief', thinking: { type: 'adaptive', display: 'summarized' },
    });

    const curl = buildSnippet('curl', {
      method: 'POST', url: openai.url, params: [], headers: openai.headers, formData: [], bodyType: 'json', body: openai.body,
      auth: { type: 'bearer', token: '{{openrouterApiKey}}', keyName: '', keyValue: '', keyIn: 'header' },
    }, toCurl);
    expect(curl).toContain('https://openrouter.ai/api/v1/chat/completions');
    expect(curl).toContain('Say hi');
    expect(curl).toContain('Content-Type: application/json');
  });

  it('shows which address a base URL turns into, the same way the backend builds it', () => {
    expect(aiEndpointParts('https://api.deepseek.com/v1', 'openai')).toEqual({ base: 'https://api.deepseek.com/v1', suffix: '/chat/completions', query: '' });
    expect(aiEndpointParts(' https://api.deepseek.com/v1/ ', 'openai').base).toBe('https://api.deepseek.com/v1');
    expect(aiEndpointParts('https://api.deepseek.com/v1/chat/completions', 'openai')).toEqual({ base: 'https://api.deepseek.com/v1/chat/completions', suffix: '', query: '' });
    expect(aiEndpointParts('https://api.anthropic.com/v1', 'anthropic').suffix).toBe('/messages');
    expect(aiEndpointParts('https://x.openai.azure.com/openai/deployments/gpt?api-version=2024-10-21', 'openai'))
      .toEqual({ base: 'https://x.openai.azure.com/openai/deployments/gpt', suffix: '/chat/completions', query: '?api-version=2024-10-21' });
    expect(aiModelsURL('https://api.deepseek.com/v1', 'openai')).toBe('https://api.deepseek.com/v1/models');
    expect(aiModelsURL('https://api.deepseek.com/v1/chat/completions', 'openai')).toBe('https://api.deepseek.com/v1/models');
    expect(aiModelsURL('https://api.anthropic.com/v1/messages', 'anthropic')).toBe('https://api.anthropic.com/v1/models');
    expect(aiModelsURL('https://x.test/v1?api-version=1', 'openai')).toBe('https://x.test/v1/models?api-version=1');
  });

  it('splits a provider error into a status, the message and a hint', () => {
    expect(aiErrorView('402 Payment Required: This request requires more credits.')).toEqual({
      title: 'The provider returned an error',
      status: '402 Payment Required',
      message: 'This request requires more credits.',
      hint: 'Add credits at the provider, or lower Max tokens in Settings.',
    });
    expect(aiErrorView('502 Bad Gateway')).toMatchObject({ status: '502 Bad Gateway', message: '', hint: 'The provider had a problem on its side. Try again in a moment.' });
    expect(aiErrorView('418: teapot')).toMatchObject({ status: '418', message: 'teapot', hint: '' });
    expect(aiErrorView('No data from the model for 5m0s. The stream was stopped.')).toEqual({ title: 'The request failed', status: '', message: 'No data from the model for 5m0s. The stream was stopped.', hint: '' });
  });

  it('explains why the model list could not be loaded', () => {
    const url = 'https://api.example.test/v1/models?key=secret';
    expect(aiModelsProblem({ kind: 'status', url, statusCode: 404, status: '404 Not Found', body: '{"error":{"message":"Not Found"}}' })).toEqual({
      title: 'This server has no model list',
      status: '404 Not Found',
      detail: 'GET https://api.example.test/v1/models',
      hint: 'Check the base URL, or type the model name: some servers do not list their models.',
    });
    expect(aiModelsProblem({ kind: 'status', url, statusCode: 401, status: '401 Unauthorized', body: '{"error":{"message":"Incorrect API key"}}' }))
      .toMatchObject({ title: 'The API key was not accepted', status: '401 Unauthorized', detail: 'GET https://api.example.test/v1/models\nIncorrect API key' });
    expect(aiModelsProblem({ kind: 'status', url, statusCode: 500, status: '500 Internal Server Error', body: '' }))
      .toMatchObject({ title: 'The provider refused the model list', detail: 'GET https://api.example.test/v1/models' });
    expect(aiModelsProblem({ kind: 'network', url, error: 'connection refused' }))
      .toMatchObject({ title: 'Could not reach the provider', status: '', detail: 'GET https://api.example.test/v1/models\nconnection refused' });
    expect(aiModelsProblem({ kind: 'empty', url }).title).toBe('The provider listed no models');
    expect(aiModelsProblem({ kind: 'no-url' }).title).toBe('Enter the base URL first');
    expect(JSON.stringify(aiModelsProblem({ kind: 'network', url, error: 'x' }))).not.toContain('secret');
  });

  it('validates model parameters', () => {
    expect(aiSettingsError({ aiTemperature: '0.7', aiMaxTokens: '512' })).toBe('');
    expect(aiSettingsError({ aiTemperature: '3' })).toContain('Temperature');
    expect(aiSettingsError({ aiMaxTokens: '1.5' })).toContain('Max tokens');
    expect(aiSettingsError({ aiMaxSteps: '99' })).toContain('Step limit');
    expect(aiSettingsError({ aiIdleTimeoutSec: '0' })).toContain('silence');
    expect(aiSettingErrors({ aiTemperature: '2132312231', aiTopP: '0.5', aiMaxTokens: 'abc' })).toEqual({
      aiTemperature: 'Use a number from 0 to 2.',
      aiMaxTokens: 'Use a whole number above 0.',
    });
    expect(aiSettingsError({ aiTemperature: '9' })).toBe('Temperature: 9 is not valid. Use a number from 0 to 2.');
  });
});

describe('ai streaming', () => {
  it('assembles text and growing tool arguments from deltas', () => {
    let current = turn();
    current = applyAiDeltas(current, [
      { sessionId: 'r', step: 0, index: 0, type: 'text', text: 'Hel' },
      { sessionId: 'r', step: 0, index: 0, type: 'text', text: 'lo' },
      { sessionId: 'r', step: 0, index: 1, type: 'tool_use', id: 'c1', name: 'get_weather' },
      { sessionId: 'r', step: 0, index: 1, type: 'tool_use', input: '{"city":' },
      { sessionId: 'r', step: 0, index: 1, type: 'tool_use', input: '"Lisbon"}' },
    ]);
    expect(current.steps[0].blocks[0]).toMatchObject({ type: 'text', text: 'Hello' });
    expect(current.steps[0].blocks[1]).toMatchObject({ type: 'tool_use', id: 'c1', name: 'get_weather', input: '{"city":"Lisbon"}' });
  });

  it('carries finished turns into the next request and skips failed ones', () => {
    const done = turn({
      id: 'a', prompt: 'First', status: 'done',
      response: aiResponse({ messages: [{ role: 'assistant', blocks: [{ type: 'text', text: 'One' }] }] }),
    });
    const failed = turn({ id: 'b', prompt: 'Broken', status: 'error', response: aiResponse({ error: 'boom' }) });
    expect(aiConversationHistory([done, failed])).toEqual([
      { role: 'user', blocks: [{ type: 'text', text: 'First' }] },
      { role: 'assistant', blocks: [{ type: 'text', text: 'One' }] },
    ]);
  });
});

function sendHost(overrides: Record<string, unknown> = {}) {
  const snapshot = { id: 'req-1', collectionId: 'col', aiPrompt: 'Hello', aiModel: 'm', aiProvider: 'openai' } as SavedRequest;
  const host: Record<string, unknown> = {
    activeRequestId: 'req-1',
    requestType: 'ai',
    requestTab: 'body',
    requestError: '',
    activeEnvironmentId: 'env',
    aiConversations: new Map(),
    inFlightRequestIds: new Set<string>(),
    history: 0,
    sent: [] as unknown[],
    guardWorkspaceWritable: () => true,
    snapshotActiveRequest: () => snapshot,
    activeEnvironmentValues: () => ({}),
    activeSecretEnvironmentKeys: () => [],
    activeSecretEnvironmentValues: () => [],
    savedRequestToRunnableAiRequest: (_req: unknown, messages: unknown[]) => ({ http: {}, messages }),
    markRequestLoading: (id: string, loading: boolean) => {
      const next = new Set(host.inFlightRequestIds as Set<string>);
      if (loading) next.add(id); else next.delete(id);
      host.inFlightRequestIds = next;
    },
    requestIsActive: () => true,
    cancelActiveRequest: vi.fn(async () => {}),
    persistActiveRequestNow: async () => {},
    syncBackendEnvironment: async () => {},
    syncActiveEnvironmentFromBackend: async () => {},
    applyEnvironmentChangesFromResponse: async () => {},
    recordRequestHistory: async () => { host.history = (host.history as number) + 1; },
    setActiveResponse: () => {},
    ...overrides,
  };
  for (const [name, fn] of Object.entries(aiFeature)) {
    if (typeof fn === 'function' && !(name in host)) host[name] = (fn as (...args: unknown[]) => unknown).bind(host);
  }
  return host;
}

describe('sending an AI request', () => {
  it('sends the saved prompt as a fresh conversation and keeps the answer', async () => {
    vi.mocked(backend.sendAiRequest).mockResolvedValueOnce(aiResponse({
      text: 'Hi there',
      steps: [{ index: 0, method: '', url: '', requestBody: '', blocks: [{ type: 'text', text: 'Hi there' }], toolResults: [], stopReason: 'end_turn', rawStopReason: 'end_turn', model: 'm', usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, hasUsage: true, firstTokenMs: 10, durationMs: 50, http: { ...emptyHttpResponse(), statusCode: 200 } }],
      messages: [{ role: 'assistant', blocks: [{ type: 'text', text: 'Hi there' }] }],
    }));
    const host = sendHost();
    await (host.sendAiPrompt as () => Promise<void>)();
    const call = vi.mocked(backend.sendAiRequest).mock.calls.at(-1)?.[0];
    expect(call?.messages).toEqual([{ role: 'user', blocks: [{ type: 'text', text: 'Hello' }] }]);
    const turns = (host.aiConversations as Map<string, AiTurn[]>).get('req-1') ?? [];
    expect(turns).toHaveLength(1);
    expect(turns[0].status).toBe('done');
    expect(turns[0].steps[0].blocks[0].text).toBe('Hi there');
    expect(host.history).toBe(1);
    expect((host.inFlightRequestIds as Set<string>).size).toBe(0);
  });

  it('continues the conversation with a reply', async () => {
    const earlier = turn({
      id: 'a', prompt: 'Hello', status: 'done',
      response: aiResponse({ messages: [{ role: 'assistant', blocks: [{ type: 'text', text: 'Hi' }] }] }),
    });
    vi.mocked(backend.sendAiRequest).mockResolvedValueOnce(aiResponse({ text: 'Sure' }));
    const host = sendHost({ aiConversations: new Map([['req-1', [earlier]]]) });
    await (host.sendAiPrompt as (text?: string) => Promise<void>)('And again?');
    const call = vi.mocked(backend.sendAiRequest).mock.calls.at(-1)?.[0];
    expect(call?.messages.map(m => `${m.role}:${m.blocks[0].text}`)).toEqual(['user:Hello', 'assistant:Hi', 'user:And again?']);
    expect((host.aiConversations as Map<string, AiTurn[]>).get('req-1')).toHaveLength(2);
  });

  it('keeps only the history of earlier turns, not their raw request and response bodies', async () => {
    const big = 'x'.repeat(50000);
    const earlier = turn({
      id: 'a', prompt: 'Hello', status: 'done',
      response: aiResponse({
        messages: [{ role: 'assistant', blocks: [{ type: 'text', text: 'Hi' }] }],
        http: { ...emptyHttpResponse(), statusCode: 200, body: big },
        steps: [{ index: 0, method: 'POST', url: 'https://x', requestBody: big, blocks: [{ type: 'text', text: 'Hi' }], toolResults: [], stopReason: 'end_turn', rawStopReason: 'end_turn', model: 'm', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, hasUsage: true, firstTokenMs: 1, durationMs: 2, http: { ...emptyHttpResponse(), statusCode: 200, body: big } }],
      }),
    });
    vi.mocked(backend.sendAiRequest).mockResolvedValueOnce(aiResponse({ text: 'Sure' }));
    const host = sendHost({ aiConversations: new Map([['req-1', [earlier]]]) });
    await (host.sendAiPrompt as (text?: string) => Promise<void>)('More?');
    const [kept] = (host.aiConversations as Map<string, AiTurn[]>).get('req-1') ?? [];
    expect(kept.response?.steps[0].requestBody).toBe('');
    expect(kept.response?.steps[0].http.body).toBe('');
    expect(kept.response?.http.body).toBe('');
    expect(kept.response?.messages[0].blocks[0].text).toBe('Hi');
    expect(compactAiTurn(turn({ id: 'b', prompt: 'p', status: 'error', response: null }))).toMatchObject({ id: 'b', response: null });
  });

  it('refuses prompts, replies and system prompts over the length limit', async () => {
    expect(aiPromptLengthError({ aiSystem: 's'.repeat(AI_SYSTEM_MAX_CHARS), aiPrompt: 'p'.repeat(AI_PROMPT_MAX_CHARS) })).toBe('');
    expect(aiPromptLengthError({ aiSystem: 's'.repeat(AI_SYSTEM_MAX_CHARS + 1), aiPrompt: '' })).toContain('system prompt is longer than 50,000');
    vi.mocked(backend.sendAiRequest).mockClear();
    const host = sendHost({ snapshotActiveRequest: () => ({ id: 'req-1', aiPrompt: 'p'.repeat(AI_PROMPT_MAX_CHARS + 1), aiModel: 'm' }) });
    await (host.sendAiPrompt as () => Promise<void>)();
    expect(host.requestError).toContain('prompt is longer than 200,000');
    const reply = sendHost();
    await (reply.sendAiPrompt as (text?: string) => Promise<void>)('r'.repeat(AI_PROMPT_MAX_CHARS + 1));
    expect(reply.requestError).toContain('message is longer than 200,000');
    expect(backend.sendAiRequest).not.toHaveBeenCalled();
  });

  it('tells the composer whether the reply was sent so it can keep the text', async () => {
    vi.mocked(backend.sendAiRequest).mockClear();
    const noModel = sendHost({ snapshotActiveRequest: () => ({ id: 'req-1', aiPrompt: 'Hello', aiModel: '' }) });
    expect(await (noModel.sendAiPrompt as (text?: string) => Promise<boolean>)('Keep me')).toBe(false);
    expect(noModel.requestError).toBe('Choose a model before sending.');
    const locked = sendHost({ guardWorkspaceWritable: () => false });
    expect(await (locked.sendAiPrompt as (text?: string) => Promise<boolean>)('Keep me')).toBe(false);
    expect(backend.sendAiRequest).not.toHaveBeenCalled();
    vi.mocked(backend.sendAiRequest).mockResolvedValueOnce(aiResponse({ text: 'Sure' }));
    expect(await (sendHost().sendAiPrompt as (text?: string) => Promise<boolean>)('Go')).toBe(true);
  });

  it('sends a reply on Enter and keeps Shift+Enter for a new line', () => {
    const key = (init: Partial<KeyboardEvent>) => ({ key: 'Enter', shiftKey: false, altKey: false, isComposing: false, ...init });
    expect(aiComposerSends(key({}))).toBe(true);
    expect(aiComposerSends(key({ shiftKey: true }))).toBe(false);
    expect(aiComposerSends(key({ altKey: true }))).toBe(false);
    expect(aiComposerSends(key({ isComposing: true }))).toBe(false);
    expect(aiComposerSends({ ...key({}), keyCode: 229 })).toBe(false);
    expect(aiComposerSends(key({ key: 'a' }))).toBe(false);
  });

  it('refuses to send without a prompt or a model', async () => {
    const host = sendHost({ snapshotActiveRequest: () => ({ id: 'req-1', aiPrompt: ' ', aiModel: 'm' }) });
    await (host.sendAiPrompt as () => Promise<void>)();
    expect(host.requestError).toContain('prompt');
    const noModel = sendHost({ snapshotActiveRequest: () => ({ id: 'req-1', aiPrompt: 'Hi', aiModel: '' }) });
    await (noModel.sendAiPrompt as () => Promise<void>)();
    expect(noModel.requestError).toContain('model');
  });

  it('stops the request instead of sending twice', async () => {
    const host = sendHost({ inFlightRequestIds: new Set(['req-1']) });
    await (host.sendAiPrompt as () => Promise<void>)();
    expect(host.cancelActiveRequest).toHaveBeenCalled();
  });

  it('marks a cancelled answer as stopped', async () => {
    vi.mocked(backend.sendAiRequest).mockResolvedValueOnce(aiResponse({ error: 'Cancelled' }));
    const host = sendHost();
    await (host.sendAiPrompt as () => Promise<void>)();
    expect((host.aiConversations as Map<string, AiTurn[]>).get('req-1')?.[0].status).toBe('cancelled');
  });
});

describe('ai request serialization', () => {
  it('builds the provider request with resolved variables, settings and MCP tool servers', () => {
    const mcpServer = { id: 'mcp-1', name: 'Weather', requestType: 'mcp', url: 'http://mcp.test' } as SavedRequest;
    const host = {
      activeEnvironmentValues: () => ({ city: 'Lisbon', model: 'gpt-x' }),
      activeSecretEnvironmentKeys: () => [],
      activeSecretEnvironmentValues: () => [],
      environmentValuesForRequest: (_req: unknown, env: Record<string, string>) => env,
      requestWithCollectionDefaults: (req: SavedRequest) => req,
      resolveTemplate: (value: string, values: Record<string, string> = {}) => value.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? `{{${key}}}`),
      savedRequestToRunnableHttpRequest: () => ({ ...emptyHttpResponse(), url: '', headers: [], testScript: 'pm.test()' }),
      savedRequestToRunnableMcpRequest: (req: SavedRequest) => ({ url: req.url, mcpMethod: '' }),
      requestsById: new Map([['mcp-1', mcpServer]]),
    };
    const req = {
      id: 'req-1', url: 'https://api.openai.com/v1', aiProvider: 'openai', aiModel: '{{model}}', aiSystem: 'Talk about {{city}}',
      aiTemperature: '0.2', aiMaxTokens: '300', aiTopP: '', aiStream: false, aiThinking: 'summarized', aiMaxSteps: '4',
      aiToolRequestIds: ['mcp-1', 'gone'],
    } as SavedRequest;
    const built = requestSerializationFeature.savedRequestToRunnableAiRequest.call(
      host as never, req, [{ role: 'user', blocks: [{ type: 'text', text: 'Weather in {{city}}?' }] }],
    );
    expect(built.model).toBe('gpt-x');
    expect(built.system).toBe('Talk about Lisbon');
    expect(built.messages[0].blocks[0].text).toBe('Weather in Lisbon?');
    expect(built.settings).toMatchObject({ temperature: 0.2, maxTokens: 300, stream: false, thinking: '' });
    expect(built.settings.topP).toBeUndefined();
    expect(built.maxSteps).toBe(4);
    expect(built.toolServers).toEqual([{ name: 'Weather', request: { url: 'http://mcp.test', mcpMethod: '' } }]);
    expect(built.http.method).toBe('POST');
    expect(built.http.testScript).toBe('pm.test()');
  });
});
