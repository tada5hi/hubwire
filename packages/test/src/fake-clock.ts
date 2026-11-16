import type { IClock } from 'hubwire';

type FakeTimer = {
    at: number,
    order: number,
    fn: () => void,
};

/**
 * An IClock that moves only when advanced; `now()` is epoch ms (fractions kept). `advance(ms)` fires every timer due within the
 * span in order of its time (then of arming), with `now()` at the timer's time while it
 * fires, including the timers a fired one arms within the span; it awaits nothing, so
 * asynchronous work a timer starts runs after it returned (see `drain()`).
 * A delay outside 1 .. 2^31-1 ms counts as 1 ms, as for the global setTimeout.
 */
export class FakeClock implements IClock {
    protected time: number;

    protected timers: FakeTimer[] = [];

    protected armed = 0;

    constructor(now: Date | number = 0) {
        this.time = typeof now === 'number' ? now : now.getTime();
    }

    /**
     * The timers armed and not yet fired or cleared.
     */
    get timerCount(): number {
        return this.timers.length;
    }

    now(): number {
        return this.time;
    }

    setTimeout(fn: () => void, ms: number): { clear(): void } {
        const delay = ms >= 1 && ms <= 2 ** 31 - 1 ? ms : 1;
        const timer: FakeTimer = {
            at: this.time + delay, 
            order: this.armed++, 
            fn, 
        };

        this.timers.push(timer);

        return {
            clear: () => {
                this.timers = this.timers.filter((item) => item !== timer);
            },
        };
    }

    advance(ms: number): void {
        const until = this.time + ms;

        for (;;) {
            let next: FakeTimer | undefined;

            for (const timer of this.timers) {
                if (
                    timer.at <= until &&
                    (!next || timer.at < next.at || (timer.at === next.at && timer.order < next.order))
                ) {
                    next = timer;
                }
            }

            if (!next) {
                break;
            }

            const due = next;

            this.timers = this.timers.filter((item) => item !== due);
            this.time = Math.max(this.time, due.at);
            due.fn();
        }

        this.time = until;
    }
}
