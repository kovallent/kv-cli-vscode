/** A timer handle, opaque to everything but the clock that made it. */
export type TimerHandle = unknown;

/** What the debouncer needs of time. Production uses the real timers. */
export interface Clock {
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  now(): number;
}

export const realClock: Clock = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  now: () => Date.now(),
};

/**
 * One pending call per key: scheduling a key again replaces the call
 * waiting for it, so only the last of a burst runs.
 */
export class Debouncer {
  private readonly pending = new Map<string, { handle: TimerHandle; due: number }>();

  constructor(private readonly clock: Clock = realClock) {}

  schedule(key: string, delayMs: number, run: () => void): void {
    this.cancel(key);
    const handle = this.clock.setTimeout(() => {
      this.pending.delete(key);
      run();
    }, delayMs);
    this.pending.set(key, { handle, due: this.clock.now() + delayMs });
  }

  cancel(key: string): void {
    const waiting = this.pending.get(key);
    if (waiting) {
      this.clock.clearTimeout(waiting.handle);
      this.pending.delete(key);
    }
  }

  cancelAll(): void {
    for (const key of [...this.pending.keys()]) {
      this.cancel(key);
    }
  }

  /** When the call waiting for `key` runs, on the clock's time; undefined if none. */
  due(key: string): number | undefined {
    return this.pending.get(key)?.due;
  }

  get size(): number {
    return this.pending.size;
  }
}

/**
 * Forwards to another clock, which the extension's tests can swap for a fake
 * one. Only `activate()` under the test runner creates it. Each handle keeps
 * the clock that made it, so a timer set before a swap is still cleared.
 */
export class SwitchableClock implements Clock {
  private target: Clock = realClock;

  use(clock: Clock): void {
    this.target = clock;
  }

  reset(): void {
    this.target = realClock;
  }

  setTimeout(callback: () => void, ms: number): TimerHandle {
    const clock = this.target;
    return { clock, inner: clock.setTimeout(callback, ms) };
  }

  clearTimeout(handle: TimerHandle): void {
    const { clock, inner } = handle as { clock: Clock; inner: TimerHandle };
    clock.clearTimeout(inner);
  }

  now(): number {
    return this.target.now();
  }
}
