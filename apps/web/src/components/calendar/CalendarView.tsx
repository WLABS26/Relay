'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { CalendarClock, ChevronLeft, ChevronRight, Lock } from 'lucide-react';
import type { DestinationState } from '@relay/domain';
import { EmptyState, linkButtonClass, SampleBadge, SimulatedBadge } from '@relay/ui';
import { ScheduleDialog, type ScheduleTarget } from '@/components/posts/ScheduleDialog';
import { StateBadge } from '@/components/status/StateBadge';
import { formatDay, formatDayShort, formatTime, zoneLabel } from '@/lib/format';

interface Item {
  postDestinationId: string;
  postId: string;
  version: number;
  title: string;
  isSample: boolean;
  pageName: string;
  destinationLabel: string;
  provider: string;
  connectionMode: string;
  accountName: string;
  visibility: string;
  state: DestinationState;
  stateLabel: string;
  plannedAt: string;
  localDate: string;
  localTime: string;
  offset: string;
  locked: boolean;
  publishedAt: string | null;
  thumbnailUrl: string | null;
}

const MOVABLE: DestinationState[] = ['scheduled', 'preparing', 'blocked', 'failed'];

export function CalendarView(props: {
  slug: string;
  workspaceId: string;
  zone: string;
  days: string[];
  today: string;
  items: Item[];
  pageId: string | null;
  pageName: string;
  destinations: Array<{ id: string; label: string }>;
  destinationId: string | null;
  prevWeek: string;
  nextWeek: string;
  canSchedule: boolean;
}) {
  const router = useRouter();
  const [move, setMove] = useState<{ target: ScheduleTarget; initialLocal: string } | null>(null);
  const [dropDay, setDropDay] = useState<string | null>(null);
  const query = (week: string | null, destination?: string | null) => {
    const q = new URLSearchParams();
    if (props.pageId) q.set('page', props.pageId);
    if (week) q.set('week', week);
    const dest = destination === undefined ? props.destinationId : destination;
    if (dest) q.set('destination', dest);
    return `/w/${props.slug}/calendar${q.size ? `?${q}` : ''}`;
  };
  const byDay = (day: string) => props.items.filter((i) => i.localDate === day);
  const openMove = (item: Item, day?: string) =>
    setMove({
      initialLocal: `${day ?? item.localDate}T${item.localTime}`,
      target: {
        postDestinationId: item.postDestinationId,
        version: item.version,
        label: item.destinationLabel,
        accountName: item.accountName,
        provider: item.provider,
        connectionMode: item.connectionMode,
        visibility: item.visibility,
      },
    });
  const canMove = (item: Item) => props.canSchedule && MOVABLE.includes(item.state) && !item.locked;

  const renderItem = (item: Item, draggable: boolean) => (
    <div
      key={item.postDestinationId}
      className="cal-item"
      draggable={draggable && canMove(item)}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/relay-item', item.postDestinationId);
        e.dataTransfer.effectAllowed = 'move';
      }}
      data-testid="calendar-item"
    >
      <div className="r-spread" style={{ gap: 4 }}>
        <span className="r-strong r-tabular">{item.localTime}</span>
        {item.locked ? <Lock aria-label="Locked slot" width={14} height={14} /> : null}
      </div>
      <Link href={`/w/${props.slug}/posts/${item.postId}`} className="r-strong" style={{ overflowWrap: 'anywhere' }}>{item.title}</Link>
      <span className="r-muted">{item.destinationLabel}</span>
      <StateBadge state={item.state} label={item.stateLabel} />
      {item.connectionMode === 'simulated' || item.isSample ? (
        <span className="cal-meta">
          {item.connectionMode === 'simulated' ? <SimulatedBadge /> : null}
          {item.isSample ? <SampleBadge /> : null}
        </span>
      ) : null}
      {item.publishedAt ? <span className="r-muted r-tabular">Published {formatTime(item.publishedAt, props.zone)}</span> : null}
      {canMove(item) ? (
        <button type="button" className="r-button r-button--ghost" style={{ justifyContent: 'flex-start', paddingLeft: 4 }} onClick={() => openMove(item)} aria-label={`Move ${item.title} (${item.destinationLabel})`}>
          <CalendarClock aria-hidden /> Move
        </button>
      ) : null}
    </div>
  );

  return (
    <>
      <div className="app-page-header">
        <div>
          <h1>Calendar</h1>
          <p>{props.pageName} · {zoneLabel(props.zone)}</p>
        </div>
      </div>
      <div className="cal-toolbar">
        <div className="r-row-tight">
          <Link className={linkButtonClass('secondary')} href={query(props.prevWeek)} aria-label="Previous week"><ChevronLeft aria-hidden /></Link>
          <Link className={linkButtonClass('secondary')} href={query(null)}>This week</Link>
          <Link className={linkButtonClass('secondary')} href={query(props.nextWeek)} aria-label="Next week"><ChevronRight aria-hidden /></Link>
          <span className="r-strong r-small">{formatDayShort(props.days[0]!)} – {formatDayShort(props.days[6]!)}</span>
        </div>
        <label className="r-row-tight r-small" style={{ maxWidth: '100%' }}>
          <span>Destination</span>
          <select className="r-select" style={{ width: 'auto', minWidth: 200 }} value={props.destinationId ?? ''} onChange={(e) => router.push(query(props.days[0]!, e.target.value || null))}>
            <option value="">All destinations</option>
            {props.destinations.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select>
        </label>
      </div>
      <p className="r-xs r-muted">Drag a scheduled post to another day, or use Move. Moving always asks you to confirm the account, visibility and local time.</p>

      <ol className="cal-week" aria-label="Week view">
        {props.days.map((day) => (
          <li
            key={day}
            className="cal-day"
            aria-label={formatDay(day)}
            data-today={day === props.today ? 'true' : 'false'}
            data-drop={dropDay === day ? 'true' : 'false'}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes('text/relay-item')) {
                e.preventDefault();
                setDropDay(day);
              }
            }}
            onDragLeave={() => setDropDay(null)}
            onDrop={(e) => {
              e.preventDefault();
              setDropDay(null);
              const id = e.dataTransfer.getData('text/relay-item');
              const item = props.items.find((i) => i.postDestinationId === id);
              if (item && canMove(item) && day !== item.localDate) openMove(item, day);
            }}
          >
            <div className="cal-day-head">
              <span>{formatDayShort(day)}</span>
              {day === props.today ? <span>Today</span> : null}
            </div>
            <div className="cal-day-body">{byDay(day).map((i) => renderItem(i, true))}</div>
          </li>
        ))}
      </ol>

      <section className="cal-agenda" aria-label="Agenda">
        {props.days.map((day) => (
          <div key={day} className="r-stack-sm">
            <h2 className="r-section-title">{formatDay(day)}{day === props.today ? ' · Today' : ''}</h2>
            {byDay(day).length === 0 ? <p className="r-xs r-muted">Nothing scheduled.</p> : byDay(day).map((i) => renderItem(i, false))}
          </div>
        ))}
      </section>

      {props.items.length === 0 ? (
        <EmptyState icon={<CalendarClock aria-hidden />} title="Nothing scheduled this week" action={<Link className={linkButtonClass('secondary')} href={`/w/${props.slug}/posts${props.pageId ? `?page=${props.pageId}` : ''}`}>Go to content</Link>}>
          Approved posts can be scheduled from their page. Suggested slots appear only while scheduling and are never reserved.
        </EmptyState>
      ) : null}

      <ScheduleDialog open={move !== null} onClose={() => setMove(null)} workspaceId={props.workspaceId} zone={props.zone} target={move?.target ?? null} mode="move" initialLocal={move?.initialLocal} />
    </>
  );
}
