# Hosted staging: web on Vercel, worker elsewhere

How to run Relay on the internet for testing. Relay is four parts, and only one of them can
live on Vercel:

| Part                                                                     | Can it run on Vercel?                                   | Where it goes instead                                                                                                   |
| ------------------------------------------------------------------------ | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Web app** (Next.js)                                                    | Yes                                                     | Vercel project, root directory `apps/web`                                                                               |
| **Worker** (Graphile Worker + FFmpeg; long-running, listens to Postgres) | No: Vercel functions are short-lived and have no FFmpeg | Any container host: Render, Railway, Fly.io, Cloud Run (min 1 instance), a VPS. Image: `infra/docker/worker.Dockerfile` |
| **PostgreSQL 16**                                                        | Not on Vercel itself                                    | Neon (offered inside Vercel under _Storage_), Supabase, RDS, Cloud SQL                                                  |
| **Object storage** (S3 API with versioning)                              | Not Vercel Blob (different API, no versioning)          | AWS S3, or another store with the S3 API, object versioning _and_ bucket CORS                                           |

Without the worker, uploads never finish validating and nothing publishes, so all four are
needed for a meaningful test. Everything stays **simulated**: no real platform is contacted.

This is a **staging** deployment. Production mode is intentionally refused by this build until
the KMS key provider ships (M3); staging runs with a local encryption keyring and demo sign-in.

## Quick path (no prior experience assumed)

You need accounts at Vercel, AWS (for the bucket) and Render or Railway (for the worker). Neon
is created from inside Vercel. Nothing is installed on your computer and you never write SQL:
the first time the worker starts it creates the database roles and tables, prepares the bucket
and loads the demo data by itself.

### 1. Two secrets

Generate two random values once and keep them in a password manager. The web app and the
worker must get the **same** two values.

Mac or Linux (Terminal):

```bash
openssl rand -base64 48
```

```bash
echo "k1:$(openssl rand -base64 32)"
```

Windows (PowerShell):

```powershell
$b = New-Object byte[] 48; (New-Object System.Security.Cryptography.RNGCryptoServiceProvider).GetBytes($b); [Convert]::ToBase64String($b)
```

```powershell
$b = New-Object byte[] 32; (New-Object System.Security.Cryptography.RNGCryptoServiceProvider).GetBytes($b); "k1:" + [Convert]::ToBase64String($b)
```

The first value is `RELAY_SESSION_SECRET`. The second, which starts with `k1:`, is
`RELAY_ENCRYPTION_KEYS`.

### 2. Database (Neon, from inside Vercel)

Vercel → your Relay project → **Storage** → **Create Database** → **Neon** → keep the defaults
→ connect it to the project for all environments. This adds `DATABASE_URL` and
`DATABASE_URL_UNPOOLED` to the project's environment variables. Open Settings → Environment
Variables, reveal `DATABASE_URL_UNPOOLED` and copy its value somewhere safe: the worker needs it
in step 5. Do not open the SQL editor; the worker creates the roles and tables.

### 3. File storage (AWS S3)

1. AWS Console → S3 → **Create bucket**. Choose a unique name (for example
   `relay-staging-yourname`) and the region nearest to you. Keep **Block all public access**
   on and leave everything else at its default: Relay turns on versioning and sets CORS itself.
2. IAM → Users → **Create user** (no console access) → **Attach policies directly** → **Create
   policy** → JSON → paste the policy below with your bucket name in both `Resource` lines →
   name it `relay-staging-bucket` → back in the user wizard, refresh, tick it, create the user.
3. Open the user → **Security credentials** → **Create access key** → _Application running
   outside AWS_ → copy the access key ID and the secret access key (the secret is shown once).

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "Bucket",
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket",
        "s3:ListBucketVersions",
        "s3:ListBucketMultipartUploads",
        "s3:GetBucketVersioning",
        "s3:PutBucketVersioning",
        "s3:GetBucketCORS",
        "s3:PutBucketCORS"
      ],
      "Resource": "arn:aws:s3:::YOUR-BUCKET-NAME"
    },
    {
      "Sid": "Objects",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:GetObjectVersion",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:DeleteObjectVersion",
        "s3:AbortMultipartUpload",
        "s3:ListMultipartUploadParts"
      ],
      "Resource": "arn:aws:s3:::YOUR-BUCKET-NAME/*"
    }
  ]
}
```

Another S3-compatible store works when it supports object versioning and bucket CORS: also set
`S3_ENDPOINT` and `S3_PUBLIC_ENDPOINT` to its URL and `S3_FORCE_PATH_STYLE=true`.

### 4. Web app variables (Vercel)

Vercel → project → Settings → **Environment Variables** → add every row below for
_Production_. Then Deployments → the latest deployment's menu → **Redeploy**.

| Variable                                   | Value                                                                                                           |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `RELAY_ENV`                                | `staging` (Vercel sets `NODE_ENV=production`; without this Relay applies production rules and refuses to start) |
| `RELAY_DEMO_MODE`                          | `true`                                                                                                          |
| `RELAY_PUBLIC_URL`                         | the project's main address from Settings → Domains, e.g. `https://relay-yourteam.vercel.app`, no trailing slash |
| `RELAY_SESSION_SECRET`                     | the first secret                                                                                                |
| `RELAY_ENCRYPTION_PROVIDER`                | `local`                                                                                                         |
| `RELAY_ENCRYPTION_KEYS`                    | the second secret (`k1:…`)                                                                                      |
| `S3_BUCKET`                                | the bucket name                                                                                                 |
| `S3_REGION`                                | the bucket's region, e.g. `eu-central-1`                                                                        |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | from step 3                                                                                                     |
| `RELAY_DB_POOL_MAX`                        | `3` (each serverless instance keeps its own small pool)                                                         |

`DATABASE_URL` and `DATABASE_URL_UNPOOLED` are already present from step 2. The site now
builds and answers, but nobody can sign in until the worker has started once (next step),
because the worker creates the tables.

### 5. Worker and demo data (Render, or Railway)

**Render:** Dashboard → **New** → **Background Worker** → connect GitHub and pick
`WLABS26/Relay` → Language **Docker** → _Dockerfile Path_ `./infra/docker/worker.Dockerfile`
(build context stays the repository root) → instance type _Starter_ is enough for the demo
data → **Environment Variables**: the same ten rows as step 4 plus the four below → create. The
first build takes several minutes because the image contains FFmpeg.

| Variable                   | Value                                                  |
| -------------------------- | ------------------------------------------------------ |
| `DATABASE_URL`             | the `DATABASE_URL_UNPOOLED` value you copied in step 2 |
| `RELAY_AUTO_MIGRATE`       | `true`                                                 |
| `RELAY_AUTO_SEED`          | `true`                                                 |
| `RELAY_WORKER_HEALTH_HOST` | `0.0.0.0`                                              |

**Railway instead:** New Project → Deploy from GitHub repo → `WLABS26/Relay` → Variables: the
same rows plus `RAILWAY_DOCKERFILE_PATH=infra/docker/worker.Dockerfile` → deploy. The worker
needs no public address.

On its first start the worker logs `created role relay_app`, `migrations: 11 applied`,
`bucket …: versioning on, CORS allows …`, the seed steps and finally
`deployment bootstrap done` with `"seeded":true`. Every later start takes about a second and
logs `demo data already present`.

### 6. Check

1. `https://<your-app>.vercel.app/api/ready` shows `"database":"ok"` and `"storage":"ok"`.
2. Open the site, choose a demo user (Mara at Fernhill Studio has every permission) and follow
   `docs/testing-guide.md` section 3.

### If something fails

| Symptom                                                                        | Cause                                                                           | Fix                                                                                                                      |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Vercel build: `Unsupported environment … Node.js version`                      | the project builds on Node 26                                                   | Settings → General → _Node.js Version_ **22.x**, redeploy                                                                |
| web or worker exits with code 78 and a list of problems                        | a variable is missing or wrong (a missing `RELAY_ENV` applies production rules) | each line names the variable; fix it and redeploy                                                                        |
| `DATABASE_URL points at a connection pooler`                                   | only the pooled address was set                                                 | add `DATABASE_URL_UNPOOLED` (Neon: the connection string with _Connection pooling_ switched off)                         |
| `bucket "…" is not ready`                                                      | the access key may not change bucket settings                                   | use the policy above, or enable versioning and add a CORS rule for the origin the message names, then restart the worker |
| `/api/ready` says the database is not ok; no bootstrap lines in the worker log | the worker has not started yet, or failed                                       | read the worker log; it names the problem                                                                                |
| sign-in or saving fails with an origin or CSRF error                           | `RELAY_PUBLIC_URL` differs from the address in the browser                      | set it to the exact address you open                                                                                     |
| uploads never leave "validating"                                               | the worker is not running                                                       | check the worker service and its log                                                                                     |

## How it works, and what it is not

- **One database login, still least privilege.** Hosted Postgres gives you one owner login.
  On start-up the worker creates `relay_app` and `relay_worker` as NOLOGIN roles without
  `BYPASSRLS`, grants the login the right to `SET ROLE` to them, and proves the switch. Every
  pooled connection switches role right after connecting; a connection that cannot switch is
  rejected, never used as the owner. Row-level security stays forced on every tenant table.
- **Direct connection only.** The role switch is session state, which transaction poolers
  drop, so single-login mode always uses the direct host (`DATABASE_URL_UNPOOLED`) and refuses
  an address that looks like a pooler. `RELAY_DB_POOL_MAX=3` keeps the serverless web app
  within Neon's connection limit.
- **Automatic set-up is staging-only.** `RELAY_AUTO_MIGRATE` (roles, migrations, bucket
  versioning and CORS) and `RELAY_AUTO_SEED` (demo data, once) are refused with
  `RELAY_ENV=production`, as is single-login mode. Production uses separate logins
  (`infra/postgres/managed-roles.sql`), the manual _Migrate database_ GitHub workflow
  (`.github/workflows/migrate.yml`) and buckets managed as infrastructure.
- **Still simulated.** No real platform is contacted; simulator results are labelled as such
  everywhere in the product.

## Separate logins (optional hardening for staging)

To give staging the production shape instead: run `infra/postgres/managed-roles.sql` in Neon's
SQL editor with three passwords; set `DATABASE_URL_APP` (`relay_app`; the pooled host is fine
here) and `DATABASE_URL_WORKER` (`relay_worker`, direct host) instead of `DATABASE_URL`; add the
GitHub environment secret `DATABASE_URL_MIGRATOR` and run the _Migrate database_ workflow; leave
`RELAY_AUTO_MIGRATE` and `RELAY_AUTO_SEED` off and seed with `pnpm db:seed` from a machine that
reaches the database and the bucket.

## Previews

Vercel preview deployments get different URLs, so `RELAY_PUBLIC_URL` will not match and sign-in
mutations are refused there. Test on the project's main domain (or disable preview deployments).

## What stays local-only

`pnpm test:integration`, `pnpm test:e2e` and the fixtures generator need Docker/FFmpeg and run
locally, in Codespaces, or in GitHub Actions; they are not part of the hosted environment.
