export const KURLO_REPO_URL = 'https://github.com/stormhop/kurlo';
export const STAR_PROMPT_STORAGE_KEY = 'kurlo.starPrompt.v1';
export const STAR_PROMPT_AFTER_SENDS = 20;

export type StarPromptState = { sends: number; done: boolean };

export function normalizeStarPromptState(value: unknown): StarPromptState {
  const input = value && typeof value === 'object' ? value as Partial<StarPromptState> : {};
  const sends = typeof input.sends === 'number' && Number.isFinite(input.sends) && input.sends > 0 ? Math.floor(input.sends) : 0;
  return { sends: Math.min(sends, STAR_PROMPT_AFTER_SENDS), done: input.done === true };
}

export function loadStarPromptState(): StarPromptState {
  try {
    const raw = localStorage.getItem(STAR_PROMPT_STORAGE_KEY);
    return normalizeStarPromptState(raw ? JSON.parse(raw) : null);
  } catch {
    return normalizeStarPromptState(null);
  }
}

function saveStarPromptState(state: StarPromptState) {
  try {
    localStorage.setItem(STAR_PROMPT_STORAGE_KEY, JSON.stringify(state));
  } catch {}
}

export function starPromptDue(state: StarPromptState): boolean {
  return !state.done && state.sends >= STAR_PROMPT_AFTER_SENDS;
}

export function recordSuccessfulSend(): StarPromptState {
  const state = loadStarPromptState();
  if (state.done || state.sends >= STAR_PROMPT_AFTER_SENDS) return state;
  const next = { ...state, sends: state.sends + 1 };
  saveStarPromptState(next);
  return next;
}

export function finishStarPrompt(): StarPromptState {
  const next = { ...loadStarPromptState(), done: true };
  saveStarPromptState(next);
  return next;
}
