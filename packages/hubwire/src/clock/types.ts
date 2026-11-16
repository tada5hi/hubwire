/**
 * The source of time and timers of the components. `systemClock` is the default;
 * a test passes a controllable one (`FakeClock` of `@hubwire/test`).
 */
export interface IClock {
    /**
     * Epoch milliseconds; fractions are allowed (e.g. `performance.timeOrigin + performance.now()`).
     */
    now(): number;
    /**
     * Calls `fn` once after `ms` milliseconds, unless cleared before.
     */
    setTimeout(fn: () => void, ms: number): { clear(): void };
}
