import { mkRow, DEFAULT_REQUEST_SETTINGS } from '../../lib/constants';
import { type SavedRequest } from '../../lib/types/models';
import { emptyAuthState } from '../../lib/utils';
import { buildPostmanCollection } from '../../lib/postman';

function testRow(key: string, value: string, description = '') {
  return { ...mkRow(), key, value, description };
}

function testRequest(overrides: Partial<SavedRequest>): SavedRequest {
  return {
    id: 'req-1',
    name: 'Test request',
    collectionId: 'collection-1',
    collection: 'Test API',
    folderPath: [],
    method: 'GET',
    url: 'https://api.example.test/ping',
    requestTab: 'params',
    params: [],
    headers: [],
    auth: emptyAuthState(),
    bodyType: 'none',
    rawBodyType: 'json',
    bodyContent: '',
    bodyFilePath: '',
    bodyFileName: '',
    formRows: [],
    requestNotes: '',
    settings: { ...DEFAULT_REQUEST_SETTINGS },
    ...overrides,
  };
}

const strip = (source: string) => source;

type ExportHttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'options';

type ExportParameter = { name?: string; [key: string]: unknown };

type ExportOperation = {
  tags?: string[];
  security?: Array<Record<string, string[]>>;
  parameters?: ExportParameter[];
  requestBody?: { content: Record<string, { schema?: unknown; example?: unknown }> };
  consumes?: string[];
  [key: string]: unknown;
};

type ExportPathItem = Partial<Record<ExportHttpMethod, ExportOperation>>;

type ExportDocument = Record<string, unknown> & { paths: Record<string, ExportPathItem> };

type PostmanRequestExport = {
  method?: string;
  auth?: { bearer?: Array<Record<string, unknown>> };
  header?: Array<Record<string, unknown>>;
  url?: { raw?: string; query?: Array<Record<string, unknown>> };
  body?: { urlencoded?: Array<Record<string, unknown>>; formdata?: Array<Record<string, unknown>>; graphql?: Record<string, unknown>; mode?: string };
};

type PostmanCollectionExport = {
  item: Array<{ request: PostmanRequestExport }>;
};

function exportDocument(doc: Record<string, unknown>): ExportDocument {
  return doc as ExportDocument;
}

function operation(doc: Record<string, unknown>, path: string, method: ExportHttpMethod): ExportOperation {
  const op = exportDocument(doc).paths[path]?.[method];
  if (!op) throw new Error(`Missing ${method.toUpperCase()} ${path}`);
  return op;
}

function postmanExport(collection: ReturnType<typeof buildPostmanCollection>): PostmanCollectionExport {
  return collection as PostmanCollectionExport;
}

export { testRequest, testRow, strip, operation, exportDocument, postmanExport };
