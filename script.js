let allAlbums = [];
let currentFilter = "All Albums";
let currentView = "ranking"; // 'ranking' or 'list'

const tierOrder = { "S": 1, "A": 2, "B": 3, "C": 4, "D": 5, "Unranked": 99 };
const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

// Fetch and merge data
Promise.all([
    fetch('./albums.json').then(response => response.json()),
    fetch('./rankings.json').then(response => response.json())
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
            lists: albumLists
        };
    });

    initializeUI();
}).catch(error => console.error("Error loading JSON files:", error));

function initializeUI() {
    updateSidebar();
    refreshMainView();
}

function updateSidebar() {
    const listsSet = new Set();
    allAlbums.forEach(album => {
        album.lists.forEach(listName => {
            if (listName.trim() !== "") listsSet.add(listName.trim());
        });
    });

    const categoryList = document.getElementById('category-list');
    categoryList.innerHTML = ''; 
    
    // 1. Default All Albums
    const allLi = document.createElement('li');
    allLi.textContent = "All Albums";
    allLi.className = currentFilter === "All Albums" ? "active" : "";
    allLi.onclick = () => { currentFilter = "All Albums"; updateSidebar(); refreshMainView(); };
    categoryList.appendChild(allLi);

    // 2. Tiers (Act as filters AND drop zones)
    const tiersList = ["S", "A", "B", "C", "D", "Unranked"];
    tiersList.forEach(tier => {
        const li = document.createElement('li');
        li.textContent = tier === "Unranked" ? "Unranked" : `${tier} Tier`;
        li.className = currentFilter === tier ? "active sidebar-tier" : "sidebar-tier";
        li.dataset.tier = tier;
        li.onclick = () => { currentFilter = tier; updateSidebar(); refreshMainView(); };

        // Attach sidebar drop events
        if (isLocal) {
            li.addEventListener('dragover', handleSidebarDragOver);
            li.addEventListener('dragleave', handleSidebarDragLeave);
            li.addEventListener('drop', handleSidebarDrop);
        }
        categoryList.appendChild(li);
    });

    // 3. Custom Lists
    if (listsSet.size > 0) {
        const divider = document.createElement('li');
        divider.textContent = "Your Lists";
        divider.className = "sidebar-divider";
        categoryList.appendChild(divider);

        Array.from(listsSet).sort().forEach(listName => {
            const li = document.createElement('li');
            li.textContent = listName;
            li.className = currentFilter === listName ? "active" : "";
            li.onclick = () => { currentFilter = listName; updateSidebar(); refreshMainView(); };
            categoryList.appendChild(li);
        });
    }
}

function switchView(viewType) {
    currentView = viewType;
    document.getElementById('btn-ranking-view').classList.toggle('active', viewType === 'ranking');
    document.getElementById('btn-list-view').classList.toggle('active', viewType === 'list');
    refreshMainView();
}

function refreshMainView() {
    const isTierFilter = ["S", "A", "B", "C", "D", "Unranked"].includes(currentFilter);
    document.getElementById('current-view-title').textContent = isTierFilter && currentFilter !== "Unranked" ? `${currentFilter} Tier` : currentFilter;
    
    let albumsToRender = allAlbums;
    if (currentFilter !== "All Albums") {
        if (isTierFilter) {
            albumsToRender = allAlbums.filter(album => (album.tier || "Unranked") === currentFilter);
        } else {
            albumsToRender = allAlbums.filter(album => album.lists.includes(currentFilter));
        }
    }

    const container = document.getElementById('main-container');
    container.innerHTML = '';

    if (albumsToRender.length === 0) {
        container.innerHTML = '<p style="color: #A7A7A7;">No albums found here.</p>';
        return;
    }

    // Always render list view if a specific tier is selected from the sidebar for better visibility
    if (currentView === 'ranking' && !isTierFilter) {
        renderRankingView(albumsToRender, container);
    } else {
        renderListView(albumsToRender, container);
    }
}

// --- RENDERING VIEWS --- //

function createAlbumCard(album) {
    const card = document.createElement('a');
    card.href = album.spotify_url || "#";
    card.target = "_blank";
    card.rel = "noopener noreferrer";
    card.className = 'album-card';
    card.dataset.id = album.id;
    
    // Cards are now draggable in ALL views if local
    if (isLocal) {
        card.draggable = true;
        card.addEventListener('dragstart', handleDragStart);
        card.addEventListener('dragend', handleDragEnd);
    }
    
    const safeTitle = album.album_name.replace(/'/g, "\\'").replace(/"/g, '&quot;');
    const safeArtist = album.artist.replace(/'/g, "\\'").replace(/"/g, '&quot;');
    const safeLists = album.lists.join(', ').replace(/'/g, "\\'").replace(/"/g, '&quot;');
    
    let editBtn = isLocal ? `<button class="edit-btn" onclick="openModal(event, '${album.id}', '${safeTitle}', '${safeArtist}', '${album.tier}', '${safeLists}')">✎</button>` : '';
    
    card.innerHTML = `
        <div class="album-image-container">
            <img src="${album.thumbnail_url}" alt="Cover" loading="lazy">
            ${editBtn}
        </div>
        <div class="album-title" title="${album.album_name}">${album.album_name}</div>
        <div class="album-artist">${album.artist}</div>
    `;
    return card;
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
        tierHeader.setAttribute('data-tier', tier);

        const grid = document.createElement('div');
        grid.className = 'album-grid';
        groupedByTier[tier].forEach(album => grid.appendChild(createAlbumCard(album)));

        tierSection.appendChild(tierHeader);
        tierSection.appendChild(grid);
        container.appendChild(tierSection);
    });
}

// --- DRAG AND DROP LOGIC (MAIN AREA) --- //

let draggedAlbumId = null;

function handleDragStart(e) {
    draggedAlbumId = this.dataset.id;
    this.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
}

function handleDragEnd(e) {
    this.classList.remove('dragging');
    document.querySelectorAll('.tier-section').forEach(ts => ts.classList.remove('drag-over'));
    document.querySelectorAll('.sidebar-tier').forEach(st => st.classList.remove('drag-over-sidebar'));
}

function handleDragOver(e) {
    e.preventDefault(); 
    this.classList.add('drag-over');
    e.dataTransfer.dropEffect = 'move';
}

function handleDragLeave(e) {
    this.classList.remove('drag-over');
}

function handleDrop(e) {
    e.preventDefault();
    this.classList.remove('drag-over');
    
    const targetTier = this.dataset.tier;
    updateAlbumTier(targetTier);
}

// --- DRAG AND DROP LOGIC (SIDEBAR) --- //

function handleSidebarDragOver(e) {
    e.preventDefault();
    this.classList.add('drag-over-sidebar');
    e.dataTransfer.dropEffect = 'move';
}

function handleSidebarDragLeave(e) {
    this.classList.remove('drag-over-sidebar');
}

function handleSidebarDrop(e) {
    e.preventDefault();
    this.classList.remove('drag-over-sidebar');
    
    const targetTier = this.dataset.tier;
    updateAlbumTier(targetTier);
}

function updateAlbumTier(targetTier) {
    const album = allAlbums.find(a => a.id === draggedAlbumId);
    if (album && album.tier !== targetTier) {
        album.tier = targetTier;
        saveToServer(album.id, album.tier, album.lists);
    }
}

// --- MODAL & SAVING LOGIC --- //

let currentEditingId = null;

window.openModal = function(event, id, title, artist, currentTier, currentListsString) {
    event.preventDefault(); 
    currentEditingId = id;
    
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-artist').textContent = artist;
    document.getElementById('modal-tier').value = currentTier;
    document.getElementById('modal-lists').value = currentListsString;
    
    document.getElementById('edit-modal').style.display = 'flex';
};

window.closeModal = function() {
    document.getElementById('edit-modal').style.display = 'none';
    currentEditingId = null;
};

window.submitModal = function() {
    if (!currentEditingId) return;
    
    const newTier = document.getElementById('modal-tier').value;
    const rawLists = document.getElementById('modal-lists').value;
    const newListsArray = rawLists.split(',').map(s => s.trim()).filter(s => s !== "");
    
    saveToServer(currentEditingId, newTier, newListsArray);
    closeModal();
};

function saveToServer(id, tier, listsArray) {
    fetch('/update_ranking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id, tier: tier, lists: listsArray })
    })
    .then(response => {
        if (response.ok) {
            const album = allAlbums.find(a => a.id === id);
            if (album) {
                album.tier = tier;
                album.lists = listsArray;
            }
            initializeUI(); 
        } else alert("Failed to save. Make sure server.py is running.");
    })
    .catch(err => console.error("Save error:", err));
}


// --- SIDEBAR COLLAPSE LOGIC --- //

document.addEventListener('DOMContentLoaded', () => {
    const menuBtn = document.getElementById('mobile-menu-btn');
    const sidebar = document.querySelector('.sidebar');

    if (menuBtn && sidebar) {
        menuBtn.addEventListener('click', () => {
            if (window.innerWidth <= 768) {
                // On mobile, slide the menu in/out
                sidebar.classList.toggle('open');
            } else {
                // On desktop, smoothly shrink/expand it to 0 width
                sidebar.classList.toggle('collapsed');
            }
        });

        // Close sidebar automatically on mobile when a list or tier is tapped
        sidebar.addEventListener('click', (e) => {
            if (window.innerWidth <= 768 && e.target.tagName === 'LI') {
                sidebar.classList.remove('open');
            }
        });
    }
});
