/**
 * Error types for the Qobuz client.
 */

import { ServiceError } from "../errors.js";

/** Discriminates the kind of failure so callers can react without string matching. */
export type QobuzErrorKind =
  | "bundle-extraction"
  | "authentication"
  | "ineligible-user"
  | "api-response";

/**
 * An error originating from the Qobuz integration.
 *
 * The `kind` field lets callers (and the UI) distinguish, for example, a failed
 * token extraction from invalid credentials without parsing messages.
 */
export class QobuzError extends ServiceError {
  declare readonly kind: QobuzErrorKind;

  constructor(kind: QobuzErrorKind, message: string) {
    super("qobuz", kind, message);
    this.name = "QobuzError";
  }
}
