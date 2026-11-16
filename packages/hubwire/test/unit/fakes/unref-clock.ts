import { FakeClock } from '@hubwire/test';
import type { ClockTimer } from '../../../src';

/**
 * A FakeClock whose timers have an `unref()`: `armedCount` counts every timer
 * armed, `unrefCount` every timer whose unref() was called (once per timer).
 */
export class UnrefClock extends FakeClock {
    armedCount = 0;

    unrefCount = 0;

    override setTimeout(fn: () => void, ms: number): ClockTimer {
        const timer = super.setTimeout(fn, ms);
        let unrefed = false;

        this.armedCount++;

        return {
            clear: () => timer.clear(),
            unref: () => {
                if (unrefed) {
                    return;
                }

                unrefed = true;
                this.unrefCount++;
            },
        };
    }
}
