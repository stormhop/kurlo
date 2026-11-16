import { describe, expect, it, vi } from 'vitest';
import { buildPaletteCommands, filterPaletteCommands, parsePaletteQuery, type PaletteContext } from '../lib/commandPalette';

function context(overrides: Partial<PaletteContext> = {}): PaletteContext {
  return {
    hasActiveRequest: true,
    canCopyCurl: true,
    autosave: false,
    codePanelAvailable: true,
    codePanelOpen: false,
    sidebarHidden: false,
    responseLayout: 'right',
    themeMode: 'system',
    whatsNewAvailable: true,
    showSidebarView: vi.fn(),
    openGlobals: vi.fn(),
    openCollectionRunner: vi.fn(),
    openMockServer: vi.fn(),
    openGit: vi.fn(),
    openCookies: vi.fn(),
    openSettings: vi.fn(),
    runShortcut: vi.fn(),
    createRequest: vi.fn(),
    createCollection: vi.fn(),
    createEnvironment: vi.fn(),
    importCollection: vi.fn(),
    copyCurl: vi.fn(),
    setResponseLayout: vi.fn(),
    setThemeMode: vi.fn(),
    showWhatsNew: vi.fn(),
    ...overrides,
  };
}

const ids = (ctx: PaletteContext) => buildPaletteCommands(ctx).map(command => command.id);

describe('request creation commands', () => {
  it('creates an HTTP request from New request and other protocols from their own commands', () => {
    const ctx = context();
    const commands = buildPaletteCommands(ctx);
    commands.find(command => command.id === 'create-request')!.run();
    expect(ctx.runShortcut).toHaveBeenCalledWith('new-request');
    for (const type of ['graphql', 'ws', 'socketio', 'grpc', 'mcp'] as const) {
      commands.find(command => command.id === `create-request-${type}`)!.run();
      expect(ctx.createRequest).toHaveBeenCalledWith(type);
    }
  });
});

describe('parsePaletteQuery', () => {
  it('treats a leading > as commands only', () => {
    expect(parsePaletteQuery('  > Git ')).toEqual({ commandsOnly: true, text: 'git' });
    expect(parsePaletteQuery('>')).toEqual({ commandsOnly: true, text: '' });
  });

  it('keeps an ordinary query for requests and commands', () => {
    expect(parsePaletteQuery(' Login ')).toEqual({ commandsOnly: false, text: 'login' });
  });
});

describe('buildPaletteCommands', () => {
  it('reopens the welcome screen through Help', () => {
    const showWelcome = vi.fn();
    const command = buildPaletteCommands(context({ showWelcome })).find(item => item.id === 'help-welcome');
    expect(command?.group).toBe('Help');
    command?.run();
    expect(showWelcome).toHaveBeenCalledOnce();
  });

  it('offers request commands only with a request open', () => {
    expect(ids(context())).toContain('request-send');
    const without = ids(context({ hasActiveRequest: false }));
    expect(without).not.toContain('request-send');
    expect(without).not.toContain('request-curl');
    expect(without).toContain('request-reopen');
  });

  it('offers Save only when saving is manual', () => {
    expect(ids(context({ autosave: false }))).toContain('request-save');
    expect(ids(context({ autosave: true }))).not.toContain('request-save');
  });

  it('offers the layout and themes that are not already in use', () => {
    const commands = ids(context({ responseLayout: 'right', themeMode: 'dark' }));
    expect(commands).toContain('view-response-below');
    expect(commands).not.toContain('view-response-right');
    expect(commands).toContain('theme-light');
    expect(commands).toContain('theme-system');
    expect(commands).not.toContain('theme-dark');
  });

  it('names the sidebar and code panel toggles by what they will do', () => {
    const labels = buildPaletteCommands(context({ sidebarHidden: true, codePanelOpen: true })).map(command => command.label);
    expect(labels).toContain('Show sidebar');
    expect(labels).toContain('Hide code snippet');
    expect(ids(context({ codePanelAvailable: false }))).not.toContain('view-code');
  });

  it('routes shortcut-backed commands through the shortcut runner', () => {
    const ctx = context();
    buildPaletteCommands(ctx).find(command => command.id === 'request-send')?.run();
    expect(ctx.runShortcut).toHaveBeenCalledWith('send-request');
  });

  it('keeps command ids unique', () => {
    const all = ids(context());
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('filterPaletteCommands', () => {
  const commands = buildPaletteCommands(context());

  it('returns every command for an empty query, in order', () => {
    expect(filterPaletteCommands(commands, '')).toEqual(commands);
  });

  it('ranks a label prefix above a word match and a keyword match', () => {
    const found = filterPaletteCommands(commands, 'git').map(command => command.id);
    expect(found[0]).toBe('go-git');
  });

  it('matches words of a label anywhere', () => {
    expect(filterPaletteCommands(commands, 'runner').map(command => command.id)).toContain('go-runner');
  });

  it('matches keywords by the start of a word, not the middle', () => {
    const found = filterPaletteCommands(commands, 'res').map(command => command.id);
    expect(found).not.toContain('request-url');
    expect(found).toContain('request-reopen');
  });

  it('puts request commands first when a request is open', () => {
    expect(commands[0].group).toBe('Request');
  });

  it('matches keywords when the label does not', () => {
    expect(filterPaletteCommands(commands, 'postman').map(command => command.id)).toEqual(['import-collection']);
  });

  it('requires every word of a multi-word query', () => {
    expect(filterPaletteCommands(commands, 'theme dark').map(command => command.id)).toEqual(['theme-dark']);
    expect(filterPaletteCommands(commands, 'theme banana')).toEqual([]);
  });
});
