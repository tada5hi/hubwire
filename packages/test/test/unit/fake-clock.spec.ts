import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../src';

describe('src/fake-clock', () => {
    it('should start at the given time and move only when advanced', () => {
        const clock = new FakeClock(new Date('2026-01-15T10:00:00.000Z'));

        expect(clock.now()).toBe(Date.parse('2026-01-15T10:00:00.000Z'));
        clock.advance(1500);
        expect(clock.now()).toBe(Date.parse('2026-01-15T10:00:01.500Z'));
    });

    it('should start at epoch 0 by default', () => {
        expect(new FakeClock().now()).toBe(0);
    });

    it('should accept epoch milliseconds with fractions and keep them', () => {
        const clock = new FakeClock(1000.25);

        expect(clock.now()).toBe(1000.25);
        clock.advance(0.5);
        expect(clock.now()).toBe(1000.75);
    });

    it('should fire due timers in order of their time, then of arming', () => {
        const clock = new FakeClock();
        const fired: string[] = [];

        clock.setTimeout(() => {
            fired.push('b');
        }, 200);
        clock.setTimeout(() => {
            fired.push('a');
        }, 100);
        clock.setTimeout(() => {
            fired.push('c');
        }, 200);
        clock.setTimeout(() => {
            fired.push('d');
        }, 300);
        clock.advance(200);

        expect(fired).toEqual(['a', 'b', 'c']);
        expect(clock.timerCount).toBe(1);
    });

    it('should report the timer\'s own time as now() while it fires', () => {
        const clock = new FakeClock();
        const seen: number[] = [];

        clock.setTimeout(() => {
            seen.push(clock.now());
        }, 100);
        clock.advance(250);

        expect(seen).toEqual([100]);
        expect(clock.now()).toBe(250);
    });

    it('should fire a timer armed by a fired timer within the advanced span', () => {
        const clock = new FakeClock();
        const fired: number[] = [];

        clock.setTimeout(() => {
            fired.push(clock.now());
            clock.setTimeout(() => {
                fired.push(clock.now());
            }, 100);
        }, 100);
        clock.advance(200);

        expect(fired).toEqual([100, 200]);
        expect(clock.timerCount).toBe(0);
    });

    it('should not fire a timer armed beyond the advanced span', () => {
        const clock = new FakeClock();
        const fired: number[] = [];

        clock.setTimeout(() => {
            clock.setTimeout(() => {
                fired.push(clock.now());
            }, 100);
        }, 100);
        clock.advance(150);

        expect(fired).toEqual([]);
        clock.advance(50);
        expect(fired).toEqual([200]);
    });

    it('should not fire a cleared timer', () => {
        const clock = new FakeClock();
        let fired = false;
        const timer = clock.setTimeout(() => {
            fired = true;
        }, 100);

        timer.clear();
        timer.clear();
        clock.advance(100);

        expect(fired).toBe(false);
        expect(clock.timerCount).toBe(0);
    });

    it('should treat a delay outside 1 .. 2^31-1 ms as 1 ms, as setTimeout does', () => {
        const clock = new FakeClock();
        const fired: number[] = [];

        for (const ms of [0, -5, NaN, 2 ** 31]) {
            clock.setTimeout(() => {
                fired.push(ms);
            }, ms);
        }

        clock.advance(1);

        expect(fired).toEqual([0, -5, NaN, 2 ** 31]);
    });
});
