import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/backend', async () => {
  const wire = await import('../lib/wire');
  return { ...wire, sendAiRequest: vi.fn(), sendHttpRequest: vi.fn() };
});

import * as backend from '../lib/backend';
import type { AiResponse } from '../lib/backend';
import { emptyHttpResponse } from '../lib/wire';
import {
  AI_PRESETS,
  aiConversationHistory,
  aiFeature,
  aiPresetFor,
  aiSettingsError,
  aiUnresolvedKey,
  applyAiDeltas,
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
  });

  it('validates model parameters', () => {
    expect(aiSettingsError({ aiTemperature: '0.7', aiMaxTokens: '512' })).toBe('');
    expect(aiSettingsError({ aiTemperature: '3' })).toContain('Temperature');
    expect(aiSettingsError({ aiMaxTokens: '1.5' })).toContain('Max tokens');
    expect(aiSettingsError({ aiMaxSteps: '99' })).toContain('Step limit');
    expect(aiSettingsError({ aiIdleTimeoutSec: '0' })).toContain('silence');
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
      steps: [{ index: 0, blocks: [{ type: 'text', text: 'Hi there' }], toolResults: [], stopReason: 'end_turn', rawStopReason: 'end_turn', model: 'm', usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, hasUsage: true, firstTokenMs: 10, durationMs: 50, http: { ...emptyHttpResponse(), statusCode: 200 } }],
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
