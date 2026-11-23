/** Errors a music service raises, whichever service it is. */

import { SERVICE_LABELS, type ServiceName } from "./names.js";

/**
 * What went wrong, where the caller can act on it: `authentication` -- sign in
 * again; `unsupported` -- the service cannot do this; `rate-limited` and
 * `quota` -- wait. Services add kinds of their own.
 */
export type ServiceErrorKind =
  | "authentication"
  | "network"
  | "api-response"
  | "not-found"
  | "unsupported"
  | "rate-limited"
  | "quota"
  | "not-connected"
  | "bad-id";

export class ServiceError extends Error {
  /** The service concerned; absent when the id named none. */
  readonly service: ServiceName | undefined;
  readonly kind: string;
  /** How long the service asked us to wait, when it said. */
  readonly retryAfterSeconds?: number;

  constructor(
    service: ServiceName | undefined,
    kind: ServiceErrorKind | (string & {}),
    message: string,
    options: { cause?: unknown; retryAfterSeconds?: number } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ServiceError";
    this.service = service;
    this.kind = kind;
    if (options.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = options.retryAfterSeconds;
    }
  }
}

/** The service's name as shown to the user. */
export function labelOf(service: ServiceName): string {
  return SERVICE_LABELS[service];
}

/** True for a service's "no such thing" (Qobuz's is an HTTP 404). */
export function isNotFound(error: unknown): boolean {
  return (
    error instanceof ServiceError &&
    (error.kind === "not-found" || (error.kind === "api-response" && /HTTP 404/.test(error.message)))
  );
}
