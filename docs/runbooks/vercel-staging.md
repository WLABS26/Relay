# Hosted staging: web on Vercel, services elsewhere

How to run Relay on the internet for testing. Relay is four parts, and only one of them can
live on Vercel:

| Part                                                                     | Can it run on Vercel?                                   | Where it goes instead                                                                                                   |
| ------------------------------------------------------------------------ | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Web app** (Next.js)                                                    | Yes                                                     | Vercel project, root directory `apps/web`                                                                               |
| **Worker** (Graphile Worker + FFmpeg; long-running, listens to Postgres) | No: Vercel functions are short-lived and have no FFmpeg | Any container host: Railway, Render, Fly.io, Cloud Run (min 1 instance), a VPS. Image: `infra/docker/worker.Dockerfile` |
| **PostgreSQL 16**                                                        | Not on Vercel itself                                    | Neon (also offered in Vercel's Marketplace), Supabase, RDS, Cloud SQL                                                   |
| **Object storage** (S3 API with versioning)                              | Not Vercel Blob (different API, no versioning)          | AWS S3, or another store with the S3 API _and_ object versioning (Backblaze B2, MinIO)                                  |

Without the worker, uploads never finish validating and nothing publishes, so all four are
needed for a meaningful test. Everything stays **simulated**: no real platform is contacted.

This is a **staging** deployment. Production mode is intentionally refused by this build until
the KMS key provider ships (M3); staging runs with a local encryption keyring and demo sign-in.

## Quick path (no prior experience assumed)

Six things, in this order. Each one is a few clicks or one pasted command.

1. **Vercel project.** Vercel → Add New → Project → Import `WLABS26/Relay`. Before the first
   deploy, open the project's **Settings → General**: _Root Directory_ `apps/web`, _Framework
   Preset_ Next.js, _Node.js Version_ **22.x**. (The repository also declares Node 22 in
   `apps/web/package.json`, which is why a build on Node 26 was refused.) Deploy: the build
   should finish green. The site will answer, but sign-in cannot work until step 5.
2. **Database.** Create a free Neon project (neon.tech) → open its SQL Editor → paste
   `infra/postgres/managed-roles.sql` with three passwords you generated (a password manager's
   generator is fine) → run it. From Neon's _Connection details_ copy two URLs: the **direct**
   one and the **pooled** one. Build three connection strings by putting each role's name and
   password into them:
   - `DATABASE_URL_MIGRATOR` = `relay_migrator` on the **direct** URL
   - `DATABASE_URL_APP` = `relay_app` on the **pooled** URL
   - `DATABASE_URL_WORKER` = `relay_worker` on the **direct** URL
3. **Tables.** GitHub → the repository → Settings → Environments → New environment `staging` →
   Add environment secret `DATABASE_URL_MIGRATOR` (the migrator string). Then Actions →
   _Migrate database_ → Run workflow → environment `staging` → Run. Green = tables created.
4. **File storage.** AWS → S3 → Create bucket (private; _Bucket Versioning: Enable_). In the
   bucket's _Permissions → CORS_, paste the JSON from section 2 with your Vercel URL. IAM →
   create a user with access to that bucket only → create an access key. Note the bucket name,
   region, access key and secret.
5. **Variables.** Vercel → project → Settings → Environment Variables → add every row of the
   table in section 3 (web column) → Deployments → Redeploy. Then open
   `https://<your-app>.vercel.app/api/ready`: it must say `"database":"ok"` and `"storage":"ok"`.
6. **Worker and demo data.** The worker cannot run on Vercel. On Railway or Render, create a
   service from the GitHub repository with Dockerfile `infra/docker/worker.Dockerfile` (build
   context: repository root), add the same variables (worker column) plus
   `RELAY_WORKER_HEALTH_HOST=0.0.0.0`, and set its health check to port 3101 path `/healthz`.
   Finally seed the demo accounts once, from a laptop with Node 22 and the same variables in a
   local `.env`: `pnpm install` then `pnpm db:seed`. Sign in at your Vercel URL and follow
   `docs/testing-guide.md` section 3.

If something fails, the detailed sections below explain each piece.

## 0. Decide and prepare (operator)

1. **Who may see it.** With demo mode on, anyone who finds the URL can sign in as a demo user
   and play with synthetic data. Either accept that for a short test or enable Vercel's
   deployment protection (Settings → Deployment Protection).
2. **Generate two secrets** on your machine and keep them in a password manager; they must be
   identical on the web app and the worker:

```bash
openssl rand -base64 48
```

```bash
echo "k1:$(openssl rand -base64 32)"
```

The first is `RELAY_SESSION_SECRET`; the second is `RELAY_ENCRYPTION_KEYS`.

## 1. PostgreSQL

1. Create a Postgres 16 database (Neon: _New project_; or Vercel → Storage → Neon).
2. In its SQL editor, run `infra/postgres/managed-roles.sql` with three strong passwords.
   If the provider created the database for you, use `ALTER DATABASE … OWNER TO relay_migrator`
   as noted in the file.
3. Note three connection strings:
   - `DATABASE_URL_MIGRATOR`: `relay_migrator`, **direct** (non-pooled) host.
   - `DATABASE_URL_APP`: `relay_app`; the **pooled** host (PgBouncer, transaction mode) is fine
     and recommended for serverless.
   - `DATABASE_URL_WORKER`: `relay_worker`, **direct** host (the worker uses LISTEN/NOTIFY).
4. Apply migrations from GitHub: Settings → Environments → create `staging`, add the secret
   `DATABASE_URL_MIGRATOR`; then Actions → **Migrate database** → Run workflow → `staging`.
   This is deliberately a manual step.

## 2. Object storage (AWS S3 shown)

1. Create a private bucket (block all public access) in a region near the database.
2. Enable **Bucket Versioning** (Relay pins the validated object version).
3. CORS, with your Vercel URL as the origin:

```json
[
  {
    "AllowedOrigins": ["https://<your-app>.vercel.app"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": [
      "content-type",
      "content-length",
      "if-none-match",
      "x-amz-checksum-sha256",
      "x-amz-sdk-checksum-algorithm"
    ],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 600
  }
]
```

4. An IAM user with access limited to that bucket (`s3:PutObject`, `GetObject`,
   `GetObjectVersion`, `DeleteObject`, `DeleteObjectVersion`, `ListBucket`,
   `ListBucketVersions`, `AbortMultipartUpload`, `ListMultipartUploadParts`, `GetBucketVersioning`,
   `PutBucketVersioning`, `PutBucketCors`). Note its access key and secret.

Vercel Blob cannot be used: it is not S3-compatible and has no versioning.

## 3. Environment variables

Same values for web (Vercel) and worker (container host) unless noted. Never commit them.

| Variable                                                             | Value                                                                                                           |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `RELAY_ENV`                                                          | `staging` (Vercel sets `NODE_ENV=production`; without this Relay applies production rules and refuses to start) |
| `RELAY_DEMO_MODE`                                                    | `true`                                                                                                          |
| `RELAY_PUBLIC_URL`                                                   | `https://<your-app>.vercel.app` (exact origin; mutations are refused from any other origin)                     |
| `RELAY_SESSION_SECRET`                                               | generated above                                                                                                 |
| `RELAY_ENCRYPTION_PROVIDER` / `RELAY_ENCRYPTION_KEYS`                | `local` / generated above                                                                                       |
| `DATABASE_URL_APP`                                                   | web only (pooled host)                                                                                          |
| `DATABASE_URL_WORKER`                                                | worker only (direct host)                                                                                       |
| `RELAY_DB_POOL_MAX`                                                  | web: `3` (each serverless instance has its own pool); worker: default                                           |
| `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | from step 2                                                                                                     |
| `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`                                  | leave unset for AWS S3; set both to the endpoint URL for other stores                                           |
| `S3_FORCE_PATH_STYLE`                                                | `false` for AWS S3; usually `true` for others                                                                   |
| `RELAY_WORKER_HEALTH_HOST` / `RELAY_WORKER_HEALTH_PORT`              | worker: `0.0.0.0` / `3101` (point the host's health check at `/healthz`)                                        |
| `RELAY_LOG_LEVEL`                                                    | `info`                                                                                                          |

Previews: Vercel preview deployments get different URLs, so `RELAY_PUBLIC_URL` will not match
and sign-in mutations are refused there. Test on the production URL of the project (or disable
preview deployments).

## 4. Web app on Vercel

Project settings: framework Next.js, **root directory `apps/web`**, Node **22.x**, install
command left to detection (pnpm from `packageManager`), build command `next build`. Add the
variables above for _Production_. The first deployment after the database is migrated and
seeded should answer `GET /api/ready` with `{"ok":true,…}`.

Seeding demo data: run `pnpm db:seed` from a machine that can reach the database and the
bucket (your laptop with the staging variables in a local `.env`, or a one-off job on the
worker host: `node dist/migrate.js` is migrations only; seeding needs the repository checkout).

## 5. Worker on a container host

Build from `infra/docker/worker.Dockerfile` with the repository root as the build context,
set the variables above, expose port 3101 for the host's health check, and run one instance
(`RELAY_WORKER_POOLS=general,media`). Allow 2 CPU / 2 GB for media validation. The worker
refuses to start if the database schema is older than the build requires, so migrate first.

## 6. Check

1. `https://<your-app>.vercel.app/api/ready` → database and storage `ok`.
2. Worker host `/readyz` → `{"ok":true,…}`.
3. Follow `docs/testing-guide.md` section 3 on the hosted URL.

## What stays local-only

`pnpm test:integration`, `pnpm test:e2e` and the fixtures generator need Docker/FFmpeg and run
locally, in Codespaces, or in GitHub Actions; they are not part of the hosted environment.
