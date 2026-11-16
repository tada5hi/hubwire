import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { FakeClock, MemoryScheduleLock } from '../../src';

describe('src/memory-schedule-lock', () => {
    beforeEach(() => {
        vi.useFakeTimers({ now: new Date('2026-01-15T10:00:00.000Z') });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('should let only the first caller acquire a key', async () => {
        const lock = new MemoryScheduleLock();

        await expect(lock.acquire('a', 1000)).resolves.toBe(true);
        await expect(lock.acquire('a', 1000)).resolves.toBe(false);
        expect(lock.acquired).toEqual([{ key: 'a', ttlMs: 1000 }]);
    });

    it('should keep keys independent', async () => {
        const lock = new MemoryScheduleLock();

        await expect(lock.acquire('a', 1000)).resolves.toBe(true);
        await expect(lock.acquire('b', 1000)).resolves.toBe(true);
    });

    it('should free a key at exactly acquiredAt + ttlMs', async () => {
        const lock = new MemoryScheduleLock();

        await lock.acquire('a', 1000);
        vi.advanceTimersByTime(999);
        await expect(lock.acquire('a', 1000)).resolves.toBe(false);
        vi.advanceTimersByTime(1);
        await expect(lock.acquire('a', 1000)).resolves.toBe(true);
    });

    it('should let only one of two concurrent callers win', async () => {
        const lock = new MemoryScheduleLock();
        const results = await Promise.all([lock.acquire('a', 1000), lock.acquire('a', 1000)]);

        expect(results.sort()).toEqual([false, true]);
    });

    it('should reject with acquireError', async () => {
        const lock = new MemoryScheduleLock();

        lock.acquireError = new Error('down');
        await expect(lock.acquire('a', 1)).rejects.toThrow('down');
        expect(lock.acquired).toEqual([]);
    });

    it('should free a key when the given clock passes its ttl', async () => {
        const clock = new FakeClock(new Date('2030-01-01T00:00:00.000Z'));
        const lock = new MemoryScheduleLock({ clock });

        await lock.acquire('a', 1000);
        // the global clock moving does not matter
        vi.advanceTimersByTime(5000);
        await expect(lock.acquire('a', 1000)).resolves.toBe(false);
        clock.advance(999);
        await expect(lock.acquire('a', 1000)).resolves.toBe(false);
        clock.advance(1);
        await expect(lock.acquire('a', 1000)).resolves.toBe(true);
    });
});
