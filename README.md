# High Heel Confidential — Outfit Research System

An automated editorial research system for celebrity outfit-repeat stories.
It ingests Reddit, creates one case per outfit, retains a searchable fashion
archive, and renders draft collages without requiring manual URL or image entry.

## Run

```powershell
Copy-Item .env.example .env
docker compose up --build
```

Open http://localhost:3100. API docs are at http://localhost:8100/docs.

For local testing, Docker enables a temporary demo login by default:
`hhc-demo` / `HHC-Demo-2026!`. Set `DEMO_LOGIN_ENABLED=false` before sharing or
deploying the application, then use the client WordPress Application Password.

With `REDDIT_SOURCE_MODE=rss`, the first launch immediately processes the live
`r/BollywoodFashion` feed. It then runs every day at the configured UTC time.
The **Run daily automation** control is an optional run-now trigger; it is not a
required editorial step. Repeated runs are idempotent, so the same Reddit post
is not imported twice.

For every eligible post, the runner:

1. Downloads the highest-resolution Reddit-hosted source available.
2. Uses both title and description to extract celebrity, designer, and event.
3. Searches the retained Reddit archive using title and description evidence,
   then requires matching designer, garment category, construction landmarks,
   and bounded image similarity. Explicit colour or garment conflicts reject
   a candidate instead of forcing a comparison.
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
