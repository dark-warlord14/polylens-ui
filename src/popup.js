// popup.js
// Simplifies communication with the dashboard.

document.addEventListener("DOMContentLoaded", function () {
    restoreState();
    refreshBadge();
    setupTabs();
    
    const applyBtn = document.getElementById("btn-apply");
    if (applyBtn) applyBtn.addEventListener("click", applyFilter);
    
    const clearBtn = document.getElementById("btn-clear");
    if (clearBtn) clearBtn.addEventListener("click", clearFilter);
    
    const dashboardBtn = document.getElementById("btn-open-dashboard");
    if (dashboardBtn) {
        dashboardBtn.addEventListener("click", function () {
            window.location.href = '/';
        });
    }
    
    setupQuickFilters();
    prefillDates();
});

var currentMode = "days";

function setupTabs() {
    document.querySelectorAll(".tab").forEach(function (tab) {
        tab.addEventListener("click", function () {
            document.querySelectorAll(".tab").forEach(function (t) { t.classList.remove("active"); });
            tab.classList.add("active");
            currentMode = tab.getAttribute("data-mode");
            
            document.querySelectorAll(".filter-section").forEach(function (s) { s.classList.remove("visible"); });
            var section = document.getElementById("section-" + currentMode);
            if (section) section.classList.add("visible");
        });
    });
}

function setupQuickFilters() {
    // Days chips
    document.querySelectorAll(".chip[data-val]").forEach(function (chip) {
        chip.addEventListener("click", function () {
            const input = document.getElementById("input-days");
            if (input) {
                input.value = chip.getAttribute("data-val");
                updateChips("days", chip);
                applyFilter();
            }
        });
    });

    // Date chips
    const todayChip = document.getElementById("chip-today");
    if (todayChip) {
        todayChip.addEventListener("click", function () {
            const input = document.getElementById("input-date");
            if (input) {
                input.value = new Date().toISOString().split("T")[0];
                updateChips("date", this);
                applyFilter();
            }
        });
    }

    const endMonthChip = document.getElementById("chip-end-month");
    if (endMonthChip) {
        endMonthChip.addEventListener("click", function () {
            const input = document.getElementById("input-date");
            if (input) {
                var now = new Date();
                var lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
                input.value = lastDay.toISOString().split("T")[0];
                updateChips("date", this);
                applyFilter();
            }
        });
    }
}

function updateChips(context, activeChip) {
    var parent = activeChip.parentElement;
    if (parent) {
        parent.querySelectorAll(".chip").forEach(function (c) { c.classList.remove("active"); });
        activeChip.classList.add("active");
    }
}

function prefillDates() {
    var today = new Date().toISOString().split("T")[0];
    var startInput = document.getElementById("input-start");
    if (startInput && !startInput.value) {
        startInput.value = today;
    }
}

function refreshBadge() {
    // Fetch count from the cached JSON file
    fetch('data/cache.json')
        .then(res => res.json())
        .then(cache => {
            updateBadgeUI(cache.count || 0, "ok");
        })
        .catch(err => {
            console.error("Failed to load count for badge:", err);
            updateBadgeUI(0, "error");
        });
}

function updateBadgeUI(count, state) {
    var b = document.getElementById("api-badge");
    var t = document.getElementById("api-badge-text");
    if (!b || !t) return;

    if (state === "error") {
        b.className = "badge badge-error";
        t.textContent = "Data unavailable";
    } else if (state === "ok") {
        b.className = "badge badge-ok";
        t.textContent = count.toLocaleString() + " markets synced";
    } else {
        b.className = "badge badge-loading";
        t.textContent = "Loading markets...";
    }
}

function applyFilter() {
    var filters = buildFilters();
    if (!filters && currentMode !== "deals") return;

    var payload = { mode: currentMode, filters: filters };
    // Native localStorage save
    localStorage.setItem("polyFilters", JSON.stringify(payload));
    showStatus("Filters saved locally", "ok");
}

function clearFilter() {
    ["input-days", "input-date", "input-start", "input-end"].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.value = "";
    });
    localStorage.removeItem("polyFilters");
    hideStatus();
}

function buildFilters() {
    if (currentMode === "days") {
        var el = document.getElementById("input-days");
        var d = el ? el.value : "";
        if (d === "") return null;
        return { daysToExpiry: parseInt(d, 10) };
    }
    if (currentMode === "date") {
        var el = document.getElementById("input-date");
        var dt = el ? el.value : "";
        if (!dt) return null;
        return { exactDate: dt };
    }
    if (currentMode === "range") {
        var sEl = document.getElementById("input-start");
        var eEl = document.getElementById("input-end");
        var s = sEl ? sEl.value : "";
        var e = eEl ? eEl.value : "";
        if (!s || !e) return null;
        return { rangeStart: s, rangeEnd: e };
    }
    return null;
}

function showStatus(text, type) {
    var b = document.getElementById("status-bar");
    var labels = document.getElementById("status-text");
    var c = document.getElementById("status-counts");
    if (!b || !labels || !c) return;

    b.classList.remove("hidden");
    if (type === "error") {
        b.style.background = "#fff1f2";
        b.style.color = "#9f1239";
        labels.textContent = text;
        c.textContent = "";
    } else {
        b.style.background = "#f0fdf4";
        b.style.color = "#166534";
        labels.textContent = "Filter Active: ";
        c.textContent = text;
    }
}

function hideStatus() {
    var b = document.getElementById("status-bar");
    if (b) b.classList.add("hidden");
}

function restoreState() {
    const saved = localStorage.getItem("polyFilters");
    if (!saved) return;

    try {
        const s = JSON.parse(saved);
        currentMode = s.mode || "days";
        
        document.querySelectorAll(".tab").forEach(function (t) { t.classList.remove("active"); });
        var t = document.querySelector('.tab[data-mode="' + currentMode + '"]');
        if (t) t.classList.add("active");
        
        document.querySelectorAll(".filter-section").forEach(function (sec) { sec.classList.remove("visible"); });
        var sec = document.getElementById("section-" + currentMode);
        if (sec) sec.classList.add("visible");
        
        if (s.filters) {
            var f = s.filters;
            var iDays = document.getElementById("input-days");
            var iDate = document.getElementById("input-date");
            var iStart = document.getElementById("input-start");
            var iEnd = document.getElementById("input-end");

            if (iDays && f.daysToExpiry !== undefined) iDays.value = f.daysToExpiry;
            if (iDate && f.exactDate) iDate.value = f.exactDate;
            if (iStart && f.rangeStart) iStart.value = f.rangeStart;
            if (iEnd && f.rangeEnd) iEnd.value = f.rangeEnd;
        }
    } catch (e) {}
}
