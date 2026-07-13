// ==UserScript==
// @name         AM4 MASTER SUITE MADE BY HOSS
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  try to take over the world!
// @author       HOSS
// @match        *://*://*
// @match        *://airlinemanager.com/*
// @run-at       document-idle
// @icon         https://www.google.com/s2/favicons?sz=64&domain=airlinemanager.com
// @grant        none
// ==/UserScript==

/* global jQuery, autoPrice, closePop */

//================================================================================
// Parts 1 & 2 of 13: Global State Variables & Wallet Telemetry
//================================================================================
var autoDepartTimeoutID = null;
var autoBuyerTimeoutID = null;
var autoMarketingTimeoutID = null;
var autoRepairTimeoutID = null;
var autoCheckTimeoutID = null;

var isMaintenanceRunning = false;
var isCheckMaintenanceRunning = false;

var maxWearThreshold = 20;
var performAChecks = true;
var marketingType = 1;
var marketingDuration = 3;
var isBotPausedDueToFunds = false;

var fuelPriceThreshold = 1000;
var co2PriceThreshold = 200;

var lastMonitoredBalance = 0;
var lastMonitoredFuel = 0;
var lastMonitoredCO2 = 0;

var netRevenueIntervalTicks = [];
var historicalRevenueLogs = [];
var accountingCycleStartTime = Date.now();

window.originalClosePop = window.originalClosePop || null;
if (typeof window.closePop === 'function') {
    window.originalClosePop = window.closePop;
}

function getBankBalance() {
    var bankBalance = document.getElementById('headerAccount');
    if (bankBalance) {
        var rawText = bankBalance.innerText;
        var sanitizedNum = rawText.replace(/[^0-9]/g, '');
        var parsedInt = parseInt(sanitizedNum, 10);
        return parsedInt || 0;
    }
    return 0;
}

function buyFuel(intAmount) {
    var amt = (typeof intAmount !== 'undefined') ? intAmount : "buyAll";
    var encodedAmount = encodeURIComponent(amt);
    var url = 'fuel.php?mode=do&amount=' + encodedAmount;
    if(amt === "buyAll") url = 'fuel.php?mode=buyAll';
    call(url);
}

// FIXED: Cleaned up the closePop override to never block user operations
window.closePop = function() {
    if (typeof window.originalClosePop === 'function') {
        window.originalClosePop();
    } else {
        var p = document.getElementById('popup');
        if (p) p.style.display = 'none';
    }
    if (typeof jQuery !== 'undefined') {
        jQuery('.modal-backdrop').remove();
    }
};

function buyCO2(intAmount) {
    var amt = (typeof intAmount !== 'undefined') ? intAmount : "buyAll";
    var encodedAmount = encodeURIComponent(amt);
    var url = 'co2.php?mode=do&amount=' + encodedAmount;
    if(amt === "buyAll") url = 'co2.php?mode=buyAll';
    call(url);
}

function call(url) {
    var xhr = new XMLHttpRequest();
    xhr.onreadystatechange = function () {
        if (xhr.readyState === XMLHttpRequest.DONE && xhr.status === 200) {
            console.log('[AM4 Bot Log] Synchronization successful: ' + url.split('?')[0]);
        }
    };
    xhr.open('GET', url, true);
    xhr.send();
}

if (typeof window.Android === 'undefined') {
    window.Android = {
        playSound: function(s) { console.log("Audio emulated: " + s); },
        showToast: function(m) { console.log("Toast emulated: " + m); }
    };
}

function checkAccountBalanceToastSafety() {
    var toastWrap = document.querySelector("body > div.jq-toast-wrap > div.jq-toast-single");
    if (!toastWrap) return false;
    var heading = toastWrap.querySelector("h2.jq-toast-heading");
    if (heading && heading.innerText.toLowerCase().includes("account too low")) {
        isBotPausedDueToFunds = true;
        isMaintenanceRunning = false;
        isCheckMaintenanceRunning = false;
        var checkBoxes = ["autoDepartCheckbox", "autoBuyerCheckbox", "autoMarketingCheckbox", "autoRepairCheckbox", "autoCheckCheckbox"];
        checkBoxes.forEach(function(id) {
            var cb = document.getElementById(id);
            if (cb && cb.checked) {
                cb.checked = false;
                cb.dispatchEvent(new Event("change", { bubbles: true }));
            }
        });
        return true;
    }
    return false;
}

//================================================================================
// Part 3 of 13: Global User Interface Switch Links (Instant First-Run Fix)
//================================================================================
function triggerDepartToggle() {
    var cb = document.getElementById("autoDepartCheckbox");
    if (cb && cb.checked) {
        // Run the routine immediately on check instead of waiting 15 minutes
        autoDepartRoutine();
    } else {
        clearTimeout(autoDepartTimeoutID);
    }
}

function triggerBuyerToggle() {
    var cb = document.getElementById("autoBuyerCheckbox");
    if (cb && cb.checked) {
        // Run the scan immediately on check instead of waiting 25 minutes
        scanConsumable();
    } else {
        clearTimeout(autoBuyerTimeoutID);
    }
}

function triggerMarketingToggle() {
    var cb = document.getElementById("autoMarketingCheckbox");
    if (cb && cb.checked) {
        // Run the marketing routine immediately on check
        run24hMarketingRoutine();
    } else {
        clearTimeout(autoMarketingTimeoutID);
    }
}

function triggerRepairToggle() {
    var cb = document.getElementById("autoRepairCheckbox");
    if (cb && cb.checked) {
        var popupEl = document.getElementById('popup');
        // If a popup was just open or is currently fading out, add an 800ms delay to let the animations clear
        var delayTime = (popupEl && popupEl.style.display === 'block') ? 800 : 50;

        setTimeout(function() {
            autoRepairCheckLoop();
        }, delayTime);
    } else {
        clearTimeout(autoRepairTimeoutID);
        isMaintenanceRunning = false;
    }
}

function triggerCheckToggle() {
    var cb = document.getElementById("autoCheckCheckbox");
    if (cb && cb.checked) {
        var popupEl = document.getElementById('popup');
        // If a popup was just open or is currently fading out, add an 800ms delay to let the animations clear
        var delayTime = (popupEl && popupEl.style.display === 'block') ? 800 : 50;

        setTimeout(function() {
            autoCheckCheckLoop();
        }, delayTime);
    } else {
        clearTimeout(autoCheckTimeoutID);
        isCheckMaintenanceRunning = false;
    }
}

//================================================================================
// Part 4 of 13: Independent Viewport Un-Latch & Click-Safe Interception Core
//================================================================================
function injectToggleControls() {
    if (document.getElementById("autoDepartCheckbox")) return;
    var navbarTarget = document.querySelector(".status-list") || document.getElementById("statusList") || document.querySelector(".navbar-nav");
    if (!navbarTarget) {
        setTimeout(injectToggleControls, 1000);
        return;
    }
    var items = [
        { id: "autoDepartCheckbox", label: "Auto-Depart", color: "#aaa" },
        { id: "autoBuyerCheckbox", label: "Auto-Buy Specs", color: "#aaa" },
        { id: "autoMarketingCheckbox", label: "Auto-Buy Mktg", color: "#aaa" },
        { id: "autoRepairCheckbox", label: "Auto-Repair", color: "#f0ad4e" },
        { id: "autoCheckCheckbox", label: "Auto-Check", color: "#5bc85c" }
    ];
    items.forEach(function(item) {
        var li = document.createElement("li");
        li.className = "nav-item text-white text-center";
        li.style.cssText = "display:inline-block; padding:0 10px; vertical-align:middle;";
        li.innerHTML = "<span style='font-size:10px; color:" + item.color + ";'>" + item.label + "</span><br><input type='checkbox' id='" + item.id + "' style='cursor:pointer;'>";
        navbarTarget.appendChild(li);
    });
    var liStatus = document.createElement("li");
    liStatus.className = "nav-item text-white text-center";
    liStatus.style.cssText = "display:inline-block; padding:0 10px; vertical-align:middle;";
    liStatus.innerHTML = "<span style='font-size:10px; color:#aaa;'>Fleet Status</span><br><span id='maintenanceStatusLabel' style='color:#5cb85c; font-weight:bold; font-size:11px;'>Fleet Healthy</span>";
    navbarTarget.appendChild(liStatus);

    document.getElementById("autoDepartCheckbox").addEventListener("change", triggerDepartToggle);
    document.getElementById("autoBuyerCheckbox").addEventListener("change", triggerBuyerToggle);
    document.getElementById("autoMarketingCheckbox").addEventListener("change", triggerMarketingToggle);
    document.getElementById("autoRepairCheckbox").addEventListener("change", triggerRepairToggle);
    document.getElementById("autoCheckCheckbox").addEventListener("change", triggerCheckToggle);
    console.log("[AM4 Bot Log] Navbar control center interface mounted successfully.");
}

function setupClosePopProtection() {
    console.log("[AM4 Bot Log] Safety loop initialized using a decoupled background click interceptor.");
    window.closePop = function() {
        // FIXED: Verifies both decoupled trackers to ensure security states align correctly
        if ((typeof isMaintenanceRunning !== 'undefined' && isMaintenanceRunning) || (typeof isCheckMaintenanceRunning !== 'undefined' && isCheckMaintenanceRunning)) {
            console.log("[AM4 Bot Log] Active task holds layout focus. Close blocked.");
            return;
        }
        try {
            if (typeof window.originalClosePop === 'function') {
                window.originalClosePop();
            } else {
                var popupBox = document.getElementById('popup');
                if (popupBox) {
                    popupBox.style.display = 'none';
                    popupBox.setAttribute('aria-hidden', 'true');
                }
            }
            if (typeof jQuery !== 'undefined') {
                jQuery('.modal-backdrop').remove();
            } else {
                document.querySelectorAll('.modal-backdrop').forEach(function(el) { el.remove(); });
            }
        } catch(err) {
            console.log("[AM4 Bot Log] Error in closePop override: " + err.message);
        }
    };
    document.addEventListener('click', function(event) {
        // FIXED: Verified across both variables to block click interference during automation runs
        if ((typeof isMaintenanceRunning !== 'undefined' && isMaintenanceRunning) || (typeof isCheckMaintenanceRunning !== 'undefined' && isCheckMaintenanceRunning)) {
            var targetedElement = event.target;
            if (targetedElement && (targetedElement.closest('.close') || targetedElement.closest('[data-dismiss="modal"]'))) {
                event.stopImmediatePropagation();
                event.preventDefault();
                console.log("[AM4 Bot Log] Close action intercepted during active automated maintenance task.");
            }
        }
    }, true);
}

//================================================================================
// Parts 5 & 6 of 13: Core Control Background Timers & Background Evaluators
//================================================================================
function autoDepartRoutine() {
    // Clear any existing timers first to prevent multiple stacked threads
    clearTimeout(autoDepartTimeoutID);

    var cb = document.getElementById("autoDepartCheckbox");
    if (cb && cb.checked) {
        console.log("[AM4 Bot Log] Initializing background departure sequence evaluation...");
        executeDepartAllAction();
    }

    // Unconditionally reschedule the loop for 15 minutes, ensuring it repeats forever
    autoDepartTimeoutID = setTimeout(autoDepartRoutine, 15 * 60 * 1000);
}

function executeDepartAllAction() {
    var span = document.getElementById("listDepartAmount");
    if (!span) {
        console.log("[AM4 Bot Log] Departure scan bypass: #listDepartAmount node missing from dashboard.");
        return;
    }

    var planesReady = parseInt(span.innerText.replace(/[^0-9]/g, ""), 10) || 0;

    if (planesReady > 0) {
        console.log("[AM4 Bot Log] Dispatching flight paths for " + planesReady + " ready aircraft frames.");

        // 1. Refresh marketing agreements silently via background channels
        var x = new XMLHttpRequest();
        x.open("GET", "marketing_new.php?type=" + marketingType + "&mode=do&c=" + marketingDuration, true);
        x.send();

        // 2. Click the physical departure anchor element node after a layout settlement window
        setTimeout(function () {
            if (span.parentElement) {
                // Release active focus layers right before dispatching the click event
                if (document.activeElement && document.activeElement.blur) document.activeElement.blur();

                span.parentElement.click();

                // FIXED: Clear any lingering grey overlays or modals left behind by the native click trigger
                setTimeout(function() {
                    if (typeof window.originalClosePop === 'function') window.originalClosePop();
                    if (typeof jQuery !== 'undefined') jQuery('.modal-backdrop').remove();
                    if (document.body && document.body.focus) document.body.focus();
                }, 1000);
            }
        }, 1200);
    } else {
        console.log("[AM4 Bot Log] Departure scan complete: 0 aircraft frames at gates. Thread resting.");
    }
}

function run24hMarketingRoutine() {
    var cb = document.getElementById("autoMarketingCheckbox");
    if (!cb || !cb.checked) return;

    var x = new XMLHttpRequest();
    x.onreadystatechange = function () {
        if (x.readyState === 4 && x.status === 200 && (x.responseText.includes('marketing_new.php') || x.responseText.includes('Campaign'))) {
            call('marketing_new.php?type=1&mode=do&c=3'); //Eco Campaign
            call('marketing_new.php?type=2&mode=do&c=3'); //Pax Campaign
            call('marketing_new.php?type=3&mode=do&c=3'); //Cargo Campaign
            call('marketing_new.php?type=10&mode=do&c=3'); //Charter Campaign
        }
    };
    x.open("GET", "marketing.php", true);
    x.send();

    clearTimeout(autoMarketingTimeoutID);
    autoMarketingTimeoutID = setTimeout(run24hMarketingRoutine, 12 * 60 * 60 * 1000);
}

function autoRepairCheckLoop() {
    if (checkAccountBalanceToastSafety() || isBotPausedDueToFunds) return;
    var cb = document.getElementById("autoRepairCheckbox");
    if (!cb || !cb.checked) return;

    var popupEl = document.getElementById('popup');
    if (isMaintenanceRunning || (popupEl && popupEl.style.display === 'block')) {
        clearTimeout(autoRepairTimeoutID);
        autoRepairTimeoutID = setTimeout(autoRepairCheckLoop, 5000);
        return;
    }

    console.log("[AM4 Bot Log] Triggering visual Auto-Repair sequence evaluation...");
    isMaintenanceRunning = true;
    if (typeof runStandaloneRepairSequence === 'function') {
        runStandaloneRepairSequence();
    } else {
        isMaintenanceRunning = false;
    }
}

function autoCheckCheckLoop() {
    if (checkAccountBalanceToastSafety() || isBotPausedDueToFunds) return;
    var cb = document.getElementById("autoCheckCheckbox");
    if (!cb || !cb.checked) return;

    var popupEl = document.getElementById('popup');
    if (isCheckMaintenanceRunning || (popupEl && popupEl.style.display === 'block')) {
        clearTimeout(autoCheckTimeoutID);
        autoCheckTimeoutID = setTimeout(autoCheckCheckLoop, 5000);
        return;
    }

    console.log("[AM4 Bot Log] Triggering visual Auto-Check sequence evaluation...");
    isCheckMaintenanceRunning = true;
    if (typeof runStandaloneCheckSequence === 'function') {
        runStandaloneCheckSequence();
    } else {
        isCheckMaintenanceRunning = false;
    }
}

//================================================================================
// Part 7 of 13: Interaction Macro Click Solvers
//================================================================================
function humanClick(el) {
    if (!el) return false;
    ["mousedown", "mouseup", "click"].forEach(function (t) {
        el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    });
    return true;
}

function openMaintenancePopup() {
    if (typeof jQuery !== 'undefined') {
        jQuery('.modal-backdrop').remove();
    }
    var btn = document.querySelector('[onclick*="maintenance.php"]') || document.querySelector('[onclick*="maintenance"]') || document.querySelector('.btn-maintenance');
    return btn ? humanClick(btn) : false;
}

function clickPlanTab() {
    var btn = document.getElementById("popBtn2") || document.querySelector('button[onclick*="maint_plan.php"]');
    return btn ? humanClick(btn) : false;
}

function clickBulkRepair() {
    var btn = document.querySelector('[onclick*="maint_plan_repair_bulk.php"]') || document.querySelector('[onclick*="maint_plan_repair_bulk"]');
    return btn ? humanClick(btn) : false;
}

function select20Percent() {
    var selects = document.querySelectorAll("select");
    for (var i = 0; i < selects.length; i++) {
        var opts = selects[i].options;
        for (var j = 0; j < opts.length; j++) {
            if (opts[j].text.includes("20")) {
                selects[i].selectedIndex = j;
                selects[i].dispatchEvent(new Event("change", { bubbles: true }));
                return true;
            }
        }
    }
    return false;
}

function clickPlanBulkRepair() {
    var buttons = document.querySelectorAll("button,input[type=button]");
    for (var i = 0; i < buttons.length; i++) {
        if ((buttons[i].innerText || buttons[i].value || "").toLowerCase().includes("plan bulk repair")) return humanClick(buttons[i]);
    }
    return false;
}

function clickBulkCheck() {
    var wrapper = document.getElementById("popup") || document.getElementById("maintAction") || document.body;
    var btn = wrapper.querySelector('[onclick*="maint_plan_check_bulk.php"]') || wrapper.querySelector('[onclick*="maint_plan_check_bulk"]');
    return btn ? humanClick(btn) : false;
}

function clickPlanesLowerThan250Hours() {
    var wrapper = document.getElementById("maintPlanAction");
    if (!wrapper) return 0;
    var hoursElements = wrapper.querySelectorAll("div.col-sm-6 b.text-success, div[data-id] b.text-success");
    var totalSelected = 0;
    hoursElements.forEach(function(el) {
        var hoursValue = parseInt(el.innerText.replace(/[^0-9]/g, ""), 10) || 999;
        if (hoursValue < 250) {
            var planeCard = el.closest(".col-sm-6") || el.closest("[data-id]");
            if (planeCard && !planeCard.classList.contains("selected")) {
                humanClick(planeCard);
                totalSelected++;
            }
        }
    });
    console.log("[AM4 Bot Log] Filter macro complete. Selected " + totalSelected + " aircraft variants with remaining hours under 250.");
    return totalSelected;
}

function clickPlanBulkCheck() {
    var btn = document.querySelector("#bulk-check-btn");
    if (btn) return humanClick(btn);
    var fallback = document.querySelector('button[onclick*="maint_plan_check_bulk.php"]') || document.querySelector('button[onclick*="mode=acheckAll"]');
    return fallback ? humanClick(fallback) : false;
}

//================================================================================
// Part 8 of 13: Repaired Macro Sequence Orchestrators (Focus Release Framework)
//================================================================================
function runStandaloneRepairSequence() {
    if (!openMaintenancePopup()) { isMaintenanceRunning = false; return; }

    setTimeout(function() {
        if (!clickPlanTab()) { finishVisualCloseAction(true); return; }

        setTimeout(function() {
            if (!clickBulkRepair()) { finishVisualCloseAction(true); return; }

            setTimeout(function() {
                select20Percent();

                setTimeout(function() {
                    var form = document.getElementById("maintAction") || document.body;
                    var submitBtn = form.querySelector('button[onclick*="maint_plan_repair_bulk.php?mode=do"]');

                    if (!submitBtn && !form.innerHTML.includes("mode=do")) {
                        console.log("[AM4 Bot Log] Repair scan complete: 0 planes meet wear limit. Displaying visually for 3 seconds.");
                        setTimeout(function() { finishVisualCloseAction(true); }, 3000);
                        return;
                    }

                    clickPlanBulkRepair();
                    setTimeout(function() { finishVisualCloseAction(true); }, 1500);

                }, 600);
            }, 800);
        }, 800);
    }, 2000);
}

function runStandaloneCheckSequence() {
    if (!openMaintenancePopup()) { isCheckMaintenanceRunning = false; return; }

    setTimeout(function() {
        if (!clickPlanTab()) { finishVisualCloseAction(false); return; }

        setTimeout(function() {
            if (!clickBulkCheck()) { finishVisualCloseAction(false); return; }

            setTimeout(function() {
                var planesSelected = clickPlanesLowerThan250Hours();

                if (planesSelected === 0) {
                    console.log("[AM4 Bot Log] Check scan complete: 0 planes under 250 hours. Displaying visually for 3 seconds.");
                    setTimeout(function() { finishVisualCloseAction(false); }, 3000);
                    return;
                }

                clickPlanBulkCheck();
                setTimeout(function() { finishVisualCloseAction(false); }, 1500);

            }, 1000);
        }, 1200);
    }, 2000);
}

function finishVisualCloseAction(isRepairModule) {
    // FIXED: Release browser focus away from the popup back to the main document body
    // This allows the browser to legally update aria-hidden properties without blocking visual renders
    if (document.activeElement && document.activeElement.blur) {
        document.activeElement.blur();
    }
    if (document.body && document.body.focus) {
        document.body.focus();
    }

    if (typeof window.originalClosePop === 'function') {
        window.originalClosePop();
    } else if (typeof closePop === 'function') {
        window.originalClosePop = window.closePop;
        window.originalClosePop();
    }

    if (typeof jQuery !== 'undefined') {
        jQuery('.modal-backdrop').remove();
    } else {
        document.querySelectorAll('.modal-backdrop').forEach(function(el) { el.remove(); });
    }

    var lbl = document.getElementById('maintenanceStatusLabel');
    if (lbl) { lbl.innerText = 'Fleet Healthy'; lbl.style.color = '#5cb85c'; }

    if (isRepairModule) {
        isMaintenanceRunning = false;
        clearTimeout(autoRepairTimeoutID);
        autoRepairTimeoutID = setTimeout(autoRepairCheckLoop, 8 * 60 * 60 * 1000);
        console.log("[AM4 Bot Log] Auto-Repair sequence shut down cleanly. Thread cleared.");
    } else {
        isCheckMaintenanceRunning = false;
        clearTimeout(autoCheckTimeoutID);
        autoCheckTimeoutID = setTimeout(autoCheckCheckLoop, 8 * 60 * 60 * 1000);
        console.log("[AM4 Bot Log] Auto-Check sequence shut down cleanly. Thread cleared.");
    }
}

//Part 9 of 13: Custom Multiplier Pricing Interceptor
document.addEventListener('click', function (e) {
    var btn = e.target.closest('#introAuto') || e.target.closest('[onclick*="autoPrice"]') || (e.target.tagName === 'BUTTON' && e.target.innerText.toLowerCase().includes('autoprice'));
    if (!btn) return;
    var originalOnclick = btn.getAttribute('onclick');
    if (!originalOnclick || !originalOnclick.includes('autoPrice')) return;
    var matchPatterns = originalOnclick.match(/autoPrice\s*\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)/) || originalOnclick.match(/autoPrice\s*\(\s*([0-9.]+)\s*,\s*([0-9.]+)/);
    var explicitBaseY = matchPatterns ? parseFloat(matchPatterns[1]) : 0;
    var explicitBaseJ = matchPatterns ? parseFloat(matchPatterns[2]) : 0;
    var explicitBaseF = (matchPatterns && matchPatterns[3]) ? parseFloat(matchPatterns[3]) : 0;
    setTimeout(function() {
        var isCargoRoute = document.getElementById('price_l') || document.getElementById('price_h');
        var truncateToTwoDecimals = function(num) { return Math.floor(num * 100) / 100; };
        if (isCargoRoute) {
            var targetL = document.getElementById('price_l');
            var targetH = document.getElementById('price_h');
            var baseLarge = explicitBaseY || parseFloat(targetL ? targetL.value : 0) || 0;
            var baseHeavy = explicitBaseJ || parseFloat(targetH ? targetH.value : 0) || 0;
            if (baseLarge > 0 && baseHeavy > 0) {
                var calcLarge = truncateToTwoDecimals(baseLarge * 1.10);
                var calcHeavy = truncateToTwoDecimals(baseHeavy * 1.08);
                if (targetL) { targetL.value = calcLarge.toFixed(2); targetL.dispatchEvent(new Event('input', { bubbles: true })); }
                if (targetH) { targetH.value = calcHeavy.toFixed(2); targetH.dispatchEvent(new Event('input', { bubbles: true })); }
                if (typeof autoPrice === 'function') { autoPrice(calcLarge, calcHeavy, baseLarge, baseHeavy); }
            }
        } else {
            var targetY = document.getElementById('eSeat') || document.getElementById('price_y');
            var targetJ = document.getElementById('bSeat') || document.getElementById('price_j');
            var targetF = document.getElementById('fSeat') || document.getElementById('price_f');
            var baseY = explicitBaseY || parseFloat(targetY ? targetY.value : 0) || 0;
            var baseJ = explicitBaseJ || parseFloat(targetJ ? targetJ.value : 0) || 0;
            var baseF = explicitBaseF || parseFloat(targetF ? targetF.value : 0) || 0;
            if (!explicitBaseY && baseY > 0) { baseY = baseY / 1.10; baseJ = baseJ / 1.08; baseF = baseF / 1.06; }
            if (baseY > 0 && baseJ > 0 && baseF > 0) {
                var calcY = Math.floor(baseY * 1.10);
                var calcJ = Math.floor(baseJ * 1.08);
                var calcF = Math.floor(baseF * 1.06);
                if (targetY) { targetY.value = calcY.toString(); targetY.dispatchEvent(new Event('input', { bubbles: true })); }
                if (targetJ) { targetJ.value = calcJ.toString(); targetJ.dispatchEvent(new Event('input', { bubbles: true })); }
                if (targetF) { targetF.value = calcF.toString(); targetF.dispatchEvent(new Event('input', { bubbles: true })); }
                if (typeof autoPrice === 'function') { autoPrice(calcY, calcJ, calcF, Math.floor(baseY), 0); }
            }
        }
    }, 1000);
}, false);

document.addEventListener('click', function(e) {
    var isConfigPage = document.getElementById('eSeat') || document.querySelector('.seatPricing');
    if (!isConfigPage) return;

    setTimeout(function() {
        var demandY = 0, demandJ = 0, demandF = 0;
        document.querySelectorAll('td, span, div.row').forEach(function(n) {
            var txt = n.innerText || "";
            if (txt.includes('Y class')) { demandY = parseInt(txt.replace(/[^0-9]/g, ''), 10) || 0; }
            if (txt.includes('J class')) { demandJ = parseInt(txt.replace(/[^0-9]/g, ''), 10) || 0; }
            if (txt.includes('F class')) { demandF = parseInt(txt.replace(/[^0-9]/g, ''), 10) || 0; }
        });

        var totalDemand = demandY + demandJ + demandF;
        if (totalDemand === 0) return;

        var inputY = document.getElementById('eSeat');
        var inputJ = document.getElementById('bSeat');
        var inputF = document.getElementById('fSeat');
        var maxSeatsVal = document.getElementById('totalSeatsVal');
        var maxSeatsFallback = document.querySelector('.max-seats');

        var rawSeatsText = "0";
        if (maxSeatsVal) { rawSeatsText = maxSeatsVal.innerText; } else if (maxSeatsFallback) { rawSeatsText = maxSeatsFallback.innerText; }

        var maxSeats = parseInt(rawSeatsText.replace(/[^0-9]/g, ''), 10) || 0;
        if (!maxSeats || !inputY) return;

        var assignY = Math.floor(maxSeats * (demandY / totalDemand));
        var assignJ = Math.floor(maxSeats * (demandJ / totalDemand));
        var assignF = maxSeats - (assignY + assignJ);

        if (inputY) { inputY.value = assignY; inputY.dispatchEvent(new Event('input', { bubbles: true })); }
        if (inputJ) { inputJ.value = assignJ; inputJ.dispatchEvent(new Event('input', { bubbles: true })); }
        if (inputF) { inputF.value = assignF; inputF.dispatchEvent(new Event('input', { bubbles: true })); }
        console.log("[AM4 Bot Log] Configuration Balanced -> Eco: " + assignY + " | Biz: " + assignJ + " | First: " + assignF);
    }, 1200);
}, false);
// PART 10 OF 13: SANDBOXED DOM-TREE BACKGROUND BUYER (ZERO GRAPHICAL LOADING)
function scanConsumable() {
    var cb = document.getElementById("autoBuyerCheckbox");
    if (!cb || !cb.checked) {
        // TIMING UPDATE: Modified backup tracking check loop interval to strictly match 15 minutes
        autoBuyerTimeoutID = setTimeout(scanConsumable, 15 * 60 * 1000);
        return;
    }
    console.log("[AM4 Bot Log] Initiating clean sandboxed background market scan check...");
    var xhrFuel = new XMLHttpRequest();
    xhrFuel.onreadystatechange = function () {
        if (xhrFuel.readyState === 4 && xhrFuel.status === 200) {
            try {
                var sandboxFuel = document.createElement('div');
                sandboxFuel.innerHTML = xhrFuel.responseText;
                var element = sandboxFuel.querySelector('#fuelMain');
                if (element) {
                    var price = element.children[0].children[0].children[2].children[0].innerText;
                    var intPrice = parseInt(price.replace(/[^0-9]/g, ""), 10);
                    console.log(`[AM4 Bot Log] Background Fuel Match -> Found: $${intPrice} | Limit: $${fuelPriceThreshold}`);
                    if (intPrice <= fuelPriceThreshold) {
                        var capacity = element.children[0].children[2].children[2].innerText;
                        var intCapacity = parseInt(capacity.replace(/[^0-9]/g, ""), 10);
                        var intBankBalance = getBankBalance();
                        var intBuyable = Math.floor(intBankBalance / intPrice * 1000);
                        var intBuy = Math.min(intBuyable, intCapacity);
                        if (intBuy > 0) {
                            console.log("[AM4 Bot Log] Success: Target met! Buying Fuel background -> " + intBuy);
                            buyFuel(intBuy);
                        }
                    }
                }
            } catch(err) { console.log("Fuel background sandbox delayed: " + err.message); }
        }
    };
    xhrFuel.open("GET", "fuel.php?_=" + Date.now(), true);
    xhrFuel.send();
    setTimeout(function() {
        var xhrCo2 = new XMLHttpRequest();
        xhrCo2.onreadystatechange = function () {
            if (xhrCo2.readyState === 4 && xhrCo2.status === 200) {
                try {
                    var sandboxCo2 = document.createElement('div');
                    sandboxCo2.innerHTML = xhrCo2.responseText;
                    var element = sandboxCo2.querySelector('#co2Main');
                    if (element) {
                        var price = element.children[0].children[1].children[2].children[0].innerText;
                        var intPrice = parseInt(price.replace(/[^0-9]/g, ""), 10);
                        console.log(`[AM4 Bot Log] Background CO2 Match -> Found: $${intPrice} | Limit: $${co2PriceThreshold}`);
                        if (intPrice <= co2PriceThreshold) {
                            var capacity = element.children[0].children[3].children[2].innerText;
                            var intCapacity = parseInt(capacity.replace(/[^0-9]/g, ""), 10);
                            var intBankBalance = getBankBalance();
                            var intBuyable = Math.floor(intBankBalance / intPrice * 1000);
                            var intBuy = Math.min(intBuyable, intCapacity);
                            if (intBuy > 0) {
                                console.log("[AM4 Bot Log] Success: Target met! Buying CO2 background -> " + intBuy);
                                buyCO2(intBuy);
                            }
                        }
                    }
                } catch(err) { console.log("CO2 background sandbox delayed: " + err.message); }
            }
        };
        xhrCo2.open("GET", "co2.php?_=" + Date.now(), true);
        xhrCo2.send();
    }, 3000);
    setTimeout(function () {
        if (typeof closePop === 'function') closePop();
        console.log("[AM4 Bot Log] Consumable scan loop complete.");
    }, 5000);
    // TIMING UPDATE: Hard-locked core execution engine sequence strictly to match 15 minutes
    autoBuyerTimeoutID = setTimeout(scanConsumable, 15 * 60 * 1000);
}
// PART 11 OF 13: ROUTE CREATION VIEW DYNAMIC PRICE OVERRIDER
const creationPricingObserver = new MutationObserver(() => {
    const priceY = document.getElementById('eSeat') || document.getElementById('price_y');
    const priceJ = document.getElementById('bSeat') || document.getElementById('price_j');
    const priceF = document.getElementById('fSeat') || document.getElementById('price_f');
    if (priceY && priceJ && priceF) {
        var rawY = parseFloat(priceY.value) || 0;
        var rawJ = parseFloat(priceJ.value) || 0;
        var rawF = parseFloat(priceF.value) || 0;
        if (rawY === 0 || priceY.classList.contains('price-multiplier-done')) {
            return;
        }
        if (priceY.getAttribute('data-base-checked') !== 'true') {
            priceY.setAttribute('data-base-checked', 'true');
            if (rawY > 1000) {
                rawY = rawY / 1.10;
                rawJ = rawJ / 1.08;
                rawF = rawF / 1.06;
            }
        }
        priceY.classList.add('price-multiplier-done');
        console.log(`[AM4 Bot Log] Base ticket costs captured -> Eco: ${Math.floor(rawY)} | Biz: ${Math.floor(rawJ)} | First: ${Math.floor(rawF)}`);
        var finalPriceY = Math.floor(rawY * 1.10);
        var finalPriceJ = Math.floor(rawJ * 1.08);
        var finalPriceF = Math.floor(rawF * 1.06);
        priceY.value = finalPriceY.toString();
        priceJ.value = finalPriceJ.toString();
        priceF.value = finalPriceF.toString();
        priceY.dispatchEvent(new Event('input', { bubbles: true }));
        priceJ.dispatchEvent(new Event('input', { bubbles: true }));
        priceF.dispatchEvent(new Event('input', { bubbles: true }));
        console.log(`[AM4 Bot Log] Modified pricing applied -> Eco: $${finalPriceY} | Biz: $${finalPriceJ} | First: $${finalPriceF}`);
    }
});

function routeDistanceWatcher() {
    document.querySelectorAll('#routeInfo, .route-details, #newRouteInfo, td, span').forEach(function (el) {
        if (el.innerText && el.innerText.includes('km') && !el.classList.contains('distance-scanned')) {
            el.classList.add('distance-scanned');
            var dist = parseFloat(el.innerText.replace(/[^0-9.]/g, '')) || 0;
            if (dist > 0 && dist < 50000) {
                var rng = dist < 3000 ? 'Short Haul' : (dist < 7000 ? 'Medium Haul' : 'Long Haul');
                console.log("[AM4 Bot Log] Route Distance: " + dist + " km (" + rng + ")");
            }
        }
    });
    setTimeout(routeDistanceWatcher, 1500);
}

function cargoDemandWatcher() {
    if (document.body.innerText.includes('Heavy load') || document.body.innerText.includes('Large load')) {
        var heavy = 0, large = 0;
        document.querySelectorAll('td, span, div.row').forEach(function (node) {
            if (node.innerText && !node.classList.contains('cargo-scanned')) {
                if (node.innerText.includes('Heavy load')) {
                    node.classList.add('cargo-scanned');
                    heavy = parseInt(node.innerText.replace(/[^0-9]/g, ''), 10) || 0;
                }
                if (node.innerText.includes('Large load')) {
                    node.classList.add('cargo-scanned');
                    large = parseInt(node.innerText.replace(/[^0-9]/g, ''), 10) || 0;
                }
            }
        });
    }
    setTimeout(cargoDemandWatcher, 2000);
}

function paxDemandWatcher() {
    if (document.body.innerText.includes('Y class') || document.body.innerText.includes('J class') || document.body.innerText.includes('F class')) {
        var yClass = 0, jClass = 0, fClass = 0;
        document.querySelectorAll('td, span, div.row').forEach(function (node) {
            if (node.innerText && !node.classList.contains('pax-scanned')) {
                if (node.innerText.includes('Y class')) {
                    node.classList.add('pax-scanned');
                    yClass = parseInt(node.innerText.replace(/[^0-9]/g, ''), 10) || 0;
                }
                if (node.innerText.includes('J class')) {
                    node.classList.add('pax-scanned');
                    jClass = parseInt(node.innerText.replace(/[^0-9]/g, ''), 10) || 0;
                }
                if (node.innerText.includes('F class')) {
                    node.classList.add('pax-scanned');
                    fClass = parseInt(node.innerText.replace(/[^0-9]/g, ''), 10) || 0;
                }
            }
        });
    }
    setTimeout(paxDemandWatcher, 2000);
}

function scanMarketplaceForBestHubs() {
    var popupBox = document.getElementById('popup');
    var popupHTML = popupBox ? popupBox.innerHTML : "";
    if (!popupHTML.includes('hubs_new.php') && !popupHTML.includes('select')) {
        document.body.classList.remove('market-shortlist-logged');
        setTimeout(scanMarketplaceForBestHubs, 2500);
        return;
    }
    if (document.body.classList.contains('market-shortlist-logged')) {
        runVisualHubHighlighter();
        setTimeout(scanMarketplaceForBestHubs, 2500);
        return;
    }
    document.body.classList.add('market-shortlist-logged');
    console.log("[AM4 Bot Log] Hub Marketplace active. Initializing dynamic dropdown tracking modules...");
    var countrySelect = document.querySelector("#popup select");
    if (countrySelect && !countrySelect.classList.contains("bot-listener-bound")) {
        countrySelect.classList.add("bot-listener-bound");
        countrySelect.addEventListener("change", function() {
            setTimeout(runVisualHubHighlighter, 400);
        });
    }
    runVisualHubHighlighter();
    setTimeout(scanMarketplaceForBestHubs, 2500);
}

function runVisualHubHighlighter() {
    // 1. ELITE COUNTRIES: Used ONLY to highlight the first country dropdown menu safely
    var eliteCountries = [
        "South Korea", "Singapore", "Hong Kong", "India", "UAE", "Bahrain",
        "Australia", "Fiji",
        "United Kingdom", "United Kingdom (Heathrow)", "Netherlands", "Germany", "France",
        "United States", "Brazil", "Chile", "Venezuela", "Argentina",
        "Tunisia", "Angola", "Senegal"
    ];

    // 2. ELITE AIRPORTS: Extracted exactly from the ultimate continental guide list
    var highYieldAirports = [
        // Asia
        "Seoul Incheon",
        "Singapore Changi",
        "Hong Kong",
        "New Delhi",
        "Dubai International",
        "Manama",

        // Australia & Oceania
        "Sydney intl",
        "Canberra",
        "Nadi",

        // Europe
        "London Heathrow",
        "Amsterdam",
        "Frankfurt intl",
        "Paris Charles de Gaulle",

        // North America
       "New York John F. Kennedy",
        "Dallas Fort-Worth",
        "Chicago O'Hare",
        "Los Angeles",

        // South America
        "Sao Paolo Guarulhos",
        "Santiago de Chile",
        "Caracas",
        "Buenos Aires int",

        // Africa
        "Tunis",
        "Luanda",
        "Dakar L.S. Senghor"
    ];

    var generalElements = document.querySelectorAll("#popup option, #popup tr, .modal-body td");
    generalElements.forEach(function(el) {
        var text = (el.innerText || el.textContent || "").trim();
        var shouldPaint = eliteCountries.includes(text) || highYieldAirports.includes(text);

        if (el.tagName.toLowerCase() === 'td' || el.tagName.toLowerCase() === 'tr') {
            if (eliteCountries.includes(text) && !highYieldAirports.includes(text)) {
                shouldPaint = false;
            }
        }

        if (shouldPaint && !el.classList.contains("bot-premium-hub-painted")) {
            el.classList.add("bot-premium-hub-painted");
            el.style.backgroundColor = "rgba(92, 184, 92, 0.35)";
            el.style.border = "2px solid #5cb85c";
            el.style.color = "#1b5e20";
            el.style.fontWeight = "bold";
        }
    });

    var airportSelector = document.getElementById("hubAirportSelector") || document.querySelector("#hubCityContainer select");
    if (airportSelector) {
        var options = airportSelector.querySelectorAll("option");
        options.forEach(function(opt) {
            var optText = opt.innerText || opt.textContent || "";
            highYieldAirports.forEach(function(target) {
                if (optText.includes(target) && !opt.classList.contains("bot-premium-airport-tagged")) {
                    opt.classList.add("bot-premium-airport-tagged");
                    opt.innerText = "⭐ [BEST HUB] " + optText.toUpperCase();
                    opt.style.backgroundColor = "#5cb85c";
                    opt.style.color = "#ffffff";
                    opt.style.fontWeight = "bold";
                    console.log("[AM4 Bot Log] Successfully tagged premium airport option inside dropdown: " + target);
                }
            });
        });
    }
}

// PART 12 OF 13: LIVE FINANCIAL OVERLAY INTERFACE CARRIER
function buildFinancialOverlay() {
    if (document.getElementById('am4FinancialMetricsDashboard')) return;
    var container = document.createElement('div');
    container.id = 'am4FinancialMetricsDashboard';
    container.style.position = 'fixed';
    container.style.bottom = '20px';
    container.style.left = '20px';
    container.style.width = '260px';
    container.style.background = 'rgba(20,24,30,0.92)';
    container.style.border = '1px solid #34495e';
    container.style.borderRadius = '6px';
    container.style.color = '#fff';
    container.style.fontFamily = 'monospace';
    container.style.fontSize = '11px';
    container.style.zIndex = '999999';
    container.style.padding = '10px';
    container.style.boxShadow = '0 4px 15px rgba(0,0,0,0.5)';
    container.style.pointerEvents = 'auto';
    container.innerHTML = [
        '<div style="font-weight:bold; border-bottom:1px solid #475569; padding-bottom:4px; margin-bottom:6px; color:#38bdf8; display:flex;">',
        '<span style="flex-grow:1;">AM4 FINANCIAL METRICS</span>',
        '<span style="cursor:pointer; color:#ef4444; font-weight:bold; padding:0 4px;" id="closeOverlayBtn">[X]</span>',
        '</div>',
        '<table style="width:100%; border-collapse:collapse;">',
        '<tr><td style="color:#aaa; padding:2px 0;">Est. Fleet ROI:</td><td id="metricOverlayROI" style="text-align:right; font-weight:bold; color:#10b981;">---</td></tr>',
        '<tr><td style="color:#aaa; padding:2px 0;">Net Flow/Min:</td><td id="metricOverlayFlow" style="text-align:right; font-weight:bold; color:#38bdf8;">---</td></tr>',
        '<tr><td style="color:#aaa; padding:2px 0;">Avg Fuel Spend:</td><td id="metricOverlayFuelSpend" style="text-align:right; color:#f59e0b;">---</td></tr>',
        '<tr><td style="color:#aaa; padding:2px 0;">Avg CO2 Spend:</td><td id="metricOverlayCo2Spend" style="text-align:right; color:#f59e0b;">---</td></tr>',
        '</table>',
        '<div style="font-size:9px; color:#64748b; margin-top:6px; border-top:1px dashed #334155; padding-top:4px; text-align:center;">Tracking network metrics real-time...</div>'
    ].join('');
    document.body.appendChild(container);
    var closeBtn = document.getElementById('closeOverlayBtn');
    if (closeBtn) {
        closeBtn.addEventListener('click', function() {
            container.style.display = 'none';
        });
    }
}
// PART 13 OF 13: FINANCIAL ROLLING SCRAPER MASTER CALCULATIONS
setInterval(function() {
    var overlayBox = document.getElementById('am4FinancialMetricsDashboard');
    if (!overlayBox || overlayBox.style.display === 'none') return;
    var headerElement = document.getElementById('headerAccount');
    if (!headerElement) return;
    var currentCash = parseInt(headerElement.innerText.replace(/[^0-9]/g, ''), 10) || 0;
    if (lastMonitoredBalance === 0) {
        lastMonitoredBalance = currentCash;
        return;
    }
    var netDifference = currentCash - lastMonitoredBalance;
    lastMonitoredBalance = currentCash;
    if (Math.abs(netDifference) < 15000000) {
        netRevenueIntervalTicks.push(netDifference);
        if (netRevenueIntervalTicks.length > 30) {
            netRevenueIntervalTicks.shift();
        }
    }
    var combinedSum = 0;
    netRevenueIntervalTicks.forEach(function(val) {
        combinedSum += val;
    });
    var flowPerMin = netRevenueIntervalTicks.length > 0 ? Math.floor((combinedSum / netRevenueIntervalTicks.length) * 6) : 0;
    var displayRoi = "Infinite";
    if (flowPerMin > 0) {
        var approxCost = 45000000;
        var daysToPayback = ((approxCost / flowPerMin) / 60 / 24);
        displayRoi = daysToPayback.toFixed(1) + " Days";
    }
    var fField = document.getElementById('metricOverlayFlow');
    var rField = document.getElementById('metricOverlayROI');
    var fuelField = document.getElementById('metricOverlayFuelSpend');
    var co2Field = document.getElementById('metricOverlayCo2Spend');
    if (fField) {
        fField.innerText = (flowPerMin >= 0 ? "+" : "") + flowPerMin.toLocaleString() + " /m";
        fField.style.color = flowPerMin >= 0 ? '#10b981' : '#ef4444';
    }
    if (rField) {
        rField.innerText = displayRoi;
    }
    if (fuelField) {
        var baseFuel = typeof fuelPriceThreshold !== 'undefined' ? fuelPriceThreshold : 1000;
        fuelField.innerText = "$" + Math.floor(baseFuel * 0.12).toLocaleString();
    }
    if (co2Field) {
        var baseCo2 = typeof co2PriceThreshold !== 'undefined' ? co2PriceThreshold : 200;
        co2Field.innerText = "$" + Math.floor(baseCo2 * 0.18).toLocaleString();
    }
}, 10000);

// MASTER CORE LAUNCHPAD SEQUENCE
(function() {
    'use strict';
    if (!window.location.href.includes('airlinemanager.com')) return;
    if (typeof window.L !== 'undefined') {
        const origRemove = window.L.LayerGroup ? window.L.LayerGroup.prototype.removeLayer : null;
        if (origRemove) {
            window.L.LayerGroup.prototype.removeLayer = function(l) { return l ? origRemove.call(this, l) : this; };
        }
    }
    setTimeout(injectToggleControls, 2000);
    setTimeout(routeDistanceWatcher, 4000);
    setTimeout(cargoDemandWatcher, 4500);
    setTimeout(paxDemandWatcher, 4800);
    setTimeout(scanMarketplaceForBestHubs, 5000);
    setTimeout(autoRepairCheckLoop, 5200);
    setTimeout(autoCheckCheckLoop, 5500);
    setTimeout(setupClosePopProtection, 5800);
    setTimeout(buildFinancialOverlay, 6200);
    creationPricingObserver.observe(document.body, { childList: true, subtree: true });
    console.log("[AM4 Bot Log] Master layout lifecycle extension successfully initialized.");
})();
