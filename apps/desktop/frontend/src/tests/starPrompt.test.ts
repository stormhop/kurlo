import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  finishStarPrompt,
  loadStarPromptState,
  normalizeStarPromptState,
  recordSuccessfulSend,
  STAR_PROMPT_AFTER_SENDS,
  STAR_PROMPT_STORAGE_KEY,
  starPromptDue,
} from '../lib/starPrompt';

describe('GitHub star prompt', () => {
  let store: Record<string, string>;

  beforeEach(() => {
    store = {};
    (globalThis as { localStorage?: Storage }).localStorage = {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
      clear: () => { store = {}; },
      key: () => null,
      length: 0,
    } as Storage;
  });

  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it('comes due on the twentieth successful send and not before', () => {
    for (let i = 1; i < STAR_PROMPT_AFTER_SENDS; i++) expect(starPromptDue(recordSuccessfulSend())).toBe(false);
    expect(starPromptDue(recordSuccessfulSend())).toBe(true);
    expect(starPromptDue(loadStarPromptState())).toBe(true);
  });

  it('never comes back once closed', () => {
    for (let i = 0; i < STAR_PROMPT_AFTER_SENDS; i++) recordSuccessfulSend();
    finishStarPrompt();
    expect(starPromptDue(recordSuccessfulSend())).toBe(false);
    expect(JSON.parse(store[STAR_PROMPT_STORAGE_KEY])).toEqual({ sends: STAR_PROMPT_AFTER_SENDS, done: true });
  });

  it('stops counting once it is due', () => {
    for (let i = 0; i < STAR_PROMPT_AFTER_SENDS + 5; i++) recordSuccessfulSend();
    expect(loadStarPromptState().sends).toBe(STAR_PROMPT_AFTER_SENDS);
  });

  it('treats broken or missing storage as a fresh start', () => {
    store[STAR_PROMPT_STORAGE_KEY] = '{not json';
    expect(loadStarPromptState()).toEqual({ sends: 0, done: false });
    expect(normalizeStarPromptState({ sends: -3, done: 'yes' })).toEqual({ sends: 0, done: false });
    delete (globalThis as { localStorage?: Storage }).localStorage;
    expect(starPromptDue(recordSuccessfulSend())).toBe(false);
    expect(() => finishStarPrompt()).not.toThrow();
  });
});
