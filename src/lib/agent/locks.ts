/**
 * Per-conversation FIFO serialisation. A turn holds the lock until its answer
 * AND its memory update are committed, so the next turn always sees them.
 * Single-process by design (local SQLite app); see DESIGN.md.
 */
const tails = new Map<string, Promise<void>>();

export class LockTimeoutError extends Error {
  constructor() {
    super("Another reply in this conversation is still being written. Please wait a moment and retry.");
  }
}

/** Wait for earlier turns of `key`, then return a release function. */
export async function acquireConversationLock(key: string, waitMs = 90_000): Promise<() => void> {
  const prev = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const tail = prev.then(() => mine);
  tails.set(key, tail);
  let released = false;
  const done = () => {
    if (released) return;
    released = true;
    release();
    if (tails.get(key) === tail) tails.delete(key);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      prev,
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new LockTimeoutError()), waitMs);
      }),
    ]);
  } catch (e) {
    done();
    throw e;
  } finally {
    clearTimeout(timer);
  }
  return done;
}
