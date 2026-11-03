import { cancelClaudeCodeSignIn, claudeCodeStatus, emptyClaudeStatus, onAgentEvent, signInClaudeCode, type ClaudeStatus, type CodexRateLimit } from '../backend';

class ClaudeConnectionStore {
  private listening = false;

  private listen() {
    if (this.listening) return;
    this.listening = true;
    onAgentEvent<CodexRateLimit>('claude:rateLimits', limit => {
      this.status = { ...this.status, rateLimits: [limit] };
    });
  }

  status = $state<ClaudeStatus>(emptyClaudeStatus());
  checking = $state(false);
  loaded = $state(false);
  signingIn = $state(false);
  signInError = $state('');

  get models() {
    return this.status.models;
  }

  modelName(id: string): string {
    return this.status.models.find(model => model.id === id)?.name || id;
  }

  get usable() {
    return this.status.connected && this.status.authenticated && !this.status.error;
  }

  apply(status: ClaudeStatus) {
    this.listen();
    this.status = { ...status, models: status.models ?? [] };
    this.loaded = true;
  }

  async signIn(path = '') {
    if (this.signingIn || this.checking) return;
    this.signingIn = true;
    this.signInError = '';
    try {
      const result = await signInClaudeCode(path);
      this.signInError = result.error ?? '';
    } catch {
      this.signInError = 'Could not start Claude Code sign-in.';
    } finally {
      this.signingIn = false;
      await this.refresh(path);
    }
  }

  async cancelSignIn() {
    await cancelClaudeCodeSignIn();
  }

  async refresh(path = '') {
    if (this.checking) return;
    this.checking = true;
    try {
      this.apply(await claudeCodeStatus(path));
    } catch (error) {
      this.apply({ ...this.status, error: error instanceof Error ? error.message : 'Could not check Claude Code.' });
    } finally {
      this.checking = false;
    }
  }
}

export const claudeConnectionStore = new ClaudeConnectionStore();
