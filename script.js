const firebaseConfig = {
    apiKey: "AIzaSyDxd_AQdG4a5NHn61kNq7u7fSY7JfUjuZU",
    authDomain: "spotify-53dd6.firebaseapp.com",
    projectId: "spotify-53dd6",
    storageBucket: "spotify-53dd6.firebasestorage.app",
    messagingSenderId: "932740952145",
    appId: "1:932740952145:web:357a9c83c710fd133b0870"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const FIRESTORE_PERSISTENCE_READY = db.enablePersistence({ synchronizeTabs: true })
    .then(() => true)
    .catch((err) => {
        console.info("Firestore persistent cache is unavailable in this browser.", err);
        return false;
    });

const PREFS_KEY = "musicVaultPrefs";
const HISTORY_KEY = "musicVaultListeningStats";
const LOCAL_OVERRIDES_KEY = "musicVaultLocalAlbumOverrides";
const SAVED_FILTER_VIEWS_KEY = "musicVaultSavedFilterViews";
const GETTING_STARTED_DISMISSED_KEY = "musicVaultGettingStartedDismissed";
const LAST_BACKUP_KEY = "musicVaultLastBackupAt";
const CATALOG_CACHE_KEY = "musicVaultCatalogCache";
const CATALOG_CACHE_TTL_MS = 10 * 60 * 1000;
const CATALOG_CACHE_MAX_CHARS = 2_000_000;
const IS_LOCAL_EDIT_MODE = ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
const IS_READONLY_PREVIEW = new URLSearchParams(window.location.search).get("mode") === "readonly";
const TIER_FILTERS = ["S", "A", "B", "C", "D", "Unranked"];
const tierOrder = { S: 1, A: 2, B: 3, C: 4, D: 5, Unranked: 99 };

let allAlbums = [];
let localOverrides = {};
let firestoreAlbumsById = new Map();
let savedFilterViews = [];
let catalogLoadMessage = "";
let currentFilter = "All Albums";
let currentView = "ranking";
let currentSort = "default";
let currentSearchQuery = "";
let activeFilters = {
    tier: "",
    list: "",
    durationMin: "",
    durationMax: "",
    ratingMin: "",
    ratingMax: "",
    yearMin: "",
    yearMax: "",
    listening: "",
    trackData: ""
};
let listeningStats = {};
let insightSelection = null;
let activeAlbumViewId = null;
let tableSortCol = null;
let tableSortAsc = true;
let isColumnResizing = false;
let draggedAlbumId = null;
let currentEditingId = null;
let lastFocusedElement = null;
let searchTimer = null;
let undoTimer = null;
let undoPayload = null;
const selectedAlbumIds = new Set();

function canEdit() {
    return IS_LOCAL_EDIT_MODE && !IS_READONLY_PREVIEW;
}

function loadPrefs() {
    try {
        const prefs = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
        if (["ranking", "list", "table", "insights"].includes(prefs.view)) currentView = prefs.view;
        if (["default", "rating-desc", "rating-asc", "year-desc", "year-asc", "duration-desc", "duration-asc"].includes(prefs.sort)) {
            currentSort = prefs.sort;
        }
        const savedFilters = prefs.filters || {};
        const validNumber = (value, min, max = Infinity, integer = false) => {
            if (value === undefined || value === null || value === "") return "";
            const number = Number(value);
            return Number.isFinite(number) && number >= min && number <= max &&
                (!integer || Number.isInteger(number))
                ? String(number)
                : "";
        };
        activeFilters = {
            tier: TIER_FILTERS.includes(savedFilters.tier) ? savedFilters.tier : "",
            list: typeof savedFilters.list === "string" ? savedFilters.list : "",
            durationMin: validNumber(savedFilters.durationMin ?? prefs.minDurationMinutes, 0),
            durationMax: validNumber(savedFilters.durationMax ?? prefs.maxDurationMinutes, 0),
            ratingMin: validNumber(savedFilters.ratingMin, 0, 10),
            ratingMax: validNumber(savedFilters.ratingMax, 0, 10),
            yearMin: validNumber(savedFilters.yearMin, 0, 9999, true),
            yearMax: validNumber(savedFilters.yearMax, 0, 9999, true),
            listening: ["listened", "unlistened"].includes(savedFilters.listening) ? savedFilters.listening : "",
            trackData: ["missing", "duration", "issues"].includes(savedFilters.trackData) ? savedFilters.trackData : ""
        };
        if (activeFilters.durationMin !== "" && activeFilters.durationMax !== "" &&
            Number(activeFilters.durationMin) > Number(activeFilters.durationMax)) {
            activeFilters.durationMin = "";
            activeFilters.durationMax = "";
        }
        if (activeFilters.ratingMin !== "" && activeFilters.ratingMax !== "" &&
            Number(activeFilters.ratingMin) > Number(activeFilters.ratingMax)) {
            activeFilters.ratingMin = "";
            activeFilters.ratingMax = "";
        }
        if (activeFilters.yearMin !== "" && activeFilters.yearMax !== "" &&
            Number(activeFilters.yearMin) > Number(activeFilters.yearMax)) {
            activeFilters.yearMin = "";
            activeFilters.yearMax = "";
        }
    } catch (err) {
        console.warn("Could not load saved view preferences.", err);
    }
}

function savePrefs() {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
        view: currentView,
        sort: currentSort,
        filters: activeFilters
    }));
}

function formatTrackTime(ms) {
    if (!ms || isNaN(ms)) return "-:--";
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatDuration(ms) {
    if (!ms) return "Unknown Duration";
    const totalMinutes = Math.floor(ms / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return hours > 0 ? `${hours} hr ${minutes} min` : `${minutes} min`;
}

function cssUrl(value) {
    return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function albumMatchesSearch(album, query) {
    if (!query) return true;
    const name = (album.album_name || "").toLowerCase();
    const artist = (album.artist || "").toLowerCase();
    if (name.includes(query) || artist.includes(query)) return true;
    return (album.tracks || []).some((track) =>
        String(track && track.name ? track.name : "").toLowerCase().includes(query)
    );
}

function getFocusable(container) {
    return Array.from(container.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )).filter((el) => !el.disabled && el.offsetParent !== null);
}

function trapFocus(event, modal) {
    if (event.key !== "Tab") return;
    const focusable = getFocusable(modal);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
}

function openOverlay(modal, firstFocusSelector) {
    lastFocusedElement = document.activeElement;
    modal.style.display = "flex";
    modal.setAttribute("aria-hidden", "false");
    const first = modal.querySelector(firstFocusSelector) || getFocusable(modal)[0];
    if (first) first.focus();
}

function closeOverlay(modal) {
    modal.style.display = "none";
    modal.setAttribute("aria-hidden", "true");
    if (lastFocusedElement && typeof lastFocusedElement.focus === "function") {
        lastFocusedElement.focus();
    }
}

function showStatus(message, isError) {
    const container = document.getElementById("main-container");
    container.replaceChildren();
    const p = document.createElement("p");
    p.className = isError ? "status-message error" : "status-message";
    p.textContent = message;
    container.appendChild(p);
}

function updateModeUI() {
    document.body.classList.toggle("is-editing", canEdit());
    document.body.classList.toggle("is-readonly", !canEdit());
    document.getElementById("mode-label").textContent = canEdit() ? "Local editing" : "Read only";
    document.getElementById("btn-import-backup").hidden = !canEdit();
    document.getElementById("btn-clear-local-edits").hidden = !canEdit();
    document.getElementById("btn-import-history").hidden = !canEdit();
    document.getElementById("save-status-group").hidden = !canEdit();
    updatePendingEdits();
}

function updateGettingStarted() {
    const guide = document.getElementById("getting-started");
    if (!guide) return;
    try {
        guide.hidden = localStorage.getItem(GETTING_STARTED_DISMISSED_KEY) === "true";
    } catch (err) {
        console.warn("Could not read getting-started preference.", err);
        guide.hidden = false;
    }
    document.getElementById("getting-started-copy").textContent = canEdit()
        ? "Browse your albums, use Filter to narrow the collection, and save useful combinations as views. Changes and imported listening history stay in this browser; this website only reads from Firebase."
        : "Browse and search the catalog, use Filter to narrow it, and save useful combinations as views in this browser. This deployed view is read-only and only reads the album catalog from Firebase.";
}

function dismissGettingStarted() {
    document.getElementById("getting-started").hidden = true;
    try {
        localStorage.setItem(GETTING_STARTED_DISMISSED_KEY, "true");
    } catch (err) {
        console.warn("Could not save getting-started preference.", err);
    }
}

function updatePendingEdits() {
    const count = Object.keys(localOverrides).length;
    let lastBackupValue = "";
    try {
        lastBackupValue = localStorage.getItem(LAST_BACKUP_KEY) || "";
    } catch (err) {
        console.warn("Could not read backup timestamp from browser storage.", err);
    }
    const lastBackup = Date.parse(lastBackupValue);
    const backupLabel = Number.isFinite(lastBackup)
        ? `Last backup ${new Date(lastBackup).toLocaleDateString()}`
        : "No backup exported yet";
    const status = document.getElementById("save-status");
    if (!status) return;
    status.textContent = `${count
        ? `${count} local album ${count === 1 ? "override" : "overrides"} not published`
        : "No unpublished local changes"} · ${backupLabel}`;
    status.classList.remove("error");
    renderCatalogLoadMessage();
}

function renderCatalogLoadMessage() {
    const message = document.getElementById("catalog-load-message");
    if (!message) return;
    const count = Object.keys(localOverrides).length;
    const localStatus = count
        ? ` Display includes ${count} unpublished local album ${count === 1 ? "override" : "overrides"}; these edits are not in Firestore.`
        : "";
    message.textContent = `${catalogLoadMessage}${localStatus}`;
}

function setupInteractiveStars(containerId, initialRating, onSaveCallback, displayValueId) {
    const container = document.getElementById(containerId);
    if (!container) return null;
    container.replaceChildren();

    let currentSelected = parseFloat(initialRating) || 0;
    const editable = canEdit();
    container.classList.toggle("stars-readonly", !editable);

    const updateVisuals = (value) => {
        const stars = container.querySelectorAll(".star-node, .modal-star, .track-star");
        stars.forEach((star, index) => {
            const i = index + 1;
            star.classList.toggle("filled", value >= i);
            star.classList.toggle("half", value >= i - 0.5 && value < i);
        });
        if (displayValueId) {
            const display = document.getElementById(displayValueId);
            if (display) display.textContent = value;
        }
    };

    for (let i = 1; i <= 10; i++) {
        const star = document.createElement("span");
        star.className = containerId.includes("modal")
            ? "modal-star"
            : (containerId.includes("track") ? "track-star" : "star-node");
        star.textContent = "★";
        star.setAttribute("aria-hidden", "true");

        if (editable) {
            star.addEventListener("mousemove", (e) => {
                const rect = star.getBoundingClientRect();
                const isHalf = (e.clientX - rect.left) < (rect.width / 2);
                updateVisuals(isHalf ? i - 0.5 : i);
            });

            star.addEventListener("click", (e) => {
                const rect = star.getBoundingClientRect();
                const isHalf = (e.clientX - rect.left) < (rect.width / 2);
                const clickedValue = isHalf ? i - 0.5 : i;
                currentSelected = currentSelected === clickedValue ? 0 : clickedValue;
                updateVisuals(currentSelected);
                if (onSaveCallback) onSaveCallback(currentSelected);
            });
        }

        container.appendChild(star);
    }

    if (editable) {
        container.addEventListener("mouseleave", () => updateVisuals(currentSelected));
    }

    updateVisuals(currentSelected);
    return (newRating) => {
        currentSelected = newRating;
        updateVisuals(currentSelected);
    };
}

function updateSidebar() {
    const listsSet = new Set();
    const tierCounts = { S: 0, A: 0, B: 0, C: 0, D: 0, Unranked: 0 };

    allAlbums.forEach((album) => {
        const tier = album.tier || "Unranked";
        if (tierCounts[tier] !== undefined) tierCounts[tier] += 1;
        else tierCounts.Unranked += 1;
        (album.lists || []).forEach((listName) => {
            if (listName.trim() !== "") listsSet.add(listName.trim());
        });
    });

    const categoryList = document.getElementById("category-list");
    if (!categoryList) return;
    categoryList.replaceChildren();

    const appendNavItem = (label, filterValue, extraClass, count) => {
        const li = document.createElement("li");
        li.className = extraClass || "";
        if (currentFilter === filterValue) li.classList.add("active");
        li.setAttribute("role", "button");
        li.tabIndex = extraClass === "sidebar-divider" ? -1 : 0;
        if (currentFilter === filterValue) li.setAttribute("aria-current", "page");

        const nameSpan = document.createElement("span");
        nameSpan.textContent = label;
        li.appendChild(nameSpan);

        if (typeof count === "number") {
            const countSpan = document.createElement("span");
            countSpan.className = "nav-count";
            countSpan.textContent = String(count);
            li.appendChild(countSpan);
        }

        li.addEventListener("click", () => handleNav(filterValue));
        li.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                handleNav(filterValue);
            }
        });
        return li;
    };

    categoryList.appendChild(appendNavItem("All Albums", "All Albums", "", allAlbums.length));

    TIER_FILTERS.forEach((tier) => {
        const label = tier === "Unranked" ? "Unranked" : `${tier} Tier`;
        const li = appendNavItem(label, tier, "sidebar-tier", tierCounts[tier]);
        li.dataset.tier = tier;
        if (canEdit()) {
            li.addEventListener("dragover", handleSidebarDragOver);
            li.addEventListener("dragleave", handleSidebarDragLeave);
            li.addEventListener("drop", handleSidebarDrop);
        }
        categoryList.appendChild(li);
    });

    if (listsSet.size > 0) {
        const divider = document.createElement("li");
        divider.textContent = "Your Lists";
        divider.className = "sidebar-divider";
        categoryList.appendChild(divider);

        Array.from(listsSet).sort().forEach((listName) => {
            const count = allAlbums.filter((album) => (album.lists || []).includes(listName)).length;
            categoryList.appendChild(appendNavItem(listName, listName, "", count));
        });
    }
    updateFilterListOptions();
}

function handleNav(filterName) {
    insightSelection = null;
    currentFilter = filterName;
    activeAlbumViewId = null;
    if (currentView === "insights") {
        currentView = "ranking";
        savePrefs();
        updateViewButtons();
    }
    const viewToggle = document.querySelector(".view-toggle");
    if (viewToggle) viewToggle.style.display = "flex";
    updateSidebar();
    refreshMainView();
}

function switchView(viewType) {
    if (viewType !== "table") selectedAlbumIds.clear();
    if (viewType === "insights") insightSelection = null;
    currentView = viewType;
    savePrefs();
    updateViewButtons();
    refreshMainView();
}

function updateViewButtons() {
    ["ranking", "list", "table", "insights"].forEach((view) => {
        const button = document.getElementById(`btn-${view}-view`);
        button.classList.toggle("active", currentView === view);
        button.setAttribute("aria-pressed", String(currentView === view));
    });
}

function filterInputsFromUI() {
    return {
        tier: document.getElementById("filter-tier").value,
        list: document.getElementById("filter-list").value,
        durationMin: document.getElementById("filter-duration-min").value.trim(),
        durationMax: document.getElementById("filter-duration-max").value.trim(),
        ratingMin: document.getElementById("filter-rating-min").value.trim(),
        ratingMax: document.getElementById("filter-rating-max").value.trim(),
        yearMin: document.getElementById("filter-year-min").value.trim(),
        yearMax: document.getElementById("filter-year-max").value.trim(),
        listening: document.getElementById("filter-listening").value,
        trackData: document.getElementById("filter-track-data").value
    };
}

function validateFilterInputs(filters) {
    const numberInRange = (value, min, max = Infinity, integer = false) => {
        if (value === "") return true;
        const number = Number(value);
        return Number.isFinite(number) && number >= min && number <= max &&
            (!integer || Number.isInteger(number));
    };
    if (!numberInRange(filters.durationMin, 0) || !numberInRange(filters.durationMax, 0)) {
        return "Album length must be a non-negative number of minutes.";
    }
    if (filters.durationMin !== "" && filters.durationMax !== "" &&
        Number(filters.durationMin) > Number(filters.durationMax)) {
        return "Minimum album length cannot exceed the maximum.";
    }
    if (!numberInRange(filters.ratingMin, 0, 10) || !numberInRange(filters.ratingMax, 0, 10)) {
        return "Ratings must be between 0 and 10.";
    }
    if (filters.ratingMin !== "" && filters.ratingMax !== "" &&
        Number(filters.ratingMin) > Number(filters.ratingMax)) {
        return "Minimum rating cannot exceed the maximum.";
    }
    if (!numberInRange(filters.yearMin, 0, 9999, true) || !numberInRange(filters.yearMax, 0, 9999, true)) {
        return "Release years must be whole numbers.";
    }
    if (filters.yearMin !== "" && filters.yearMax !== "" &&
        Number(filters.yearMin) > Number(filters.yearMax)) {
        return "Start release year cannot exceed the end year.";
    }
    if (filters.tier && !TIER_FILTERS.includes(filters.tier)) return "Choose a valid tier.";
    if (filters.list && !Array.from(document.getElementById("filter-list").options).some((option) => option.value === filters.list)) {
        return "Choose a list from the available options.";
    }
    if (filters.listening && !["listened", "unlistened"].includes(filters.listening)) {
        return "Choose a valid listening-history filter.";
    }
    if (filters.trackData && !["missing", "duration", "issues"].includes(filters.trackData)) {
        return "Choose a valid track-data filter.";
    }
    return "";
}

function activeFilterCount(filters = activeFilters) {
    return [
        Boolean(filters.tier),
        Boolean(filters.list),
        Boolean(filters.durationMin || filters.durationMax),
        Boolean(filters.ratingMin || filters.ratingMax),
        Boolean(filters.yearMin || filters.yearMax),
        Boolean(filters.listening),
        Boolean(filters.trackData)
    ].filter(Boolean).length;
}

function updateFilterButton() {
    const count = activeFilterCount();
    const button = document.getElementById("btn-filters");
    button.textContent = count ? `Filter (${count})` : "Filter";
    button.setAttribute("aria-label", count ? `Filter albums, ${count} active` : "Filter albums");
    button.classList.toggle("has-active-filters", count > 0);
}

function syncFilterInputs() {
    Object.entries({
        "filter-tier": activeFilters.tier,
        "filter-list": activeFilters.list,
        "filter-duration-min": activeFilters.durationMin,
        "filter-duration-max": activeFilters.durationMax,
        "filter-rating-min": activeFilters.ratingMin,
        "filter-rating-max": activeFilters.ratingMax,
        "filter-year-min": activeFilters.yearMin,
        "filter-year-max": activeFilters.yearMax,
        "filter-listening": activeFilters.listening,
        "filter-track-data": activeFilters.trackData
    }).forEach(([id, value]) => {
        document.getElementById(id).value = value;
    });
}

function sanitizeSavedFilterView(view) {
    if (!view || typeof view !== "object" || Array.isArray(view) ||
        typeof view.name !== "string" || !view.name.trim()) return null;
    const source = view.filters && typeof view.filters === "object" && !Array.isArray(view.filters)
        ? view.filters
        : {};
    const numeric = (key, min, max = Infinity, integer = false) => {
        const value = source[key];
        if (value === undefined || value === null || value === "") return "";
        const number = Number(value);
        return Number.isFinite(number) && number >= min && number <= max &&
            (!integer || Number.isInteger(number)) ? String(number) : "";
    };
    const filters = {
        tier: TIER_FILTERS.includes(source.tier) ? source.tier : "",
        list: typeof source.list === "string" ? source.list.slice(0, 100) : "",
        durationMin: numeric("durationMin", 0),
        durationMax: numeric("durationMax", 0),
        ratingMin: numeric("ratingMin", 0, 10),
        ratingMax: numeric("ratingMax", 0, 10),
        yearMin: numeric("yearMin", 0, 9999, true),
        yearMax: numeric("yearMax", 0, 9999, true),
        listening: ["listened", "unlistened"].includes(source.listening) ? source.listening : "",
        trackData: ["missing", "duration", "issues"].includes(source.trackData) ? source.trackData : ""
    };
    if (filters.durationMin && filters.durationMax && Number(filters.durationMin) > Number(filters.durationMax)) {
        filters.durationMin = "";
        filters.durationMax = "";
    }
    if (filters.ratingMin && filters.ratingMax && Number(filters.ratingMin) > Number(filters.ratingMax)) {
        filters.ratingMin = "";
        filters.ratingMax = "";
    }
    if (filters.yearMin && filters.yearMax && Number(filters.yearMin) > Number(filters.yearMax)) {
        filters.yearMin = "";
        filters.yearMax = "";
    }
    const validSorts = [
        "default", "rating-desc", "rating-asc", "year-desc", "year-asc", "duration-desc", "duration-asc"
    ];
    return {
        name: view.name.trim().slice(0, 40),
        filters,
        search: typeof view.search === "string" ? view.search.slice(0, 200) : "",
        sort: validSorts.includes(view.sort) ? view.sort : "default"
    };
}

function loadSavedFilterViews() {
    try {
        const parsed = JSON.parse(localStorage.getItem(SAVED_FILTER_VIEWS_KEY) || "[]");
        if (!Array.isArray(parsed)) throw new Error("Saved filter views must be a list.");
        const names = new Set();
        savedFilterViews = parsed.slice(0, 20).map(sanitizeSavedFilterView).filter((view) => {
            if (!view || names.has(view.name.toLocaleLowerCase())) return false;
            names.add(view.name.toLocaleLowerCase());
            return true;
        });
    } catch (err) {
        console.warn("Could not load saved filter views.", err);
        document.getElementById("saved-filter-view-status").textContent =
            "Saved filter views could not be loaded from this browser.";
    }
    updateSavedFilterViewOptions();
}

function updateSavedFilterViewOptions(selectedName = "") {
    const select = document.getElementById("saved-filter-view-select");
    if (!select) return;
    select.replaceChildren(new Option("Choose a saved view", ""));
    savedFilterViews.forEach((view) => select.add(new Option(view.name, view.name)));
    if (savedFilterViews.some((view) => view.name === selectedName)) select.value = selectedName;
    document.getElementById("btn-apply-filter-view").disabled = !savedFilterViews.length;
    document.getElementById("btn-delete-filter-view").disabled = !select.value;
}

function applySavedFilterView() {
    const selectedName = document.getElementById("saved-filter-view-select").value;
    const view = savedFilterViews.find((item) => item.name === selectedName);
    if (!view) return;
    insightSelection = null;
    updateFilterListOptions();
    activeFilters = { ...view.filters };
    let missingSavedList = false;
    if (activeFilters.list && !Array.from(document.getElementById("filter-list").options)
        .some((option) => option.value === activeFilters.list)) {
        activeFilters.list = "";
        missingSavedList = true;
    }
    currentSearchQuery = view.search;
    document.getElementById("search-input").value = view.search;
    currentSort = view.sort;
    document.getElementById("sort-select").value = view.sort;
    currentFilter = "All Albums";
    activeAlbumViewId = null;
    syncFilterInputs();
    savePrefs();
    updateFilterButton();
    updateSidebar();
    refreshMainView();
    document.getElementById("saved-filter-view-status").textContent = missingSavedList
        ? `Applied "${view.name}", but its saved list no longer exists and was cleared.`
        : `Applied "${view.name}".`;
}

function saveCurrentFilterView() {
    const nameInput = document.getElementById("saved-filter-view-name");
    const name = nameInput.value.trim().slice(0, 40);
    const status = document.getElementById("saved-filter-view-status");
    if (!name) {
        status.textContent = "Enter a name for this saved view.";
        nameInput.focus();
        return;
    }
    const existingIndex = savedFilterViews.findIndex((view) =>
        view.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (existingIndex === -1 && savedFilterViews.length >= 20) {
        status.textContent = "You can save up to 20 filter views. Delete one before adding another.";
        return;
    }
    const nextViews = [...savedFilterViews];
    const savedView = sanitizeSavedFilterView({
        name,
        filters: activeFilters,
        search: currentSearchQuery,
        sort: currentSort
    });
    if (existingIndex === -1) nextViews.push(savedView);
    else nextViews[existingIndex] = savedView;
    try {
        localStorage.setItem(SAVED_FILTER_VIEWS_KEY, JSON.stringify(nextViews));
        savedFilterViews = nextViews;
        updateSavedFilterViewOptions(name);
        nameInput.value = "";
        status.textContent = existingIndex === -1
            ? `Saved "${name}" in this browser.`
            : `Updated "${name}" in this browser.`;
    } catch (err) {
        console.error("Could not save filter view:", err);
        status.textContent = "Could not save this view in browser storage.";
    }
}

function deleteSelectedFilterView() {
    const select = document.getElementById("saved-filter-view-select");
    const selectedName = select.value;
    if (!selectedName) return;
    const nextViews = savedFilterViews.filter((view) => view.name !== selectedName);
    try {
        localStorage.setItem(SAVED_FILTER_VIEWS_KEY, JSON.stringify(nextViews));
        savedFilterViews = nextViews;
        updateSavedFilterViewOptions();
        document.getElementById("saved-filter-view-status").textContent = `Deleted "${selectedName}".`;
    } catch (err) {
        console.error("Could not delete saved filter view:", err);
        document.getElementById("saved-filter-view-status").textContent =
            "Could not delete this view from browser storage.";
    }
}

function applyFiltersFromUI() {
    const nextFilters = filterInputsFromUI();
    const error = validateFilterInputs(nextFilters);
    const errorElement = document.getElementById("filter-error");
    if (error) {
        errorElement.textContent = error;
        return;
    }
    insightSelection = null;
    activeFilters = nextFilters;
    errorElement.textContent = "";
    savePrefs();
    updateFilterButton();
    refreshMainView();
}

function updateFilterListOptions() {
    const select = document.getElementById("filter-list");
    const selected = activeFilters.list;
    const lists = new Set();
    allAlbums.forEach((album) => (album.lists || []).forEach((name) => {
        if (String(name).trim()) lists.add(String(name).trim());
    }));
    select.replaceChildren(new Option("Any list", ""));
    Array.from(lists).sort((a, b) => a.localeCompare(b)).forEach((name) => {
        select.add(new Option(name, name));
    });
    if (selected && lists.has(selected)) select.value = selected;
    else if (selected) activeFilters.list = "";
    updateFilterButton();
}

function getAlbumDataIssues(album) {
    const issues = [];
    const tracks = Array.isArray(album.tracks) ? album.tracks : [];
    const hasMissingNames = !tracks.length || tracks.some((track) => {
        const name = String(track && track.name || "").trim();
        if (!name) return true;
        if (!/^Track\s+\d+$/i.test(name)) return false;
        const isCharliPop2Title = String(album.artist || "").trim().toLocaleLowerCase() === "charli xcx" &&
            String(album.album_name || "").trim().toLocaleLowerCase() === "pop 2" &&
            Number(track && track.track_number) === 10 &&
            name.toLocaleLowerCase() === "track 10";
        return !isCharliPop2Title;
    });
    if (hasMissingNames) issues.push("tracks");
    const expectedTracks = Number(album.total_tracks) || 0;
    if (expectedTracks > 0 && tracks.length > 0 && tracks.length !== expectedTracks) {
        issues.push("track-count");
    }
    if (!(Number(album.duration_ms) > 0)) issues.push("duration");
    return issues;
}

function updateCatalogHealth() {
    const panel = document.getElementById("catalog-health");
    if (!panel) return;
    if (!canEdit()) {
        panel.replaceChildren();
        panel.hidden = true;
        return;
    }
    const issueSets = allAlbums.map((album) => getAlbumDataIssues(album));
    const missingTracklists = allAlbums.filter((album, index) =>
        issueSets[index].includes("tracks") && (!Array.isArray(album.tracks) || album.tracks.length === 0)
    ).length;
    const incompleteTracklists = issueSets.filter((issues) =>
        (issues.includes("tracks") || issues.includes("track-count"))
    ).length - missingTracklists;
    const missingDuration = issueSets.filter((issues) => issues.includes("duration")).length;
    const affected = issueSets.filter((issues) => issues.length > 0).length;
    panel.replaceChildren();
    if (!allAlbums.length || !affected) {
        panel.hidden = true;
        return;
    }
    panel.hidden = false;
    const summary = document.createElement("div");
    summary.className = "catalog-health-summary";
    const heading = document.createElement("strong");
    heading.textContent = `${affected} albums have known catalog data gaps`;
    const details = document.createElement("span");
    details.textContent =
        `${missingTracklists} missing tracklists · ${incompleteTracklists} incomplete tracklists · ` +
        `${missingDuration} missing durations. Counts reflect the catalog currently loaded below.`;
    summary.append(heading, details);
    const review = document.createElement("button");
    review.type = "button";
    review.className = "catalog-health-action";
    review.textContent = "Review albums";
    review.addEventListener("click", () => {
        currentFilter = "All Albums";
        insightSelection = null;
        currentSearchQuery = "";
        document.getElementById("search-input").value = "";
        activeFilters.trackData = "issues";
        syncFilterInputs();
        savePrefs();
        updateFilterButton();
        currentView = "list";
        updateViewButtons();
        updateSidebar();
        refreshMainView();
    });
    const issuesDetails = document.createElement("details");
    issuesDetails.className = "catalog-health-issues";
    const issuesSummary = document.createElement("summary");
    issuesSummary.textContent = `Show affected albums (${affected})`;
    const issuesList = document.createElement("ul");
    issuesList.className = "catalog-health-issue-list";
    allAlbums.forEach((album, index) => {
        const issues = issueSets[index];
        if (!issues.length) return;
        const item = document.createElement("li");
        const albumInfo = document.createElement("div");
        albumInfo.className = "catalog-health-album-info";
        const albumName = document.createElement("strong");
        albumName.textContent = album.album_name || "Untitled album";
        const artistName = document.createElement("span");
        artistName.textContent = album.artist || "Unknown artist";
        const reasons = document.createElement("span");
        reasons.className = "catalog-health-issue-reasons";
        const labels = [];
        if (issues.includes("tracks")) {
            const tracks = Array.isArray(album.tracks) ? album.tracks : [];
            labels.push(!tracks.length ? "No tracklist" : "Missing or placeholder track names");
        }
        if (issues.includes("track-count")) {
            const actualCount = Array.isArray(album.tracks) ? album.tracks.length : 0;
            labels.push(`Track count mismatch (${actualCount}/${Number(album.total_tracks)})`);
        }
        if (issues.includes("duration")) labels.push("Missing album duration");
        reasons.textContent = labels.join(" · ");
        albumInfo.append(albumName, artistName, reasons);
        const openAlbum = document.createElement("button");
        openAlbum.type = "button";
        openAlbum.className = "catalog-health-action";
        openAlbum.textContent = "Open album";
        openAlbum.setAttribute(
            "aria-label",
            `Open ${album.album_name || "untitled album"} by ${album.artist || "unknown artist"}`
        );
        openAlbum.addEventListener("click", () => viewAlbumInfo(String(album.id)));
        item.append(albumInfo, openAlbum);
        issuesList.appendChild(item);
    });
    issuesDetails.append(issuesSummary, issuesList);
    panel.append(summary, review, issuesDetails);
}

function filterLabels(filters = activeFilters) {
    const labels = [];
    if (filters.tier) labels.push(["tier", `${filters.tier} Tier`]);
    if (filters.list) labels.push(["list", `List: ${filters.list}`]);
    if (filters.durationMin || filters.durationMax) {
        labels.push(["duration", `${filters.durationMin || "0"}–${filters.durationMax || "∞"} min`]);
    }
    if (filters.ratingMin || filters.ratingMax) {
        labels.push(["rating", `Rating ${filters.ratingMin || "0"}–${filters.ratingMax || "10"}`]);
    }
    if (filters.yearMin || filters.yearMax) {
        labels.push(["year", `Year ${filters.yearMin || "any"}–${filters.yearMax || "any"}`]);
    }
    if (filters.listening) labels.push(["listening", filters.listening === "listened" ? "Listened" : "Not listened"]);
    if (filters.trackData) {
        labels.push(["trackData", {
            missing: "Missing track names",
            duration: "Missing duration",
            issues: "Data issues"
        }[filters.trackData]]);
    }
    return labels;
}

function clearFilterKey(key) {
    insightSelection = null;
    const keys = key === "duration" ? ["durationMin", "durationMax"]
        : key === "rating" ? ["ratingMin", "ratingMax"]
            : key === "year" ? ["yearMin", "yearMax"] : [key];
    keys.forEach((filterKey) => { activeFilters[filterKey] = ""; });
    syncFilterInputs();
    savePrefs();
    updateFilterButton();
    refreshMainView();
}

function clearAllSelections() {
    insightSelection = null;
    currentSearchQuery = "";
    currentFilter = "All Albums";
    document.getElementById("search-input").value = "";
    activeFilters = {
        tier: "", list: "", durationMin: "", durationMax: "",
        ratingMin: "", ratingMax: "", yearMin: "", yearMax: "",
        listening: "", trackData: ""
    };
    syncFilterInputs();
    updateSidebar();
    updateFilterButton();
    savePrefs();
    refreshMainView();
}

function updateResultsSummary(visibleCount) {
    const summary = document.getElementById("results-summary");
    summary.replaceChildren();
    const count = document.createElement("strong");
    count.textContent = `${visibleCount.toLocaleString()} of ${allAlbums.length.toLocaleString()} albums`;
    summary.appendChild(count);
    if (insightSelection) {
        const insightChip = document.createElement("button");
        insightChip.type = "button";
        insightChip.className = "filter-chip";
        insightChip.textContent = `Insight: ${insightSelection.label} ×`;
        insightChip.setAttribute("aria-label", `Clear insight selection: ${insightSelection.label}`);
        insightChip.addEventListener("click", () => {
            insightSelection = null;
            refreshMainView();
        });
        summary.appendChild(insightChip);
    }
    if (currentSearchQuery) {
        const searchChip = document.createElement("button");
        searchChip.type = "button";
        searchChip.className = "filter-chip";
        searchChip.textContent = `Search: ${currentSearchQuery} ×`;
        searchChip.setAttribute("aria-label", `Clear search ${currentSearchQuery}`);
        searchChip.addEventListener("click", () => {
            insightSelection = null;
            currentSearchQuery = "";
            document.getElementById("search-input").value = "";
            refreshMainView();
        });
        summary.appendChild(searchChip);
    }
    if (currentFilter !== "All Albums") {
        const libraryChip = document.createElement("button");
        libraryChip.type = "button";
        libraryChip.className = "filter-chip";
        libraryChip.textContent = `Library: ${currentFilter} ×`;
        libraryChip.setAttribute("aria-label", `Clear library selection ${currentFilter}`);
        libraryChip.addEventListener("click", () => handleNav("All Albums"));
        summary.appendChild(libraryChip);
    }
    filterLabels().forEach(([key, label]) => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "filter-chip";
        chip.textContent = `${label} ×`;
        chip.setAttribute("aria-label", `Remove filter: ${label}`);
        chip.addEventListener("click", () => clearFilterKey(key));
        summary.appendChild(chip);
    });
    if (insightSelection || currentSearchQuery || currentFilter !== "All Albums" || activeFilterCount()) {
        const clear = document.createElement("button");
        clear.type = "button";
        clear.className = "clear-all-chips";
        clear.textContent = "Clear all";
        clear.addEventListener("click", clearAllSelections);
        summary.appendChild(clear);
    }
}

function filteredAlbums() {
    const isTierFilter = TIER_FILTERS.includes(currentFilter);
    let albumsToRender = allAlbums;

    if (currentFilter !== "All Albums") {
        if (isTierFilter) {
            albumsToRender = allAlbums.filter((album) => (album.tier || "Unranked") === currentFilter);
        } else {
            albumsToRender = allAlbums.filter((album) => (album.lists || []).includes(currentFilter));
        }
    }

    if (currentSearchQuery) {
        albumsToRender = albumsToRender.filter((album) => albumMatchesSearch(album, currentSearchQuery));
    }

    const filters = activeFilters;
    if (filters.tier) albumsToRender = albumsToRender.filter((album) => (album.tier || "Unranked") === filters.tier);
    if (filters.list) albumsToRender = albumsToRender.filter((album) => (album.lists || []).includes(filters.list));
    if (filters.durationMin || filters.durationMax) {
        albumsToRender = albumsToRender.filter((album) => {
            const duration = Number(album.duration_ms) || 0;
            const minutes = duration / 60000;
            return duration > 0 &&
                (!filters.durationMin || minutes >= Number(filters.durationMin)) &&
                (!filters.durationMax || minutes <= Number(filters.durationMax));
        });
    }
    if (filters.ratingMin || filters.ratingMax) {
        albumsToRender = albumsToRender.filter((album) => {
            const rating = Number(album.rating) || 0;
            return (!filters.ratingMin || rating >= Number(filters.ratingMin)) &&
                (!filters.ratingMax || rating <= Number(filters.ratingMax));
        });
    }
    if (filters.yearMin || filters.yearMax) {
        albumsToRender = albumsToRender.filter((album) => {
            const year = Number.parseInt(String(album.release_date || "").slice(0, 4), 10);
            return Number.isFinite(year) &&
                (!filters.yearMin || year >= Number(filters.yearMin)) &&
                (!filters.yearMax || year <= Number(filters.yearMax));
        });
    }
    if (filters.listening) {
        albumsToRender = albumsToRender.filter((album) => {
            const listened = Boolean(listeningStats[album.id] && listeningStats[album.id].plays > 0);
            return filters.listening === "listened" ? listened : !listened;
        });
    }
    if (filters.trackData) {
        albumsToRender = albumsToRender.filter((album) => {
            const issues = getAlbumDataIssues(album);
            if (filters.trackData === "missing") {
                return issues.includes("tracks") || issues.includes("track-count");
            }
            if (filters.trackData === "duration") return issues.includes("duration");
            return issues.length > 0;
        });
    }
    if (insightSelection) {
        const selectedIds = new Set(insightSelection.albumIds);
        albumsToRender = albumsToRender.filter((album) => selectedIds.has(String(album.id)));
    }

    const sortedAlbums = [...albumsToRender];
    if (currentSort !== "default") {
        sortedAlbums.sort((a, b) => {
            if (currentSort === "rating-desc") return (b.rating || 0) - (a.rating || 0);
            if (currentSort === "rating-asc") return (a.rating || 0) - (b.rating || 0);
            if (currentSort.startsWith("year")) {
                const yearA = a.release_date ? parseInt(a.release_date.split("-")[0], 10) : 0;
                const yearB = b.release_date ? parseInt(b.release_date.split("-")[0], 10) : 0;
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
    return sortedAlbums;
}

function selectInsightAlbums(label, albumIds) {
    if (!albumIds.length) return;
    insightSelection = { label, albumIds: [...new Set(albumIds.map(String))] };
    currentFilter = "All Albums";
    currentSearchQuery = "";
    document.getElementById("search-input").value = "";
    activeFilters = {
        tier: "", list: "", durationMin: "", durationMax: "",
        ratingMin: "", ratingMax: "", yearMin: "", yearMax: "",
        listening: "", trackData: ""
    };
    currentView = "list";
    activeAlbumViewId = null;
    syncFilterInputs();
    savePrefs();
    updateFilterButton();
    updateViewButtons();
    updateSidebar();
    refreshMainView();
}

function appendInsightList(parent, entries, emptyMessage) {
    const list = document.createElement("ul");
    list.className = "insight-list";
    if (!entries.length) {
        const empty = document.createElement("li");
        empty.textContent = emptyMessage;
        list.appendChild(empty);
    } else {
        entries.forEach(([label, value, albumIds]) => {
            const row = document.createElement("li");
            const name = document.createElement(albumIds && albumIds.length ? "button" : "span");
            name.textContent = label;
            const stat = document.createElement("strong");
            stat.textContent = value;
            if (albumIds && albumIds.length) {
                name.type = "button";
                name.className = "insight-row-button";
                name.setAttribute("aria-label", `Show ${albumIds.length} albums for ${label}`);
                name.addEventListener("click", () => selectInsightAlbums(label, albumIds));
                row.append(name, stat);
            } else {
                row.append(name, stat);
            }
            list.appendChild(row);
        });
    }
    parent.appendChild(list);
}

function createInsightPanel(title, entries, emptyMessage) {
    const panel = document.createElement("section");
    panel.className = "insight-panel";
    const heading = document.createElement("h2");
    heading.textContent = title;
    panel.appendChild(heading);
    appendInsightList(panel, entries, emptyMessage);
    return panel;
}

function renderInsightsView(container) {
    const ratedAlbums = allAlbums.filter((album) => Number(album.rating) > 0);
    const ratingTotal = ratedAlbums.reduce((total, album) => total + Number(album.rating), 0);
    const avgRating = ratedAlbums.length ? (ratingTotal / ratedAlbums.length).toFixed(1) : "—";
    const totalListeningMs = Object.values(listeningStats)
        .reduce((total, stats) => total + (Number(stats.msPlayed) || 0), 0);
    const totalPlays = Object.values(listeningStats)
        .reduce((total, stats) => total + (Number(stats.plays) || 0), 0);
    const listenedAlbums = allAlbums.filter((album) =>
        Number(listeningStats[album.id] && listeningStats[album.id].plays) > 0
    ).length;

    const summary = document.createElement("div");
    summary.className = "insights-summary";
    [
        ["Albums", String(allAlbums.length), `${ratedAlbums.length} rated`],
        ["Average rating", avgRating, "Across rated albums"],
        ["Listening time", totalListeningMs ? formatDuration(totalListeningMs) : "0 min", `${totalPlays.toLocaleString()} matched plays`],
        ["Listening coverage", `${listenedAlbums} / ${allAlbums.length}`, allAlbums.length
            ? `${Math.round((listenedAlbums / allAlbums.length) * 100)}% of albums have matched plays`
            : "Import history to see coverage"]
    ].forEach(([label, value, note]) => {
        const card = document.createElement("section");
        card.className = "insight-card";
        const heading = document.createElement("h3");
        heading.textContent = label;
        const number = document.createElement("p");
        number.className = "insight-value";
        number.textContent = value;
        const detail = document.createElement("p");
        detail.textContent = note;
        card.append(heading, number, detail);
        summary.appendChild(card);
    });

    const tiers = {};
    const decades = {};
    const artists = {};
    allAlbums.forEach((album) => {
        const tier = album.tier || "Unranked";
        if (!tiers[tier]) tiers[tier] = [];
        tiers[tier].push(String(album.id));
        const year = Number.parseInt(String(album.release_date || "").slice(0, 4), 10);
        if (Number.isFinite(year) && year > 0) {
            const decade = `${Math.floor(year / 10) * 10}s`;
            if (!decades[decade]) decades[decade] = [];
            decades[decade].push(String(album.id));
        }
        const artist = String(album.artist || "Unknown artist");
        if (!artists[artist]) artists[artist] = [];
        artists[artist].push(String(album.id));
    });

    const topRated = [...ratedAlbums]
        .sort((a, b) => Number(b.rating) - Number(a.rating))
        .slice(0, 10)
        .map((album) => [
            `${album.album_name} — ${album.artist}`,
            `${Number(album.rating).toFixed(1)} / 10`,
            [String(album.id)]
        ]);
    const mostListened = allAlbums
        .filter((album) => listeningStats[album.id])
        .sort((a, b) => (Number(listeningStats[b.id].msPlayed) || 0) - (Number(listeningStats[a.id].msPlayed) || 0))
        .slice(0, 10)
        .map((album) => {
            const stats = listeningStats[album.id];
            return [
                `${album.album_name} — ${album.artist}`,
                `${Number(stats.plays).toLocaleString()} plays · ${formatDuration(Number(stats.msPlayed))}`,
                [String(album.id)]
            ];
        });
    const recentlyPlayed = allAlbums
        .filter((album) => listeningStats[album.id] && listeningStats[album.id].lastPlayedAt)
        .sort((a, b) => Date.parse(listeningStats[b.id].lastPlayedAt) - Date.parse(listeningStats[a.id].lastPlayedAt))
        .slice(0, 10)
        .map((album) => [
            `${album.album_name} — ${album.artist}`,
            new Date(listeningStats[album.id].lastPlayedAt).toLocaleDateString(),
            [String(album.id)]
        ]);

    const columns = document.createElement("div");
    columns.className = "insights-columns";
    const listeningHistoryEmptyMessage = canEdit()
        ? "Import Spotify history to populate this list."
        : "Available after importing history in local editing mode.";
    columns.append(
        createInsightPanel(
            "Albums by tier",
            Object.entries(tiers)
                .sort((a, b) => (tierOrder[a[0]] || 98) - (tierOrder[b[0]] || 98))
                .map(([tier, albumIds]) => [tier, albumIds.length, albumIds]),
            "No albums yet."
        ),
        createInsightPanel(
            "Albums by decade",
            Object.entries(decades)
                .sort((a, b) => Number.parseInt(a[0], 10) - Number.parseInt(b[0], 10))
                .map(([decade, albumIds]) => [decade, albumIds.length, albumIds]),
            "No release years available."
        ),
        createInsightPanel(
            "Artists with most albums",
            Object.entries(artists)
                .sort((a, b) => b[1].length - a[1].length)
                .slice(0, 10)
                .map(([artist, albumIds]) => [artist, albumIds.length, albumIds]),
            "No artists available."
        ),
        createInsightPanel("Top rated", topRated, "Rate albums to see your top picks."),
        createInsightPanel("Most listened", mostListened, listeningHistoryEmptyMessage),
        createInsightPanel("Recently played", recentlyPlayed, "No recent matched plays available.")
    );

    const dashboard = document.createElement("div");
    dashboard.className = "insights-dashboard";
    const note = document.createElement("p");
    note.className = "insight-note";
    note.textContent = "Listening history is matched locally by exact track and artist names. Ambiguous matches are skipped; history files and play summaries stay in this browser.";
    dashboard.append(summary, columns, note);
    container.appendChild(dashboard);
}

function refreshMainView() {
    if (activeAlbumViewId) {
        document.getElementById("catalog-health").hidden = true;
        document.getElementById("results-summary").hidden = true;
        renderAlbumDetailView(activeAlbumViewId);
        return;
    }

    document.getElementById("catalog-health").hidden = false;
    document.getElementById("results-summary").hidden = currentView === "insights";
    updateCatalogHealth();
    const isTierFilter = TIER_FILTERS.includes(currentFilter);
    document.getElementById("current-view-title").textContent = currentView === "insights"
        ? "Insights"
        : isTierFilter && currentFilter !== "Unranked" ? `${currentFilter} Tier` : currentFilter;

    const sortedAlbums = filteredAlbums();
    if (currentView !== "table" || sortedAlbums.length === 0) selectedAlbumIds.clear();
    updateResultsSummary(sortedAlbums.length);
    const container = document.getElementById("main-container");
    container.replaceChildren();

    if (currentView === "insights") {
        renderInsightsView(container);
        return;
    }

    if (sortedAlbums.length === 0) {
        const hasSelection = currentSearchQuery || activeFilterCount() || currentFilter !== "All Albums";
        const empty = document.createElement("section");
        empty.className = "empty-state";
        empty.setAttribute("role", "status");
        const heading = document.createElement("h2");
        heading.textContent = hasSelection ? "No albums match this view" : "No albums found";
        const description = document.createElement("p");
        description.textContent = hasSelection
            ? "Try removing a filter or changing your search to see more albums."
            : "Your albums will appear here when the catalog is available.";
        empty.append(heading, description);
        if (hasSelection) {
            const clear = document.createElement("button");
            clear.type = "button";
            clear.className = "empty-state-action";
            clear.textContent = "Clear search and filters";
            clear.addEventListener("click", clearAllSelections);
            empty.appendChild(clear);
        }
        container.appendChild(empty);
        return;
    }

    if (currentView === "table") {
        renderTableView(sortedAlbums, container);
    } else if (currentView === "ranking" && !isTierFilter) {
        renderRankingView(sortedAlbums, container);
    } else {
        renderListView(sortedAlbums, container);
    }
}

function createAlbumCard(album) {
    const card = document.createElement("div");
    card.className = "album-card";
    card.dataset.id = album.id;
    card.setAttribute("role", "button");
    card.tabIndex = 0;
    card.addEventListener("click", () => viewAlbumInfo(album.id));
    card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            viewAlbumInfo(album.id);
        }
    });

    if (canEdit()) {
        card.draggable = true;
        card.addEventListener("dragstart", handleDragStart);
        card.addEventListener("dragend", handleDragEnd);
    }

    const imgContainer = document.createElement("div");
    imgContainer.className = "album-image-container";

    const img = document.createElement("img");
    img.src = album.thumbnail_url || "";
    img.alt = `${album.album_name || "Album"} cover`;
    img.loading = "lazy";
    imgContainer.appendChild(img);

    if (album.spotify_url) {
        const spotifyBtn = document.createElement("a");
        spotifyBtn.className = "spotify-open-btn";
        spotifyBtn.href = album.spotify_url;
        spotifyBtn.target = "_blank";
        spotifyBtn.rel = "noopener noreferrer";
        spotifyBtn.title = "Open in Spotify";
        spotifyBtn.setAttribute("aria-label", `Open ${album.album_name} in Spotify`);
        spotifyBtn.textContent = "▶";
        spotifyBtn.addEventListener("click", (e) => e.stopPropagation());
        imgContainer.appendChild(spotifyBtn);
    }

    if (canEdit()) {
        const editBtn = document.createElement("button");
        editBtn.className = "edit-btn";
        editBtn.type = "button";
        editBtn.textContent = "✎";
        editBtn.setAttribute("aria-label", `Edit ${album.album_name}`);
        editBtn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            openModal(album);
        });
        imgContainer.appendChild(editBtn);
    }

    const titleDiv = document.createElement("div");
    titleDiv.className = "album-title";
    titleDiv.title = album.album_name;
    titleDiv.textContent = album.album_name;

    const artistDiv = document.createElement("div");
    artistDiv.className = "album-artist";
    artistDiv.textContent = album.artist;

    const ratingBadge = document.createElement("div");
    ratingBadge.className = "card-rating";
    const star = document.createElement("span");
    star.style.color = "#FFD700";
    star.textContent = "★";
    const ratingValue = document.createElement("span");
    ratingValue.style.color = "white";
    ratingValue.style.marginLeft = "4px";
    ratingValue.style.fontWeight = "700";
    ratingValue.textContent = (album.rating || 0).toFixed(1);
    ratingBadge.append(star, ratingValue);

    card.append(imgContainer, titleDiv, artistDiv, ratingBadge);
    return card;
}

function renderListView(albumsToRender, container) {
    const grid = document.createElement("div");
    grid.className = "album-grid";
    albumsToRender.forEach((album) => grid.appendChild(createAlbumCard(album)));
    container.appendChild(grid);
}

function renderRankingView(albumsToRender, container) {
    const groupedByTier = { S: [], A: [], B: [], C: [], D: [], Unranked: [] };

    albumsToRender.forEach((album) => {
        const tier = album.tier || "Unranked";
        if (groupedByTier[tier]) groupedByTier[tier].push(album);
        else groupedByTier.Unranked.push(album);
    });

    Object.keys(groupedByTier)
        .sort((a, b) => tierOrder[a] - tierOrder[b])
        .forEach((tier) => {
            if (groupedByTier[tier].length === 0) return;

            const tierSection = document.createElement("div");
            tierSection.className = "tier-section";
            tierSection.dataset.tier = tier;

            if (canEdit()) {
                tierSection.addEventListener("dragover", handleDragOver);
                tierSection.addEventListener("dragleave", handleDragLeave);
                tierSection.addEventListener("drop", handleDrop);
            }

            const tierHeader = document.createElement("h2");
            tierHeader.className = "tier-header";
            tierHeader.dataset.tier = tier;
            tierHeader.textContent = `${tier} Tier`;

            const grid = document.createElement("div");
            grid.className = "album-grid";
            groupedByTier[tier].forEach((album) => grid.appendChild(createAlbumCard(album)));

            tierSection.append(tierHeader, grid);
            container.appendChild(tierSection);
        });
}

function viewAlbumInfo(id) {
    selectedAlbumIds.clear();
    activeAlbumViewId = id;
    const viewToggle = document.querySelector(".view-toggle");
    if (viewToggle) viewToggle.style.display = "none";
    refreshMainView();
}

function makeTableResizable(tableElement) {
    const ths = tableElement.querySelectorAll("thead th");
    ths.forEach((th) => {
        if (th.classList.contains("selection-column")) return;
        th.style.width = `${th.offsetWidth}px`;
    });

    ths.forEach((th) => {
        if (th.classList.contains("selection-column")) return;
        if (!th.querySelector(".table-resizer")) {
            const resizer = document.createElement("div");
            resizer.className = "table-resizer";
            th.appendChild(resizer);
        }

        const resizer = th.querySelector(".table-resizer");
        let startX = 0;
        let startWidth = 0;
        let hasDragged = false;

        const onMouseMove = (e) => {
            const deltaX = e.clientX - startX;
            if (Math.abs(deltaX) > 2) {
                hasDragged = true;
                isColumnResizing = true;
            }
            th.style.width = `${Math.max(50, startWidth + deltaX)}px`;
        };

        const onMouseUp = () => {
            resizer.classList.remove("resizing");
            document.removeEventListener("mousemove", onMouseMove);
            document.removeEventListener("mouseup", onMouseUp);
            if (hasDragged) {
                setTimeout(() => {
                    isColumnResizing = false;
                }, 120);
            } else {
                isColumnResizing = false;
            }
        };

        resizer.addEventListener("mousedown", (e) => {
            e.stopPropagation();
            e.preventDefault();
            hasDragged = false;
            isColumnResizing = true;
            startX = e.clientX;
            startWidth = th.offsetWidth;
            resizer.classList.add("resizing");
            document.addEventListener("mousemove", onMouseMove);
            document.addEventListener("mouseup", onMouseUp);
        });
    });
}

function renderTableView(albumsToRender, container) {
    let displayAlbums = [...albumsToRender];
    if (tableSortCol) {
        displayAlbums.sort((a, b) => {
            let valA;
            let valB;
            if (tableSortCol === "title") {
                valA = a.album_name || "";
                valB = b.album_name || "";
            } else if (tableSortCol === "artist") {
                valA = a.artist || "";
                valB = b.artist || "";
            } else if (tableSortCol === "tier") {
                const tierWeights = { S: 5, A: 4, B: 3, C: 2, D: 1, Unranked: 0 };
                valA = tierWeights[a.tier] || 0;
                valB = tierWeights[b.tier] || 0;
            } else if (tableSortCol === "rating") {
                valA = a.rating || 0;
                valB = b.rating || 0;
            } else {
                valA = a.release_date || "";
                valB = b.release_date || "";
            }
            if (valA < valB) return tableSortAsc ? -1 : 1;
            if (valA > valB) return tableSortAsc ? 1 : -1;
            return 0;
        });
    }

    const table = document.createElement("table");
    table.className = "album-table";
    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    if (canEdit()) {
        const selectHeader = document.createElement("th");
        selectHeader.className = "selection-column";
        selectHeader.textContent = "Select";
        selectHeader.scope = "col";
        headerRow.appendChild(selectHeader);
    }
    const columns = [
        { col: "title", label: "Title", width: "320px" },
        { col: "artist", label: "Artist", width: "220px" },
        { col: "tier", label: "Tier", width: "100px" },
        { col: "rating", label: "Rating", width: "120px" },
        { col: "year", label: "Year", width: "100px" }
    ];

    columns.forEach(({ col, label, width }) => {
        const th = document.createElement("th");
        th.dataset.col = col;
        th.style.width = width;
        let text = label;
        if (tableSortCol === col) text += tableSortAsc ? " ▲" : " ▼";
        th.textContent = text;
        th.addEventListener("click", (e) => {
            if (isColumnResizing || e.target.classList.contains("table-resizer")) return;
            if (tableSortCol === col) tableSortAsc = !tableSortAsc;
            else {
                tableSortCol = col;
                tableSortAsc = true;
            }
            container.replaceChildren();
            renderTableView(albumsToRender, container);
        });
        headerRow.appendChild(th);
    });

    thead.appendChild(headerRow);
    const tbody = document.createElement("tbody");

    displayAlbums.forEach((album) => {
        const tr = document.createElement("tr");
        tr.addEventListener("click", () => viewAlbumInfo(album.id));

        if (canEdit()) {
            const selectCell = document.createElement("td");
            selectCell.className = "selection-column";
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.checked = selectedAlbumIds.has(String(album.id));
            checkbox.setAttribute("aria-label", `Select ${album.album_name || "album"}`);
            checkbox.addEventListener("click", (event) => event.stopPropagation());
            checkbox.addEventListener("change", () => {
                if (checkbox.checked) selectedAlbumIds.add(String(album.id));
                else selectedAlbumIds.delete(String(album.id));
                refreshMainView();
            });
            selectCell.appendChild(checkbox);
            tr.appendChild(selectCell);
        }

        const titleTd = document.createElement("td");
        const cover = document.createElement("img");
        cover.src = album.thumbnail_url || "";
        cover.alt = "";
        cover.className = "table-cover";
        cover.loading = "lazy";
        const openAlbumButton = document.createElement("button");
        openAlbumButton.type = "button";
        openAlbumButton.className = "table-album-link";
        openAlbumButton.textContent = album.album_name || "Untitled album";
        openAlbumButton.setAttribute("aria-label", `Open ${album.album_name || "album"} by ${album.artist || "unknown artist"}`);
        openAlbumButton.addEventListener("click", (event) => {
            event.stopPropagation();
            viewAlbumInfo(album.id);
        });
        titleTd.append(cover, openAlbumButton);

        const artistTd = document.createElement("td");
        artistTd.textContent = album.artist || "";

        const tierTd = document.createElement("td");
        tierTd.textContent = album.tier || "Unranked";

        const ratingTd = document.createElement("td");
        ratingTd.textContent = album.rating > 0 ? `★ ${album.rating.toFixed(1)}` : "-";

        const yearTd = document.createElement("td");
        yearTd.textContent = album.release_date ? album.release_date.split("-")[0] : "-";

        tr.append(titleTd, artistTd, tierTd, ratingTd, yearTd);
        tbody.appendChild(tr);
    });

    table.append(thead, tbody);
    const tableScroll = document.createElement("div");
    tableScroll.className = "table-scroll";
    tableScroll.appendChild(table);
    if (canEdit()) renderBulkActions(displayAlbums, container);
    container.appendChild(tableScroll);
    makeTableResizable(table);
}

function renderBulkActions(visibleAlbums, container) {
    const visibleIds = new Set(visibleAlbums.map((album) => String(album.id)));
    Array.from(selectedAlbumIds).forEach((id) => {
        if (!visibleIds.has(id)) selectedAlbumIds.delete(id);
    });
    const toolbar = document.createElement("section");
    toolbar.className = "bulk-actions";
    toolbar.setAttribute("aria-label", "Bulk album editing");
    const selectedCount = document.createElement("strong");
    selectedCount.textContent = `${selectedAlbumIds.size} selected`;
    toolbar.appendChild(selectedCount);

    const selectVisible = document.createElement("button");
    selectVisible.type = "button";
    selectVisible.textContent = visibleAlbums.length > 0 &&
        visibleAlbums.every((album) => selectedAlbumIds.has(String(album.id)))
        ? "Deselect visible" : "Select visible";
    selectVisible.addEventListener("click", () => {
        const allSelected = visibleAlbums.every((album) => selectedAlbumIds.has(String(album.id)));
        visibleAlbums.forEach((album) => {
            if (allSelected) selectedAlbumIds.delete(String(album.id));
            else selectedAlbumIds.add(String(album.id));
        });
        refreshMainView();
    });
    toolbar.appendChild(selectVisible);

    const tierSelect = document.createElement("select");
    tierSelect.setAttribute("aria-label", "Set selected albums to tier");
    tierSelect.add(new Option("Set tier…", ""));
    TIER_FILTERS.forEach((tier) => tierSelect.add(new Option(tier === "Unranked" ? tier : `${tier} Tier`, tier)));
    const applyTier = document.createElement("button");
    applyTier.type = "button";
    applyTier.textContent = "Apply tier";
    applyTier.disabled = selectedAlbumIds.size === 0;
    applyTier.addEventListener("click", () => {
        const tier = tierSelect.value;
        if (!tier || !selectedAlbumIds.size) return;
        allAlbums.filter((album) => selectedAlbumIds.has(String(album.id))).forEach((album) => {
            album.tier = tier;
            saveToServer(album);
        });
        selectedAlbumIds.clear();
        updateSidebar();
        refreshMainView();
    });
    toolbar.append(tierSelect, applyTier);

    const listInput = document.createElement("input");
    listInput.type = "text";
    listInput.placeholder = "One list / tag name";
    listInput.setAttribute("aria-label", "List name for selected albums");
    const listAction = document.createElement("select");
    listAction.setAttribute("aria-label", "Add or remove list from selected albums");
    listAction.add(new Option("Add list", "add"));
    listAction.add(new Option("Remove list", "remove"));
    const applyList = document.createElement("button");
    applyList.type = "button";
    applyList.textContent = "Apply list";
    applyList.disabled = selectedAlbumIds.size === 0;
    applyList.addEventListener("click", () => {
        const listName = listInput.value.trim();
        if (!listName || listName.includes(",") || !selectedAlbumIds.size) {
            listInput.setCustomValidity(listName.includes(",")
                ? "Enter one list name without commas."
                : "Enter a list name.");
            listInput.reportValidity();
            listInput.focus();
            return;
        }
        allAlbums.filter((album) => selectedAlbumIds.has(String(album.id))).forEach((album) => {
            const lists = new Set((album.lists || []).map((name) => String(name).trim()).filter(Boolean));
            if (listAction.value === "add") lists.add(listName);
            else lists.delete(listName);
            album.lists = Array.from(lists);
            saveToServer(album);
        });
        listInput.addEventListener("input", () => listInput.setCustomValidity(""));
        selectedAlbumIds.clear();
        updateSidebar();
        refreshMainView();
    });
    toolbar.append(listInput, listAction, applyList);
    const clearSelection = document.createElement("button");
    clearSelection.type = "button";
    clearSelection.textContent = "Clear selection";
    clearSelection.disabled = selectedAlbumIds.size === 0;
    clearSelection.addEventListener("click", () => {
        selectedAlbumIds.clear();
        refreshMainView();
    });
    toolbar.appendChild(clearSelection);
    container.appendChild(toolbar);
}

function renderAlbumDetailView(id) {
    const album = allAlbums.find((a) => a.id === id);
    if (!album) return;

    document.getElementById("current-view-title").textContent = "";
    const container = document.getElementById("main-container");
    container.replaceChildren();

    const releaseYear = album.release_date ? album.release_date.split("-")[0] : "Unknown";
    const duration = formatDuration(album.duration_ms);
    const albumLists = album.lists || [];
    const listsText = albumLists.length > 0 ? albumLists.join(", ") : "None";
    const tracks = album.tracks || [];
    const history = listeningStats[album.id];
    const lastPlayed = history && history.lastPlayedAt
        ? new Date(history.lastPlayedAt).toLocaleDateString(undefined, { dateStyle: "medium" })
        : "No date available";

    const blur = document.createElement("div");
    blur.className = "detail-bg-blur";
    if (album.thumbnail_url) {
        blur.style.backgroundImage = `url("${cssUrl(album.thumbnail_url)}")`;
    }

    const backBtn = document.createElement("button");
    backBtn.className = "btn-back";
    backBtn.type = "button";
    backBtn.textContent = `← Back to ${currentFilter}`;
    backBtn.addEventListener("click", () => handleNav(currentFilter));

    const detail = document.createElement("div");
    detail.className = "album-detail-view";

    const cover = document.createElement("img");
    cover.src = album.thumbnail_url || "";
    cover.alt = `${album.album_name || "Album"} cover`;
    cover.className = "detail-cover";

    const info = document.createElement("div");
    info.className = "detail-info";

    const typeLabel = document.createElement("div");
    typeLabel.style.marginBottom = "4px";
    const typeSpan = document.createElement("span");
    typeSpan.style.textTransform = "uppercase";
    typeSpan.style.fontSize = "11px";
    typeSpan.style.fontWeight = "700";
    typeSpan.style.color = "#b3b3b3";
    typeSpan.style.letterSpacing = "1px";
    typeSpan.textContent = "Album";
    typeLabel.appendChild(typeSpan);

    const title = document.createElement("div");
    title.className = "detail-title";
    title.textContent = album.album_name || "";

    const artist = document.createElement("div");
    artist.className = "detail-artist";
    artist.textContent = album.artist || "";

    const starBox = document.createElement("div");
    starBox.className = "detail-interactive-stars";
    starBox.id = "detail-star-container";

    const meta = document.createElement("div");
    meta.className = "detail-metadata-stack";
    const metadataRows = [
        ["Released:", releaseYear],
        ["Tracks:", String(album.total_tracks || tracks.length || "?")],
        ["Length:", duration],
        ["List:", listsText]
    ];
    if (history && history.plays > 0) {
        metadataRows.push([
            "Listening:",
            `${history.plays.toLocaleString()} matched plays · ${formatDuration(history.msPlayed)} listened · Last played ${lastPlayed}`
        ]);
    }
    metadataRows.forEach(([label, value]) => {
        const row = document.createElement("div");
        row.append(document.createTextNode(label + " "));
        const span = document.createElement("span");
        span.textContent = value;
        row.appendChild(span);
        meta.appendChild(row);
    });

    info.append(typeLabel, title, artist, starBox, meta);

    if (album.spotify_url) {
        const playLink = document.createElement("a");
        playLink.href = album.spotify_url;
        playLink.target = "_blank";
        playLink.rel = "noopener noreferrer";
        playLink.className = "btn-spotify";
        playLink.textContent = "PLAY ON SPOTIFY";
        info.appendChild(playLink);
    }

    detail.append(cover, info);

    const trackSection = document.createElement("div");
    trackSection.className = "track-list-section";
    const heading = document.createElement("h3");
    heading.textContent = "Tracks";
    const table = document.createElement("table");
    table.className = "track-table-custom";
    table.id = "track-table";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    [
        { text: "#", width: "50px" },
        { text: "Title", width: "320px" },
        { text: "Time", width: "90px" },
        { text: "Rating", width: "280px", extra: "th-rating" }
    ].forEach(({ text, width, extra }) => {
        const th = document.createElement("th");
        th.style.width = width;
        th.textContent = text;
        if (extra) th.className = extra;
        headRow.appendChild(th);
    });
    thead.appendChild(headRow);

    const tbody = document.createElement("tbody");
    tbody.id = "track-container";
    table.append(thead, tbody);
    trackSection.append(heading, table);
    container.append(blur, backBtn, detail, trackSection);

    setupInteractiveStars("detail-star-container", album.rating, (newRating) => {
        album.rating = newRating;
        saveToServer(album);
    });

    if (!tracks.length) {
        const emptyRow = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 4;
        td.style.color = "#8c8c8c";
        td.style.padding = "16px 0";
        td.textContent = "No tracks recorded for this album yet.";
        emptyRow.appendChild(td);
        tbody.appendChild(emptyRow);
        return;
    }

    tracks.forEach((track, index) => {
        const trackRow = document.createElement("tr");
        trackRow.className = "track-row";

        const trackNum = track.track_number || index + 1;
        const rawTrackName = track.name || `Track ${trackNum}`;
        const initialRating = track.rating || 0;
        const trackStarsId = `track-star-box-${index}`;
        const trackBadgeId = `track-score-${index}`;

        const numTd = document.createElement("td");
        numTd.className = "track-num";
        numTd.textContent = trackNum;

        const titleTd = document.createElement("td");
        titleTd.className = "track-title";
        titleTd.title = rawTrackName;
        titleTd.textContent = rawTrackName;

        const timeTd = document.createElement("td");
        timeTd.className = "track-duration";
        timeTd.textContent = formatTrackTime(track.duration_ms);

        const ratingTd = document.createElement("td");
        const wrap = document.createElement("div");
        wrap.className = "track-rating-wrap";
        const stars = document.createElement("div");
        stars.className = "track-stars-container";
        stars.id = trackStarsId;
        const badge = document.createElement("span");
        badge.className = "track-score-badge";
        badge.id = trackBadgeId;
        badge.textContent = initialRating > 0 ? initialRating : "-";
        wrap.append(stars, badge);
        ratingTd.appendChild(wrap);

        trackRow.append(numTd, titleTd, timeTd, ratingTd);
        tbody.appendChild(trackRow);

        setupInteractiveStars(trackStarsId, initialRating, (newTrackRating) => {
            track.rating = newTrackRating;
            badge.textContent = newTrackRating > 0 ? newTrackRating : "-";
            saveToServer(album);
        });
    });

    makeTableResizable(table);
}

function handleDragStart(e) {
    const card = e.target.closest(".album-card");
    if (!card) return;
    draggedAlbumId = card.dataset.id;
    card.classList.add("dragging");
    e.dataTransfer.setData("text/plain", card.dataset.id);
    e.dataTransfer.effectAllowed = "move";
}

function handleDragEnd(e) {
    e.currentTarget.classList.remove("dragging");
    document.querySelectorAll(".tier-section").forEach((ts) => ts.classList.remove("drag-over"));
    document.querySelectorAll(".sidebar-tier").forEach((st) => st.classList.remove("drag-over-sidebar"));
}

function handleDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    e.currentTarget.classList.add("drag-over");
}

function handleDragLeave(e) {
    if (!e.currentTarget.contains(e.relatedTarget)) {
        e.currentTarget.classList.remove("drag-over");
    }
}

function handleDrop(e) {
    e.preventDefault();
    e.currentTarget.classList.remove("drag-over");
    const droppedId = draggedAlbumId || e.dataTransfer.getData("text/plain");
    const targetTier = e.currentTarget.dataset.tier;
    if (droppedId && targetTier) updateAlbumTier(droppedId, targetTier);
    draggedAlbumId = null;
}

function handleSidebarDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    e.currentTarget.classList.add("drag-over-sidebar");
}

function handleSidebarDragLeave(e) {
    if (!e.currentTarget.contains(e.relatedTarget)) {
        e.currentTarget.classList.remove("drag-over-sidebar");
    }
}

function handleSidebarDrop(e) {
    e.preventDefault();
    e.currentTarget.classList.remove("drag-over-sidebar");
    const droppedId = draggedAlbumId || e.dataTransfer.getData("text/plain");
    const targetTier = e.currentTarget.dataset.tier;
    if (droppedId && targetTier) updateAlbumTier(droppedId, targetTier);
    draggedAlbumId = null;
}

function showUndoToast(album, previousTier) {
    const toast = document.getElementById("undo-toast");
    const message = document.getElementById("undo-toast-message");
    if (!toast || !message) return;

    undoPayload = { album, previousTier };
    const dest = album.tier === "Unranked" ? "Unranked" : `${album.tier} Tier`;
    message.textContent = `Moved ${album.album_name} to ${dest}.`;
    toast.hidden = false;

    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => {
        toast.hidden = true;
        undoPayload = null;
    }, 5000);
}

function undoTierChange() {
    if (!undoPayload) return;
    const { album, previousTier } = undoPayload;
    album.tier = previousTier;
    undoPayload = null;
    document.getElementById("undo-toast").hidden = true;
    updateSidebar();
    refreshMainView();
    saveToServer(album);
}

function updateAlbumTier(albumId, targetTier) {
    const album = allAlbums.find((a) => String(a.id) === String(albumId));
    if (!album || album.tier === targetTier || !canEdit()) return;
    const previousTier = album.tier || "Unranked";
    album.tier = targetTier;
    updateSidebar();
    refreshMainView();
    saveToServer(album);
    showUndoToast(album, previousTier);
}

function openModal(album) {
    if (!canEdit()) return;
    currentEditingId = album.id;
    document.getElementById("modal-title").textContent = album.album_name || "";
    document.getElementById("modal-artist").textContent = album.artist || "";
    document.getElementById("modal-tier").value = album.tier || "Unranked";
    document.getElementById("modal-lists").value = (album.lists || []).join(", ");
    document.getElementById("rating-display-value").textContent = album.rating || 0;
    setupInteractiveStars("modal-star-container", album.rating, null, "rating-display-value");
    openOverlay(document.getElementById("edit-modal"), "#modal-tier");
}

function closeModal() {
    closeOverlay(document.getElementById("edit-modal"));
    currentEditingId = null;
}

function submitModal() {
    if (!currentEditingId || !canEdit()) return;
    const album = allAlbums.find((a) => a.id === currentEditingId);
    if (!album) return;

    album.tier = document.getElementById("modal-tier").value;
    album.lists = document.getElementById("modal-lists").value
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "");
    album.rating = parseFloat(document.getElementById("rating-display-value").textContent) || 0;
    saveToServer(album, { immediate: true });
    closeModal();
    updateSidebar();
    refreshMainView();
}

function saveToServer(album) {
    if (!canEdit() || !album || !album.id) return;
    const id = String(album.id);
    const firestoreAlbum = firestoreAlbumsById.get(id);
    if (!firestoreAlbum) {
        localOverrides[id] = { ...album };
    } else {
        const override = { id };
        const fields = ["tier", "rating", "lists"];
        fields.forEach((field) => {
            const currentValue = album[field] ?? (field === "tier" ? "Unranked" : field === "lists" ? [] : 0);
            const serverValue = firestoreAlbum[field] ??
                (field === "tier" ? "Unranked" : field === "lists" ? [] : 0);
            if (JSON.stringify(currentValue) !== JSON.stringify(serverValue)) {
                override[field] = Array.isArray(currentValue) ? [...currentValue] : currentValue;
            }
        });

        const serverTrackRatings = new Map();
        (firestoreAlbum.tracks || []).forEach((track, index) => {
            serverTrackRatings.set(trackKey(track, index), Number(track.rating) || 0);
        });
        const localTrackRatings = {};
        (album.tracks || []).forEach((track, index) => {
            const key = trackKey(track, index);
            const rating = Number(track.rating) || 0;
            if (rating !== (serverTrackRatings.get(key) || 0)) localTrackRatings[key] = rating;
        });
        if (Object.keys(localTrackRatings).length) override.trackRatings = localTrackRatings;

        if (Object.keys(override).length === 1) delete localOverrides[id];
        else localOverrides[id] = override;
    }
    try {
        localStorage.setItem(LOCAL_OVERRIDES_KEY, JSON.stringify(localOverrides));
        updatePendingEdits();
    } catch (err) {
        console.error("Could not save local album changes:", err);
        document.getElementById("save-status").textContent = "Could not save locally. Export a backup to keep these changes.";
        document.getElementById("save-status").classList.add("error");
    }
}

function trackKey(track, index) {
    const disc = Number(track && track.disc_number) || 1;
    const number = Number(track && track.track_number) || index + 1;
    return `${disc}:${number}`;
}

function mergeLocalAlbumOverride(album, override) {
    const merged = {
        ...album,
        tracks: Array.isArray(album.tracks) ? album.tracks.map((track) => ({ ...track })) : []
    };
    if (!override || typeof override !== "object") return merged;
    ["tier", "rating", "lists"].forEach((field) => {
        if (Object.prototype.hasOwnProperty.call(override, field)) {
            merged[field] = Array.isArray(override[field]) ? [...override[field]] : override[field];
        }
    });

    const trackRatings = new Map();
    if (Array.isArray(override.tracks)) {
        override.tracks.forEach((track, index) => {
            if (!track || !Object.prototype.hasOwnProperty.call(track, "rating")) return;
            const numericRating = Number(track.rating);
            if (Number.isFinite(numericRating) && numericRating >= 0 && numericRating <= 10) {
                trackRatings.set(trackKey(track, index), numericRating);
            }
        });
    }
    if (override.trackRatings && typeof override.trackRatings === "object" &&
        !Array.isArray(override.trackRatings)) {
        Object.entries(override.trackRatings).forEach(([key, rating]) => {
            const numericRating = Number(rating);
            if (Number.isFinite(numericRating) && numericRating >= 0 && numericRating <= 10) {
                trackRatings.set(key, numericRating);
            }
        });
    }
    if (trackRatings.size && Array.isArray(album.tracks)) {
        merged.tracks = album.tracks.map((track, index) => {
            const key = trackKey(track, index);
            return trackRatings.has(key) ? { ...track, rating: trackRatings.get(key) } : track;
        });
    }
    return merged;
}

function setToolStatus(message, isError = false) {
    const status = document.getElementById("data-tool-status");
    status.textContent = message;
    status.classList.toggle("error", isError);
}

function downloadTextFile(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvValue(value) {
    let text = String(value ?? "");
    if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
}

function exportBackup() {
    const backup = {
        schemaVersion: 2,
        exportedAt: new Date().toISOString(),
        albums: allAlbums,
        listeningStats
    };
    const filename = `music-vault-backup-${new Date().toISOString().slice(0, 10)}.json`;
    downloadTextFile(
        filename,
        JSON.stringify(backup, null, 2),
        "application/json"
    );
    try {
        localStorage.setItem(LAST_BACKUP_KEY, backup.exportedAt);
        updatePendingEdits();
    } catch (err) {
        console.error("Backup downloaded, but its timestamp could not be saved:", err);
        setToolStatus("Backup downloaded, but this browser could not save its backup timestamp.", true);
    }
    if (IS_LOCAL_EDIT_MODE) {
        const command = `python sync_vault.py --input "${filename}" --rankings-only`;
        document.getElementById("publish-command").textContent = command;
        document.getElementById("publish-command-wrap").hidden = false;
        setToolStatus(`Exported ${allAlbums.length} albums. Review the command below to publish your backup.`);
    } else {
        document.getElementById("publish-command-wrap").hidden = true;
        setToolStatus(`Exported ${allAlbums.length} albums as a JSON backup.`);
    }
}

async function copyPublishCommand() {
    const command = document.getElementById("publish-command").textContent;
    if (!command) return;
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(command);
        } else {
            const temporary = document.createElement("textarea");
            temporary.value = command;
            temporary.setAttribute("readonly", "");
            temporary.style.position = "fixed";
            temporary.style.opacity = "0";
            document.body.appendChild(temporary);
            temporary.select();
            const copied = document.execCommand("copy");
            temporary.remove();
            if (!copied) throw new Error("Clipboard access is unavailable in this browser.");
        }
        setToolStatus("Publish command copied to clipboard.");
    } catch (err) {
        console.error("Could not copy publish command:", err);
        setToolStatus(`Could not copy command: ${err.message || "Clipboard access was denied."}`, true);
    }
}

function exportCsv() {
    const rows = [
        ["Album", "Artist", "Tier", "Rating", "Release date", "Duration (minutes)", "Lists"],
        ...allAlbums.map((album) => [
            album.album_name || "",
            album.artist || "",
            album.tier || "Unranked",
            album.rating || 0,
            album.release_date || "",
            album.duration_ms ? (Number(album.duration_ms) / 60000).toFixed(1) : "",
            (album.lists || []).join(", ")
        ])
    ];
    const csv = rows.map((row) => row.map(csvValue).join(",")).join("\r\n");
    downloadTextFile(
        `music-vault-${new Date().toISOString().slice(0, 10)}.csv`,
        `\uFEFF${csv}`,
        "text/csv;charset=utf-8"
    );
    setToolStatus(`Exported ${allAlbums.length} albums as CSV.`);
}

function validateBackup(data) {
    const albums = Array.isArray(data) ? data : data && data.albums;
    if (!Array.isArray(albums) || albums.some((album) => !album || typeof album !== "object" || Array.isArray(album))) {
        throw new Error("Backup must contain an albums array of objects.");
    }

    const ids = new Set();
    albums.forEach((album, index) => {
        const id = String(album.id || "").trim();
        if (!id) throw new Error(`Album at position ${index + 1} is missing an id.`);
        if (ids.has(id)) throw new Error(`Backup contains duplicate album id ${id}.`);
        ids.add(id);
    });
    const listeningStats = data && data.listeningStats;
    if (listeningStats !== undefined &&
        (!listeningStats || typeof listeningStats !== "object" || Array.isArray(listeningStats))) {
        throw new Error("Backup listeningStats must be an object keyed by album ID.");
    }
    const validatedStats = {};
    Object.entries(listeningStats || {}).forEach(([id, stats]) => {
        if (!id || !stats || typeof stats !== "object" || Array.isArray(stats)) {
            throw new Error("Backup contains an invalid listening summary.");
        }
        const plays = Number(stats.plays);
        const msPlayed = Number(stats.msPlayed);
        if (!Number.isFinite(plays) || plays < 0 || !Number.isInteger(plays) ||
            !Number.isFinite(msPlayed) || msPlayed < 0) {
            throw new Error(`Backup listening summary for ${id} has invalid play totals.`);
        }
        const lastPlayedTime = stats.lastPlayedAt ? Date.parse(stats.lastPlayedAt) : NaN;
        if (stats.lastPlayedAt && !Number.isFinite(lastPlayedTime)) {
            throw new Error(`Backup listening summary for ${id} has an invalid last-played date.`);
        }
        validatedStats[id] = {
            plays,
            msPlayed,
            lastPlayedAt: Number.isFinite(lastPlayedTime) ? new Date(lastPlayedTime).toISOString() : ""
        };
    });
    return { albums, listeningStats: validatedStats, hasListeningStats: listeningStats !== undefined };
}

function clearLocalEdits() {
    if (!canEdit() || !Object.keys(localOverrides).length) return;
    if (!window.confirm("Discard all local-only catalog edits and reload the Firestore catalog?")) return;
    try {
        localStorage.removeItem(LOCAL_OVERRIDES_KEY);
        localOverrides = {};
        updatePendingEdits();
        setToolStatus("Local edits discarded. Reloading the Firestore catalog...");
        loadAlbums();
    } catch (err) {
        console.error("Could not discard local edits:", err);
        setToolStatus(`Could not clear local edits: ${err.message || "Browser storage error"}.`, true);
    }
}

async function restoreBackup(file) {
    if (!canEdit()) {
        setToolStatus("Catalog restore is available only in local editing mode.", true);
        return;
    }

    let albums;
    try {
        var validatedBackup = validateBackup(JSON.parse(await file.text()));
        albums = validatedBackup.albums;
    } catch (err) {
        setToolStatus(`Could not read backup: ${err.message}`, true);
        return;
    }

    const existingIds = new Set(allAlbums.map((album) => String(album.id)));
    const newCount = albums.filter((album) => !existingIds.has(String(album.id))).length;
    const updateCount = albums.length - newCount;
    const historyCount = Object.values(validatedBackup.listeningStats)
        .reduce((total, stats) => total + stats.plays, 0);
    const approved = window.confirm(
        `Load ${albums.length} albums into this browser? This will add ${newCount} and replace ${updateCount} matching local records` +
        `${validatedBackup.hasListeningStats ? `, and replace listening history with ${historyCount.toLocaleString()} plays` : ""}. ` +
        "It will not write to Firestore."
    );
    if (!approved) {
        setToolStatus("Local backup load cancelled.");
        return;
    }

    try {
        const nextAlbumsById = new Map(allAlbums.map((album) => [String(album.id), album]));
        const nextOverrides = { ...localOverrides };
        albums.forEach((album) => {
            const id = String(album.id).trim();
            const normalized = { ...album, id };
            nextAlbumsById.set(id, normalized);
            nextOverrides[id] = normalized;
        });
        const previousOverrides = localStorage.getItem(LOCAL_OVERRIDES_KEY);
        const previousHistory = localStorage.getItem(HISTORY_KEY);
        localStorage.setItem(LOCAL_OVERRIDES_KEY, JSON.stringify(nextOverrides));
        if (validatedBackup.hasListeningStats) {
            try {
                localStorage.setItem(HISTORY_KEY, JSON.stringify(validatedBackup.listeningStats));
            } catch (err) {
                if (previousOverrides === null) localStorage.removeItem(LOCAL_OVERRIDES_KEY);
                else localStorage.setItem(LOCAL_OVERRIDES_KEY, previousOverrides);
                if (previousHistory === null) localStorage.removeItem(HISTORY_KEY);
                else localStorage.setItem(HISTORY_KEY, previousHistory);
                throw err;
            }
        }
        localOverrides = nextOverrides;
        allAlbums = Array.from(nextAlbumsById.values());
        if (validatedBackup.hasListeningStats) listeningStats = validatedBackup.listeningStats;

        updatePendingEdits();
        updateSidebar();
        refreshMainView();
        setToolStatus(`Loaded ${albums.length} albums locally (${newCount} added, ${updateCount} replaced). Export a backup to push them to Firestore.`);
    } catch (err) {
        console.error("Local backup load failed:", err);
        setToolStatus(`Could not save the loaded backup in this browser: ${err.message || "Browser storage error"}.`, true);
    }
}

function normalizeHistoryName(value) {
    return String(value || "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
}

function importListeningHistory(files) {
    if (!canEdit() || !files.length) return;

    const albumsByTrack = new Map();
    allAlbums.forEach((album) => {
        const artist = normalizeHistoryName(album.artist);
        (album.tracks || []).forEach((track) => {
            const trackName = normalizeHistoryName(track && track.name);
            if (!artist || !trackName) return;
            const key = `${artist}|${trackName}`;
            if (!albumsByTrack.has(key)) albumsByTrack.set(key, new Set());
            albumsByTrack.get(key).add(String(album.id));
        });
    });

    Promise.all(Array.from(files, async (file) => {
        const data = JSON.parse(await file.text());
        const entries = Array.isArray(data)
            ? data
            : data && (data.items || data.streamingHistory || data.tracks);
        if (!Array.isArray(entries)) {
            throw new Error(`${file.name} must contain a Spotify listening-history array.`);
        }
        return entries;
    }))
        .then((historyFiles) => {
            const stats = {};
            let matched = 0;
            let unmatched = 0;
            let ambiguous = 0;
            historyFiles.flat().forEach((entry) => {
                if (!entry || typeof entry !== "object") {
                    unmatched += 1;
                    return;
                }
                const artist = normalizeHistoryName(entry.artistName || entry.artist);
                const track = normalizeHistoryName(entry.trackName || entry.track);
                const duration = Number(entry.msPlayed ?? entry.ms_played) || 0;
                if (!artist || !track || duration <= 0) return;

                const candidates = albumsByTrack.get(`${artist}|${track}`);
                if (!candidates || candidates.size === 0) {
                    unmatched += 1;
                    return;
                }
                if (candidates.size > 1) {
                    ambiguous += 1;
                    return;
                }

                const id = candidates.values().next().value;
                if (!stats[id]) stats[id] = { plays: 0, msPlayed: 0, lastPlayedAt: "" };
                stats[id].plays += 1;
                stats[id].msPlayed += duration;
                const endTime = String(entry.endTime || "");
                const normalizedEndTime = endTime.includes("T") ? endTime : endTime.replace(" ", "T");
                const time = Date.parse(/[zZ]|[+-]\d{2}:\d{2}$/.test(normalizedEndTime)
                    ? normalizedEndTime
                    : `${normalizedEndTime}Z`);
                if (Number.isFinite(time) &&
                    (!stats[id].lastPlayedAt || time > Date.parse(stats[id].lastPlayedAt))) {
                    stats[id].lastPlayedAt = new Date(time).toISOString();
                }
                matched += 1;
            });

            listeningStats = stats;
            try {
                localStorage.setItem(HISTORY_KEY, JSON.stringify(listeningStats));
            } catch (err) {
                console.error("Could not save listening summaries locally:", err);
                refreshMainView();
                setToolStatus("History was imported for this session, but browser storage could not save the summaries.", true);
                return;
            }
            refreshMainView();
            setToolStatus(
                `Replaced saved listening summaries with ${matched.toLocaleString()} matched plays across ${Object.keys(stats).length} albums. ` +
                `${unmatched.toLocaleString()} unmatched and ${ambiguous.toLocaleString()} ambiguous plays were skipped.`
            );
        })
        .catch((err) => {
            console.error("Listening history import failed:", err);
            setToolStatus(`Could not import listening history: ${err.message || "Invalid file"}`, true);
        });
}

function bindUi() {
    loadPrefs();
    if (!IS_READONLY_PREVIEW) {
        try {
            const savedOverrides = JSON.parse(localStorage.getItem(LOCAL_OVERRIDES_KEY) || "{}");
            localOverrides = savedOverrides && typeof savedOverrides === "object" && !Array.isArray(savedOverrides)
                ? Object.fromEntries(Object.entries(savedOverrides).filter(([id, album]) =>
                    id && album && typeof album === "object" && !Array.isArray(album)))
                : {};
        } catch (err) {
            console.warn("Could not load local album changes.", err);
            setToolStatus("Local album changes could not be loaded from browser storage.", true);
        }
    }
    try {
        const savedHistory = JSON.parse(localStorage.getItem(HISTORY_KEY) || "{}");
        listeningStats = savedHistory && typeof savedHistory === "object" && !Array.isArray(savedHistory)
            ? Object.fromEntries(Object.entries(savedHistory)
                .filter(([, stats]) => stats && typeof stats === "object" &&
                    Number.isFinite(Number(stats.plays)) && Number(stats.plays) >= 0 &&
                    Number.isFinite(Number(stats.msPlayed)) && Number(stats.msPlayed) >= 0)
                .map(([id, stats]) => {
                    const lastPlayedTime = Date.parse(stats.lastPlayedAt || "");
                    return [id, {
                        plays: Number(stats.plays),
                        msPlayed: Number(stats.msPlayed),
                        lastPlayedAt: Number.isFinite(lastPlayedTime)
                            ? new Date(lastPlayedTime).toISOString()
                            : ""
                    }];
                }))
            : {};
    } catch (err) {
        console.warn("Could not load saved listening insights.", err);
        setToolStatus("Saved listening insights could not be loaded.", true);
    }
    updateModeUI();
    updateGettingStarted();
    loadSavedFilterViews();

    const sortSelect = document.getElementById("sort-select");
    if (sortSelect) {
        sortSelect.value = currentSort;
        sortSelect.addEventListener("change", (event) => {
            currentSort = event.target.value;
            savePrefs();
            refreshMainView();
        });
    }

    updateViewButtons();

    const searchInput = document.getElementById("search-input");
    searchInput.addEventListener("input", (event) => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            insightSelection = null;
            currentSearchQuery = event.target.value.toLowerCase().trim();
            refreshMainView();
        }, 200);
    });
    document.getElementById("btn-dismiss-getting-started")
        .addEventListener("click", dismissGettingStarted);

    document.getElementById("btn-print").addEventListener("click", () => window.print());
    document.getElementById("btn-ranking-view").addEventListener("click", () => switchView("ranking"));
    document.getElementById("btn-list-view").addEventListener("click", () => switchView("list"));
    document.getElementById("btn-table-view").addEventListener("click", () => switchView("table"));
    document.getElementById("btn-insights-view").addEventListener("click", () => switchView("insights"));

    syncFilterInputs();
    updateFilterButton();
    document.getElementById("btn-apply-filter-view").addEventListener("click", applySavedFilterView);
    document.getElementById("btn-delete-filter-view").addEventListener("click", deleteSelectedFilterView);
    document.getElementById("btn-save-filter-view").addEventListener("click", saveCurrentFilterView);
    document.getElementById("saved-filter-view-select").addEventListener("change", (event) => {
        document.getElementById("btn-delete-filter-view").disabled = !event.target.value;
    });
    [
        "filter-tier",
        "filter-list",
        "filter-duration-min",
        "filter-duration-max",
        "filter-rating-min",
        "filter-rating-max",
        "filter-year-min",
        "filter-year-max",
        "filter-listening",
        "filter-track-data"
    ].forEach((id) => {
        const input = document.getElementById(id);
        input.addEventListener(input.tagName === "INPUT" ? "input" : "change", applyFiltersFromUI);
    });

    document.getElementById("btn-clear-filters").addEventListener("click", () => {
        activeFilters = {
            tier: "",
            list: "",
            durationMin: "",
            durationMax: "",
            ratingMin: "",
            ratingMax: "",
            yearMin: "",
            yearMax: "",
            listening: "",
            trackData: ""
        };
        document.getElementById("filter-error").textContent = "";
        syncFilterInputs();
        savePrefs();
        updateFilterButton();
        refreshMainView();
    });
    document.getElementById("btn-clear-local-edits").addEventListener("click", clearLocalEdits);

    const filterButton = document.getElementById("btn-filters");
    const filterPanel = document.getElementById("filter-panel");
    const dataButton = document.getElementById("btn-data-tools");
    const dataPanel = document.getElementById("data-tools-panel");
    filterButton.addEventListener("click", () => {
        dataPanel.hidden = true;
        dataButton.setAttribute("aria-expanded", "false");
        filterPanel.hidden = !filterPanel.hidden;
        filterButton.setAttribute("aria-expanded", String(!filterPanel.hidden));
        if (!filterPanel.hidden) {
            filterPanel.querySelector(".filter-grid select, .filter-grid input").focus();
        }
    });
    dataButton.addEventListener("click", () => {
        filterPanel.hidden = true;
        filterButton.setAttribute("aria-expanded", "false");
        dataPanel.hidden = !dataPanel.hidden;
        dataButton.setAttribute("aria-expanded", String(!dataPanel.hidden));
        if (!dataPanel.hidden) dataPanel.querySelector("button:not([hidden])").focus();
    });
    document.getElementById("btn-close-filters").addEventListener("click", () => {
        filterPanel.hidden = true;
        filterButton.setAttribute("aria-expanded", "false");
        filterButton.focus();
    });
    document.addEventListener("click", (event) => {
        if (!filterPanel.contains(event.target) && !filterButton.contains(event.target)) {
            filterPanel.hidden = true;
            filterButton.setAttribute("aria-expanded", "false");
        }
        if (!dataPanel.contains(event.target) && !dataButton.contains(event.target)) {
            dataPanel.hidden = true;
            dataButton.setAttribute("aria-expanded", "false");
        }
    });

    document.getElementById("btn-export-json").addEventListener("click", exportBackup);
    document.getElementById("btn-copy-publish-command").addEventListener("click", copyPublishCommand);
    document.getElementById("btn-export-csv").addEventListener("click", exportCsv);
    document.getElementById("btn-import-backup").addEventListener("click", () => {
        document.getElementById("backup-file-input").click();
    });
    document.getElementById("backup-file-input").addEventListener("change", (event) => {
        const [file] = event.target.files;
        if (file) restoreBackup(file);
        event.target.value = "";
    });
    document.getElementById("btn-import-history").addEventListener("click", () => {
        if (!canEdit()) return;
        document.getElementById("history-file-input").click();
    });
    document.getElementById("history-file-input").addEventListener("change", (event) => {
        if (!canEdit()) {
            event.target.value = "";
            return;
        }
        importListeningHistory(event.target.files);
        event.target.value = "";
    });

    document.getElementById("modal-close-btn").addEventListener("click", closeModal);
    document.getElementById("modal-cancel-btn").addEventListener("click", closeModal);
    document.getElementById("modal-save-btn").addEventListener("click", submitModal);
    document.getElementById("edit-modal").addEventListener("click", (e) => {
        if (e.target.id === "edit-modal") closeModal();
    });

    document.getElementById("undo-btn").addEventListener("click", undoTierChange);

    document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape" && event.key !== "Tab") return;
        const editModal = document.getElementById("edit-modal");
        const editOpen = editModal.style.display === "flex";
        if (event.key === "Escape") {
            if (editOpen) closeModal();
            if (sidebar.classList.contains("open")) {
                sidebar.classList.remove("open");
                sidebarBackdrop.hidden = true;
                menuBtn.setAttribute("aria-expanded", "false");
                menuBtn.focus();
            }
            if (!filterPanel.hidden) {
                filterPanel.hidden = true;
                filterButton.setAttribute("aria-expanded", "false");
                filterButton.focus();
            }
            if (!dataPanel.hidden) {
                dataPanel.hidden = true;
                dataButton.setAttribute("aria-expanded", "false");
                dataButton.focus();
            }
            return;
        }
        if (editOpen) trapFocus(event, editModal);
    });

    const menuBtn = document.getElementById("mobile-menu-btn");
    const sidebar = document.querySelector(".sidebar");
    const sidebarBackdrop = document.getElementById("sidebar-backdrop");
    if (menuBtn && sidebar) {
        menuBtn.setAttribute(
            "aria-expanded",
            String(window.innerWidth > 768 && !sidebar.classList.contains("collapsed"))
        );
        menuBtn.addEventListener("click", () => {
            if (window.innerWidth <= 768) {
                const isOpen = !sidebar.classList.contains("open");
                sidebar.classList.toggle("open", isOpen);
                sidebarBackdrop.hidden = !isOpen;
                menuBtn.setAttribute("aria-expanded", String(isOpen));
            }
            else {
                const isExpanded = sidebar.classList.toggle("collapsed") === false;
                menuBtn.setAttribute("aria-expanded", String(isExpanded));
            }
        });
        sidebarBackdrop.addEventListener("click", () => {
            sidebar.classList.remove("open");
            sidebarBackdrop.hidden = true;
            menuBtn.setAttribute("aria-expanded", "false");
            menuBtn.focus();
        });
        sidebar.addEventListener("click", (e) => {
            if (window.innerWidth <= 768 && e.target.closest("li") && !e.target.closest(".sidebar-divider")) {
                sidebar.classList.remove("open");
                sidebarBackdrop.hidden = true;
                menuBtn.setAttribute("aria-expanded", "false");
            }
        });
    }

}

function setCatalogLoadStatus(message, isError = false, visible = true) {
    const status = document.getElementById("catalog-load-status");
    status.hidden = !visible;
    status.classList.toggle("error", isError);
    catalogLoadMessage = message;
    renderCatalogLoadMessage();
}

function renderAlbumDocuments(albums) {
    firestoreAlbumsById = new Map();
    allAlbums = albums.map((data) => {
        const id = String(data.id);
        const baseAlbum = {
            ...data,
            id,
            tier: data.tier || "Unranked",
            lists: data.lists || [],
            rating: data.rating || 0.0,
            tracks: data.tracks || []
        };
        firestoreAlbumsById.set(id, baseAlbum);
        return { ...mergeLocalAlbumOverride(baseAlbum, localOverrides[id]), id };
    });
    const loadedIds = new Set(allAlbums.map((album) => String(album.id)));
    Object.entries(localOverrides).forEach(([id, album]) => {
        if (!loadedIds.has(id)) allAlbums.push({ ...album, id });
    });
    updateSidebar();
    refreshMainView();
}

function readCatalogCache() {
    const raw = localStorage.getItem(CATALOG_CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    if (!cached || !Array.isArray(cached.albums) || !Number.isFinite(cached.savedAt) ||
        cached.albums.some((album) => !album || typeof album !== "object" || !album.id)) {
        throw new Error("Saved catalog cache has an invalid shape.");
    }
    return cached;
}

function saveCatalogCache(albums) {
    const serialized = JSON.stringify({ savedAt: Date.now(), albums });
    if (serialized.length > CATALOG_CACHE_MAX_CHARS) {
        localStorage.removeItem(CATALOG_CACHE_KEY);
        return false;
    }
    localStorage.setItem(CATALOG_CACHE_KEY, serialized);
    return true;
}

async function loadAlbums(forceRefresh = false) {
    const refreshButton = document.getElementById("btn-refresh-catalog");
    refreshButton.disabled = true;
    refreshButton.textContent = "Refreshing…";
    let cachedCatalog = null;
    let hasRenderedCatalog = false;

    try {
        await FIRESTORE_PERSISTENCE_READY;
        try {
            cachedCatalog = readCatalogCache();
        } catch (err) {
            console.error("Saved catalog cache could not be read:", err);
            setCatalogLoadStatus("Saved catalog cache could not be read. Refreshing from Firestore.", true);
        }

        if (cachedCatalog && !forceRefresh) {
            renderAlbumDocuments(cachedCatalog.albums);
            hasRenderedCatalog = true;
            const age = Date.now() - cachedCatalog.savedAt;
            if (age < CATALOG_CACHE_TTL_MS) {
                const updated = new Date(cachedCatalog.savedAt).toLocaleTimeString([], {
                    hour: "numeric",
                    minute: "2-digit"
                });
                setCatalogLoadStatus(`Cached catalog from ${updated}. It may have changed since then; refresh to check for updates.`, false);
                return;
            }
            setCatalogLoadStatus("Showing the saved catalog while checking for updates.", false);
        } else if (forceRefresh && allAlbums.length) {
            hasRenderedCatalog = true;
            setCatalogLoadStatus("Refreshing the catalog from Firestore…", false);
        }

        const querySnapshot = await db.collection("albums").get({ source: "server" });
        const albums = [];
        querySnapshot.forEach((doc) => albums.push({ ...doc.data(), id: doc.id }));
        renderAlbumDocuments(albums);
        hasRenderedCatalog = true;
        try {
            if (saveCatalogCache(albums)) {
                const updated = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
                setCatalogLoadStatus(`Catalog refreshed from Firestore at ${updated}.`, false);
            } else {
                setCatalogLoadStatus(
                    "Catalog refreshed, but it exceeds the browser cache limit and will load from Firestore next visit.",
                    false
                );
            }
        } catch (err) {
            console.error("Could not save catalog cache:", err);
            setCatalogLoadStatus(
                "Catalog refreshed, but browser storage could not save a cached copy.",
                true
            );
        }
    } catch (err) {
        console.error("Error loading data from Firestore:", err);
        if (!hasRenderedCatalog) {
            try {
                const snapshot = await db.collection("albums").get({ source: "cache" });
                const cachedAlbums = [];
                snapshot.forEach((doc) => cachedAlbums.push({ ...doc.data(), id: doc.id }));
                if (cachedAlbums.length) {
                    renderAlbumDocuments(cachedAlbums);
                    hasRenderedCatalog = true;
                    setCatalogLoadStatus(
                        "Offline: showing Firestore's saved copy. This catalog may be out of date; refresh when connected.",
                        true
                    );
                }
            } catch (cacheError) {
                console.warn("Firestore has no usable offline catalog cache.", cacheError);
            }
        }
        if (hasRenderedCatalog) {
            setCatalogLoadStatus(
                "Could not refresh the catalog. Showing saved data that may be out of date; try again when connected.",
                true
            );
        } else {
            showStatus("Could not load your library. Check your connection and Firestore rules.", true);
            setCatalogLoadStatus("Catalog failed to load.", true);
        }
    } finally {
        refreshButton.disabled = false;
        refreshButton.textContent = "Refresh catalog";
    }
}

document.addEventListener("DOMContentLoaded", () => {
    bindUi();
    document.getElementById("btn-refresh-catalog").addEventListener("click", () => loadAlbums(true));
    loadAlbums();
});
