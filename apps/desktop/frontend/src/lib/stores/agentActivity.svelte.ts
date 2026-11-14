import {
  agentActivity, agentActivityEntry, clearAgentActivity, revertAgentActivity, setAgentActivityEnabled,
  type AgentActivityEntry, type AgentActivityOverview, type AgentActivitySummary,
} from '../backend';

const ACTIVITY_PAGE = 100;
const FILTER_DELAY_MS = 250;
const DAY_MS = 24 * 60 * 60 * 1000;

function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class AgentActivityStore {
  entries = $state.raw<AgentActivitySummary[]>([]);
  overview = $state.raw<AgentActivityOverview | null>(null);
  hasMore = $state(false);
  loadingMore = $state(false);
  enabled = $state(true);
  loaded = $state(false);
  loading = $state(false);
  error = $state('');
  text = $state('');
  client = $state('');
  allWorkspaces = $state(false);
  workspaceId = $state('');
  selectedId = $state('');
  selected = $state<AgentActivityEntry | null>(null);
  detailError = $state('');
  actionError = $state('');
  busy = $state('');
  private request = 0;
  private detailRequest = 0;
  private filterTimer: ReturnType<typeof setTimeout> | null = null;

  private filter() {
    return { limit: ACTIVITY_PAGE, workspaceId: this.workspaceId, allWorkspaces: this.allWorkspaces, text: this.text.trim(), client: this.client };
  }

  async refresh(workspaceId = this.workspaceId) {
    const request = ++this.request;
    this.workspaceId = workspaceId;
    this.loading = true;
    this.loadingMore = false;
    try {
      const list = await agentActivity({ ...this.filter(), overviewSince: Date.now() - 7 * DAY_MS, todaySince: startOfToday() });
      if (request !== this.request) return;
      this.entries = list.entries ?? [];
      this.hasMore = Boolean(list.hasMore);
      this.overview = list.overview ?? null;
      this.enabled = list.enabled;
      this.error = list.error ?? '';
      if (this.selectedId && !this.hasMore && !this.text.trim() && !this.client && !this.entries.some(entry => entry.id === this.selectedId)) this.deselect();
    } catch (error) {
      if (request === this.request) this.error = message(error);
    } finally {
      if (request === this.request) {
        this.loading = false;
        this.loaded = true;
      }
    }
  }

  async loadMore() {
    if (!this.hasMore || this.loadingMore || this.loading) return;
    const last = this.entries[this.entries.length - 1];
    if (!last) return;
    const request = this.request;
    this.loadingMore = true;
    try {
      const list = await agentActivity({ ...this.filter(), before: last.id });
      if (request !== this.request) return;
      const known = new Set(this.entries.map(entry => entry.id));
      this.entries = [...this.entries, ...(list.entries ?? []).filter(entry => !known.has(entry.id))];
      this.hasMore = Boolean(list.hasMore);
      this.error = list.error ?? '';
    } catch (error) {
      if (request === this.request) this.error = message(error);
    } finally {
      if (request === this.request) this.loadingMore = false;
    }
  }

  setText(text: string) {
    this.text = text;
    if (this.filterTimer) clearTimeout(this.filterTimer);
    this.filterTimer = setTimeout(() => {
      this.filterTimer = null;
      void this.refresh();
    }, FILTER_DELAY_MS);
  }

  setClient(client: string) {
    this.client = client;
    void this.refresh();
  }

  clearFilters() {
    if (this.filterTimer) clearTimeout(this.filterTimer);
    this.filterTimer = null;
    this.text = '';
    this.client = '';
    void this.refresh();
  }

  setAllWorkspaces(all: boolean) {
    this.allWorkspaces = all;
    this.client = '';
    void this.refresh();
  }

  private withPlace(entry: AgentActivityEntry): AgentActivityEntry {
    const listed = this.entries.find(item => item.id === entry.id);
    return { ...entry, here: listed?.here ?? false, workspaceName: listed?.workspaceName ?? '' };
  }

  deselect() {
    this.detailRequest++;
    this.selectedId = '';
    this.selected = null;
    this.detailError = '';
    this.actionError = '';
  }

  async select(id: string) {
    const request = ++this.detailRequest;
    this.selectedId = id;
    this.detailError = '';
    this.actionError = '';
    if (this.selected?.id !== id) this.selected = null;
    try {
      const entry = await agentActivityEntry(id);
      if (request === this.detailRequest) this.selected = this.withPlace(entry);
    } catch (error) {
      if (request === this.detailRequest) this.detailError = message(error);
    }
  }

  async restore(path = '') {
    const entry = this.selected;
    if (!entry || this.busy) return;
    this.busy = path || '*';
    this.actionError = '';
    try {
      const updated = await revertAgentActivity(entry.id, path);
      if (this.selectedId === entry.id) this.selected = this.withPlace(updated);
      this.entries = this.entries.map(item => item.id === updated.id ? { ...item, reverted: updated.reverted } : item);
    } catch (error) {
      this.actionError = message(error);
    } finally {
      this.busy = '';
    }
  }

  async setEnabled(enabled: boolean) {
    const previous = this.enabled;
    this.enabled = enabled;
    this.actionError = '';
    const result = await setAgentActivityEnabled(enabled);
    if (!result.ok) {
      this.enabled = previous;
      this.actionError = result.error ?? 'Kurlo could not save this setting.';
    }
  }

  async clear() {
    this.actionError = '';
    const result = await clearAgentActivity();
    if (!result.ok) {
      this.actionError = result.error ?? 'Kurlo could not clear the activity log.';
      return;
    }
    this.deselect();
    this.entries = [];
    this.hasMore = false;
    this.overview = null;
  }
}

export const agentActivityStore = new AgentActivityStore();
