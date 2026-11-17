import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/utils', async importOriginal => ({ ...(await importOriginal<object>()), clipboardCopy: vi.fn(async () => undefined) }));

import { RESPONSE_FILTER_DELAY_MS, responseFeature } from '../lib/stores/features/response';
import { clipboardCopy } from '../lib/utils';

function host() {
  const state: any = {
    responseFilter: '',
    responseFilterQuery: '',
    responseFilterOpen: true,
    copiedBody: false,
    response: { body: '{"items":[{"id":1},{"id":2}]}', bodyIsBinary: false, error: '' },
  };
  const stubbed = new Set(['isJsonResponse', 'formatResponseBody']);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(responseFeature))) {
    if (stubbed.has(key)) continue;
    Object.defineProperty(state, key, descriptor.get ? { get: descriptor.get.bind(state) } : { value: (descriptor.value as (...args: unknown[]) => unknown).bind(state) });
  }
  state.isJsonResponse = () => true;
  state.formatResponseBody = () => '';
  return state;
}

afterEach(() => vi.useRealTimers());

describe('response filter while typing', () => {
  it('applies the query once typing pauses', () => {
    vi.useFakeTimers();
    const state = host();
    state.setResponseFilter('$.items');
    state.setResponseFilter('$.items[*].id');
    expect(state.responseFilterResult).toBeNull();
    vi.advanceTimersByTime(RESPONSE_FILTER_DELAY_MS);
    expect(state.responseFilterResult.matches).toEqual([1, 2]);
  });

  it('clears at once and applies at once on Enter', () => {
    vi.useFakeTimers();
    const state = host();
    state.setResponseFilter('$.items[0].id');
    state.onResponseFilterKeydown({ key: 'Enter', preventDefault() {} });
    expect(state.responseFilterResult.matches).toEqual([1]);
    state.setResponseFilter('');
    expect(state.responseFilterResult).toBeNull();
  });

  it('copies what was typed even before the filter caught up', async () => {
    vi.useFakeTimers();
    const state = host();
    state.setResponseFilter('$.items[-1].id');
    await state.copyResponseBody();
    expect(clipboardCopy).toHaveBeenCalledWith('2');
  });
});
