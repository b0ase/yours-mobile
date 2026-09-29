/// <reference lib="webworker" />
import { Buffer } from 'buffer';
import process from 'process';
import { createChromeShim } from './chromeShim';

/**
 * Runs the extension's background.ts in a dedicated worker. Like a service
 * worker it has no document, so background.ts takes its normal
 * `isInServiceWorker` path unchanged.
 */

declare const self: DedicatedWorkerGlobalScope & { chrome?: unknown; Buffer?: unknown; process?: unknown };

self.Buffer = Buffer;
self.process = process;

// Worker consoles aren't visible on iOS (only the page's reaches Xcode / the
// bridge), so relay errors and warnings to the page. __YOURS_WORKER_LOG_ALL__
// relays everything for local debugging.
const relayLevels: Array<'error' | 'warn' | 'log'> = (self as unknown as { __YOURS_WORKER_LOG_ALL__?: boolean })
  .__YOURS_WORKER_LOG_ALL__
  ? ['error', 'warn', 'log']
  : ['error', 'warn'];
for (const level of relayLevels) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    original(...args);
    try {
      const text = args
        .map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ');
      self.postMessage({ t: 'console', level, text: text.slice(0, 4000) });
    } catch {
      // unserialisable argument: the original call already ran
    }
  };
}

// Hub traffic can arrive before init on WebKit; hold it until the shim exists.
const early: string[] = [];
let receive: ((json: string) => void) | undefined;

self.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as string | { t?: string; rootUrl?: string; version?: string };
  if (typeof data === 'string') return receive ? receive(data) : void early.push(data);
  if (data?.t === 'init' && !receive) void init(data.rootUrl!, data.version!);
});

const init = async (rootUrl: string, version: string) => {
  const shim = createChromeShim({
    post: (json) => self.postMessage(json),
    parse: JSON.parse,
    rootUrl,
    version,
    timers: {
      setInterval: self.setInterval.bind(self),
      setTimeout: self.setTimeout.bind(self),
      clearInterval: self.clearInterval.bind(self),
    },
  });
  self.chrome = shim.chrome;
  receive = shim.receive;
  early.splice(0).forEach(receive);

  try {
    await import('../background');
    self.postMessage({ t: 'ready' });
  } catch (error) {
    self.postMessage({
      t: 'error',
      message: error instanceof Error ? `${error.message}\n${error.stack}` : String(error),
    });
  }
};
