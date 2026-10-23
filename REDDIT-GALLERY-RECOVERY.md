# Recover incomplete Reddit galleries

Reddit can block server requests while RSS still supplies a cover photo. The studio
labels these imports incomplete and keeps Edit collage available. A code rollback
cannot restore images that Reddit has not supplied.

For local recovery, install the web dependencies with `npm ci`, then run
`node scripts/reddit-gallery.mjs` from `apps/web`. The collector reads the root `.env`;
set `HHC_ENV_FILE` to use another private environment file.

Use `node scripts/reddit-gallery.mjs --one` to test one post first.
If the editor has confirmed sign-in in this same local profile but Reddit's UI is
not recognized by the login detector, use `--confirmed-login` to resume the saved
session. This does not bypass Reddit access checks; blocked posts still stop capture.
Edge opens Reddit's login page with a separate local profile. The collector waits
for signed-in navigation before opening any post. Complete any Reddit verification
or sign-in yourself. The collector screenshots each visible photo inside that post's
carousel, using its Next control, and rebuilds incomplete posts from today and yesterday.
It excludes recommendations and stops on videos, missing controls, repeated slides,
or incomplete carousels. It does not depend on Reddit's JSON endpoint.
Captures exclude Reddit's navigation overlays and the padding around contained
photos. Shadow-root carousel controls and the declared slide count are checked.
It stops if Reddit still restricts access; it does not solve challenges or retry
through alternative hosts. The browser profile stays outside the repository.

Saved crops and layout options are preserved, newly recovered photos are appended,
and open editors receive a revision conflict instead of overwriting the recovery.
Posts with a WordPress handoff are skipped. If any photo download fails, the existing
collage and its editing state are retained. This is a manually launched recovery tool;
it is not an unattended background service or a cloud-compatible collector.
