type ListenerRegistry = Map<string, () => void>;

function registry(): ListenerRegistry {
  const host = window as Window & { __kurloRuntimeListeners?: ListenerRegistry };
  host.__kurloRuntimeListeners ??= new Map();
  return host.__kurloRuntimeListeners;
}

export function listenRuntime<T>(eventName: string, callback: (payload: T) => void): void {
  const on = window.runtime?.EventsOn;
  if (!on) return;
  const listeners = registry();
  listeners.get(eventName)?.();
  const off: unknown = on<T>(eventName, callback);
  listeners.set(eventName, typeof off === 'function' ? () => off() : () => {});
}
