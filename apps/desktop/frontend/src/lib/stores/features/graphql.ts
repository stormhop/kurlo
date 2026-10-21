import { openFileDialog, readTextFile, sendHttpRequest } from '../../backend';
import type { RunnableHttpOptions } from './requestSerialization';
import { emptyAuthConfig, emptyHttpRequest } from '../../wire';
import type { HttpRequest } from '../../backend';
import {
  DEFAULT_GRAPHQL_QUERY,
  DEFAULT_GRAPHQL_VARIABLES,
  GRAPHQL_INTROSPECTION_QUERY,
  buildGraphQLExplorerOperation,
  buildGraphQLRequestBody,
  formatGraphQLQuery,
  graphQLExplorerFields,
  graphQLSchemaValidationError,
  normalizeGraphQLSchemaText,
  parseGraphQLPayload,
  parseGraphQLVariables,
  serializeGraphQLPayload,
  type GraphQLExplorerField,
  type GraphQLPayload,
} from '../../graphql';
import type { ResolvedProxy } from '../../proxy';
import type { RequestTab, RequestType, SavedRequest } from '../../types/models';
import { newRequestId, prettyJson } from '../../utils';

type GraphQLHost = {
  activeRequestId: string;
  graphqlOperationName: string;
  graphqlQuery: string;
  graphqlSchema: string;
  graphqlSchemaError: string;
  graphqlSchemaLoading: boolean;
  graphqlSchemaOperationToken: number;
  graphqlSchemaStatus: string;
  graphqlVariables: string;
  requestTab: RequestTab;
  requestType: RequestType;
  url: string;
  activeSecretEnvironmentKeys: () => string[];
  activeSecretEnvironmentValues: () => string[];
  currentGraphQLPayload: () => GraphQLPayload;
  environmentValuesForRequest: (req: Pick<SavedRequest, 'collectionId'>, envValues?: Record<string, string>) => Record<string, string>;
  fetchGraphQLSchemaUrl: (schemaUrl: string) => Promise<{ body: string; status: string; statusCode: number }>;
  graphQLBodyForSend: (payload?: GraphQLPayload) => string;
  importGraphQLSchemaText: (source: string, label?: string) => void;
  normalizeRequestUrlForSend: (rawUrl: string) => string;
  requestWithCollectionDefaults: (req: SavedRequest) => SavedRequest;
  resolveProxyFields: (overrideUrl: string) => ResolvedProxy;
  resolveTemplate: (value: string, values?: Record<string, string>) => string;
  savedRequestToRunnableHttpRequest: (req: SavedRequest, envValues?: Record<string, string>, secretValues?: string[], secretKeys?: string[], requestId?: string, options?: RunnableHttpOptions) => HttpRequest;
  scheduleActiveRequestPersist: () => void;
  snapshotActiveRequest: (options?: { forPersistence?: boolean }) => SavedRequest;
  syncBackendEnvironment: () => Promise<void>;
};

export const graphqlFeature = {
  currentGraphQLPayload(this: GraphQLHost): GraphQLPayload {
    return {
      query: this.graphqlQuery,
      variables: this.graphqlVariables,
      operationName: this.graphqlOperationName,
    };
  },

  graphQLBodyContentForStore(this: GraphQLHost): string {
    return serializeGraphQLPayload(this.currentGraphQLPayload());
  },

  graphQLBodyForSend(this: GraphQLHost, payload = this.currentGraphQLPayload()) {
    return buildGraphQLRequestBody(payload);
  },

  graphQLPayloadFromRequest(this: GraphQLHost, req: Pick<SavedRequest, 'bodyContent'>) {
    return parseGraphQLPayload(req.bodyContent);
  },

  graphQLPayloadError(this: GraphQLHost, payload = this.currentGraphQLPayload()) {
    try {
      this.graphQLBodyForSend(payload);
      return '';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  },

  get graphQLExplorerFields(): GraphQLExplorerField[] {
    return graphQLExplorerFields((this as unknown as GraphQLHost).graphqlSchema);
  },

  applyGraphQLExplorerField(this: GraphQLHost, field: GraphQLExplorerField) {
    const payload = buildGraphQLExplorerOperation(this.graphqlSchema, field.name);
    if (!payload) {
      this.graphqlSchemaStatus = 'Schema does not expose this query field';
      return;
    }
    this.graphqlQuery = payload.query;
    this.graphqlVariables = payload.variables;
    this.graphqlOperationName = '';
    this.requestTab = 'query';
    this.scheduleActiveRequestPersist();
  },

  beautifyGraphQLQuery(this: GraphQLHost) {
    this.graphqlQuery = formatGraphQLQuery(this.graphqlQuery.trim() ? this.graphqlQuery : DEFAULT_GRAPHQL_QUERY);
    this.scheduleActiveRequestPersist();
  },

  graphQLPayloadHasContent(this: GraphQLHost, source: string) {
    const payload = parseGraphQLPayload(source);
    let variablesHaveContent: boolean;
    try {
      variablesHaveContent = Object.keys(parseGraphQLVariables(payload.variables)).length > 0;
    } catch {
      const cleanVariables = payload.variables.trim();
      variablesHaveContent = Boolean(cleanVariables && cleanVariables !== '{}' && cleanVariables !== DEFAULT_GRAPHQL_VARIABLES.trim());
    }
    return Boolean(
      payload.query.trim() && payload.query.trim() !== DEFAULT_GRAPHQL_QUERY.trim()
      || variablesHaveContent
      || payload.operationName.trim()
    );
  },

  async fetchGraphQLSchemaUrl(this: GraphQLHost, schemaUrl: string): Promise<{ body: string; status: string; statusCode: number }> {
    const target = schemaUrl.trim();
    if (!target) return { body: '', status: '', statusCode: 0 };
    const resolvedUrl = this.normalizeRequestUrlForSend(this.resolveTemplate(target, this.environmentValuesForRequest(this.snapshotActiveRequest())));
    if (!window.go?.api?.App?.SendRequest) {
      const resp = await fetch(resolvedUrl, { headers: { Accept: 'application/json, application/graphql, text/plain, */*' } });
      const body = await resp.text();
      if (!resp.ok) throw new Error(`Failed to load schema: ${resp.status} ${resp.statusText}`.trim());
      return { body, status: `${resp.status} ${resp.statusText}`.trim(), statusCode: resp.status };
    }
    const requestId = `graphql-schema-url-${this.activeRequestId || newRequestId()}-${Date.now()}`;
    const effectiveSettings = this.requestWithCollectionDefaults(this.snapshotActiveRequest()).settings;
    const resp = await sendHttpRequest({
      ...emptyHttpRequest(),
      requestId,
      method: 'GET',
      url: resolvedUrl,
      params: [],
      headers: [{ key: 'Accept', value: 'application/json, application/graphql, text/plain, */*', enabled: true, isFile: false, fileName: '', contentType: '' }],
      auth: emptyAuthConfig(),
      bodyType: 'none',
      body: '',
      bodyFilePath: '',
      formData: [],
      preRequestScript: '',
      testScript: '',
      followRedirects: effectiveSettings.followRedirects,
      timeoutMs: effectiveSettings.timeoutMs,
      httpVersion: effectiveSettings.httpVersion,
      enableSSLVerification: effectiveSettings.enableSSLVerification,
      followOriginalMethod: effectiveSettings.followOriginalMethod,
      followAuthorizationHeader: effectiveSettings.followAuthorizationHeader,
      removeRefererHeader: effectiveSettings.removeRefererHeader,
      encodeUrlAutomatically: effectiveSettings.encodeUrlAutomatically,
      disableCookieJar: effectiveSettings.disableCookieJar,
      maxRedirects: effectiveSettings.maxRedirects,
      ...this.resolveProxyFields(effectiveSettings.proxyUrl ?? ''),
      browserEmulation: effectiveSettings.browserEmulation,
      browserOrigin: effectiveSettings.browserOrigin,
      browserWithCredentials: effectiveSettings.browserWithCredentials,
      browserEnforceCORS: effectiveSettings.browserEnforceCORS,
      browserEnforceCSP: effectiveSettings.browserEnforceCSP,
      browserCSP: effectiveSettings.browserCSP,
    });
    if (resp.error && !resp.statusCode) throw new Error(resp.error);
    if (resp.statusCode >= 400) throw new Error(`Failed to load schema: ${resp.status || resp.statusCode}`);
    return { body: resp.body, status: resp.status || 'Schema imported', statusCode: resp.statusCode };
  },

  importGraphQLSchemaText(this: GraphQLHost, source: string, label = 'Schema imported') {
    this.graphqlSchema = normalizeGraphQLSchemaText(source);
    const validationError = this.graphqlSchema ? graphQLSchemaValidationError(this.graphqlSchema) : '';
    this.graphqlSchemaError = validationError;
    this.graphqlSchemaStatus = this.graphqlSchema ? (validationError ? 'Schema imported with issues' : label) : 'Selected schema file is empty';
    this.scheduleActiveRequestPersist();
  },

  async importGraphQLSchemaFromUrl(this: GraphQLHost, schemaUrl: string) {
    if (!schemaUrl.trim() || this.graphqlSchemaLoading) return;
    const ownerId = this.activeRequestId;
    const operationToken = ++this.graphqlSchemaOperationToken;
    const stillOwned = () => this.activeRequestId === ownerId && this.graphqlSchemaOperationToken === operationToken;
    this.graphqlSchemaLoading = true;
    this.graphqlSchemaStatus = '';
    this.graphqlSchemaError = '';
    try {
      try { await this.syncBackendEnvironment(); } catch {}
      if (!stillOwned()) return;
      const resp = await this.fetchGraphQLSchemaUrl(schemaUrl);
      if (!stillOwned()) return;
      const validationError = graphQLSchemaValidationError(resp.body);
      if (validationError) throw new Error(validationError);
      this.importGraphQLSchemaText(resp.body, resp.status || 'Schema imported from URL');
    } catch (error) {
      if (stillOwned()) this.graphqlSchemaError = error instanceof Error ? error.message : String(error);
    } finally {
      if (stillOwned()) this.graphqlSchemaLoading = false;
    }
  },

  async importGraphQLSchemaFromFile(this: GraphQLHost) {
    if (this.graphqlSchemaLoading) return false;
    const ownerId = this.activeRequestId;
    const operationToken = ++this.graphqlSchemaOperationToken;
    const stillOwned = () => this.activeRequestId === ownerId && this.graphqlSchemaOperationToken === operationToken;
    const path = await openFileDialog('Import GraphQL schema');
    if (!stillOwned()) return true;
    if (!path) return true;
    this.graphqlSchemaLoading = true;
    this.graphqlSchemaStatus = '';
    this.graphqlSchemaError = '';
    try {
      const content = await readTextFile(path);
      if (!stillOwned()) return true;
      this.importGraphQLSchemaText(content, `Imported ${path.split('/').pop() ?? 'schema file'}`);
    } catch (error) {
      if (stillOwned()) this.graphqlSchemaError = error instanceof Error ? error.message : String(error);
    } finally {
      if (stillOwned()) this.graphqlSchemaLoading = false;
    }
    return true;
  },

  async fetchGraphQLSchema(this: GraphQLHost) {
    if (this.requestType !== 'graphql' || this.graphqlSchemaLoading) return;
    if (!this.url.trim()) {
      this.graphqlSchemaStatus = '';
      this.graphqlSchemaError = 'Invalid URL ""';
      return;
    }
    const ownerId = this.activeRequestId;
    const operationToken = ++this.graphqlSchemaOperationToken;
    const stillOwned = () => this.activeRequestId === ownerId && this.graphqlSchemaOperationToken === operationToken;
    const requestId = `graphql-schema-${this.activeRequestId || newRequestId()}-${Date.now()}`;
    const envValues = this.environmentValuesForRequest(this.snapshotActiveRequest());
    const secretValues = this.activeSecretEnvironmentValues();
    const secretKeys = this.activeSecretEnvironmentKeys();
    const snapshot = {
      ...this.snapshotActiveRequest(),
      requestType: 'graphql' as const,
      method: 'POST' as const,
      bodyType: 'graphql' as const,
      bodyContent: serializeGraphQLPayload({
        query: GRAPHQL_INTROSPECTION_QUERY,
        variables: DEFAULT_GRAPHQL_VARIABLES,
        operationName: 'IntrospectionQuery',
      }),
      preRequestScript: '',
      testScript: '',
    };
    this.graphqlSchemaLoading = true;
    this.graphqlSchemaStatus = '';
    this.graphqlSchemaError = '';
    try {
      try { await this.syncBackendEnvironment(); } catch {}
      if (!stillOwned()) return;
      const resp = await sendHttpRequest(this.savedRequestToRunnableHttpRequest(snapshot, envValues, secretValues, secretKeys, requestId, { deferTemplates: true }));
      if (!stillOwned()) return;
      if (resp.error && !resp.statusCode) {
        this.graphqlSchemaError = resp.error;
        return;
      }
      if (resp.statusCode >= 400) {
        this.graphqlSchemaError = resp.status || `HTTP ${resp.statusCode}`;
        return;
      }
      const validationError = graphQLSchemaValidationError(resp.body);
      if (validationError) {
        this.graphqlSchemaError = validationError;
        return;
      }
      this.graphqlSchema = resp.body ? normalizeGraphQLSchemaText(prettyJson(resp.body)) : '';
      this.graphqlSchemaError = '';
      this.graphqlSchemaStatus = resp.statusCode ? `${resp.statusCode} ${resp.status.replace(String(resp.statusCode), '').trim()}`.trim() : 'Schema loaded';
      this.scheduleActiveRequestPersist();
    } catch (error) {
      if (stillOwned()) this.graphqlSchemaError = error instanceof Error ? error.message : String(error);
    } finally {
      if (stillOwned()) this.graphqlSchemaLoading = false;
    }
  },

  clearGraphQLSchema(this: GraphQLHost) {
    this.graphqlSchema = '';
    this.graphqlSchemaStatus = '';
    this.graphqlSchemaError = '';
    this.scheduleActiveRequestPersist();
  },
};
