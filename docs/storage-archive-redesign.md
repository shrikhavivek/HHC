# Storage & Archive Redesign — Analysis

Status: implemented on `feature/storage-archive-redesign` · Based on `master` @ `d9f1538` · 2026-10-22

## Implementation notes

What shipped, and where it differs from the plan below:

- **Settings:** `COLLAGE_RENDER_ON_PULL=false`, `ARCHIVE_PURGE_ENABLED=false`,
  `ARCHIVE_PURGE_GRACE_DAYS=7`. Purge ships **off**, so the first runs only
  record archive entries. That is the backfill.
- **Fingerprints are captured when an edition closes,** not at pull. Every case
  passes through that step while its photo still exists, so the result is the
  same with fewer intake paths changed (`app/archive.py`).
- **Duplicate grouping is unchanged.** It only compares desk cases, whose photos
  are never purged.
- **Render on open** happens in `GET /api/cases/{id}` when the case is marked
  `pending`. Editor actions (Research more, URL import, collage edit) still
  render immediately.
- **Reference images** are written on approval (the current look and the matched
  earlier look) and on a successful WordPress send. The purge step also backfills
  them for cases that were already approved or sent.
- **Not done:** evidence ZIPs are still built with each render (they're purged
  with the edition); version history of a purged case shows missing images; the
  web app has no "Rendering…" state, so the first open just takes longer.

## 1. Goal

Cut storage to the minimum and centre the system on the collage. Images live
only while they are being worked on; history is kept as text; final collages
live in WordPress.

## 2. Current behaviour (what the code does today)

- **Worker** (`apps/api/app/worker.py`) pulls hourly from 03:30 UTC for *today*,
  and re-pulls *yesterday* until one clean run marks it final.
- **Every pull is full processing**: for each new post it downloads all images,
  parses person/designer/event, runs archive + Reddit search, fetches a designer
  reference, and **renders a draft collage immediately**
  (`automation.py` → `_research_existing_case` → `_render_automatic_draft`).
- **Archive = every case ever collected**, with its images on disk. Matching
  (`_historical_matches`) reads prior images from disk to compute visual
  similarity; duplicate grouping (`outfit_posts.py`) hashes image files on the fly.
- **Every collage save is a new immutable render** (`Collage` row + image +
  manifest + evidence ZIP). Nothing is ever deleted; README flags unbounded growth.
- Storage lives in two Docker volumes: `media_data` (sources) and `output_data`
  (renders, bundles).

## 3. Proposed model

| Tier | Holds | Lifetime |
|---|---|---|
| **Hot** (disk / object store) | Source images, collage versions, evidence ZIPs | Current edition only (today + yesterday, until yesterday is finalised) |
| **Cold** (DB, text) | Links, tags, keywords, image fingerprints, decisions, audit, WordPress IDs | Forever, ~few KB per case |
| **Reference** (object store) | One compressed image per **approved or sent** case (see §6) | Forever, ~100–200 KB each |
| **WordPress** | Final sent collages | Forever (already paid for) |

Flow:

1. **Hourly pull = collect only.** Fetch post metadata, download images once,
   compute fingerprints, parse tags, run the text + fingerprint match. **No render.**
2. **Render on open.** Collage is built when the editor opens the case (or clicks
   Edit collage), not at pull time.
3. **Editor approves → WordPress draft.** Unchanged human gate.
4. **Edition close (after yesterday is finalised)** → purge hot tier for that
   edition; cold rows stay; sent collages survive in WordPress.

## 4. Current vs After

### Intake & processing

| Area | Current | After |
|---|---|---|
| Hourly pull | Full pipeline per post, incl. collage render | Collect + fingerprint + match only; no render |
| Image download | Kept permanently in `media_data` | Kept only for the hot edition |
| Image fingerprint | Computed on the fly from files (matcher, grouping) | Computed **once at pull**, stored as text/vector in DB |
| Collage render | Automatic at pull + on every research rerun | **Lazy**: on first open / Edit collage |
| Designer reference | Fetched + downloaded at pull | Look up at pull (store URL), download only at render |
| Pull budgets (8 searches etc.) | Shared with render work | Unchanged; renders no longer consume pull time |

### Archive & matching

| Area | Current | After |
|---|---|---|
| What the "archive" is | All `Case` rows **+ their image files** | New **`ArchiveEntry`** table, text only |
| Stored per entry | Full case + images | Permalink, platform, post ID, celebrity, designer, event, date, outfit signature (garments/details/colours), matched keywords, credit, **image fingerprint(s)**, WordPress media ID/URL if sent |
| Visual similarity | Reads prior image from disk | Compares **stored fingerprints** (no image needed) |
| Text similarity | Token overlap from case title/body | Same, from stored tokens |
| Historical panel in a new collage | Uses archived image file | **Reference image** if the case was approved/sent; otherwise **re-fetch from permalink**; if gone, ask editor to upload |
| Instagram cases in archive | Excluded from local matching | Include (fingerprints make it cheap) — decision needed |
| Duplicate grouping | Hashes image files every list load | Compares stored fingerprints |

### Collages, versions & WordPress

| Area | Current | After |
|---|---|---|
| Collage versions | Every save kept forever (up to 30 shown) | Kept only during hot edition |
| Evidence ZIP | Built and stored per render | Built **on demand**, not stored |
| Final collage | Stays on our disk | Lives in **WordPress media library**; we keep `wordpress_media_id` + URL (already on `StoryDraft`) |
| Unsent collages at edition close | Kept | Deleted (manifest JSON may be kept as text) |
| Restore old version | Any time | Only within the hot edition |

### Retention & cleanup

| Area | Current | After |
|---|---|---|
| Deletion | None | **Purge job** after yesterday is finalised |
| What's purged | — | Source images, collage images, bundles for closed edition |
| What's kept | Everything | `Case` row, `Candidate` evidence, `Decision`, `AuditEvent`, `StoryDraft`, `ArchiveEntry`, reference image for approved/sent cases |
| In-progress work | — | Purge **skips** cases with unsent drafts or `sync_state` `sending`/`uncertain`, or extends them by N days |
| Storage growth | Unbounded | Bounded to ~2 editions of images + slow-growing text + small reference set |

### Code touch points

| File / area | Change |
|---|---|
| `models.py` | Add `ArchiveEntry` (incl. `reference_image_path`); add fingerprint field(s); mark purged assets on `Collage`/`Case` |
| `review.py` / `wordpress.py` | On approval or successful draft send, write the compressed reference image |
| `automation.py` | Split pull from render; store fingerprints; matcher reads `ArchiveEntry`; re-fetch for historical panels |
| `outfit_posts.py` | Group by stored fingerprints, not files |
| `worker.py` | Add purge step after an edition is finalised |
| `editorial.py` / collage endpoints | Trigger render on first open; handle "source no longer available" |
| `apps/web` dashboard & collage editor | "Rendering…" state on open; missing-source state; history limited to edition |
| Migration | Backfill `ArchiveEntry` + fingerprints from existing cases **before** first purge |
| `README.md`, `docs/runbook.md` | Update retention, backup and restore notes |

## 5. Analysis

### Agreed fixes (from review of the original sketch)

1. **Text alone breaks matching** → store a small image fingerprint per photo
   (the code already computes descriptors in `_image_descriptor` and photo
   signatures in `outfit_posts.py`).
2. **Source links rot** (Instagram CDN URLs expire; posts get deleted) → store
   the **post permalink**, re-fetch at render, and treat **WordPress as the
   collage archive**.
3. **Don't flush at today − 1** → purge only after yesterday is finalised and
   skip cases still in progress.
4. **Keep case rows, purge only images** → verification evidence, decisions and
   audit are tiny and are the record of why a match was approved.
5. **No automatic WordPress send** → approval stays with the editor; render on
   open instead of a last-hour batch, so nothing is rendered that nobody opens.

### Benefits

- Storage becomes **bounded**: roughly two editions of images, plus text that
  grows by KB per case.
- Hourly pulls get **faster and lighter** (no rendering), so they fit short
  execution windows — relevant for serverless/free hosting.
- Fewer wasted renders: only opened cases are rendered.
- The disk stops being the hard dependency, which is the main thing blocking
  free hosting today.

### Costs & risks

| Risk | Impact | Mitigation |
|---|---|---|
| Historical image unavailable at render | Match found but can't be shown | Reference image for approved/sent cases (§6); otherwise editor upload; label "source unavailable" |
| Fingerprints weaker than full images | Fewer / noisier visual matches | Store the same descriptor the matcher already uses; keep text scoring |
| First render on open is slower | Editor waits a few seconds | "Rendering…" state; optionally pre-render cases marked review-ready |
| Version history lost after edition | Can't restore old drafts later | Acceptable by design; manifest JSON can be kept as text |
| Purge deletes work in progress | Lost edits | Skip unsent drafts / uncertain sends; configurable grace period |
| Re-fetching third-party images | Rate limits, ToS, rights | Same allow-list and user agent as today; rights review unchanged |
| Migration on existing data | Data loss if purge runs first | Backfill + verify before enabling purge; dry-run mode |

### Open decisions

- Grace period for unsent drafts before purge (e.g. 7 days)?
- Include Instagram cases in the local archive match?
- Keep collage manifests (JSON) after purge, or drop them too?
- Pre-render "review-ready" cases, or strictly render on open?

### Rough effort

Medium. The largest pieces are splitting pull from render in `automation.py`
and moving the matcher and grouping onto stored fingerprints. Purge job, new
table and UI states are small. Backfill migration needs care.

## 6. Middle ground: reference images for verified looks

### The tradeoff it fixes

A text-only archive keeps the ability to **find** old matches (text +
fingerprints) but weakens the ability to **show** them: the historical photo
must be re-fetched, and Instagram CDN links expire while posts get deleted or
made private. The older the match, the likelier the re-fetch fails. That is a
slow, silent decay of the app's core value — the side-by-side "worn before"
collage. The WordPress fallback only covers sent collages and means cropping a
finished collage rather than using the original photo.

### The rule

Keep **one compressed reference image** (1080 px WebP, ~100–200 KB) per case,
**only when the case was approved or sent to WordPress**. Everything else stays
text-only.

| Case outcome | Images after edition close |
|---|---|
| Approved or sent to WordPress | Reference image(s) of the verified look kept |
| Rejected / not the same / never opened | None — text + fingerprints only |
| Unsent draft in progress | Hot tier kept until grace period ends |

### Why this subset

- These are verified looks — the ones most likely to resurface as matches.
- They are a small fraction of everything collected.
- An editor has already checked their rights, so stored third-party images are
  limited to reviewed ones.

### Size

At ~150 KB per reference and, say, 3–10 approved cases a day, growth is roughly
**15–45 MB a month** — bounded and small, versus unbounded today.

### Changes

| Area | Change |
|---|---|
| Approval / draft send | Write the compressed reference image; store its path on `ArchiveEntry` |
| Purge job | Skip reference images |
| Collage render | Prefer reference image → re-fetch from permalink → editor upload |
| Backfill | Generate references for existing approved/sent cases before first purge |

### Verdict

With this in place the architecture is **better overall**: bounded storage,
viable cheap hosting, lower legal exposure, fewer wasted renders — while
protecting the matches that matter most. Without it, the redesign trades the
core feature for disk space that is cheap anyway.

Remaining tradeoffs accepted: more moving parts (purge, migration, re-fetch
states), a text-only audit trail for unapproved cases, slower first open, and
version history limited to the hot edition.

## 7. Next step: hosting scope

With images confined to the hot edition, re-check free hosting
(e.g. **Vercel** for web + **Supabase** for Postgres and object storage).
Questions to answer then:

- Where the hourly pull runs without an always-on worker
  (Vercel Cron, Supabase `pg_cron` + Edge Functions, GitHub Actions).
- Whether the Python API fits serverless limits (execution time, image
  processing with Pillow, cold starts) or needs a small free container.
- Whether Supabase Storage's free tier covers ~2 editions of images plus the
  growing reference set.
- Vercel Hobby's non-commercial terms vs. a client site.
