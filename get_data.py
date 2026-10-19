import json
import os
import tempfile
import time
import unicodedata
from difflib import SequenceMatcher
from pathlib import Path

import spotipy
from dotenv import load_dotenv
from spotipy.oauth2 import SpotifyClientCredentials

load_dotenv()

SPOTIFY_CACHE_PATH = ".spotify_album_cache.json"
SPOTIFY_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60
_search_caches = {}


def create_spotify_client():
    client_id = os.getenv("SPOTIPY_CLIENT_ID")
    client_secret = os.getenv("SPOTIPY_CLIENT_SECRET")
    if not client_id or not client_secret:
        raise ValueError("Missing Spotify credentials. Check your .env file.")

    return spotipy.Spotify(
        auth_manager=SpotifyClientCredentials(
            client_id=client_id,
            client_secret=client_secret
        ),
        retries=5,
        status_retries=5,
        backoff_factor=0.5
    )


def album_key(artist, album_name):
    def normalize(value):
        value = unicodedata.normalize("NFKD", str(value or ""))
        return "".join(char for char in value if not unicodedata.combining(char)).casefold().strip()
    return f"{normalize(artist)}|{normalize(album_name)}"


def choose_spotify_album(
    artist_name,
    album_name,
    candidates,
    input_func=None,
    output_func=print,
):
    if not candidates:
        return None

    def artist_names(candidate):
        return ", ".join(
            artist.get("name", "")
            for artist in candidate.get("artists", [])
            if isinstance(artist, dict)
        )

    target_key = album_key(artist_name, album_name)
    exact = [
        candidate for candidate in candidates
        if album_key(artist_names(candidate), candidate.get("name")) == target_key
    ]
    if len(exact) == 1:
        return exact[0]

    def score(candidate):
        return (
            SequenceMatcher(None, album_key(artist_name, album_name),
                            album_key(artist_names(candidate), candidate.get("name"))).ratio()
        )

    ranked = sorted(candidates, key=score, reverse=True)
    output_func(f"Choose the Spotify album for {album_name} by {artist_name}:")
    for index, candidate in enumerate(ranked, start=1):
        artists = artist_names(candidate)
        release_year = str(candidate.get("release_date", "Unknown"))[:4]
        output_func(
            f"  {index}. {candidate.get('name', 'Unknown')} — {artists} "
            f"({release_year}, {candidate.get('total_tracks', '?')} tracks, "
            f"match {score(candidate):.0%}, id {candidate.get('id', 'unknown')})"
        )
    output_func("  s. Skip this album")
    if input_func is None:
        input_func = input
    while True:
        try:
            choice = input_func("Select 1–{} or s to skip: ".format(len(ranked))).strip().casefold()
        except EOFError as exc:
            raise RuntimeError(
                "Spotify returned multiple possible albums. Re-run interactively to choose a match."
            ) from exc
        if choice in {"s", "skip"}:
            return None
        if choice.isdigit() and 1 <= int(choice) <= len(ranked):
            return ranked[int(choice) - 1]
        output_func("Enter one of the listed numbers, or s to skip.")


def fetch_spotify_album(
    artist_name,
    album_name,
    spotify_client=None,
    cache_path=SPOTIFY_CACHE_PATH,
    input_func=None,
    output_func=print,
):
    cache_key = album_key(artist_name, album_name)
    cache = _search_caches.get(cache_path)
    if cache is None:
        if os.path.exists(cache_path):
            cache = load_json(cache_path)
            if not isinstance(cache, dict):
                raise ValueError(f"{cache_path} must contain a JSON object.")
        else:
            cache = {}
        _search_caches[cache_path] = cache

    cached_entry = cache.get(cache_key)
    if isinstance(cached_entry, dict):
        cached_at = cached_entry.get("cached_at")
        if (
            isinstance(cached_at, (int, float))
            and time.time() - cached_at < SPOTIFY_CACHE_TTL_SECONDS
        ):
            selected = cached_entry.get("selected_album")
            if isinstance(selected, dict):
                return selected
            cached_candidates = cached_entry.get("candidates")
            if not isinstance(cached_candidates, list) and isinstance(cached_entry.get("album"), dict):
                cached_candidates = [cached_entry["album"]]
            if isinstance(cached_candidates, list):
                selected = choose_spotify_album(
                    artist_name, album_name, cached_candidates, input_func, output_func
                )
                if selected:
                    cached_entry["selected_album"] = selected
                    write_json_atomically(cache_path, cache)
                return selected

    client = spotify_client or create_spotify_client()
    query = f"artist:{artist_name} album:{album_name}"
    results = client.search(q=query, type="album", limit=5)
    items = results.get("albums", {}).get("items", [])
    candidates = [item for item in items if isinstance(item, dict) and item.get("id")]
    if not candidates:
        return None
    album = choose_spotify_album(artist_name, album_name, candidates, input_func, output_func)
    cache[cache_key] = {
        "cached_at": time.time(),
        "candidates": candidates,
        "selected_album": album,
    }
    write_json_atomically(cache_path, cache)
    return album


def build_album_record(artist, album_name, album_id, spotify_album=None):
    images = (spotify_album or {}).get("images") or []
    thumbnail = images[0]["url"] if images else "https://via.placeholder.com/300?text=No+Cover"
    external = (spotify_album or {}).get("external_urls") or {}

    return {
        "id": album_id,
        "artist": artist,
        "album_name": album_name,
        "thumbnail_url": thumbnail,
        "category": "Uncategorized",
        "tier": "Unranked",
        "rating": 0.0,
        "lists": [],
        "tracks": [],
        "spotify_url": external.get("spotify", ""),
        "total_tracks": (spotify_album or {}).get("total_tracks", 0) or 0,
        "release_date": (spotify_album or {}).get("release_date", ""),
        "label": "Unknown",
        "duration_ms": 0,
    }


def load_json(path):
    try:
        with open(path, "r", encoding="utf-8") as file:
            return json.load(file)
    except json.JSONDecodeError as exc:
        raise ValueError(f"{path} contains invalid JSON: {exc}") from exc


def write_json_atomically(path, data):
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
            json.dump(data, file, indent=2)
            file.write("\n")
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary_path, destination)
    except Exception:
        if temporary_path and os.path.exists(temporary_path):
            os.unlink(temporary_path)
        raise


def load_album_catalog(path):
    if not os.path.exists(path):
        return []
    albums = load_json(path)
    if not isinstance(albums, list) or any(not isinstance(item, dict) for item in albums):
        raise ValueError(f"{path} must contain a JSON array of album objects.")
    return albums


def load_spotify_library(path):
    data = load_json(path)
    if not isinstance(data, dict) or not isinstance(data.get("albums"), list):
        raise ValueError(f"{path} must contain an object with an 'albums' array.")
    if any(not isinstance(item, dict) for item in data["albums"]):
        raise ValueError(f"{path} contains an invalid album entry; expected objects.")
    return data["albums"]


def process_library(
    library_path="YourLibrary.json",
    catalog_path="albums.json",
    album_fetcher=None,
):
    existing_albums = load_album_catalog(catalog_path)
    raw_albums = load_spotify_library(library_path)

    existing_keys = {
        album_key(item.get("artist"), item.get("album_name")): item
        for item in existing_albums
    }
    max_numeric_id = 0
    for item in existing_albums:
        try:
            max_numeric_id = max(max_numeric_id, int(str(item.get("id", "0"))))
        except (TypeError, ValueError):
            continue

    final_albums = list(existing_albums)
    new_count = 0
    spotify_client = None

    print(f"Found {len(raw_albums)} albums in Spotify export.")

    for item in raw_albums:
        artist = item.get("artist")
        album_name = item.get("album")
        key = album_key(artist, album_name)
        if key in existing_keys:
            continue

        if album_fetcher:
            spotify_album = album_fetcher(artist, album_name)
        else:
            if spotify_client is None:
                spotify_client = create_spotify_client()
            spotify_album = fetch_spotify_album(artist, album_name, spotify_client)

        if spotify_album and spotify_album.get("id"):
            album_id = str(spotify_album["id"])
        else:
            max_numeric_id += 1
            album_id = str(max_numeric_id)
        album_data = build_album_record(artist, album_name, album_id, spotify_album)
        final_albums.append(album_data)
        existing_keys[key] = album_data
        new_count += 1
        print(f"Added: {album_name} by {artist}")

    write_json_atomically(catalog_path, final_albums)

    print(f"Success. Added {new_count} new albums. Total: {len(final_albums)}")
    print("Next: python sync_vault.py")
    return final_albums


if __name__ == "__main__":
    process_library()
