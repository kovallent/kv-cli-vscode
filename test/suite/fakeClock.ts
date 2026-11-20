import type { Clock, TimerHandle } from "../../src/debounce";

/**
 * A clock that only moves when told to. Timers fire inside `advance`, in
 * order of due time, so a test decides exactly how far apart two saves are.
 */
export class FakeClock implements Clock {
  private time: number;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  constructor(start = 1_000_000) {
    this.time = start;
  }

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, ms: number): TimerHandle {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + Math.max(0, ms), callback });
    return id;
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle as number);
  }

  /** Move time forward by `ms`, firing every timer due on the way. */
  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      let next: [number, { at: number; callback: () => void }] | undefined;
      for (const entry of this.timers) {
        if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) {
          next = entry;
        }
      }
      if (!next) {
        break;
      }
      this.timers.delete(next[0]);
      this.time = next[1].at;
      next[1].callback();
    }
    this.time = end;
  }

  /** Fire everything still waiting, however far off. */
  runAll(): void {
    let latest = this.time;
    for (const t of this.timers.values()) {
      latest = Math.max(latest, t.at);
    }
    this.advance(latest - this.time);
  }

  get pending(): number {
    return this.timers.size;
  }
}
