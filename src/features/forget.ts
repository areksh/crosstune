/**
 * Forgetting a service: what crosstune keeps about it goes (Spotify's terms
 * ask for it on disconnecting; it is done alike for every service). History is
 * edited here, and only here (ADR-0011): a service's entries are dropped, and an
 * entry that also changed another service keeps its label but cannot be undone.
 */

import { parseId, type ServiceName } from "../services/ids.js";
import { parseHistory, serializeRecords, type HistoryRecord, type Operation } from "./history.js";

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

/**
 * {@link forgetInHistory} over the file's text, line by line: a line that is
 * not a readable record (damaged, of another version, or with an operation
 * this version does not know) is kept exactly as it was, whatever it holds.
 */
export function forgetInHistoryText(text: string, service: ServiceName): { text: string; dropped: number } {
  const lines = text.split("\n").filter((line) => line.length > 0);
  const parsed = lines.map((line) => parseHistory(line)[0]);
  const { records, dropped } = forgetInHistory(
    parsed.filter((record): record is HistoryRecord => record !== undefined),
    service,
  );
  const kept = new Map<HistoryRecord, HistoryRecord>();
  const survivors = new Set(records.filter((record) => record.type === "undone").map((record) => record.id));
  for (const record of records) {
    if (record.type === "entry") {
      kept.set(parsed.find((one) => one?.type === "entry" && one.id === record.id)!, record);
    }
  }
  const out = lines.flatMap((line, index) => {
    const record = parsed[index];
    if (record === undefined) {
      return [line];
    }
    if (record.type === "undone") {
      return survivors.has(record.id) ? [line] : [];
    }
    const now = kept.get(record);
    if (now === undefined) {
      return [];
    }
    return [now === record ? line : serializeRecords([now]).trimEnd()];
  });
  return { text: out.map((line) => `${line}\n`).join(""), dropped };
}
