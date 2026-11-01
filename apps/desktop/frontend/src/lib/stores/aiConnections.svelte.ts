import { aiConnections, type AiConnection } from '../backend';

class AiConnectionsStore {
  list = $state<AiConnection[]>([]);
  loaded = $state(false);

  get defaultConnection(): AiConnection | null {
    return this.list.find(connection => connection.default) ?? this.list[0] ?? null;
  }

  set(list: AiConnection[]) {
    this.list = list;
    this.loaded = true;
  }

  async refresh() {
    const state = await aiConnections();
    if (!state.error) this.set(state.connections ?? []);
  }
}

export const aiConnectionsStore = new AiConnectionsStore();
