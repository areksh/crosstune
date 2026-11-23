/** Resolve a job's source, whichever kind it is, into desired tracks and its new state. */

import type { TrackId } from "../../services/ids.js";
import type { Job, SourceDef, SourceState } from "../model.js";
import { resolveCombined } from "./combined.js";
import { applyShape, type SourceResult } from "./common.js";
import { resolveDiscovery, type DiscoveryClient } from "./discovery.js";
import { resolveFollow } from "./follow.js";
import { resolveNewReleasesFeed, type FeedClient } from "./new-releases.js";
import { resolveSmart } from "./smart.js";

export type { SourceResult };

/** Everything any source reads. */
export type SourceClient = FeedClient & DiscoveryClient;

export interface SourceContext {
  now: Date;
  /** Original dates of favourites a tidy-up replaced. */
  favouriteDates?: ReadonlyMap<TrackId, string>;
}

export async function resolveSource(
  client: SourceClient,
  job: Job & { source: SourceDef },
  state: SourceState,
  ctx: SourceContext,
): Promise<SourceResult> {
  const { source } = job;
  switch (source.type) {
    case "new-releases": {
      const result = await resolveNewReleasesFeed(client, source, job.shape, {
        now: ctx.now,
        jobId: job.id,
        state: state.similar === undefined ? {} : { similar: state.similar },
      });
      return {
        tracks: result.tracks,
        complete: result.complete,
        notes: result.notes,
        state: result.similar === undefined ? {} : { similar: result.similar },
      };
    }
    case "combined":
      return shaped(await resolveCombined(client, source, { jobId: job.id }), job);
    case "follow":
      return shaped(await resolveFollow(client, source, { state }), job);
    case "smart":
      return shaped(
        await resolveSmart(client, source, {
          now: ctx.now,
          jobId: job.id,
          ...(ctx.favouriteDates !== undefined && { favouriteDates: ctx.favouriteDates }),
        }),
        job,
      );
    case "discovery":
      return shaped(
        await resolveDiscovery(client, source, { now: ctx.now, jobId: job.id, createdAt: job.createdAt, state }),
        job,
      );
  }
}

function shaped(result: SourceResult, job: Job): SourceResult {
  return job.shape === undefined ? result : { ...result, tracks: applyShape(result.tracks, job.shape) };
}
