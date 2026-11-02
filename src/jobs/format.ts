/** Plain-text wording of jobs, runs and previews, for the CLI. */

import type { InvalidJob, Job, RunResultSummary, Schedule } from "./model.js";
import type { ReleaseWindow } from "../features/new-releases.js";
import type { RefreshPreview } from "./refresh.js";
import type { RunSummary } from "./run-due.js";
import type { JobView } from "./service.js";
import type { GlobalFlags } from "./stores.js";

const DAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

function count(n: number, noun: string, plural = `${noun}s`): string {
  return `${n.toLocaleString("en-GB")} ${n === 1 ? noun : plural}`;
}

export function describeSchedule(schedule: Schedule): string {
  switch (schedule.every) {
    case "hour":
      return "Every hour";
    case "day":
      return `Daily at ${schedule.at}`;
    case "week":
      return `${DAYS[schedule.weekday] ?? "Weekly"} at ${schedule.at}`;
  }
}

export function describeWindow(window: ReleaseWindow): string {
  switch (window.type) {
    case "last-days":
      return window.days === 1 ? "released in the last day" : `released in the last ${window.days} days`;
    case "since":
      return `released since ${window.date}`;
    case "latest-per-artist":
      return window.count === 1
        ? "each artist's newest release"
        : `each artist's ${window.count} newest releases`;
  }
}

export function describeResult(result: RunResultSummary): string {
  if (result.status === "failed") {
    return `failed: ${result.error ?? "unknown error"}`;
  }
  if (result.status === "paused") {
    return "paused";
  }
  const parts = [
    ...(result.added > 0 ? [`+${count(result.added, "track")}`] : []),
    ...(result.removed > 0 ? [`-${count(result.removed, "track")}`] : []),
    ...(result.dismissed > 0 ? [`${result.dismissed} dismissed`] : []),
  ];
  return `${result.status}: ${parts.length > 0 ? parts.join(", ") : "no changes"}`;
}

function describeArtists(job: Job): string {
  const { artists, similar } = job.recipe;
  const base =
    artists.type === "list"
      ? count(artists.artists.length, "artist")
      : artists.type === "favourites"
        ? "favourite artists"
        : `the artists of playlist ${artists.playlistId}`;
  return similar === undefined ? base : `${base} + ${similar.perArtist} similar each`;
}

function describeFlags(flags: GlobalFlags): string[] {
  return [
    ...(flags.needsSignIn !== undefined
      ? [`! Jobs are stopped: the Qobuz session expired. Sign in again with: qobuz-helper login`]
      : []),
    ...(flags.bundleBroken !== undefined
      ? [`! Jobs are stopped: Qobuz changed its web player (${flags.bundleBroken.message}). Update qobuz-helper.`]
      : []),
  ];
}

export function formatJobList(list: { jobs: JobView[]; invalid: InvalidJob[]; flags: GlobalFlags }): string {
  const lines = describeFlags(list.flags);
  if (list.jobs.length === 0 && list.invalid.length === 0) {
    lines.push("No jobs yet. Create one with: qobuz-helper jobs create new-releases <artists...> --name <name>");
    return lines.join("\n");
  }
  for (const { job, state, stateError } of list.jobs) {
    lines.push(`${job.id}  ${job.name}`);
    lines.push(
      `    ${describeSchedule(job.schedule)} -- ${describeArtists(job)}, ${describeWindow(job.recipe.window)}; ${job.edits === "respect" ? "respects your edits" : "strict mirror"}`,
    );
    const status = stateError !== undefined
      ? `skipped: ${stateError}`
      : !job.enabled
      ? "paused by you"
      : state.paused !== undefined
        ? "paused: the playlist was deleted (jobs resume <id> makes a new one)"
        : state.nextRunAt === undefined
          ? "next run: as soon as run-due or serve runs"
          : `next ${state.nextRunAt}`;
    const last = state.lastResult === undefined ? "never run" : `last ${describeResult(state.lastResult)}`;
    const playlist = state.playlistId === undefined ? "no playlist yet" : `playlist ${state.playlistId}`;
    lines.push(`    ${playlist}; ${last}; ${status}`);
  }
  for (const bad of list.invalid) {
    lines.push(`! Job ${bad.id ?? `#${bad.index + 1}`} in jobs.json is invalid and skipped: ${bad.error}`);
  }
  return lines.join("\n");
}

function withNotes(line: string, notes: readonly string[]): string {
  return [line, ...notes.map((note) => `  ${note}`)].join("\n");
}

export function formatRunSummary(summary: RunSummary): string {
  switch (summary.status) {
    case "nothing-due":
      return "Nothing is due.";
    case "busy":
    case "jobs-file-error":
      return summary.message ?? summary.status;
    case "needs-sign-in":
      return `Jobs are stopped: the Qobuz session was rejected (${summary.message ?? ""}). Sign in again with: qobuz-helper login`;
    case "bundle-broken":
      return `Jobs are stopped: Qobuz changed its web player (${summary.message ?? ""}). Update qobuz-helper.`;
    case "ran":
      return summary.reports
        .map((report) => withNotes(`${report.name}: ${describeResult(report.result)}`, report.result.notes))
        .join("\n");
  }
}

export function formatPreview(name: string, preview: RefreshPreview): string {
  const releases = new Set(preview.add.map((track) => track.source)).size;
  const parts = [
    ...(preview.add.length > 0
      ? [`add ${count(preview.add.length, "track")} from ${count(releases, "release")}`]
      : []),
    ...(preview.remove.length > 0 ? [`remove ${count(preview.remove.length, "track")}`] : []),
    ...(preview.newlyDismissed.length > 0
      ? [`leave out ${count(preview.newlyDismissed.length, "track")} you removed`]
      : []),
  ];
  const line = preview.createsPlaylist
    ? `Would create the playlist "${name}"${parts.length > 0 ? ` and ${parts.join(", ")}` : " (empty for now)"}.`
    : parts.length > 0
      ? `Would ${parts.join(", ")} in "${name}".`
      : `"${name}" is up to date.`;
  return withNotes(line, preview.notes);
}
