import { mkRow } from '../../constants';
import { defaultSocketIOArg } from '../../requestBodyDefaults';
import type { KVRow, SIOArg } from '../../types/models';
import { rowHasContent } from '../../utils';

type SocketIOFormHost = {
  sioArgs: SIOArg[];
  sioEvents: KVRow[];
  sioSelectedArgId: string;
  mkSioEventRow: () => KVRow;
  sioCurrentArg: () => SIOArg | undefined;
};

export function mkSioEventRow(): KVRow {
  return { ...mkRow(), enabled: false };
}

export const socketioFormFeature = {
  mkSioEventRow(): KVRow {
    return mkSioEventRow();
  },

  restoreSioEventRows(this: SocketIOFormHost, rows: KVRow[] | undefined): KVRow[] {
    const restored = (rows ?? [])
      .filter(rowHasContent)
      .map(row => ({
        ...this.mkSioEventRow(),
        enabled: row.enabled ?? true,
        key: row.key ?? '',
        value: row.value ?? '',
        description: row.description ?? '',
        isFile: row.isFile ?? false,
        fileName: row.fileName ?? '',
        secret: row.secret ?? false,
      }));
    return [...restored, this.mkSioEventRow()];
  },

  sioCurrentArg(this: SocketIOFormHost): SIOArg | undefined {
    return this.sioArgs.find(a => a.id === this.sioSelectedArgId) ?? this.sioArgs[0];
  },

  sioAddArg(this: SocketIOFormHost) {
    const id = String(Date.now());
    this.sioArgs = [...this.sioArgs, defaultSocketIOArg(id)];
    this.sioSelectedArgId = id;
  },

  sioRemoveArg(this: SocketIOFormHost, argId: string) {
    if (this.sioArgs.length <= 1) return;
    const idx = this.sioArgs.findIndex(a => a.id === argId);
    this.sioArgs = this.sioArgs.filter(a => a.id !== argId);
    if (this.sioSelectedArgId === argId) {
      this.sioSelectedArgId = this.sioArgs[Math.max(0, idx - 1)]?.id ?? this.sioArgs[0]?.id ?? '';
    }
  },

  sioUpdateCurrentArg(this: SocketIOFormHost, patch: Partial<SIOArg>) {
    const idx = this.sioArgs.findIndex(a => a.id === this.sioSelectedArgId);
    const targetIdx = idx >= 0 ? idx : 0;
    this.sioArgs = this.sioArgs.map((a, i) => i === targetIdx ? { ...a, ...patch } : a);
    this.sioSelectedArgId = this.sioArgs[targetIdx]?.id ?? this.sioSelectedArgId;
  },

  get sioCurrentArgLang(): 'json' | 'text' | 'xml' | 'html' {
    const host = this as unknown as SocketIOFormHost;
    const arg = host.sioCurrentArg();
    if (!arg || arg.bodyType === 'binary') return 'text';
    return arg.bodyType as 'json' | 'text' | 'xml' | 'html';
  },

  sioEventsWithTrailing(this: SocketIOFormHost) {
    const rows = this.sioEvents;
    if (rows.length === 0 || rows[rows.length - 1].key !== '') return [...rows, this.mkSioEventRow()];
    return rows;
  },

  updateSioEventRow(this: SocketIOFormHost, id: number, patch: Partial<KVRow>) {
    this.sioEvents = this.sioEvents.map(r => {
      if (r.id !== id) return r;
      const effectivePatch = (!r.key && patch.key && !('enabled' in patch))
        ? { ...patch, enabled: false }
        : patch;
      return { ...r, ...effectivePatch };
    });
    const rows = this.sioEvents;
    if (rows.length === 0 || rows[rows.length - 1].key !== '') this.sioEvents = [...rows, this.mkSioEventRow()];
  },

  removeSioEventRow(this: SocketIOFormHost, id: number) {
    this.sioEvents = this.sioEvents.filter(r => r.id !== id);
  },
};
