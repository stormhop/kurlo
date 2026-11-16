import type { SavedRequest } from '../../types/models';

const PREVIEW_TABS_KEY = 'kurlo.previewTabs.v1';
const PREVIEW_REQUEST_KEY = 'kurlo.previewRequest.v1';

type RequestTabsHost = {
  previewTabs: boolean;
  previewRequestId: string;
  openRequestIds: string[];
  dirtyRequestIds: Set<string>;
  inFlightRequestIds: Set<string>;
  webSocketSessions: Map<string, { status: string }>;
  socketIOSessions: Map<string, { status: string }>;
  sseSessions: Map<string, { status: string }>;
  requestForEditing: (id: string) => SavedRequest | undefined;
  requestDiffersFromStored: (request: SavedRequest) => boolean;
  realtimeStatusIsActive: (status: string) => boolean;
  disposeRealtimeSession: (id: string) => void;
  setPreviewRequestId: (id: string) => void;
  requestTabNeedsKeeping: (id: string) => boolean;
};

export const requestTabsFeature = {
  loadRequestTabPreferences(this: RequestTabsHost) {
    try {
      this.previewTabs = localStorage.getItem(PREVIEW_TABS_KEY) === 'true';
      this.previewRequestId = this.previewTabs ? localStorage.getItem(PREVIEW_REQUEST_KEY) ?? '' : '';
    } catch {}
  },

  setPreviewTabs(this: RequestTabsHost, enabled: boolean) {
    this.previewTabs = enabled;
    if (!enabled) this.setPreviewRequestId('');
    try {
      localStorage.setItem(PREVIEW_TABS_KEY, String(enabled));
    } catch {}
  },

  setPreviewRequestId(this: RequestTabsHost, id: string) {
    this.previewRequestId = id;
    try {
      if (id) localStorage.setItem(PREVIEW_REQUEST_KEY, id);
      else localStorage.removeItem(PREVIEW_REQUEST_KEY);
    } catch {}
  },

  keepRequestTab(this: RequestTabsHost, id: string) {
    if (id === this.previewRequestId) this.setPreviewRequestId('');
  },

  requestTabNeedsKeeping(this: RequestTabsHost, id: string) {
    const request = this.requestForEditing(id);
    return Boolean(request?.isDraft)
      || this.dirtyRequestIds.has(id)
      || Boolean(request && this.requestDiffersFromStored(request))
      || this.inFlightRequestIds.has(id)
      || [this.webSocketSessions, this.socketIOSessions, this.sseSessions]
        .some(sessions => this.realtimeStatusIsActive(sessions.get(id)?.status ?? ''));
  },

  openRequestTab(this: RequestTabsHost, id: string) {
    if (this.openRequestIds.includes(id)) return;
    if (!this.previewTabs || this.requestTabNeedsKeeping(id)) {
      this.openRequestIds = [...this.openRequestIds, id];
      return;
    }
    const previous = this.previewRequestId;
    const replace = previous && this.openRequestIds.includes(previous) && !this.requestTabNeedsKeeping(previous);
    this.openRequestIds = replace
      ? this.openRequestIds.map(openId => openId === previous ? id : openId)
      : [...this.openRequestIds, id];
    if (replace) this.disposeRealtimeSession(previous);
    this.setPreviewRequestId(id);
  },
};
