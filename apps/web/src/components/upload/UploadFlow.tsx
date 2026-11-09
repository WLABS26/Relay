'use client';

import { useRouter } from 'next/navigation';
import { useId, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, FileVideo, Image as ImageIcon, Trash2, Upload } from 'lucide-react';
import { ALLOWED_UPLOAD_TYPES, PROVIDER_LABELS, type DestinationProviderId } from '@relay/domain';
import {
  Banner,
  Badge,
  Button,
  Card,
  describedBy,
  Field,
  ProgressBar,
  SimulatedBadge,
} from '@relay/ui';
import { apiFetch, errorMessage, newIdempotencyKey, poll } from '@/lib/client/api';
import { uploadFile } from '@/lib/client/upload';
import { formatBytes, formatDuration } from '@/lib/format';

interface PageOption {
  id: string;
  name: string;
  allowedFormats: string[];
  destinations: Array<{
    id: string;
    label: string;
    provider: string;
    connectionMode: string;
    accountStatus: string;
  }>;
}

type ItemStatus = 'queued' | 'uploading' | 'validating' | 'ready' | 'rejected' | 'error';

interface Item {
  key: string;
  file: File;
  status: ItemStatus;
  loaded: number;
  assetId?: string;
  message?: string;
  meta?: { width: number | null; height: number | null; durationMs: number | null };
}

const REJECTION_HELP: Record<string, string> = {
  malformed_media: 'The file could not be read as valid media. Export it again and retry.',
  encrypted_media: 'Encrypted or DRM-protected files cannot be processed.',
  mime_mismatch: 'The file content does not match its type. Check the file extension.',
  unsupported_codec: 'This codec is not supported. Export as H.264/AAC MP4.',
  too_long: 'The video is longer than the allowed maximum.',
  dimensions_too_large: 'The video or image dimensions are too large.',
  size_mismatch: 'The uploaded size did not match. Try uploading again.',
  checksum_mismatch: 'The file changed during upload. Try again.',
};

export function UploadFlow({
  slug,
  workspaceId,
  pages,
  defaultPageId,
  statement,
  limits,
}: {
  slug: string;
  workspaceId: string;
  pages: PageOption[];
  defaultPageId: string;
  statement: { version: string; text: string };
  limits: { maxVideoBytes: number; maxImageBytes: number; maxCarouselItems: number };
}) {
  const router = useRouter();
  const ids = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pageId, setPageId] = useState(defaultPageId || pages[0]?.id || '');
  const [items, setItems] = useState<Item[]>([]);
  const [declared, setDeclared] = useState(false);
  const [commercial, setCommercial] = useState(true);
  const [dragActive, setDragActive] = useState(false);
  const [phase, setPhase] = useState<'select' | 'uploading' | 'compose'>('select');
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [caption, setCaption] = useState('');
  const [destinations, setDestinations] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const page = pages.find((p) => p.id === pageId);

  const update = (key: string, patch: Partial<Item>) =>
    setItems((list) => list.map((i) => (i.key === key ? { ...i, ...patch } : i)));

  function addFiles(files: FileList | File[]) {
    setError(null);
    const next: Item[] = [];
    for (const file of Array.from(files)) {
      const type = ALLOWED_UPLOAD_TYPES[file.type];
      if (!type) {
        setError(
          `${file.name}: ${file.type || 'unknown type'} is not supported. Use MP4, MOV or WebM video, or JPEG, PNG or WebP images.`,
        );
        continue;
      }
      const max = type.kind === 'video' ? limits.maxVideoBytes : limits.maxImageBytes;
      if (file.size > max) {
        setError(`${file.name} is ${formatBytes(file.size)}; the limit is ${formatBytes(max)}.`);
        continue;
      }
      next.push({
        key: `${file.name}-${file.size}-${file.lastModified}-${Math.random()}`,
        file,
        status: 'queued',
        loaded: 0,
      });
    }
    setItems((list) => [...list, ...next].slice(0, limits.maxCarouselItems));
  }

  function move(index: number, delta: number) {
    setItems((list) => {
      const copy = [...list];
      const [moved] = copy.splice(index, 1);
      copy.splice(Math.max(0, Math.min(copy.length, index + delta)), 0, moved!);
      return copy;
    });
  }

  async function startUploads() {
    if (!page || !declared || items.length === 0) return;
    setPhase('uploading');
    setError(null);
    await Promise.all(
      items.map(async (item) => {
        if (item.status === 'ready') return;
        update(item.key, { status: 'uploading', loaded: 0, message: undefined });
        try {
          const { assetId } = await uploadFile({
            workspaceId,
            pageId: page.id,
            file: item.file,
            declaration: {
              confirmed: true,
              statementVersion: statement.version,
              commercialUse: commercial,
            },
            onProgress: (p) => update(item.key, { loaded: p.loaded }),
          });
          update(item.key, { status: 'validating', assetId });
          const result = await poll(
            () =>
              apiFetch<{
                asset: {
                  status: string;
                  rejectionCode: string | null;
                  rejectionDetail: string | null;
                  width: number | null;
                  height: number | null;
                  durationMs: number | null;
                };
              }>(`/api/v1/workspaces/${workspaceId}/assets/${assetId}`),
            (r) => r.asset.status === 'ready' || r.asset.status === 'rejected',
            { timeoutMs: 10 * 60_000 },
          );
          if (result.asset.status === 'ready') {
            update(item.key, {
              status: 'ready',
              meta: {
                width: result.asset.width,
                height: result.asset.height,
                durationMs: result.asset.durationMs,
              },
            });
          } else if (result.asset.status === 'rejected') {
            update(item.key, {
              status: 'rejected',
              message:
                REJECTION_HELP[result.asset.rejectionCode ?? ''] ??
                result.asset.rejectionDetail ??
                'The file was rejected.',
            });
          } else {
            update(item.key, {
              status: 'validating',
              message: 'Still validating — it will appear in the media library when ready.',
            });
          }
        } catch (e) {
          update(item.key, { status: 'error', message: errorMessage(e) });
        }
      }),
    );
    setPhase('compose');
    setDestinations(page.destinations.filter((d) => d.accountStatus === 'active').map((d) => d.id));
  }

  const ready = items.filter((i) => i.status === 'ready');
  const format =
    ready.length > 1 ? 'carousel' : ready[0]?.file.type.startsWith('video') ? 'video' : 'image';
  const formatAllowed = page ? page.allowedFormats.includes(format) : false;

  async function createDraft() {
    if (!page) return;
    setCreating(true);
    setError(null);
    try {
      const created = await apiFetch<{ postId: string }>(
        `/api/v1/workspaces/${workspaceId}/posts`,
        {
          body: {
            pageId: page.id,
            title: title.trim() || null,
            caption,
            mediaAssetIds: ready.map((i) => i.assetId!),
            destinationIds: destinations,
          },
          idempotencyKey: newIdempotencyKey('post'),
        },
      );
      router.push(`/w/${slug}/posts/${created.postId}`);
    } catch (e) {
      setError(errorMessage(e));
      setCreating(false);
    }
  }

  return (
    <div className="r-stack-lg">
      <Card className="r-stack">
        <h2>1. Where is this for?</h2>
        <Field id={`${ids}-page`} label="Page">
          <select
            id={`${ids}-page`}
            className="r-select"
            value={pageId}
            onChange={(e) => setPageId(e.target.value)}
            disabled={phase !== 'select'}
          >
            {pages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
      </Card>

      <Card className="r-stack">
        <h2>2. Choose files</h2>
        <div
          className="drop-zone"
          data-active={dragActive ? 'true' : 'false'}
          onDragOver={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragActive(false);
            if (phase === 'select') addFiles(e.dataTransfer.files);
          }}
        >
          <Upload aria-hidden width={28} height={28} />
          <p className="r-small">Drag files here, or</p>
          <Button onClick={() => inputRef.current?.click()} disabled={phase !== 'select'}>
            Choose files
          </Button>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={Object.keys(ALLOWED_UPLOAD_TYPES).join(',')}
            className="r-visually-hidden"
            aria-label="Choose files to upload"
            data-testid="file-input"
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <p className="r-xs r-muted">
            Video: MP4, MOV, WebM up to {formatBytes(limits.maxVideoBytes)}. Images: JPEG, PNG, WebP
            up to {formatBytes(limits.maxImageBytes)}. Several images make a carousel (up to{' '}
            {limits.maxCarouselItems}).
          </p>
        </div>
        {items.length > 0 ? (
          <ol
            className="r-stack-sm"
            style={{ listStyle: 'none', margin: 0, padding: 0 }}
            aria-label="Selected files (in carousel order)"
          >
            {items.map((item, index) => (
              <li
                key={item.key}
                className="r-card r-card--flat r-stack-sm"
                style={{ padding: 'var(--space-3)' }}
              >
                <div className="r-spread">
                  <div className="r-row-tight" style={{ minWidth: 0 }}>
                    {item.file.type.startsWith('video') ? (
                      <FileVideo aria-hidden width={20} height={20} />
                    ) : (
                      <ImageIcon aria-hidden width={20} height={20} />
                    )}
                    <span className="r-strong r-truncate">{item.file.name}</span>
                    <span className="r-xs r-muted r-nowrap">{formatBytes(item.file.size)}</span>
                  </div>
                  <div className="r-row-tight">
                    <ItemStatusBadge status={item.status} />
                    {phase === 'select' ? (
                      <>
                        <Button
                          variant="ghost"
                          aria-label={`Move ${item.file.name} earlier`}
                          icon={<ArrowUp aria-hidden />}
                          disabled={index === 0}
                          onClick={() => move(index, -1)}
                        />
                        <Button
                          variant="ghost"
                          aria-label={`Move ${item.file.name} later`}
                          icon={<ArrowDown aria-hidden />}
                          disabled={index === items.length - 1}
                          onClick={() => move(index, 1)}
                        />
                        <Button
                          variant="ghost"
                          aria-label={`Remove ${item.file.name}`}
                          icon={<Trash2 aria-hidden />}
                          onClick={() => setItems((l) => l.filter((i) => i.key !== item.key))}
                        />
                      </>
                    ) : null}
                  </div>
                </div>
                {item.status === 'uploading' ? (
                  <ProgressBar
                    value={(item.loaded / item.file.size) * 100}
                    label={`Uploading ${item.file.name}`}
                  />
                ) : null}
                {item.meta ? (
                  <span className="r-xs r-muted r-tabular">
                    {item.meta.width}×{item.meta.height}
                    {item.meta.durationMs ? ` · ${formatDuration(item.meta.durationMs)}` : ''}
                  </span>
                ) : null}
                {item.message ? (
                  <span
                    className={
                      item.status === 'rejected' || item.status === 'error'
                        ? 'r-error-text'
                        : 'r-hint'
                    }
                  >
                    {item.message}
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        ) : null}
      </Card>

      {phase === 'select' ? (
        <Card className="r-stack">
          <h2>3. Confirm you may use this media</h2>
          <label className="r-check">
            <input
              type="checkbox"
              checked={declared}
              onChange={(e) => setDeclared(e.target.checked)}
              aria-describedby={`${ids}-statement`}
            />
            <span className="r-small" id={`${ids}-statement`}>
              {statement.text}
            </span>
          </label>
          <label className="r-check">
            <input
              type="checkbox"
              checked={commercial}
              onChange={(e) => setCommercial(e.target.checked)}
            />
            <span className="r-small">
              Commercial use is permitted (for example sponsored or monetised posts).
            </span>
          </label>
          <p className="r-xs r-muted">
            Recorded as an ownership declaration ({statement.version}) with your name and the time.
            A connected account or a public URL is never treated as a licence.
          </p>
          {error ? (
            <Banner tone="danger" live>
              {error}
            </Banner>
          ) : null}
          <div>
            <Button
              variant="primary"
              icon={<Upload aria-hidden />}
              disabled={!declared || items.length === 0 || !page}
              onClick={startUploads}
            >
              Upload{' '}
              {items.length > 0 ? `${items.length} file${items.length === 1 ? '' : 's'}` : ''}
            </Button>
          </div>
        </Card>
      ) : null}

      {phase === 'compose' ? (
        <Card className="r-stack">
          <h2>4. Create the draft</h2>
          {ready.length === 0 ? (
            <Banner tone="danger" title="No file is ready">
              Fix the problems above and upload again.
            </Banner>
          ) : (
            <>
              {!formatAllowed ? (
                <Banner tone="warning" title={`This page does not allow ${format} posts`}>
                  Change the page’s allowed formats, or choose different media.
                </Banner>
              ) : null}
              <Field
                id={`${ids}-title`}
                label="Title"
                hint="Required by some destinations (for example video platforms)."
              >
                <input
                  id={`${ids}-title`}
                  className="r-input"
                  value={title}
                  maxLength={200}
                  onChange={(e) => setTitle(e.target.value)}
                  aria-describedby={describedBy(`${ids}-title`, { hint: true })}
                />
              </Field>
              <Field
                id={`${ids}-caption`}
                label="Caption"
                hint="You can tailor the caption per destination on the next screen."
              >
                <textarea
                  id={`${ids}-caption`}
                  className="r-textarea"
                  value={caption}
                  maxLength={5000}
                  onChange={(e) => setCaption(e.target.value)}
                  aria-describedby={describedBy(`${ids}-caption`, { hint: true })}
                />
              </Field>
              <fieldset className="r-fieldset r-stack-sm">
                <legend>Destinations</legend>
                {page && page.destinations.length === 0 ? (
                  <p className="r-small r-muted">
                    This page has no destinations yet. Add one under Pages &amp; rules.
                  </p>
                ) : null}
                {page?.destinations.map((d) => (
                  <label key={d.id} className="r-check">
                    <input
                      type="checkbox"
                      checked={destinations.includes(d.id)}
                      disabled={d.accountStatus !== 'active'}
                      onChange={(e) =>
                        setDestinations((list) =>
                          e.target.checked ? [...list, d.id] : list.filter((x) => x !== d.id),
                        )
                      }
                    />
                    <span className="r-row-tight r-small">
                      <span>{d.label}</span>
                      <Badge>
                        {PROVIDER_LABELS[d.provider as DestinationProviderId] ?? d.provider}
                      </Badge>
                      {d.connectionMode === 'simulated' ? <SimulatedBadge /> : null}
                      {d.accountStatus !== 'active' ? (
                        <Badge tone="warning">Needs reconnecting</Badge>
                      ) : null}
                    </span>
                  </label>
                ))}
              </fieldset>
              {error ? (
                <Banner tone="danger" live>
                  {error}
                </Banner>
              ) : null}
              <div>
                <Button
                  variant="primary"
                  busy={creating}
                  disabled={destinations.length === 0 || !formatAllowed}
                  onClick={createDraft}
                >
                  Create draft
                </Button>
              </div>
            </>
          )}
        </Card>
      ) : null}
    </div>
  );
}

function ItemStatusBadge({ status }: { status: ItemStatus }) {
  switch (status) {
    case 'queued':
      return <Badge>Selected</Badge>;
    case 'uploading':
      return <Badge tone="info">Uploading</Badge>;
    case 'validating':
      return <Badge tone="info">Validating</Badge>;
    case 'ready':
      return <Badge tone="success">Ready</Badge>;
    case 'rejected':
      return <Badge tone="danger">Rejected</Badge>;
    case 'error':
      return <Badge tone="danger">Upload failed</Badge>;
  }
}
