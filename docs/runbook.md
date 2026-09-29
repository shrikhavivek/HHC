# Operations runbook

## Start and inspect

```powershell
docker compose up --build -d
docker compose ps
docker compose logs --tail 100 api web
```

UI: http://localhost:3100  
API health: http://localhost:8100/health  
API documentation: http://localhost:8100/docs

## Test

```powershell
docker compose exec -T api pytest -q
docker compose build web
```

## Backup

Back up the `postgres_data` volume and `output_data` volume together. Evidence
records and generated bundles must remain version-aligned.

## Production changes required

Replace all example evidence, set a strong `EDITOR_API_KEY`, use managed
PostgreSQL and object storage, connect staff SSO, configure Secret Manager,
add an approved discovery provider, and apply database migrations with Alembic.

