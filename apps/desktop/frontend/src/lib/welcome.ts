export const WELCOME_SEEN_KEY = 'kurlo:welcome-seen';

export function shouldShowWelcome(state: {
  seen: boolean;
  lastSeenVersion: string | null;
  requestCount: number;
  historyCount: number;
  environmentCount: number;
  collectionCount: number;
  workspaceCount: number;
  blocked: boolean;
}) {
  return !state.seen && !state.lastSeenVersion && !state.blocked
    && state.requestCount === 0 && state.historyCount === 0
    && state.environmentCount === 0 && state.collectionCount <= 1
    && state.workspaceCount <= 1;
}
