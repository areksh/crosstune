/** The linked playlists' routes, under `/api/links`. Writes take the jobs lock (in the service). */

import { isServiceName, readId, type TrackId } from "../services/ids.js";
import type { LinksService } from "../sync/service.js";
import type { ApiRequest, ApiResponse } from "./router.js";

export const LINKS_PREFIX = "/api/links";

const ok = (body: unknown): ApiResponse => ({ status: 200, body });
const bad = (error: string): ApiResponse => ({ status: 400, body: { error } });

export async function linkRoutes(req: ApiRequest, service: LinksService): Promise<ApiResponse> {
  const body = typeof req.body === "object" && req.body !== null ? (req.body as Record<string, unknown>) : {};
  if (req.path === LINKS_PREFIX) {
    if (req.method === "GET") {
      return ok(service.list());
    }
    if (req.method === "POST") {
      const created = await guard(() => service.create(body));
      return "status" in created ? created : ok(created);
    }
  }
  const match = /^\/api\/links\/([0-9a-f]{8})\/([a-z-]+)$/.exec(req.path);
  if (match === null || req.method !== "POST") {
    return { status: 404, body: { error: "not found" } };
  }
  const [, id, action] = match as unknown as [string, string, string];
  try {
    switch (action) {
      case "run":
        return ok(await service.run(id));
      case "resolve": {
        const use = body["use"];
        const merge = body["merge"];
        if (isServiceName(use)) {
          return ok(await service.resolve(id, { use }, body["dryRun"] === true));
        }
        return isServiceName(merge)
          ? ok(await service.resolve(id, { merge }, body["dryRun"] === true))
          : bad("say which copy to use, or to merge into");
      }
      case "start-from-common": {
        const from = body["from"];
        return isServiceName(from) ? ok(await service.startFromCommon(id, from)) : bad("from must name a service");
      }
      case "answer": {
        const { key, answer } = body;
        return typeof key === "string" && (answer === "removed" || answer === "withdrawn" || answer === "keep")
          ? ok(await service.answer(id, key, answer))
          : bad("an answer is removed, withdrawn or keep");
      }
      case "match": {
        const track = body["track"] === null ? null : readId<TrackId>(body["track"]);
        return typeof body["key"] === "string" && track !== undefined
          ? ok(await service.chooseMatch(id, body["key"], track))
          : bad("choose a song, or none");
      }
      case "pause":
        return ok(await service.setEnabled(id, false));
      case "resume":
        return ok(await service.setEnabled(id, true));
      case "remove":
        await service.remove(id);
        return ok({ removed: id });
      default:
        return { status: 404, body: { error: "not found" } };
    }
  } catch (error) {
    if (error instanceof Error && /^No link /.test(error.message)) {
      return { status: 404, body: { error: error.message } };
    }
    throw error;
  }
}

/** A definition the user got wrong is their 400; anything else goes on. */
async function guard<T>(fn: () => Promise<T>): Promise<T | ApiResponse> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof Error && !("kind" in error)) {
      return bad(error.message);
    }
    throw error;
  }
}
