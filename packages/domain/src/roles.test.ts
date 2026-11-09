import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  ROLES,
  assignableRoles,
  can,
  isPageScoped,
  isRole,
  roleSeesAllPages,
  type Action,
  type Role,
} from './roles';

const allowed = (role: Role) => ACTIONS.filter((a) => can(role, a));

describe('role matrix', () => {
  it('is strictly nested: each role can do everything the role below it can', () => {
    const order: Role[] = ['viewer', 'editor', 'publisher', 'admin', 'owner'];
    for (let i = 1; i < order.length; i++) {
      for (const a of allowed(order[i - 1]!))
        expect(can(order[i]!, a), `${order[i]} should ${a}`).toBe(true);
    }
  });

  it('keeps viewers read-only', () => {
    const writes = allowed('viewer').filter((a) => !/\.view$/.test(a));
    expect(writes).toEqual([]);
  });

  it('lets editors create and submit but not approve, schedule or publish', () => {
    for (const a of [
      'content.create',
      'content.edit',
      'content.submit',
      'media.upload',
    ] as Action[])
      expect(can('editor', a)).toBe(true);
    for (const a of [
      'content.approve',
      'content.schedule',
      'content.cancel',
      'content.retry',
    ] as Action[])
      expect(can('editor', a)).toBe(false);
  });

  it('lets publishers pause a page as a safety action, but only admins resume it or reconcile', () => {
    expect(can('publisher', 'page.pause')).toBe(true);
    expect(can('publisher', 'page.resume')).toBe(false);
    expect(can('publisher', 'content.reconcile')).toBe(false);
    expect(can('admin', 'page.resume')).toBe(true);
    expect(can('admin', 'content.reconcile')).toBe(true);
  });

  it('reserves people, connections and automation for admins and owners', () => {
    for (const a of [
      'members.manage',
      'connections.manage',
      'automation.activate',
      'workspace.pause',
    ] as Action[]) {
      expect(ROLES.filter((r) => can(r, a))).toEqual(['owner', 'admin']);
    }
  });

  it('only lets owners appoint owners, and nobody below admin assign roles', () => {
    expect(assignableRoles('owner')).toContain('owner');
    expect(assignableRoles('admin')).not.toContain('owner');
    expect(assignableRoles('publisher')).toEqual([]);
    expect(assignableRoles('viewer')).toEqual([]);
  });

  it('scopes page-level actions and gives only owners/admins every page', () => {
    expect(isPageScoped('content.approve')).toBe(true);
    expect(isPageScoped('members.manage')).toBe(false);
    expect(ROLES.filter(roleSeesAllPages)).toEqual(['owner', 'admin']);
    expect(isRole('owner')).toBe(true);
    expect(isRole('superuser')).toBe(false);
  });
});
