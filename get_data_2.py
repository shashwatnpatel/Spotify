import json
import os
import spotipy
from spotipy.oauth2 import SpotifyClientCredentials
from dotenv import load_dotenv

# Load environment variables from the .env file
load_dotenv()

SPOTIPY_CLIENT_ID = os.getenv('SPOTIPY_CLIENT_ID')
SPOTIPY_CLIENT_SECRET = os.getenv('SPOTIPY_CLIENT_SECRET')

if not SPOTIPY_CLIENT_ID or not SPOTIPY_CLIENT_SECRET:
    raise ValueError("Missing Spotify credentials. Check your .env file.")

# Initialize the Spotify API client
sp = spotipy.Spotify(auth_manager=SpotifyClientCredentials(
    client_id=SPOTIPY_CLIENT_ID,
    client_secret=SPOTIPY_CLIENT_SECRET
))

def fetch_album_cover(artist_name, album_name):
    """Hits the Spotify API to find the album and grab its thumbnail."""
    query = f"artist:{artist_name} album:{album_name}"
    results = sp.search(q=query, type='album', limit=1)
    
    albums = results['albums']['items']
    if albums:
        return albums[0]['images'][0]['url'] 
    return "https://via.placeholder.com/300?text=No+Cover"

def process_library():
    # 1. Load existing data to preserve your manual tiers and categories
    existing_albums = []
    existing_keys = set()
    
    if os.path.exists('albums.json'):
        with open('albums.json', 'r', encoding='utf-8') as f:
            try:
                existing_albums = json.load(f)
                for item in existing_albums:
                    # Create a unique key (e.g., "sade|love deluxe")
                    key = f"{item.get('artist', '')}|{item.get('album_name', '')}".lower()
                    existing_keys.add(key)
            except json.JSONDecodeError:
                print("albums.json is empty or invalid. Starting fresh.")

    # 2. Load your Spotify export data
    with open('YourLibrary.json', 'r', encoding='utf-8') as f:
        spotify_data = json.load(f)

    raw_albums = spotify_data.get('albums', []) 
    final_albums_list = existing_albums.copy()
    new_additions_count = 0
    
    print(f"Found {len(raw_albums)} albums in Spotify export.")

    # 3. Process only the new albums
    for item in raw_albums:
        artist = item.get('artist')
        album_name = item.get('album')
        
        # Check if we already processed this album
        key = f"{artist}|{album_name}".lower()
        if key in existing_keys:
            continue
            
        # If it's new, fetch the cover art
        thumbnail = fetch_album_cover(artist, album_name)
        
        # Structure the new data
        album_data = {
            "id": str(len(final_albums_list) + 1),
            "artist": artist,
            "album_name": album_name,
            "thumbnail_url": thumbnail,
            "category": "Uncategorized", 
            "tier": "Unranked"           
        }
        
        final_albums_list.append(album_data)
        existing_keys.add(key) # Add to set so we don't duplicate it in this run
        new_additions_count += 1
        print(f"Added new: {album_name} by {artist}")

    # 4. Output the combined data back to the file
    with open('albums.json', 'w', encoding='utf-8') as f:
        json.dump(final_albums_list, f, indent=2)
        
    print(f"Success! Added {new_additions_count} new albums. Total in library: {len(final_albums_list)}")

if __name__ == '__main__':
    process_library()