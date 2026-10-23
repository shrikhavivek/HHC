# Operations runbook

Read the root README for credentials, provider prerequisites and release gates.
Do not replace an existing .env with the example.

## Start and inspect

```powershell
docker compose up --build -d
docker compose ps
docker compose logs --tail 100 api web worker
```

UI: http://localhost:3100
Public API health: http://localhost:8100/health

API documentation, API reads and images require the internal editor API key.
The browser uses authenticated server-side proxy routes; do not put the key
in browser code or public environment variables.

The one-shot storage-init service assigns only the media/output volumes
to UID 10001. Existing files are retained. The API and worker run non-root.

## Daily refresh

Use Sources & schedule to inspect the worker heartbeat, configured providers,
upstream cooldowns and recent runs. Refresh now queues an edition. The dedicated
worker processes it; do not also enable SCHEDULER_IN_API in Compose.

A missing token or an upstream cooldown is not a successful extraction.
Respect the provider's retry window. Do not rotate proxies or identities.
An interrupted refresh can be queued again; imported posts are deduplicated.

## WordPress handoff

Use the client's WordPress Application Password and enable the handoff explicitly.
The application creates drafts, never published posts. Validate on a staging
site first. Never run browser acceptance tests against a live client workspace.

If the network result is uncertain, use Check previous handoff. Do not repeatedly
click Send or clear the database state without inspecting remote posts and media.
A matching post can be reconciled; an absent post requires administrator review.

## Test

```powershell
docker compose run --rm --no-deps -e DATABASE_URL=sqlite:////tmp/hhc-tests.db -e APP_ENV=development -e SCHEDULER_IN_API=false api pytest -q -p no:cacheprovider
cd apps/web
npm ci
npm run typecheck
npm run build
```

Browser acceptance tests need a separate disposable demo instance. See README
for HHC_TEST_BASE_URL and other test settings.

## Backup and production release

Back up PostgreSQL, output_data and media_data together and test restoration.
Render versions accumulate until archive purge is enabled. Keep
ARCHIVE_PURGE_ENABLED=false until archive entries exist for closed cases, then
enable it; after that, renders and source photos of closed editions are deleted.
The reference/ folder in media_data holds verified-look photos: back it up.
Keep provider credentials and SESSION_SECRET in the deployment secret store.

Before public access: configure HTTPS, production mode, strong secrets, a
non-default database password, disabled demo login, provider approvals, operational
alerts, backup restoration, and a source-removal process. Database changes in this
upgrade are additive tables; adopt reviewed migrations before further schema work.
The repository does not provision hosting, client permissions, backups or alerts.
