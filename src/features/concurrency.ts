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
 *
 * `limit` is floored and taken as at least 1: a zero, negative or `NaN` limit
 * would otherwise start no runner at all and hand back an empty, sparse array
 * as though every item had been done.
 *
 * Once any call rejects, the runners stop claiming new items -- the result is
 * going to be that rejection whatever the rest return, and over a long list
 * every further item is a wasted request to the service. Calls already in
 * flight finish on their own; the returned promise rejects with the first error.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const width = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : limit > 0 ? items.length : 1;
  let next = 0;
  let failed = false;
  const runners = Array.from(
    { length: Math.min(width, items.length) },
    async () => {
      for (;;) {
        // `next += 1` runs to completion between awaits (JS is single-threaded),
        // so each runner claims a distinct index.
        const index = next;
        next += 1;
        if (failed || index >= items.length) {
          return;
        }
        try {
          results[index] = await worker(items[index]!);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    },
  );
  await Promise.all(runners);
  return results;
}
