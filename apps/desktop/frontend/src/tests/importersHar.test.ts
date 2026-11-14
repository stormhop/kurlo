import { describe, it, expect } from 'vitest';
import { harRequestsFromLog } from '../lib/har';

describe('harRequestsFromLog', () => {
  const makeHar = (entries: unknown[]) => ({ log: { version: '1.2', entries } });

  it('imports basic GET with query params and headers', () => {
    const har = makeHar([{
      request: {
        method: 'GET',
        url: 'https://api.example.com/users?page=2&limit=10',
        queryString: [{ name: 'page', value: '2' }, { name: 'limit', value: '10' }],
        headers: [
          { name: 'Authorization', value: 'Bearer tok' },
          { name: ':authority', value: 'api.example.com' },
        ],
      },
    }]);

    const requests = harRequestsFromLog(har, 'col-1', 'My HAR');

    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('GET');
    expect(requests[0].url).toBe('https://api.example.com/users');
    expect(requests[0].params).toHaveLength(2);
    expect(requests[0].params[0]).toMatchObject({ key: 'page', value: '2' });
    expect(requests[0].params[1]).toMatchObject({ key: 'limit', value: '10' });
    expect(requests[0].headers).toHaveLength(1);
    expect(requests[0].headers[0]).toMatchObject({ key: 'Authorization', value: 'Bearer tok' });
  });

  it('imports POST with JSON body', () => {
    const har = makeHar([{
      request: {
        method: 'POST',
        url: 'https://api.example.com/orders',
        queryString: [],
        headers: [{ name: 'Content-Type', value: 'application/json' }],
        postData: { mimeType: 'application/json', text: '{"item":"coffee"}' },
      },
    }]);

    const requests = harRequestsFromLog(har, 'col-1', 'My HAR');

    expect(requests[0].method).toBe('POST');
    expect(requests[0].bodyType).toBe('json');
    expect(requests[0].bodyContent).toBe('{"item":"coffee"}');
    expect(requests[0].requestTab).toBe('body');
  });

  it('imports GraphQL JSON bodies as GraphQL requests', () => {
    const har = makeHar([{
      request: {
        method: 'POST',
        url: 'https://api.example.com/graphql',
        queryString: [],
        headers: [{ name: 'Content-Type', value: 'application/json' }],
        postData: {
          mimeType: 'application/json',
          text: '{"query":"query Viewer { viewer { id } }","variables":{"id":"123"}}',
        },
      },
    }]);

    const requests = harRequestsFromLog(har, 'col-1', 'My HAR');

    expect(requests[0]).toMatchObject({ requestType: 'graphql', method: 'POST', requestTab: 'query', bodyType: 'graphql' });
    expect(JSON.parse(requests[0].bodyContent)).toMatchObject({
      query: 'query Viewer { viewer { id } }',
      variables: { id: '123' },
    });
  });

  it('keeps regular HAR JSON bodies with query fields as HTTP requests', () => {
    const har = makeHar([{
      request: {
        method: 'POST',
        url: 'https://api.example.com/search',
        queryString: [],
        headers: [{ name: 'Content-Type', value: 'application/json' }],
        postData: {
          mimeType: 'application/json',
          text: '{"query":"coffee","limit":10}',
        },
      },
    }]);

    const requests = harRequestsFromLog(har, 'col-1', 'My HAR');

    expect(requests[0]).toMatchObject({
      requestType: 'http',
      bodyType: 'json',
      bodyContent: '{"query":"coffee","limit":10}',
    });
  });

  it('imports POST with urlencoded body', () => {
    const har = makeHar([{
      request: {
        method: 'POST',
        url: 'https://api.example.com/login',
        queryString: [],
        headers: [],
        postData: {
          mimeType: 'application/x-www-form-urlencoded',
          params: [{ name: 'username', value: 'admin' }, { name: 'password', value: 'secret' }],
        },
      },
    }]);

    const requests = harRequestsFromLog(har, 'col-1', 'My HAR');

    expect(requests[0].bodyType).toBe('urlencoded');
    expect(requests[0].formRows).toHaveLength(2);
    expect(requests[0].formRows[0]).toMatchObject({ key: 'username', value: 'admin' });
  });

  it('imports WebSocket upgrade requests', () => {
    const har = makeHar([{
      request: {
        method: 'GET',
        url: 'https://api.example.com/ws?token=abc',
        queryString: [{ name: 'token', value: 'abc' }],
        headers: [{ name: 'Upgrade', value: 'websocket' }],
      },
    }]);

    const requests = harRequestsFromLog(har, 'col-1', 'My HAR');

    expect(requests[0]).toMatchObject({
      requestType: 'ws',
      requestTab: 'body',
      url: 'https://api.example.com/ws',
    });
    expect(requests[0].params[0]).toMatchObject({ key: 'token', value: 'abc' });
  });

  it('imports Socket.IO captures without Engine.IO transport params', () => {
    const har = makeHar([{
      request: {
        method: 'GET',
        url: 'wss://api.example.com/socket.io/?EIO=4&transport=websocket&sid=abc&token=user',
        queryString: [
          { name: 'EIO', value: '4' },
          { name: 'transport', value: 'websocket' },
          { name: 'sid', value: 'abc' },
          { name: 'token', value: 'user' },
        ],
        headers: [],
      },
    }]);

    const requests = harRequestsFromLog(har, 'col-1', 'My HAR');

    expect(requests[0]).toMatchObject({
      requestType: 'socketio',
      requestTab: 'events',
      url: 'https://api.example.com',
      settings: expect.objectContaining({ sioPath: '/socket.io', sioClientVersion: 'v3' }),
    });
    expect(requests[0].params).toEqual([expect.objectContaining({ key: 'token', value: 'user' })]);
  });

  it('skips entries with missing or empty url', () => {
    const har = makeHar([
      { request: { method: 'GET', url: '', queryString: [], headers: [] } },
      { request: { method: 'GET', url: 'https://api.example.com/ping', queryString: [], headers: [] } },
    ]);
    const requests = harRequestsFromLog(har, 'col-1', 'My HAR');
    expect(requests).toHaveLength(1);
  });

  it('throws when log is missing', () => {
    expect(() => harRequestsFromLog({ noLog: true }, 'col-1', 'Bad')).toThrow();
  });

  it('throws when entries array is empty', () => {
    expect(() => harRequestsFromLog({ log: { entries: [] } }, 'col-1', 'Empty')).toThrow();
  });
});
