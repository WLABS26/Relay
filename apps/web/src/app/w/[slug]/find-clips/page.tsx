import type { Metadata } from 'next';
import { Scissors } from 'lucide-react';
import { Banner, Card } from '@relay/ui';

export const metadata: Metadata = { title: 'Find clips' };

export default function FindClipsPage() {
  return (
    <>
      <div className="app-page-header">
        <div>
          <h1>Find clips</h1>
          <p>Turn an authorised stream, replay or video into timestamped clip candidates.</p>
        </div>
      </div>
      <Banner tone="info" title="Not available in this build (planned for milestone M2)">
        Source resolution, rights checks, time alignment, the deterministic highlight ranker and the
        clip editor ship in M2. Nothing on this page sends requests.
      </Banner>
      <Card className="r-stack">
        <div className="r-row-tight">
          <Scissors aria-hidden width={20} height={20} />
          <h2>What M2 will add</h2>
        </div>
        <ul className="r-small r-stack-sm" style={{ margin: 0, paddingLeft: 20 }}>
          <li>
            Paste a supported YouTube or Twitch URL; Relay resolves metadata, signals and media
            access separately.
          </li>
          <li>
            A pasted URL never implies downloadable media or permission to repost: attach the
            creator’s authorised recording.
          </li>
          <li>
            Review explainable, timestamped candidates; set in/out points, reframe, edit captions
            and render.
          </li>
          <li>Hand a draft to a marketer without access to their social accounts.</li>
        </ul>
      </Card>
    </>
  );
}
