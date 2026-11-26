import { describe, expect, it } from 'vitest';
import { requestYamlOptions } from '../lib/requestYamlOptions';

function labels(path: string[], kind: 'key' | 'value', siblings = new Map<string, string>(), requestType?: string, method?: string) {
  return requestYamlOptions(path, kind, siblings, requestType, method).map(option => option.label);
}

describe('request YAML completions', () => {
  it('uses the workspace schema for ordinary request and row fields', () => {
    const requestFields = labels(['request'], 'key', new Map([['name', 'Request']]), 'http');
    expect(requestFields).toContain('url');
    expect(requestFields).toContain('headers');
    expect(requestFields).not.toContain('id');
    expect(requestFields).not.toContain('requestTab');
    expect(requestFields).toContain('requestType');

    const rowFields = labels(['request', 'headers', '*'], 'key', new Map([['key', 'Accept']]));
    expect(rowFields).toContain('value');
    expect(rowFields).toContain('enabled');
    expect(rowFields).not.toContain('key');
    expect(labels(['request', 'headers', '*', 'enabled'], 'value')).toEqual(['true', 'false']);
  });

  it('offers the HTTP body variant fields and their nested schema', () => {
    const fields = ['activeBodyVariant', 'bodyVariants'];
    expect(labels(['request'], 'key', new Map(), 'http')).toEqual(expect.arrayContaining(fields));
    for (const field of fields) expect(labels(['request'], 'key', new Map(), 'ws')).not.toContain(field);

    const variant = ['request', 'bodyVariants', '*'];
    expect(labels(variant, 'key').sort()).toEqual(['bodyContent', 'bodyFileName', 'bodyFilePath', 'bodyType', 'formRows', 'name', 'rawBodyType']);
    expect(labels([...variant, 'bodyType'], 'value')).toEqual(labels(['request', 'bodyType'], 'value').filter(type => type !== 'graphql'));
    expect(labels([...variant, 'formRows', '*', 'enabled'], 'value')).toEqual(['true', 'false']);
  });

  it('suggests auth fields for the selected scheme and marks only secret fields', () => {
    const fields = requestYamlOptions(['request', 'auth'], 'key', new Map([['type', 'basic']]));
    expect(fields.map(field => field.label)).toEqual(['basicUser', 'basicPass']);
    expect(fields.find(field => field.label === 'basicPass')?.detail).toContain('Sensitive value');
    expect(requestYamlOptions(['request', 'auth'], 'key', new Map([['type', 'bearer']])).map(field => field.label)).toEqual(['bearerToken']);
    expect(requestYamlOptions(['request', 'auth'], 'key', new Map([['type', 'oauth2']])).map(field => field.label)).toContain('oauth2TokenURL');
    expect(requestYamlOptions(['request', 'auth'], 'key', new Map([['type', 'constructor']])).map(field => field.label)).toEqual([]);
    expect(labels(['request', 'auth', 'type'], 'value')).toContain('basic');
  });

  it('filters request settings and methods by protocol while retaining general settings', () => {
    const grpc = labels(['request', 'settings'], 'key', new Map(), 'grpc');
    expect(grpc).toContain('grpcUseTls');
    expect(grpc).toContain('allowSendRequest');
    expect(grpc).toContain('scriptTimeoutMs');
    expect(grpc).toContain('clientCertPath');
    expect(grpc).not.toContain('wsReconnectAttempts');
    expect(grpc).not.toContain('httpVersion');

    const overrides = labels(['request', 'settingsOverrides'], 'key', new Map([['timeoutMs', 'true']]), 'http');
    expect(overrides).toContain('followRedirects');
    expect(overrides).not.toContain('timeoutMs');
    expect(labels(['request', 'settingsOverrides', 'allowSendRequest'], 'value')).toEqual(['true', 'false']);
    expect(labels(['request', 'method'], 'value', new Map(), 'grpc')).toEqual(['POST']);
    expect(labels(['request', 'method'], 'value', new Map(), 'http')).toContain('SSE');
  });

  it('does not offer values for fields managed by Kurlo or paths outside request files', () => {
    expect(labels(['request', 'requestType'], 'value')).toEqual(['http', 'graphql', 'ws', 'socketio', 'grpc', 'kafka', 'mcp', 'ai']);
    expect(labels(['request', 'requestTab'], 'value')).toEqual([]);
    expect(labels(['environment'], 'key')).toEqual([]);
    expect(labels(['request', 'bodyType'], 'value')).toContain('json');
    expect(labels(['request', 'settings', 'enableSSLVerification'], 'value')).toEqual(['true', 'false']);
  });
});
