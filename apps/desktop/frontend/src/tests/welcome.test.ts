import { describe, expect, it } from 'vitest';
import { shouldShowWelcome } from '../lib/welcome';

const fresh = {
  seen: false,
  lastSeenVersion: null,
  requestCount: 0,
  historyCount: 0,
  environmentCount: 0,
  collectionCount: 1,
  workspaceCount: 1,
  blocked: false,
};

describe('first launch welcome', () => {
  it('welcomes an empty profile with the automatically created default collection', () => {
    expect(shouldShowWelcome(fresh)).toBe(true);
    expect(shouldShowWelcome({ ...fresh, collectionCount: 0, workspaceCount: 0 })).toBe(true);
  });

  it.each([
    { seen: true },
    { lastSeenVersion: '3.1.3' },
    { requestCount: 1 },
    { historyCount: 1 },
    { environmentCount: 1 },
    { collectionCount: 2 },
    { workspaceCount: 2 },
    { blocked: true },
  ])('preserves the normal startup for %j', state => {
    expect(shouldShowWelcome({ ...fresh, ...state })).toBe(false);
  });
});
