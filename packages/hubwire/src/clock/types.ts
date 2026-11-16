/**
 * The source of time and timers of the components. `systemClock` is the default;
 * a test passes a controllable one (`FakeClock` of `@hubwire/test`).
 */
export interface IClock {
    now(): Date;
    /**
     * Calls `fn` once after `ms` milliseconds, unless cleared before.
     */
    setTimeout(fn: () => void, ms: number): { clear(): void };
}
