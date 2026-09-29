/**
 * Wire protocol between the mobile hub (top window) and each extension-page
 * endpoint (main UI, background worker, overlay iframes).
 *
 * Everything crosses as a JSON string, which matches how Chrome serialises
 * runtime messages and storage values, and means each endpoint parses into
 * objects from its own realm (iframes would otherwise get top-window objects).
 */

export type StorageArea = 'local' | 'session';

export type Sender = { id: string; url: string; origin: string };

export type StorageChanges = Record<string, { oldValue?: unknown; newValue?: unknown }>;

export type HostOp =
  | 'windows.create'
  | 'windows.remove'
  | 'windows.update'
  | 'windows.getAll'
  | 'tabs.create'
  | 'tabs.update'
  | 'notifications.create';

export type ToHub =
  | { t: 'send'; reqId: number; message: unknown }
  | { t: 'deliverResult'; hubReqId: number; hasResponse: boolean; response?: unknown; keepOpen: boolean }
  | { t: 'lateResponse'; hubReqId: number; response: unknown }
  | { t: 'storage'; reqId: number; area: StorageArea; op: 'get' | 'set' | 'remove' | 'clear'; arg?: unknown }
  | { t: 'connect'; portId: string; name: string }
  | { t: 'portPost'; portId: string; msg: unknown }
  | { t: 'portDisconnect'; portId: string }
  | { t: 'host'; reqId: number; op: HostOp; args: unknown[] };

export type ToEndpoint =
  | { t: 'deliver'; hubReqId: number; message: unknown; sender: Sender }
  | { t: 'reply'; reqId: number; response?: unknown; error?: string }
  | { t: 'storageResult'; reqId: number; result?: unknown; error?: string }
  | { t: 'storageChanged'; area: StorageArea; changes: StorageChanges }
  | { t: 'connect'; portId: string; name: string; sender: Sender }
  | { t: 'portPost'; portId: string; msg: unknown }
  | { t: 'portDisconnect'; portId: string }
  | { t: 'hostResult'; reqId: number; result?: unknown; error?: string }
  | { t: 'windowRemoved'; windowId: number };

/** Stands in for the extension id. Internal pages report this origin as sender. */
export const MOBILE_EXTENSION_ID = 'yours-mobile';
export const INTERNAL_ORIGIN = `chrome-extension://${MOBILE_EXTENSION_ID}`;
