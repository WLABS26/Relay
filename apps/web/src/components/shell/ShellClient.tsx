'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { ChartColumn, CalendarDays, Inbox, LayoutList, LogOut, Menu, Moon, Scissors, Settings, Sun, Upload, Users, Plug, Monitor } from 'lucide-react';
import { apiFetch } from '@/lib/client/api';

const NAV = [
  { href: 'inbox', label: 'Inbox', icon: <Inbox aria-hidden /> },
  { href: 'calendar', label: 'Calendar', icon: <CalendarDays aria-hidden /> },
  { href: 'posts', label: 'Content', icon: <LayoutList aria-hidden /> },
  { href: 'results', label: 'Results', icon: <ChartColumn aria-hidden /> },
];
const ACTIONS = [
  { href: 'upload', label: 'Upload content', icon: <Upload aria-hidden /> },
  { href: 'find-clips', label: 'Find clips', icon: <Scissors aria-hidden /> },
];
const SETTINGS = [
  { href: 'settings/pages', label: 'Pages & rules', icon: <Settings aria-hidden /> },
  { href: 'settings/connections', label: 'Connections', icon: <Plug aria-hidden /> },
  { href: 'settings/members', label: 'Members', icon: <Users aria-hidden /> },
];

/** Navigation that keeps the ?page= filter, with aria-current on the active section. */
export function SidebarNav({ slug }: { slug: string }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const page = search.get('page');
  const suffix = page ? `?page=${encodeURIComponent(page)}` : '';
  const link = (item: { href: string; label: string; icon: ReactNode }) => {
    const href = `/w/${slug}/${item.href}`;
    const active = pathname === href || pathname.startsWith(`${href}/`);
    return (
      <Link key={item.href} href={`${href}${item.href.startsWith('settings') ? '' : suffix}`} aria-current={active ? 'page' : undefined}>
        {item.icon}
        {item.label}
      </Link>
    );
  };
  return (
    <nav aria-label="Workspace" className="app-nav">
      {NAV.map(link)}
      <span className="r-section-title app-nav-label">Create</span>
      {ACTIONS.map(link)}
      <span className="r-section-title app-nav-label">Settings</span>
      {SETTINGS.map(link)}
    </nav>
  );
}

export function SidebarFrame({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <aside className="app-sidebar" data-open={open ? 'true' : 'false'}>
      <button type="button" className="r-button r-button--secondary mobile-nav-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Menu aria-hidden /> Menu
      </button>
      {children}
    </aside>
  );
}

/** Page filter: a native select (keyboard accessible) that rewrites the stable ?page= param. */
export function PageSwitcher({ pages }: { pages: Array<{ id: string; name: string; pausedAt: string | null }> }) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const current = search.get('page') ?? '';
  return (
    <label className="r-row-tight r-small">
      <span className="r-visually-hidden">Page</span>
      <select
        className="r-select"
        style={{ minWidth: 200, width: 'auto' }}
        value={current}
        onChange={(e) => {
          const params = new URLSearchParams(search.toString());
          if (e.target.value) params.set('page', e.target.value);
          else params.delete('page');
          router.push(`${pathname}${params.size ? `?${params}` : ''}`);
        }}
        aria-label="Filter by page"
      >
        <option value="">All pages</option>
        {pages.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {p.pausedAt ? ' (paused)' : ''}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ThemeToggle({ current }: { current: 'light' | 'dark' | 'system' }) {
  const router = useRouter();
  const next = current === 'system' ? 'light' : current === 'light' ? 'dark' : 'system';
  const icon = current === 'light' ? <Sun aria-hidden /> : current === 'dark' ? <Moon aria-hidden /> : <Monitor aria-hidden />;
  return (
    <button
      type="button"
      className="r-button r-button--ghost r-button--icon"
      aria-label={`Theme: ${current}. Switch to ${next}`}
      title={`Theme: ${current}`}
      onClick={() => {
        document.cookie = next === 'system' ? 'relay_theme=; path=/; max-age=0; samesite=lax' : `relay_theme=${next}; path=/; max-age=31536000; samesite=lax`;
        router.refresh();
      }}
    >
      {icon}
    </button>
  );
}

export function SignOutButton() {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="r-button r-button--ghost"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await apiFetch('/api/auth/sign-out', { method: 'POST' }).catch(() => undefined);
        // A full load clears all client state and cached pages of the signed-out session.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- deliberate hard navigation
        window.location.assign('/sign-in');
      }}
    >
      <LogOut aria-hidden /> Sign out
    </button>
  );
}
