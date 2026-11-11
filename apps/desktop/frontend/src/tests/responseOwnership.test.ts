import { describe, expect, it } from 'vitest';
import { responseFeature } from '../lib/stores/features/response';
import { emptyHttpResponse } from '../lib/wire';
import type { HttpResponse } from '../lib/backend';
import type { ResponseTab } from '../lib/types/models';

function host() {
  const visible = { ...emptyHttpResponse(), body: 'visible response' };
  return {
    activeRequestId: 'visible',
    response: visible as HttpResponse | null,
    responseTab: 'headers' as ResponseTab,
    responses: new Map([['visible', visible]]),
    previousResponses: new Map<string, HttpResponse>(),
    responseTabs: new Map<string, ResponseTab>([['visible', 'headers']]),
  };
}

describe('request-owned HTTP responses', () => {
  it('stores background responses and their diff baseline without changing the visible response', () => {
    const state = host();
    const visible = state.response;
    const first = { ...emptyHttpResponse(), body: 'first background' };
    const second = { ...emptyHttpResponse(), body: 'second background' };
    responseFeature.setActiveResponse.call(state as never, first, 'background');
    responseFeature.setActiveResponse.call(state as never, second, 'background');
    expect(state.response).toBe(visible);
    expect(state.responses.get('visible')).toBe(visible);
    expect(state.responses.get('background')).toBe(second);
    expect(state.previousResponses.get('background')).toBe(first);
    responseFeature.setActiveResponse.call(state as never, null, 'background');
    expect(state.response).toBe(visible);
    expect(state.responses.has('background')).toBe(false);
    expect(state.previousResponses.has('background')).toBe(false);
  });

  it('stores background response tabs without changing the visible tab', () => {
    const state = host();
    responseFeature.setActiveResponseTab.call(state as never, 'test-results', 'background');
    expect(state.responseTab).toBe('headers');
    expect(state.responseTabs.get('visible')).toBe('headers');
    expect(state.responseTabs.get('background')).toBe('test-results');
  });

  it('updates the visible response and tab for the active request', () => {
    const state = host();
    const response = { ...emptyHttpResponse(), body: 'updated' };
    responseFeature.setActiveResponse.call(state as never, response, 'visible');
    responseFeature.setActiveResponseTab.call(state as never, 'body', 'visible');
    expect(state.response).toBe(response);
    expect(state.responses.get('visible')).toBe(response);
    expect(state.responseTab).toBe('body');
    expect(state.responseTabs.get('visible')).toBe('body');
  });
});
