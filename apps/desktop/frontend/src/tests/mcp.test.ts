import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/backend', async () => {
  const wire = await import('../lib/wire');
  return { ...wire, sendMcpRequest: vi.fn() };
});

import * as backend from '../lib/backend';
import type { McpResponse } from '../lib/backend';
import { emptyHttpResponse } from '../lib/wire';
import {
  MCP_METHODS,
  mcpSessionProtocolVersion,
  mcpArgumentTemplate,
  mcpFailureMessage,
  mcpFeature,
  mcpMethodNeedsName,
  mcpMethodTakesArguments,
  mcpNameLabelFor,
} from '../lib/stores/features/mcp';
import { normalizeSavedRequest } from '../lib/normalizers';
import { requestCrudFeature } from '../lib/stores/features/requestCrud';
import { requestKindFor, requestBadgeLabel, requestSupportsCurl } from '../lib/utils';

function mcpResponse(overrides: Partial<McpResponse> = {}): McpResponse {
  return {
    http: { ...emptyHttpResponse(), statusCode: 200, status: '200 OK' },
    serverName: '', serverVersion: '', instructions: '',
    supportedVersions: [], capabilities: [],
    resultType: 'complete', result: '', content: [], structuredContent: '',
    isError: false, tools: [], resources: [], prompts: [],
    nextCursor: '', ttlMs: 0, cacheScope: '',
    inputRequests: '', requestState: '',
    notifications: [], rpcErrorCode: 0, rpcErrorMessage: '', rpcErrorData: '',
    warnings: [], error: '',
    ...overrides,
  } as McpResponse;
}

function makeHost(overrides: Record<string, unknown> = {}) {
  const host = {
    activeRequestId: 'req-1',
    requestType: 'mcp',
    requestTab: 'body',
    requestError: '',
    loading: false,
    url: 'https://example.test/mcp',
    mcpMethod: 'tools/list',
    mcpName: '',
    mcpArguments: '',
    mcpProtocolVersion: '',
    mcpResponse: null,
    mcpResponses: new Map(),
    mcpCatalog: null,
    mcpCatalogLoading: false,
    mcpCatalogError: '',
    mcpCatalogOperationToken: 0,
    responseSearch: '',
    responseSearchIndex: 0,
    sentRequests: [] as unknown[],
    historyRecorded: 0,
    guardWorkspaceWritable: () => true,
    snapshotActiveRequest: () => ({ id: 'req-1', collectionId: 'col-1' }),
    activeEnvironmentValues: () => ({}),
    activeSecretEnvironmentKeys: () => [],
    activeSecretEnvironmentValues: () => [],
    environmentValuesForRequest: () => ({}),
    savedRequestToRunnableMcpRequest: (
      _req: unknown,
      _env?: unknown,
      _sv?: unknown,
      _sk?: unknown,
      _id?: string,
      overridesArg: Record<string, string> = {},
    ) => {
      const built = {
        url: host.url,
        mcpMethod: overridesArg.method ?? host.mcpMethod,
        mcpName: host.mcpName,
        mcpArguments: host.mcpArguments,
        mcpInputSchema: overridesArg.inputSchema ?? '',
        mcpOutputSchema: overridesArg.outputSchema ?? '',
      };
      host.sentRequests.push(built);
      return built;
    },
    markRequestLoading: () => {},
    requestIsActive: () => true,
    cancelActiveRequest: async () => {},
    persistActiveRequestNow: async () => {},
    syncBackendEnvironment: async () => {},
    syncActiveEnvironmentFromBackend: async () => {},
    recordRequestHistory: async () => { host.historyRecorded += 1; },
    setActiveResponse: () => {},
    ...overrides,
  };
  return Object.assign(host, Object.fromEntries(
    Object.entries(mcpFeature).map(([key, value]) => [key, (value as () => unknown).bind(host)]),
  )) as typeof host & Record<string, (...args: never[]) => unknown>;
}

describe('mcp request shape', () => {
  it('is a request type of its own, and not one cURL can express', () => {
    expect(MCP_METHODS).toContain('tools/call');
    expect(requestKindFor({ requestType: 'mcp' })).toBe('mcp');
    expect(requestBadgeLabel({ requestType: 'mcp' })).toBe('MCP');
    expect(requestSupportsCurl({ requestType: 'mcp' })).toBe(false);
  });

  it('normalizes into a listable call with the arguments tab open', () => {
    const request = normalizeSavedRequest(
      { id: 'r1', requestType: 'mcp', url: 'https://example.test/mcp' } as never,
      [],
      'workspace-main',
    );
    expect(request.requestType).toBe('mcp');
    expect(request.mcpMethod).toBe('tools/list');
    expect(request.requestTab).toBe('body');
  });

  it('keeps the method, name and arguments across a round trip through the store shape', () => {
    const request = normalizeSavedRequest(
      {
        id: 'r1', requestType: 'mcp', url: 'https://example.test/mcp',
        mcpMethod: 'tools/call', mcpName: 'get_weather', mcpArguments: '{"location":"Seattle"}',
      } as never,
      [],
      'workspace-main',
    );
    expect(request.mcpMethod).toBe('tools/call');
    expect(request.mcpName).toBe('get_weather');
    expect(request.mcpArguments).toBe('{"location":"Seattle"}');
  });

  it('knows which methods carry a name and which carry arguments', () => {
    expect(mcpMethodNeedsName('tools/call')).toBe(true);
    expect(mcpMethodNeedsName('tools/list')).toBe(false);
    expect(mcpMethodTakesArguments('tools/call')).toBe(true);
    expect(mcpMethodTakesArguments('resources/read')).toBe(false);
    expect(mcpNameLabelFor('resources/read')).toBe('Resource URI');
  });
});

describe('switching an existing request to mcp', () => {
  function switchHost(overrides: Record<string, unknown> = {}) {
    const host = {
      requestTypeEditable: true,
      requestType: 'http',
      requestTab: 'params',
      method: 'GET',
      url: 'https://example.test/mcp',
      bodyType: 'json',
      rawBodyType: 'json',
      bodyContent: '{"a":1}',
      authType: 'none',
      apiKeyIn: 'header',
      mcpMethod: '',
      graphqlQuery: '', graphqlVariables: '', graphqlOperationName: '',
      graphqlSchema: '', graphqlSchemaStatus: '', graphqlSchemaError: '',
      sseDisconnect: async () => {},
      webSocketDisconnect: async () => {},
      socketIODisconnect: async () => {},
      normalizeRequestTypeValue: (value: unknown) => value,
      graphQLBodyContentForStore: () => '',
      ...overrides,
    };
    return Object.assign(host, {
      selectRequestType: requestCrudFeature.selectRequestType.bind(host),
    }) as typeof host & { selectRequestType: (type: string) => void };
  }

  it('leaves a tab the type actually has', () => {
    const host = switchHost();
    host.selectRequestType('mcp');
    expect(host.requestType).toBe('mcp');
    expect(host.requestTab).toBe('body');
    expect(host.method).toBe('POST');
    expect(host.mcpMethod).toBe('tools/list');
  });

  it('keeps a shared tab the user was already on', () => {
    const host = switchHost({ requestTab: 'headers' });
    host.selectRequestType('mcp');
    expect(host.requestTab).toBe('headers');
  });

  it('clears the http body, because the arguments are not one', () => {
    const host = switchHost();
    host.selectRequestType('mcp');
    expect(host.bodyType).toBe('none');
    expect(host.bodyContent).toBe('');
  });
});

describe('mcp argument template', () => {
  it('seeds the required properties of the tool schema, with values of the right shape', () => {
    const seeded = mcpArgumentTemplate(JSON.stringify({
      type: 'object',
      properties: {
        location: { type: 'string' },
        days: { type: 'integer' },
        metric: { type: 'boolean' },
        ignored: { type: 'string' },
      },
      required: ['location', 'days', 'metric'],
    }));
    expect(JSON.parse(seeded)).toEqual({ location: '', days: 0, metric: false });
  });

  it('prefers an enum or a default over an empty value', () => {
    const seeded = mcpArgumentTemplate(JSON.stringify({
      type: 'object',
      properties: {
        region: { type: 'string', enum: ['us-west1', 'eu-west1'] },
        limit: { type: 'integer', default: 25 },
      },
      required: ['region', 'limit'],
    }));
    expect(JSON.parse(seeded)).toEqual({ region: 'us-west1', limit: 25 });
  });

  it('says nothing when there is nothing to seed', () => {
    expect(mcpArgumentTemplate('')).toBe('');
    expect(mcpArgumentTemplate('not json')).toBe('');
    expect(mcpArgumentTemplate('{"type":"object"}')).toBe('');
  });
});

describe('mcp protocol version', () => {
  it('names the revision only for a server that needs a session', () => {
    expect(mcpSessionProtocolVersion({ protocolVersion: '2025-06-18' } as McpResponse)).toBe('2025-06-18');
    expect(mcpSessionProtocolVersion({ protocolVersion: '2026-07-28' } as McpResponse)).toBe('');
    expect(mcpSessionProtocolVersion({} as McpResponse)).toBe('');
    expect(mcpSessionProtocolVersion(null)).toBe('');
  });
});

describe('mcp failures', () => {
  it('treats a JSON-RPC error as a failure and a tool error as a result', () => {
    expect(mcpFailureMessage(mcpResponse({ rpcErrorCode: -32601, rpcErrorMessage: 'Method not found' })))
      .toBe('Method not found (-32601)');
    expect(mcpFailureMessage(mcpResponse({ error: 'dial tcp: refused' }))).toBe('dial tcp: refused');
    expect(mcpFailureMessage(mcpResponse({ isError: true }))).toBe('');
  });
});

describe('mcp discovery', () => {
  beforeEach(() => {
    vi.mocked(backend.sendMcpRequest).mockReset();
  });

  it('asks only for the catalogues the server says it has', async () => {
    const asked: string[] = [];
    vi.mocked(backend.sendMcpRequest).mockImplementation(async (req) => {
      asked.push(req.mcpMethod);
      if (req.mcpMethod === 'server/discover') {
        return mcpResponse({ serverName: 'Weather', capabilities: ['tools'] });
      }
      return mcpResponse({ tools: [{ name: 'get_weather', title: '', description: '', inputSchema: '', outputSchema: '', annotations: '', rejected: '' }] });
    });

    const host = makeHost();
    await host.discoverMcpServer();

    expect(asked).toEqual(['server/discover', 'tools/list']);
    expect(asked).not.toContain('prompts/list');
    expect(host.mcpCatalog?.serverName).toBe('Weather');
    expect(host.mcpCatalog?.tools).toHaveLength(1);
    expect(host.mcpCatalogLoading).toBe(false);
  });

  it('reports why discovery failed instead of leaving a stale catalogue', async () => {
    vi.mocked(backend.sendMcpRequest).mockResolvedValue(
      mcpResponse({ rpcErrorCode: -32021, rpcErrorMessage: 'Unsupported protocol version' }),
    );
    const host = makeHost({ mcpCatalog: mcpResponse({ serverName: 'Stale' }) });

    await host.discoverMcpServer();

    expect(host.mcpCatalogError).toContain('Unsupported protocol version');
    expect(host.mcpCatalog).toBeNull();
  });

  it('refuses to discover without an endpoint', async () => {
    const host = makeHost({ url: '   ' });
    await host.discoverMcpServer();
    expect(backend.sendMcpRequest).not.toHaveBeenCalled();
    expect(host.mcpCatalogError).toContain('endpoint');
  });
});

describe('mcp calls', () => {
  beforeEach(() => {
    vi.mocked(backend.sendMcpRequest).mockReset();
  });

  it('sends the selected tool schemas so the answer can be checked against them', async () => {
    vi.mocked(backend.sendMcpRequest).mockResolvedValue(mcpResponse({ content: [{ type: 'text', text: 'ok' }] as never }));
    const host = makeHost({
      mcpMethod: 'tools/call',
      mcpName: 'get_weather',
      mcpCatalog: mcpResponse({
        tools: [{
          name: 'get_weather', title: '', description: '',
          inputSchema: '{"type":"object"}', outputSchema: '{"type":"object"}',
          annotations: '', rejected: '',
        }],
      }),
    });

    await host.sendMcpCall();

    const sent = host.sentRequests.at(-1) as Record<string, string>;
    expect(sent.mcpInputSchema).toBe('{"type":"object"}');
    expect(sent.mcpOutputSchema).toBe('{"type":"object"}');
    expect(host.mcpResponse).not.toBeNull();
    expect(host.historyRecorded).toBe(1);
  });

  it('refuses a call with no tool chosen, and says which field is empty', async () => {
    const host = makeHost({ mcpMethod: 'tools/call', mcpName: '  ' });
    await host.sendMcpCall();
    expect(backend.sendMcpRequest).not.toHaveBeenCalled();
    expect(host.requestError).toContain('Tool');
  });

  it('refuses arguments that are not a JSON object, before anything is sent', async () => {
    const host = makeHost({ mcpMethod: 'tools/call', mcpName: 'x', mcpArguments: '[1,2]' });
    await host.sendMcpCall();
    expect(backend.sendMcpRequest).not.toHaveBeenCalled();
    expect(host.requestError).toContain('must be a JSON object');
    expect(host.requestTab).toBe('body');
  });

  it('a tool execution error is shown as a result, not as a send failure', async () => {
    vi.mocked(backend.sendMcpRequest).mockResolvedValue(mcpResponse({
      isError: true,
      content: [{ type: 'text', text: 'Invalid departure date' }] as never,
    }));
    const host = makeHost({ mcpMethod: 'tools/call', mcpName: 'book' });

    await host.sendMcpCall();

    expect(host.requestError).toBe('');
    expect(host.mcpResponse?.isError).toBe(true);
  });

  it('keeps a rejected tool in the catalogue and names why it cannot be called', () => {
    const host = makeHost({
      mcpMethod: 'tools/call',
      mcpName: 'execute_sql',
      mcpCatalog: mcpResponse({
        tools: [{
          name: 'execute_sql', title: '', description: '', inputSchema: '', outputSchema: '',
          annotations: '', rejected: 'x-mcp-header "Bad Header" is not a valid HTTP header name',
        }],
      }),
    });
    expect(host.mcpSelectableTools()).toHaveLength(1);
    expect(host.mcpSelectedToolRejection()).toContain('not a valid HTTP header name');
  });

  it('seeds the arguments from the schema when a tool is chosen', () => {
    const host = makeHost({
      mcpCatalog: mcpResponse({
        tools: [{
          name: 'get_weather', title: '', description: '',
          inputSchema: '{"type":"object","properties":{"location":{"type":"string"}},"required":["location"]}',
          outputSchema: '', annotations: '', rejected: '',
        }],
      }),
    });

    host.selectMcpTool('get_weather');

    expect(host.mcpMethod).toBe('tools/call');
    expect(JSON.parse(host.mcpArguments)).toEqual({ location: '' });
  });

  it('clears the name when a method that takes none is chosen', () => {
    const host = makeHost({ mcpMethod: 'tools/call', mcpName: 'get_weather' });
    host.selectMcpMethod('tools/list');
    expect(host.mcpName).toBe('');
  });
});
