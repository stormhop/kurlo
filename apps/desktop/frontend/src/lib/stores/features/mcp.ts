import { sendMcpRequest } from '../../backend';
import { emptyHttpResponse } from '../../wire';
import type { HttpRequest, McpResponse, McpTool } from '../../backend';
import type { RequestTab, RequestType, SavedRequest } from '../../types/models';
import { newRequestId } from '../../utils';

export const MCP_METHODS = [
  'server/discover',
  'tools/list',
  'tools/call',
  'resources/list',
  'resources/read',
  'prompts/list',
  'prompts/get',
] as const;

export const MCP_STATELESS_PROTOCOL_VERSION = '2026-07-28';

export function mcpSessionProtocolVersion(response: McpResponse | null | undefined): string {
  const version = response?.protocolVersion ?? '';
  return version && version !== MCP_STATELESS_PROTOCOL_VERSION ? version : '';
}

const NAMED_METHODS = new Set<string>(['tools/call', 'resources/read', 'prompts/get']);

export function mcpMethodNeedsName(method: string) {
  return NAMED_METHODS.has(method);
}

export function mcpMethodTakesArguments(method: string) {
  return method === 'tools/call' || method === 'prompts/get';
}

export function mcpNameLabelFor(method: string) {
  if (method === 'resources/read') return 'Resource URI';
  if (method === 'prompts/get') return 'Prompt';
  return 'Tool';
}

type McpHost = {
  activeRequestId: string;
  requestType: RequestType;
  requestTab: RequestTab;
  requestError: string;
  loading: boolean;
  url: string;
  mcpMethod: string;
  mcpName: string;
  mcpArguments: string;
  mcpProtocolVersion: string;
  mcpResponse: McpResponse | null;
  mcpResponses: Map<string, McpResponse>;
  mcpCatalog: McpResponse | null;
  mcpCatalogLoading: boolean;
  mcpCatalogError: string;
  mcpCatalogOperationToken: number;
  responseSearch: string;
  responseSearchIndex: number;
  guardWorkspaceWritable: (action?: string) => boolean;
  snapshotActiveRequest: (options?: { forPersistence?: boolean }) => SavedRequest;
  activeEnvironmentValues: () => Record<string, string>;
  activeSecretEnvironmentKeys: () => string[];
  activeSecretEnvironmentValues: () => string[];
  environmentValuesForRequest: (req: Pick<SavedRequest, 'collectionId'>, envValues?: Record<string, string>) => Record<string, string>;
  savedRequestToRunnableMcpRequest: (
    req: SavedRequest,
    envValues?: Record<string, string>,
    secretEnvironmentValues?: string[],
    secretEnvironmentKeys?: string[],
    requestId?: string,
    overrides?: { method?: string; name?: string; args?: string; inputSchema?: string; outputSchema?: string; cursor?: string },
  ) => HttpRequest;
  markRequestLoading: (requestId: string, loading: boolean) => void;
  requestIsActive: (requestId: string) => boolean;
  cancelActiveRequest: () => Promise<void>;
  persistActiveRequestNow: () => Promise<void>;
  syncBackendEnvironment: () => Promise<void>;
  syncActiveEnvironmentFromBackend: () => Promise<void>;
  recordRequestHistory: (response: ReturnType<typeof emptyHttpResponse>, req: SavedRequest) => Promise<void>;
  setActiveResponse: (response: null, requestId?: string) => void;
  setActiveMcpResponse: (response: McpResponse | null, requestId?: string) => void;
  mcpSelectedTool: () => McpTool | undefined;
  mcpSelectableTools: () => McpTool[];
  mcpArgumentsError: () => string;
};

export const mcpFeature = {
  setActiveMcpResponse(this: McpHost, response: McpResponse | null, requestId = this.activeRequestId) {
    this.mcpResponse = response;
    if (!requestId) return;
    const next = new Map(this.mcpResponses);
    if (response) next.set(requestId, response);
    else next.delete(requestId);
    this.mcpResponses = next;
  },

  mcpSelectableTools(this: McpHost): McpTool[] {
    return this.mcpCatalog?.tools ?? [];
  },

  mcpSelectedTool(this: McpHost): McpTool | undefined {
    return this.mcpSelectableTools().find(tool => tool.name === this.mcpName);
  },

  mcpSelectedToolRejection(this: McpHost): string {
    return this.mcpSelectedTool()?.rejected ?? '';
  },

  selectMcpTool(this: McpHost, name: string) {
    this.mcpName = name;
    if (this.mcpMethod !== 'tools/call') this.mcpMethod = 'tools/call';
    const tool = this.mcpSelectedTool();
    if (tool && !this.mcpArguments.trim()) {
      this.mcpArguments = mcpArgumentTemplate(tool.inputSchema ?? '');
    }
  },

  selectMcpMethod(this: McpHost, method: string) {
    this.mcpMethod = method;
    if (!mcpMethodNeedsName(method)) this.mcpName = '';
  },

  mcpArgumentsError(this: McpHost): string {
    if (!mcpMethodTakesArguments(this.mcpMethod)) return '';
    const text = this.mcpArguments.trim();
    if (!text) return '';
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return 'Arguments must be a JSON object.';
      }
      return '';
    } catch (error) {
      return error instanceof Error ? error.message : 'Arguments are not valid JSON.';
    }
  },

  async discoverMcpServer(this: McpHost) {
    if (this.requestType !== 'mcp' || this.mcpCatalogLoading) return;
    if (!this.url.trim()) {
      this.mcpCatalogError = 'Enter the MCP endpoint first.';
      return;
    }
    const ownerId = this.activeRequestId;
    const token = ++this.mcpCatalogOperationToken;
    const stillOwned = () => this.activeRequestId === ownerId && this.mcpCatalogOperationToken === token;

    const snapshot = this.snapshotActiveRequest();
    const envValues = this.environmentValuesForRequest(snapshot);
    const secretValues = this.activeSecretEnvironmentValues();
    const secretKeys = this.activeSecretEnvironmentKeys();
    const call = (method: string) => sendMcpRequest(this.savedRequestToRunnableMcpRequest(
      snapshot, envValues, secretValues, secretKeys,
      `mcp-discover-${ownerId || newRequestId()}-${Date.now()}`,
      { method },
    ));

    this.mcpCatalogLoading = true;
    this.mcpCatalogError = '';
    try {
      try { await this.syncBackendEnvironment(); } catch {  }
      const discovered = await call('server/discover');
      if (!stillOwned()) return;
      const failure = mcpFailureMessage(discovered);
      if (failure) {
        this.mcpCatalogError = failure;
        this.mcpCatalog = null;
        return;
      }

      const catalog: McpResponse = { ...discovered, tools: [], resources: [], prompts: [] };
      const capabilities = new Set(discovered.capabilities ?? []);
      for (const [capability, method, key] of [
        ['tools', 'tools/list', 'tools'],
        ['resources', 'resources/list', 'resources'],
        ['prompts', 'prompts/list', 'prompts'],
      ] as const) {
        if (!capabilities.has(capability)) continue;
        const listed = await call(method);
        if (!stillOwned()) return;
        if (mcpFailureMessage(listed)) continue;
        Object.assign(catalog, { [key]: listed[key] ?? [] });
      }
      this.mcpCatalog = catalog;
    } catch (error) {
      if (stillOwned()) this.mcpCatalogError = error instanceof Error ? error.message : String(error);
    } finally {
      if (stillOwned()) this.mcpCatalogLoading = false;
    }
  },

  async sendMcpCall(this: McpHost) {
    if (!this.guardWorkspaceWritable('Sending requests')) return;
    if (this.loading) {
      await this.cancelActiveRequest();
      return;
    }
    if (!this.url.trim()) return;
    if (mcpMethodNeedsName(this.mcpMethod) && !this.mcpName.trim()) {
      this.requestError = `${mcpNameLabelFor(this.mcpMethod)} is empty — choose one before sending.`;
      return;
    }
    const argumentsError = this.mcpArgumentsError();
    if (argumentsError) {
      this.requestError = argumentsError;
      this.requestTab = 'body';
      return;
    }

    const snapshot = this.snapshotActiveRequest();
    const envValues = this.activeEnvironmentValues();
    const secretValues = this.activeSecretEnvironmentValues();
    const secretKeys = this.activeSecretEnvironmentKeys();
    const requestId = this.activeRequestId || newRequestId();
    const tool = this.mcpSelectedTool();

    this.markRequestLoading(requestId, true);
    this.requestError = '';
    this.setActiveResponse(null, requestId);
    this.setActiveMcpResponse(null, requestId);
    this.responseSearch = '';
    this.responseSearchIndex = 0;
    try {
      await this.persistActiveRequestNow();
      try { await this.syncBackendEnvironment(); } catch {  }
      const response = await sendMcpRequest(this.savedRequestToRunnableMcpRequest(
        snapshot, envValues, secretValues, secretKeys, requestId,
        { inputSchema: tool?.inputSchema ?? '', outputSchema: tool?.outputSchema ?? '' },
      ));
      try { await this.syncActiveEnvironmentFromBackend(); } catch {  }
      if (this.requestIsActive(requestId)) {
        this.requestError = mcpFailureMessage(response);
        this.setActiveMcpResponse(response, requestId);
      }
      await this.recordRequestHistory({
        ...emptyHttpResponse(),
        statusCode: response.http?.statusCode ?? 0,
        status: response.http?.status || 'MCP',
        headers: response.http?.headers ?? [],
        body: response.http?.body ?? '',
        duration: response.http?.duration ?? 0,
        size: response.http?.size ?? 0,
      }, snapshot);
    } catch (error) {
      if (this.requestIsActive(requestId)) {
        this.requestError = error instanceof Error ? error.message : String(error);
      }
    } finally {
      this.markRequestLoading(requestId, false);
    }
  },
};

export function mcpFailureMessage(response: McpResponse): string {
  if (response.error) return response.error;
  if (response.rpcErrorMessage) {
    return response.rpcErrorCode
      ? `${response.rpcErrorMessage} (${response.rpcErrorCode})`
      : response.rpcErrorMessage;
  }
  return '';
}

export function mcpArgumentTemplate(inputSchemaJSON: string): string {
  const text = inputSchemaJSON.trim();
  if (!text) return '';
  let schema: Record<string, unknown>;
  try {
    schema = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return '';
  }
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties) return '';
  const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
  const names = required.length ? required : Object.keys(properties);
  const seed: Record<string, unknown> = {};
  for (const name of names) {
    const property = properties[name];
    if (!property) continue;
    seed[name] = mcpSeedValue(property);
  }
  if (!Object.keys(seed).length) return '';
  return JSON.stringify(seed, null, 2);
}

function mcpSeedValue(property: Record<string, unknown>): unknown {
  if (Array.isArray(property.enum) && property.enum.length) return property.enum[0];
  if ('default' in property) return property.default;
  const declared = typeof property.type === 'string'
    ? property.type
    : Array.isArray(property.type) ? String(property.type.find(entry => entry !== 'null') ?? '') : '';
  switch (declared) {
    case 'string': return '';
    case 'integer':
    case 'number': return 0;
    case 'boolean': return false;
    case 'array': return [];
    case 'object': return {};
    default: return null;
  }
}
