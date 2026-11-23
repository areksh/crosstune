/**
 * Forgetting a service: what qobuz-helper keeps about it goes (Spotify's terms
 * ask for it on disconnecting; it is done alike for every service). History is
 * edited here, and only here (ADR-0011): a service's entries are dropped, and an
 * entry that also changed another service keeps its label but cannot be undone.
 */

import { parseId, type ServiceName } from "../services/ids.js";
import type { HistoryRecord, Operation } from "./history.js";

function idsOf(op: Operation): string[] {
  switch (op.kind) {
    case "add-favourites":
    case "remove-favourites":
      return op.ids;
    default:
      return [op.playlistId];
  }
}

function touches(op: Operation, service: ServiceName): boolean {
  return idsOf(op).some((id) => parseId(id)?.service === service);
}

export function forgetInHistory(
  records: readonly HistoryRecord[],
  service: ServiceName,
): { records: HistoryRecord[]; dropped: number } {
  const dropped = new Set<string>();
  const kept: HistoryRecord[] = [];
  for (const record of records) {
    if (record.type !== "entry") {
      kept.push(record);
      continue;
    }
    const mine = record.ops.filter((op) => touches(op, service));
    if (mine.length === 0) {
      kept.push(record);
    } else if (mine.length === record.ops.length) {
      dropped.add(record.id);
    } else {
      kept.push({ ...record, ops: [], forgotten: service });
    }
  }
  return {
    records: kept.filter((record) => record.type === "entry" || !dropped.has(record.id)),
    dropped: dropped.size,
  };
}
