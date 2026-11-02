import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { nextRunAt, retryAt } from "./schedule.js";

let previousTz: string | undefined;

beforeAll(() => {
  previousTz = process.env["TZ"];
  process.env["TZ"] = "Europe/London";
});

afterAll(() => {
  if (previousTz === undefined) {
    delete process.env["TZ"];
  } else {
    process.env["TZ"] = previousTz;
  }
});

const iso = (date: Date) => date.toISOString();
const daily = { every: "day", at: "06:00" } as const;

describe("nextRunAt", () => {
  it("runs hourly jobs on the hour", () => {
    expect(iso(nextRunAt({ every: "hour" }, new Date("2026-11-02T10:15:00Z")))).toBe(
      "2026-11-02T11:00:00.000Z",
    );
    expect(iso(nextRunAt({ every: "hour" }, new Date("2026-11-02T11:00:00Z")))).toBe(
      "2026-11-02T12:00:00.000Z",
    );
  });

  it("runs a daily job today when its time is still ahead, else tomorrow", () => {
    // November: London is on GMT, so local time equals UTC.
    expect(iso(nextRunAt(daily, new Date("2026-11-02T05:59:00Z")))).toBe("2026-11-02T06:00:00.000Z");
    expect(iso(nextRunAt(daily, new Date("2026-11-02T06:00:00Z")))).toBe("2026-11-03T06:00:00.000Z");
  });

  it("uses local time (summer time is UTC+1)", () => {
    expect(iso(nextRunAt(daily, new Date("2026-07-01T04:00:00Z")))).toBe("2026-07-01T05:00:00.000Z");
  });

  it("runs a weekly job on its weekday", () => {
    // 2026-11-04 is a Wednesday; the next Monday is 2026-11-09.
    expect(
      iso(nextRunAt({ every: "week", weekday: 1, at: "06:00" }, new Date("2026-11-04T12:00:00Z"))),
    ).toBe("2026-11-09T06:00:00.000Z");
    // On the Monday itself, before the time: today.
    expect(
      iso(nextRunAt({ every: "week", weekday: 1, at: "06:00" }, new Date("2026-11-09T05:00:00Z"))),
    ).toBe("2026-11-09T06:00:00.000Z");
    // On the Monday after the time: next week.
    expect(
      iso(nextRunAt({ every: "week", weekday: 1, at: "06:00" }, new Date("2026-11-09T07:00:00Z"))),
    ).toBe("2026-11-16T06:00:00.000Z");
  });

  it("schedules a daily job asleep for 10 days once, at the next slot after waking", () => {
    // Last scheduled 2026-11-02 06:00; the machine wakes on 2026-11-12 at 09:00.
    const wake = new Date("2026-11-12T09:00:00Z");
    expect(iso(nextRunAt(daily, wake))).toBe("2026-11-13T06:00:00.000Z");
  });

  it("moves a time inside the spring-forward gap forward by the gap", () => {
    // 2026-03-29: clocks go from 01:00 GMT to 02:00 BST; 01:30 does not exist.
    expect(
      iso(nextRunAt({ every: "day", at: "01:30" }, new Date("2026-03-29T00:00:00Z"))),
    ).toBe("2026-03-29T01:30:00.000Z"); // 02:30 BST
  });

  it("keeps 06:00 local across the autumn change", () => {
    expect(iso(nextRunAt(daily, new Date("2026-10-24T06:00:00Z")))).toBe("2026-10-25T06:00:00.000Z");
    expect(iso(nextRunAt(daily, new Date("2026-10-23T06:00:00Z")))).toBe("2026-10-24T05:00:00.000Z");
  });
});

describe("retryAt", () => {
  const weekly = { every: "week", weekday: 1, at: "06:00" } as const;
  const now = new Date("2026-11-04T12:00:00Z");

  it("backs off 15 minutes, then an hour, then 6 hours", () => {
    expect(iso(retryAt(weekly, now, 1))).toBe("2026-11-04T12:15:00.000Z");
    expect(iso(retryAt(weekly, now, 2))).toBe("2026-11-04T13:00:00.000Z");
    expect(iso(retryAt(weekly, now, 3))).toBe("2026-11-04T18:00:00.000Z");
    expect(iso(retryAt(weekly, now, 9))).toBe("2026-11-04T18:00:00.000Z");
  });

  it("never retries later than the next regular slot", () => {
    expect(iso(retryAt({ every: "hour" }, now, 3))).toBe("2026-11-04T13:00:00.000Z");
  });
});
