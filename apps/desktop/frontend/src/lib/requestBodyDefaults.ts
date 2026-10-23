import {
  DEFAULT_GRAPHQL_QUERY,
  DEFAULT_GRAPHQL_VARIABLES,
  serializeGraphQLPayload,
} from './graphql';
import type { BodyType, KVRow, RawBodyType, RequestType, SIOArg } from './types/models';

export const DEFAULT_GRPC_MESSAGE = '{}';

type BodyDefaults = {
  bodyType: BodyType;
  rawBodyType: RawBodyType;
  bodyContent: string;
};

const GRAPHQL_BODY_DEFAULT: BodyDefaults = {
  bodyType: 'graphql',
  rawBodyType: 'json',
  bodyContent: serializeGraphQLPayload({
    query: DEFAULT_GRAPHQL_QUERY,
    variables: DEFAULT_GRAPHQL_VARIABLES,
    operationName: '',
  }),
};

export const REQUEST_BODY_DEFAULTS: Record<RequestType, BodyDefaults> = {
  http: { bodyType: 'none', rawBodyType: 'json', bodyContent: '' },
  graphql: GRAPHQL_BODY_DEFAULT,
  ws: { bodyType: 'text', rawBodyType: 'text', bodyContent: '' },
  socketio: { bodyType: 'text', rawBodyType: 'text', bodyContent: '' },
  grpc: { bodyType: 'json', rawBodyType: 'json', bodyContent: DEFAULT_GRPC_MESSAGE },
  mcp: { bodyType: 'none', rawBodyType: 'json', bodyContent: '' },
  ai: { bodyType: 'none', rawBodyType: 'json', bodyContent: '' },
};

export function requestBodyDefaultsFor(type: RequestType): BodyDefaults & {
  bodyFilePath: string;
  bodyFileName: string;
  formRows: KVRow[];
} {
  return {
    ...REQUEST_BODY_DEFAULTS[type],
    bodyFilePath: '',
    bodyFileName: '',
    formRows: [],
  };
}

export function defaultBodyContentFor(type: RequestType): string {
  return REQUEST_BODY_DEFAULTS[type].bodyContent;
}

export function defaultSocketIOArg(id = '1'): SIOArg {
  return { id, content: '', bodyType: 'text', encoding: 'base64' };
}

export function defaultSocketIOArgs(): SIOArg[] {
  return [defaultSocketIOArg()];
}
