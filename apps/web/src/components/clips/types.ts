import type {
  AnalysisView,
  CandidateView,
  ClipDetail,
  ClipRenderView,
  ClipSourceSummary,
  ClipSummary,
} from '@relay/services';

/** A service view as it arrives over JSON: dates are ISO strings. */
export type Wire<T> = T extends Date
  ? string
  : T extends ReadonlyArray<infer U>
    ? Array<Wire<U>>
    : T extends object
      ? { [K in keyof T]: Wire<T[K]> }
      : T;

export type WireAnalysis = Wire<AnalysisView>;
export type WireCandidate = Wire<CandidateView>;
export type WireClipDetail = Wire<ClipDetail>;
export type WireClipRender = Wire<ClipRenderView>;
export type WireClipSummary = Wire<ClipSummary>;
export type WireClipSource = Wire<ClipSourceSummary>;

export interface CandidatesResponse {
  analysis: WireAnalysis | null;
  jobId: string | null;
  jobUrl: string | null;
  candidates: WireCandidate[];
}

export interface StartAnalysisResult {
  analysis: WireAnalysis;
  jobId: string | null;
  jobUrl: string | null;
}

export interface JobResponse {
  job: { id: string; status: string; progress: number; errorCode: string | null };
  entity: {
    type: string;
    id: string;
    status?: string;
    errorCode?: string | null;
    errorDetail?: string | null;
  };
}

/** Structured-clone a server view into its JSON shape before handing it to a client component. */
export function toWire<T>(value: T): Wire<T> {
  return JSON.parse(JSON.stringify(value)) as Wire<T>;
}
