"""Upsert albums.json into Firestore. Prefer: python sync_vault.py"""

from sync_vault import run_sync

if __name__ == "__main__":
    run_sync()
