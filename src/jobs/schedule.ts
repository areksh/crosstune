/**
 * When jobs run.
 *
 * A job's next run is the first slot of its schedule strictly after "now", in
 * local time. Computing it from the clock (not from the previous slot) is what
 * makes a machine that slept through several slots run the job once on waking,
 * not once per missed slot. A local time that does not exist on a day (inside
 * a spring-forward gap) is moved forward by the gap, as `Date` normalises it.
 */

import type { Schedule } from "./model.js";

const HOUR_MS = 3_600_000;

/** Retry delays after the 1st, 2nd and 3rd (and later) failures in a row. */
export const BACKOFF_MS: readonly number[] = [15 * 60_000, HOUR_MS, 6 * HOUR_MS];

function clock(at: string): { hours: number; minutes: number } {
  const [hours = 0, minutes = 0] = at.split(":").map(Number);
  return { hours, minutes };
}

/** The first slot of `schedule` strictly after `after`. */
export function nextRunAt(schedule: Schedule, after: Date): Date {
  if (schedule.every === "hour") {
    return new Date((Math.floor(after.getTime() / HOUR_MS) + 1) * HOUR_MS);
  }
  const { hours, minutes } = clock(schedule.at);
  const slotOn = (dayOffset: number): Date =>
    new Date(after.getFullYear(), after.getMonth(), after.getDate() + dayOffset, hours, minutes);

  if (schedule.every === "day") {
    const today = slotOn(0);
    return today > after ? today : slotOn(1);
  }
  const ahead = (schedule.weekday - after.getDay() + 7) % 7;
  const slot = slotOn(ahead);
  return slot > after ? slot : slotOn(ahead + 7);
}

/**
 * When to retry after `consecutiveFailures` (>= 1) failures in a row: after the
 * backoff, but never later than the next regular slot.
 */
export function retryAt(schedule: Schedule, now: Date, consecutiveFailures: number): Date {
  const index = Math.min(Math.max(consecutiveFailures, 1), BACKOFF_MS.length) - 1;
  const backoff = new Date(now.getTime() + (BACKOFF_MS[index] ?? HOUR_MS));
  const regular = nextRunAt(schedule, now);
  return backoff < regular ? backoff : regular;
}
