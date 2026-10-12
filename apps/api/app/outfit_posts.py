import re
from functools import lru_cache

from PIL import Image, ImageOps, ImageStat

from .automation import UNKNOWN_VALUES, _canonical, _cosine, _local_media_path, parse_outfit


def _person(case) -> str:
    person = _canonical(case.celebrity)
    if re.search(r"\s(?:for|at|during)\s", person) and not (case.extraction or {}).get("context_verified"):
        person = _canonical(parse_outfit(case.source_title, case.source_body)["celebrity"])
    return "" if person in UNKNOWN_VALUES or len(person.split()) < 2 else person


def _photos(case) -> set[str]:
    extraction = case.extraction or {}
    paths = {case.base_image}
    paths.update(
        asset.get("image_path")
        for asset in extraction.get("collage_assets", [])
        if isinstance(asset, dict) and asset.get("role") in {"current_primary", "current_angle"}
    )
    return {path for path in paths if isinstance(path, str) and path.startswith("/media-files/")}


@lru_cache(maxsize=1024)
def _photo_signature(path: str, modified: int, size: int):
    try:
        with Image.open(path) as source:
            image = ImageOps.exif_transpose(source).convert("RGB")
        try:
            ratio = image.width / max(1, image.height)
            image.thumbnail((128, 128), Image.Resampling.LANCZOS)
            with image.convert("L") as gray:
                if ImageStat.Stat(gray).stddev[0] < 12:
                    return None
                with gray.resize((9, 8), Image.Resampling.LANCZOS) as reduced:
                    pixels = list(reduced.getdata())
                fingerprint = 0
                for row in range(8):
                    for column in range(8):
                        fingerprint = (fingerprint << 1) | int(pixels[row * 9 + column] > pixels[row * 9 + column + 1])
            histogram = image.histogram()
            colors = [sum(histogram[channel * 256 + bucket * 16:channel * 256 + (bucket + 1) * 16]) for channel in range(3) for bucket in range(16)]
            return ratio, fingerprint, colors
        finally:
            image.close()
    except (OSError, ValueError, Image.DecompressionBombError):
        return None


def _signatures(paths: set[str], media_dir: str) -> list[tuple]:
    signatures = []
    for image_path in sorted(paths):
        path = _local_media_path(image_path, media_dir)
        if path is None:
            continue
        try:
            stat = path.stat()
        except OSError:
            continue
        signature = _photo_signature(str(path), stat.st_mtime_ns, stat.st_size)
        if signature is not None:
            signatures.append(signature)
    return signatures


def _same_photos(left, right, media_dir: str) -> bool:
    left_paths, right_paths = _photos(left), _photos(right)
    if left_paths & right_paths:
        return True
    left_signatures = _signatures(left_paths, media_dir)
    right_signatures = _signatures(right_paths, media_dir)
    for left_ratio, left_hash, left_colors in left_signatures:
        for right_ratio, right_hash, right_colors in right_signatures:
            if abs(left_ratio / right_ratio - 1) > 0.02:
                continue
            if (left_hash ^ right_hash).bit_count() <= 2 and _cosine(left_colors, right_colors) >= 0.995:
                return True
    return False


def _priority(case) -> tuple:
    extraction = case.extraction or {}
    edited = bool(extraction.get("collage_edit") or extraction.get("context_verified"))
    return edited, len(_photos(case)), str(case.created_at), case.id


def group_outfit_posts(cases, media_dir: str) -> list[list]:
    """Present reposted photographs once without deleting source posts or edits."""
    groups = []
    by_person: dict[str, list[list]] = {}
    for case in sorted(cases, key=_priority, reverse=True):
        person = _person(case) if not case.demo_data else ""
        matches = by_person.get(person, []) if person else []
        group = next((group for group in matches if _same_photos(case, group[0], media_dir)), None)
        if group is not None:
            group.append(case)
        else:
            group = [case]
            groups.append(group)
            if person:
                by_person.setdefault(person, []).append(group)
    order = {case.id: index for index, case in enumerate(cases)}
    return sorted(groups, key=lambda group: min(order[case.id] for case in group))
