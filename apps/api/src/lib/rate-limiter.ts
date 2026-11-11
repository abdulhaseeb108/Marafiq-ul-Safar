/**
 * Counts failed attempts per key in a fixed window (e.g. 5 per 15 minutes).
 * In memory: correct for one API process. If the API is ever scaled to several
 * instances, swap this for a shared store behind the same three methods.
 */
export class FailureLimiter {
  private readonly entries = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly options: { maxFailures: number; windowMs: number },
    private readonly now: () => number = Date.now,
  ) {}

  /** 0 when the key may try again, otherwise seconds until it may. */
  retryAfterSeconds(key: string): number {
    const entry = this.live(key);
    if (!entry || entry.count < this.options.maxFailures) return 0;
    return Math.ceil((entry.resetAt - this.now()) / 1000);
  }

  recordFailure(key: string): void {
    const entry = this.live(key);
    if (entry) entry.count += 1;
    else this.entries.set(key, { count: 1, resetAt: this.now() + this.options.windowMs });
    if (this.entries.size > 10_000) this.sweep();
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  private live(key: string) {
    const entry = this.entries.get(key);
    if (entry && entry.resetAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) if (entry.resetAt <= now) this.entries.delete(key);
  }
}
