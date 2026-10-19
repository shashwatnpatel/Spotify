import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from get_data import choose_spotify_album, fetch_spotify_album, process_library
import sync_vault
from sync_vault import build_new_record, chunked, load_local_albums


class ProcessLibraryTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.library_path = self.root / "YourLibrary.json"
        self.catalog_path = self.root / "albums.json"

    def tearDown(self):
        self.temp_dir.cleanup()

    def write_json(self, path, value):
        path.write_text(json.dumps(value), encoding="utf-8")

    def test_import_deduplicates_and_preserves_existing_ratings_and_tiers(self):
        original = [{
            "id": "8",
            "artist": "Existing Artist",
            "album_name": "Existing Album",
            "tier": "S",
            "rating": 9.5,
            "lists": ["favorites"],
        }]
        self.write_json(self.catalog_path, original)
        self.write_json(self.library_path, {
            "albums": [
                {"artist": "existing artist", "album": "EXISTING ALBUM"},
                {"artist": "New Artist", "album": "New Album"},
                {"artist": "New Artist", "album": "New Album"},
            ]
        })
        fetched = []

        result = process_library(
            str(self.library_path),
            str(self.catalog_path),
            album_fetcher=lambda artist, album: fetched.append((artist, album)) or None,
        )

        self.assertEqual(len(result), 2)
        self.assertEqual(fetched, [("New Artist", "New Album")])
        self.assertEqual(result[0]["tier"], "S")
        self.assertEqual(result[0]["rating"], 9.5)
        self.assertEqual(result[0]["lists"], ["favorites"])
        self.assertEqual(result[1]["id"], "9")
        self.assertEqual(json.loads(self.catalog_path.read_text(encoding="utf-8")), result)

    def test_invalid_existing_catalog_is_not_overwritten(self):
        invalid_contents = '{"albums":'
        self.catalog_path.write_text(invalid_contents, encoding="utf-8")
        self.write_json(self.library_path, {"albums": []})

        with self.assertRaisesRegex(ValueError, "invalid JSON"):
            process_library(str(self.library_path), str(self.catalog_path))

        self.assertEqual(self.catalog_path.read_text(encoding="utf-8"), invalid_contents)

    def test_invalid_library_shape_does_not_overwrite_catalog(self):
        existing = [{"id": "1", "tier": "A", "rating": 8}]
        self.write_json(self.catalog_path, existing)
        self.write_json(self.library_path, {"albums": "not a list"})

        with self.assertRaisesRegex(ValueError, "'albums' array"):
            process_library(str(self.library_path), str(self.catalog_path))

        self.assertEqual(json.loads(self.catalog_path.read_text(encoding="utf-8")), existing)

    def test_spotify_album_search_is_cached_for_repeated_imports(self):
        class FakeSpotifyClient:
            def __init__(self):
                self.search_count = 0

            def search(self, **kwargs):
                self.search_count += 1
                return {"albums": {"items": [{
                    "id": "spotify-id",
                    "name": "Album",
                    "artists": [{"name": "Artist"}],
                }]}}

        client = FakeSpotifyClient()
        cache_path = str(self.root / "spotify-cache.json")

        first = fetch_spotify_album("Artist", "Album", client, cache_path)
        second = fetch_spotify_album("Artist", "Album", client, cache_path)

        self.assertEqual(first["id"], "spotify-id")
        self.assertEqual(second, first)
        self.assertEqual(client.search_count, 1)

    def test_new_import_uses_spotify_album_id_as_canonical_id(self):
        self.write_json(self.library_path, {
            "albums": [{"artist": "New Artist", "album": "New Album"}]
        })
        result = process_library(
            str(self.library_path),
            str(self.catalog_path),
            album_fetcher=lambda artist, album: {
                "id": "spotify-album-id",
                "name": album,
                "artists": [{"name": artist}],
            },
        )
        self.assertEqual(result[0]["id"], "spotify-album-id")

    def test_spotify_match_picker_requires_choice_for_non_exact_results(self):
        candidates = [
            {"id": "wrong", "name": "Album Deluxe", "artists": [{"name": "Artist"}]},
            {"id": "right", "name": "Album", "artists": [{"name": "Artist"}]},
        ]
        result = choose_spotify_album(
            "Artist",
            "Album",
            candidates,
            input_func=lambda _: "2",
            output_func=lambda _: None,
        )
        self.assertEqual(result["id"], "right")

    def test_spotify_match_picker_skips_when_user_declines_candidates(self):
        result = choose_spotify_album(
            "Artist",
            "Album",
            [{"id": "candidate", "name": "Different Album", "artists": [{"name": "Other"}]}],
            input_func=lambda _: "s",
            output_func=lambda _: None,
        )
        self.assertIsNone(result)


class SyncHelpersTests(unittest.TestCase):
    def test_placeholder_track_names_are_invalid(self):
        self.assertFalse(sync_vault.is_tracks_valid([
            {"name": "Track 1", "track_number": 1},
            {"name": "Track 2", "track_number": 2},
        ]))

    def test_track_10_is_valid_for_charli_xcx_pop_2(self):
        album = {"artist": "Charli xcx", "album_name": "Pop 2"}
        tracks = [{"name": "Track 10", "track_number": 10, "duration_ms": 326906}]

        self.assertTrue(sync_vault.is_tracks_valid(tracks, album))
        self.assertFalse(sync_vault.is_tracks_valid(tracks, {"artist": "Other", "album_name": "Other"}))

    def test_spotify_track_fetch_preserves_scores_and_rejects_placeholders(self):
        class FakeSpotifyClient:
            def album_tracks(self, album_id):
                return {
                    "items": [{
                        "name": "Real Song",
                        "track_number": 1,
                        "duration_ms": 180000,
                    }],
                    "next": None,
                }

        with patch.object(sync_vault, "sp", FakeSpotifyClient()):
            tracks = sync_vault.fetch_spotify_tracks(
                "https://open.spotify.com/album/abcdefghijklmnopqrstuv",
                [{"name": "Track 1", "track_number": 1, "rating": 8}],
            )

        self.assertEqual(tracks, [{
            "track_number": 1,
            "name": "Real Song",
            "duration_ms": 180000,
            "rating": 8,
        }])

    def test_spotify_track_fetch_requires_credentials_and_never_falls_back(self):
        with patch.object(sync_vault, "sp", None):
            with self.assertRaisesRegex(RuntimeError, "Spotify credentials are required"):
                sync_vault.fetch_spotify_tracks(
                    "https://open.spotify.com/album/abcdefghijklmnopqrstuv"
                )

    def test_refresh_tracks_replaces_remote_placeholders_from_spotify(self):
        class FakeSpotifyClient:
            def album_tracks(self, album_id):
                return {
                    "items": [{
                        "name": "Real Song",
                        "track_number": 1,
                        "duration_ms": 180000,
                    }],
                    "next": None,
                }

        class FakeDocument:
            id = "album-1"

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "albums.json"
            album = {
                "id": "album-1",
                "album_name": "Album",
                "artist": "Artist",
                "spotify_url": "https://open.spotify.com/album/abcdefghijklmnopqrstuv",
                "total_tracks": 1,
                "duration_ms": 0,
                "release_date": "2000",
                "label": "Label",
                "thumbnail_url": "cover",
                "tracks": [],
            }
            path.write_text(json.dumps([album]), encoding="utf-8")
            remote_data = {
                **{key: value for key, value in album.items() if key != "tracks"},
                "tracks": [{
                    "name": "Track 1",
                    "track_number": 1,
                    "duration_ms": 0,
                    "rating": 8,
                }],
            }
            writes = []

            with (
                patch.object(sync_vault, "initialize_services"),
                patch.object(sync_vault, "sp", FakeSpotifyClient()),
                patch.object(sync_vault, "find_existing_docs_by_record_id", return_value={
                    "album-1": {"ref": FakeDocument(), "data": remote_data}
                }),
                patch.object(sync_vault, "commit_writes", side_effect=lambda batch: writes.extend(batch)),
            ):
                sync_vault.run_sync(str(path), refresh_tracks=True)

        self.assertEqual(len(writes), 1)
        update = writes[0][1]
        self.assertEqual(update["tracks"][0]["name"], "Real Song")
        self.assertEqual(update["tracks"][0]["rating"], 8)
        self.assertEqual(update["duration_ms"], 180000)

    def test_legacy_numeric_record_id_resolves_to_spotify_document_id(self):
        class FakeReference:
            id = "spotify-album-id"
            path = "albums/spotify-album-id"

        class FakeDocument:
            reference = FakeReference()

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "albums.json"
            tracks = [{"name": "One", "track_number": 1, "duration_ms": 1000, "rating": 0}]
            album = {
                "id": "42",
                "album_name": "Album",
                "artist": "Artist",
                "spotify_url": "https://open.spotify.com/album/spotify-album-id",
                "tracks": tracks,
                "total_tracks": 1,
                "duration_ms": 1000,
                "release_date": "2000",
                "label": "Label",
                "thumbnail_url": "cover",
            }
            path.write_text(json.dumps([album]), encoding="utf-8")
            remote = {
                **album,
                "id": "42",
                "tracks": tracks,
            }
            writes = []
            entry = {"ref": FakeReference(), "data": remote}
            with (
                patch.object(sync_vault, "initialize_services"),
                patch.object(sync_vault, "find_existing_docs_for_albums", return_value={
                    "42": entry,
                    "spotify-album-id": entry,
                }),
                patch.object(sync_vault, "commit_writes", side_effect=lambda batch: writes.extend(batch)),
            ):
                sync_vault.run_sync(str(path))

        self.assertEqual(len(writes), 1)
        self.assertEqual(writes[0][0].id, "spotify-album-id")
        self.assertEqual(writes[0][1]["id"], "spotify-album-id")

    def test_dry_run_does_not_commit_firestore_writes(self):
        class FakeReference:
            id = "album-1"
            path = "albums/album-1"

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "albums.json"
            album = {
                "id": "album-1",
                "album_name": "Album",
                "artist": "Artist",
                "spotify_url": "https://open.spotify.com/album/abcdefghijklmnopqrstuv",
                "tracks": [{"name": "One", "track_number": 1, "duration_ms": 1000, "rating": 0}],
                "total_tracks": 1,
                "duration_ms": 1000,
                "release_date": "2000",
                "label": "Label",
                "thumbnail_url": "cover",
            }
            path.write_text(json.dumps([album]), encoding="utf-8")
            entry = {"ref": FakeReference(), "data": dict(album)}
            with (
                patch.object(sync_vault, "initialize_services"),
                patch.object(sync_vault, "find_existing_docs_for_albums", return_value={"album-1": entry}),
                patch.object(sync_vault, "commit_writes") as commit,
            ):
                sync_vault.run_sync(str(path), dry_run=True)
            commit.assert_not_called()

    def test_failed_firestore_batch_writes_retry_report(self):
        class FakeReference:
            id = "album-1"
            path = "albums/album-1"

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "albums.json"
            retry_path = Path(directory) / "retry.json"
            album = {
                "id": "album-1",
                "album_name": "Album",
                "artist": "Artist",
                "spotify_url": "https://open.spotify.com/album/abcdefghijklmnopqrstuv",
                "tracks": [{"name": "One", "track_number": 1, "duration_ms": 1000, "rating": 0}],
                "total_tracks": 1,
                "duration_ms": 1000,
                "release_date": "2000",
                "label": "Label",
                "thumbnail_url": "cover",
            }
            path.write_text(json.dumps([album]), encoding="utf-8")
            remote = {**album, "album_name": "Old Album"}
            entry = {"ref": FakeReference(), "data": remote}
            with (
                patch.object(sync_vault, "initialize_services"),
                patch.object(sync_vault, "find_existing_docs_for_albums", return_value={"album-1": entry}),
                patch.object(
                    sync_vault,
                    "commit_writes",
                    side_effect=sync_vault.GoogleAPICallError("temporary Firestore failure"),
                ),
            ):
                with self.assertRaisesRegex(RuntimeError, "1 album operation"):
                    sync_vault.run_sync(str(path), retry_file=str(retry_path))

            report = json.loads(retry_path.read_text(encoding="utf-8"))
            self.assertEqual([item["id"] for item in report["albums"]], ["album-1"])
            self.assertIn("Firestore batch failed", report["failures"][0]["reason"])

    def test_failed_track_fetch_writes_album_to_retry_report(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "albums.json"
            retry_path = Path(directory) / "retry.json"
            album = {
                "id": "album-1",
                "album_name": "Album",
                "artist": "Artist",
                "spotify_url": "https://open.spotify.com/album/abcdefghijklmnopqrstuv",
            }
            path.write_text(json.dumps([album]), encoding="utf-8")
            with (
                patch.object(sync_vault, "initialize_services"),
                patch.object(sync_vault, "find_existing_docs_for_albums", return_value={}),
                patch.object(sync_vault, "sp", None),
            ):
                with self.assertRaisesRegex(RuntimeError, "1 album operation"):
                    sync_vault.run_sync(str(path), retry_file=str(retry_path))

            report = json.loads(retry_path.read_text(encoding="utf-8"))
            self.assertEqual(report["albums"], [album])
            self.assertIn("Spotify credentials are required", report["failures"][0]["reason"])

    def test_new_firestore_record_preserves_ranking_and_track_values(self):
        album = {"tier": "A", "rating": 8.5, "lists": ["favorites"]}
        metadata = {"total_tracks": 0, "duration_ms": 0}
        tracks = [
            {"name": "One", "duration_ms": 1200, "rating": 7},
            {"name": "Two", "duration_ms": 1800, "rating": 9},
        ]

        result = build_new_record(album, metadata, tracks)

        self.assertEqual(result["tier"], "A")
        self.assertEqual(result["rating"], 8.5)
        self.assertEqual(result["lists"], ["favorites"])
        self.assertEqual(result["tracks"], tracks)
        self.assertEqual(result["total_tracks"], 2)
        self.assertEqual(result["duration_ms"], 3000)

    def test_firestore_catalog_must_be_an_array_of_objects(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "albums.json"
            path.write_text('{"not": "an array"}', encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "array of album objects"):
                load_local_albums(str(path))

    def test_sync_backup_can_push_local_ratings_and_lists(self):
        class FakeDocument:
            id = "album-1"
            path = "albums/album-1"

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "backup.json"
            album = {
                "id": "album-1",
                "album_name": "Album",
                "artist": "Artist",
                "tier": "S",
                "rating": 9.0,
                "lists": ["favorites"],
                "tracks": [{"name": "Track", "track_number": 1, "duration_ms": 1000, "rating": 8}],
                "release_date": "2000",
                "total_tracks": 1,
                "duration_ms": 1000,
                "label": "Label",
                "spotify_url": "url",
                "thumbnail_url": "cover",
            }
            path.write_text(json.dumps({"schemaVersion": 1, "albums": [album]}), encoding="utf-8")
            remote_data = {
                key: value for key, value in album.items()
                if key not in {"tier", "rating", "lists"}
            }
            remote_data.update({
                "tier": "Unranked",
                "rating": 0,
                "lists": [],
                "tracks": [{"name": "Track", "track_number": 1, "duration_ms": 1000, "rating": 0}],
            })
            writes = []

            with (
                patch.object(sync_vault, "initialize_services"),
                patch.object(sync_vault, "find_existing_docs_for_albums", return_value={
                    "album-1": {"ref": FakeDocument(), "data": remote_data}
                }),
                patch.object(sync_vault, "commit_writes", side_effect=lambda batch: writes.extend(batch)),
            ):
                sync_vault.run_sync(str(path), include_rankings=True)

            self.assertEqual(len(writes), 1)
            payload = writes[0][1]
            self.assertEqual(payload["tier"], "S")
            self.assertEqual(payload["rating"], 9.0)
            self.assertEqual(payload["lists"], ["favorites"])
            self.assertEqual(payload["tracks"], album["tracks"])

    def test_rankings_payload_preserves_remote_metadata_and_updates_track_scores(self):
        local_album = {
            "id": "album-1",
            "tier": "S",
            "rating": 9,
            "lists": ["favorites"],
            "tracks": [
                {"name": "Track 1", "track_number": 1, "rating": 8},
                {"name": "Track 2", "track_number": 2, "rating": 0},
            ],
        }
        remote_data = {
            "album_name": "Current Album Name",
            "duration_ms": 120000,
            "tier": "Unranked",
            "rating": 0,
            "lists": [],
            "tracks": [
                {"name": "Real Song One", "track_number": 1, "duration_ms": 60000, "rating": 0},
                {"name": "Real Song Two", "track_number": 2, "duration_ms": 60000, "rating": 0},
            ],
        }

        payload = sync_vault.build_rankings_payload(local_album, remote_data)

        self.assertEqual(payload["tier"], "S")
        self.assertEqual(payload["rating"], 9)
        self.assertEqual(payload["lists"], ["favorites"])
        self.assertEqual(payload["tracks"][0]["name"], "Real Song One")
        self.assertEqual(payload["tracks"][0]["rating"], 8)
        self.assertEqual(payload["tracks"][1]["name"], "Real Song Two")
        self.assertNotIn("album_name", payload)
        self.assertNotIn("duration_ms", payload)

    def test_rankings_sync_prefers_exact_firestore_document_id_on_duplicate_spotify_alias(self):
        class FakeReference:
            def __init__(self, path):
                self.path = path

        class FakeSnapshot:
            def __init__(self, doc_id, data):
                self.id = doc_id
                self.reference = FakeReference(f"albums/{doc_id}")
                self._data = data

            def to_dict(self):
                return self._data

        class FakeCollection:
            def stream(self):
                shared_data = {
                    "id": "legacy-id",
                    "spotify_url": "https://open.spotify.com/album/spotify-id",
                    "tier": "Unranked",
                    "rating": 0,
                    "lists": [],
                    "tracks": [{"name": "Current title", "track_number": 1, "rating": 0}],
                }
                return iter([
                    FakeSnapshot("album-doc-1", shared_data),
                    FakeSnapshot("album-doc-2", shared_data),
                ])

        class FakeDb:
            def collection(self, name):
                self.asserted_collection = name
                return FakeCollection()

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "backup.json"
            path.write_text(json.dumps({"albums": [{
                "id": "album-doc-1",
                "tier": "A",
                "rating": 8,
                "lists": ["local"],
                "tracks": [{"name": "Stale title", "track_number": 1, "rating": 7}],
            }]}), encoding="utf-8")
            writes = []
            fake_db = FakeDb()
            with (
                patch.object(sync_vault, "initialize_services"),
                patch.object(sync_vault, "db", fake_db),
                patch.object(sync_vault, "commit_writes", side_effect=lambda batch: writes.extend(batch)),
            ):
                sync_vault.run_rankings_sync(str(path))

            self.assertEqual(fake_db.asserted_collection, "albums")
            self.assertEqual(len(writes), 1)
            reference, payload = writes[0]
            self.assertEqual(reference.path, "albums/album-doc-1")
            self.assertEqual(payload["tracks"][0]["name"], "Current title")
            self.assertEqual(payload["tracks"][0]["rating"], 7)

    def test_chunked_splits_batches_without_dropping_items(self):
        self.assertEqual(list(chunked(list(range(5)), 2)), [[0, 1], [2, 3], [4]])


if __name__ == "__main__":
    unittest.main()
