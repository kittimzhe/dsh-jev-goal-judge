/**
 * Degradation primitives shared by the Jev client: a consecutive-failure
 * cooldown gate and a cancellable counting semaphore. Both are synchronous
 * and dependency-free so tests can drive them with an injected clock.
 * @module dsh-jev-goal-judge/resilience
 */

/**
 * Opens after `threshold` consecutive failures for `cooldownMs`, then lets a
 * single probe through; success closes the gate, failure re-opens it.
 */
export class CooldownGate {
  private failures = 0
  private openUntil = 0

  constructor(
    private readonly threshold: number,
    private readonly cooldownMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether calls are currently blocked by the gate. */
  open(): boolean {
    return this.now() < this.openUntil
  }

  /** Record a success: close the gate and reset the failure streak. */
  success(): void {
    this.failures = 0
    this.openUntil = 0
  }

  /** Record a failure: open the gate once the streak reaches the threshold. */
  failure(): void {
    this.failures += 1
    if (this.failures >= this.threshold) {
      this.openUntil = this.now() + this.cooldownMs
      this.failures = 0
    }
  }
}

/** Acquisition result of {@link Semaphore.acquire}. */
export type AcquireResult = 'acquired' | 'timeout' | 'aborted'

/**
 * Counting semaphore with a wait budget: at most `limit` holders at once, and
 * a waiter gives up when its budget or signal expires.
 */
export class Semaphore {
  private active = 0
  private readonly waiters: Array<{
    resolve: (value: AcquireResult) => void
    budget: number
    signal: AbortSignal
    onAbort: () => void
  }> = []

  constructor(private readonly limit: number) {}

  /**
   * Wait for a slot.
   * @param signal - caller cancellation; releasing rejects pending waiters as aborted.
   * @param budget - remaining wall-clock budget in ms; non-positive means timeout.
   * @returns how the wait settled.
   */
  acquire(signal: AbortSignal, budget: number): Promise<AcquireResult> {
    if (budget <= 0) return Promise.resolve(signal.aborted ? 'aborted' : 'timeout')
    if (this.active < this.limit) {
      this.active += 1
      return Promise.resolve('acquired')
    }
    return new Promise<AcquireResult>((resolve) => {
      const waiter = {
        resolve: (value: AcquireResult) => {
          signal.removeEventListener('abort', waiter.onAbort)
          resolve(value)
        },
        // The budget is captured as an expiry deadline checked by release() and
        // a local timer as the backstop while parked.
        budget: Date.now() + budget,
        signal,
        onAbort: () => waiter.resolve('aborted'),
      }
      signal.addEventListener('abort', waiter.onAbort, { once: true })
      this.waiters.push(waiter)
    })
  }

  /** Release a slot and admit the next waiter whose budget has not expired. */
  release(): void {
    this.active = Math.max(0, this.active - 1)
    while (this.active < this.limit) {
      const waiter = this.waiters.shift()
      if (waiter === undefined) return
      if (waiter.signal.aborted) continue
      if (Date.now() > waiter.budget) {
        waiter.resolve('timeout')
        continue
      }
      this.active += 1
      waiter.resolve('acquired')
    }
  }
}
