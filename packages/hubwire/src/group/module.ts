import type { IComponent } from '../component';
import { invokeHook } from '../hook';
import { createLifecycle } from '../worker/lifecycle';
import type { ComponentGroupOptions, ComponentGroupStatus, IComponentGroup } from './types';

type Entry = { name: string, component: IComponent };

/**
 * Calls fn and turns a synchronous throw into a rejection.
 */
function call(fn: () => Promise<void> | undefined): Promise<void> {
    try {
        return Promise.resolve(fn());
    } catch (error) {
        return Promise.reject(error);
    }
}

export function defineComponentGroup(options: ComponentGroupOptions = {}): IComponentGroup {
    const entries: Entry[] = [];
    // true from start() until its release (or its failure) completed: add() is refused
    let active = false;

    const report = (name: string) => (error: unknown) => {
        invokeHook(options.hooks, 'onStopFailed', name, error);
    };

    /**
     * stop() on every entry (reverse add order) before awaiting any, then settled?.() on all.
     * Never rejects.
     */
    const sweep = async (started: Entry[]) => {
        const reversed = [...started].reverse();

        await Promise.all(reversed.map(({ name, component }) => call(() => component.stop()).catch(report(name))));
        await Promise.all(reversed.map(({ name, component }) => call(() => component.settled?.()).catch(report(name))));
    };

    const lifecycle = createLifecycle(async () => {
        active = true;

        const started: Entry[] = [];

        try {
            for (const entry of entries) {
                await call(() => entry.component.start());
                started.push(entry);
            }
        } catch (error) {
            await sweep(started);
            active = false;

            throw error;
        }

        return async () => {
            await sweep(started);
            active = false;
        };
    });

    let pending = 0;

    return {
        add(name, component) {
            if (active || pending > 0) {
                throw new Error(`The component group is started: cannot add "${name}".`);
            }

            const duplicate = entries.some((entry) => entry.name === name);

            if (duplicate) {
                throw new Error(`A component named "${name}" was already added.`);
            }

            entries.push({ name, component });
        },
        async start() {
            // covers the microtasks before the lifecycle's acquire sets `active`
            pending++;

            try {
                await lifecycle.start();
            } finally {
                pending--;
            }
        },
        stop() {
            return lifecycle.stop();
        },
        status(): ComponentGroupStatus {
            return {
                components: entries.map(({ name, component }) => ({
                    name,
                    ...component.status(),
                })),
            };
        },
        async settled() {
            await Promise.all(entries.map(({ component }) => call(() => component.settled?.()).catch(() => {})));
        },
    };
}
