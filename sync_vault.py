"""Upsert albums.json into Firestore."""

import argparse
import copy
import json
import math
import os
import re
import sys
import tempfile
from pathlib import Path

import firebase_admin
import spotipy
from dotenv import load_dotenv
from firebase_admin import credentials, firestore
from google.api_core.exceptions import GoogleAPICallError
from spotipy.exceptions import SpotifyException
from spotipy.oauth2 import SpotifyClientCredentials

load_dotenv()

FIREBASE_KEY_PATH = "serviceAccountKey.json"
ALBUMS_JSON_PATH = "albums.json"
BATCH_SIZE = 450
db = None
sp = None


def initialize_services():
    global db, sp

    if not firebase_admin._apps:
        try:
            cred = credentials.Certificate(FIREBASE_KEY_PATH)
            firebase_admin.initialize_app(cred)
        except (OSError, ValueError) as exc:
            raise RuntimeError(f"Could not initialize Firebase: {exc}") from exc

    db = firestore.client()

    client_id = os.getenv("SPOTIPY_CLIENT_ID")
    client_secret = os.getenv("SPOTIPY_CLIENT_SECRET")
    if client_id and client_secret:
        auth_manager = SpotifyClientCredentials(
            client_id=client_id,
            client_secret=client_secret
        )
        sp = spotipy.Spotify(
            client_credentials_manager=auth_manager,
            retries=5,
            status_retries=5,
            backoff_factor=0.5
        )
    else:
        sp = None
        print("Warning: Spotify credentials not set. Missing tracklists cannot be fetched.")


def extract_spotify_album_id(url_or_id):
    if not url_or_id:
        return None
    match = re.search(r"album[/:]([a-zA-Z0-9]+)", str(url_or_id))
    if match:
        return match.group(1)
    if len(str(url_or_id)) == 22 and str(url_or_id).isalnum():
        return str(url_or_id)
    return None


def is_tracks_valid(tracks, album=None):
    if not tracks or not isinstance(tracks, list):
        return False

    for track in tracks:
        if not isinstance(track, dict):
            return False
        name = str(track.get("name", "")).strip()
        if not name:
            return False
        if re.match(r"^Track\s+\d+$", name, re.IGNORECASE):
            is_charli_pop_2_track_10 = (
                str((album or {}).get("artist", "")).strip().casefold() == "charli xcx"
                and str((album or {}).get("album_name", "")).strip().casefold() == "pop 2"
                and int(track.get("track_number", 0) or 0) == 10
                and name.casefold() == "track 10"
            )
            if not is_charli_pop_2_track_10:
                return False

    return True


def fetch_spotify_tracks(spotify_url, existing_tracks=None, album=None):
    rating_map = {}
    if isinstance(existing_tracks, list):
        for idx, track in enumerate(existing_tracks):
            if isinstance(track, dict):
                number = track.get("track_number", idx + 1)
                rating_map[number] = track.get("rating", 0)

    spotify_album_id = extract_spotify_album_id(spotify_url)
    if sp is None:
        raise RuntimeError("Spotify credentials are required to fetch real track names.")
    if not spotify_album_id:
        raise RuntimeError(f"Could not find a Spotify album ID in {spotify_url!r}.")

    try:
        results = sp.album_tracks(spotify_album_id)
        items = results.get("items", [])
        while results.get("next"):
            results = sp.next(results)
            items.extend(results.get("items", []))
    except SpotifyException as exc:
        raise RuntimeError(f"Spotify could not fetch album {spotify_album_id}: {exc}") from exc

    built_tracks = []
    for item in items:
        track_number = item.get("track_number", len(built_tracks) + 1)
        built_tracks.append({
            "track_number": track_number,
            "name": item.get("name", ""),
            "duration_ms": item.get("duration_ms", 0),
            "rating": rating_map.get(track_number, 0)
        })
    if not is_tracks_valid(built_tracks, album):
        raise RuntimeError(f"Spotify returned no complete track names for album {spotify_album_id}.")
    return built_tracks


def chunked(items, size):
    for start in range(0, len(items), size):
        yield items[start:start + size]


def find_existing_docs(album_ids):
    existing_docs = {}
    refs = [db.collection("albums").document(album_id) for album_id in album_ids]
    for ref_batch in chunked(refs, BATCH_SIZE):
        for doc in db.get_all(ref_batch):
            if doc.exists:
                existing_docs[doc.id] = {
                    "ref": doc.reference,
                    "data": doc.to_dict() or {}
                }
    return existing_docs


def find_existing_docs_by_record_id():
    existing_docs = {}
    for doc in db.collection("albums").stream():
        data = doc.to_dict() or {}
        entry = {"ref": doc.reference, "data": data}
        keys = {doc.id}
        record_id = str(data.get("id", "")).strip()
        if record_id:
            keys.add(record_id)
        for key in keys:
            existing_entry = existing_docs.get(key)
            if existing_entry and existing_entry["ref"] != doc.reference:
                raise RuntimeError(f"Multiple Firestore albums match catalog ID {key!r}.")
            existing_docs[key] = entry
    return existing_docs


def find_existing_docs_for_albums(albums):
    collection = db.collection("albums")
    requested_ids = set()
    record_ids = set()
    for album in albums:
        album_id = str(album.get("id", "")).strip()
        spotify_id = extract_spotify_album_id(album.get("spotify_url"))
        if album_id:
            requested_ids.add(album_id)
            record_ids.add(album_id)
        if spotify_id:
            requested_ids.add(spotify_id)

    docs_by_path = {}
    refs = [collection.document(album_id) for album_id in requested_ids]
    for ref_batch in chunked(refs, BATCH_SIZE):
        for doc in db.get_all(ref_batch):
            if doc.exists:
                docs_by_path[doc.reference.path] = doc

    for ids in chunked(sorted(record_ids), 30):
        for doc in collection.where("id", "in", ids).stream():
            docs_by_path[doc.reference.path] = doc

    numeric_ids = []
    for record_id in record_ids:
        if record_id.isdecimal():
            numeric_ids.append(int(record_id))
    for ids in chunked(numeric_ids, 30):
        if ids:
            for doc in collection.where("id", "in", ids).stream():
                docs_by_path[doc.reference.path] = doc

    existing_docs = {}
    for doc in docs_by_path.values():
        data = doc.to_dict() or {}
        entry = {"ref": doc.reference, "data": data}
        aliases = {doc.id}
        stored_id = str(data.get("id", "")).strip()
        if stored_id:
            aliases.add(stored_id)
        spotify_id = extract_spotify_album_id(data.get("spotify_url"))
        if spotify_id:
            aliases.add(spotify_id)
        for alias in aliases:
            previous = existing_docs.get(alias)
            if previous and previous["ref"].path != doc.reference.path:
                raise RuntimeError(
                    f"Multiple Firestore albums match catalog ID {alias!r}; "
                    "resolve the duplicate documents before syncing."
                )
            existing_docs[alias] = entry
    return existing_docs


def find_album_document(album, existing_docs):
    album_id = str(album.get("id", "")).strip()
    spotify_id = extract_spotify_album_id(album.get("spotify_url"))
    matches = {
        existing_docs[alias]["ref"].path: existing_docs[alias]
        for alias in (album_id, spotify_id)
        if alias and alias in existing_docs
    }
    if len(matches) > 1:
        raise RuntimeError(
            f"Catalog album {album.get('album_name', album_id)!r} matches multiple "
            "Firestore documents by ID/Spotify URL."
        )
    return next(iter(matches.values()), None)


def build_new_record(album, metadata, tracks):
    duration = sum(track.get("duration_ms", 0) or 0 for track in tracks)
    return {
        **metadata,
        "tier": album.get("tier", "Unranked"),
        "rating": album.get("rating", 0.0),
        "lists": album.get("lists", []),
        "tracks": tracks,
        "total_tracks": len(tracks) if tracks else metadata["total_tracks"],
        "duration_ms": duration or metadata["duration_ms"],
    }


def load_local_albums(path):
    try:
        with open(path, "r", encoding="utf-8") as file:
            albums = json.load(file)
    except FileNotFoundError as exc:
        raise FileNotFoundError(f"{path} not found. Run get_data.py first.") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"{path} contains invalid JSON: {exc}") from exc

    if isinstance(albums, dict):
        albums = albums.get("albums")
    if not isinstance(albums, list) or any(not isinstance(album, dict) for album in albums):
        raise ValueError(f"{path} must contain a JSON array of album objects.")
    return albums


def commit_writes(writes):
    for write_batch in chunked(writes, BATCH_SIZE):
        batch = db.batch()
        for doc_ref, payload in write_batch:
            batch.set(doc_ref, payload, merge=True)
        batch.commit()


def track_key(track, index):
    disc = int(track.get("disc_number", 1) or 1)
    number = int(track.get("track_number", index + 1) or index + 1)
    return disc, number


def build_rankings_payload(album, remote_data):
    payload = {}
    for field, default in (("tier", "Unranked"), ("rating", 0.0), ("lists", [])):
        if field not in album:
            continue
        value = album[field]
        if field == "tier" and value not in {"S", "A", "B", "C", "D", "Unranked"}:
            raise ValueError(f"Album {album.get('id')!r} has an invalid tier.")
        if field == "rating":
            try:
                value = float(value)
            except (TypeError, ValueError) as exc:
                raise ValueError(f"Album {album.get('id')!r} has an invalid rating.") from exc
            if not math.isfinite(value) or not 0 <= value <= 10:
                raise ValueError(f"Album {album.get('id')!r} has an invalid rating.")
        if field == "lists" and (
            not isinstance(value, list) or any(not isinstance(name, str) for name in value)
        ):
            raise ValueError(f"Album {album.get('id')!r} has invalid lists.")
        if value != remote_data.get(field, default):
            payload[field] = value

    local_tracks = album.get("tracks")
    remote_tracks = remote_data.get("tracks")
    if not isinstance(local_tracks, list) or not isinstance(remote_tracks, list):
        return payload

    ratings_by_key = {}
    for index, track in enumerate(local_tracks):
        if not isinstance(track, dict) or "rating" not in track:
            continue
        try:
            rating = float(track["rating"] or 0)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"Album {album.get('id')!r} has an invalid track rating.") from exc
        if not math.isfinite(rating) or not 0 <= rating <= 10:
            raise ValueError(f"Album {album.get('id')!r} has an invalid track rating.")
        ratings_by_key[track_key(track, index)] = rating

    if ratings_by_key:
        updated_tracks = copy.deepcopy(remote_tracks)
        changed = False
        for index, track in enumerate(updated_tracks):
            if not isinstance(track, dict):
                continue
            key = track_key(track, index)
            if key not in ratings_by_key:
                continue
            rating = ratings_by_key[key]
            if (float(track.get("rating", 0) or 0)) != rating:
                track["rating"] = rating
                changed = True
        if changed:
            payload["tracks"] = updated_tracks
    return payload


def run_rankings_sync(albums_path, dry_run=False):
    local_albums = load_local_albums(albums_path)
    seen_ids = set()
    for index, album in enumerate(local_albums):
        album_id = str(album.get("id", "")).strip()
        if not album_id:
            raise ValueError(f"Album at index {index} is missing a non-empty id in {albums_path}.")
        if album_id in seen_ids:
            raise ValueError(f"Duplicate album id {album_id!r} in {albums_path}.")
        seen_ids.add(album_id)

    initialize_services()
    docs_by_id = {}
    aliases = {}
    for snapshot in db.collection("albums").stream():
        data = snapshot.to_dict() or {}
        entry = {"ref": snapshot.reference, "data": data}
        docs_by_id[snapshot.id] = entry
        record_id = str(data.get("id", "")).strip()
        spotify_id = extract_spotify_album_id(data.get("spotify_url"))
        for alias in {record_id, spotify_id} - {"", None}:
            aliases.setdefault(alias, {})[snapshot.reference.path] = entry

    writes = []
    missing_count = 0
    unchanged_count = 0
    track_update_count = 0
    field_counts = {}
    for album in local_albums:
        album_id = str(album["id"]).strip()
        entry = docs_by_id.get(album_id)
        if entry is None:
            candidates = {}
            for alias in (album_id, extract_spotify_album_id(album.get("spotify_url"))):
                if alias:
                    candidates.update(aliases.get(alias, {}))
            if len(candidates) > 1:
                raise RuntimeError(
                    f"Album {album.get('album_name', album_id)!r} does not identify a unique "
                    "Firestore document. No writes were made."
                )
            entry = next(iter(candidates.values()), None)
        if entry is None:
            missing_count += 1
            continue
        payload = build_rankings_payload(album, entry["data"])
        if not payload:
            unchanged_count += 1
            continue
        for field in payload:
            field_counts[field] = field_counts.get(field, 0) + 1
        if "tracks" in payload:
            track_update_count += 1
        writes.append((entry["ref"], payload))

    if writes and not dry_run:
        commit_writes(writes)

    print("\nRANKINGS-ONLY SYNC SUMMARY:")
    print(f"  Albums checked: {len(local_albums)}")
    print(f"  Albums updated: {len(writes)}")
    print(f"  Track-score records updated: {track_update_count}")
    print(f"  Albums unchanged: {unchanged_count}")
    print(f"  Albums not found (not created): {missing_count}")
    print("  Fields updated: " + (", ".join(
        f"{field}={count}" for field, count in sorted(field_counts.items())
    ) or "none"))
    if dry_run:
        print("  Dry run: no Firestore writes made")
    if missing_count:
        raise RuntimeError(f"{missing_count} backup album(s) were not found in Firestore.")


def write_retry_report(path, albums, failures):
    destination = Path(path)
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=destination.parent,
            prefix=f".{destination.name}.",
            suffix=".tmp",
            delete=False,
        ) as file:
            temporary_path = file.name
            json.dump({"albums": albums, "failures": failures}, file, indent=2)
            file.write("\n")
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary_path, destination)
    except OSError:
        if temporary_path and os.path.exists(temporary_path):
            os.unlink(temporary_path)
        raise


def run_sync(
    albums_path=ALBUMS_JSON_PATH,
    include_rankings=False,
    refresh_tracks=False,
    dry_run=False,
    retry_file="sync-retry.json",
):
    local_albums = load_local_albums(albums_path)
    seen_ids = set()
    for index, album in enumerate(local_albums):
        album_id = str(album.get("id", "")).strip()
        if not album_id:
            raise ValueError(f"Album at index {index} is missing a non-empty id in {albums_path}.")
        if album_id in seen_ids:
            raise ValueError(f"Duplicate album id {album_id!r} in {albums_path}.")
        seen_ids.add(album_id)

    initialize_services()
    album_ids = [str(album["id"]).strip() for album in local_albums]
    print("Fetching existing albums from Firestore...")
    existing_docs = find_existing_docs_by_record_id() if refresh_tracks else None
    if not refresh_tracks:
        existing_docs = find_existing_docs_for_albums(local_albums)

    created_count = 0
    updated_count = 0
    skipped_count = 0
    pending_writes = []
    retry_albums = []
    failures = []
    fetch_count = 0
    track_failures = 0
    batch_failures = 0

    def flush_pending_writes():
        nonlocal batch_failures, created_count, updated_count
        if not pending_writes or dry_run:
            return
        try:
            commit_writes([(ref, payload) for ref, payload, _, _ in pending_writes])
        except (GoogleAPICallError, TimeoutError) as exc:
            batch_failures += 1
            for _, _, album, action in pending_writes:
                if action == "created":
                    created_count -= 1
                else:
                    updated_count -= 1
                retry_albums.append(album)
                failures.append({
                    "id": str(album.get("id", "")),
                    "album_name": album.get("album_name", "Unknown Album"),
                    "reason": f"Firestore batch failed: {exc}",
                })
        pending_writes.clear()

    print(f"Processing {len(local_albums)} albums from {albums_path}...\n")

    for index, album in enumerate(local_albums, start=1):
        album_id = str(album["id"]).strip()
        album_name = album.get("album_name", "Unknown Album")
        spotify_url = album.get("spotify_url", "")
        total_tracks = int(album.get("total_tracks", 0) or 0)
        canonical_id = extract_spotify_album_id(spotify_url) or album_id
        if index == 1 or index % 25 == 0 or index == len(local_albums):
            print(f"Progress: {index}/{len(local_albums)} albums")

        metadata = {
            "id": canonical_id,
            "album_name": album_name,
            "artist": album.get("artist", "Unknown Artist"),
            "release_date": album.get("release_date", ""),
            "total_tracks": total_tracks,
            "duration_ms": album.get("duration_ms", 0),
            "label": album.get("label", "Unknown"),
            "spotify_url": spotify_url,
            "thumbnail_url": album.get("thumbnail_url", "")
        }

        doc_entry = (
            existing_docs.get(album_id)
            if refresh_tracks
            else find_album_document(album, existing_docs)
        )
        if doc_entry:
            remote_data = doc_entry["data"]
            metadata["id"] = doc_entry["ref"].id
            update_payload = {} if refresh_tracks else {
                key: value for key, value in metadata.items()
                if remote_data.get(key) != value
            }

            remote_tracks = remote_data.get("tracks")
            local_tracks = album.get("tracks")
            if include_rankings:
                for key in ("tier", "rating", "lists"):
                    if key in album and remote_data.get(key) != album[key]:
                        update_payload[key] = album[key]
                if not refresh_tracks and is_tracks_valid(local_tracks, album) and remote_tracks != local_tracks:
                    update_payload["tracks"] = local_tracks
                    update_payload["total_tracks"] = len(local_tracks)
                    track_duration = sum(track.get("duration_ms", 0) or 0 for track in local_tracks)
                    if track_duration:
                        update_payload["duration_ms"] = track_duration

            needs_tracks = refresh_tracks or (
                "tracks" not in update_payload and not is_tracks_valid(remote_tracks, album)
            )
            if needs_tracks and dry_run:
                fetch_count += 1
            elif needs_tracks:
                print(f"[*] Fetching real tracks for: {album_name}")
                try:
                    fresh_tracks = fetch_spotify_tracks(
                        spotify_url or remote_data.get("spotify_url", ""),
                        remote_tracks,
                        album,
                    )
                except RuntimeError as exc:
                    track_failures += 1
                    retry_albums.append(album)
                    failures.append({
                        "id": album_id,
                        "album_name": album_name,
                        "reason": str(exc),
                    })
                else:
                    if fresh_tracks != remote_tracks:
                        update_payload["tracks"] = fresh_tracks
                        update_payload["total_tracks"] = len(fresh_tracks)
                        duration = sum(track.get("duration_ms", 0) or 0 for track in fresh_tracks)
                        if duration:
                            update_payload["duration_ms"] = duration

            if update_payload:
                print(f"[UPDATED] {album_name} (Fields: {', '.join(update_payload.keys())})")
                updated_count += 1
                pending_writes.append((doc_entry["ref"], update_payload, album, "updated"))
                if len(pending_writes) >= BATCH_SIZE:
                    flush_pending_writes()
            else:
                skipped_count += 1
        else:
            if refresh_tracks:
                reason = f"Album ID {album_id} was not found in Firestore."
                track_failures += 1
                retry_albums.append(album)
                failures.append({
                    "id": album_id,
                    "album_name": album_name,
                    "reason": reason,
                })
                print(f"[FAILED] {album_name}: {reason}")
                continue
            if dry_run:
                created_count += 1
                fetch_count += 1
                continue
            print(f"[NEW] Creating record and fetching tracks for: {album_name}")
            local_tracks = album.get("tracks")
            try:
                tracks = (
                    local_tracks
                    if include_rankings and not refresh_tracks and is_tracks_valid(local_tracks, album)
                    else fetch_spotify_tracks(spotify_url, album=album)
                )
            except RuntimeError as exc:
                track_failures += 1
                retry_albums.append(album)
                failures.append({
                    "id": album_id,
                    "album_name": album_name,
                    "reason": str(exc),
                })
                print(f"[FAILED] {album_name}: {exc}")
                continue
            doc_ref = db.collection("albums").document(canonical_id)
            payload = build_new_record(album, metadata, tracks)
            pending_writes.append((doc_ref, payload, album, "created"))
            created_count += 1
            if len(pending_writes) >= BATCH_SIZE:
                flush_pending_writes()

    flush_pending_writes()

    print("\n" + "=" * 40)
    print("SYNC SUMMARY:")
    print(f"  Created: {created_count}")
    print(f"  Updated: {updated_count}")
    print(f"  Unchanged (Skipped): {skipped_count}")
    print(f"  Track fetch failures: {track_failures}")
    print(f"  Firestore batch failures: {batch_failures}")
    if dry_run:
        print(f"  Dry run: no writes made ({fetch_count} tracklists would be fetched)")
    print("=" * 40)
    if retry_albums:
        write_retry_report(retry_file, retry_albums, failures)
        print(f"Retry {len(retry_albums)} failed album(s) with: --input {retry_file}")
    if failures:
        raise RuntimeError(
            f"{len(failures)} album operation(s) failed. See {retry_file} for retryable records."
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Sync a Music Vault catalog or exported backup to Firestore.")
    parser.add_argument(
        "--input",
        default=ALBUMS_JSON_PATH,
        help="JSON catalog or exported Music Vault backup file (default: albums.json)."
    )
    parser.add_argument(
        "--include-rankings",
        action="store_true",
        help="Also push tier, rating, lists, and valid track scores from the input file."
    )
    parser.add_argument(
        "--rankings-only",
        action="store_true",
        help="Update only existing Firestore albums' tier, rating, lists, and matching track ratings."
    )
    parser.add_argument(
        "--refresh-tracks",
        action="store_true",
        help="Fetch tracklists from Spotify for every album and publish real names, preserving scores by track number."
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show the create/update plan without writing to Firestore or fetching missing tracklists."
    )
    parser.add_argument(
        "--retry-file",
        default="sync-retry.json",
        help="Write albums from failed track lookups or Firestore batches here for a later retry."
    )
    args = parser.parse_args()
    try:
        if args.rankings_only:
            if args.refresh_tracks:
                parser.error("--rankings-only cannot be combined with --refresh-tracks.")
            run_rankings_sync(args.input, dry_run=args.dry_run)
        else:
            run_sync(
                args.input,
                include_rankings=args.include_rankings,
                refresh_tracks=args.refresh_tracks,
                dry_run=args.dry_run,
                retry_file=args.retry_file,
            )
    except (FileNotFoundError, ValueError, RuntimeError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)
