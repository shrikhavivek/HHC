# High Heel Confidential — Editorial Studio

An editorial workspace for daily fashion intake, outfit research, reversible
collage editing, and reviewed WordPress drafts. The browser never receives
Reddit, Instagram or WordPress credentials in JavaScript.

## Run locally

Keep your existing `.env`; copy `.env.example` only for a new installation.
Configure `EDITOR_USERNAME` and `EDITOR_PASSWORD_HASH` in your private `.env`.
The hash format is `scrypt:131072:8:1:<32-byte salt as hex>:<64-byte hash as hex>`.
The helper `node apps/web/scripts/configure-editor.mjs` accepts JSON containing
`username` and `password` on standard input and stores only the salted hash in
the root `.env`. Keep credentials out of source control and shell history.
For local use, set:

```env
APP_ENV=development
APP_ORIGIN=http://localhost:3100
REDDIT_SOURCE_MODE=manual
```

Then run:

```powershell
docker compose up -d --build
```

Open http://localhost:3100, enter your editor username and password, and click
**Unleash your editorial eye**. WordPress sign-in happens only when sending
a reviewed draft. Guest entry and the old demo/WordPress login paths are disabled.
The editor account works locally and in hosted installations. For hosting, set
`APP_ENV=production`, an HTTPS `APP_ORIGIN`, and strong deployment secrets.
Failed attempts are rate limited in PostgreSQL. Existing guest sessions are
rejected; changing the configured account invalidates existing editor sessions.
Demonstration cases use clearly identified placeholder images; they cannot
be sent to WordPress. No live provider access is implied by demo data.

The stack contains PostgreSQL, the private API, the web application and a
daily worker. A storage initialization service assigns only the media and
output volumes to the application's non-root user; existing files are retained.
API and web ports bind to localhost. API reads, documentation, originals and
rendered images require authentication. The public `/health` route checks
database connectivity.

## An editor's workflow

### Sign in to Instagram or Reddit and collect photos

The dashboard has **Sign in to Instagram & collect photos** and
**Sign in to Reddit & collect photos** buttons. Each opens a dedicated Edge
window on the Windows computer running the local collector. Enter credentials
directly on the provider website and complete any verification there. Collection
continues automatically after sign-in; keep the source window open. The dashboard
shows sign-in and capture progress and refreshes as posts arrive. Credentials and
cookies remain in the separate local browser profiles, outside Docker and Git.
If a Reddit page fails to load, its window stays open and the dashboard shows
**Check the Reddit window**. Refresh or complete sign-in on Reddit yourself;
collection resumes when the requested page becomes available. Navigation is not
retried automatically. If the wait expires or another collection error occurs,
the window stays open for inspection until you close it, then you can start again.

With Docker running, install web dependencies and the request launcher once:

```powershell
cd apps/web
npm ci
& ./scripts/install-browser-task.ps1
```

The **HHC Browser Requests** task starts immediately and at Windows sign-in.
It only opens source windows after an editor presses a collection button; it
does not schedule daily scans. The installer retires the older **HHC Instagram
Requests** launcher to prevent duplicate collectors. The Windows user must be
signed in and the computer awake. Remote browsers cannot launch Edge on their
own computers through this local setup; windows open on the collector computer.

Instagram scans every enabled watchlist account; Reddit scans the configured
subreddit's chronological `/new` listing. Each keeps a separate listing tab and
continues scrolling beyond the former 12/24-post limits. Six consecutive dated,
unpinned older posts establish the observed date boundary; the whole loaded batch
is inspected before stopping so pinned or reordered items cannot hide another
recent item in that batch. This is best-effort coverage of the source's exposed
ordering, not a guarantee about hidden, removed or arbitrarily reordered posts.

The dashboard records the India-time date window as of scan start, per-source
coverage, qualifying posts, saved posts, duplicates and unresolved failures.
Unreadable dates, failed captures, blocked pages and feeds that stop loading
remain incomplete. A safety stop at 200 scrolls or 45 minutes per source is also
incomplete, never a successful truncation. Rerun to reconcile new arrivals or gaps;
posts published after scan start belong to the next scan. Existing complete
carousels are reused, and incomplete Reddit galleries require their original edit
revision before expansion. Instagram's recent-photo feed no longer truncates at
100 posts. Brand/designer credits are required; reels and videos are excluded.
Captured drafts still need rights and attribution review before WordPress handoff.

1. Open **Sources & schedule** to see credentials, worker status, cooldowns
   and recent runs. **Refresh now** queues work without blocking the page.
2. Open a source case. Correct the person, designer, event or date when necessary.
   Corrections invalidate prior match verification and story rights confirmation.
3. Inspect historical leads against the original photos. Record the source,
   garment details, distinct appearances and chronology before approving a match.
4. Open **Edit collage & sources** to select the actual photos to use.
5. Choose **Write your story** after saving the collage. Add the headline,
   editorial text, image description and credits; edits save automatically.
6. Choose **Review draft** to inspect the full collage, story and credits.
   Confirm the photo rights and attribution, then **Continue to WordPress**.
   Sign in, wait for the draft confirmation, and choose **Open draft in WordPress**.
   Finish publication or scheduling in WordPress.

Story autosave is debounced and preserves typing during an active save. A
per-editor recovery copy in session storage keeps unfinished edits in the same
browser tab after reload or sign-in. Revision conflicts require choosing the
saved version or explicitly keeping local edits. Recovery copies are cleared
when saved, contain no login credentials, and are not a substitute for backups.
Closing the browser tab can discard edits that never reached the server.
WordPress cancellation returns to the same story and review step.

### Legacy public-web discovery API

The dashboard now has one **Discover Instagram posts** panel, using the signed-in
local browser collector described below. It no longer shows a separate public-web
Instagram search. The legacy `/api/discovery/web/search` and `/import` endpoints
remain available to authenticated API clients. The `instagram` source searches
indexed Instagram URLs; `web` uses general search and public publisher feeds.
This feature uses public HTML search and publisher feeds, without an Instagram
account, token, handle watchlist, or paid scraping service. Search challenges,
login walls and HTTP access denials are not bypassed. Instagram uses the public HTTP
reader also used by the existing URL importer; other publishers use robots-aware
browsing. Coverage is best-effort: search indexing can lag and Instagram may block
public access. Failures and excluded-date counts are reported rather than hidden.
Public fashion feeds are checked only in **Fashion websites** mode.
If discovery cannot reach any search source, the API returns HTTP 503 with
**Search unavailable**, not a misleading zero-results message. Partial
searches are labeled incomplete. Successful search-link lists are cached in each
API process for 15 minutes (up to 128 queries); publication dates are still checked
on the source pages on every scan and import. A browser challenge pauses new search
requests for five minutes to avoid repeated blocked requests. These measures do
not remove challenges or guarantee access; retries may still fail. Process restarts
clear the cache and cooldown.
Set `WEB_DISCOVERY_FEEDS` to a comma-separated list of public HTTPS RSS/Atom feeds
to customize the fallback sources (up to four per scan).

Instagram discovery now accepts only **today and yesterday** by publication date.
Other websites use the **current Monday–Sunday calendar week**, in
`REDDIT_DAILY_TIMEZONE` (default `Asia/Kolkata`).
The page's `datePublished`, publication metadata or explicitly marked published
time is used, not search-result dates, retrieval time, or `dateModified`. For public
Instagram pages without structured timestamps, the platform-generated caption
header (`username on Month Day, Year:`) supplies the publication day. Dates mentioned
inside the caption body are not treated as publication dates.
Missing, conflicting, timezone-ambiguous timestamps and future dates are excluded.
A date without a time is treated as that local calendar day and labeled as such.
An article's publication date does not prove the embedded Instagram post or outfit
appearance is equally recent; the original source link remains available for review.

Results include publication dates and can be imported into the existing collage
and editorial workflow. A public URL can also be checked directly. The server
re-fetches and checks the date before import; client-provided dates are never trusted.
Website imports remain visible for that week; Instagram and Reddit remain visible
for today/yesterday, then leave the current desk without being deleted. Publication dates are
stored separately from editable appearance dates. Rights and attribution still need
editorial review before publishing. Scans are on demand and bounded to 12 pages.

### Local browser-assisted Instagram trial

From `apps/web`, run `npm run instagram:browser` with dependencies installed and
Microsoft Edge available. Sign in yourself in the separate visible browser window;
never paste passwords into the terminal, chat, or repository. The dedicated browser
profile retains session data under `%LOCALAPPDATA%/HHC/instagram-browser-profile`
on Windows, outside this repository. Treat that local folder as sensitive and do not
share or commit it. Sign out in the browser to stop reusing the account session.

The terminal accepts `open <public-handle>`, `post <shortcode>`, `check`, `inspect`,
and `close`. `inspect` reports rendered dates with their linked permalinks and image
dimensions on an individual post; these must be reviewed, not assumed to belong to
the source rather than comments or suggestions. A check lists at
most 12 currently rendered post links without scrolling, screenshotting, importing,
or scheduling anything. Reel links are excluded; dates and media types are not yet
verified. Sign-in, verification and restriction screens stop inspection. This is an
access feasibility trial, not a guarantee of authorized or uninterrupted collection.
The browser closes after 30 minutes; the profile remains for subsequent local use.

### Daily local Instagram watchlist

The dashboard's single **Discover Instagram posts** panel shows collected photo
cards, publication dates, brand evidence, and an **Open editable draft** action.
**Scan now** queues a live scan of every enabled account in the saved watchlist;
progress and new photos refresh automatically every five seconds. It does not use
public search or require a post URL. A name/brand filter searches collected photos.
Watchlist and brand configuration are collapsed under **Watchlist settings**.

**Scan now** opens Instagram in the dedicated Edge window on this computer.
If sign-in is needed, the dashboard shows **Waiting for Instagram sign-in**.
Sign in and complete any verification yourself in that window; collection starts
automatically after signed-in navigation is visible. Keep the window open during
collection. Existing signed-in sessions proceed directly. The sign-in wait expires
after 15 minutes, closing the window cancels the scan, and pausing intake stops
the wait. Access restrictions stop collection. No password is entered by the app.

The panel manages an editable starter list of 121 celebrity accounts, covering
leading Bollywood actors, veteran stars, newer actors and crossover performers,
and a brand/designer registry. The default names and handles are maintained in
`apps/api/app/instagram_watchlist.json`. Saved watchlists take precedence over
these defaults, so existing installations keep their edits and paused accounts.
Handles were reviewed against [actor](https://trendingpunjabi.com/otherLinks/instaStats/mostFollowedIndians?profession=actor)
and [actress](https://trendingpunjabi.com/otherLinks/instaStats/mostFollowedIndians?profession=actress)
directories and published Instagram credits in October 2026; they can change.
This is not a complete directory of Bollywood. Up to 200 accounts can be
configured. Larger lists take longer to scan. An arbitrary @mention (stylist, photographer, friend) does not qualify:
the caption or readable on-photo tag must match a configured brand name, alias or
exact handle. Unknown labels are excluded until added to the registry.

Run `npm run instagram:daily` from `apps/web` for one local collection pass. For a
non-importing trial: `npm run instagram:daily -- --dry-run --handle kritisanon`.
The collector shares the separate Edge session used by `instagram:browser` and
can open it for sign-in itself; close any trial window before collection. Cookies stay under your Windows user
profile and never go to Docker or GitHub. The collector reads the existing local
`.env` editor API key privately and only sends approved post metadata and photo
captures to the loopback API. No Instagram password is stored in application config.

Install the daily **09:00 India-time** task from PowerShell:

```powershell
& .\apps\web\scripts\install-instagram-task.ps1
```

Task Scheduler entries: `HHC Instagram Daily` (09:00) and `HHC Instagram Requests`
(checks for dashboard requests every three seconds while idle). Re-run the installer
after upgrading. To install and start only the Scan now launcher, leaving the daily
task as configured, run `& .\apps\web\scripts\install-instagram-task.ps1 -RequestsOnly`.
The requests task starts immediately and at Windows sign-in, with a minute trigger
to recover if it exits. One console-free background process polls the local API;
idle polling never starts a terminal or another process. Polling only contacts
the local API; Instagram opens only for a queued or scheduled scan. Queued requests
expire after three minutes offline rather than unexpectedly running hours later.
Overlapping requests reuse the active scan, including while waiting for sign-in.
Login waits send heartbeats so they remain active. The UI reports an offline collector
instead of claiming a scan has started. Both tasks use a console-free Windows launcher;
the Instagram browser itself remains visible for inspection.

Windows timezone must be India
Standard Time. The task runs only while this Windows user is signed in; the computer
must be awake with Docker and the application running. Missed starts may run later
when available. No elevated account or saved Windows password is needed. Pause
intake in the dashboard, or disable the task with
`Disable-ScheduledTask -TaskName 'HHC Instagram Daily'`.

Each scan continues through the today/yesterday date window for each enabled
account; pinned posts do not establish the older-post boundary. Reels,
videos, unknown dates, future dates, dates before yesterday, mismatched authors and
unrecognized brand mentions without explicit clothing credits are excluded. A
registry match or an explicit clothing credit such as `Outfit: @label` qualifies;
unlabelled mentions of friends or photographers do not. Only a timestamp linked to the actual
post permalink qualifies, not a comment date. A screenshot is cropped to an image
matching the post's own Open Graph cover; suggested-post photos are not fallback
sources. Photo slides are captured from the same carousel. Tags are used only
when an accessible on-photo tag overlay can be read; unexposed tags can be missed.

The server rechecks date and brand eligibility and validates image bytes before
creating an editable source-only collage. Carousel photo slides are captured in
order through the post's own Next control, up to 20 slides and 22 MB per upload;
video slides are skipped. Navigation is scoped to the verified cover's image frame,
never recommendation cards. Incomplete/stalled carousels are labelled rather than
reported as complete. Source-image identifiers prevent repeat panels. Existing
cover-only drafts are expanded in place, with their saved adjustments retained and
new photo panels appended. Partial rechecks never shrink an existing gallery.
The feed shows the collage preview and collected-photo count.

Existing permalinks are deduplicated;
existing outfit grouping continues to apply. Brand mentions are not proof of outfit
attribution, so imports remain in context review. Designer-reference photos are not
automatically invented or attached based on a tag alone. Nothing is auto-published.
Older posts leave the active desk but remain in the archive.

The dashboard reports checked accounts, checked posts, exclusions and imported
counts. Blocks stop the entire run; there is no CAPTCHA solver, proxy rotation or
automatic login. Reopen `instagram:browser` yourself to resolve session expiry.
This local collector is independent of the Docker Reddit/Graph worker and cannot
promise complete daily coverage or uninterrupted Instagram access.

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

Set `WORDPRESS_SITE_URL` to the site's HTTPS home URL and
`WORDPRESS_PUBLISHER_ENABLED=true` to allow explicit draft handoffs.
After reviewing the story, **Continue to WordPress** redirects to the
site's own WordPress sign-in/authorization page. Use the normal WordPress login
there and approve the studio connection. A progress page creates the draft and
offers **Open draft in WordPress**; publishing remains a manual action. The account needs
`edit_posts` and `upload_files` permissions.

The app discovers the site's WordPress install path, including HHC's `/wp` path.
For local HTTP, it uses a `127.0.0.1` callback, which WordPress permits, and a
short-lived HttpOnly cookie to bind the return to the initiating browser. A
single-use server record expires after 15 minutes and rejects changed stories,
expired studio sessions and replayed callbacks. Cancellation preserves local
work. The generated application password is used only for that handoff and
revoked on a best-effort basis afterward; if the site is unreachable during
revocation, it can be removed in the WordPress user's profile. Do not enable
access logging of callback query strings: WordPress returns the temporary
credential in its authorization response. The callback immediately removes it
from the displayed URL, transferring it into an encrypted HttpOnly cookie for
the same-origin completion POST. That cookie is cleared after completion.
Responses use no-store/no-referrer. The completion page does not blindly retry
failed transfers; it links back to the saved story for reconciliation.

Studio sessions expire after eight hours and logout revokes the server record.
Editor login checks the configured salted password hash on the server and does
not contact WordPress or store the editor password in its session cookie.

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
