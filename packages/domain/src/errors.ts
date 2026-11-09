/**
 * Application error codes. Every failure that reaches a client maps to one of these codes and
 * the envelope `{code, message, fieldErrors?, retryAfterSeconds?, requestId}`. Codes are stable
 * API surface: clients branch on them, so rename only with a deprecation path.
 */
export const ERROR_STATUS = {
  // Authentication / authorization
  unauthenticated: 401,
  csrf_failed: 403,
  forbidden: 403,
  not_found: 404,
  demo_mode_disabled: 404,
  // Request shape and concurrency
  validation_failed: 422,
  payload_too_large: 413,
  unsupported_media_type: 415,
  version_conflict: 409,
  idempotency_key_reused: 422,
  invalid_transition: 409,
  rate_limited: 429,
  // Workspace / membership
  last_owner: 409,
  invitation_invalid: 404,
  already_member: 409,
  // Scheduling
  slot_conflict: 409,
  min_gap_violation: 409,
  daily_cap_reached: 409,
  weekly_cap_reached: 409,
  quiet_hours: 409,
  schedule_in_past: 422,
  lead_time_insufficient: 422,
  campaign_window_violation: 409,
  nonexistent_local_time: 422,
  ambiguous_local_time: 422,
  slot_locked: 409,
  // Approval, rights, readiness
  approval_required: 409,
  approval_stale: 409,
  approval_window_violation: 409,
  rights_missing: 409,
  media_not_ready: 409,
  destination_validation_failed: 422,
  capability_unavailable: 409,
  connection_unhealthy: 409,
  page_paused: 409,
  workspace_paused: 409,
  publish_kill_switch: 503,
  reconciliation_required: 409,
  // Uploads and quotas
  quota_exceeded: 409,
  upload_state_invalid: 409,
  upload_expired: 410,
  upload_incomplete: 409,
  upload_size_mismatch: 422,
  // Generic
  service_unavailable: 503,
  internal_error: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export interface ErrorEnvelope {
  code: ErrorCode;
  message: string;
  fieldErrors?: Record<string, string[]>;
  retryAfterSeconds?: number;
  details?: Record<string, unknown>;
  requestId: string;
}

export interface AppErrorOptions {
  fieldErrors?: Record<string, string[]>;
  retryAfterSeconds?: number;
  /** Safe, user-presentable structured details (never secrets or provider payloads). */
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly fieldErrors?: Record<string, string[]>;
  readonly retryAfterSeconds?: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    if (options.fieldErrors) this.fieldErrors = options.fieldErrors;
    if (options.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds;
    if (options.details) this.details = options.details;
  }

  toEnvelope(requestId: string): ErrorEnvelope {
    const envelope: ErrorEnvelope = { code: this.code, message: this.message, requestId };
    if (this.fieldErrors) envelope.fieldErrors = this.fieldErrors;
    if (this.retryAfterSeconds !== undefined) envelope.retryAfterSeconds = this.retryAfterSeconds;
    if (this.details) envelope.details = this.details;
    return envelope;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** Standard "does not exist or you cannot see it" error — never reveals which. */
export function notFound(what = 'Resource'): AppError {
  return new AppError('not_found', `${what} not found`);
}
