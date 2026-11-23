/**
 * Error types for the Qobuz client.
 */

import { ServiceError } from "../errors.js";

/**
 * Discriminates the kind of failure so callers can react without string
 * matching. `network` (Qobuz could not be reached, or did not answer in time)
 * shares its name, and meaning, with the other services' (`ServiceErrorKind`
 * in ../errors.ts).
 */
export type QobuzErrorKind =
  | "bundle-extraction"
  | "authentication"
  | "ineligible-user"
  | "network"
  | "api-response";

/**
 * An error originating from the Qobuz integration.
 *
 * The `kind` field lets callers (and the UI) distinguish, for example, a failed
 * token extraction from invalid credentials without parsing messages.
 */
export class QobuzError extends ServiceError {
  declare readonly kind: QobuzErrorKind;

  constructor(kind: QobuzErrorKind, message: string, options: { cause?: unknown } = {}) {
    super("qobuz", kind, message, options);
    this.name = "QobuzError";
  }
}
