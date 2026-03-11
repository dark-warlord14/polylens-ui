/**
 * app.js — PolyLens Elite Dashboard Controller
 */

const CACHE_KEY = "polylens_elite_cache";
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

let allOpportunities = [];
let currentCategory = "all";
let activeOutcome = null; // Outcome filter state ("Yes" | "No" | null)
const CORE_CATEGORIES = ["Politics", "Elections", "Sports", "Crypto", "Finance", "Economy", "Geopolitics", "Tech", "Culture", "Climate & Science"];

// ─── Init ──────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
    initDashboard();
    setupEventListeners();
    setupSidebarToggle();
});

function setupSidebarToggle() {
    const dashboard = document.getElementById("dashboard");
    const headerToggle = document.getElementById("header-filter-toggle");
    const overlay = document.getElementById("sidebar-overlay");

    // Restore state from localStorage (default to visible on desktop for first-time use)
    const isCollapsed = localStorage.getItem("sidebar-collapsed") === "true";
    if (isCollapsed) dashboard.classList.add("sidebar-collapsed");

    const toggle = () => {
        if (window.innerWidth > 992) {
            dashboard.classList.toggle("sidebar-collapsed");
            localStorage.setItem("sidebar-collapsed", dashboard.classList.contains("sidebar-collapsed"));
        } else {
            dashboard.classList.toggle("sidebar-open");
        }
    };

    headerToggle?.addEventListener("click", toggle);
    overlay?.addEventListener("click", () => dashboard.classList.remove("sidebar-open"));
}

function setupEventListeners() {
    ["min-volume", "max-days", "min-prob", "max-prob", "sort-by"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener("input", () => {
            // Auto-clamp: keep min ≤ max when either changes
            const minEl = document.getElementById("min-prob");
            const maxEl = document.getElementById("max-prob");
            if (minEl && maxEl && id === "min-prob" && parseFloat(minEl.value) > parseFloat(maxEl.value)) {
                maxEl.value = minEl.value;
            }
            if (minEl && maxEl && id === "max-prob" && parseFloat(maxEl.value) < parseFloat(minEl.value)) {
                minEl.value = maxEl.value;
            }
            applyFilters();
        });
    });
}

async function initDashboard() {
    renderSkeletons();
    loadConfig(); // Restore saved filter settings first

    try {
        // Direct fetch from the static JSON file
        const response = await fetch('data/cache.json');
        if (!response.ok) throw new Error('Network response was not ok');
        const cache = await response.json();

        if (cache && cache.deals && cache.deals.length > 0) {
            allOpportunities = cache.deals;
            updateStats(cache.count, allOpportunities.length, cache.timestamp);
            applyFilters();

            const ageMs = Date.now() - (cache.timestamp || 0);
            if (ageMs > CACHE_TTL_MS) {
                const statusEl = document.getElementById("sync-status");
                if (statusEl) statusEl.textContent = `Last updated ${formatAge(ageMs)} ago`;
            }
        }
    } catch (error) {
        console.error('Failed to load markets:', error);
        const statusEl = document.getElementById("sync-status");
        if (statusEl) statusEl.textContent = "Error loading markets. Please try again later.";
    }
}

// ─── Config Persistence (Native localStorage) ──────────────────────

const CONFIG_KEY = "polylens_filter_config";

function saveConfig() {
    const config = {
        minVolume: document.getElementById("min-volume")?.value || "10000",
        maxDays: document.getElementById("max-days")?.value || "1",
        minProb: document.getElementById("min-prob")?.value || "80",
        maxProb: document.getElementById("max-prob")?.value || "99",
        sortBy: document.getElementById("sort-by")?.value || "roi"
    };
    
    // Direct localStorage save
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

function loadConfig() {
    const saved = localStorage.getItem(CONFIG_KEY);
    if (!saved) return;

    try {
        const config = JSON.parse(saved);
        const set = (id, val) => {
            const el = document.getElementById(id);
            if (el && val !== undefined) el.value = val;
        };
        set("min-volume", config.minVolume);
        set("max-days", config.maxDays);
        set("min-prob", config.minProb);
        set("max-prob", config.maxProb);
        set("sort-by", config.sortBy);
    } catch (e) {
        console.error("Failed to parse config:", e);
    }
}

// ─── Stats ─────────────────────────────────────────────────────────

function updateStats(totalScanned, opportunitiesFound, timestamp) {
    const scannedEl = document.getElementById("stat-scanned");
    const dealsEl = document.getElementById("stat-deals");
    const lastSyncEl = document.getElementById("last-sync");

    if (scannedEl) scannedEl.textContent = (totalScanned || 0).toLocaleString();
    if (dealsEl) dealsEl.textContent = (opportunitiesFound || 0).toLocaleString();
    if (lastSyncEl && timestamp) {
        const ageMs = Date.now() - timestamp;
        lastSyncEl.textContent = `Updated ${formatAge(ageMs)} ago`;
    }
}

function formatAge(ms) {
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    return `${hrs}h ${mins % 60}m`;
}

// ─── Filter & Render Pipeline ──────────────────────────────────────

function applyFilters() {
    saveConfig(); // Auto-save on every filter change
    const minVol = parseFloat(document.getElementById("min-volume")?.value) || 0;
    const maxDays = parseFloat(document.getElementById("max-days")?.value) || 999;
    const minProb = parseFloat(document.getElementById("min-prob")?.value) || 0;
    const maxProb = parseFloat(document.getElementById("max-prob")?.value) || 100;
    const sortBy = document.getElementById("sort-by")?.value || "roi";

    const sidebarFiltered = allOpportunities.filter(d =>
        d.volume >= minVol &&
        d.daysLeft <= maxDays &&
        d.probability >= minProb &&
        d.probability <= maxProb
    );

    updateCategoryChips(sidebarFiltered);

    const categoryFiltered = sidebarFiltered.filter(d => {
        if (currentCategory === "all") return true;
        if (currentCategory === "Other") return !CORE_CATEGORIES.includes(d.category);
        return d.category === currentCategory;
    });

    const finalFiltered = categoryFiltered.filter(d => {
        if (!activeOutcome) return true;
        // Case-insensitive match for robustness
        return d.outcome.toLowerCase() === activeOutcome.toLowerCase();
    });

    if (sortBy === "roi") finalFiltered.sort((a, b) => b.roi - a.roi);
    else if (sortBy === "volume") finalFiltered.sort((a, b) => b.volume - a.volume);
    else if (sortBy === "prob") finalFiltered.sort((a, b) => b.probability - a.probability);
    else if (sortBy === "days") finalFiltered.sort((a, b) => a.daysLeft - b.daysLeft);

    renderOpportunities(finalFiltered);
}

function updateCategoryChips(filtered) {
    const container = document.getElementById("category-filters");
    if (!container) return;

    const allCategoriesInFiltered = new Set();
    const counts = {};
    let otherCount = 0;

    filtered.forEach(d => {
        const cat = d.category;
        counts[cat] = (counts[cat] || 0) + 1;
        if (!CORE_CATEGORIES.includes(cat)) { // Check against CORE_CATEGORIES to determine 'Other'
            otherCount++;
        }
        allCategoriesInFiltered.add(cat); // Add all unique categories found
    });

    // Determine which categories to explicitly show as chips, maintaining order
    const categoriesToShow = Array.from(allCategoriesInFiltered)
        .filter(cat => CORE_CATEGORIES.includes(cat) || (!CORE_CATEGORIES.includes(cat) && otherCount === 0)) // Only show non-core explicitly if there's no 'Other' bucket
        .sort((a, b) => {
            // Sort: CORE_CATEGORIES order first, then alphabetical for others
            const indexA = CORE_CATEGORIES.indexOf(a);
            const indexB = CORE_CATEGORIES.indexOf(b);
            if (indexA !== -1 && indexB !== -1) return indexA - indexB; // Both are core, sort by core index
            if (indexA !== -1) return -1; // A is core, B is not, A comes first
            if (indexB !== -1) return 1;  // B is core, A is not, B comes first
            return a.localeCompare(b); // Neither are core, sort alphabetically
        });

    if (otherCount > 0) {
        categoriesToShow.push("Other"); // Add "Other" chip if there are any non-core markets
    }

    container.innerHTML = "";

    const makeChip = (label, isActive, onClick) => {
        const btn = document.createElement("button");
        btn.className = `cat-chip${isActive ? " active" : ""}`;
        btn.textContent = label;
        btn.onclick = onClick;
        container.appendChild(btn);
    };

    makeChip(`All  ${filtered.length}`, currentCategory === "all", () => {
        currentCategory = "all";
        applyFilters();
    });

    categoriesToShow.forEach(cat => {
        const count = cat === "Other" ? otherCount : (counts[cat] || 0);
        if (count > 0 || currentCategory === cat) { // Only show chip if count > 0 or it's the currently active category
            makeChip(`${cat}  ${count}`, currentCategory === cat, () => {
                currentCategory = cat;
                applyFilters();
            });
        }
    });

    // Add separator & Yes/No chips
    const sep = document.createElement("div");
    sep.className = "nav-sep";
    container.appendChild(sep);

    // Yes/No counts in the CURRENT filtered set
    const yesCount = filtered.filter(d => d.outcome.toLowerCase() === "yes").length;
    const noCount = filtered.filter(d => d.outcome.toLowerCase() === "no").length;

    const makeOutcomeChip = (label, value, count, isActive) => {
        const btn = document.createElement("button");
        btn.className = `cat-chip outcome-chip-mini${isActive ? " active" : ""}`;
        btn.innerHTML = `${label} <span>${count}</span>`;
        btn.onclick = () => {
            activeOutcome = isActive ? null : value;
            applyFilters();
        };
        container.appendChild(btn);
    };

    makeOutcomeChip("Yes", "Yes", yesCount, activeOutcome === "Yes");
    makeOutcomeChip("No", "No", noCount, activeOutcome === "No");
}

// ─── Render ────────────────────────────────────────────────────────

function renderSkeletons() {
    const grid = document.getElementById("deals-grid");
    if (grid) grid.innerHTML = '<div class="skeleton-card"></div>'.repeat(8);
}

function renderOpportunities(deals) {
    const grid = document.getElementById("deals-grid");
    const empty = document.getElementById("empty-state");
    const dealsEl = document.getElementById("stat-deals");

    if (dealsEl) dealsEl.textContent = deals.length.toLocaleString();
    if (!grid) return;

    grid.innerHTML = "";

    if (deals.length === 0) {
        if (empty) empty.classList.remove("hidden");
        return;
    }
    if (empty) empty.classList.add("hidden");

    deals.forEach(deal => {
        const card = document.createElement("div");
        card.className = "deal-card";

        const vol = deal.volume;
        const volLabel = vol >= 1e6
            ? `$${(vol / 1e6).toFixed(1)}M`
            : vol >= 1e3
                ? `$${(vol / 1e3).toFixed(0)}K`
                : `$${vol}`;

        const volTier = vol >= 500000 ? "high" : vol >= 100000 ? "mid" : "low";
        const totalMinutes = deal.expiryDate
            ? Math.max(0, Math.floor((new Date(deal.expiryDate) - Date.now()) / 60000))
            : Math.max(0, Math.floor(deal.daysLeft * 24 * 60));

        const dd = Math.floor(totalMinutes / (60 * 24));
        const hh = Math.floor((totalMinutes % (60 * 24)) / 60);
        const mm = totalMinutes % 60;

        let daysLabel;
        if (totalMinutes <= 0) {
            daysLabel = "Closing now";
        } else if (dd === 0 && hh === 0) {
            daysLabel = `${mm}m left`;
        } else if (dd === 0) {
            daysLabel = `${hh}h ${mm}m left`;
        } else {
            daysLabel = `${dd}d ${hh}h left`;
        }

        const isUrgent = totalMinutes < 24 * 60; // < 24 hours
        const isHighProb = deal.probability >= 80;

        // Escape to prevent XSS
        const title = escapeHTML(deal.title);
        const outcome = escapeHTML(String(deal.outcome || "Yes"));

        card.innerHTML = `
            <div class="card-header">
                <span class="cat-badge">${escapeHTML(deal.category || "General")}</span>
                <span class="vol-badge vol-${volTier}">${volLabel}</span>
            </div>

            <div class="card-body">
                <p class="market-title">${title}</p>
                <div class="outcome-row">
                    <span class="outcome-pill">${outcome}</span>
                    <span class="expiry-chip${isUrgent ? " urgent" : ""}">${daysLabel}</span>
                </div>
            </div>

            <div class="card-metrics">
                <div class="metric">
                    <span class="metric-label">Probability</span>
                    <span class="metric-value${isHighProb ? " prob-high" : ""}">${deal.probability}%</span>
                </div>
                <div class="metric">
                    <span class="metric-label">Implied ROI</span>
                    <span class="metric-value roi-val">+${deal.roi}%</span>
                </div>
            </div>

            <div class="card-footer">
                <a href="https://polymarket.com/market/${deal.slug}" target="_blank" class="cta-btn">
                    Trade on Polymarket
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M7 17L17 7M17 7H7M17 7v10"/>
                    </svg>
                </a>
            </div>
        `;
        grid.appendChild(card);
    });
}

function escapeHTML(str) {
    if (!str) return "";
    return String(str).replace(/[&<>"']/g, m => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[m]));
}
