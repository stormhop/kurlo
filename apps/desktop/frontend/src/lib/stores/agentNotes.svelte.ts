import { agentWorkspaceNotes, saveAgentWorkspaceNotes } from '../backend';
import { AGENT_NOTES_MAX_BYTES, AGENT_NOTES_STARTER, agentNotesBytes } from '../agentNotes';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class AgentNotesEditorStore {
  open = $state(false);
  loading = $state(false);
  saving = $state(false);
  exists = $state(false);
  tooLarge = $state(false);
  path = $state('');
  content = $state('');
  initial = $state('');
  base = $state('');
  baseExists = $state(false);
  error = $state('');
  conflict = $state(false);
  conflictText = $state('');
  conflictExists = $state(false);
  preview = $state(false);
  savedAt = $state(0);

  get dirty(): boolean {
    return this.content !== this.initial;
  }

  get overLimit(): boolean {
    return agentNotesBytes(this.content) > AGENT_NOTES_MAX_BYTES;
  }

  async show() {
    this.open = true;
    this.loading = true;
    this.preview = false;
    this.clearError();
    try {
      const notes = await agentWorkspaceNotes();
      this.path = notes.path;
      this.exists = notes.exists;
      this.tooLarge = Boolean(notes.tooLarge);
      this.base = notes.content ?? '';
      this.baseExists = notes.exists;
      this.content = notes.exists ? this.base : AGENT_NOTES_STARTER;
      this.initial = this.content;
      if (notes.error) this.error = notes.error;
    } catch (error) {
      this.error = message(error);
    } finally {
      this.loading = false;
    }
  }

  clearError() {
    this.error = '';
    this.conflict = false;
    this.conflictText = '';
    this.conflictExists = false;
  }

  async save(): Promise<boolean> {
    if (this.saving || this.loading || this.tooLarge) return false;
    this.saving = true;
    this.clearError();
    try {
      const result = await saveAgentWorkspaceNotes(this.content, this.base, this.baseExists);
      if (result.ok) {
        this.exists = true;
        this.base = result.notes.content;
        this.baseExists = true;
        this.content = result.notes.content;
        this.initial = result.notes.content;
        this.savedAt = Date.now();
        return true;
      }
      this.error = result.error ?? 'Kurlo could not save kurlo-agent.md.';
      if (result.conflict) {
        this.conflict = true;
        this.conflictText = result.current ?? '';
        this.conflictExists = Boolean(result.currentExists);
      }
      return false;
    } catch (error) {
      this.error = message(error);
      return false;
    } finally {
      this.saving = false;
    }
  }

  reloadFromDisk() {
    this.base = this.conflictText;
    this.baseExists = this.conflictExists;
    this.exists = this.conflictExists;
    this.content = this.conflictText;
    this.initial = this.conflictText;
    this.clearError();
  }

  async overwrite(): Promise<boolean> {
    this.base = this.conflictText;
    this.baseExists = this.conflictExists;
    return this.save();
  }

  close() {
    this.open = false;
    this.clearError();
  }
}

export const agentNotesEditor = new AgentNotesEditorStore();
