import type { Tx } from '@relay/db';
import type { IdGenerator } from '@relay/domain';

/**
 * Append-only audit events, written in the same transaction as the change they describe.
 * `data` must be minimal, sanitised facts — never tokens, signed URLs, captions of other
 * tenants or provider payloads.
 */

export type AuditActor =
  | { type: 'user'; userId: string; label: string }
  | { type: 'service'; label: string }
  | { type: 'system'; label: string };

export interface AuditInput {
  workspaceId: string;
  actor: AuditActor;
  action: string;
  entityType: string;
  entityId?: string | null;
  pageId?: string | null;
  postId?: string | null;
  data?: Record<string, unknown>;
  requestId?: string | null;
  correlationId?: string | null;
}

export async function appendAudit(tx: Tx, ids: IdGenerator, input: AuditInput): Promise<string> {
  const id = ids.next();
  await tx
    .insertInto('auditEvents')
    .values({
      id,
      workspaceId: input.workspaceId,
      actorType: input.actor.type,
      actorUserId: input.actor.type === 'user' ? input.actor.userId : null,
      actorLabel: input.actor.label.slice(0, 120),
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      pageId: input.pageId ?? null,
      postId: input.postId ?? null,
      correlationId: input.correlationId ?? null,
      requestId: input.requestId ?? null,
      data: JSON.stringify(input.data ?? {}),
    })
    .execute();
  return id;
}

export const SERVICE_ACTORS = {
  publisher: { type: 'service', label: 'Relay publisher (worker)' },
  media: { type: 'service', label: 'Relay media processor (worker)' },
  maintenance: { type: 'service', label: 'Relay maintenance (worker)' },
  metrics: { type: 'service', label: 'Relay metrics sync (worker)' },
} as const satisfies Record<string, AuditActor>;
