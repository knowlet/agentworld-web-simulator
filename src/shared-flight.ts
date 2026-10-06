/** Work belongs to a flight, while cancellation belongs to each waiter. */
interface Flight<T> {
  controller: AbortController;
  promise: Promise<T>;
  waiters: number;
  settled: boolean;
}

export class SharedFlights {
  private readonly flights = new Map<string, Flight<unknown>>();

  has(id: string): boolean { return this.flights.has(id); }

  async run<T>(id: string, generate: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    let flight = this.flights.get(id) as Flight<T> | undefined;
    if (!flight) {
      const controller = new AbortController();
      const created: Flight<T> = {
        controller, waiters: 0, settled: false,
        promise: Promise.resolve().then(() => {
          controller.signal.throwIfAborted();
          return generate(controller.signal);
        }).then(value => {
          // A provider that finishes after cancellation must not yield success.
          controller.signal.throwIfAborted();
          return value;
        }),
      };
      flight = created;
      this.flights.set(id, created);
      const finish = () => {
        created.settled = true;
        if (this.flights.get(id) === created) this.flights.delete(id);
      };
      // Install both handlers immediately; abandoned work cannot become an
      // unhandled rejection, and an old flight cannot delete its replacement.
      void created.promise.then(finish, finish);
    }
    const current = flight;
    current.waiters++;
    return new Promise<T>((resolve, reject) => {
      let finished = false;
      const release = () => {
        if (finished) return false;
        finished = true;
        signal?.removeEventListener('abort', onAbort);
        current.waiters--;
        return true;
      };
      const onAbort = () => {
        if (!release()) return;
        if (!current.settled && current.waiters === 0) {
          if (this.flights.get(id) === current) this.flights.delete(id);
          current.controller.abort(signal?.reason);
        }
        reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      void current.promise.then(
        value => { if (release()) resolve(value); },
        error => { if (release()) reject(error); },
      );
    });
  }
}
