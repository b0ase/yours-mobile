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

const onInit = async (event: MessageEvent) => {
  const { rootUrl, version } = event.data as { rootUrl: string; version: string };
  self.removeEventListener('message', onInit);

  const { chrome, receive } = createChromeShim({
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
  self.chrome = chrome;
  self.addEventListener('message', (e) => typeof e.data === 'string' && receive(e.data));

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

self.addEventListener('message', onInit);
