/**
 * A timer armed by IClock.setTimeout.
 */
export type ClockTimer = {
    clear(): void,
    /**
     * Lets the process exit while the timer is pending. Optional: a clock without
     * such a notion (a fake) leaves it out.
     */
    unref?(): void,
};

/**
 * The source of time and timers of the components. `systemClock` is the default;
 * a test passes a controllable one (`FakeClock` of `@hubwire/test`).
 */
export interface IClock {
    /**
     * Epoch milliseconds; fractions are allowed (e.g. `performance.timeOrigin + performance.now()`,
     * which drifts from the wall clock: not for a scheduled component with a lock).
     */
    now(): number;
    /**
     * Calls `fn` once after `ms` milliseconds, unless cleared before.
     */
    setTimeout(fn: () => void, ms: number): ClockTimer;
}
