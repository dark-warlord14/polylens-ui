/**
 * main.js — PolyLens Dashboard Controller
 */

let allOpportunities = [];
let currentCategory = "all";
let activeOutcome = null; // Outcome filter state ("Yes" | "No" | null)
const CORE_CATEGORIES = ["Politics", "Elections", "Sports", "Crypto", "Finance", "Economy", "Geopolitics", "Tech", "Culture", "Climate & Science"];

// Preset liquidity options (value in raw number)
const VOL_PRESETS = [
    { label: "5K",   value: 5000   },
    { label: "10K",  value: 10000  },
    { label: "25K",  value: 25000  },
    { label: "50K",  value: 50000  },
    { label: "Custom", value: "custom" }
];

// ─── Init ──────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
    setupThemeToggle(); // theme first to avoid flash
    initDashboard();
    setupEventListeners();
    setupLiquidityDropdown();
    checkOnboarding();
});

let _filterDebounce;
function setupEventListeners() {
    // These IDs all trigger a debounced filter re-run
    ["max-days", "min-prob", "max-prob", "vol-custom-input", "sort-by"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener("input", () => {
            clearTimeout(_filterDebounce);
            _filterDebounce = setTimeout(applyFilters, 300);
        });
    });

    // Guard: min-prob should never exceed max-prob and vice-versa
    const minProbEl = document.getElementById("min-prob");
    const maxProbEl = document.getElementById("max-prob");

    minProbEl?.addEventListener("change", () => {
        const min = parseFloat(minProbEl.value) || 0;
        const max = parseFloat(maxProbEl?.value) ?? 100;
        if (min > max) maxProbEl.value = min;
    });

    maxProbEl?.addEventListener("change", () => {
        const min = parseFloat(minProbEl?.value) || 0;
        const max = parseFloat(maxProbEl.value) ?? 100;
        if (max < min) minProbEl.value = max;
    });
}

// ─── Liquidity Dropdown ────────────────────────────────────────────

function setupLiquidityDropdown() {
    const select = document.getElementById("vol-preset");
    const customWrap = document.getElementById("vol-custom-wrap");
    const customInput = document.getElementById("vol-custom-input");

    if (!select) return;

    const toggle = () => {
        const isCustom = select.value === "custom";
        customWrap.classList.toggle("hidden", !isCustom);
        if (!isCustom) {
            clearTimeout(_filterDebounce);
            _filterDebounce = setTimeout(applyFilters, 300);
        }
    };

    select.addEventListener("change", toggle);

    // Sync state on first load (after loadConfig sets the value)
    // We call this in loadConfig after setting select.value
}

// ─── Theme Toggle ──────────────────────────────────────────────────

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

    const savedTheme = localStorage.getItem("polylens_theme");
    // Default to dark if no preference or explicitly dark
    const isDark = !savedTheme || savedTheme === "dark";
    setTheme(isDark);

    toggle?.addEventListener("click", () => {
        const isCurrentlyDark = document.body.classList.contains("dark-theme");
        setTheme(!isCurrentlyDark);
    });
}

// ─── Onboarding ────────────────────────────────────────────────────

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

// ─── Init Dashboard ────────────────────────────────────────────────

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

// ─── Config Persistence ────────────────────────────────────────────

const CONFIG_KEY = "polylens_filter_config";

function getEffectiveMinVolume() {
    const select = document.getElementById("vol-preset");
    if (!select) return 10000;
    if (select.value === "custom") {
        return parseFloat(document.getElementById("vol-custom-input")?.value) || 0;
    }
    return parseFloat(select.value) || 0;
}

function saveConfig() {
    const config = {
        volPreset:    document.getElementById("vol-preset")?.value      || "10000",
        volCustom:    document.getElementById("vol-custom-input")?.value || "",
        maxDays:      document.getElementById("max-days")?.value         || "1",
        minProb:      document.getElementById("min-prob")?.value         || "80",
        maxProb:      document.getElementById("max-prob")?.value         || "100",
        sortBy:       document.getElementById("sort-by")?.value          || "prob-desc"
    };
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

function loadConfig() {
    const saved = localStorage.getItem(CONFIG_KEY);
    const set = (id, val) => {
        const el = document.getElementById(id);
        if (el && val !== undefined && val !== null) el.value = val;
    };

    if (saved) {
        try {
            const config = JSON.parse(saved);
            set("vol-preset", config.volPreset);
            set("vol-custom-input", config.volCustom);
            set("max-days", config.maxDays);
            set("min-prob", config.minProb);
            set("max-prob", config.maxProb);
            set("sort-by", config.sortBy);
        } catch (e) {
            console.error("Failed to parse config:", e);
        }
    }

    // After loading, sync the custom-input visibility
    const select = document.getElementById("vol-preset");
    const customWrap = document.getElementById("vol-custom-wrap");
    if (select && customWrap) {
        customWrap.classList.toggle("hidden", select.value !== "custom");
    }
}

// ─── Stats ─────────────────────────────────────────────────────────

function updateStats(totalScanned, opportunitiesFound, timestamp) {
    const scannedEl = document.getElementById("stat-scanned");
    const dealsEl   = document.getElementById("stat-deals");
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

    const minVol  = getEffectiveMinVolume();
    const maxDays = parseFloat(document.getElementById("max-days")?.value) || 999;
    const minProb = parseFloat(document.getElementById("min-prob")?.value) || 0;
    const maxProb = parseFloat(document.getElementById("max-prob")?.value) ?? 100;
    const sortBy  = document.getElementById("sort-by")?.value || "prob";

    const sidebarFiltered = allOpportunities.filter(d =>
        d.volume >= minVol &&
        d.daysLeft <= maxDays &&
        d.probability >= minProb &&
        d.probability <= maxProb
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
        return d.outcome.toLowerCase() === activeOutcome.toLowerCase();
    });

    if      (sortBy === "prob-desc")  finalFiltered.sort((a, b) => b.probability - a.probability);
    else if (sortBy === "prob-asc")   finalFiltered.sort((a, b) => a.probability - b.probability);
    else if (sortBy === "vol-desc")   finalFiltered.sort((a, b) => b.volume - a.volume);
    else if (sortBy === "vol-asc")    finalFiltered.sort((a, b) => a.volume - b.volume);
    else if (sortBy === "days-asc")   finalFiltered.sort((a, b) => a.daysLeft - b.daysLeft);
    else if (sortBy === "days-desc")  finalFiltered.sort((a, b) => b.daysLeft - a.daysLeft);
    else finalFiltered.sort((a, b) => b.probability - a.probability); // fallback

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
        if (!CORE_CATEGORIES.includes(cat)) {
            otherCount++;
        }
        allCategoriesInFiltered.add(cat);
    });

    const categoriesToShow = Array.from(allCategoriesInFiltered)
        .filter(cat => CORE_CATEGORIES.includes(cat) || (!CORE_CATEGORIES.includes(cat) && otherCount === 0))
        .sort((a, b) => {
            const indexA = CORE_CATEGORIES.indexOf(a);
            const indexB = CORE_CATEGORIES.indexOf(b);
            if (indexA !== -1 && indexB !== -1) return indexA - indexB;
            if (indexA !== -1) return -1;
            if (indexB !== -1) return 1;
            return a.localeCompare(b);
        });

    if (otherCount > 0) {
        categoriesToShow.push("Other");
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
        if (count > 0 || currentCategory === cat) {
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

    const _base = categoryFiltered || filtered;
    const yesCount = _base.filter(d => d.outcome.toLowerCase() === "yes").length;
    const noCount  = _base.filter(d => d.outcome.toLowerCase() === "no").length;

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
    makeOutcomeChip("No",  "No",  noCount,  activeOutcome === "No");
}

// ─── Render ────────────────────────────────────────────────────────

function renderSkeletons() {
    const grid = document.getElementById("deals-grid");
    if (grid) grid.innerHTML = '<div class="skeleton-card" role="presentation"></div>'.repeat(8);
}

function renderOpportunities(deals) {
    const grid    = document.getElementById("deals-grid");
    const empty   = document.getElementById("empty-state");
    const dealsEl = document.getElementById("stat-deals");

    if (dealsEl) dealsEl.textContent = deals.length.toLocaleString();
    if (!grid) return;

    grid.innerHTML = "";

    if (empty) {
        empty.classList.toggle("hidden", deals.length > 0);
    }
    if (deals.length === 0) return;

    deals.forEach(deal => {
        const card = document.createElement("div");
        card.className = "deal-card";
        card.setAttribute("role", "listitem");

        const vol = deal.volume;
        const volLabel = vol >= 1e6
            ? `${(vol / 1e6).toFixed(1)}M`
            : vol >= 1e3
                ? `${(vol / 1e3).toFixed(0)}K`
                : `${vol}`;

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

        const isUrgent   = totalMinutes < 24 * 60;
        const isHighProb = deal.probability >= 80;

        // Escape to prevent XSS
        const title    = escapeHTML(deal.title);
        const category = escapeHTML(deal.category || "General");
        const outcome  = escapeHTML(String(deal.outcome || "Yes"));
        const outcomeClass = outcome.toLowerCase() === "yes" ? "yes" : "no";

        card.innerHTML = `
            <div class="card-header">
                <span class="cat-badge" data-cat="${category}">${category}</span>
                <span class="vol-badge vol-${volTier}">${volLabel}</span>
            </div>

            <div class="card-body">
                <h3 class="market-title">${title}</h3>
                <div class="outcome-row">
                    <span class="outcome-pill ${outcomeClass}">${outcome}</span>
                    <span class="expiry-chip${isUrgent ? " urgent" : ""}">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                            <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                        </svg>
                        ${daysLabel}
                    </span>
                </div>
            </div>

            <div class="card-metrics">
                <span class="metric-label">Probability</span>
                <span class="metric-value${isHighProb ? " prob-high" : ""}">${deal.probability}%</span>
                <div class="prob-track">
                    <div class="prob-bar${isHighProb ? " high" : ""}" style="width: ${deal.probability}%"></div>
                </div>
            </div>

            <div class="card-footer">
                <a href="https://polymarket.com/market/${encodeURIComponent(deal.slug)}" target="_blank" rel="noopener noreferrer" class="cta-btn">
                    <span>Trade on Polymarket</span>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
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
