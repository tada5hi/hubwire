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

    const stop = ({ name, component }: Entry) => call(() => component.stop()).catch(report(name));

    /**
     * stop() on every started entry (reverse add order) before awaiting any, then settled?.()
     * on all. `early` holds the stop() made on an entry during its start(): it is awaited, and
     * the entry is stopped again if its start() resolved (the early one may have found nothing
     * to stop yet) or only settled if its start() failed. Never rejects.
     */
    const sweep = async (started: Entry[], early: Map<Entry, Promise<void>>) => {
        // an entry stopped during a start() that then failed is not in `started`; it was added last
        const failed = early.keys().filter((entry) => !started.includes(entry));
        const reversed = [...failed, ...[...started].reverse()];

        await Promise.all(reversed.map((entry) => Promise.all([
            early.get(entry),
            started.includes(entry) ? stop(entry) : undefined,
        ])));
        await Promise.all(reversed.map(({ name, component }) => call(() => component.settled?.()).catch(report(name))));
    };

    const lifecycle = createLifecycle(async (signal) => {
        active = true;

        const started: Entry[] = [];
        const early = new Map<Entry, Promise<void>>();
        let starting: Entry | undefined;
        // a stop() during start(): the component being started is stopped at once, since its
        // start() may only resolve once it is (a scheduled component's start pass waiting for its abort)
        const onAbort = () => {
            if (starting) {
                early.set(starting, stop(starting));
            }
        };

        signal.addEventListener('abort', onAbort);

        try {
            for (const entry of entries) {
                if (signal.aborted) {
                    // stopped meanwhile: the rest is never started
                    break;
                }

                starting = entry;

                try {
                    await call(() => entry.component.start());
                } finally {
                    // before any cleanup: a stop() during it must not reach a component whose start() ended
                    starting = undefined;
                }

                started.push(entry);
            }
        } catch (error) {
            await sweep(started, early);
            active = false;

            throw error;
        } finally {
            signal.removeEventListener('abort', onAbort);
        }

        return async () => {
            await sweep(started, early);
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
                    ...component.status(),
                    // last: the name the component was added under wins over one in its status
                    name,
                })),
            };
        },
        async settled() {
            await Promise.all(entries.map(({ component }) => call(() => component.settled?.()).catch(() => {})));
        },
    };
}
