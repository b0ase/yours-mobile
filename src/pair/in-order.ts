/**
 * Wrap an async WebSocket frame handler so frames are handled one at a time, in arrival order.
 *
 * `onmessage` does not wait for an async handler. Two sealed frames that arrive back to back both
 * pass `Sealer.open`'s sequence check before either decrypts, can finish in either order, and can
 * leave `lastSeen` lower than a frame already accepted. On the site side the same gap drops a
 * `ready` that arrives while `hello` is still deriving the key. Queueing every frame fixes both.
 */
export function inOrder<T>(handle: (frame: T) => Promise<void> | void): (frame: T) => void {
  let queue: Promise<void> = Promise.resolve();
  return (frame: T) => {
    queue = queue
      .then(() => handle(frame))
      .catch(() => {
        /* one bad frame must not stop the rest */
      });
  };
}
