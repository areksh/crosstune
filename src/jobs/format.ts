/** Plain-text wording of jobs, runs and previews, for the CLI (and parts of the web UI). */

import type { PlaylistId } from "../services/ids.js";
import type {
  Job,
  InvalidJob,
  PlaylistInput,
  RunResultSummary,
  Schedule,
  SmartRule,
  SourceDef,
  TidyKind,
  TidySet,
} from "./model.js";
import type { ReleaseWindow } from "../features/new-releases.js";
import type { RefreshPreview } from "./refresh.js";
import type { AcceptOutcome, RunSummary } from "./run-due.js";
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
    ...((result.replaced ?? 0) > 0 ? [`${result.replaced} replaced`] : []),
    ...((result.tidyRemoved ?? 0) > 0 ? [`${result.tidyRemoved} tidied away`] : []),
    ...((result.suggested ?? 0) > 0 ? [count(result.suggested ?? 0, "suggestion")] : []),
  ];
  return `${result.status}: ${parts.length > 0 ? parts.join(", ") : "no changes"}`;
}

/** How a playlist or the favourites is named, given the names known. */
export function describeInput(input: PlaylistInput, names: ReadonlyMap<number, string> = new Map()): string {
  return input.type === "favourites" ? "Favourites" : (names.get(input.playlistId) ?? `playlist ${input.playlistId}`);
}

function list(inputs: readonly PlaylistInput[], names: ReadonlyMap<number, string>): string {
  return inputs.map((input) => describeInput(input, names)).join(" + ");
}

function describeArtists(artists: Extract<SourceDef, { type: "new-releases" }>["artists"], names: ReadonlyMap<number, string>): string {
  return artists.type === "list"
    ? count(artists.artists.length, "artist")
    : artists.type === "favourites"
      ? "favourite artists"
      : `the artists of ${describeInput({ type: "playlist", playlistId: artists.playlistId }, names)}`;
}

function describeRule(rule: SmartRule): string {
  switch (rule.type) {
    case "quality":
      return rule.quality === "hires" ? "hi-res" : "CD quality";
    case "decades":
      return `from the ${rule.decades.join(", ")}`;
    case "genres":
      return rule.genres.join(" or ");
    case "favourited-within":
      return `favourited in the last ${count(rule.days, "day")}`;
    case "artists":
      return [
        ...(rule.include !== undefined ? [`by ${rule.include.map((a) => a.name).join(", ")}`] : []),
        ...(rule.exclude !== undefined ? [`not by ${rule.exclude.map((a) => a.name).join(", ")}`] : []),
      ].join(", ");
    case "duration": {
      const minutes = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
      return rule.minSeconds !== undefined && rule.maxSeconds !== undefined
        ? `${minutes(rule.minSeconds)}-${minutes(rule.maxSeconds)} long`
        : rule.minSeconds !== undefined
          ? `at least ${minutes(rule.minSeconds)}`
          : `at most ${minutes(rule.maxSeconds ?? 0)}`;
    }
  }
}

const MODE_WORDS = { merge: "merged", "only-first": "only in the first", common: "in all of them" } as const;

/** One line saying what fills a playlist. */
export function describeSource(source: SourceDef | undefined, names: ReadonlyMap<number, string> = new Map()): string {
  if (source === undefined) {
    return "No source: only tidied";
  }
  switch (source.type) {
    case "new-releases": {
      const similar = source.similar === undefined ? "" : ` + ${source.similar.perArtist} similar each`;
      return `New releases: ${describeArtists(source.artists, names)}${similar}, ${describeWindow(source.window)}`;
    }
    case "combined":
      return `Combined: ${list(source.inputs, names)} (${MODE_WORDS[source.mode]}${source.order === "sequential" ? "" : `, ${source.order === "shuffle" ? "shuffled" : "taking turns"}`})`;
    case "follow":
      return `${source.keepRemoved ? "Archive of" : "Follows"} ${describeInput({ type: "playlist", playlistId: source.playlistId }, names)}`;
    case "smart":
      return `Smart: ${list(source.from, names)}, ${source.rules.map(describeRule).join(", ")}`;
    case "discovery":
      return `Discovery: ${source.artistsPerRotation} artists like ${describeArtists(source.seeds, names)}, ${source.tracksPerArtist} tracks each, new every ${source.rotation}`;
  }
}

const TIDY_NAMES: Record<TidyKind, string> = { dedupe: "Dedupe", upgrade: "Upgrade", repair: "Repair" };
const CADENCE_WORDS = { "every-pass": "every pass", weekly: "weekly", monthly: "monthly" } as const;

/** The tidy-ups, e.g. "Dedupe every pass · Upgrade monthly (suggest)". */
export function describeTidy(tidy: TidySet): string {
  const parts = (["repair", "upgrade", "dedupe"] as const).flatMap((kind) => {
    const def = tidy[kind];
    return def === undefined ? [] : [`${TIDY_NAMES[kind]} ${CADENCE_WORDS[def.cadence]}${def.mode === "suggest" ? " (suggest)" : ""}`];
  });
  return parts.length === 0 ? "No tidy-ups" : parts.join(" · ");
}

/** What a job manages: "playlist 77", "your playlist 12", "the favourites". */
export function describeTarget(job: Job, playlistId: PlaylistId | undefined, name?: string): string {
  if (job.target.type === "favourites") {
    return "the favourites";
  }
  const called = name === undefined ? "" : ` "${name}"`;
  if (job.target.type === "adopted") {
    return `your playlist${called} (${job.target.playlistId})`;
  }
  return playlistId === undefined ? "no playlist yet" : `playlist${called} (${playlistId}), created by qobuz-helper`;
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
    lines.push("No jobs yet. Create one with: qobuz-helper jobs create <new-releases|combined|follow|smart|discovery|tidy> ...");
    return lines.join("\n");
  }
  for (const { job, state, stateError } of list.jobs) {
    lines.push(`${job.id}  ${job.name} -- ${describeTarget(job, job.target.type === "created" ? state.playlistId : undefined)}`);
    lines.push(`    ${describeSource(job.source)}`);
    lines.push(
      `    ${describeTidy(job.tidy)}; ${describeSchedule(job.schedule)}${job.source === undefined ? "" : `; ${job.edits === "respect" ? "respects your edits" : "strict mirror"}`}`,
    );
    const status = stateError !== undefined
      ? `skipped: ${stateError}`
      : !job.enabled
      ? "paused by you"
      : state.paused !== undefined
        ? job.target.type === "adopted"
          ? "paused: the playlist was deleted or cannot be read (jobs resume <id> tries again)"
          : "paused: the playlist was deleted (jobs resume <id> makes a new one)"
        : state.nextRunAt === undefined
          ? "next run: as soon as run-due or serve runs"
          : `next ${state.nextRunAt}`;
    const last = state.lastResult === undefined ? "never run" : `last ${describeResult(state.lastResult)}`;
    const suggestions =
      state.suggestions.length === 0 ? "" : `; ${count(state.suggestions.length, "suggestion")} (jobs suggestions ${job.id})`;
    lines.push(`    ${last}; ${status}${suggestions}`);
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
  const sources = new Set(preview.add.map((track) => track.source));
  const releases = [...sources].every((source) => source.startsWith("album:"));
  const parts = [
    ...(preview.add.length > 0
      ? [
          `add ${count(preview.add.length, "track")}${releases ? ` from ${count(sources.size, "release")}` : ""}`,
        ]
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
      : preview.findings.length > 0
        ? `"${name}" has nothing to add or remove.`
        : `"${name}" is up to date.`;
  const findings = preview.findings.map(
    (finding) => `${finding.mode === "apply" ? "Would tidy" : "Would suggest"}: ${finding.summary}`,
  );
  return withNotes([line, ...findings].join("\n"), preview.notes);
}

export function formatSuggestions(view: JobView): string {
  const { suggestions } = view.state;
  if (suggestions.length === 0) {
    return `"${view.job.name}" has no suggestions.`;
  }
  return [
    `"${view.job.name}" -- ${count(suggestions.length, "suggestion")}:`,
    ...suggestions.map((suggestion) => `  ${suggestion.key}  ${suggestion.summary}`),
    `Accept with: qobuz-helper jobs accept ${view.job.id} <key...>|--all  (or ignore the same way)`,
  ].join("\n");
}

export function formatAccept(outcome: AcceptOutcome): string {
  if (outcome.status !== "accepted") {
    return outcome.message;
  }
  const parts = [
    `Accepted ${count(outcome.applied, "suggestion")}`,
    ...(outcome.stale > 0 ? [`dropped ${outcome.stale} that no longer applied`] : []),
  ];
  return withNotes(`${parts.join("; ")}.`, outcome.notes);
}
