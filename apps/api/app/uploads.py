"""Files sent straight to storage instead of through the API request.

Serverless requests are capped at 4.5 MB, so in Supabase mode the browser and
the Instagram collector ask for upload links, put each file in the bucket and
send only its key. StagedUpload reads it back like a FastAPI UploadFile.
"""
import asyncio
import json
from pathlib import Path

from fastapi import HTTPException, UploadFile

from .storage import get_storage

MAX_STAGED_UPLOADS = 20


class StagedUpload:
    def __init__(self, key: str, filename: str = ""):
        self.key, self.filename = key, Path(filename or "upload").name[:180]

    async def read(self, size: int = -1) -> bytes:
        try:
            content = await asyncio.to_thread(get_storage().take_incoming, self.key)
        except FileNotFoundError as exc:
            raise HTTPException(422, str(exc)) from exc
        return content if size < 0 else content[:size]

    async def close(self) -> None:
        pass


def staged_uploads(keys: str, names: str = "") -> list[StagedUpload]:
    """Parse the JSON key (and optional filename) lists sent with a form."""
    try:
        parsed = json.loads(keys) if keys else []
        filenames = json.loads(names) if names else []
    except json.JSONDecodeError as exc:
        raise HTTPException(422, "Upload keys must be a JSON list") from exc
    if not isinstance(parsed, list) or not all(isinstance(key, str) for key in parsed) or len(parsed) > MAX_STAGED_UPLOADS:
        raise HTTPException(422, "Upload keys must be a list of at most 20 keys")
    filenames = filenames if isinstance(filenames, list) else []
    return [StagedUpload(key, str(filenames[index]) if index < len(filenames) else "") for index, key in enumerate(parsed)]


def one_upload(image: UploadFile | None, keys: str, names: str = "") -> UploadFile | StagedUpload:
    if image is not None:
        return image
    staged = staged_uploads(keys, names)
    if len(staged) != 1:
        raise HTTPException(422, "Choose an image to upload")
    return staged[0]
