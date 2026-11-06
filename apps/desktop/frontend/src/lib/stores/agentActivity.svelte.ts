import {
  agentActivity, agentActivityEntry, clearAgentActivity, revertAgentActivity, setAgentActivityEnabled,
  type AgentActivityEntry, type AgentActivitySummary,
} from '../backend';
import type { AgentActivityPeriod } from '../agentActivity';

const ACTIVITY_LIMIT = 500;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class AgentActivityStore {
  entries = $state<AgentActivitySummary[]>([]);
  enabled = $state(true);
  loaded = $state(false);
  loading = $state(false);
  error = $state('');
  text = $state('');
  client = $state('');
  period = $state<AgentActivityPeriod>('all');
  allWorkspaces = $state(false);
  workspaceId = $state('');
  selectedId = $state('');
  selected = $state<AgentActivityEntry | null>(null);
  detailError = $state('');
  actionError = $state('');
  busy = $state('');
  private request = 0;
  private detailRequest = 0;

  async refresh(workspaceId = this.workspaceId) {
    const request = ++this.request;
    this.workspaceId = workspaceId;
    this.loading = true;
    try {
      const list = await agentActivity({ limit: ACTIVITY_LIMIT, workspaceId, allWorkspaces: this.allWorkspaces });
      if (request !== this.request) return;
      this.entries = list.entries ?? [];
      this.enabled = list.enabled;
      this.error = list.error ?? '';
      if (this.selectedId && !this.entries.some(entry => entry.id === this.selectedId)) this.deselect();
    } catch (error) {
      if (request === this.request) this.error = message(error);
    } finally {
      if (request === this.request) {
        this.loading = false;
        this.loaded = true;
      }
    }
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
  }
}

export const agentActivityStore = new AgentActivityStore();
