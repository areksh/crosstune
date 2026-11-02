/**
 * Small text helpers for the CLI's human-readable output.
 */

/**
 * "1 track", "0 tracks", "1,240 tracks": a count with its noun in the right
 * number. `plural` defaults to the noun plus "s".
 */
export function count(n: number, noun: string, plural = `${noun}s`): string {
  return `${n.toLocaleString("en-GB")} ${n === 1 ? noun : plural}`;
}
