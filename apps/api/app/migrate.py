"""Create tables and refresh stored data once per deploy: python -m app.migrate.

Serverless instances set RUN_STARTUP_TASKS=false so cold starts skip this work.
"""
import logging

from .main import run_startup_tasks

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    run_startup_tasks()
    logging.getLogger(__name__).info("Database is up to date")
