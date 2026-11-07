import { aiConnections, testAiConnection, type AiConnection, type AiConnectionModel } from '../backend';

class AiConnectionsStore {
  list = $state<AiConnection[]>([]);
  loaded = $state(false);
  intent = $state<'' | 'key' | 'local'>('');
  reveal = $state<'' | 'agents' | 'kurlo' | 'models'>('');
  models = $state<Record<string, AiConnectionModel[]>>({});
  modelsLoading = $state<Record<string, boolean>>({});
  modelsError = $state<Record<string, string>>({});

  get defaultConnection(): AiConnection | null {
    return this.list.find(connection => connection.default) ?? this.list[0] ?? null;
  }

  set(list: AiConnection[]) {
    this.list = list;
    this.loaded = true;
  }

  async loadModels(id: string, force = false) {
    if (!id || this.modelsLoading[id] || (!force && this.models[id])) return;
    this.modelsLoading = { ...this.modelsLoading, [id]: true };
    this.modelsError = { ...this.modelsError, [id]: '' };
    try {
      const result = await testAiConnection({ id, kind: '', label: '', baseUrl: '', key: '', model: '' });
      if (result.ok) this.models = { ...this.models, [id]: result.models ?? [] };
      else this.modelsError = { ...this.modelsError, [id]: result.error ?? 'Kurlo could not load the models.' };
    } catch (error) {
      this.modelsError = { ...this.modelsError, [id]: error instanceof Error ? error.message : String(error) };
    } finally {
      this.modelsLoading = { ...this.modelsLoading, [id]: false };
    }
  }

  async refresh() {
    try {
      const state = await aiConnections();
      if (!state.error) this.set(state.connections ?? []);
    } finally {
      this.loaded = true;
    }
  }
}

export const aiConnectionsStore = new AiConnectionsStore();
