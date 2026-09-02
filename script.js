let allAlbums = [];
let currentFilter = "All Albums";
let currentView = "ranking"; 
let currentSort = "default"; 
let currentSearchQuery = ""; // NEW
let activeAlbumViewId = null;

const tierOrder = { "S": 1, "A": 2, "B": 3, "C": 4, "D": 5, "Unranked": 99 };
const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

// CACHE BUSTER: Forces the browser to load the freshest JSON data
const noCache = '?t=' + new Date().getTime();

Promise.all([
    fetch('./albums.json' + noCache).then(response => response.json()),
    fetch('./rankings.json' + noCache).then(response => response.json())
]).then(([albumsData, rankingsData]) => {
    const rankingsMap = {};
    rankingsData.forEach(ranking => { rankingsMap[ranking.id] = ranking; });

    allAlbums = albumsData.map(album => {
        const userRanking = rankingsMap[album.id] || {};
        let albumLists = [];
        if (userRanking.lists && Array.isArray(userRanking.lists)) {
            albumLists = userRanking.lists;
        } else if (userRanking.category && userRanking.category !== "Uncategorized") {
            albumLists = [userRanking.category];
        }

        return {
            ...album,
            tier: userRanking.tier || "Unranked",
            lists: albumLists,
            rating: userRanking.rating || 0.0
        };
    });

    initializeUI();
}).catch(error => console.error("Error loading JSON files:", error));

function initializeUI() {
    updateSidebar();
    refreshMainView();
}

// --- UTILS & STAR GENERATOR --- //

function formatDuration(ms) {
    if (!ms) return "Unknown Duration";
    const totalMinutes = Math.floor(ms / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return hours > 0 ? `${hours} hr ${minutes} min` : `${minutes} min`;
}

function generateStarsHTML(rating) {
    let html = '';
    for (let i = 1; i <= 10; i++) {
        if (rating >= i) html += '<span class="star filled" style="color:#FFD700;">★</span>';
        else if (rating >= i - 0.5) html += '<span class="star half" style="background: linear-gradient(90deg, #FFD700 50%, #555 50%); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">★</span>';
        else html += '<span class="star empty" style="color:#555;">★</span>';
    }
    return html;
}

// Reusable Interactive Star Component (Updated with Reset & High Responsiveness)
function setupInteractiveStars(containerId, initialRating, onSaveCallback, displayValueId = null) {
    const container = document.getElementById(containerId);
    if (!container) return null;
    container.innerHTML = '';
    
    let currentSelected = parseFloat(initialRating) || 0;

    const updateVisuals = (value) => {
        const stars = container.querySelectorAll('.star-node, .modal-star');
        stars.forEach((star, index) => {
            const i = index + 1;
            star.className = star.classList.contains('modal-star') ? 'modal-star' : 'star-node';
            if (value >= i) star.classList.add('filled');
            else if (value >= i - 0.5) star.classList.add('half');
        });
        if (displayValueId) {
            document.getElementById(displayValueId).textContent = value;
        }
    };

    for (let i = 1; i <= 10; i++) {
        const star = document.createElement('span');
        star.className = containerId.includes('modal') ? 'modal-star' : 'star-node';
        star.innerHTML = '★';
        
        // Only attach interactive hover/click events if running locally
        if (isLocal) {
            star.addEventListener('mousemove', (e) => {
                const rect = star.getBoundingClientRect();
                const isHalf = (e.clientX - rect.left) < (rect.width / 2);
                updateVisuals(isHalf ? i - 0.5 : i);
            });
            
            star.addEventListener('click', (e) => {
                const rect = star.getBoundingClientRect();
                const isHalf = (e.clientX - rect.left) < (rect.width / 2);
                const clickedValue = isHalf ? i - 0.5 : i;
                
                // RESET / TOGGLE FEATURE: If clicking the exact same rating, clear it to 0
                if (currentSelected === clickedValue) {
                    currentSelected = 0;
                } else {
                    currentSelected = clickedValue;
                }
                
                updateVisuals(currentSelected);
                if (onSaveCallback) onSaveCallback(currentSelected);
            });
        }
        
        container.appendChild(star);
    }
    
    if (isLocal) {
        container.addEventListener('mouseleave', () => {
            updateVisuals(currentSelected);
        });
    }
    
    updateVisuals(currentSelected);
    
    return (newRating) => {
        currentSelected = newRating;
        updateVisuals(currentSelected);
    };
}

window.handleSortChange = function(event) {
    currentSort = event.target.value;
    refreshMainView(); // Re-render the grid instantly
};

window.handleSearch = function(event) {
    currentSearchQuery = event.target.value.toLowerCase().trim();
    refreshMainView();
};

// --- SIDEBAR & ROUTING --- //

function updateSidebar() {
    const listsSet = new Set();
    allAlbums.forEach(album => {
        album.lists.forEach(listName => {
            if (listName.trim() !== "") listsSet.add(listName.trim());
        });
    });

    const categoryList = document.getElementById('category-list');
    categoryList.innerHTML = ''; 
    
    const allLi = document.createElement('li');
    allLi.textContent = "All Albums";
    allLi.className = currentFilter === "All Albums" ? "active" : "";
    allLi.onclick = () => handleNav("All Albums");
    categoryList.appendChild(allLi);

    const tiersList = ["S", "A", "B", "C", "D", "Unranked"];
    tiersList.forEach(tier => {
        const li = document.createElement('li');
        li.textContent = tier === "Unranked" ? "Unranked" : `${tier} Tier`;
        li.className = currentFilter === tier ? "active sidebar-tier" : "sidebar-tier";
        li.dataset.tier = tier;
        li.onclick = () => handleNav(tier);

        if (isLocal) {
            li.addEventListener('dragover', handleSidebarDragOver);
            li.addEventListener('dragleave', handleSidebarDragLeave);
            li.addEventListener('drop', handleSidebarDrop);
        }
        categoryList.appendChild(li);
    });

    if (listsSet.size > 0) {
        const divider = document.createElement('li');
        divider.textContent = "Your Lists";
        divider.className = "sidebar-divider";
        categoryList.appendChild(divider);

        Array.from(listsSet).sort().forEach(listName => {
            const li = document.createElement('li');
            li.textContent = listName;
            li.className = currentFilter === listName ? "active" : "";
            li.onclick = () => handleNav(listName);
            categoryList.appendChild(li);
        });
    }
}

function handleNav(filterName) {
    currentFilter = filterName;
    activeAlbumViewId = null; 
    document.querySelector('.view-toggle').style.display = 'flex'; 
    updateSidebar();
    refreshMainView();
}

function switchView(viewType) {
    currentView = viewType;
    document.getElementById('btn-ranking-view').classList.toggle('active', viewType === 'ranking');
    document.getElementById('btn-list-view').classList.toggle('active', viewType === 'list');
    
    const tableBtn = document.getElementById('btn-table-view');
    if (tableBtn) tableBtn.classList.toggle('active', viewType === 'table');
    
    refreshMainView();
}

function refreshMainView() {
    // Check if we should be showing the Album Detail view instead of the grid
    if (activeAlbumViewId) {
        renderAlbumDetailView(activeAlbumViewId);
        return;
    }

    const isTierFilter = ["S", "A", "B", "C", "D", "Unranked"].includes(currentFilter);
    document.getElementById('current-view-title').textContent = isTierFilter && currentFilter !== "Unranked" ? `${currentFilter} Tier` : currentFilter;
    
    let albumsToRender = allAlbums;
    
    // 1. FILTERING (By Sidebar Selection)
    if (currentFilter !== "All Albums") {
        if (isTierFilter) {
            albumsToRender = allAlbums.filter(album => (album.tier || "Unranked") === currentFilter);
        } else {
            albumsToRender = allAlbums.filter(album => album.lists.includes(currentFilter));
        }
    }

    // 1.5 NEW: FILTERING (By Search Bar Text)
    if (currentSearchQuery !== "") {
        albumsToRender = albumsToRender.filter(album => 
            album.album_name.toLowerCase().includes(currentSearchQuery) || 
            album.artist.toLowerCase().includes(currentSearchQuery)
        );
    }

    // 2. SORTING (By Dropdown Selection)
    let sortedAlbums = [...albumsToRender]; 
    
    if (currentSort !== "default") {
        sortedAlbums.sort((a, b) => {
            if (currentSort === "rating-desc") return (b.rating || 0) - (a.rating || 0);
            if (currentSort === "rating-asc") return (a.rating || 0) - (b.rating || 0);
            
            if (currentSort.startsWith("year")) {
                const yearA = a.release_date ? parseInt(a.release_date.split('-')[0]) : 0;
                const yearB = b.release_date ? parseInt(b.release_date.split('-')[0]) : 0;
                return currentSort === "year-desc" ? yearB - yearA : yearA - yearB;
            }
            
            if (currentSort.startsWith("duration")) {
                const durA = a.duration_ms || 0;
                const durB = b.duration_ms || 0;
                return currentSort === "duration-desc" ? durB - durA : durA - durB;
            }
            return 0;
        });
    }

    const container = document.getElementById('main-container');
    container.innerHTML = '';

    if (sortedAlbums.length === 0) {
        container.innerHTML = '<p style="color: #A7A7A7;">No albums found.</p>';
        return;
    }

    // 3. RENDERING
    if (currentView === 'table') {
        renderTableView(sortedAlbums, container);
    } else if (currentView === 'ranking' && !isTierFilter) {
        renderRankingView(sortedAlbums, container);
    } else {
        renderListView(sortedAlbums, container);
    }
}

// --- CARD RENDERING --- //

function createAlbumCard(album) {
    const card = document.createElement('div');
    card.className = 'album-card';
    card.dataset.id = album.id;
    // card.onclick = () => viewAlbumInfo(album.id);
    // card.ondblclick = () => window.open(album.spotify_url, '_blank'); // Double-click quick play
    
    let cardClickTimer = null;
    card.onclick = () => {
        if (cardClickTimer) {
            clearTimeout(cardClickTimer);
            cardClickTimer = null;
            window.open(album.spotify_url, '_blank'); // Double-click opens Spotify
        } else {
            cardClickTimer = setTimeout(() => {
                cardClickTimer = null;
                viewAlbumInfo(album.id); // Single-click opens album detail view
            }, 250);
        }
    };
    
    if (isLocal) {
        card.draggable = true;
        card.addEventListener('dragstart', handleDragStart);
        card.addEventListener('dragend', handleDragEnd);
    }
    
    const safeTitle = album.album_name.replace(/'/g, "\\'").replace(/"/g, '&quot;');
    const safeArtist = album.artist.replace(/'/g, "\\'").replace(/"/g, '&quot;');
    const safeLists = album.lists.join(', ').replace(/'/g, "\\'").replace(/"/g, '&quot;');
    
    let editBtn = isLocal ? `<button class="edit-btn" onclick="event.stopPropagation(); openModal(event, '${album.id}', '${safeTitle}', '${safeArtist}', '${album.tier}', '${safeLists}', '${album.rating}')">✎</button>` : '';
    // Shows a single large star and the numerical rating (e.g., ★ 8.5)
    let ratingBadge = `<div class="card-rating"><span style="color:#FFD700;">★</span> <span style="color:white; margin-left:4px; font-weight:700;">${(album.rating || 0).toFixed(1)}</span></div>`;

    card.innerHTML = `
        <div class="album-image-container">
            <img src="${album.thumbnail_url}" alt="Cover" loading="lazy">
            ${editBtn}
        </div>
        <div class="album-title" title="${album.album_name}">${album.album_name}</div>
        <div class="album-artist">${album.artist}</div>
        ${ratingBadge}
    `;
    return card;
}
let tableSortCol = null;
let tableSortAsc = true;

function renderTableView(albumsToRender, container) {
    let displayAlbums = [...albumsToRender];
    if (tableSortCol) {
        displayAlbums.sort((a, b) => {
            let valA, valB;
            if (tableSortCol === 'title') { valA = a.album_name; valB = b.album_name; }
            else if (tableSortCol === 'artist') { valA = a.artist; valB = b.artist; }
            else if (tableSortCol === 'tier') { 
                const tierWeights = { 'S': 5, 'A': 4, 'B': 3, 'C': 2, 'D': 1, 'Unranked': 0 };
                valA = tierWeights[a.tier] || 0; 
                valB = tierWeights[b.tier] || 0; 
            }
            else if (tableSortCol === 'rating') { valA = a.rating || 0; valB = b.rating || 0; }
            else if (tableSortCol === 'year') { valA = a.release_date || ''; valB = b.release_date || ''; }

            if (valA < valB) return tableSortAsc ? -1 : 1;
            if (valA > valB) return tableSortAsc ? 1 : -1;
            return 0;
        });
    }

    const table = document.createElement('table');
    table.className = 'album-table';
    table.innerHTML = `
        <thead>
            <tr>
                <th data-col="title">Title ${tableSortCol === 'title' ? (tableSortAsc ? '▲' : '▼') : ''}<div class="table-resizer"></div></th>
                <th data-col="artist">Artist ${tableSortCol === 'artist' ? (tableSortAsc ? '▲' : '▼') : ''}<div class="table-resizer"></div></th>
                <th data-col="tier">Tier ${tableSortCol === 'tier' ? (tableSortAsc ? '▲' : '▼') : ''}<div class="table-resizer"></div></th>
                <th data-col="rating">Rating ${tableSortCol === 'rating' ? (tableSortAsc ? '▲' : '▼') : ''}<div class="table-resizer"></div></th>
                <th data-col="year">Year ${tableSortCol === 'year' ? (tableSortAsc ? '▲' : '▼') : ''}<div class="table-resizer"></div></th>
            </tr>
        </thead>
        <tbody></tbody>
    `;
    
    table.querySelectorAll('th').forEach(th => {
        th.addEventListener('click', (e) => {
            if (e.target.classList.contains('table-resizer')) return;
            const col = th.dataset.col;
            if (tableSortCol === col) {
                tableSortAsc = !tableSortAsc;
            } else {
                tableSortCol = col;
                tableSortAsc = true;
            }
            renderTableView(albumsToRender, container);
        });
    });

    // Column resizing logic
    table.querySelectorAll('th').forEach(th => {
        const resizer = th.querySelector('.table-resizer');
        let x = 0;
        let w = 0;

        resizer.addEventListener('mousedown', function(e) {
            e.stopPropagation();
            x = e.clientX;
            w = th.offsetWidth;
            resizer.classList.add('resizing');

            function onMouseMove(e) {
                const dx = e.clientX - x;
                th.style.width = `${w + dx}px`;
            }

            function onMouseUp() {
                resizer.classList.remove('resizing');
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
            }

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    });

    const tbody = table.querySelector('tbody');
    displayAlbums.forEach(album => {
        const tr = document.createElement('tr');
        
        // Clean single-click vs double-click handler for table rows
        let clickTimer = null;
        tr.onclick = () => {
            if (clickTimer) {
                clearTimeout(clickTimer);
                clickTimer = null;
                window.open(album.spotify_url, '_blank'); // Double-click opens Spotify
            } else {
                clickTimer = setTimeout(() => {
                    clickTimer = null;
                    viewAlbumInfo(album.id); // Single-click opens album detail view
                }, 250);
            }
        };
        
        const year = album.release_date ? album.release_date.split('-')[0] : "-";
        const rating = album.rating > 0 ? `★ ${album.rating.toFixed(1)}` : "-";
        
        tr.innerHTML = `
            <td><img src="${album.thumbnail_url}" class="table-cover" loading="lazy"> ${album.album_name}</td>
            <td>${album.artist}</td>
            <td>${album.tier}</td>
            <td>${rating}</td>
            <td>${year}</td>
        `;
        tbody.appendChild(tr);
    });
    
    container.innerHTML = '';
    container.appendChild(table);
}

function renderListView(albumsToRender, container) {
    const grid = document.createElement('div');
    grid.className = 'album-grid';
    albumsToRender.forEach(album => grid.appendChild(createAlbumCard(album)));
    container.appendChild(grid);
}

function renderRankingView(albumsToRender, container) {
    const groupedByTier = { "S": [], "A": [], "B": [], "C": [], "D": [], "Unranked": [] };
    
    albumsToRender.forEach(album => {
        const tier = album.tier || "Unranked";
        if (groupedByTier[tier]) groupedByTier[tier].push(album);
        else groupedByTier["Unranked"].push(album);
    });

    Object.keys(groupedByTier).sort((a, b) => tierOrder[a] - tierOrder[b]).forEach(tier => {
        const tierSection = document.createElement('div');
        tierSection.className = 'tier-section';
        tierSection.dataset.tier = tier; 

        if (isLocal) {
            tierSection.addEventListener('dragover', handleDragOver);
            tierSection.addEventListener('dragleave', handleDragLeave);
            tierSection.addEventListener('drop', handleDrop);
        }

        const tierHeader = document.createElement('h2');
        tierHeader.className = 'tier-header';
        tierHeader.textContent = `${tier} Tier`;

        const grid = document.createElement('div');
        grid.className = 'album-grid';
        groupedByTier[tier].forEach(album => grid.appendChild(createAlbumCard(album)));

        tierSection.appendChild(tierHeader);
        tierSection.appendChild(grid);
        container.appendChild(tierSection);
    });
}

// --- NEW ALBUM DETAIL VIEW --- //

function viewAlbumInfo(id) {
    activeAlbumViewId = id;
    document.querySelector('.view-toggle').style.display = 'none'; 
    refreshMainView();
}

function renderAlbumDetailView(id) {
    const album = allAlbums.find(a => a.id === id);
    if (!album) return;

    document.getElementById('current-view-title').textContent = "";
    const container = document.getElementById('main-container');
    
    const releaseYear = album.release_date ? album.release_date.split('-')[0] : "Unknown";
    const duration = formatDuration(album.duration_ms);

    container.innerHTML = `
        <div class="detail-bg-blur" style="background-image: url('${album.thumbnail_url}');"></div>
        <button class="btn-back" onclick="handleNav(currentFilter)">← Back to ${currentFilter}</button>
        <div class="album-detail-view">
            <img src="${album.thumbnail_url}" alt="Cover" class="detail-cover">
            <div class="detail-info">
                <div style="margin-bottom: 4px;">
                    <span style="text-transform: uppercase; font-size: 11px; font-weight: 700; color: #b3b3b3; letter-spacing: 1px;">Album</span>
                </div>

                <div class="detail-title">${album.album_name}</div>
                <div class="detail-artist">${album.artist}</div>
                
                <!-- Interactive Stars -->
                <div class="detail-interactive-stars" id="detail-star-container" style="margin: 12px 0 16px 0;"></div>
                
                <!-- Vertical Metadata Stack (Larger Font) -->
                <div class="detail-metadata-stack">
                    <div>Released: <span>${releaseYear}</span></div>
                    <div>Tracks: <span>${album.total_tracks || '?'}</span></div>
                    <div>Length: <span>${duration}</span></div>
                    <div>Label: <span>${album.label || 'Unknown'}</span></div>
                </div>

                <!-- Badges Row (Tier removed as requested) -->
                <div class="detail-badges">
                    ${album.lists.map(list => `<span class="badge-pill">📂 ${list}</span>`).join('')}
                </div>

                <a href="${album.spotify_url}" target="_blank" rel="noopener noreferrer" class="btn-spotify">Play on Spotify</a>
            </div>
        </div>
    `;

    setupInteractiveStars('detail-star-container', album.rating, (newRating) => {
        album.rating = newRating;
        fetch('/update_ranking', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: album.id, tier: album.tier, lists: album.lists, rating: newRating })
        }).catch(err => console.error("Save error:", err));
    });
}


// --- DRAG AND DROP LOGIC --- //
let draggedAlbumId = null;
function handleDragStart(e) { draggedAlbumId = this.dataset.id; this.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; }
function handleDragEnd(e) { this.classList.remove('dragging'); document.querySelectorAll('.tier-section').forEach(ts => ts.classList.remove('drag-over')); document.querySelectorAll('.sidebar-tier').forEach(st => st.classList.remove('drag-over-sidebar')); }
function handleDragOver(e) { e.preventDefault(); this.classList.add('drag-over'); e.dataTransfer.dropEffect = 'move'; }
function handleDragLeave(e) { this.classList.remove('drag-over'); }
function handleDrop(e) { e.preventDefault(); this.classList.remove('drag-over'); updateAlbumTier(this.dataset.tier); }
function handleSidebarDragOver(e) { e.preventDefault(); this.classList.add('drag-over-sidebar'); e.dataTransfer.dropEffect = 'move'; }
function handleSidebarDragLeave(e) { this.classList.remove('drag-over-sidebar'); }
function handleSidebarDrop(e) { e.preventDefault(); this.classList.remove('drag-over-sidebar'); updateAlbumTier(this.dataset.tier); }

function updateAlbumTier(targetTier) {
    const album = allAlbums.find(a => a.id === draggedAlbumId);
    if (album && album.tier !== targetTier) {
        album.tier = targetTier;
        saveToServer(album.id, album.tier, album.lists, album.rating);
    }
}

// --- MODAL & SAVING LOGIC --- //

let currentEditingId = null;
let updateModalStars = null; // Holds the star updater function

window.openModal = function(event, id, title, artist, currentTier, currentListsString, currentRating) {
    event.preventDefault(); 
    event.stopPropagation(); 
    currentEditingId = id;
    
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-artist').textContent = artist;
    document.getElementById('modal-tier').value = currentTier;
    document.getElementById('modal-lists').value = currentListsString;
    
    // Initialize stars in the modal
    updateModalStars = setupInteractiveStars(
        'modal-star-container', 
        currentRating, 
        null, 
        'rating-display-value'
    );
    
    document.getElementById('edit-modal').style.display = 'flex';
};

window.closeModal = function() {
    document.getElementById('edit-modal').style.display = 'none';
    currentEditingId = null;
    updateModalStars = null;
};

window.submitModal = function() {
    if (!currentEditingId) return;
    
    const newTier = document.getElementById('modal-tier').value;
    const rawLists = document.getElementById('modal-lists').value;
    const newListsArray = rawLists.split(',').map(s => s.trim()).filter(s => s !== "");
    const newRating = parseFloat(document.getElementById('rating-display-value').textContent) || 0.0;
    
    saveToServer(currentEditingId, newTier, newListsArray, newRating);
    closeModal();
};

function saveToServer(id, tier, listsArray, rating) {
    fetch('/update_ranking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id, tier: tier, lists: listsArray, rating: rating })
    })
    .then(response => {
        if (response.ok) {
            const album = allAlbums.find(a => a.id === id);
            if (album) {
                album.tier = tier;
                album.lists = listsArray;
                album.rating = rating;
            }
            refreshMainView(); 
        } else alert("Failed to save. Make sure server.py is running.");
    })
    .catch(err => console.error("Save error:", err));
}

// --- COLLAPSE LOGIC --- //
document.addEventListener('DOMContentLoaded', () => {
    const menuBtn = document.getElementById('mobile-menu-btn');
    const sidebar = document.querySelector('.sidebar');
    if (menuBtn && sidebar) {
        menuBtn.addEventListener('click', () => {
            if (window.innerWidth <= 768) sidebar.classList.toggle('open');
            else sidebar.classList.toggle('collapsed');
        });
        sidebar.addEventListener('click', (e) => {
            if (window.innerWidth <= 768 && e.target.tagName === 'LI') sidebar.classList.remove('open');
        });
    }
});
