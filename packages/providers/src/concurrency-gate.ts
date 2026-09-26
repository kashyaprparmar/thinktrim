import { DecisionBackendFailure } from "@thinktrim/core";

export interface ConcurrencyLease {
  readonly queueTimeMs: number;
  readonly release: () => void;
}

interface Waiter {
  readonly queuedAt: number;
  readonly resolve: (lease: ConcurrencyLease) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  readonly abort?: () => void;
}

/** Fair, bounded async gate for provider calls. */
export class ConcurrencyGate {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueued: number,
  ) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 64) {
      throw new RangeError("maxConcurrent must be between 1 and 64");
    }
    if (!Number.isSafeInteger(maxQueued) || maxQueued < 0 || maxQueued > 1024) {
      throw new RangeError("maxQueued must be between 0 and 1024");
    }
  }

  get queuedCount(): number {
    return this.waiters.length;
  }

  acquire(signal?: AbortSignal): Promise<ConcurrencyLease> {
    if (signal?.aborted) return Promise.reject(new DecisionBackendFailure("cancelled"));
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve(this.createLease(0));
    }
    if (this.waiters.length >= this.maxQueued) {
      return Promise.reject(new DecisionBackendFailure("unavailable"));
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        queuedAt: performance.now(),
        resolve,
        reject,
        ...(signal === undefined ? {} : { signal }),
        ...(signal === undefined
          ? {}
          : {
              abort: () => {
                const index = this.waiters.indexOf(waiter);
                if (index >= 0) this.waiters.splice(index, 1);
                reject(new DecisionBackendFailure("cancelled"));
              },
            }),
      };
      if (waiter.abort) signal?.addEventListener("abort", waiter.abort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private createLease(queueTimeMs: number): ConcurrencyLease {
    let released = false;
    return {
      queueTimeMs,
      release: () => {
        if (released) return;
        released = true;
        const next = this.waiters.shift();
        if (next) {
          if (next.abort) next.signal?.removeEventListener("abort", next.abort);
          next.resolve(this.createLease(Math.max(0, performance.now() - next.queuedAt)));
        } else {
          this.active -= 1;
        }
      },
    };
  }
}
