# Music Vault

A personal Spotify album catalog with tiers, ratings, lists, and track scores. The deployed site is read-only. Catalog edits are made locally and explicitly pushed to Firestore from the command line.

## Setup

1. Copy `.env.example` to `.env` and add your Spotify app credentials.
2. Keep `serviceAccountKey.json` **out of git**. It is already listed in `.gitignore`.
3. Install Python deps: `pip install -r requirements.txt`

If Spotify or Firebase keys were ever committed or shared, **rotate them** in the Spotify developer dashboard and Google Cloud IAM before using this project again.

## Data pipeline

Use the supported ingest and publishing path:

1. Export your Spotify library as `YourLibrary.json`.
2. `python get_data.py` — adds new albums to `albums.json` (covers, URLs, release dates). Existing ratings and tiers are kept. Exact Spotify album matches are selected automatically; uncertain matches show candidate details and require an explicit choice or skip.
3. `python sync_vault.py` — upserts Firestore using Spotify album IDs as canonical IDs and resolves existing documents by Spotify URL, document ID, or stored legacy ID. It fetches real tracklists when missing and does not intentionally create duplicates.

`firebase.py` is an alias for `sync_vault.py`.
Spotify album-search results are cached locally in `.spotify_album_cache.json` for 30 days, and API requests retry transient rate-limit/server errors.
Approved Spotify album matches are saved to that cache and reused on later imports. Firestore sync reads candidate document IDs and legacy ID matches, then commits writes in batches.
Tracklists are fetched from Spotify using the album URLs. If Spotify credentials are missing or a tracklist cannot be retrieved, sync reports the failure instead of saving generated `Track 1` placeholders.

Preview sync changes without writing to Firestore or fetching missing tracklists:

```bash
python sync_vault.py --dry-run
```

Failed track lookups and Firestore write batches are recorded in `sync-retry.json`; after resolving the cause, rerun the listed command with `--input sync-retry.json`. The retry file is local and ignored by git. Do not run a real sync until the dry-run output is acceptable.

## Firebase

1. Create a Firestore database and set the Firebase web configuration in `script.js`.
2. Keep a Firebase Admin service-account key at `serviceAccountKey.json` for local sync. Never publish or commit this key.
3. Deploy rules that allow public reads but deny client writes:

```bash
firebase deploy --only firestore:rules
```

`firestore.rules` allows public reads and denies all client writes. The browser app only reads album documents from Firestore; edits, filter preferences, and imported listening summaries stay in browser storage. The local Python sync uses the Admin SDK and service-account key, so it can publish approved changes without opening write access to the deployed website.

## Local preview

Serve the folder over HTTP (Firestore will not work reliably from `file://`):

```bash
python -m http.server 8000
```

Open `http://localhost:8000`. The app recognizes `localhost`, `127.0.0.1`, and `[::1]` as local editing mode. Edits are saved in that browser's local storage only. To preview the deployed read-only experience locally, open `http://localhost:8000/?mode=readonly`; this hides local editing controls, Spotify history import, and the catalog data-attention panel, and ignores saved local album overrides without deleting them. Other non-local hosts (including the deployed site) are read-only. The browser only reads from Firestore in every mode; deployed Firestore rules also deny all client writes. For albums present in Firestore, local overrides retain ratings, tiers, lists, and track ratings; track names, track counts, duration, and other catalog metadata refresh from Firestore. Albums that exist only in a local backup remain local. Use **More → Export backup** and the CLI below to publish local changes.

## Publish local edits to Firestore

1. In local editing mode, edit ratings, tiers, lists, or track scores.
2. Select **More → Export backup** and keep the downloaded JSON file.
3. From the project directory, use rankings-only sync to publish those local edits without overwriting Firestore track names, durations, or other catalog metadata:

```bash
python sync_vault.py --input "/path/to/music-vault-backup-YYYY-MM-DD.json" --rankings-only
```

Run with `--dry-run` first to see how many existing albums and fields would change. The command requires `serviceAccountKey.json`. It updates only existing albums' tiers, ratings, lists, and track ratings matched by disc/track number; track names, album metadata, and duration are read from Firestore and preserved. Exact Firestore document IDs are preferred to avoid ambiguity when duplicate Spotify IDs exist. Albums missing from Firestore are not created. Because this uses Admin credentials, run it only with a backup you trust. The local browser keeps its local changes after publishing; use **More → Discard local changes** to reload the current Firestore catalog. The local header shows how many album records have unpublished changes; exporting a backup reveals a copyable publish command.

## Repair missing track names

To fetch real song names from Spotify for every album in `albums.json` and update Firestore, run this from the project directory:

```bash
python sync_vault.py --refresh-tracks
```

This requires `serviceAccountKey.json` and the Spotify client ID and secret in `.env`. You can refresh a different catalog or exported backup by adding `--input "/path/to/catalog-or-backup.json"`. The command updates only track data and duration for existing albums, preserves track ratings by track number, and reports albums it could not refresh; it never replaces a failed lookup with placeholder names. After it completes, reload the deployed site or choose **More → Discard local changes** locally to load the repaired Firestore data.

## Using the app

Open the app over HTTP as described above. The app uses a ten-minute browser catalog cache to avoid repeated Firestore reads. Its status line identifies cached, refreshing, current, and offline data; cached and offline messages warn that the catalog may be out of date. Select **Refresh catalog** to fetch the latest version immediately. In local editing mode, it also says how many local album overrides are layered over the catalog; those edits are not in Firestore until explicitly published. When offline, the app shows saved catalog data when available. Firestore browser persistence is also enabled when supported by the browser. A dismissible getting-started guide explains the local/read-only model and the main browsing controls on first visit. Use the controls in the top bar and the library sidebar:

- **Browse and search:** Choose **All Albums**, a tier, or one of your lists in the sidebar. Search matches album, artist, and track names. Use **Ranking**, **List**, or **Table** to change the layout; choose **Insights** for the dashboard. The result count and removable chips above the results show which library, search, and filter selections are narrowing the view.
- **Edit ratings and tiers:** Only on localhost, open an album and use its edit controls, or drag an album card into a tier. Changes are saved in the current browser only; deployed pages do not show edit controls.
- **Bulk edit:** In local mode, switch to **Table**, select visible albums, then apply one tier or add/remove a list tag from the selection. The table can be scrolled horizontally on small screens.
- **Album listening details:** After importing Spotify history, an album with matched plays shows its play count, total matched listening time, and latest play date on the album detail page.
- **Filter albums:** Select **Filter** to combine tier, list, album-length range (minutes), rating range (0–10), release-year range, listened/not-listened status, and track-data health. Filters update as fields change; no Enter key is required. Close the panel with **Close**, Escape, or by clicking outside it. Bounds are inclusive. Albums without a known duration or release year are excluded when that corresponding filter is active. Select **Clear all** in the panel to reset filters. The active filter, search, and sort choices are saved in this browser. Name and save up to 20 reusable **Saved views** in the filter panel; applying a view restores its filters, search, and sort.
- **Review catalog data:** In local editing mode, the catalog health banner reports known gaps in the currently loaded catalog, separating missing tracklists, incomplete tracklists, and missing duration. It includes local overrides for ratings, tiers, lists, and track ratings, but Firestore metadata remains authoritative for existing albums. Expand **Show affected albums** to see each album's specific issue and open its detail page, or use **Review albums** / **Filter → Track data** to narrow the catalog. The banner is hidden in read-only mode. Spotify's literal title “Track 10” on Charli XCX's *Pop 2* is valid metadata, not a placeholder.
- **View insights:** Select **Insights** to see the album count, rated-album average, listening time and coverage, tier and release-decade distributions, artists with the most albums, top-rated albums, and—after importing history—most/recently listened albums. Select an insight row to open the albums it represents; remove its chip to return to the full list. Catalog statistics use the full library, not the currently selected sidebar or filters. Import listening history from **More → Import Spotify history** in local editing mode.
- **Accessibility:** The app supports keyboard activation and visible focus for interactive controls, Escape to close open panels, labeled form controls, and reduced-motion preferences.
- **Export a backup:** Select **Export backup** to download a dated JSON file containing the full catalog and its ratings, tiers, lists, track data, and listening summaries. Keep this file somewhere safe. Older array and schema-version-1 backups remain supported; they do not contain listening summaries.
- **Export a spreadsheet:** Select **Export CSV** for a spreadsheet-friendly summary of album title, artist, tier, rating, release date, length, and lists. Use the JSON backup for restores; CSV is not accepted by the restore tool.
- **Load a backup locally:** On localhost, select **More → Load local backup** and choose a JSON backup. Confirm to merge records by album `id` into this browser's local catalog. This does not write to Firestore; export the result and use the CLI publish steps above when ready.
- **Import Spotify listening history (local editing only):** In Spotify's account privacy settings, request and download your extended streaming history. Select **Import Spotify history** in local editing mode and choose one or more music streaming-history JSON files (commonly named `Streaming_History_Audio_*.json` or `StreamingHistory_music_*.json`). Podcast history is not used. Each import replaces the previous listening summaries in this browser; it never writes to Firestore. Entries are matched to albums by normalized exact artist and track names; unmatched tracks and tracks present on multiple albums are skipped to avoid misleading attribution. The dashboard reports matched, unmatched, and ambiguous plays.

Listening-history files are processed in the browser and are not uploaded. Only per-album matched play counts, listening time, and latest play date are stored in that browser's local storage and included in new JSON backups. Clearing browser storage removes the cached catalog, local edits, and listening summaries; restore from a saved backup as needed.

## Security notes

- Never commit `.env` or `serviceAccountKey.json`.
- The Firebase web config in `script.js` is public; Firestore rules deny client writes.
- Firestore client writes are denied by `firestore.rules`; only the local Admin SDK sync can publish changes.
- Configure Firestore budget alerts and periodically review usage in Google Cloud. The browser cache reduces repeat catalog reads but does not replace quota/budget monitoring.
- The old one-off scripts (`fetch_real_tracks.py`, `fix_tracks.py`, `update_tracks.py`, `get_data_2.py`) were removed in favor of the pipeline above.
- `server.py` and `process_albums.py` are retired legacy tools and are not part of the supported workflow. Use `get_data.py` for library ingestion and `sync_vault.py` for explicit Firestore publishing.

## Tests

Run the focused data-pipeline tests with:

```bash
python -m unittest discover -s tests
```
