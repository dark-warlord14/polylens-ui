/**
 * app.js — PolyLens Elite Dashboard Controller
 */

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

let allOpportunities = [];
let currentCategory = "all";
let activeOutcome = null; // Outcome filter state ("Yes" | "No" | null)
const CORE_CATEGORIES = ["Politics", "Elections", "Sports", "Crypto", "Finance", "Economy", "Geopolitics", "Tech", "Culture", "Climate & Science"];

// ─── Init ──────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
    initDashboard();
    setupEventListeners();
    setupThemeToggle();
    checkOnboarding();
});

let _filterDebounce;
function setupEventListeners() {
    ["min-volume", "max-days", "min-prob", "sort-by"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener("input", () => {
            clearTimeout(_filterDebounce);
            _filterDebounce = setTimeout(applyFilters, 300);
        });
    });
}

function setupThemeToggle() {
    const toggle = document.getElementById("theme-toggle-header");
    const lightIcon = document.getElementById("theme-light-icon-header");
    const darkIcon = document.getElementById("theme-dark-icon-header");

    const setTheme = (isDark) => {
        if (isDark) {
            document.body.classList.add("dark-theme");
            lightIcon?.classList.remove("active");
            darkIcon?.classList.add("active");
        } else {
            document.body.classList.remove("dark-theme");
            lightIcon?.classList.add("active");
            darkIcon?.classList.remove("active");
        }
        localStorage.setItem("polylens_theme", isDark ? "dark" : "light");
    };

    // Init
    const savedTheme = localStorage.getItem("polylens_theme");
    // Default to dark if no preference or explicitly dark
    const isDark = !savedTheme || savedTheme === "dark";
    setTheme(isDark);

    toggle?.addEventListener("click", () => {
        const isCurrentlyDark = document.body.classList.contains("dark-theme");
        setTheme(!isCurrentlyDark);
    });
}

function checkOnboarding() {
    const overlay = document.getElementById("welcome-overlay");
    const closeBtn = document.getElementById("close-welcome");
    const lastWelcomed = localStorage.getItem("polylens_last_welcomed");
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

    const shouldShow = !lastWelcomed || (Date.now() - parseInt(lastWelcomed, 10) > SEVEN_DAYS_MS);

    if (shouldShow) {
        setTimeout(() => overlay?.classList.add("active"), 500);
    }

    closeBtn?.addEventListener("click", () => {
        overlay?.classList.remove("active");
        localStorage.setItem("polylens_last_welcomed", Date.now().toString());
    });
}

async function initDashboard() {
    renderSkeletons();
    loadConfig();

    try {
        const response = await fetch('data/cache.json');
        if (!response.ok) throw new Error('Network response was not ok');
        const cache = await response.json();

        if (cache && cache.deals && cache.deals.length > 0) {
            allOpportunities = cache.deals;
            updateStats(cache.count, allOpportunities.length, cache.timestamp);
            applyFilters();
        }
    } catch (error) {
        console.error('Failed to load markets:', error);
        const statusEl = document.getElementById("last-sync");
        if (statusEl) statusEl.textContent = "Error loading markets.";
    }
}

// ─── Config Persistence (Native localStorage) ──────────────────────

const CONFIG_KEY = "polylens_filter_config";

function saveConfig() {
    const config = {
        minVolume: document.getElementById("min-volume")?.value || "10000",
        maxDays: document.getElementById("max-days")?.value || "1",
        minProb: document.getElementById("min-prob")?.value || "80",
        sortBy: document.getElementById("sort-by")?.value || "roi"
    };
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
        const mins = Math.floor(ageMs / 60000);
        if (mins < 1) {
            lastSyncEl.textContent = "Just synced";
        } else if (mins < 60) {
            lastSyncEl.textContent = `Updated ${mins}m ago`;
        } else {
            const hrs = Math.floor(mins / 60);
            lastSyncEl.textContent = `Updated ${hrs}h ${mins % 60}m ago`;
        }
    }
}

// ─── Filter & Render Pipeline ──────────────────────────────────────

function applyFilters() {
    saveConfig(); // Auto-save on every filter change
    const minVol = parseFloat(document.getElementById("min-volume")?.value) || 0;
    const maxDays = parseFloat(document.getElementById("max-days")?.value) || 999;
    const minProb = parseFloat(document.getElementById("min-prob")?.value) || 0;
    const sortBy = document.getElementById("sort-by")?.value || "roi";

    const sidebarFiltered = allOpportunities.filter(d =>
        d.volume >= minVol &&
        d.daysLeft <= maxDays &&
        d.probability >= minProb
    );

    const categoryFiltered = sidebarFiltered.filter(d => {
        if (currentCategory === "all") return true;
        if (currentCategory === "Other") return !CORE_CATEGORIES.includes(d.category);
        return d.category === currentCategory;
    });

    // Pass category-filtered set so Yes/No counts reflect what's actually visible
    updateCategoryChips(sidebarFiltered, categoryFiltered);

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

function updateCategoryChips(filtered, categoryFiltered) {
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

    // Yes/No counts in the CATEGORY-filtered set (what's actually visible)
    const _base = categoryFiltered || filtered;
    const yesCount = _base.filter(d => d.outcome.toLowerCase() === "yes").length;
    const noCount = _base.filter(d => d.outcome.toLowerCase() === "no").length;

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

    if (empty) {
        if (deals.length === 0) {
            empty.classList.remove("hidden");
        } else {
            empty.classList.add("hidden");
        }
    }
    if (deals.length === 0) return;

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
                <span class="vol-badge vol-${volTier}">${volLabel} volume</span>
            </div>

            <div class="card-body">
                <p class="market-title">${title}</p>
                <div class="outcome-row">
                    <span class="outcome-pill">${outcome}</span>
                    <span class="expiry-chip${isUrgent ? " urgent" : ""}">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin-right: 4px;"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                        ${daysLabel}
                    </span>
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
                <a href="https://polymarket.com/market/${encodeURIComponent(deal.slug)}" target="_blank" class="cta-btn">
                    <span>Trade on Polymarket</span>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                        <polyline points="15 3 21 3 21 9"></polyline>
                        <line x1="10" y1="14" x2="21" y2="3"></line>
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
