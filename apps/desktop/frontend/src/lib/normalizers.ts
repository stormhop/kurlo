import type {
    Collection,
    Environment,
    Method,
    RequestHistoryEntry,
    RequestTab,
    RequestType,
    SavedRequest,
    SIOArg,
    Workspace,
    RequestSettingsOverrides,
} from './types/models';
import {
    DEFAULT_COLLECTION,
    DEFAULT_REQUEST_SETTINGS,
    DEFAULT_WORKSPACE,
    mkRow,
} from './constants';
import { emptyCollectionDefaults, normalizeCollectionDefaults, normalizeRequestSettingsOverrides } from './collectionDefaults';
import { normalizeRequestExamples } from './examples';
import { normalizeCollectionFolderPaths } from './collections';
import { defaultSocketIOArgs, requestBodyDefaultsFor } from './requestBodyDefaults';
import {
    asText,
    cloneRowsForStore,
    emptyAuthState,
    finiteNumber,
    newEntityId,
    newRequestId,
    normalizeBodyTypeForUi,
    normalizeRawBodyTypeForUi,
    requestTitleFrom,
    restoreRows,
    sanitizeLike,
} from './utils';

type FieldTypes = { strings?: string[]; booleans?: string[]; arrays?: string[]; objects?: string[] };

function sanitizeFields<T>(input: Partial<T> | null | undefined, fields: FieldTypes): Partial<T> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
    const clean: Record<string, unknown> = { ...(input as Record<string, unknown>) };
    for (const key of fields.strings ?? []) {
        const value = clean[key];
        if (typeof value === 'number' || typeof value === 'boolean') clean[key] = String(value);
        else if (value !== undefined && typeof value !== 'string') delete clean[key];
    }
    for (const key of fields.booleans ?? []) {
        if (clean[key] !== undefined && typeof clean[key] !== 'boolean') delete clean[key];
    }
    for (const key of fields.arrays ?? []) {
        if (clean[key] !== undefined && !Array.isArray(clean[key])) delete clean[key];
    }
    for (const key of fields.objects ?? []) {
        const value = clean[key];
        if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) delete clean[key];
    }
    return clean as Partial<T>;
}

const ENTITY_STRINGS = ['id', 'name', 'filesystemName', 'description', 'workspaceId'];

const REQUEST_FIELDS: FieldTypes = {
    strings: [
        ...ENTITY_STRINGS, 'collectionId', 'collection', 'method', 'url', 'requestTab', 'requestType', 'bodyType', 'rawBodyType',
        'bodyContent', 'bodyFilePath', 'bodyFileName', 'graphqlSchema', 'preRequestScript', 'testScript',
        'preRequestScriptJs', 'testScriptJs', 'requestNotes', 'sioEventName', 'grpcMethod', 'grpcProtoFilePath',
        'grpcProtoFileName', 'mcpMethod', 'mcpName', 'mcpArguments', 'mcpProtocolVersion',
    ],
    booleans: ['nameAuto', 'isDraft', 'isPinned', 'sioAck', 'grpcUseReflection'],
    arrays: ['folderPath', 'params', 'headers', 'formRows', 'sioEvents', 'sioArgs', 'grpcMetadata', 'grpcProtoImportPaths', 'examples'],
    objects: ['auth', 'settings', 'settingsOverrides'],
};

function normalizeRequestType(input: Partial<SavedRequest>): RequestType {
    if (input.requestType === 'mcp') return 'mcp';
    if (input.requestType === 'grpc') return 'grpc';
    if (input.requestType === 'socketio') return 'socketio';
    if (input.requestType === 'ws') return 'ws';
    if (input.requestType === 'graphql' || input.bodyType === 'graphql') return 'graphql';
    return /^wss?:\/\//i.test(input.url || '') ? 'ws' : 'http';
}

export function normalizeSioArgs(input: Partial<SIOArg>[] | undefined): SIOArg[] {
    const valid = Array.isArray(input) ? input.filter(arg => Boolean(arg) && typeof arg === 'object' && !Array.isArray(arg)) : [];
    const source = valid.length > 0 ? valid : defaultSocketIOArgs();
    const seen = new Set<string>();
    return source.map((arg, index) => {
        const fallbackId = String(index + 1);
        let id = asText(arg.id).trim() || fallbackId;
        if (seen.has(id)) {
            const base = id;
            let suffix = 2;
            while (seen.has(`${base}-${suffix}`)) suffix += 1;
            id = `${base}-${suffix}`;
        }
        seen.add(id);
        return {
            id,
            content: asText(arg.content),
            bodyType: arg.bodyType === 'binary' ? 'binary' : normalizeRawBodyTypeForUi(arg.bodyType),
            encoding: arg.encoding === 'hex' ? 'hex' : 'base64',
        };
    });
}

export function filesystemNameFromName(name: string, fallback: string): string {
    let value = String(name || fallback || '').trim();
    if (!value) value = 'item';
    value = value.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^[._-]+|[._-]+$/g, '');
    if (!value) value = 'item';
    if (value.length > 80) value = value.slice(0, 80).replace(/[._-]+$/g, '');
    return value || 'item';
}

export function makeWorkspace(name = DEFAULT_WORKSPACE): Workspace {
    const id = newEntityId('workspace');
    return {
        id,
        name,
        filesystemName: filesystemNameFromName(name, id),
        description: '',
    };
}

export function makeCollection(workspaceId: string, name = DEFAULT_COLLECTION): Collection {
    const id = newEntityId('collection');
    return {
        id,
        workspaceId,
        name,
        filesystemName: filesystemNameFromName(name, id),
        description: '',
        collapsed: false,
        folderPaths: [],
        defaults: emptyCollectionDefaults(),
    };
}

export function makeEnvironment(workspaceId: string, name = 'Local'): Environment {
    const id = newEntityId('environment');
    return {id, workspaceId, name, filesystemName: filesystemNameFromName(name, id), values: [mkRow()]};
}

export function normalizeWorkspace(raw: Partial<Workspace>): Workspace {
    const input = sanitizeFields(raw, { strings: ENTITY_STRINGS });
    const id = input.id || newEntityId('workspace');
    const name = input.name || DEFAULT_WORKSPACE;
    return {
        id,
        name,
        filesystemName: filesystemNameFromName(input.filesystemName || name, id),
        description: input.description || '',
    };
}

export function normalizeCollection(raw: Partial<Collection>, workspaceId: string): Collection {
    const input = sanitizeFields(raw, { strings: ENTITY_STRINGS, booleans: ['collapsed'], arrays: ['folderPaths'], objects: ['defaults'] });
    const id = input.id || newEntityId('collection');
    const name = input.name || DEFAULT_COLLECTION;
    return {
        id,
        workspaceId: input.workspaceId || workspaceId,
        name,
        filesystemName: filesystemNameFromName(input.filesystemName || name, id),
        description: input.description || '',
        collapsed: input.collapsed ?? false,
        folderPaths: normalizeCollectionFolderPaths(input.folderPaths),
        defaults: normalizeCollectionDefaults(input.defaults),
    };
}

export function normalizeEnvironment(raw: Partial<Environment>, workspaceId: string): Environment {
    const input = sanitizeFields(raw, { strings: ENTITY_STRINGS, arrays: ['values'] });
    const id = input.id || newEntityId('environment');
    const name = input.name || 'Local';
    return {
        id,
        workspaceId: input.workspaceId || workspaceId,
        name,
        filesystemName: filesystemNameFromName(input.filesystemName || name, id),
        values: restoreRows(input.values),
    };
}

export function normalizeSavedRequest(
    raw: Partial<SavedRequest>,
    collections: Collection[],
    defaultWorkspaceId: string,
): SavedRequest {
    const input = sanitizeFields(raw, REQUEST_FIELDS);
    const isDraft = input.isDraft ?? false;
    const collectionId = isDraft ? '' : input.collectionId
        || collections.find(c => c.name === input.collection)?.id
        || collections.find(c => c.workspaceId === defaultWorkspaceId)?.id
        || collections[0]?.id
        || '';
    const collectionName = collections.find(c => c.id === collectionId)?.name || DEFAULT_COLLECTION;
    const normalizedRequestType = normalizeRequestType(input);
    const isRealtime = normalizedRequestType === 'ws' || normalizedRequestType === 'socketio';
    const isGraphQL = normalizedRequestType === 'graphql';
    const isGrpc = normalizedRequestType === 'grpc';
    const isMcp = normalizedRequestType === 'mcp';
    const bodyDefaults = requestBodyDefaultsFor(normalizedRequestType);
    const rawRequestTab = input.requestTab || (isMcp ? 'body' : isGrpc ? 'body' : isRealtime ? 'body' : isGraphQL ? 'query' : 'params');
    const requestTab = isGraphQL && !['docs', 'query', 'auth', 'headers', 'schema', 'scripts'].includes(rawRequestTab)
        ? 'query'
        : isMcp && !['docs', 'body', 'auth', 'headers', 'scripts', 'settings', 'examples'].includes(rawRequestTab)
        ? 'body'
        : isGrpc && !['docs', 'body', 'auth', 'metadata', 'service', 'scripts', 'settings'].includes(rawRequestTab)
        ? 'body'
        : isRealtime && ['scripts', 'query', 'schema'].includes(rawRequestTab)
        ? 'body'
        : (input.method ?? '').toUpperCase() === 'SSE' && ['scripts', 'query', 'schema'].includes(rawRequestTab)
        ? 'params'
        : rawRequestTab;
    const realtimeLabel = normalizedRequestType === 'mcp' ? 'MCP' : normalizedRequestType === 'grpc' ? 'gRPC' : normalizedRequestType === 'socketio' ? 'Socket.IO' : normalizedRequestType === 'ws' ? 'WS' : normalizedRequestType === 'graphql' ? 'GraphQL' : '';
    const rawName = input.name || requestTitleFrom(realtimeLabel || (input.method || 'GET'), input.url || '');
    let folderPath = Array.isArray(input.folderPath) ? input.folderPath.map(asText).filter(Boolean) : [];
    let normalizedName = rawName;
    if (!folderPath.length && rawName.includes(' / ')) {
        const parts = rawName.split(' / ').map(p => p.trim()).filter(Boolean);
        const looksLikeAutoTitle = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|GRAPHQL|GQL|WS|WEBSOCKET|SIO|SOCKET\.IO|GRPC|MCP|SSE)\b/i.test(parts[0] ?? '')
            || (parts[0] ?? '').includes('/');
        if (parts.length > 1 && !looksLikeAutoTitle) {
            folderPath = parts.slice(0, -1);
            normalizedName = parts.at(-1) ?? rawName;
        }
    }
    const id = input.id || newRequestId();
    const settings = {...DEFAULT_REQUEST_SETTINGS, ...sanitizeLike(input.settings, DEFAULT_REQUEST_SETTINGS)};
    if (
        typeof input.grpcUseReflection === 'boolean'
        && !Object.prototype.hasOwnProperty.call(input.settings ?? {}, 'grpcUseReflection')
    ) {
        settings.grpcUseReflection = input.grpcUseReflection;
    }
    const inheritedSettings = collections.find(c => c.id === collectionId)?.defaults?.settings;
    const settingsOverrides = normalizeRequestSettingsOverrides(input.settingsOverrides as RequestSettingsOverrides | undefined, settings, inheritedSettings);
    const normalizedExamples = normalizeRequestExamples(input.examples, id);
    return {
        id,
        name: normalizedName,
        filesystemName: filesystemNameFromName(input.filesystemName || normalizedName, id),
        nameAuto: input.nameAuto ?? false,
        requestType: normalizedRequestType,
        isDraft,
        isPinned: input.isPinned ?? false,
        collectionId,
        collection: isDraft ? '' : input.collection || collectionName,
        folderPath,
        method: (isGraphQL || isGrpc ? 'POST' : input.method || 'GET') as Method,
        url: input.url || '',
        requestTab: requestTab as RequestTab,
        params: cloneRowsForStore(input.params ?? []),
        headers: cloneRowsForStore(input.headers ?? []),
        auth: {...emptyAuthState(), ...sanitizeLike(input.auth, emptyAuthState())},
        bodyType: isGraphQL || isGrpc ? bodyDefaults.bodyType : normalizeBodyTypeForUi(input.bodyType ?? bodyDefaults.bodyType),
        rawBodyType: isGraphQL || isGrpc ? bodyDefaults.rawBodyType : normalizeRawBodyTypeForUi(input.rawBodyType ?? bodyDefaults.rawBodyType),
        bodyContent: isGraphQL || isGrpc ? (input.bodyContent || bodyDefaults.bodyContent) : input.bodyContent ?? bodyDefaults.bodyContent,
        bodyFilePath: input.bodyFilePath || bodyDefaults.bodyFilePath,
        bodyFileName: input.bodyFileName || bodyDefaults.bodyFileName,
        formRows: cloneRowsForStore(input.formRows ?? bodyDefaults.formRows),
        graphqlSchema: input.graphqlSchema || '',
        preRequestScript: input.preRequestScript || '',
        testScript: input.testScript || '',
        preRequestScriptJs: input.preRequestScriptJs || '',
        testScriptJs: input.testScriptJs || '',
        requestNotes: input.requestNotes || '',
        settings,
        settingsOverrides,
        sioEvents: cloneRowsForStore(input.sioEvents ?? []),
        sioEventName: input.sioEventName || '',
        sioArgs: normalizeSioArgs(input.sioArgs),
        sioAck: input.sioAck ?? false,
        grpcMethod: input.grpcMethod || '',
        grpcMetadata: cloneRowsForStore(input.grpcMetadata ?? []),
        grpcUseReflection: settings.grpcUseReflection,
        grpcProtoFilePath: input.grpcProtoFilePath || '',
        grpcProtoFileName: input.grpcProtoFileName || '',
        grpcProtoImportPaths: Array.isArray(input.grpcProtoImportPaths) ? input.grpcProtoImportPaths.map(asText).filter(Boolean) : [],
        mcpMethod: input.mcpMethod || (isMcp ? 'tools/list' : ''),
        mcpName: input.mcpName || '',
        mcpArguments: input.mcpArguments || '',
        mcpProtocolVersion: input.mcpProtocolVersion || '',
        ...(normalizedExamples ? { examples: normalizedExamples } : {}),
    };
}

export function normalizeHistoryEntry(
    input: Partial<RequestHistoryEntry>,
    collections: Collection[],
    defaultWorkspaceId: string,
): RequestHistoryEntry | null {
    if (!input.request) return null;
    const createdAt = finiteNumber(input.createdAt, Date.now());
    return {
        id: input.id || newEntityId('history'),
        request: normalizeSavedRequest(input.request, collections, defaultWorkspaceId),
        ...(typeof input.sourceRequestId === 'string' && input.sourceRequestId ? { sourceRequestId: input.sourceRequestId } : {}),
        statusCode: finiteNumber(input.statusCode),
        status: input.status || '',
        duration: finiteNumber(input.duration),
        createdAt,
    };
}
