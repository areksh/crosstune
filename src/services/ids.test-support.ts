/** Test support (not shipped): a Qobuz id of whatever kind is wanted. */

import { tagId } from "./ids.js";

export function qid(native: number | string): never {
  return tagId<never>("qobuz", native);
}
