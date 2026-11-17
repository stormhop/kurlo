import { describe, expect, it } from 'vitest';
import { collectionFeature, requestMatchesSidebarQuery } from '../lib/stores/features/collections';
import type { SavedRequest } from '../lib/types/models';

const request = (over: Partial<SavedRequest>) => ({ id: 'r', name: 'List users', method: 'GET', url: 'https://api.test/users', collectionId: 'c1', folderPath: [], ...over }) as SavedRequest;

describe('sidebar filter', () => {
  it('matches the name, URL, gRPC method, proto file and folder path', () => {
    const grpc = request({ name: 'Call', url: 'grpc://host', grpcMethod: 'pkg.Users/Get', grpcProtoFileName: 'users.proto', folderPath: ['Admin', 'Accounts'] });
    for (const query of ['call', 'grpc://', 'users/get', 'users.proto', 'admin / accounts']) expect(requestMatchesSidebarQuery(grpc, query)).toBe(true);
    expect(requestMatchesSidebarQuery(grpc, 'call grpc')).toBe(false);
  });

  it('follows an edited request instead of an earlier copy', () => {
    const before = request({});
    expect(requestMatchesSidebarQuery(before, 'orders')).toBe(false);
    expect(requestMatchesSidebarQuery({ ...before, url: 'https://api.test/orders' }, 'orders')).toBe(true);
  });

  it('groups matches by collection and attaches request diagnostics', () => {
    const requests = [
      request({ id: 'a', name: 'Alpha', collectionId: 'c1' }),
      request({ id: 'b', name: 'Beta', collectionId: 'c2' }),
      request({ id: 'c', name: 'Alpha draft', collectionId: 'c1', isDraft: true }),
      request({ id: 'd', name: 'Alpha two', collectionId: 'c2' }),
    ];
    const diagnostic = { requestId: 'd', collectionId: 'c2', scope: 'request', path: 'x', message: 'bad', blocking: false };
    const host: any = {
      ...collectionFeature,
      sidebarSearch: 'ALPHA', sidebarRequests: requests, activeWorkspaceId: 'w', folderCollapseState: {},
      collections: [{ id: 'c1', workspaceId: 'w', name: 'One' }, { id: 'c2', workspaceId: 'w', name: 'Two' }, { id: 'c3', workspaceId: 'w', name: 'Three' }],
      workspaceDiagnostics: [diagnostic],
      diagnosticsForCollection: () => [],
      folderCollapseKey: (id: string, path: string[]) => `${id}:${path.join('/')}`,
      folderDisplayName: (path: string[]) => path.at(-1),
    };
    const groups = host.buildCollectionGroups();
    expect(groups.map((group: any) => [group.collection.id, group.requests.map((item: SavedRequest) => item.id)])).toEqual([['c1', ['a']], ['c2', ['d']]]);
    expect(groups[1].requests[0].workspaceDiagnostics).toEqual([diagnostic]);
  });
});
