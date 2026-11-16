'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, apiFetch, errorMessage } from '@/lib/client/api';

interface SignedUrl {
  url: string;
  expiresAt: string;
}

/**
 * A short-lived signed URL for a video preview. Asks for the proxy and falls back to the
 * original for media validated before proxies existed. `refresh` mints a new URL; call it when
 * the player reports an error, which is what an expired link looks like.
 */
export function useSignedVideoUrl(workspaceId: string, assetId: string | null) {
  const [state, setState] = useState<{
    assetId: string | null;
    url: string | null;
    error: string | null;
  }>({ assetId: null, url: null, error: null });
  const [attempt, setAttempt] = useState(0);
  const refreshes = useRef(0);

  useEffect(() => {
    if (!assetId) return;
    const controller = new AbortController();
    const base = `/api/v1/workspaces/${workspaceId}/assets/${assetId}/url`;
    const load = async () => {
      try {
        let signed: SignedUrl;
        try {
          signed = await apiFetch<SignedUrl>(`${base}?variant=proxy`, {
            signal: controller.signal,
          });
        } catch (error) {
          if (!(error instanceof ApiError) || error.code !== 'not_found') throw error;
          signed = await apiFetch<SignedUrl>(`${base}?variant=original`, {
            signal: controller.signal,
          });
        }
        setState({ assetId, url: signed.url, error: null });
      } catch (error) {
        if (controller.signal.aborted) return;
        setState({ assetId, url: null, error: errorMessage(error) });
      }
    };
    void load();
    return () => controller.abort();
  }, [workspaceId, assetId, attempt]);

  /** Returns false once the link was renewed twice without the player recovering. */
  const refresh = useCallback(() => {
    if (refreshes.current >= 2) return false;
    refreshes.current += 1;
    setAttempt((n) => n + 1);
    return true;
  }, []);

  const current = state.assetId === assetId;
  return {
    url: current ? state.url : null,
    error: current ? state.error : null,
    refresh,
  };
}

export interface PlayerRange {
  startMs: number;
  endMs: number;
}

/**
 * Playback state for one `<video>`: the playhead in milliseconds (updated about 15 times a
 * second while playing), and optional confinement to a range, either looping inside it (the
 * editor) or stopping at its end (previewing a suggestion).
 */
export function usePlayer(range: PlayerRange | null, atEnd: 'loop' | 'stop') {
  const ref = useRef<HTMLVideoElement>(null);
  const [playheadMs, setPlayheadMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const rangeRef = useRef(range);
  const atEndRef = useRef(atEnd);
  useEffect(() => {
    rangeRef.current = range;
    atEndRef.current = atEnd;
  });

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    let frame = 0;
    let last = -1;
    const sync = (force = false) => {
      const ms = Math.round(video.currentTime * 1000);
      if (force || Math.abs(ms - last) >= 66) {
        last = ms;
        setPlayheadMs(ms);
      }
    };
    const tick = () => {
      const r = rangeRef.current;
      if (r && !video.paused && video.currentTime * 1000 >= r.endMs) {
        if (atEndRef.current === 'loop') video.currentTime = r.startMs / 1000;
        else video.pause();
      }
      sync();
      frame = requestAnimationFrame(tick);
    };
    const onPlay = () => {
      setPlaying(true);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(tick);
    };
    const onPause = () => {
      setPlaying(false);
      cancelAnimationFrame(frame);
      sync(true);
    };
    const onSeeked = () => sync(true);
    const onTimeUpdate = () => sync();
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('ended', onPause);
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('timeupdate', onTimeUpdate);
    return () => {
      cancelAnimationFrame(frame);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('ended', onPause);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('timeupdate', onTimeUpdate);
    };
  }, []);

  const seek = useCallback((ms: number) => {
    const video = ref.current;
    if (!video) return;
    video.currentTime = Math.max(0, ms) / 1000;
    setPlayheadMs(Math.max(0, Math.round(ms)));
  }, []);

  const pause = useCallback(() => ref.current?.pause(), []);

  /** Play; with a range, start from its beginning when the playhead is outside it. */
  const play = useCallback((from?: PlayerRange) => {
    const video = ref.current;
    if (!video) return;
    const r = from ?? rangeRef.current;
    if (from) rangeRef.current = from;
    const now = video.currentTime * 1000;
    if (r && (from || now < r.startMs || now >= r.endMs - 50)) video.currentTime = r.startMs / 1000;
    // A rejected play() (no source yet, autoplay policy) leaves the player paused.
    video.play().catch(() => undefined);
  }, []);

  return { ref, playheadMs, playing, seek, play, pause };
}
