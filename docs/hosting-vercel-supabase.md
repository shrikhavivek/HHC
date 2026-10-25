# Hosting on Vercel + Supabase (free tiers)

Status: **experimental** on `feature/vercel-supabase`. Tested locally against a
fake Supabase Storage API; not yet run against a real Supabase project or a
Vercel deployment. Docker Compose still works unchanged (`STORAGE_BACKEND=local`).

## Layout

| Piece | Runs on | Notes |
|---|---|---|
| Web (`apps/web`) | Vercel project 1 (Next.js) | Login, dashboard, proxies to the API |
| API (`apps/api`) | Vercel project 2 (FastAPI, `app/main.py`) | One function, up to 300 s per request |
| Database | Supabase Postgres | API uses the transaction pooler; worker uses the session pooler |
| Files | Supabase Storage, private bucket `hhc` | Created automatically by the migrate step |
| Hourly worker | GitHub Actions (`.github/workflows/worker.yml`) | Runs at :35 every hour; can be started from "Refresh now" |
| Instagram collector | Your computer | Set `HHC_API_URL` to the API's Vercel URL |
| Reddit gallery recovery | Your computer | Same `HHC_API_URL`; screenshots go straight to the bucket |

## How files work

`MEDIA_DIR` and `OUTPUT_DIR` point at `/tmp` and act as a cache. Each file is
uploaded to the bucket after it is written and downloaded again by any
instance that needs it (`app/storage.py`). The database still stores the same
paths as before.

- **Showing images:** the web's `/media/...` route asks the API, which answers
  with a redirect to a signed link (1 hour). The browser loads the image
  directly from Supabase.
- **Uploads:** Vercel caps requests at 4.5 MB. The browser and the collector
  ask `POST /api/uploads` for signed upload links, put the files in the bucket
  under `incoming/`, and send only the keys. The API reads each file once and
  deletes it; leftovers are deleted after 24 hours.
- **Evidence ZIP:** built on first download, stored beside the render, and
  handed out as a signed link.

## Setup

1. **Supabase:** create a project. From *Project Settings*, copy:
   - the project URL and the secret key (`sb_secret_...`, or the legacy `service_role` key);
   - the **transaction pooler** connection string (port 6543) for the API;
   - the **session pooler** connection string (port 5432) for the worker.
2. **Reddit:** production mode requires Reddit OAuth credentials. Create a
   "script" app at reddit.com/prefs/apps. Reddit also tends to block
   unauthenticated requests from cloud servers.
3. **GitHub:** in the repo's *Settings → Secrets and variables → Actions*, add
   the secrets listed under "Worker" below. Run the **worker** workflow once by
   hand (*Actions → worker → Run workflow*). Its first step creates the bucket
   and the tables.
4. **Vercel API project:** import the repo, set *Root Directory* to
   `apps/api`, add the "API" variables, deploy.
5. **Vercel web project:** import the repo again, set *Root Directory* to
   `apps/web`, add the "Web" variables, deploy.
6. **Collectors** (Instagram and Reddit gallery recovery): add
   `HHC_API_URL=https://<api>.vercel.app` and the production `EDITOR_API_KEY`
   to the repo's `.env` on your computer.
7. **Optional, "Refresh now":** create a fine-grained GitHub token with
   *Actions: read and write* on this repo, and set the `GITHUB_DISPATCH_*`
   variables on the API project.

## Environment variables

### API (Vercel)

| Variable | Value |
|---|---|
| `APP_ENV` | `production` |
| `DATABASE_URL` | Transaction pooler string (port 6543) |
| `DATABASE_NULL_POOL` | `true` |
| `RUN_STARTUP_TASKS` | `false` (the worker's migrate step does this) |
| `SCHEDULER_IN_API` | `false` |
| `STORAGE_BACKEND` | `supabase` |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | From Supabase |
| `MEDIA_DIR`, `OUTPUT_DIR`, `STATIC_DIR` | `/tmp/hhc/media`, `/tmp/hhc/outputs`, `/tmp/hhc/static` |
| `EDITOR_API_KEY` | Random, 32+ characters; same on web and worker |
| `CORS_ORIGINS` | `https://<web>.vercel.app` |
| `REDDIT_SOURCE_MODE`, `REDDIT_USER_AGENT`, `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` | Reddit OAuth app |
| `SERPAPI_KEY` | Optional |
| `WORKER_HEARTBEAT_WINDOW_SECONDS` | `5400` (the worker runs hourly) |
| `GITHUB_DISPATCH_REPO`, `GITHUB_DISPATCH_TOKEN`, `GITHUB_DISPATCH_REF` | Optional: `shrikhavivek/HHC`, token, `master` |
| `WORDPRESS_PUBLISHER_ENABLED`, `WORDPRESS_SITE_URL` | Leave sending off, or point at your own site |

### Web (Vercel)

| Variable | Value |
|---|---|
| `APP_ENV` | `production` |
| `APP_ORIGIN` | `https://<web>.vercel.app` |
| `API_INTERNAL_URL` | `https://<api>.vercel.app` |
| `EDITOR_API_KEY` | Same as the API |
| `SESSION_SECRET` | Random, 32+ characters |
| `EDITOR_USERNAME`, `EDITOR_PASSWORD_HASH` | From `node scripts/configure-editor.mjs` |
| `WORDPRESS_SITE_URL` | Same as the API |

### Worker (GitHub Actions secrets)

`WORKER_DATABASE_URL` (session pooler, port 5432), `EDITOR_API_KEY`,
`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `REDDIT_CLIENT_ID`,
`REDDIT_CLIENT_SECRET`, and optionally `SERPAPI_KEY`, `INSTAGRAM_ACCESS_TOKEN`,
`INSTAGRAM_ACCOUNT_ID`. Repository variables (optional): `REDDIT_USER_AGENT`,
`REDDIT_SOURCE_MODE`, `ARCHIVE_PURGE_ENABLED` (default `true`),
`HISTORY_RETENTION_DAYS` (default `90`).

## Known limits

- **Untested against the real services.** The storage calls follow
  Supabase's storage-js client, but bucket permissions, CORS on signed uploads
  and pooler behaviour must be checked on a real project.
- **"Refresh now"** waits for the next hourly run unless the GitHub dispatch
  token is set; even then, Actions takes about a minute to start.
- **First open of a case** downloads its photos from Supabase into the
  instance's cache, then renders. Expect a few seconds on a cold instance.
- **The desk list** compares photos to group duplicate posts, so a cold
  instance downloads the current edition's photos once.
- **GitHub disables scheduled workflows** after 60 days without commits to
  the repo. Re-enable it from the Actions tab.
- **Supabase free projects pause** after 7 days without database activity.
  The hourly worker keeps it active.
- **No automatic backups** on the free tier.
