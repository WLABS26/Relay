/**
 * Role-based access control. Domain commands call `can()` for every action; the web layer
 * never decides authorization by itself. Page-scoped actions additionally require that the
 * member can access the page (owners and admins always can; other roles see either all
 * pages or an explicit page list).
 */

export const ROLES = ['owner', 'admin', 'publisher', 'editor', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const ACTIONS = [
  'workspace.view',
  'workspace.update',
  'workspace.pause',
  'members.view',
  'members.manage',
  'connections.view',
  'connections.manage',
  'pages.create',
  'page.view',
  'page.update',
  'page.rules.update',
  'page.pause',
  'page.resume',
  'media.view',
  'media.upload',
  'content.view',
  'content.create',
  'content.edit',
  'content.submit',
  'content.approve',
  'content.schedule',
  'content.cancel',
  'content.retry',
  'content.reconcile',
  'content.export',
  'results.view',
  'audit.view',
  'jobs.view',
  'automation.activate',
] as const;
export type Action = (typeof ACTIONS)[number];

const PAGE_SCOPED: ReadonlySet<Action> = new Set<Action>([
  'page.view',
  'page.update',
  'page.rules.update',
  'page.pause',
  'page.resume',
  'media.view',
  'media.upload',
  'content.view',
  'content.create',
  'content.edit',
  'content.submit',
  'content.approve',
  'content.schedule',
  'content.cancel',
  'content.retry',
  'content.reconcile',
  'content.export',
  'results.view',
]);

const VIEW: Action[] = [
  'workspace.view',
  'members.view',
  'connections.view',
  'page.view',
  'media.view',
  'content.view',
  'results.view',
  'jobs.view',
];
const EDIT: Action[] = [
  ...VIEW,
  'media.upload',
  'content.create',
  'content.edit',
  'content.submit',
  'content.export',
];
const PUBLISH: Action[] = [
  ...EDIT,
  'content.approve',
  'content.schedule',
  'content.cancel',
  'content.retry',
  'page.pause',
  'audit.view',
];
const ADMIN: Action[] = [
  ...PUBLISH,
  'workspace.update',
  'workspace.pause',
  'members.manage',
  'connections.manage',
  'pages.create',
  'page.update',
  'page.rules.update',
  'page.resume',
  'content.reconcile',
  'automation.activate',
];

const MATRIX: Record<Role, ReadonlySet<Action>> = {
  owner: new Set(ADMIN),
  admin: new Set(ADMIN),
  publisher: new Set(PUBLISH),
  editor: new Set(EDIT),
  viewer: new Set(VIEW),
};

export function can(role: Role, action: Action): boolean {
  return MATRIX[role].has(action);
}

export function isPageScoped(action: Action): boolean {
  return PAGE_SCOPED.has(action);
}

/** Owners and admins see every page regardless of explicit page grants. */
export function roleSeesAllPages(role: Role): boolean {
  return role === 'owner' || role === 'admin';
}

/** Which roles an actor may assign. Only owners may create or demote owners. */
export function assignableRoles(actorRole: Role): Role[] {
  if (actorRole === 'owner') return [...ROLES];
  if (actorRole === 'admin') return ['admin', 'publisher', 'editor', 'viewer'];
  return [];
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  publisher: 'Publisher',
  editor: 'Editor',
  viewer: 'Viewer',
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  owner: 'Full control, including appointing and removing other owners.',
  admin: 'Manages people, connections, pages, publishing rules and auto-publish activation.',
  publisher: 'Approves, schedules and publishes on assigned pages.',
  editor: 'Creates and edits content and submits it for approval.',
  viewer: 'Read-only access to assigned pages.',
};
