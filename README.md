# High Heel Confidential — Outfit Research System

An automated editorial research system for celebrity outfit-repeat stories.
It ingests Reddit automatically, accepts editor-selected public social-post
URLs, retains a searchable fashion archive, and renders editable draft collages.

## Run

```powershell
Copy-Item .env.example .env
docker compose up --build
```

Open http://localhost:3100. API docs are at http://localhost:8100/docs.

For local testing, Docker enables a temporary demo login by default:
`hhc-demo` / `HHC-Demo-2026!`. Set `DEMO_LOGIN_ENABLED=false` before sharing or
deploying the application, then use the client WordPress Application Password.

With `REDDIT_SOURCE_MODE=rss`, the first launch immediately processes every
image post published that calendar day in `r/BollywoodFashion`. Intake follows
Reddit listing pages until it crosses the day boundary; it is not capped at a
fixed number of posts. The default source calendar is `Asia/Kolkata`, configured
with `REDDIT_DAILY_TIMEZONE`. It then runs every day at the configured UTC time.
The **Run daily automation** control is an optional run-now trigger; it is not a
required editorial step. Repeated runs are idempotent, so the same Reddit post
is not imported twice.

Editors can also choose **Import post URL** and paste a public Instagram,
Threads, Facebook, X, Pinterest, TikTok, YouTube, or Reddit post. The importer
uses only title, caption, author, date, and images exposed by the public page;
private or login-gated content is rejected. Optional celebrity, designer,
event, title, and description hints can correct sparse source metadata. The
result enters the same archive-search, matching, collage, rights, and editing
workflow as an automated Reddit case. A source that exposes only its cover
image creates a one-image draft; editors can then add properly credited images
manually instead of the system inventing or scraping unrelated panels.

For every eligible post, the runner:

1. Downloads the highest-resolution Reddit-hosted source available.
2. Uses title, description, gallery captions, social handles, and known aliases
   to extract celebrity, designer, event, and Women/Men/Both classification.
3. Searches the complete retained archive and up to 100 all-time Reddit search
   results using title and description evidence; there is no age or year cutoff.
   It then requires matching designer, garment category, construction landmarks,
   and bounded image similarity. Explicit colour or garment conflicts reject a
   candidate instead of forcing a comparison.
4. Creates a multi-image collage when exact supporting sources qualify, or an
   honest source-only editorial layout when no exact match exists.
5. Stores a full-resolution WebP/PNG, source manifest, and ZIP evidence bundle.

Live media is stored in the persistent `media_data` Docker volume and generated
bundles in `output_data`, so rebuilding containers does not remove them. Once
live results exist, seeded visual placeholders are automatically excluded from
the dashboard.

Official designer-model references are also automatic when `SERPAPI_KEY` is
configured. The provider first resolves the designer's official domain, then
accepts only an exact-context image whose source page is on that domain. If the
provider is absent or evidence is weak, the panel is omitted—never replaced by
a stock image or placeholder.

## Editorial workspaces

- **Today's edit** shows the complete working edition.
- **Women's fashion** lists women-led and mixed-celebrity posts.
- **Men's fashion** lists men-led and mixed-celebrity posts.
- **Review queue** includes every case requiring context, research, or a final
  editor decision.
- **Fashion archive** contains approved and closed outfit stories.
- **Rights desk** exposes panel-level source, official-reference, exact-match,
  and image-rights status.

Use the global search field (or press `/`) to find a celebrity, designer, event,
or relationship. Approved stories open an in-app collage preview with links to
the full-resolution image and evidence bundle.

Every generated draft also has an **Edit collage** control. Editors can
reorder panels, remove a poor image, or replace it with another source-backed
current angle, historical match, or verified designer reference. A tuning
control on every selected panel can make it narrower or wider, keep the whole
photo visible, or open a freeform manual cropper. In crop mode, draw a rectangle
around the model, move it, and resize its width and height independently using
eight edge and corner handles. Everything outside the selected rectangle is
excluded from the rendered panel. The selected order and per-image layout are
stored on the case, each save creates an audit event, and the app re-renders
the preview and evidence bundle without publishing to WordPress or changing
the source image.

Editors can also upload a JPEG, PNG, or WebP directly inside the collage
editor. Uploads preserve normal source resolution, require a credit and usage
confirmation, remain visibly unverified, and are not included until the editor
selects them. Fashion-section assignments are inferred from explicit title and
description evidence and can be corrected to Women, Men, or Both on each case.

The collage editor also supports an optional client-authorized HHC watermark.
Upload a transparent PNG or WebP, drag it anywhere on the collage, resize it
from its handles, tilt it with the rotation handle, and adjust width, height,
opacity, or angle with precision sliders. Side handles resize width, top and
bottom handles resize height, and corner handles change both dimensions.
Watermark width and height can each reach 100% of the collage canvas. The
placement is stored as normalized
coordinates, so the same transform is applied to the full-resolution PNG and
WebP rather than only to the browser preview. Editors can hide, restore, reset,
or replace the mark without changing its source file. A separate unwatermarked
preview is retained for editing; the downloadable evidence bundle contains the
finished branded render and records all watermark settings in its manifest.

The editor includes reversible colour controls for both the complete collage
and the watermark independently. Editors can start from Original, Editorial,
Soft, Vivid, or Mono presets, then fine-tune brightness, contrast, saturation,
and grayscale strength. The browser preview and full-resolution export use the
same saved values. An untouched assembled preview is retained so reopening an
edit never applies a filter twice, and all adjustment values are included in
the manifest and audit trail.

Each case represents one outfit. Its collage can combine the current Reddit
appearance, qualified earlier wearers, same-post angles, and an exact-garment
image from an official designer campaign or lookbook. Unverified designer
images are never replaced with placeholders. Images are fitted without
cropping by default; an editor may explicitly opt into a reversible crop for a
specific panel. Every output bundle includes panel-level source, credit,
retrieval date, source grade, rights metadata, and saved layout settings.

## Safety invariants

- `AUTO_APPROVE=false` is enforced by the API.
- WordPress publishing is disabled until the client supplies an Application
  Password. The automatic output remains a local draft bundle in the meantime.
- Daily collages are visibly labelled `AUTOMATED DRAFT`; automation does not
  silently turn a research signal into an editorial approval.
- Assets marked `do_not_use` are blocked from rendering.
- Designer imagery is supplementary evidence and never bypasses identity or
  rights review.
- Every decision and render is appended to the audit log.
