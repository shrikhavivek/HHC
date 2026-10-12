# High Heel Confidential — Editorial Studio

An editorial workspace for daily fashion intake, outfit research, reversible
collage editing, and reviewed WordPress drafts. The browser never receives
Reddit, Instagram or WordPress credentials in JavaScript.

## Run locally

Keep your existing `.env`; copy `.env.example` only for a new installation.
For a local demonstration, explicitly set:

```env
APP_ENV=development
APP_ORIGIN=http://localhost:3100
DEMO_LOGIN_ENABLED=true
DEMO_USERNAME=hhc-demo
DEMO_PASSWORD=HHC-Demo-2026!
REDDIT_SOURCE_MODE=manual
```

Then run:

```powershell
docker compose up -d --build
```

Open http://localhost:3100 and use the demonstration credentials above.
Demo sign-in is disabled by default and always disabled in production.
Demonstration cases use clearly identified placeholder images; they cannot
be sent to WordPress. No live provider access is implied by demo data.

The stack contains PostgreSQL, the private API, the web application and a
daily worker. A storage initialization service assigns only the media and
output volumes to the application's non-root user; existing files are retained.
API and web ports bind to localhost. API reads, documentation, originals and
rendered images require authentication. The public `/health` route checks
database connectivity.

## An editor's workflow

1. Open **Sources & schedule** to see credentials, worker status, cooldowns
   and recent runs. **Refresh now** queues work without blocking the page.
2. Open a source case. Correct the person, designer, event or date when necessary.
   Corrections invalidate prior match verification and story rights confirmation.
3. Inspect historical leads against the original photos. Record the source,
   garment details, distinct appearances and chronology before approving a match.
4. Open **Edit collage & sources** to select the actual photos to use.
5. Open **Write story**, write the headline and editorial text, add image
   descriptions and photo credits, and choose WordPress categories and tags.
6. Confirm the reviewed collage's attribution and usage rights, save the story,
   then **Send WordPress draft**. Finish publication or scheduling in WordPress.

### Collage tools

- Reorder with drag and drop or keyboard-accessible move buttons.
- Add, remove and replace source photos; upload credited JPEG, PNG or WebP files.
- Fit the full photograph or draw, move and resize a reversible crop.
- Rotate in quarter turns; mirror horizontally or vertically.
- Adjust brightness, contrast, saturation and grayscale per photo or across
  the complete collage; apply and reset appearance presets.
- Add a caption/designer credit in a separate strip beneath a photo.
- Choose portrait/landscape and balanced-grid, hero or editorial-split layouts.
- Export at 1080, 2160 or 3240 pixels wide. Enlarging cannot recover missing
  source detail. Original images remain unchanged.
- Upload an authorized watermark, then move, resize, rotate and change its
  opacity and colour independently.
- Undo/redo recent changes with buttons or Ctrl/Cmd Z, Shift Ctrl/Cmd Z or Ctrl Y.
- Unsaved-change warnings, concurrent-edit checks, immutable render versions,
  restore-as-new-draft, PNG/WebP outputs and a ZIP source manifest.

New renders have unique version paths. Older, pre-upgrade render records may
point to a single overwritten legacy file; that history cannot be reconstructed.

## Reddit

Production intake requires approved OAuth access. Configure:

```env
REDDIT_SOURCE_MODE=approved_api
REDDIT_CLIENT_ID=issued-client-id
REDDIT_CLIENT_SECRET=issued-client-secret
REDDIT_USER_AGENT=windows:hhc-editorial:v3 (by /u/YOUR_REDDIT_USERNAME)
REDDIT_SUBREDDIT=BollywoodFashion
REDDIT_DAILY_TIMEZONE=Asia/Kolkata
```

The client reuses OAuth tokens, briefly caches identical queries, spaces requests,
and records shared cooldowns from Reddit's rate-limit headers. It never rotates
identities or proxies to evade a limit. Anonymous RSS remains a development
option, with no access guarantee; it is not an approved production fallback.
See [Reddit's API guidance](https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki).

Titles and captions identify research leads. Matching designer names, colour
histograms and perceptual hashes are retrieval signals, not proof that two
garments are identical. Unknown or later dates are excluded from historical
search. Unapproved historical leads are available for review but are not
automatically included as confirmed outfit repeats. Publication requires
recorded editorial verification. Same-post photos still require visual review.

## Instagram

The official Graph connector supports the connected professional account and
configured accounts accessible through Business Discovery. Supply the client's
authorized token, professional account ID and permitted watch list:

```env
INSTAGRAM_ACCESS_TOKEN=authorized-token
INSTAGRAM_ACCOUNT_ID=numeric-professional-account-id
INSTAGRAM_WATCH_ACCOUNTS=account_one,account_two
META_GRAPH_VERSION=v23.0
```

The API version is configurable. Validate it and the app's permissions against
Meta's current account setup before deployment. The connector follows media
pages and image carousel children. It does not bypass private accounts, login
walls or rate limits. Unsupported or inaccessible accounts require an
editor-selected source and permitted image upload. Videos are not converted into
fabricated outfit photos. Live access cannot be verified without the client's
Meta credentials and approvals.

## Daily editions

`DAILY_AUTOMATION_ENABLED=true` enables scheduled intake.
`DAILY_AUTOMATION_HOUR_UTC=3` and
`DAILY_AUTOMATION_MINUTE_UTC=30` start the current edition at 09:00 India time.
The worker revisits the current edition hourly and checks yesterday for late
arrivals. Partial runs retry with backoff; one provider failing does not prevent
the other from running. Posts are deduplicated by their source permalink.

Run exactly one worker for this installation; PostgreSQL advisory locks also
prevent simultaneous refresh workers. Queued run-now requests survive API
restarts. A terminated active job becomes interrupted and the scheduled edition
can retry. The app needs to remain running for daily refresh to occur.

## WordPress

Set `WORDPRESS_SITE_URL` to the client's HTTPS site. Sign in using a WordPress
Application Password from an account with `edit_posts` and `upload_files`.
Set `WORDPRESS_PUBLISHER_ENABLED=true` to allow explicit draft handoffs.

Credentials are encrypted in an HttpOnly, SameSite session cookie; sessions
expire after eight hours and logout revokes the server-side session record.
Local demo sessions cannot connect to WordPress.

Only drafts are created. The handoff uploads the reviewed image, credits,
image description, categories and tags. Historical panels require the latest
approved decision. Changing the collage invalidates its previous rights review.
The connector reuses known posts/media and blocks blind retries after uncertain
network results. **Check previous handoff** reconciles a known post; if none is
found, an administrator must inspect WordPress before resetting the stored
handoff state. Already published or scheduled posts are managed in WordPress.

WordPress application-password authentication is described in the
[official REST API documentation](https://developer.wordpress.org/rest-api/using-the-rest-api/authentication/).

## Deployment and verification

Before exposing the app, set `APP_ENV=production`, an HTTPS `APP_ORIGIN`,
unique random `SESSION_SECRET` and `EDITOR_API_KEY` values, a strong database
password and matching `DATABASE_URL`. Keep demo login disabled. Terminate TLS
at the deployment proxy; Secure cookies and HSTS are enabled in production.
Production startup rejects default API secrets, the sample database password,
SQLite and anonymous Reddit intake.

The web and API run as non-root users. Media access is authenticated, mutation
requests require the app's origin, login attempts are rate-limited, script
nonces protect page execution, uploads are bounded, and remote image fetches
pin a validated public address while preserving TLS hostname verification.

Back up PostgreSQL and both named volumes together, test restoration, provide
disk monitoring and job-failure alerts, and establish the client's process for
source removals and archive retention. Those deployment services and
provider-specific deletion workflows are not provisioned by this repository.

```powershell
docker compose run --rm --no-deps -e DATABASE_URL=sqlite:////tmp/hhc-tests.db -e APP_ENV=development -e SCHEDULER_IN_API=false api pytest -q -p no:cacheprovider
cd apps/web
npm ci
npm run typecheck
npm run build
npm run test:e2e
```

Browser tests default to an isolated preview at http://localhost:3200 and
Microsoft Edge. Set `HHC_TEST_BASE_URL`, `HHC_TEST_BROWSER`,
`HHC_TEST_USERNAME` and `HHC_TEST_PASSWORD` for another test installation.
Use a disposable demo database: acceptance tests intentionally save draft stories
and collage versions. Never point them at the client's live editorial workspace.

Provider calls and WordPress writes are mocked in the automated API tests.
A passing test suite is not a guarantee of error-free external services or
perfect outfit identification. Client staging sign-off, live credential testing,
backup restoration and operational monitoring remain release requirements.
