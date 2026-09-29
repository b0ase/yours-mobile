/* eslint-disable @typescript-eslint/no-explicit-any */
import type { HostOp, Sender, StorageArea, ToEndpoint, ToHub } from './protocol';
import { MOBILE_EXTENSION_ID } from './protocol';

/**
 * A `chrome` object covering the extension APIs Yours Wallet uses, backed by
 * the hub. One is created per context (main UI, background worker, each
 * overlay iframe), the way every extension page gets its own `chrome`.
 */

type Listener = (...args: any[]) => any;

export type ShimOptions = {
  /** Send a JSON string to the hub. */
  post: (json: string) => void;
  /** JSON.parse from this context's realm. */
  parse: (json: string) => any;
  /** App root URL, the stand-in for chrome-extension://<id>/. */
  rootUrl: string;
  version: string;
  timers: Timers;
};

type Timers = {
  setInterval: (fn: () => void, ms: number) => number;
  setTimeout: (fn: () => void, ms: number) => number;
  clearInterval: (id: number) => void;
};

const makeEvent = () => {
  const listeners = new Set<Listener>();
  return {
    listeners,
    addListener: (fn: Listener) => void listeners.add(fn),
    removeListener: (fn: Listener) => void listeners.delete(fn),
    hasListener: (fn: Listener) => listeners.has(fn),
    hasListeners: () => listeners.size > 0,
  };
};

export const createChromeShim = (opts: ShimOptions) => {
  let nextReqId = 1;
  const replies = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const send = (msg: ToHub) => opts.post(JSON.stringify(msg));

  const runtime: any = {
    id: MOBILE_EXTENSION_ID,
    lastError: undefined as { message: string } | undefined,
    onMessage: makeEvent(),
    onConnect: makeEvent(),
    onInstalled: makeEvent(),
    getURL: (path: string) => new URL(path.replace(/^\//, ''), opts.rootUrl).href,
    getManifest: () => ({ version: opts.version, name: 'Yours Wallet', manifest_version: 3 }),
  };

  /** Call a chrome-style callback with runtime.lastError set for its duration. */
  const withLastError = (error: string | undefined, fn: () => void) => {
    runtime.lastError = error ? { message: error } : undefined;
    try {
      fn();
    } finally {
      runtime.lastError = undefined;
    }
  };

  /** Request/response against the hub, supporting both callback and promise forms. */
  const request = (build: (reqId: number) => ToHub, callback?: (result: any) => void): Promise<any> => {
    const reqId = nextReqId++;
    const promise = new Promise<any>((resolve, reject) => replies.set(reqId, { resolve, reject }));
    send(build(reqId));
    if (!callback) return promise;
    promise.then(
      (result) => withLastError(undefined, () => callback(result)),
      (error: Error) => withLastError(error.message, () => callback(undefined)),
    );
    return promise.catch(() => undefined);
  };

  runtime.sendMessage = (message: any, callback?: (response: any) => void) =>
    request((reqId) => ({ t: 'send', reqId, message }), callback);

  // PORTS ******************************************************************
  const ports = new Map<string, any>();
  const makePort = (portId: string, name: string, sender?: Sender) => {
    const port: any = {
      name,
      sender,
      onMessage: makeEvent(),
      onDisconnect: makeEvent(),
      postMessage: (msg: any) => send({ t: 'portPost', portId, msg }),
      disconnect: () => {
        if (!ports.delete(portId)) return;
        send({ t: 'portDisconnect', portId });
      },
    };
    ports.set(portId, port);
    return port;
  };
  runtime.connect = (info?: { name?: string }) => {
    const portId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const port = makePort(portId, info?.name ?? '');
    send({ t: 'connect', portId, name: port.name });
    return port;
  };

  // STORAGE ****************************************************************
  const storageOnChanged = makeEvent();
  const makeArea = (area: StorageArea) => {
    const op =
      (name: 'get' | 'set' | 'remove' | 'clear') =>
      (arg?: any, callback?: (r: any) => void): Promise<any> => {
        if (typeof arg === 'function') [arg, callback] = [undefined, arg];
        return request(
          (reqId) => ({ t: 'storage', reqId, area, op: name, arg }),
          callback && (name === 'get' ? callback : () => callback(undefined)),
        );
      };
    return {
      get: op('get'),
      set: op('set'),
      remove: op('remove'),
      clear: op('clear'),
      onChanged: makeEvent(),
    };
  };
  const storage = { local: makeArea('local'), session: makeArea('session'), onChanged: storageOnChanged };

  // HOST APIS (windows, tabs, notifications) ********************************
  const host =
    (op: HostOp) =>
    (...args: any[]) => {
      const callback = typeof args[args.length - 1] === 'function' ? args.pop() : undefined;
      return request((reqId) => ({ t: 'host', reqId, op, args }), callback);
    };
  const windowsOnRemoved = makeEvent();
  const windows = {
    WINDOW_ID_NONE: -1,
    create: host('windows.create'),
    remove: host('windows.remove'),
    update: host('windows.update'),
    getAll: host('windows.getAll'),
    onRemoved: windowsOnRemoved,
  };
  const tabs = { create: host('tabs.create'), update: host('tabs.update') };
  const notifications = { create: host('notifications.create') };

  // ALARMS (local timers; the background lives as long as the app) *********
  const alarmTimers = new Map<string, number>();
  const onAlarm = makeEvent();
  const alarms = {
    onAlarm,
    create: (name: string, info: { periodInMinutes?: number; delayInMinutes?: number }) => {
      const existing = alarmTimers.get(name);
      if (existing) opts.timers.clearInterval(existing);
      const periodMs = (info.periodInMinutes ?? info.delayInMinutes ?? 1) * 60_000;
      const fire = () => onAlarm.listeners.forEach((fn) => fn({ name, scheduledTime: Date.now() }));
      if (info.periodInMinutes) alarmTimers.set(name, opts.timers.setInterval(fire, periodMs));
      else opts.timers.setTimeout(fire, periodMs);
    },
    clear: async (name: string) => {
      const timer = alarmTimers.get(name);
      if (timer) opts.timers.clearInterval(timer);
      return alarmTimers.delete(name);
    },
  };

  // INBOUND ****************************************************************
  const deliver = (msg: Extract<ToEndpoint, { t: 'deliver' }>) => {
    let responded = false;
    let syncPhase = true;
    let syncResponse: unknown;
    let keepOpen = false;
    const sendResponse = (response?: unknown) => {
      if (responded) return;
      responded = true;
      if (syncPhase) syncResponse = response;
      else send({ t: 'lateResponse', hubReqId: msg.hubReqId, response });
    };
    for (const listener of [...runtime.onMessage.listeners]) {
      try {
        if (listener(msg.message, msg.sender, sendResponse) === true) keepOpen = true;
      } catch (error) {
        console.error('[chrome shim] onMessage listener threw', error);
      }
    }
    syncPhase = false;
    send({
      t: 'deliverResult',
      hubReqId: msg.hubReqId,
      hasResponse: responded,
      response: syncResponse,
      keepOpen: !responded && keepOpen,
    });
  };

  const receive = (json: string) => {
    const msg = opts.parse(json) as ToEndpoint;
    switch (msg.t) {
      case 'deliver':
        return deliver(msg);
      case 'reply':
      case 'storageResult':
      case 'hostResult': {
        const pending = replies.get(msg.reqId);
        if (!pending) return;
        replies.delete(msg.reqId);
        if (msg.error) return pending.reject(new Error(msg.error));
        return pending.resolve(msg.t === 'reply' ? msg.response : msg.result);
      }
      case 'storageChanged':
        storage[msg.area].onChanged.listeners.forEach((fn) => fn(msg.changes));
        return storageOnChanged.listeners.forEach((fn) => fn(msg.changes, msg.area));
      case 'connect': {
        if (!runtime.onConnect.hasListeners()) return;
        const port = makePort(msg.portId, msg.name, msg.sender);
        return runtime.onConnect.listeners.forEach((fn: Listener) => fn(port));
      }
      case 'portPost':
        return ports.get(msg.portId)?.onMessage.listeners.forEach((fn: Listener) => fn(msg.msg, ports.get(msg.portId)));
      case 'portDisconnect': {
        const port = ports.get(msg.portId);
        if (!port) return;
        ports.delete(msg.portId);
        return port.onDisconnect.listeners.forEach((fn: Listener) => fn(port));
      }
      case 'windowRemoved':
        return windowsOnRemoved.listeners.forEach((fn) => fn(msg.windowId));
    }
  };

  const chrome = { runtime, storage, windows, tabs, notifications, alarms };
  return { chrome, receive };
};
