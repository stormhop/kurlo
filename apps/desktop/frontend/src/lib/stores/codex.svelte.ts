import { codexStatus, onAgentEvent, type CodexRateLimit, type CodexStatus } from '../backend';

export const emptyCodexStatus = (): CodexStatus => ({ installed: false, connected: false, authenticated: false, path: '', version: '', account: '', authType: '', model: '', models: [], authUrl: '', waiting: false });

class CodexConnectionStore {
  private listening = false;

  private listen() {
    if (this.listening) return;
    this.listening = true;
    onAgentEvent<CodexRateLimit>('codex:rateLimits', limit => {
      const limits = this.status.rateLimits ?? [];
      this.status = { ...this.status, rateLimits: [...limits.filter(item => (item.limitId || 'codex') !== (limit.limitId || 'codex')), limit] };
    });
  }

  status = $state<CodexStatus>(emptyCodexStatus());
  loaded = $state(false);
  checking = $state(false);

  apply(status: CodexStatus) {
    this.listen();
    this.status = { ...status, models: status.models ?? [] };
    this.loaded = true;
  }

  async refresh(path = '') {
    if (this.checking) return;
    this.checking = true;
    try {
      this.apply(await codexStatus(path));
    } catch (error) {
      this.status = { ...this.status, error: error instanceof Error ? error.message : String(error) };
      this.loaded = true;
    } finally {
      this.checking = false;
    }
  }
}

export const codexConnectionStore = new CodexConnectionStore();
