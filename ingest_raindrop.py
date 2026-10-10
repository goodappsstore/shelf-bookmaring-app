#!/usr/bin/env python3
"""Import a Raindrop.io bookmarks CSV export into Shelf through its HTTP API."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit, urlunsplit
from urllib.request import Request, urlopen


DEFAULT_BASE_URL = "http://localhost:9876/api/v1"
BATCH_SIZE = 100
DEFAULT_TIMEOUT = 30.0


class ApiError(RuntimeError):
    """An HTTP or response-format error returned by Shelf."""

    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class ImportItem:
    """A validated CSV row and the URL key used to match Shelf bookmarks."""

    row_number: int
    url_key: str
    draft: dict[str, Any]


def request_json(
    base_url: str,
    path: str,
    *,
    method: str = "GET",
    payload: Any | None = None,
    timeout: float = DEFAULT_TIMEOUT,
) -> Any:
    """Send a JSON request to Shelf and return its decoded JSON response."""

    url = f"{base_url.rstrip('/')}/{path.lstrip('/')}"
    data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {"Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/json"

    request = Request(url, data=data, headers=headers, method=method)
    try:
        with urlopen(request, timeout=timeout) as response:
            status = getattr(response, "status", response.getcode())
            body = response.read()
    except HTTPError as error:
        body = error.read()
        raise ApiError(format_api_error(error.code, body), error.code) from error
    except (TimeoutError, URLError, OSError) as error:
        raise ApiError(f"could not reach {url}: {error}") from error

    if not 200 <= status < 300:
        raise ApiError(format_api_error(status, body), status)
    if not body:
        return None
    try:
        return json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ApiError(f"Shelf returned invalid JSON for {method} {path}") from error


def format_api_error(status: int, body: bytes) -> str:
    """Turn Shelf's JSON error shape, or a plain-text error, into a useful message."""

    try:
        decoded = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        decoded = None

    if isinstance(decoded, dict) and decoded.get("error"):
        return f"HTTP {status}: {decoded['error']}"
    text = body.decode("utf-8", errors="replace").strip()
    return f"HTTP {status}: {text or 'Shelf returned an error'}"


def optional_text(value: str | None) -> str | None:
    """Return a trimmed value, or None for an empty CSV field."""

    if value is None:
        return None
    value = value.strip()
    return value or None


def parse_tags(value: str | None) -> list[str]:
    """Split Raindrop's comma-separated tags and remove local duplicates."""

    tags: list[str] = []
    seen: set[str] = set()
    for raw_tag in (value or "").split(","):
        tag = raw_tag.strip().lstrip("#").lower()
        if tag and tag not in seen:
            seen.add(tag)
            tags.append(tag)
    return tags


def parse_bool(value: str | None) -> bool:
    """Parse the true/false values used by Raindrop CSV exports."""

    return (value or "").strip().lower() in {"1", "true", "yes", "y", "on"}


def canonical_url_key(raw_url: str) -> str | None:
    """Match Shelf's URL normalization for ordinary HTTP and HTTPS URLs."""

    value = raw_url.strip()
    if not value:
        return None
    if "://" not in value:
        value = f"https://{value}"

    try:
        parts = urlsplit(value)
        if parts.scheme.lower() not in {"http", "https"} or not parts.hostname:
            return None
        # Accessing port validates malformed values such as ``example.com:bad``.
        _ = parts.port
    except ValueError:
        return None

    # Shelf removes fragments and serializes an empty URL path as "/". Host names
    # and schemes are case-insensitive; paths and queries are intentionally kept.
    return urlunsplit(
        (
            parts.scheme.lower(),
            parts.netloc.lower(),
            parts.path or "/",
            parts.query,
            "",
        )
    )


def row_value(row: dict[str, str], *names: str) -> str:
    """Read the first non-empty column among a set of common aliases."""

    for name in names:
        value = row.get(name, "")
        if value.strip():
            return value.strip()
    return ""


def row_to_item(row_number: int, row: dict[str, str]) -> ImportItem | None:
    """Convert a normalized Raindrop CSV row to a Shelf bookmark draft."""

    raw_url = row_value(row, "url", "link", "uri")
    url_key = canonical_url_key(raw_url)
    if url_key is None:
        return None

    note = optional_text(row_value(row, "note", "notes"))
    highlights = optional_text(row_value(row, "highlights"))
    if highlights:
        note = f"{note}\n\nHighlights:\n{highlights}" if note else f"Highlights:\n{highlights}"

    draft: dict[str, Any] = {
        "url": raw_url,
        "tags": parse_tags(row.get("tags")),
        "favorite": parse_bool(row_value(row, "favorite", "favourite", "starred")),
        "archived": False,
        "archiveMode": "none",
    }

    optional_fields = {
        "title": optional_text(row_value(row, "title", "name")),
        "description": optional_text(row_value(row, "excerpt", "description", "summary")),
        "imageUrl": optional_text(row_value(row, "cover", "imageurl", "image")),
        "notes": note,
    }
    draft.update({key: value for key, value in optional_fields.items() if value is not None})
    return ImportItem(row_number=row_number, url_key=url_key, draft=draft)


def read_csv_items(path: Path) -> tuple[list[ImportItem], int]:
    """Read and validate the CSV, returning importable rows and skipped count."""

    items: list[ImportItem] = []
    skipped = 0
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as csv_file:
            reader = csv.DictReader(csv_file)
            if not reader.fieldnames:
                raise ValueError("CSV has no header row")
            headers = {header.strip().lower() for header in reader.fieldnames if header}
            if not headers.intersection({"url", "link", "uri"}):
                raise ValueError("CSV must contain a url, link, or uri column")

            for row_number, raw_row in enumerate(reader, start=2):
                row = {
                    str(key).strip().lower(): (value or "")
                    for key, value in raw_row.items()
                    if key is not None
                }
                if not any(value.strip() for value in row.values()):
                    continue
                item = row_to_item(row_number, row)
                if item is None:
                    print(f"Skipping row {row_number}: missing or invalid URL", file=sys.stderr)
                    skipped += 1
                else:
                    items.append(item)
    except csv.Error as error:
        raise ValueError(f"could not parse CSV: {error}") from error
    except OSError as error:
        raise ValueError(f"could not read CSV {path}: {error}") from error

    return items, skipped


def existing_bookmarks(base_url: str, timeout: float) -> dict[str, str]:
    """Load existing bookmarks so repeated imports do not create duplicates."""

    response = request_json(base_url, "/bookmarks", timeout=timeout)
    if not isinstance(response, list):
        raise ApiError("Shelf returned an unexpected response from GET /bookmarks")

    result: dict[str, str] = {}
    for bookmark in response:
        if not isinstance(bookmark, dict):
            continue
        bookmark_id = bookmark.get("id")
        url = bookmark.get("url")
        if isinstance(bookmark_id, str) and isinstance(url, str):
            key = canonical_url_key(url)
            if key is not None:
                result[key] = bookmark_id
    return result


def deduplicate_items(
    items: list[ImportItem],
    existing: dict[str, str],
) -> tuple[list[ImportItem], int]:
    """Remove duplicate CSV rows and URLs already present in Shelf."""

    unique: list[ImportItem] = []
    seen: set[str] = set()
    duplicates = 0
    for item in items:
        if item.url_key in seen:
            print(f"Skipping row {item.row_number}: duplicate URL in CSV", file=sys.stderr)
            duplicates += 1
        elif item.url_key in existing:
            print(f"Skipping row {item.row_number}: URL is already in Shelf", file=sys.stderr)
            duplicates += 1
        else:
            seen.add(item.url_key)
            unique.append(item)
    return unique, duplicates


def created_bookmark_ids(
    snapshot: Any,
    items: list[ImportItem],
    base_url: str,
    timeout: float,
) -> list[str]:
    """Find the generated Shelf IDs in the batch-create snapshot."""

    def bookmark_map(value: Any) -> dict[str, str]:
        if not isinstance(value, dict) or not isinstance(value.get("bookmarks"), list):
            return {}
        result: dict[str, str] = {}
        for bookmark in value["bookmarks"]:
            if not isinstance(bookmark, dict):
                continue
            bookmark_id = bookmark.get("id")
            url = bookmark.get("url")
            if isinstance(bookmark_id, str) and isinstance(url, str):
                key = canonical_url_key(url)
                if key is not None:
                    result[key] = bookmark_id
        return result

    by_url = bookmark_map(snapshot)
    missing = [item for item in items if item.url_key not in by_url]
    if missing:
        # This is only a defensive fallback for a non-standard server response.
        by_url = bookmark_map(
            {"bookmarks": request_json(base_url, "/bookmarks", timeout=timeout)}
        )

    unresolved = [item for item in items if item.url_key not in by_url]
    if unresolved:
        rows = ", ".join(str(item.row_number) for item in unresolved)
        raise ApiError(f"batch succeeded, but Shelf returned no ID for CSV row(s): {rows}")
    return [by_url[item.url_key] for item in items]


def refresh_metadata(base_url: str, bookmark_id: str, timeout: float) -> None:
    """Refresh one stored bookmark through Shelf's metadata endpoint."""

    encoded_id = quote(bookmark_id, safe="")
    request_json(base_url, f"/bookmarks/{encoded_id}/metadata", method="POST", timeout=timeout)


def run(csv_path: Path, base_url: str, timeout: float) -> int:
    """Import the CSV and return a process exit code."""

    items, skipped = read_csv_items(csv_path)
    if not items:
        print("No importable bookmarks were found.", file=sys.stderr)
        return 1

    existing = existing_bookmarks(base_url, timeout)
    items, duplicates = deduplicate_items(items, existing)
    if not items:
        print(
            f"Nothing to import. skipped={skipped} duplicates={duplicates}",
        )
        return 0 if skipped == 0 else 1

    print(f"Importing {len(items)} bookmark(s) in batches of {BATCH_SIZE}...")
    imported = 0
    metadata_refreshed = 0
    metadata_failed = 0

    for batch_start in range(0, len(items), BATCH_SIZE):
        batch = items[batch_start : batch_start + BATCH_SIZE]
        batch_number = batch_start // BATCH_SIZE + 1
        print(f"Creating batch {batch_number} ({len(batch)} bookmark(s))...", flush=True)
        try:
            snapshot = request_json(
                base_url,
                "/bookmarks/batch",
                method="POST",
                payload={"bookmarks": [item.draft for item in batch]},
                timeout=timeout,
            )
            bookmark_ids = created_bookmark_ids(snapshot, batch, base_url, timeout)
        except ApiError as error:
            print(f"Batch {batch_number} failed: {error}", file=sys.stderr)
            return 1

        imported += len(batch)
        for item, bookmark_id in zip(batch, bookmark_ids):
            print(f"Refreshing metadata for row {item.row_number}...", flush=True)
            try:
                refresh_metadata(base_url, bookmark_id, timeout)
            except ApiError as error:
                metadata_failed += 1
                print(
                    f"Metadata refresh failed for row {item.row_number} ({bookmark_id}): {error}",
                    file=sys.stderr,
                )
            else:
                metadata_refreshed += 1

    print(
        "Done. "
        f"imported={imported} "
        f"skipped={skipped} "
        f"duplicates={duplicates} "
        f"metadata_refreshed={metadata_refreshed} "
        f"metadata_failed={metadata_failed}"
    )
    return 1 if skipped or metadata_failed else 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Import a Raindrop.io bookmarks CSV export into Shelf."
    )
    parser.add_argument("csv_file", type=Path, help="path to the Raindrop.io CSV export")
    parser.add_argument(
        "--base-url",
        default=DEFAULT_BASE_URL,
        help=f"Shelf API base URL (default: {DEFAULT_BASE_URL})",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=DEFAULT_TIMEOUT,
        help=f"per-request timeout in seconds (default: {DEFAULT_TIMEOUT:g})",
    )
    args = parser.parse_args(argv)
    if args.timeout <= 0:
        parser.error("--timeout must be greater than zero")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        return run(args.csv_file, args.base_url, args.timeout)
    except (ApiError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
