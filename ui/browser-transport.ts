/** Forward caller cancellation unchanged; World owns shared-work lifetime. */
export function createBrowserTransport<P, S>(world: {
  page(url: string, from: string, ctx: string, signal?: AbortSignal): Promise<P>;
  search(query: string, signal?: AbortSignal): Promise<S>;
}) {
  return {
    kind: 'browser' as const,
    page: (url: string, from: string, ctx: string, signal: AbortSignal) =>
      world.page(url, from, ctx, signal),
    search: (query: string, signal: AbortSignal) => world.search(query, signal),
  };
}
