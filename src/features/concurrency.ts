/**
 * Bounded-concurrency mapping for the feature modules.
 *
 * The resolve/fetch helpers turn each input into a Qobuz item with one or two
 * requests per item. Over a large list a strictly sequential pass keeps a single
 * web request open long enough for the browser to abort the fetch even though
 * the server is still working. Running the calls through a small pool cuts the
 * wall-clock time by the pool's width. It is kept modest deliberately: Qobuz
 * throttles bursts of signed requests with a 400, which the client's own
 * backoff-and-retry rides out, so a large fan-out would be counter-productive.
 */

/** The default pool width shared by the resolve/fetch feature helpers. */
export const DEFAULT_CONCURRENCY = 5;

/**
 * Map over `items` running at most `limit` calls of `worker` concurrently, and
 * return the results in input order (regardless of which calls finish first).
 * `limit` is assumed to be at least 1.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        // `next += 1` runs to completion between awaits (JS is single-threaded),
        // so each runner claims a distinct index.
        const index = next;
        next += 1;
        if (index >= items.length) {
          return;
        }
        results[index] = await worker(items[index]!);
      }
    },
  );
  await Promise.all(runners);
  return results;
}
