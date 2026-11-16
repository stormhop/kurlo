import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestDiffersFromSavedSnapshot } from '../lib/manualSave';
import { requestTabsFeature } from '../lib/stores/features/requestTabs';
import type { SavedRequest } from '../lib/types/models';
import { dataBackupFeature } from '../lib/stores/features/dataBackup';
import { DEFAULT_PROXY_CONFIG } from '../lib/constants';

function tabHost() {
  const requests = new Map(['one', 'two', 'three'].map(id => [id, { id, name: id, url: `https://example.test/${id}`, method: 'GET' } as SavedRequest]));
  const saved = new Map(requests);
  const host = {
    previewTabs: false,
    previewRequestId: '',
    openRequestIds: ['one'],
    dirtyRequestIds: new Set<string>(),
    inFlightRequestIds: new Set<string>(),
    webSocketSessions: new Map<string, { status: string }>(),
    socketIOSessions: new Map<string, { status: string }>(),
    sseSessions: new Map<string, { status: string }>(),
    requests,
    requestForEditing: (id: string) => requests.get(id),
    requestDiffersFromStored: (request: SavedRequest) => requestDiffersFromSavedSnapshot(request, saved.get(request.id)),
    realtimeStatusIsActive: (status: string) => ['connected', 'connecting', 'reconnecting'].includes(status),
    disposeRealtimeSession: vi.fn(),
    ...requestTabsFeature,
  };
  return host;
}

describe('request preview tabs', () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('opens distinct tabs by default and focuses an already open request without duplicating it', () => {
    const host = tabHost();
    host.loadRequestTabPreferences();
    host.openRequestTab('two');
    host.openRequestTab('three');
    host.openRequestTab('two');
    expect(host.openRequestIds).toEqual(['one', 'two', 'three']);
    expect(host.previewTabs).toBe(false);
    expect(host.previewRequestId).toBe('');
  });

  it('reuses only the preview slot and leaves existing tabs in place', () => {
    const host = tabHost();
    host.setPreviewTabs(true);
    host.openRequestTab('two');
    host.openRequestTab('one');
    expect(host.previewRequestId).toBe('two');
    host.openRequestTab('three');
    expect(host.openRequestIds).toEqual(['one', 'three']);
    expect(host.previewRequestId).toBe('three');
    expect(host.disposeRealtimeSession).toHaveBeenCalledExactlyOnceWith('two');
  });

  it('keeps a preview explicitly and creates a new preview on the next open', () => {
    const host = tabHost();
    host.setPreviewTabs(true);
    host.openRequestTab('two');
    host.keepRequestTab('one');
    expect(host.previewRequestId).toBe('two');
    host.keepRequestTab('two');
    host.openRequestTab('three');
    expect(host.openRequestIds).toEqual(['one', 'two', 'three']);
    expect(host.previewRequestId).toBe('three');
  });

  for (const protectedState of ['draft', 'dirty', 'edited', 'http', 'grpc', 'ws', 'socketio', 'sse']) {
    it(`keeps a ${protectedState} request when another request is opened`, () => {
      const host = tabHost();
      host.setPreviewTabs(true);
      host.openRequestTab('two');
      if (protectedState === 'draft') host.requests.set('two', { ...host.requests.get('two')!, isDraft: true });
      if (protectedState === 'dirty') host.dirtyRequestIds.add('two');
      if (protectedState === 'edited') host.requests.set('two', { ...host.requests.get('two')!, url: 'https://edited.test' });
      if (['http', 'grpc'].includes(protectedState)) host.inFlightRequestIds.add('two');
      if (protectedState === 'ws') host.webSocketSessions.set('two', { status: 'connecting' });
      if (protectedState === 'socketio') host.socketIOSessions.set('two', { status: 'connected' });
      if (protectedState === 'sse') host.sseSessions.set('two', { status: 'reconnecting' });
      host.openRequestTab('three');
      expect(host.openRequestIds).toEqual(['one', 'two', 'three']);
      expect(host.previewRequestId).toBe('three');
      expect(host.disposeRealtimeSession).not.toHaveBeenCalled();
    });
  }

  it('opens drafts as permanent tabs without taking over the preview', () => {
    const host = tabHost();
    host.setPreviewTabs(true);
    host.openRequestTab('two');
    host.requests.set('three', { ...host.requests.get('three')!, isDraft: true });
    host.openRequestTab('three');
    expect(host.openRequestIds).toEqual(['one', 'two', 'three']);
    expect(host.previewRequestId).toBe('two');
  });

  it('restores the preference and preview identity and keeps all tabs when disabled', () => {
    const host = tabHost();
    host.setPreviewTabs(true);
    host.openRequestTab('two');
    const restored = tabHost();
    restored.loadRequestTabPreferences();
    restored.openRequestIds = [...host.openRequestIds];
    restored.openRequestTab('three');
    expect(restored.openRequestIds).toEqual(['one', 'three']);
    restored.setPreviewTabs(false);
    restored.openRequestTab('two');
    expect(restored.openRequestIds).toEqual(['one', 'three', 'two']);
    expect(restored.previewRequestId).toBe('');
    const disabled = tabHost();
    disabled.loadRequestTabPreferences();
    expect(disabled.previewTabs).toBe(false);
    expect(disabled.previewRequestId).toBe('');
  });

  it('does not replace another tab when the remembered preview has already closed', () => {
    const host = tabHost();
    host.setPreviewTabs(true);
    host.setPreviewRequestId('deleted');
    host.openRequestTab('two');
    expect(host.openRequestIds).toEqual(['one', 'two']);
    expect(host.previewRequestId).toBe('two');
  });

  it('includes the mode in a backup and applies it durably on import', () => {
    const host = {
      ...tabHost(),
      isRecord: (value: unknown) => Boolean(value && typeof value === 'object'),
      currentRequestSettings: () => ({}),
      proxyConfig: DEFAULT_PROXY_CONFIG,
    };
    host.setPreviewTabs(true);
    const backup = dataBackupFeature.kurloBackupPayload.call(host as never, {} as never);
    expect(backup.preferences.previewTabs).toBe(true);
    host.setPreviewTabs(false);
    dataBackupFeature.applyImportedPreferences.call(host as never, { previewTabs: backup.preferences.previewTabs });
    const restored = tabHost();
    restored.loadRequestTabPreferences();
    expect(restored.previewTabs).toBe(true);
  });

  it('still switches modes when local storage is unavailable', () => {
    vi.stubGlobal('localStorage', undefined);
    const host = tabHost();
    host.loadRequestTabPreferences();
    host.setPreviewTabs(true);
    host.openRequestTab('two');
    host.openRequestTab('three');
    expect(host.openRequestIds).toEqual(['one', 'three']);
    host.setPreviewTabs(false);
    expect(host.previewRequestId).toBe('');
  });
});
