import type { MockRoute } from './backend';
import type { RequestExample, SavedRequest } from './types/models';
import { mediaTypeOf } from './examples';

export const DEFAULT_MOCK_PORT = 3100;

function headerRows(example: RequestExample) {
  return example.response.headers
    .filter(row => row.key.trim() !== '')
    .map(row => ({
      key: row.key,
      value: row.value,
      enabled: true,
      isFile: false,
      fileName: '',
      contentType: '',
    }));
}

function queryRows(example: RequestExample) {
  const query = example.match.query ?? {};
  return Object.entries(query).map(([key, value]) => ({
    key,
    value,
    enabled: true,
    isFile: false,
    fileName: '',
    contentType: '',
  }));
}

function bodyMediaType(example: RequestExample) {
  if (example.response.bodyMediaType) return example.response.bodyMediaType;
  const header = example.response.headers.find(row => row.key.toLowerCase() === 'content-type');
  return mediaTypeOf(header?.value ?? '');
}

export function mockRouteFromExample(request: SavedRequest, example: RequestExample): MockRoute {
  return {
    exampleId: example.id,
    exampleName: example.name,
    requestId: request.id,
    requestName: request.name,
    method: example.snapshot.method || request.method || 'GET',
    pathTemplate: example.match.pathTemplate || '/',
    query: queryRows(example),
    statusCode: example.response.statusCode || 200,
    status: example.response.status,
    headers: headerRows(example),
    body: example.response.body,
    bodyMediaType: bodyMediaType(example),
    delayMs: example.response.durationMs ?? 0,
  };
}

export function mockRoutesForCollection(requests: SavedRequest[], collectionId: string): MockRoute[] {
  const routes: MockRoute[] = [];
  for (const request of requests) {
    if (request.collectionId !== collectionId) continue;
    for (const example of request.examples ?? []) {
      routes.push(mockRouteFromExample(request, example));
    }
  }
  return routes;
}

export function collectionsWithExamples(requests: SavedRequest[]): Set<string> {
  const ids = new Set<string>();
  for (const request of requests) {
    if (request.examples?.length) ids.add(request.collectionId);
  }
  return ids;
}

export function mockRoutesSignature(routes: MockRoute[]): string {
  return JSON.stringify(routes.map(route => [
    route.method,
    route.pathTemplate,
    route.statusCode,
    route.bodyMediaType,
    route.body,
    route.delayMs,
    route.query.map(pair => [pair.key, pair.value]),
    route.headers.map(pair => [pair.key, pair.value]),
  ]));
}

export function mockRouteLabel(route: MockRoute): string {
  return `${route.method.toUpperCase()} ${route.pathTemplate}`;
}

export function mockRouteConflicts(routes: MockRoute[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const route of routes) {
    const key = `${mockRouteLabel(route)}|${JSON.stringify(route.query.map(q => [q.key, q.value]))}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Map([...counts].filter(([, count]) => count > 1));
}

export function mockRouteShadows(routes: MockRoute[]): Map<string, MockRoute> {
  const first = new Map<string, MockRoute>();
  const shadows = new Map<string, MockRoute>();
  for (const route of routes) {
    const key = `${mockRouteLabel(route)}|${JSON.stringify(route.query.map(q => [q.key, q.value]))}`;
    const winner = first.get(key);
    if (winner) shadows.set(route.exampleId, winner);
    else first.set(key, route);
  }
  return shadows;
}
