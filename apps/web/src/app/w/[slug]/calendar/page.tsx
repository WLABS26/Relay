import type { Metadata } from 'next';
import { addDays, localDate, weekStartDate, type WeekStart } from '@relay/domain';
import { getCalendar } from '@relay/services';
import { CalendarView } from '@/components/calendar/CalendarView';
import { loadWorkspace, selectedPage } from '@/lib/server/workspace';

export const metadata: Metadata = { title: 'Calendar' };

export default async function CalendarPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ page?: string; week?: string; destination?: string }> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const wc = await loadWorkspace(slug);
  const page = selectedPage(wc, sp.page);
  const zone = page?.timezone ?? wc.workspace.timezone;
  const weekStart = (page?.weekStart ?? wc.workspace.weekStart) as WeekStart;
  const anchor = sp.week && /^\d{4}-\d{2}-\d{2}$/.test(sp.week) ? sp.week : localDate(new Date(), zone);
  const from = weekStartDate(anchor, weekStart);
  const to = addDays(from, 6);
  const destinations = (page ? [page] : wc.pages).flatMap((p) => p.destinations.map((d) => ({ id: d.id, label: `${page ? '' : `${p.name} · `}${d.label}` })));
  const destinationId = destinations.some((d) => d.id === sp.destination) ? sp.destination : undefined;
  const calendar = await getCalendar(wc.ctx, wc.user, wc.workspace.id, { from, to, ...(page ? { pageId: page.id } : {}), ...(destinationId ? { destinationId } : {}) });
  const canSchedule = ['owner', 'admin', 'publisher'].includes(wc.member.role);
  return (
    <CalendarView
      slug={slug}
      workspaceId={wc.workspace.id}
      zone={calendar.zone}
      days={calendar.days}
      today={calendar.today}
      items={calendar.items}
      pageId={page?.id ?? null}
      pageName={page?.name ?? 'All pages'}
      destinations={destinations}
      destinationId={destinationId ?? null}
      prevWeek={addDays(from, -7)}
      nextWeek={addDays(from, 7)}
      canSchedule={canSchedule}
    />
  );
}
