import { describe, expect, it } from 'vitest';
import { blankRule, compileRulePattern, headerNames, patternForURL, ruleMatches, ruleSummary } from '../lib/captureRules';

describe('capture rules', () => {
  it('matches URLs the same way as the proxy', () => {
    const cases: Array<[string, string, string, string, boolean]> = [
      ['https://api.shop.test/orders/*', '', 'GET', 'https://api.shop.test/orders/184', true],
      ['https://api.shop.test/orders/*', '', 'GET', 'https://api.shop.test/orders', false],
      ['https://api.shop.test/orders/*', '', 'GET', 'https://api.shop.test/orders/184?expand=items', true],
      ['https://api.shop.test/orders/*', 'POST', 'GET', 'https://api.shop.test/orders/184', false],
      ['https://API.Shop.test/orders', '', 'GET', 'https://api.shop.test/orders', true],
      ['https://api.shop.test/Orders', '', 'GET', 'https://api.shop.test/orders', false],
      ['https://api.shop.test', '', 'GET', 'https://api.shop.test/anything/here', true],
      ['https://api.shop.test', '', 'GET', 'http://api.shop.test/', false],
      ['*://api.shop.test/*', '', 'GET', 'http://api.shop.test/x', true],
      ['https://*.shop.test/*', '', 'GET', 'https://cdn.shop.test/app.js', true],
      ['http://localhost:*/api/*', '', 'GET', 'http://localhost:3000/api/users', true],
      ['https://api.shop.test/search?q=*', '', 'GET', 'https://api.shop.test/search?q=boots', true],
      ['https://api.shop.test/search?q=*', '', 'GET', 'https://api.shop.test/search', false],
      ['https://api.shop.test/a.b', '', 'GET', 'https://api.shop.test/aXb', false],
      ['http://fixture.test/orders', '', 'GET', 'http://fixture.test:80/orders', true],
      ['http://fixture.test:80/orders', '', 'GET', 'http://fixture.test/orders', true],
      ['https://fixture.test/orders', '', 'GET', 'https://fixture.test:443/orders', true],
      ['https://fixture.test:443/orders', '', 'GET', 'https://fixture.test/orders', true],
      ['http://fixture.test:8080/orders', '', 'GET', 'http://fixture.test/orders', false],
      ['http://fixture.test/orders', '', 'GET', 'https://fixture.test:80/orders', false],
      ['*://fixture.test:80/orders', '', 'GET', 'http://fixture.test:80/orders', true],
      ['*://fixture.test/orders', '', 'GET', 'http://fixture.test:80/orders', false],
      ['*://fixture.test:*/orders', '', 'GET', 'https://fixture.test:443/orders', true],
      ['*://fixture.test:*/orders', '', 'GET', 'https://fixture.test/orders', false],
    ];
    for (const [url, method, requestMethod, target, want] of cases) {
      expect(ruleMatches({ url, method }, requestMethod, target), `${method} ${url} ${target}`).toBe(want);
    }
  });

  it('rejects patterns the proxy rejects', () => {
    for (const pattern of ['', 'api.test/x', 'ftp://a.test/', 'https:///x', 'https://a.test/ x']) {
      expect(compileRulePattern(pattern), pattern).toBeNull();
    }
  });

  it('suggests a pattern without the query and summarises rules', () => {
    expect(patternForURL('https://api.shop.test/orders/7?expand=1')).toBe('https://api.shop.test/orders/7');
    const local = blankRule('local', 'GET', 'https://a.test/*');
    local.local.delayMs = 300;
    expect(ruleSummary(local)).toBe('Responds 200 · 300 ms delay');
    const rewrite = blankRule('rewrite');
    rewrite.rewrite.target = 'http://localhost:3000';
    rewrite.rewrite.setRequestHeaders = [{ name: 'X-Env', value: 'dev' }];
    expect(ruleSummary(rewrite)).toBe('to http://localhost:3000 · 1 request header change');
    expect(headerNames(' X-Debug, Cookie  Server ')).toEqual(['X-Debug', 'Cookie', 'Server']);
  });

  it('suggests patterns with browser-normalized default ports', () => {
    expect(patternForURL('http://fixture.test:80/orders')).toBe('http://fixture.test/orders');
    expect(patternForURL('https://fixture.test:443/orders')).toBe('https://fixture.test/orders');
  });

  it('summarizes legacy rewrite rules with null header arrays', () => {
    const legacy = { ...blankRule('rewrite'), rewrite: { target: '', pathFrom: '/v1', pathTo: '/v2', setRequestHeaders: null, removeRequestHeaders: null, setResponseHeaders: null, removeResponseHeaders: null } } as unknown as ProxyRule;
    expect(ruleSummary(legacy)).toBe('/v1 → /v2');
  });
});
