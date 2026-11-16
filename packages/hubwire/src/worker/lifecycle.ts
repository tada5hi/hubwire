/* eslint-disable unicorn/prefer-promise-try -- Keep compatibility with the published Node.js runtime requirement. */
type Release = () => Promise<void>;

/**
 * Start / stop around an acquire that returns its release: a start() joins one in flight,
 * a stop() waits for it and releases, a start() or stop() during a release waits for it,
 * a failed start() resets so the next one acquires again. The acquire gets a signal that the
 * stop() ending it aborts, also while it is still in flight: an acquire that waits for
 * something a stop should end listens to it.
 */
export function createLifecycle(acquire: (signal: AbortSignal) => Promise<Release>) {
    let state: Promise<Release> | undefined;
    let controller: AbortController | undefined;
    // the release in flight, settled either way: start() and a later stop() queue on it in call
    // order, and a failed release stays the error of the stop() that started it
    let settled: Promise<void> | undefined;

    const stop = (): Promise<void> => {
        if (settled) {
            // a start() may be waiting for this release: stop again after it, so the last call wins
            return settled.then(stop);
        }

        const current = state;

        state = undefined;
        // before waiting for the acquire: it may be waiting for exactly this
        controller?.abort();
        controller = undefined;

        const released = (async () => {
            if (!current) {
                return;
            }

            let release: Release;

            try {
                release = await current;
            } catch {
                return;
            }

            await release();
        })();

        settled = released.catch(() => {}).then(() => {
            settled = undefined;
        });

        return released;
    };

    return {
        async start() {
            // set state synchronously unless a release is in flight, so a stop() right after sees it
            while (settled) {
                await settled;
            }

            if (!state) {
                // acquire's body runs a microtask later: a stop() it makes re-entrantly sees the state
                const { signal } = controller = new AbortController();
                const current = Promise.resolve().then(() => acquire(signal));

                state = current;
                current.catch(() => {
                    if (state !== current) {
                        return;
                    }

                    state = undefined;
                    controller = undefined;
                });
            }

            await state;
        },
        stop,
    };
}
