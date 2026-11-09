# Testing guide

A step-by-step walk through Relay as it stands after milestones M0 and M1. Everything you
publish here goes to Relay's **provider simulator**, never to a real platform; the UI says so
wherever simulated data appears. Allow about 30 minutes for the guided tour.

## 1. Choose where to run it

| Option                   | Good for                                           | Needs on your machine                                      |
| ------------------------ | -------------------------------------------------- | ---------------------------------------------------------- |
| **A. GitHub Codespaces** | Trying it in a browser without installing anything | A GitHub account (Codespaces has a free monthly allowance) |
| **B. Local machine**     | Day-to-day development                             | Docker Desktop, Node 22, pnpm 10, FFmpeg 6                 |

### A. GitHub Codespaces

1. On the repository page, choose **Code → Codespaces → Create codespace on main**.
2. Wait for the set-up to finish (5–10 minutes the first time). The terminal shows the
   quick-start commands running: install, migrations, synthetic media, demo data, browser.
   The web app and the worker start automatically afterwards.
3. Open the **Ports** panel (bottom of VS Code). Port **3000 "Relay web"** is the app: click
   its globe icon to open it in a new tab.
4. In the same panel, right-click port **7070 "Media storage"** → **Port Visibility → Public**.
   Your browser uploads files to, and loads previews from, this port directly; it stays a
   private bucket (only short-lived signed URLs work), but the port must be reachable.
5. To restart the app later: in a codespace terminal, `bash .devcontainer/start.sh`.
   Logs: `/tmp/relay-web.log`, `/tmp/relay-worker.log`.

> Verified with the dev container CLI: the container builds, set-up runs unattended, the unit
> and integration suites pass inside it, and the app and worker start. The Codespaces
> browser-forwarding specifics (steps 3–4) follow GitHub's documented behaviour but could not
> be exercised from the build environment. If the app opens but uploads or previews fail,
> check that port 7070 is Public, then run the automated suites inside the codespace
> (section 4), which do not depend on forwarding.

### B. Local machine

Prerequisites: Docker Desktop (or Docker Engine with Compose v2), Node 22.18 or newer
(`.nvmrc` pins 22.23.4), pnpm 10 (`corepack enable`), FFmpeg 6 on your `PATH`. Then, from the
repository root, one command at a time:

```bash
pnpm install
```

```bash
cp .env.example .env
```

```bash
pnpm infra:up
```

```bash
pnpm db:migrate
```

```bash
pnpm fixtures:generate
```

```bash
pnpm db:seed
```

Two terminals, left running:

```bash
pnpm dev
```

```bash
pnpm worker:dev
```

Open <http://localhost:3000>.

## 2. Demo accounts

Sign-in shows **Choose a demo account**; click a name (no password; demo mode only).

| Person         | Workspace       | Role                            | Use them to…                  |
| -------------- | --------------- | ------------------------------- | ----------------------------- |
| Mara Lindqvist | Fernhill Studio | Owner                           | do everything below           |
| Theo Brandt    | Fernhill Studio | Admin                           | manage people and connections |
| Priya Raman    | Fernhill Studio | Publisher, Fernhill Coffee only | see page scoping              |
| Eli Novak      | Fernhill Studio | Editor                          | create but not approve        |
| Vic Osei       | Fernhill Studio | Viewer                          | see read-only                 |
| Gus Ferreira   | Kestrel Media   | Owner                           | see tenant isolation          |
| Kim Sato       | Kestrel Media   | Editor                          | accept an invitation          |

Fernhill has three pages: **Fernhill Coffee**, **Fernhill Trail Club** and **Simulator lab**
(seeded with the awkward cases: one post whose three destinations end rejected, outcome
unknown, and published after a lost response).

## 3. Guided tour

Sign in as **Mara Lindqvist**. The left navigation is Inbox, Calendar, Content, Results,
Upload content, Find clips (M2, placeholder), Pages & rules, Connections, Members.

### 3.1 Publish an upload end to end (the M1 gate)

1. **Upload content** → **Page**: Fernhill Coffee → **Choose files** → pick a video or image.
   Any MP4 (H.264/HEVC) or JPEG/PNG/WebP works; generated samples are in `fixtures/media/`
   (`vertical-1080x1920-8s.mp4` is a good first one). In Codespaces, download a sample first
   via the file explorer (right-click → Download), or use a file from your computer.
2. Tick the declaration **I own this media…** (required: a connection is never a licence).
3. **Upload 1 file**. The browser sends the bytes straight to object storage; the worker
   validates them with FFmpeg. Within about 10 seconds the file shows **Ready** with its
   normalised details (for the sample: `1080×1920 · 8 s`).
4. Fill in **Title** and **Caption**, leave **YouTube** and **Instagram** ticked under
   **Destinations**, untick the others → **Create draft**. You land on the post page: one card
   per destination (for example **YouTube · Fernhill Coffee**), each with its own state badge.
5. **Submit for review** → both cards show **Needs review**. Then **Approve all** (or
   **Approve this version** on one card) → **Approved**. An approval binds to exactly this
   content for exactly that destination.
6. On the YouTube card, **Schedule**. The **Schedule post** dialog offers **A suggested slot**
   (labelled _Suggested_ with the reasons; never reserved until you schedule), **A specific
   time**, or **As soon as possible**. The summary says _You are about to publish to_, names
   the account and the visibility, and shows the time zone (Europe/Berlin).
7. Choose **As soon as possible** → **Publish as soon as possible**.
8. Watch the card: _Preparing_ → _Publishing_ → **Published**, within about a minute. It shows
   the simulated post ID (`sim_youtube_…`) and _simulated — not a real post_. The **Lineage**
   list underneath records every step (claimed, dispatched, confirmed by platform). The
   Instagram card stays **Approved**: destinations never drag each other along.
9. **Calendar** shows the post as Published; **Results** lists it under a **Simulated data**
   banner with metrics marked by availability (nothing is ever shown as "0" when it is
   really "not reported yet").

### 3.2 Scheduling, time zones and collisions

1. Open any **Approved** post (Content → filter by state) → **Schedule** → **A specific time**.
2. Date **2027-03-28**, time **02:30** → _That time does not exist (clocks go forward)_ with a
   one-click **Use 03:30 instead**.
3. Date **2027-10-31**, time **02:30** → _This time happens twice (clocks go back)_: you must
   pick the first or second occurrence; Relay never guesses.
4. Schedule two posts on the same account at the same minute: the second is refused
   (_Another post is already scheduled on this account at exactly that time_). Within two
   hours of each other: refused by the minimum-gap rule (2 h by default for this page).
5. **Calendar** → **Move** on a scheduled item → pick another time. Tick _Lock this slot…_ on
   one post, then try to move it: locked slots refuse to move.

### 3.3 Pause and resume

1. **Pages & rules** → Fernhill Coffee → **Publishing rules** → **Pause page**. Scheduled posts
   are held; anything already in flight finishes and is reported.
2. **Resume** → held posts continue (ones whose time passed go back to review instead of
   publishing late).

### 3.4 Mixed outcomes and the unknown case

1. **Inbox** lists what needs a person. Open the **Simulator lab** post (_Sample · Mixed outcomes demo_): one destination
   **Rejected by platform**, one **Outcome unknown**, and one **Published** after the platform's
   reply was lost and reconciliation proved the post exists.
2. On the _Outcome unknown_ destination, **Resolve outcome** → _Resolve unknown outcome_:
   say what you found on the platform (**Platform post ID** to link it, or close it as not
   published) and a **Reason**, which lands in the audit trail. Relay never re-sends a post it
   cannot prove was not sent.
3. Edit an approved post's caption: only the affected destinations lose their approval and
   show **Request re-approval**.

### 3.5 People, roles and tenant isolation (the M0 gate)

1. **Members** → invite `kim@kestrel.example` as Viewer → **Create invitation**. Relay shows the
   one-time link (e-mail delivery is not part of this build). **Sign out**, sign in as
   **Kim Sato**, open the link → **Accept invitation** → Kim is now in two workspaces.
2. Sign in as **Gus Ferreira** (Kestrel) and type `/w/fernhill/inbox` in the address bar:
   **404**. Relay never reveals whether another tenant's thing exists.
3. Sign in as **Vic Osei** (Viewer) → **Upload content**: _You cannot upload here_, and
   everything else is read-only.
4. Sign in as **Priya Raman** (Publisher on Fernhill Coffee only): Fernhill Trail Club content
   does not exist for her.

### 3.6 Connections

**Connections** lists simulated accounts with their simulator profile (reliable, slow
processing, rate limited once, lost response, ambiguous, rejects format). **Connect an
account** adds another simulated one. There is no way to connect a real account yet (M3+).

## 4. Automated checks

From the repository root (or a codespace terminal):

| Command                          | What it proves                                                                                                                            | Expected   |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `pnpm test`                      | Pure logic: DST, slot rules, state machine, capability gates, media rules, crypto, CSRF                                                   | 203 passed |
| `pnpm test:integration`          | Tenant isolation, least privilege, uploads with hostile files, scheduling, reliability, memberships, against real Postgres, S3 and FFmpeg | 54 passed  |
| `pnpm test:e2e`                  | The browser flow above, security headers, CSRF, fail-closed start-up, accessibility, mobile                                               | 16 passed  |
| `pnpm lint` and `pnpm typecheck` | Code quality and source hygiene                                                                                                           | clean      |

The same checks run on every push in GitHub Actions (`.github/workflows/ci.yml`), together
with a build of both container images and a check that they refuse a production
configuration containing demo mode (exit code 78).

## 5. What is intentionally not there yet

- Real platform connections (YouTube, Instagram, Facebook Pages, TikTok): milestones M3–M5.
- Production start-up: refused until the KMS key provider ships (M3). `RELAY_ENV=staging` runs.
- Source clips (Find clips), the URL resolver and rights management commands: M2.
- Invitation e-mails (links are shown to copy), and automatic clean-up of expired sessions.

## 6. If something does not work

| Symptom                                            | Likely cause                                  | Fix                                                                                        |
| -------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `pnpm infra:up` fails                              | Docker not running, or ports 5432/7070 in use | Start Docker; or set `RELAY_PG_PORT`/`RELAY_S3_PORT` and update `.env`                     |
| Upload stays _Validating_                          | Worker not running                            | Start `pnpm worker:dev`; check its log                                                     |
| Upload or preview fails in Codespaces              | Port 7070 not Public                          | Ports panel → 7070 → Port Visibility → Public                                              |
| _Could not prepare the test database_              | Infra not running                             | `pnpm infra:up`                                                                            |
| `pnpm db:reset` says the database is in use        | Web or worker still connected                 | Stop them, retry                                                                           |
| No demo accounts on the sign-in page               | Database not seeded                           | `pnpm db:seed`                                                                             |
| Dev container build fails with a certificate error | Your network intercepts TLS                   | Save your proxy's CA certificate as `.devcontainer/extra-ca.crt` (git-ignored) and rebuild |
