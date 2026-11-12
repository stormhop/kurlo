import { afterEach, describe, expect, it, vi } from 'vitest';
import { frameSyncedWheel, wheelPixelsY } from '../lib/frameSyncedWheel';

type Listener = (event: WheelEvent) => void;

function scroller(scrollHeight: number, clientHeight: number) {
  let listener: Listener | null = null;
  const node = {
    scrollTop: 0,
    scrollHeight,
    clientHeight,
    addEventListener: (_type: string, handler: Listener) => { listener = handler; },
    removeEventListener: () => { listener = null; },
  };
  const wheel = (deltaY: number, extra: Partial<WheelEvent> = {}) => {
    const event = { deltaY, deltaMode: 0, ctrlKey: false, shiftKey: false, preventDefault: vi.fn(), ...extra } as unknown as WheelEvent;
    listener?.(event);
    return event;
  };
  return { node: node as unknown as HTMLElement, wheel, attached: () => listener !== null };
}

function stubFrames() {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal('cancelAnimationFrame', () => { frames.length = 0; });
  return () => frames.splice(0).forEach(callback => callback(0));
}

afterEach(() => vi.unstubAllGlobals());

describe('frameSyncedWheel', () => {
  it('collects a burst of wheel events and scrolls once per frame', () => {
    const runFrame = stubFrames();
    const { node, wheel } = scroller(10000, 600);
    const sync = vi.fn();
    frameSyncedWheel(node, sync);
    for (let i = 0; i < 5; i++) expect(wheel(40).preventDefault).toHaveBeenCalled();
    expect(node.scrollTop).toBe(0);
    runFrame();
    expect(node.scrollTop).toBe(200);
    expect(sync).toHaveBeenCalledOnce();
  });

  it('stops at both ends of the list', () => {
    const runFrame = stubFrames();
    const { node, wheel } = scroller(1000, 600);
    const sync = vi.fn();
    frameSyncedWheel(node, sync);
    wheel(5000);
    runFrame();
    expect(node.scrollTop).toBe(400);
    wheel(-9000);
    runFrame();
    expect(node.scrollTop).toBe(0);
    wheel(-10);
    runFrame();
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('leaves pinch zoom, shift scrolling and lists that fit alone', () => {
    stubFrames();
    const long = scroller(10000, 600);
    frameSyncedWheel(long.node, vi.fn());
    expect(long.wheel(40, { ctrlKey: true }).preventDefault).not.toHaveBeenCalled();
    expect(long.wheel(40, { shiftKey: true }).preventDefault).not.toHaveBeenCalled();
    expect(long.wheel(0).preventDefault).not.toHaveBeenCalled();
    const short = scroller(300, 600);
    frameSyncedWheel(short.node, vi.fn());
    expect(short.wheel(40).preventDefault).not.toHaveBeenCalled();
  });

  it('calls the latest handler after an update and detaches on destroy', () => {
    const runFrame = stubFrames();
    const { node, wheel, attached } = scroller(10000, 600);
    const first = vi.fn();
    const second = vi.fn();
    const action = frameSyncedWheel(node, first);
    action.update(second);
    wheel(50);
    runFrame();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    action.destroy();
    expect(attached()).toBe(false);
  });
});

describe('wheelPixelsY', () => {
  it('converts line and page deltas to pixels', () => {
    expect(wheelPixelsY({ deltaY: 3, deltaMode: 0 }, 600)).toBe(3);
    expect(wheelPixelsY({ deltaY: 3, deltaMode: 1 }, 600)).toBe(96);
    expect(wheelPixelsY({ deltaY: 1, deltaMode: 2 }, 600)).toBe(600);
  });
});
