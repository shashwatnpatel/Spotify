import json
import os
import spotipy
from spotipy.oauth2 import SpotifyClientCredentials
from dotenv import load_dotenv

# 1. Load environment variables from the .env file
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
        # Returns the URL of the first image (usually the largest/best quality)
        return albums[0]['images'][0]['url'] 
    return "https://via.placeholder.com/300?text=No+Cover" # Fallback image

def process_library():
    # 2. Load your actual Spotify export data
    with open('YourLibrary.json', 'r', encoding='utf-8') as f:
        spotify_data = json.load(f)

    raw_albums = spotify_data.get('albums', []) 
    formatted_albums = []
    
    print(f"Found {len(raw_albums)} albums. Fetching covers...")

    for index, item in enumerate(raw_albums):
        artist = item.get('artist')
        album_name = item.get('album')
        
        # Fetch the cover art
        thumbnail = fetch_album_cover(artist, album_name)
        
        # Structure the data with default tiers and categories
        album_data = {
            "id": str(index + 1),
            "artist": artist,
            "album_name": album_name,
            "thumbnail_url": thumbnail,
            "category": "Uncategorized", 
            "tier": "Unranked"           
        }
        
        formatted_albums.append(album_data)
        print(f"Processed: {album_name} by {artist}")

    # 3. Output the clean data for your website
    with open('albums.json', 'w', encoding='utf-8') as f:
        json.dump(formatted_albums, f, indent=2)
        
    print("Success! Created albums.json")

if __name__ == '__main__':
    process_library()