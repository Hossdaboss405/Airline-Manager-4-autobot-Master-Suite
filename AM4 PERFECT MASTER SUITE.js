// ==UserScript==
// @name AM4 MASTER SUITE MADE BY HOSS
// @namespace http://tampermonkey.net/
// @version 2.26
// @description AM4 automation suite: auto depart (departs the whole queue), buy/marketing/repair/check, price multipliers, best-hub highlighter, Research Explorer (ranks hubs by good routes for the selected aircraft type), one-click Auto-Build pipeline (order named+configured → modify CO2/speed/fuel → route, from the Explorer, fail-closed queue), Fleet Assistant (fleet state + manual capped buyer for any aircraft type + manual route builder), separate 🔧 Modify panel (seats + speed/fuel/CO2 upgrades, parked & routed aircraft), quiet hours (idle overnight), real 24h net income in the overlay, status dashboard with a persisted action log (departed/bought/built…), hard spend guards (never-spend-points + daily/per-cycle caps), settings panel (⚙) with per-campaign marketing, all suite windows draggable + collapsible (Explorer/Fleet/Modify/Build/Status/Settings/Financial, positions remembered), collapsible overlay and randomized timing
// @author HOSS
// @match *://airlinemanager.com/*
// @match *://*.airlinemanager.com/*
// @run-at document-idle
// @noframes
// @icon https://www.google.com/s2/favicons?sz=64&domain=airlinemanager.com
// @grant none
// ==/UserScript==

/* eslint-env browser */
/* global jQuery, autoPrice, closePop, airportIconData, statusData, routeMarkers, fbSig, L, Ajax, getBankBalance, intro, Android, isBotPausedDueToFunds */
/* eslint-disable no-console, no-empty, no-var, no-unused-vars, eqeqeq, camelcase, max-len, max-lines, complexity, no-implied-eval, no-alert, no-new-func, prefer-const */

//================================================================================
// Whole-script scope: all suite state and helpers live inside this IIFE instead
// of polluting window. Only window.closePop, window.originalClosePop and
// window.Android are intentionally global (the game calls/expects them).
//================================================================================
(function() {
'use strict';

var AM4_SUITE_VERSION = '2.26';

var am4NativeConsoleLog = (typeof console !== 'undefined' && console.log)
    ? console.log.bind(console) : function () {};
var am4NativeConsoleWarn = (typeof console !== 'undefined' && console.warn)
    ? console.warn.bind(console) : am4NativeConsoleLog;
var am4NativeConsoleError = (typeof console !== 'undefined' && console.error)
    ? console.error.bind(console) : am4NativeConsoleLog;
var am4LogBuffer = [];

function am4CaptureBotLog(args) {
    try {
        var a0 = args && args[0];
        if (typeof a0 !== 'string') return;
        if (a0.indexOf('[AM4 Bot Log]') !== 0) return;
        if (a0.indexOf('▸') !== -1) return;
        var rest = Array.prototype.map.call(args, function (x) { return String(x); }).join(' ');
        rest = rest.replace(/^\[AM4 Bot Log\]\s*/,'');
        if (typeof am4PushAction === 'function' && typeof am4ActionLog !== 'undefined' && Array.isArray(am4ActionLog)) {
            am4PushAction('log', rest);
        } else {
            am4LogBuffer.push(rest);
        }
    } catch (e) { /* ignore */ }
}

if (typeof console !== 'undefined' && !console.log.__am4Wrapped) {
    console.log = function () {
        am4NativeConsoleLog.apply(console, arguments);
        am4CaptureBotLog(arguments);
    };
    console.log.__am4Wrapped = true;
    console.warn = function () {
        am4NativeConsoleWarn.apply(console, arguments);
        am4CaptureBotLog(arguments);
    };
    console.error = function () {
        am4NativeConsoleError.apply(console, arguments);
        am4CaptureBotLog(arguments);
    };
}

//================================================================================
// Single-instance guard.
//
// A second copy of this script on the same page (userscript AND console snippet,
// a manual re-run, or an SPA re-injection) does not just duplicate the UI - it
// duplicates every timer. Two buyer loops buy fuel twice, two campaign cycles buy
// each campaign twice, two depart chains click over each other. Nothing below this
// line may run more than once per page.
//================================================================================
if (window.__am4SuiteInstance) {
    console.log('[AM4 Bot Log] AM4 Suite ' + window.__am4SuiteInstance +
        ' is already running on this page - this second copy is NOT starting. ' +
        'Two copies would run every timer twice and buy everything twice.');
    return;
}
window.__am4SuiteInstance = AM4_SUITE_VERSION;
console.log('[AM4 Bot Log] AM4 Suite v' + AM4_SUITE_VERSION + ' starting.');

//================================================================================
// Part 0 of 13: Central Config Store (persisted in localStorage, editable via ⚙)
//================================================================================
var AM4_CONFIG_KEY = 'am4MasterSuiteConfig';
var AM4_TOGGLE_KEY = 'am4MasterSuiteToggles';
var AM4_LEASE_KEY = 'am4MasterSuiteLease';

var AM4_DEFAULT_CONFIG = {
    fuelPriceThreshold: 1000,
    co2PriceThreshold: 200,
    // Money the buyer must leave untouched. Fuel and CO2 otherwise size their orders
    // as "spend almost everything", which leaves nothing for maintenance or campaigns.
    cashReserve: 0,
    wearPercent: 20,
    checkHours: 250,
    paxMultiEco: 1.10,
    paxMultiBiz: 1.08,
    paxMultiFirst: 1.06,
    cargoMultiLarge: 1.10,
    cargoMultiHeavy: 1.08,
    departIntervalMin: 15,
    buyerIntervalMin: 15,
    maintIntervalHrs: 8,
    // Quiet hours (Phase A1): during this local-time window EVERY scheduler skips its
    // action and reschedules instead, so zero requests go out and the account is
    // genuinely idle overnight - the safest form of"be offline" and it cuts the
    // biggest ban signal (24/7 activity). quietFrom/quietTo are local hours (0-23);
    // a window may wrap midnight (e.g. from 23 to 6). from == to means"disabled" .
    quietHoursEnabled: false,
    quietFrom: 1,
    quietTo: 8,
    // How often to look whether a campaign has run out. Only used while the bot does
    // not already know when the campaign ends - after it buys one itself it simply
    // sleeps for that campaign's duration and checks again right after it expires.
    campaignCheckMin: 10,
    // Hard spend guards (Phase A5) - fail-closed caps that sit ON TOP of the per-item
    // thresholds. neverSpendPoints is a master switch: nothing may auto-spend POINTS
    // (they are bought with real money), so Brand Marketing is blocked even if ticked,
    // until this is turned off. The two $ caps are 0 = disabled. maxCampaignSpendPerDay
    // limits cash campaign spend over a rolling 24 h; maxSpendPerCycle caps the fuel+CO2
    // buyer per scan cycle regardless of the price thresholds.
    neverSpendPoints: true,
    maxCampaignSpendPerDay: 0,
    maxSpendPerCycle: 0,
    // Fleet Assistant buyer (Phase B). The buyer is MANUAL (a button + confirm), never an
    // auto-loop. These are the fail-closed caps on a single order: how many aircraft at once,
    // and a total-$ ceiling (0 = off) that blocks an order costing more than this.
    fleetBuyerMaxPerBuy: 10,
    fleetBuyerSpendCap: 0,
    restoreToggles: false,
    // Financial overlay placement / state
    overlayEnabled: true,
    overlayPosition: 'left',
    overlayCollapsed: false,
    // Alliance contribution readout in the overlay. Leave the id blank to auto-detect
    // your own row (the highlighted one) from the alliance member table. The metrics
    // are refreshed by a light background read of alliance.php every few minutes.
    allianceMemberId: '',
    allianceRefreshMin: 10,
    // How often to read the game's own 24h accounting (transactions.php?mode=summary)
    // for the honest Income/Expenses/Net rows in the overlay. A slow background read.
    financeRefreshMin: 15,
    // Depart: keep clicking until the gate queue is empty (game departs ~20 per click)
    departMaxBatches: 15,
    departBatchDelaySec: 8,
    // Timing randomization: every scheduled interval and macro delay is varied by
    // +/- this percentage so the bot produces no fixed clockwork pattern
    jitterPercent: 25,
    // Marketing campaigns. The game's endpoint is
    // marketing_new.php?type=<category>&c=<strength>&mode=do&d=<duration option>
    // Eco (type 5) is the odd one out: fixed duration, no d= at all, and c=1 is a
    // required constant rather than a strength.
    //
    // IMPORTANT:`d` is an OPTION INDEX, not a unit. For the cash campaigns one step
    // is four hours (d=6 -> 24 h), but Brand Marketing (type 9) sells DAYS from the
    // same parameter (d=1 -> 4 days, d=2 -> 7 days) and is paid in POINTS, not cash.
    // A single global"hours = 4 x d" formula is therefore wrong, which is why every
    // campaign carries its own durationOptions with the real hours per entry.
    //
    //`description` ,`tierPrices` ,`allowedTiers` and`durationOptions` are refreshed
    // by"scan from game" , which reads them off your own Marketing page - the only
    // source that cannot go out of date.`fixedHours` is used for campaigns the game
    // offers no duration choice for (Eco), to know when to look again.
    campaigns: [
        { type: 5, label:"Eco-friendly (pax + cargo)" , enabled: true, tier: 1, duration: 6, hasDuration: false, fixedHours: 12, description: "" , tierPrices: {}, allowedTiers: [1], durationOptions: [], resourceKind:"cash" },
        { type: 1, label:"Airline reputation (pax)" , enabled: true, tier: 1, duration: 6, hasDuration: true, fixedHours: 24, description: "" , tierPrices: {}, allowedTiers: [1, 2, 3, 4], durationOptions: AM4_HOURLY_DURATIONS(), resourceKind:"cash" },
        { type: 2, label:"Cargo reputation" , enabled: false, tier: 1, duration: 6, hasDuration: true, fixedHours: 24, description: "" , tierPrices: {}, allowedTiers: [1, 2, 3, 4], durationOptions: AM4_HOURLY_DURATIONS(), resourceKind:"cash" },
        { type: 10, label:"Charter reputation" , enabled: false, tier: 1, duration: 6, hasDuration: true, fixedHours: 24, description: "" , tierPrices: {}, allowedTiers: [1, 2, 3, 4], durationOptions: AM4_HOURLY_DURATIONS(), resourceKind:"cash" },
        // Brand Marketing raises airline, cargo AND charter reputation at once, but it
        // is billed in POINTS. Shipped switched OFF on purpose: points are bought with
        // real money, so nothing may spend them without you ticking the box yourself.
        { type: 9, label:"Brand Marketing (costs POINTS)" , enabled: false, tier: 1, duration: 1, hasDuration: true, fixedHours: 96, description: "" , tierPrices: {}, allowedTiers: [1, 2, 3],
          durationOptions: [{ value: 1, label:"4 days" , hours: 96 }, { value: 2, label:"7 days" , hours: 168 }], resourceKind:"points" }
    ],
    // Countries and airports below are spelled the way the game's own dropdowns spell
    // them - the highlighter compares against that text.
    eliteCountries: [
        "South Korea","Singapore" ,"Hong Kong" ,"India" ,"United Arab Emirates" ,"Bahrain" ,
        "Australia","Fiji" ,
        "United Kingdom","Netherlands" ,"Germany" ,"France" ,
        "United States","Brazil" ,"Chile" ,"Venezuela" ,"Argentina" ,
        "Tunisia","Angola" ,"Senegal" 
    ],
    highYieldAirports: [
        "Seoul Incheon","Singapore" ,"Hong Kong" ,"New Delhi" ,
        "Dubai","Manama" ,
        "Sydney intl","Canberra" ,"Nadi" ,
        "London Heathrow","Amsterdam" ,"Frankfurt intl" ,"Paris Charles de Gaulle" ,
        "New York JFK","Dallas-Fort Worth" ,"Chicago O'Hare" ,"Los Angeles" ,
        "São Paulo Guarulhos","Santiago" ,"Caracas" ,"Buenos Aires Int" ,
        "Tunis","Luanda" ,"Dakar L.S. Senghor" 
    ]
};

// The hourly ladder cash campaigns use (d=1 -> 4 h ... d=6 -> 24 h, including 20 h at d=5).
function AM4_HOURLY_DURATIONS() {
    return [4, 8, 12, 16, 20, 24].map(function(h, i) {
        return { value: i + 1, label: h + ' Hours', hours: h };
    });
}

// Bounds for every numeric setting. A stored config is user-editable JSON in
// localStorage and survives across script versions, so it can hold anything: nulls
// from an older build, a negative interval, a string where a number belongs. An
// unvalidated 0-minute interval turns a 15-minute loop into a hot loop that hammers
// the game a hundred times a second, so every value is clamped on LOAD, not just
// when the settings panel writes it.
var AM4_NUM_BOUNDS = {
    fuelPriceThreshold: [1, 5000],
    co2PriceThreshold: [1, 5000],
    cashReserve: [0, 1e12],
    wearPercent: [1, 99],
    checkHours: [1, 10000],
    paxMultiEco: [0.5, 5],
    paxMultiBiz: [0.5, 5],
    paxMultiFirst: [0.5, 5],
    cargoMultiLarge: [0.5, 5],
    cargoMultiHeavy: [0.5, 5],
    departIntervalMin: [1, 1440],
    buyerIntervalMin: [1, 1440],
    maintIntervalHrs: [0.1, 168],
    campaignCheckMin: [1, 1440],
    departMaxBatches: [1, 200],
    departBatchDelaySec: [1, 300],
    jitterPercent: [0, 40],
    allianceRefreshMin: [2, 120],
    quietFrom: [0, 23],
    quietTo: [0, 23],
    financeRefreshMin: [2, 120],
    maxCampaignSpendPerDay: [0, 1e12],
    maxSpendPerCycle: [0, 1e12],
    fleetBuyerMaxPerBuy: [1, 100],
    fleetBuyerSpendCap: [0, 1e12]
};

function am4NormalizeNumber(key, value) {
    var bounds = AM4_NUM_BOUNDS[key];
    var fallback = AM4_DEFAULT_CONFIG[key];
    var num = Number(value);
    if (!isFinite(num)) return fallback;
    if (bounds) {
        if (num < bounds[0]) num = bounds[0];
        if (num > bounds[1]) num = bounds[1];
    }
    return num;
}

// Brings one stored campaign entry back to the current schema. Anything missing or
// nonsensical falls back to the shipped default for that type, or to a safe
// switched-off entry - a half-migrated campaign must never end up buying something.
function am4NormalizeCampaign(stored) {
    if (!stored || typeof stored !== 'object') return null;
    var type = parseInt(stored.type, 10);
    if (!isFinite(type) || type < 0) return null;
    var shipped = AM4_DEFAULT_CONFIG.campaigns.filter(function(c) { return c.type === type; })[0] || null;

    // A stored option is kept as long as its VALUE (the d= the URL needs) is valid.
    // hours may legitimately be 0 - the scanner records"length seen in a link but 
    // not measured" that way on purpose, and the scheduler then polls instead of
    // sleeping. The old predicate required hours > 0 and so DELETED every honestly
    //"unknown length" option, then invented a fake 4-hour ladder in its place - a
    // made-up duration the game never offered, which the renewal then slept on.
    var durationOptions = Array.isArray(stored.durationOptions)
        ? stored.durationOptions.filter(function(o) {
              return o && isFinite(Number(o.value)) && Number(o.value) >= 1;
          }).map(function(o) {
              var hours = Number(o.hours);
              if (!isFinite(hours) || hours < 0) hours = 0; // unknown length, not invalid
              return { value: Number(o.value), label: String(o.label || (hours > 0 ? hours + ' h' : 'option ' + o.value)), hours: hours };
          })
        : (shipped ? shipped.durationOptions.slice() : []);

    var allowedTiers = (Array.isArray(stored.allowedTiers) ? stored.allowedTiers : (shipped ? shipped.allowedTiers : [1]))
        .map(function(t) { return parseInt(t, 10); })
        .filter(function(t) { return isFinite(t) && t >= 1 && t <= 9; });
    if (allowedTiers.length === 0) allowedTiers = [1];

    var hasDuration = (typeof stored.hasDuration === 'boolean')
        ? stored.hasDuration
        : (shipped ? shipped.hasDuration : false);
    // Pax / cargo / charter / brand always have a duration picker. A scan that ran
    // while a campaign was active (or that only saw Eco-style HTML) used to save
    // hasDuration:false, which locked Charter to"fixed 12 h" even though 24 h exists.
    if (shipped && shipped.hasDuration) hasDuration = true;
    // Only fall back to the shipped options when we truly have nothing. Never invent
    // a ladder for a scanned campaign - leaving durationOptions empty is what makes
    // the panel show"unknown - scan" and the scheduler poll instead of sleeping on
    // a fabricated runtime.
    if (hasDuration && durationOptions.length === 0 && shipped && shipped.durationOptions.length) {
        durationOptions = shipped.durationOptions.slice();
    }
    if (shipped && Array.isArray(shipped.allowedTiers) && shipped.allowedTiers.length > allowedTiers.length) {
        allowedTiers = shipped.allowedTiers.slice();
    }

    var tier = parseInt(stored.tier, 10);
    if (allowedTiers.indexOf(tier) === -1) tier = allowedTiers[0];
    var duration = parseInt(stored.duration, 10);
    var durationValues = durationOptions.map(function(o) { return o.value; });
    if (durationValues.indexOf(duration) === -1) duration = durationValues.length ? durationValues[0] : 1;

    var fixedHours = Number(stored.fixedHours);
    if (!isFinite(fixedHours) || fixedHours <= 0) fixedHours = shipped ? shipped.fixedHours : 12;

    return {
        type: type,
        label: String(stored.label || (shipped && shipped.label) || ('Campaign type ' + type)),
        enabled: stored.enabled === true,
        tier: tier,
        duration: duration,
        hasDuration: hasDuration,
        fixedHours: fixedHours,
        description: String(stored.description || ''),
        tierPrices: (stored.tierPrices && typeof stored.tierPrices === 'object') ? stored.tierPrices : {},
        tierPricesByDuration: (stored.tierPricesByDuration && typeof stored.tierPricesByDuration === 'object') ? stored.tierPricesByDuration : {},
        allowedTiers: allowedTiers,
        durationOptions: durationOptions,
        resourceKind: (stored.resourceKind === 'points') ? 'points' : ((stored.resourceKind === 'ads') ? 'ads' : 'cash')
    };
}

function am4NormalizeStringList(value, fallback) {
    if (!Array.isArray(value)) return fallback.slice();
    var cleaned = value
        .filter(function(s) { return typeof s === 'string'; })
        .map(function(s) { return s.trim(); })
        .filter(function(s) { return s.length > 0 && s.length < 120; });
    return cleaned;
}

function loadAm4Config() {
    var merged = JSON.parse(JSON.stringify(AM4_DEFAULT_CONFIG));
    var stored = null;
    try {
        stored = JSON.parse(localStorage.getItem(AM4_CONFIG_KEY) || '{}');
    } catch (err) {
        console.log('[AM4 Bot Log] Stored config is not valid JSON - starting from defaults: ' + err.message);
        return merged;
    }
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return merged;

    Object.keys(merged).forEach(function(key) {
        if (!Object.prototype.hasOwnProperty.call(stored, key)) return;
        var value = stored[key];
        var def = AM4_DEFAULT_CONFIG[key];
        if (typeof def === 'boolean') {
            merged[key] = (value === true);
        } else if (typeof def === 'number') {
            merged[key] = am4NormalizeNumber(key, value);
        } else if (key === 'overlayPosition') {
            merged[key] = (value === 'right') ? 'right' : 'left';
        } else if (key === 'allianceMemberId') {
            // Digits only - it is a member id; never trust arbitrary stored strings
            merged[key] = (typeof value === 'string' || typeof value === 'number')
                ? String(value).replace(/[^0-9]/g,'').slice(0, 12) : '';
        } else if (key === 'campaigns') {
            if (!Array.isArray(value)) return; // keep shipped defaults
            var seen = {};
            var list = [];
            value.forEach(function(entry) {
                var norm = am4NormalizeCampaign(entry);
                if (!norm || seen[norm.type]) return; // duplicates would double-buy
                seen[norm.type] = true;
                list.push(norm);
            });
            // A campaign we ship but the stored config never saw stays available,
            // switched off, instead of silently disappearing from the panel
            AM4_DEFAULT_CONFIG.campaigns.forEach(function(def2) {
                if (seen[def2.type]) return;
                var copy = JSON.parse(JSON.stringify(def2));
                copy.enabled = false;
                list.push(copy);
            });
            if (list.length > 0) merged[key] = list;
        } else if (key === 'eliteCountries' || key === 'highYieldAirports') {
            merged[key] = am4NormalizeStringList(value, AM4_DEFAULT_CONFIG[key]);
        }
    });
    return merged;
}

var AM4_CONFIG = loadAm4Config();

// Everything reads its thresholds straight out of AM4_CONFIG now. The old mirror
// globals (maxWearThreshold, fuelPriceThreshold, co2PriceThreshold) were a second
// source of truth that could drift out of sync with the panel.
function persistAm4Config() {
    try {
        localStorage.setItem(AM4_CONFIG_KEY, JSON.stringify(AM4_CONFIG));
    } catch (err) {
        console.log('[AM4 Bot Log] Config save failed: ' + err.message);
    }
}

function saveAm4Config() {
    persistAm4Config();
    console.log('[AM4 Bot Log] Config saved and applied.');
}

//================================================================================
// Timing randomization
//
// Every interval and macro delay runs through am4Jitter(), so no action ever
// repeats on an exact clock tick. This removes the fixed-cadence fingerprint
// (15:00.000 min / 12:00 h / 8:00 h) that a naive server-side log analysis would
// spot instantly. It does NOT make automation invisible: total action volume,
// round-the-clock activity and actions without matching page views still look
// automated. See the README for an honest assessment.
//================================================================================
function am4Jitter(ms) {
    var pct = Number(AM4_CONFIG.jitterPercent) || 0;
    if (pct <= 0) return Math.round(ms);
    var factor = 1 + ((Math.random() * 2 - 1) * (pct / 100));
    // Never shorten a wait below 60% of its tuned value. Several delays here are
    // functional (waiting for the game's AJAX panels to render), and a 90% draw
    // would cut a 2000 ms popup wait to 200 ms and break the macro chains.
    // Stretching is always safe, so only the downside is clamped.
    if (factor < 0.6) factor = 0.6;
    return Math.max(50, Math.round(ms * factor));
}

// Random delay in a [min, max] ms window - for spacing out individual actions
function am4RandomDelay(minMs, maxMs) {
    return Math.round(minMs + Math.random() * (maxMs - minMs));
}

//================================================================================
// Quiet hours (Phase A1). am4InQuietHours() is the single gate every scheduler
// consults before acting; when true the scheduler reschedules with
// am4QuietRescheduleMs() instead of doing anything, so no request goes out until the
// window ends. The window is whole local hours and may wrap midnight.
//================================================================================
function am4InQuietHours() {
    if (!AM4_CONFIG.quietHoursEnabled) return false;
    var from = Number(AM4_CONFIG.quietFrom), to = Number(AM4_CONFIG.quietTo);
    if (!isFinite(from) || !isFinite(to) || from === to) return false; // from==to => disabled
    var h = new Date().getHours();
    return (from < to) ? (h >= from && h < to) // same-day window, e.g. 1..8
                       : (h >= from || h < to); // wraps midnight, e.g. 23..6
}

// Milliseconds until the quiet window ends, capped so the scheduler still wakes
// periodically (to notice a config change or the window closing) - it makes NO game
// request on those wake-ups, it only re-checks the clock, so the account stays idle.
function am4MsUntilQuietEnd() {
    var now = new Date();
    var end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(AM4_CONFIG.quietTo), 0, 0, 0);
    if (end <= now) end = new Date(end.getTime() + 24 * 3600 * 1000);
    return end - now;
}
function am4QuietRescheduleMs() {
    return am4Jitter(Math.min(am4MsUntilQuietEnd(), 30 * 60 * 1000));
}

// Shows/hides a small"quiet until Nh" badge in the control bar. No requests.
function am4UpdateQuietBadge() {
    var badge = document.getElementById('am4QuietBadge');
    if (!badge) return;
    if (am4InQuietHours()) {
        var to = Number(AM4_CONFIG.quietTo);
        badge.innerText = '😴 quiet until ' + (to < 10 ?'0' + to : to) + ':00';
        badge.style.display = '';
    } else {
        badge.style.display = 'none';
    }
}

//================================================================================
// Multi-tab lease
//
// Every AM4 tab runs its own copy of this script with its own timers. Two tabs
// open means two buyer loops computing"spend almost the whole balance on fuel" 
// from the same balance, two campaign cycles and two depart chains. localStorage is
// shared but nothing coordinated the tabs, so exactly one tab is elected to perform
// actions; the others keep their UI and their read-only features and simply do not
// spend anything.
//
// The TTL is deliberately generous: a background tab has its timers throttled, and
// a short TTL would let a foreground tab steal the lease from a perfectly healthy
// leader and both would mutate for a while.
//================================================================================
var AM4_LEASE_TTL_MS = 120000;
var AM4_LEASE_BEAT_MS = 45000;
var am4TabID = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
var am4LeaseWarned = false;

function am4ReadLease() {
    try {
        var raw = JSON.parse(localStorage.getItem(AM4_LEASE_KEY) || 'null');
        if (!raw || typeof raw !== 'object' || typeof raw.owner !== 'string') return null;
        if (!isFinite(Number(raw.at))) return null;
        return raw;
    } catch (err) {
        return null;
    }
}

function am4WriteLease() {
    try {
        localStorage.setItem(AM4_LEASE_KEY, JSON.stringify({ owner: am4TabID, at: Date.now() }));
    } catch (err) { /* storage blocked - fall through to single-tab behaviour */ }
}

// True when this tab currently owns the right to spend money / click things.
// Claims a free or expired lease on the spot.
function am4CanMutate() {
    var lease = am4ReadLease();
    var now = Date.now();
    if (!lease || lease.owner === am4TabID || (now - Number(lease.at)) > AM4_LEASE_TTL_MS) {
        if (!lease || lease.owner !== am4TabID) {
            console.log('[AM4 Bot Log] This tab is now the acting AM4 Suite tab.');
        }
        am4WriteLease();
        am4LeaseWarned = false;
        return true;
    }
    if (!am4LeaseWarned) {
        am4LeaseWarned = true;
        console.log('[AM4 Bot Log] Another AM4 tab is the acting tab - this one will not buy, depart or run maintenance. ' +
            'Close the other tab (or leave it as the active one) to avoid doing everything twice.');
    }
    return false;
}

// Is this tab actually automating anything right now? Only a tab with at least one
// switch on has any reason to hold the lease.
function am4TabIsActing() {
    var ids = ["autoDepartCheckbox","autoBuyerCheckbox" ,"autoMarketingCheckbox" ,"autoRepairCheckbox" ,"autoCheckCheckbox" ];
    for (var i = 0; i < ids.length; i++) {
        var cb = document.getElementById(ids[i]);
        if (cb && cb.checked) return true;
    }
    return false;
}

function am4ReleaseLease() {
    var lease = am4ReadLease();
    if (lease && lease.owner === am4TabID) {
        try { localStorage.removeItem(AM4_LEASE_KEY); } catch (err) { /* ignore */ }
    }
}

function am4StartLeaseHeartbeat() {
    // Deliberately does NOT claim on startup. A tab claims the lease only when it is
    // about to mutate (am4CanMutate at each spend/click site). Claiming eagerly here
    // was the bug: an idle second tab grabbed the lease and its heartbeat renewed it
    // forever, so the tab the user was actually automating in could never act again.
    setInterval(function() {
        var lease = am4ReadLease();
        if (!lease || lease.owner !== am4TabID) return;
        // Hold the lease only while genuinely acting; hand it back the moment this tab
        // goes idle, so another tab can take over.
        if (am4TabIsActing()) am4WriteLease();
        else am4ReleaseLease();
    }, AM4_LEASE_BEAT_MS);
    window.addEventListener('pagehide', am4ReleaseLease);
}

// Campaign labels come from the game's own HTML, so they must never be pasted
// into innerHTML unescaped
function am4EscapeHtml(s) {
    return String(s)
        .replace(/&/g,'&amp;')
        .replace(/</g,'&lt;')
        .replace(/>/g,'&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

//================================================================================
// Part 19: DESIGN SYSTEM + PANEL DOCK
//
// The suite grew one panel at a time, and it showed: 8 panels all opened at the exact
// same coordinates (so the second one you opened hid the first), ~250 inline style
// strings and ~500 hard-coded hex colours across ~20 values, with font sizes 9/10/11/
// 12/13 px mixed and section headings sometimes orange, sometimes blue.
//
// This part fixes that from ONE place, without rewriting the panels:
// 1. Design tokens (CSS custom properties) + a small utility layer. Because the
// existing markup carries inline styles - which beat any selector - the shared
// rules use`!important` for a deliberately SHORT list of purely visual
// properties (surface, border, radius, control chrome). Nothing structural.
// 2. Cascading default positions, so opening several panels staggers them instead
// of stacking them. A panel that was ever dragged keeps its saved position.
// 3. A DOCK: every open or minimised panel gets an entry with a live badge; click
// brings it to front (or minimises it if it is already frontmost), and panels
// gain a"–" minimise control next to the existing collapse and close.
// 4. Click-to-front z-ordering, kept strictly BELOW the game's own modals (1050),
// and snap-to-grid / snap-to-edge when a panel is dropped.
//================================================================================
var AM4_PANEL_META = {
    explorer: { icon: '🔎', label: 'Explorer'},
    fleet: { icon: '✈', label: 'Fleet'},
    modify: { icon: '🔧', label: 'Modify'},
    build: { icon: '🏗', label: 'Build'},
    rebuild: { icon: '🔄', label: 'Rebuild'},
    status: { icon: '📊', label: 'Status'},
    settings: { icon: '⚙', label: 'Settings'},
    overlay: { icon: '💰', label: 'Finances'}
};
// Cascade order = the order above. Each later panel opens a little further down/left
// so a stack of panels stays individually reachable.
var AM4_PANEL_ORDER = ['explorer','fleet','modify','build','rebuild','status','settings','overlay' ];
var AM4_DOCK_KEY = 'am4DockHidden';
var AM4_Z_BASE = 1030; // game modals sit at 1050 - never reach it
var AM4_Z_MAX = 1048;
var AM4_SNAP_PX = 8; // drop-position grid
var AM4_EDGE_SNAP_PX = 14; // distance at which a panel snaps flush to a viewport edge

var am4PanelReg = {}; // name -> element (re-registered when a panel is rebuilt)
var am4PanelStack = []; // names, front-most last
var am4DockTimer = null;

function am4InjectDesignSystem() {
    if (document.getElementById('am4DesignSystem')) return;
    var st = document.createElement('style');
    st.id = 'am4DesignSystem';
    st.textContent = [
        // ---- tokens: the single place any suite colour/size is defined ----
        ":root{",
        "--am4-bg:rgba(13,17,23,.975); --am4-surface:#161b22; --am4-surface-2:#1c2530;",
        "--am4-line:#2b3644; --am4-line-soft:#1e2733;",
        "--am4-text:#e6edf3; --am4-dim:#9aa7b4; --am4-dim-2:#6b7785;",
        "--am4-accent:#38bdf8; --am4-accent-2:#a78bfa;",
        "--am4-ok:#10b981; --am4-warn:#f59e0b; --am4-err:#ef4444;",
        "--am4-radius:10px; --am4-radius-sm:6px;",
        "--am4-fs:12px; --am4-fs-sm:10px; --am4-fs-lg:13px;",
        "--am4-shadow:0 12px 34px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.03) inset;",
        "--am4-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;",
        // Panels pad themselves by 14px; the header bleeds to the panel edge by pulling
        // that padding back. The financial overlay pads by 10px, so it overrides this.
        "--am4-pad:14px;}",
        "#am4FinancialMetricsDashboard{--am4-pad:10px}",

        // ---- panel shell (applied by am4PanelChrome, overrides the inline shell) ----
        ".am4-panel{background:var(--am4-bg)!important; border:1px solid var(--am4-line)!important;",
        "border-radius:var(--am4-radius)!important; box-shadow:var(--am4-shadow)!important;",
        "color:var(--am4-text)!important; font-family:var(--am4-mono)!important;",
        "backdrop-filter:blur(3px); scrollbar-width:thin; scrollbar-color:var(--am4-line) transparent;}",
        ".am4-panel::-webkit-scrollbar{width:9px;height:9px}",
        ".am4-panel::-webkit-scrollbar-thumb{background:var(--am4-line); border-radius:6px; border:2px solid transparent; background-clip:content-box}",
        ".am4-panel::-webkit-scrollbar-track{background:transparent}",
        ".am4-panel.am4-front{border-color:#3b4a5e!important}",

        // ---- header row: consistent bar, controls line up, drag affordance ----
        ".am4-panel>.am4-head{display:flex!important; align-items:center; gap:6px;",
        "margin:calc(-1 * var(--am4-pad)) calc(-1 * var(--am4-pad)) 10px calc(-1 * var(--am4-pad))!important;",
        "padding:9px 12px!important;",
        "background:linear-gradient(180deg,rgba(255,255,255,.045),rgba(255,255,255,0))!important;",
        "border-bottom:1px solid var(--am4-line)!important;",
        "border-radius:var(--am4-radius) var(--am4-radius) 0 0!important;}",
        ".am4-panel>.am4-head>*:first-child{font-size:var(--am4-fs-lg)!important; letter-spacing:.6px!important;}",
        // header controls become uniform round hit-targets instead of raw [X]/[-] text
        ".am4-ctl{display:inline-flex; align-items:center; justify-content:center;",
        "width:20px; height:20px; border-radius:5px; cursor:pointer; user-select:none;",
        "font-size:12px!important; font-weight:600; line-height:1; color:var(--am4-dim)!important;",
        "background:transparent; transition:background .12s,color .12s; flex:0 0 auto;}",
        ".am4-ctl:hover{background:rgba(255,255,255,.09); color:var(--am4-text)!important}",
        ".am4-ctl.am4-ctl-close:hover{background:rgba(239,68,68,.18); color:#fca5a5!important}",

        // ---- section headings: one look everywhere (they were orange OR blue) ----
        ".am4-panel .am4-exp-sec,.am4-panel .am4-set-section,.am4-panel .am4-fleet-sec{",
        "color:var(--am4-accent)!important; font-size:11px!important; font-weight:700!important;",
        "letter-spacing:.7px!important; text-transform:uppercase;",
        "border-top:1px solid var(--am4-line-soft)!important; margin-top:12px!important; padding-top:8px!important;}",

        // ---- form controls: one chrome for every input/select/button inside a panel ----
        ".am4-panel input[type=number],.am4-panel input[type=text],.am4-panel select{",
        "background:var(--am4-surface-2)!important; border:1px solid var(--am4-line)!important;",
        "color:var(--am4-text)!important; border-radius:var(--am4-radius-sm)!important;",
        "padding:3px 7px!important; font-family:var(--am4-mono)!important; outline:none;}",
        ".am4-panel input:focus-visible,.am4-panel select:focus-visible,.am4-panel button:focus-visible{",
        "outline:2px solid var(--am4-accent); outline-offset:1px;}",
        ".am4-panel input[type=checkbox]{accent-color:var(--am4-accent); cursor:pointer;}",
        ".am4-panel button{border-radius:var(--am4-radius-sm)!important; font-family:var(--am4-mono)!important;",
        "border:1px solid transparent!important; transition:filter .12s,background .12s; cursor:pointer;}",
        ".am4-panel button:hover:not(:disabled){filter:brightness(1.18)}",
        ".am4-panel button:disabled{cursor:not-allowed}",

        // The tiniest text was 9px, which is below comfortable reading size. Bump just
        // that step; 10-13px are left exactly as the panels authored them.
        ".am4-panel [style*='font-size:9px']{font-size:var(--am4-fs-sm)!important; line-height:1.5!important}",

        // ---- the dock ----
        "#am4Dock{position:fixed; left:50%; transform:translateX(-50%); bottom:10px; z-index:1029;",
        "display:flex; align-items:center; gap:4px; padding:5px 7px; max-width:calc(100vw - 24px);",
        "overflow-x:auto; background:var(--am4-bg); border:1px solid var(--am4-line);",
        "border-radius:12px; box-shadow:var(--am4-shadow); font-family:var(--am4-mono); font-size:11px;",
        "scrollbar-width:none;}",
        "#am4Dock::-webkit-scrollbar{display:none}",
        "#am4Dock.am4-dock-empty{display:none}",
        ".am4-dock-item{display:inline-flex; align-items:center; gap:5px; padding:4px 9px; border-radius:8px;",
        "cursor:pointer; user-select:none; white-space:nowrap; color:var(--am4-dim);",
        "background:transparent; border:1px solid transparent; transition:background .12s,color .12s;}",
        ".am4-dock-item:hover{background:rgba(255,255,255,.07); color:var(--am4-text)}",
        ".am4-dock-item.am4-open{color:var(--am4-text); background:rgba(56,189,248,.10); border-color:rgba(56,189,248,.28)}",
        ".am4-dock-item.am4-min{opacity:.62; font-style:italic}",
        ".am4-dock-badge{display:inline-flex; align-items:center; justify-content:center; min-width:16px; height:16px;",
        "padding:0 4px; border-radius:8px; font-size:9px; font-weight:700; background:var(--am4-accent); color:#04222e;}",
        ".am4-dock-badge.am4-bad{background:var(--am4-err); color:#fff}",
        "#am4DockHide{color:var(--am4-dim-2); cursor:pointer; padding:0 4px; font-size:12px; user-select:none;}",
        "#am4DockHide:hover{color:var(--am4-text)}"
    ].join('');
    document.head.appendChild(st);
}

// ---- z-order: click a panel to bring it forward, always below the game's modals ----
function am4PanelToFront(name) {
    var i = am4PanelStack.indexOf(name);
    if (i !== -1) am4PanelStack.splice(i, 1);
    am4PanelStack.push(name);
    // Re-assign the whole stack so the range can never creep up into the game's 1050.
    var start = Math.max(AM4_Z_BASE, AM4_Z_MAX - am4PanelStack.length + 1);
    am4PanelStack.forEach(function (n, idx) {
        var el = am4PanelReg[n];
        if (!el) return;
        el.style.zIndex = String(Math.min(AM4_Z_MAX, start + idx));
        el.classList.toggle('am4-front', idx === am4PanelStack.length - 1);
    });
    am4RenderDock();
}

function am4PanelIsOpen(el) { return !!(el && el.style.display !== 'none' && document.body.contains(el)); }
function am4PanelIsMinimised(el) { return !!(el && el.dataset && el.dataset.am4Min === '1'); }

function am4PanelMinimise(name) {
    var el = am4PanelReg[name];
    if (!el) return;
    el.dataset.am4Min = '1';
    el.style.display = 'none';
    am4RenderDock();
}
function am4PanelRestore(name) {
    var el = am4PanelReg[name];
    if (!el) return;
    el.dataset.am4Min = '0';
    el.style.display = 'block';
    am4PanelToFront(name);
}
// Dock click: minimised → restore; frontmost → minimise; otherwise → bring to front.
function am4PanelToggleFromDock(name) {
    var el = am4PanelReg[name];
    if (!el) return;
    if (am4PanelIsMinimised(el) || !am4PanelIsOpen(el)) { am4PanelRestore(name); return; }
    if (am4PanelStack[am4PanelStack.length - 1] === name) { am4PanelMinimise(name); return; }
    am4PanelToFront(name);
}

// Live counters shown on the dock. Pure reads of in-memory state - no game requests.
function am4PanelBadge(name) {
    try {
        if (name === 'rebuild' && typeof am4RbQueue !== 'undefined') {
            var bad = am4RbQueue.filter(function (j) { return j.state === 'needs_attention'; }).length;
            if (bad) return { text: String(bad), bad: true };
            var act = am4RbQueue.filter(function (j) { return AM4_RB_ACTIVE.indexOf(j.state) !== -1; }).length;
            return act ? { text: String(act) } : null;
        }
        if (name === 'build' && typeof am4BuildQueue !== 'undefined') {
            var b = am4BuildQueue.filter(function (j) { return AM4_BUILD_ACTIVE.indexOf(j.state) !== -1; }).length;
            return b ? { text: String(b) } : null;
        }
        if (name === 'status') {
            var err = Object.keys(am4Status || {}).filter(function (k) { return am4Status[k].state === 'error'; }).length;
            return err ? { text: String(err), bad: true } : null;
        }
    } catch (e) { /* a badge must never break the dock */ }
    return null;
}

function am4DockHidden() { try { return localStorage.getItem(AM4_DOCK_KEY) === '1'; } catch (e) { return false; } }
function am4SetDockHidden(v) { try { localStorage.setItem(AM4_DOCK_KEY, v ?'1' : '0'); } catch (e) { /* ignore */ } am4RenderDock(); }

function am4RenderDock() {
    if (am4DockHidden()) { var d0 = document.getElementById('am4Dock'); if (d0) d0.remove(); return; }
    am4InjectDesignSystem();
    var dock = document.getElementById('am4Dock');
    if (!dock) {
        dock = document.createElement('div');
        dock.id = 'am4Dock';
        dock.title = 'Open suite windows — click to bring forward or minimise';
        document.body.appendChild(dock);
    }
    // Only panels that exist AND are open or minimised belong in the dock; a closed
    // panel disappears from it (its control-bar button reopens it).
    var names = AM4_PANEL_ORDER.filter(function (n) {
        var el = am4PanelReg[n];
        return el && document.body.contains(el) && (am4PanelIsOpen(el) || am4PanelIsMinimised(el));
    });
    if (!names.length) { dock.className = 'am4-dock-empty'; dock.innerHTML = ''; return; }
    dock.className = '';
    var front = am4PanelStack[am4PanelStack.length - 1];
    dock.innerHTML = names.map(function (n) {
        var meta = AM4_PANEL_META[n] || { icon: '▫', label: n };
        var el = am4PanelReg[n];
        var min = am4PanelIsMinimised(el);
        var badge = am4PanelBadge(n);
        return"<span class='am4-dock-item" + (min ?' am4-min' : (am4PanelIsOpen(el) ?' am4-open' : '')) +
            "' data-am4-dock='" + n +"' title='" + (min ?'minimised — click to restore' : (n === front ?'frontmost — click to minimise' : 'click to bring to front')) +"'>" +
            "<span>" + meta.icon +"</span><span>" + meta.label +"</span>" +
            (badge ? ("<span class='am4-dock-badge" + (badge.bad ?' am4-bad' : '') +"'>" + badge.text +"</span>") : '') +
            "</span>";
    }).join('') +"<span id='am4DockHide' title='Hide the dock (it comes back on reload)'>×</span>" ;
    dock.querySelectorAll('[data-am4-dock]').forEach(function (el) {
        el.addEventListener('click', function () { am4PanelToggleFromDock(el.getAttribute('data-am4-dock')); });
    });
    var h = document.getElementById('am4DockHide');
    if (h) h.addEventListener('click', function () { am4SetDockHidden(true); });
}

function am4StartDock() {
    am4InjectDesignSystem();
    am4RenderDock();
    // Panels are shown/hidden by their own buttons (plain`display` toggles spread over
    // eight build functions), so the dock polls rather than trying to intercept every
    // call site. It reads at most nine elements' display state - no game requests - and
    // 800 ms keeps"open a panel, see its dock entry" feeling immediate. At 2 s the lag
    // was noticeable when opening a window.
    if (!am4DockTimer) am4DockTimer = setInterval(am4RenderDock, 800);
}

// Default position for a panel that has never been dragged: cascade by its place in
// AM4_PANEL_ORDER so several open panels stay individually reachable.
function am4PanelCascade(panel, name) {
    var i = AM4_PANEL_ORDER.indexOf(name);
    if (i < 0) i = 0;
    if (name === 'overlay') return; // the overlay is bottom-anchored on purpose
    var top = 60 + i * 26;
    var right = 20 + i * 16;
    // Keep it fully on screen on small viewports.
    if (top + 200 > window.innerHeight) top = Math.max(50, window.innerHeight - 260);
    panel.style.top = top + 'px';
    panel.style.right = right + 'px';
    panel.style.left = 'auto';
    panel.style.bottom = 'auto';
}

//================================================================================
// Floating-panel chrome: make every suite window draggable by its title bar and
// collapsible to just that bar (like the financial overlay), with the position and
// collapsed state remembered per panel across reloads/remounts. One generic pair of
// helpers is applied to all panels via am4PanelChrome() so they behave identically.
//
// The drag HANDLE is the panel's first child (each panel's title/header row). A click
// on any control INSIDE that row (close [X], refresh ⟳, a collapse toggle, a button/
// input) must NOT start a drag - those are excluded below. Positions are stored as
// {left, top} viewport pixels; on restore the panel switches from its default
// top/right (or bottom/left for the overlay) anchoring to left/top.
//================================================================================
function am4PanelDragExcluded(el) {
    // true when the mousedown landed on an interactive control in the header.
    // .am4-ctl / .am4-min-btn are the shared header controls added by am4PanelChrome -
    // without them here, clicking Minimise would also start dragging the panel.
    return !!(el && el.closest &&
        el.closest('button, input, select, textarea, a, .am4-ctl, .am4-min-btn, .am4-collapse-btn, [id$="Close"], [id$="Refresh"], [id$="Btn"]'));
}

function am4MakeDraggable(panel, handle, storeKey) {
    if (!panel || !handle) return;
    // Restore a saved position first (independent of any drag wiring), so reopening a
    // panel puts it back where the user left it.
    try {
        var saved = JSON.parse(localStorage.getItem(storeKey) || 'null');
        if (saved && isFinite(saved.left) && isFinite(saved.top)) {
            panel.style.left = saved.left + 'px';
            panel.style.top = saved.top + 'px';
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
        }
    } catch (e) { /* ignore */ }
    if (handle.dataset.am4DragBound === '1') return; // wiring is one-time per header element
    handle.dataset.am4DragBound = '1';
    handle.style.cursor = 'move';
    handle.style.userSelect = 'none';
    handle.title = (handle.title ? handle.title + ' · ' : '') + 'drag to move';
    var startX, startY, origLeft, origTop, dragging = false;
    var onMove = function (e) {
        if (!dragging) return;
        var nx = origLeft + (e.clientX - startX);
        var ny = origTop + (e.clientY - startY);
        // Keep a strip on screen so a panel can never be dragged fully out of reach.
        var w = panel.offsetWidth || 260, h = 24;
        nx = Math.max(60 - w, Math.min(nx, window.innerWidth - 60));
        ny = Math.max(0, Math.min(ny, window.innerHeight - h));
        panel.style.left = nx + 'px';
        panel.style.top = ny + 'px';
    };
    var onUp = function () {
        if (!dragging) return;
        dragging = false;
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('mouseup', onUp, true);
        // Snap on DROP (not while dragging, which would feel sticky): to an 8 px grid so
        // panels line up with each other, and flush to a viewport edge when dropped near
        // one. Both are cosmetic - the position is clamped on-screen either way.
        var L = parseInt(panel.style.left, 10) || 0;
        var T = parseInt(panel.style.top, 10) || 0;
        var w = panel.offsetWidth || 0, h = panel.offsetHeight || 0;
        L = Math.round(L / AM4_SNAP_PX) * AM4_SNAP_PX;
        T = Math.round(T / AM4_SNAP_PX) * AM4_SNAP_PX;
        if (L <= AM4_EDGE_SNAP_PX) L = 8;
        if (T <= AM4_EDGE_SNAP_PX + 48) T = 56; // just under the navbar
        if (w && L + w >= window.innerWidth - AM4_EDGE_SNAP_PX) L = window.innerWidth - w - 8;
        if (h && T + h >= window.innerHeight - AM4_EDGE_SNAP_PX) T = Math.max(56, window.innerHeight - h - 8);
        panel.style.left = L + 'px';
        panel.style.top = T + 'px';
        try { localStorage.setItem(storeKey, JSON.stringify({ left: L, top: T })); } catch (e) { /* ignore */ }
    };
    handle.addEventListener('mousedown', function (e) {
        if (e.button !== 0 || am4PanelDragExcluded(e.target)) return;
        var rect = panel.getBoundingClientRect();
        // Switch to absolute left/top anchoring for the drag (panels default to
        // top/right, the overlay to bottom/left).
        panel.style.left = rect.left + 'px';
        panel.style.top = rect.top + 'px';
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        startX = e.clientX; startY = e.clientY;
        origLeft = rect.left; origTop = rect.top;
        dragging = true;
        document.addEventListener('mousemove', onMove, true);
        document.addEventListener('mouseup', onUp, true);
        e.preventDefault();
    }, false);
}

function am4MakeCollapsible(panel, header, storeKey, closeBtn) {
    if (!panel || !header || header.querySelector('.am4-collapse-btn')) return;
    var btn = document.createElement('span');
    btn.className = 'am4-collapse-btn';
    btn.style.cssText = 'cursor:pointer; color:#94a3b8; font-weight:bold; padding:0 4px; user-select:none;';
    btn.title = 'Collapse / expand';
    if (closeBtn && closeBtn.parentElement === header) header.insertBefore(btn, closeBtn);
    else header.appendChild(btn);
    var apply = function (collapsed) {
        // Hide every direct child of the panel except the header row.
        Array.prototype.forEach.call(panel.children, function (ch) {
            if (ch === header) return;
            ch.style.display = collapsed ?'none' : '';
        });
        btn.innerText = collapsed ?'[+]' : '[-]';
        panel.dataset.am4Collapsed = collapsed ?'1' : '0';
    };
    var startCollapsed = false;
    try { startCollapsed = localStorage.getItem(storeKey) === '1'; } catch (e) { /* ignore */ }
    apply(startCollapsed);
    btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var now = panel.dataset.am4Collapsed !== '1';
        apply(now);
        try { localStorage.setItem(storeKey, now ?'1' : '0'); } catch (e) { /* ignore */ }
    });
}

// Apply the shared chrome to a panel. name keys its stored position/collapsed state
// AND its dock entry. opts.noCollapse: skip the collapse toggle (the financial overlay
// already has its own [-]/[+], so it only gets drag).
//
// This is the ONE place every panel passes through, which is why the design system,
// the cascading default position, the dock registration and click-to-front all hook in
// here instead of being repeated in eight build functions.
function am4PanelChrome(panel, name, opts) {
    if (!panel) return;
    var header = panel.firstElementChild;
    if (!header) return;
    am4InjectDesignSystem();
    panel.classList.add('am4-panel');
    header.classList.add('am4-head');
    // Cascade only a panel that has no remembered position - a dragged panel stays put.
    var hasSaved = false;
    try { hasSaved = !!JSON.parse(localStorage.getItem('am4pos_' + name) || 'null'); } catch (e) { /* ignore */ }
    if (!hasSaved) am4PanelCascade(panel, name);
    am4MakeDraggable(panel, header,'am4pos_' + name);
    if (!(opts && opts.noCollapse)) {
        var closeBtn = panel.querySelector('[id$="Close"], #closeOverlayBtn');
        am4MakeCollapsible(panel, header,'am4col_' + name, closeBtn);
    }
    // Uniform look for the header controls the panels authored themselves ([X], ⟳, [-]).
    header.querySelectorAll('[id$="Close"], #closeOverlayBtn').forEach(function (el) {
        el.classList.add('am4-ctl','am4-ctl-close'); el.innerText = '×';
    });
    header.querySelectorAll('[id$="Refresh"]').forEach(function (el) { el.classList.add('am4-ctl'); });
    // .am4-collapse-btn is ours; #am4OverlayCollapseBtn is the overlay's own older one.
    header.querySelectorAll('.am4-collapse-btn, #am4OverlayCollapseBtn').forEach(function (el) { el.classList.add('am4-ctl'); });
    // Minimise: hides the window but keeps it in the dock, distinct from collapse
    // (which keeps the title bar in place) and from close (which removes it entirely).
    if (!header.querySelector('.am4-min-btn')) {
        var mini = document.createElement('span');
        mini.className = 'am4-ctl am4-min-btn';
        mini.title = 'Minimise to the dock';
        mini.innerText = '–';
        var firstCtl = header.querySelector('.am4-collapse-btn, [id$="Close"], #closeOverlayBtn');
        if (firstCtl) header.insertBefore(mini, firstCtl); else header.appendChild(mini);
        mini.addEventListener('click', function (ev) { ev.stopPropagation(); am4PanelMinimise(name); });
    }
    am4PanelReg[name] = panel;
    panel.addEventListener('mousedown', function () { am4PanelToFront(name); }, true);
    am4PanelToFront(name);
    am4StartDock();
}

//================================================================================
// Parts 1 & 2 of 13: Global State Variables & Wallet Telemetry
//================================================================================
var autoDepartTimeoutID = null;
var autoBuyerTimeoutID = null;
var autoRepairTimeoutID = null;
var autoCheckTimeoutID = null;

var isMaintenanceRunning = false;
var isCheckMaintenanceRunning = false;

// A depart run clicks repeatedly across several seconds. The generation token lets
// the toggle (or the funds-safety pause) cancel a chain that is already in flight,
// and stops a second chain from being started on top of a running one.
var am4DepartRunID = 0;
var am4DepartChainActive = false;
// Per-campaign renewal timers, keyed by campaign type
var am4CampaignTimers = {};
// When each type was last actually bought, keyed by type. clearCampaignTimers()
// bumps the run id but cannot recall a request already sent, so a cycle restarted
// right after a purchase could buy the same campaign again before the first one is
// visible. This cooldown blocks a second buy of the same type for a short window.
var am4CampaignLastBuyAt = {};
// Same idea as am4DepartRunID: loading a campaign panel takes a few hundred ms and
// the toggle or the funds brake can be flipped inside that window. Every teardown
// bumps this, so a reply that arrives late can no longer spend money.
var am4CampaignRunID = 0;

//================================================================================
// Hard spend guards (Phase A5). Fail-closed: a cap that is set and reached BLOCKS the
// purchase rather than guessing. am4ParseMoneyStr turns the scanned price strings
// ("$5,218,370","$5.2M" ,"500 points") into a number; the campaign spend log is a
// rolling 24 h window persisted across reloads so a daily cap actually holds.
//================================================================================
function am4ParseMoneyStr(s) {
    if (s == null) return null;
    var m = String(s).match(/([\d][\d.,]*)\s*([kmb])?/i);
    if (!m) return null;
    var num = parseFloat(m[1].replace(/,/g,''));
    if (!isFinite(num)) return null;
    var suf = (m[2] || '').toLowerCase();
    if (suf === 'k') num *= 1e3; else if (suf === 'm') num *= 1e6; else if (suf === 'b') num *= 1e9;
    return Math.round(num);
}

var am4CampaignSpendLog = [];
(function loadCampaignSpendLog() {
    try {
        var raw = JSON.parse(localStorage.getItem('am4CampaignSpendLog') || '[]');
        if (Array.isArray(raw)) {
            am4CampaignSpendLog = raw.filter(function (e) {
                return e && typeof e.at === 'number' && typeof e.amount === 'number';
            });
        }
    } catch (e) { am4CampaignSpendLog = []; }
})();

function am4CampaignSpent24h() {
    var cut = Date.now() - 24 * 60 * 60 * 1000;
    am4CampaignSpendLog = am4CampaignSpendLog.filter(function (e) { return e.at > cut; });
    return am4CampaignSpendLog.reduce(function (s, e) { return s + (e.amount || 0); }, 0);
}

function am4LogCampaignSpend(amount) {
    if (!amount || amount <= 0) return;
    am4CampaignSpendLog.push({ at: Date.now(), amount: amount });
    am4CampaignSpent24h(); // prune
    try { localStorage.setItem('am4CampaignSpendLog', JSON.stringify(am4CampaignSpendLog)); } catch (e) { /* ignore */ }
}

function am4StopDepartChain() {
    am4DepartRunID++;
    am4DepartChainActive = false;
}

// Same generation trick for the consumables buyer: its scan spans several seconds
// of XHRs and timers, and without a token the purchase at the end of that chain
// still went out after the toggle had been switched off.
var am4BuyerRunID = 0;
var am4BuyerBusy = false;
var am4BuyerOpenedPopup = false;
var am4LastLiveAction = { text: '', at: 0, color: '#94a3b8'};
var am4LiveToastTimer = null;

function am4OpsPopupBusy() {
    try {
        if (typeof am4SuiteResearchBusy === 'function' && am4SuiteResearchBusy()) return true;
    } catch (eR) { /* ignore */ }
    if (typeof am4BuildBusy !== 'undefined' && am4BuildBusy) return true;
    if (typeof am4RbBusy !== 'undefined' && am4RbBusy) return true;
    if (am4MaintOwner) return true;
    return false;
}

function am4OpsCanUseGamePopup() {
    if (am4OpsPopupBusy()) return false;
    if (am4IsPopupVisible()) return false;
    if (document.querySelector && document.querySelector('.modal.show')) return false;
    return true;
}

function am4ShowLiveAction(text, color) {
    try {
        am4LastLiveAction = { text: String(text || ''), at: Date.now(), color: color || '#38bdf8'};
        var row = document.getElementById('am4LiveAction');
        if (row) {
            row.textContent = am4LastLiveAction.text;
            row.style.color = am4LastLiveAction.color;
        }
        var ticker = document.getElementById('am4LiveTicker');
        if (ticker) {
            ticker.textContent = am4LastLiveAction.text;
            ticker.style.color = am4LastLiveAction.color;
            ticker.title = am4LastLiveAction.text;
        }
        var toast = document.getElementById('am4LiveToast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'am4LiveToast';
            document.body.appendChild(toast);
        }
        toast.textContent = am4LastLiveAction.text;
        toast.style.color = am4LastLiveAction.color;
        toast.style.display = 'block';
        toast.style.opacity = '1';
        clearTimeout(am4LiveToastTimer);
        am4LiveToastTimer = setTimeout(function () {
            var t = document.getElementById('am4LiveToast');
            if (t) t.style.opacity = '0';
        }, 4500);
    } catch (eLive) { /* visual is best-effort */ }
}

function am4RefreshOverlayBuyRows() {
    try {
        var fuelField = document.getElementById('metricOverlayFuelSpend');
        if (fuelField) {
            var fuelAvg = am4WeightedAveragePrice(am4FuelPurchases);
            fuelField.innerText = fuelAvg === null ?'no buys yet' : '$' + Math.round(fuelAvg).toLocaleString();
        }
        var co2Field = document.getElementById('metricOverlayCo2Spend');
        if (co2Field) {
            var co2Avg = am4WeightedAveragePrice(am4Co2Purchases);
            co2Field.innerText = co2Avg === null ?'no buys yet' : '$' + Math.round(co2Avg).toLocaleString();
        }
    } catch (eRows) { /* ignore */ }
}

function am4OpenGameShop(url, title) {
    try {
        if (typeof window.popup === 'function') {
            window.popup(url, title || '', false, false, true);
            return true;
        }
    } catch (ePop) { /* fall through */ }
    try {
        var hit = document.querySelector('[onclick*="' + url + '"]') ||
            document.querySelector('[onclick*="' + url.split('.php')[0] + '"]');
        if (hit) {
            humanClick(hit);
            return true;
        }
    } catch (eClick) { /* ignore */ }
    return false;
}

function am4BuyerCloseShopIfOurs() {
    if (!am4BuyerOpenedPopup) return;
    am4BuyerOpenedPopup = false;
    try {
        if (typeof am4SuiteResearchBusy === 'function' && am4SuiteResearchBusy()) return;
    } catch (eBusy) { /* ignore */ }
    if (am4MaintOwner) return;
    am4CloseGamePopup();
}

function am4WaitForId(id, timeoutMs, done) {
    var t0 = Date.now();
    var tick = function () {
        var el = document.getElementById(id);
        if (el && String(el.innerHTML || '').length > 20) { done(el); return; }
        if (Date.now() - t0 > (timeoutMs || 4000)) { done(null); return; }
        setTimeout(tick, 180);
    };
    setTimeout(tick, 250);
}

// Buy into the visible fuel/CO2 shop when Research is idle so the tanks and
// purchase result actually appear. Falls back to the silent XHR if the popup
// is already in use (Research / maintenance / the player).
function am4ConsumablePurchase(spec, amount, onSuccess) {
    var url = spec.url + '?mode=do&amount=' + encodeURIComponent(amount);
    var buySilent = function () { spec.buy(amount, onSuccess); };
    var buyIntoShop = function () {
        if (am4OpsPopupBusy()) {
            am4BuyerOpenedPopup = false;
            buySilent();
            return;
        }
        var root = document.getElementById(spec.rootId);
        if (root && typeof window.Ajax === 'function') {
            try {
                window.Ajax(url, spec.rootId, false, false, true);
                if (typeof onSuccess === 'function') setTimeout(onSuccess, 600);
                return;
            } catch (eAjaxBuy) { /* fall through */ }
        }
        buySilent();
    };
    var shopAlreadyOpen = !!(am4BuyerOpenedPopup && document.getElementById(spec.rootId));
    if (shopAlreadyOpen) { buyIntoShop(); return; }
    if (am4BuyerOpenedPopup) {
        am4OpenGameShop(spec.url, spec.label);
        am4WaitForId(spec.rootId, 4000, function () { buyIntoShop(); });
        return;
    }
    if (!am4OpsCanUseGamePopup()) { buySilent(); return; }
    am4BuyerOpenedPopup = true;
    if (!am4OpenGameShop(spec.url, spec.label)) {
        am4BuyerOpenedPopup = false;
        buySilent();
        return;
    }
    am4WaitForId(spec.rootId, 4500, function (el) {
        if (am4OpsPopupBusy()) {
            am4BuyerOpenedPopup = false;
            buySilent();
            return;
        }
        if (!el) {
            buySilent();
            return;
        }
        buyIntoShop();
    });
}

function am4DepartedIds(responseText) {
    var ids = [];
    var seen = {};
    var add = function (id) {
        id = String(id || '');
        if (!id || seen[id]) return;
        seen[id] = true;
        ids.push(id);
    };
    var html = String(responseText || '');
    var re = /removeFromArray\(\s*flightData\s*,\s*(\d+)/g;
    var m;
    while ((m = re.exec(html))) add(m[1]);
    re = /flightStatusChange\(\s*(\d+)/g;
    while ((m = re.exec(html))) add(m[1]);
    return ids;
}

function am4FlightStatusSeconds(id) {
    try {
        var sd = window.statusData && window.statusData[id];
        if (sd && isFinite(Number(sd.end)) && Number(sd.end) > 0 && Number(sd.end) < 172800) {
            return Math.floor(Number(sd.end));
        }
        if (sd && isFinite(Number(sd.arrived))) {
            var left = Math.floor(Number(sd.arrived) - (Date.now() / 1000));
            if (left > 0 && left < 172800) return left;
        }
    } catch (eSec) { /* ignore */ }
    return 3600;
}

function am4InjectDepartResponse(html) {
    // Native Depart All is: depAllAirc = true; Ajax('route_depart.php?mode=all&ids=x','runme',this)
    // #runme is a script sink, not the Research popup, so this does not steal route UI.
    var jq = (typeof window.jQuery !== 'undefined' && window.jQuery.fn) ? window.jQuery
        : ((typeof window.$ !== 'undefined' && window.$.fn) ? window.$ : null);
    var sink = document.getElementById('runme');
    if (!sink) {
        sink = document.createElement('div');
        sink.id = 'runme';
        sink.style.display = 'none';
        document.body.appendChild(sink);
    }
    try { window.depAllAirc = true; } catch (eFlag) { /* ignore */ }
    if (jq) {
        try { jq('#runme').html(html); return true; } catch (eHtml) { /* fall through */ }
    }
    return false;
}

function am4ApplyDepartClientVisual(responseText, count) {
    if (!(count > 0)) return;
    var html = String(responseText || '');
    var ids = am4DepartedIds(html);
    am4InjectDepartResponse(html);
    // Scripts in the response usually call flightStatusChange, which moves #flightStatus<id>
    // from #landedList to #inflightList. If any row is still on Landed, do that ourselves.
    var i;
    for (i = 0; i < ids.length; i++) {
        var id = ids[i];
        var row = document.getElementById('flightStatus' + id);
        if (!row) continue;
        var parent = row.parentElement;
        var onLanded = !!(parent && parent.id === 'landedList') ||
            !!(row.closest && row.closest('#landedList'));
        if (!onLanded) continue;
        if (typeof window.flightStatusChange === 'function') {
            try { window.flightStatusChange(id,'inflight', am4FlightStatusSeconds(id)); } catch (eMove) { /* ignore */ }
        } else if (parent) {
            try { parent.removeChild(row); } catch (eRm) { /* ignore */ }
        }
    }
    try { if (typeof window.countDepartable === 'function') window.countDepartable(); } catch (eCnt) { /* ignore */ }
    try {
        var departBtn = document.querySelector('[onclick*="route_depart.php"]');
        if (departBtn && departBtn.style) {
            departBtn.style.outline = '2px solid #38bdf8';
            departBtn.style.outlineOffset = '2px';
            setTimeout(function () {
                try { departBtn.style.outline = ''; departBtn.style.outlineOffset = ''; } catch (eOff) { /* ignore */ }
            }, 1400);
        }
    } catch (eBtn) { /* ignore */ }
}

// Repair and Check drive the SAME maintenance popup, so they share one lock and one
// generation. Previously each only watched its own flag, so both could open, click
// through and close the same dialog at once - one submitting a plan the other had
// just cleared.
var am4MaintRunID = 0;
var am4MaintOwner = null; //'repair' |'check' | null

function am4AcquireMaintenance(owner) {
    if (am4MaintOwner) return 0; // the other module is inside the popup right now
    am4MaintOwner = owner;
    isMaintenanceRunning = (owner === 'repair');
    isCheckMaintenanceRunning = (owner === 'check');
    return ++am4MaintRunID;
}

// A finish callback belonging to an abandoned run must not clear the flags of the
// run that replaced it, nor close the popup that run is working in.
function am4ReleaseMaintenance(owner, runID) {
    if (am4MaintOwner !== owner || runID !== am4MaintRunID) return false;
    am4MaintOwner = null;
    isMaintenanceRunning = false;
    isCheckMaintenanceRunning = false;
    return true;
}

function am4AbortMaintenance() {
    am4MaintRunID++;
    am4MaintOwner = null;
    isMaintenanceRunning = false;
    isCheckMaintenanceRunning = false;
}

function am4MaintRunValid(owner, runID) {
    if (runID !== am4MaintRunID || am4MaintOwner !== owner) return false;
    if (isBotPausedDueToFunds) return false;
    var cb = document.getElementById(owner === 'repair' ?'autoRepairCheckbox' : 'autoCheckCheckbox');
    return !!(cb && cb.checked);
}

// Schedules the next step of a maintenance macro. The step runs only while the run
// is still the current one AND its toggle is still on - this is what makes flipping
// the toggle off actually stop a sequence instead of letting it reach its submit.
function am4MaintStep(owner, runID, delayMs, fn) {
    setTimeout(function() {
        if (!am4MaintRunValid(owner, runID)) {
            console.log('[AM4 Bot Log] ' + owner + ' step cancelled - toggle off, paused or superseded.');
            // If THIS run still owns the lock (e.g. the checkbox vanished in a navbar
            // re-render, which does not go through am4AbortMaintenance), release it.
            // A run that was genuinely superseded bumped the id, so this leaves the
            // new owner untouched. Without this, a cancelled step left am4MaintOwner
            // set forever, freezing all future maintenance AND blocking window.closePop.
            if (runID === am4MaintRunID && am4MaintOwner === owner) {
                am4MaintOwner = null;
                isMaintenanceRunning = false;
                isCheckMaintenanceRunning = false;
            }
            return;
        }
        try {
            fn();
        } catch (err) {
            console.log('[AM4 Bot Log] ' + owner + ' step threw (' + err.message + ') - releasing the maintenance lock.');
            finishVisualCloseAction(owner === 'repair', true, runID);
        }
    }, am4Jitter(delayMs));
}

// Waits for a panel to actually BE THERE instead of guessing a fixed delay.
//
// Why this exists: every maintenance step used to be"sleep N ms, then look once" . The
// Plan tab loads`maint_plan.php` over AJAX, and that response grows with the fleet - it
// is ~950 KB at ~470 aircraft and needs ~1.6 s before the Bulk check / Bulk repair
// loaders are clickable. The check path slept 1200 ms and the repair path 800 ms, so as
// the fleet grew both started missing the button and reported"bulk check panel not 
// reachable" on a run that was simply not finished loading. Polling makes the macro
// independent of fleet size and machine speed: it continues the instant the panel is
// ready, and gives up honestly if it never arrives.
//
// find() must return the element (or any truthy readiness signal). onFound gets it.
function am4MaintWaitFor(owner, runID, find, timeoutMs, onFound, onTimeout) {
    var started = Date.now();
    var pollMs = 150;
    (function poll() {
        if (!am4MaintRunValid(owner, runID)) {
            console.log('[AM4 Bot Log] ' + owner + ' wait cancelled - toggle off, paused or superseded.');
            if (runID === am4MaintRunID && am4MaintOwner === owner) {
                am4MaintOwner = null;
                isMaintenanceRunning = false;
                isCheckMaintenanceRunning = false;
            }
            return;
        }
        var hit = null;
        try {
            hit = find();
        } catch (err) {
            console.log('[AM4 Bot Log] ' + owner + ' wait predicate threw (' + err.message + ') - releasing the maintenance lock.');
            finishVisualCloseAction(owner === 'repair', true, runID);
            return;
        }
        if (hit) {
            var waited = Date.now() - started;
            if (waited > 1000) console.log('[AM4 Bot Log] ' + owner + ': panel ready after ' + waited + ' ms.');
            try {
                onFound(hit);
            } catch (err2) {
                console.log('[AM4 Bot Log] ' + owner + ' step threw (' + err2.message + ') - releasing the maintenance lock.');
                finishVisualCloseAction(owner === 'repair', true, runID);
            }
            return;
        }
        if (Date.now() - started >= timeoutMs) {
            console.log('[AM4 Bot Log] ' + owner + ': panel did not appear within ' + timeoutMs + ' ms.');
            try {
                onTimeout();
            } catch (err3) {
                finishVisualCloseAction(owner === 'repair', true, runID);
            }
            return;
        }
        setTimeout(poll, pollMs);
    })();
}

// How long to wait for an AJAX-loaded maintenance panel. The Plan tab is the slow one
// (it renders the whole fleet); the bulk sub-panels are small. Generous on purpose -
// waiting is free, a missed button costs a whole maintenance run.
var AM4_MAINT_PANEL_TIMEOUT_MS = 25000;
var AM4_MAINT_SUBPANEL_TIMEOUT_MS = 15000;
// Waiting for a SUBMIT button is the one case where"it never appears" is a legitimate,
// common answer ("nothing needs repair"), so this wait is shorter: long enough for a slow
// preview (the sub-panels render in ~160 ms measured), short enough that a clean run does
// not idle for a quarter of a minute before reporting a healthy fleet.
var AM4_MAINT_SUBMIT_TIMEOUT_MS = 8000;

// Retry policy for a maintenance run that ended in a retryable state. Counted per owner
// and reset on any clean finish, so a single hiccup still retries quickly while a
// persistent fault backs off (5s, 10s, 20s, 40s, 80s, 160s) and then stops.
var AM4_MAINT_RETRY_BASE_MS = 5000;
var AM4_MAINT_RETRY_CAP_MS = 300000;
var AM4_MAINT_MAX_RETRIES = 6;
var am4MaintRetries = { repair: 0, check: 0 };

var isBotPausedDueToFunds = false;

// null (not 0) so a genuine balance of zero is a valid reading rather than a signal
// to re-baseline forever
var lastMonitoredBalance = null;
var am4BaselineCash = 0;
var am4LastSampleAt = 0;

// {delta, ms} per sample - the elapsed time matters because a background tab has its
// timers throttled and a tick is then far longer than the nominal ten seconds
var netRevenueIntervalTicks = [];

// Prices this script last wrote into the route-creation inputs
var am4AppliedPax = null;
// Rolling logs of actual background purchases - drive the overlay's avg price rows
var am4FuelPurchases = [];
var am4Co2Purchases = [];
// Suppresses persisting toggle states while the funds-safety uncheck runs
var am4SuppressToggleSave = false;

// The game's own closePop, captured exactly once into a closure the suite never
// writes back into. The previous code re-read window.closePop on every load and
// stored whatever it found as"the original" - on a second load that was this
// script's OWN wrapper, which builds a wrapper chain and can recurse. Anything that
// is tagged __am4Wrapper is ours and is never accepted as the native function.
var am4NativeClosePop = (typeof window.closePop === 'function' && !window.closePop.__am4Wrapper)
    ? window.closePop
    : null;

// Closes the game popup the way the game would, with a DOM fallback. Never calls
// window.closePop (that is our own wrapper).
function am4CloseGamePopup() {
    try {
        if (typeof am4NativeClosePop === 'function') {
            am4NativeClosePop();
        } else {
            var popupBox = document.getElementById('popup');
            if (popupBox) {
                popupBox.style.display = 'none';
                popupBox.setAttribute('aria-hidden','true');
            }
        }
    } catch (err) {
        console.log("[AM4 Bot Log] The game's closePop threw during cleanup: " + err.message);
    }
    am4RemoveStrayBackdrops();
}

// Only clears leftover dimming layers once nothing is actually open any more.
// Removing every .modal-backdrop unconditionally also stripped the backdrop from a
// dialog the player had just opened themselves.
function am4RemoveStrayBackdrops() {
    if (am4IsPopupVisible()) return;
    if (document.querySelector('.modal.show')) return;
    document.querySelectorAll('.modal-backdrop').forEach(function(el) { el.remove(); });
}

function getBankBalance() {
    var bankBalance = document.getElementById('headerAccount');
    if (bankBalance) {
        var rawText = bankBalance.innerText;
        var sanitizedNum = rawText.replace(/[^0-9]/g,'');
        var parsedInt = parseInt(sanitizedNum, 10);
        return parsedInt || 0;
    }
    return 0;
}

// The old"buyAll" fallback is gone. No such control exists in the current markup,
// its server-side validity was never confirmed, and it fired whenever the amount
// argument was undefined - i.e. exactly when something upstream had gone wrong.
// An explicit positive amount is now required.
function am4BuyConsumable(endpoint, intAmount, onSuccess) {
    var amount = Math.floor(Number(intAmount));
    if (!isFinite(amount) || amount <= 0) {
        console.log('[AM4 Bot Log] Refusing to send a ' + endpoint + ' purchase without a valid amount.');
        return;
    }
    call(endpoint + '?mode=do&amount=' + encodeURIComponent(amount), 0, onSuccess);
}

function buyFuel(intAmount, onSuccess) {
    am4BuyConsumable('fuel.php', intAmount, onSuccess);
}

// closePop is overridden in exactly ONE place: setupClosePopProtection() (Part 4).
// The native implementation is captured once in the am4NativeClosePop closure above.

function buyCO2(intAmount, onSuccess) {
    am4BuyConsumable('co2.php', intAmount, onSuccess);
}

// Every call() in this script spends money (fuel, CO2, campaigns), so a failure is
// NEVER retried automatically: a server error can arrive after the purchase was
// already booked, and a retry would then buy the same thing twice. Failures are
// logged loudly and left for the next regular cycle instead.
function call(url, unusedRetryArg, onSuccess) {
    var xhr = new XMLHttpRequest();
    xhr.timeout = 30000;
    var settled = false;
    var fail = function(why) {
        if (settled) return;
        settled = true;
        console.log('[AM4 Bot Log] Purchase request FAILED (' + why + '): ' + url.split('?')[0] +
            ' - not retried on purpose, a retry could buy the same thing twice. ' +
            'The game may or may not have booked it; the next regular cycle re-checks.');
    };
    xhr.ontimeout = function() { fail('timed out'); };
    xhr.onerror = function() { fail('network error'); };
    xhr.onreadystatechange = function () {
        if (xhr.readyState !== XMLHttpRequest.DONE || settled) return;
        if (xhr.status !== 200) { fail('HTTP ' + xhr.status); return; }
        settled = true;
        // HTTP 200 only means the request was answered. Whether the game accepted it
        // is decided by the caller, which reads the response body back.
        console.log('[AM4 Bot Log] Purchase request answered: ' + url.split('?')[0]);
        if (typeof onSuccess === 'function') onSuccess(xhr.responseText);
    };
    // The game's own Ajax helper disables caching on every mutating request; a cached
    // 200 for a purchase URL would look like a successful buy that never happened.
    xhr.open('GET', url + (url.indexOf('?') === -1 ?'?' : '&') + '_=' + Date.now(), true);
    xhr.setRequestHeader('Cache-Control','no-cache');
    xhr.send();
}

if (typeof window.Android === 'undefined') {
    window.Android = {
        playSound: function(s) { console.log("Audio emulated: " + s); },
        showToast: function(m) { console.log("Toast emulated: " + m); }
    };
}

function checkAccountBalanceToastSafety() {
    // Several toasts can be stacked and the newest is not necessarily the first, so
    // every visible one is inspected rather than only the top of the stack.
    var toasts = document.querySelectorAll(".jq-toast-wrap .jq-toast-single");
    var hit = false;
    for (var i = 0; i < toasts.length; i++) {
        var text = (toasts[i].innerText || '').toLowerCase();
        if (text.indexOf("account too low") !== -1 || text.indexOf("not enough money") !== -1 ||
            text.indexOf("insufficient funds") !== -1) {
            hit = true;
            break;
        }
    }
    if (!hit) return false;

    // Order matters: invalidate every in-flight run FIRST. If the toggles were
    // unticked first, an already-scheduled step could still fire between the two
    // and reach its purchase while the close-protection was already switched off.
    isBotPausedDueToFunds = true;
    am4StopDepartChain();
    am4AbortMaintenance();
    am4BuyerRunID++;
    am4BuyerBusy = false;
    clearCampaignTimers();

    var checkBoxes = ["autoDepartCheckbox","autoBuyerCheckbox" ,"autoMarketingCheckbox" ,"autoRepairCheckbox" ,"autoCheckCheckbox" ];
    am4SuppressToggleSave = true; // safety pause must not overwrite the user's saved preferences
    try {
        checkBoxes.forEach(function(id) {
            var cb = document.getElementById(id);
            if (cb && cb.checked) {
                cb.checked = false;
                cb.dispatchEvent(new Event("change", { bubbles: true }));
            }
        });
    } finally {
        // A throwing change handler must not leave this latched: every later toggle
        // the user flips by hand would silently stop being remembered.
        am4SuppressToggleSave = false;
    }
    console.log('[AM4 Bot Log] Account balance too low - all automations stopped and switched off. ' +
        'Switch the ones you want back on by hand once the balance recovered.');
    return true;
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
        am4StopDepartChain(); // also abort a chain that is mid-run
    }
}

function triggerBuyerToggle() {
    var cb = document.getElementById("autoBuyerCheckbox");
    if (cb && cb.checked) {
        // Run the scan immediately on check instead of waiting for the configured buyer interval
        clearTimeout(autoBuyerTimeoutID);
        scanConsumable();
    } else {
        clearTimeout(autoBuyerTimeoutID);
        // A scan already in flight has its own XHRs and delays pending. Bumping the
        // generation is what stops those from still buying after the switch went off.
        am4BuyerRunID++;
        am4BuyerBusy = false;
        am4BuyerCloseShopIfOurs();
    }
}

function triggerMarketingToggle() {
    var cb = document.getElementById("autoMarketingCheckbox");
    if (cb && cb.checked) {
        // Start one renewal cycle per enabled campaign
        startCampaignRenewal();
        if (!am4CampaignScanAttempted) {
            am4CampaignScanAttempted = true;
            scanMarketingCampaigns();
        }
    } else {
        clearCampaignTimers();
    }
}

// Switching a maintenance module off only aborts a run that module actually owns -
// otherwise turning Repair off would kill a Check sequence that is mid-popup.
function am4AbortMaintenanceIfOwner(owner) {
    if (am4MaintOwner === owner) am4AbortMaintenance();
}

function triggerRepairToggle() {
    var cb = document.getElementById("autoRepairCheckbox");
    if (cb && cb.checked) {
        // Clear first: the launchpad and the interval both store their next run in
        // this same variable. Overwriting it without clearing left the previous timer
        // armed and unreferenced, so it fired later as an extra, unscheduled run that
        // no toggle-off could cancel.
        clearTimeout(autoRepairTimeoutID);
        // If a popup was just open or is currently fading out, add an 800ms delay to let the animations clear
        var delayTime = am4IsPopupVisible() ? 800 : 50;
        autoRepairTimeoutID = setTimeout(function() {
            autoRepairCheckLoop();
        }, delayTime);
    } else {
        clearTimeout(autoRepairTimeoutID);
        am4AbortMaintenanceIfOwner('repair');
    }
}

function triggerCheckToggle() {
    var cb = document.getElementById("autoCheckCheckbox");
    if (cb && cb.checked) {
        clearTimeout(autoCheckTimeoutID); // see triggerRepairToggle - kill the orphan first
        var delayTime = am4IsPopupVisible() ? 800 : 50;
        autoCheckTimeoutID = setTimeout(function() {
            autoCheckCheckLoop();
        }, delayTime);
    } else {
        clearTimeout(autoCheckTimeoutID);
        am4AbortMaintenanceIfOwner('check');
    }
}

// W-11: an inline style.display is not a reliable visibility test. Bootstrap shows
// modals through classes and display:flex, and an element with no inline style at
// all reads as"" - which the old check treated as closed while the dialog was
// plainly on screen.
function am4IsPopupVisible(el) {
    var node = el || document.getElementById('popup');
    if (!node) return false;
    if (node.getAttribute('aria-hidden') === 'true') return false;
    var style = window.getComputedStyle ? window.getComputedStyle(node) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)) return false;
    var box = node.getBoundingClientRect ? node.getBoundingClientRect() : null;
    return !!(box && box.width > 0 && box.height > 0);
}

//================================================================================
// Part 4 of 13: Independent Viewport Un-Latch & Click-Safe Interception Core
//================================================================================
function injectAm4Styles() {
    if (document.getElementById("am4SuiteStyles")) return;
    var style = document.createElement("style");
    style.id ="am4SuiteStyles" ;
    style.textContent = [
        "#am4ControlBar { display:inline-flex; align-items:center; gap:12px; background:rgba(20,24,30,0.88); border:1px solid #34495e; border-radius:20px; padding:5px 14px; margin:2px 8px; vertical-align:middle; }",
        "#am4BrandTag { font-size:10px; font-weight:bold; color:#38bdf8; letter-spacing:1px; font-family:monospace; white-space:nowrap; }",
        ".am4-toggle { display:flex; flex-direction:column; align-items:center; gap:3px; }",
        ".am4-toggle-label { font-size:9px; color:#94a3b8; letter-spacing:0.3px; white-space:nowrap; font-family:monospace; }",
        ".am4-switch { position:relative; display:inline-block; width:30px; height:16px; margin:0; }",
        ".am4-switch input { opacity:0; width:0; height:0; position:absolute; }",
        ".am4-slider { position:absolute; cursor:pointer; top:0; left:0; right:0; bottom:0; background:#475569; border-radius:16px; transition:background .2s; }",
        ".am4-slider:before { content: ''; position:absolute; height:12px; width:12px; left:2px; bottom:2px; background:#fff; border-radius:50%; transition:transform .2s; }",
        ".am4-switch input:checked + .am4-slider { background:#10b981; }",
        ".am4-switch input:checked + .am4-slider:before { transform:translateX(14px); }",
        "#am4StatusWrap { display:flex; flex-direction:column; align-items:center; gap:2px; }",
        "#am4SettingsBtn { cursor:pointer; color:#38bdf8; font-size:16px; line-height:1; padding:2px 4px; border-radius:4px; transition:background .15s; user-select:none; }",
        "#am4SettingsBtn:hover { background:rgba(56,189,248,0.15); }",
        // z-index stays UNDER the game's own modals (which sit at 1050). At 999999 the
        // panel covered dialog content and swallowed clicks meant for the game.
        // The width collapses on narrow screens instead of overflowing the viewport.
        "#am4SettingsPanel { position:fixed; top:60px; right:20px; width:min(360px, calc(100vw - 24px)); max-height:82vh; overflow-y:auto; background:rgba(15,19,26,0.97); border:1px solid #34495e; border-radius:8px; color:#e2e8f0; font-family:monospace; font-size:12px; z-index:1040; padding:14px; box-shadow:0 6px 24px rgba(0,0,0,0.6); display:none; }",
        ".am4-points-tag { color:#f87171; font-size:9px; border:1px solid #f87171; border-radius:3px; padding:0 3px; margin-left:4px; }",
        ".am4-campaign-warn { padding-left:22px; font-size:10px; color:#f59e0b; line-height:1.35; margin-bottom:3px; }",
        "#am4SettingsPanel h3 { margin:0 0 4px 0; font-size:13px; color:#38bdf8; letter-spacing:1px; display:flex; }",
        "#am4SettingsPanel h3 span:first-child { flex-grow:1; }",
        "#am4SettingsClose { cursor:pointer; color:#ef4444; font-weight:bold; padding:0 4px; }",
        ".am4-set-section { border-top:1px dashed #334155; margin-top:10px; padding-top:7px; font-weight:bold; color:#f59e0b; font-size:11px; letter-spacing:0.5px; }",
        ".am4-set-row { display:flex; justify-content:space-between; align-items:center; margin:5px 0; gap:8px; }",
        ".am4-set-row label { color:#94a3b8; flex-grow:1; }",
        ".am4-set-row input[type=number], .am4-set-row select { width:80px; background:#1e293b; border:1px solid #475569; color:#e2e8f0; border-radius:4px; padding:2px 5px; font-family:monospace; font-size:12px; }",
        ".am4-set-row input[type=checkbox] { cursor:pointer; }",
        "#am4SettingsPanel textarea { width:100%; min-height:110px; background:#1e293b; border:1px solid #475569; color:#e2e8f0; border-radius:4px; padding:5px; font-family:monospace; font-size:11px; resize:vertical; box-sizing:border-box; }",
        ".am4-hub-hint { font-size:10px; color:#64748b; margin:2px 0 6px 0; }",
        ".am4-btn { cursor:pointer; border:none; border-radius:5px; padding:6px 10px; font-family:monospace; font-size:12px; font-weight:bold; }",
        ".am4-btn-save { background:#10b981; color:#04211a; }",
        ".am4-btn-save:hover { background:#34d399; }",
        ".am4-btn-reset { background:#334155; color:#e2e8f0; }",
        ".am4-btn-reset:hover { background:#475569; }",
        ".am4-btn-mini { background:#334155; color:#94a3b8; font-size:10px; padding:2px 6px; font-weight:normal; }",
        ".am4-btn-row { display:flex; gap:8px; margin-top:12px; justify-content:flex-end; }",
        "#am4LiveTicker { font-size:9px; color:#38bdf8; font-family:monospace; white-space:nowrap; max-width:180px; overflow:hidden; text-overflow:ellipsis; }",
        "#am4LiveToast { position:fixed; top:72px; left:50%; transform:translateX(-50%); z-index:1045; background:rgba(15,19,26,0.96); border:1px solid #38bdf8; color:#e2e8f0; font-family:monospace; font-size:13px; font-weight:bold; padding:8px 16px; border-radius:8px; box-shadow:0 8px 24px rgba(0,0,0,0.55); pointer-events:none; opacity:0; transition:opacity .2s; white-space:nowrap; max-width:min(90vw, 520px); overflow:hidden; text-overflow:ellipsis; }",
        "#am4LiveAction { min-height:16px; font-size:11px; font-weight:bold; color:#38bdf8; margin:0 0 6px 0; line-height:1.3; }"
    ].join("\n");
    document.head.appendChild(style);
}

// Picks the LEFT nav list explicitly. Neither .status-list nor #statusList exists on
// the current page, so the old code fell through to querySelector('.navbar-nav') and
// took whichever list happened to come first in the document - on the tested layout
// that was the right one by luck, not by rule.
function am4FindNavbarTarget() {
    return document.querySelector('#topMenu ul.navbar-nav:not(.ml-auto)') ||
           document.querySelector('nav ul.navbar-nav:not(.ml-auto)') ||
           document.querySelector('.status-list') ||
           document.getElementById('statusList') ||
           document.querySelector('ul.navbar-nav') ||
           null;
}

function injectToggleControls() {
    if (document.getElementById("autoDepartCheckbox")) return;
    var navbarTarget = am4FindNavbarTarget();
    if (!navbarTarget) {
        setTimeout(injectToggleControls, 1000);
        return;
    }
    injectAm4Styles();
    var items = [
        { id:"autoDepartCheckbox" , label:"Auto-Depart" , trigger: triggerDepartToggle },
        { id:"autoBuyerCheckbox" , label:"Auto-Buy Specs" , trigger: triggerBuyerToggle },
        { id:"autoMarketingCheckbox" , label:"Auto-Buy Mktg" , trigger: triggerMarketingToggle },
        { id:"autoRepairCheckbox" , label:"Auto-Repair" , trigger: triggerRepairToggle },
        { id:"autoCheckCheckbox" , label:"Auto-Check" , trigger: triggerCheckToggle }
    ];
    var li = document.createElement("li");
    li.className ="nav-item" ;
    li.style.cssText ="display:inline-block; vertical-align:middle;" ;
    var bar = document.createElement("div");
    bar.id ="am4ControlBar" ;
    var brand = document.createElement("span");
    brand.id ="am4BrandTag" ;
    brand.innerText ="AM4 SUITE" ;
    bar.appendChild(brand);
    // Quiet-hours badge (hidden unless the window is active). Set once here, kept in
    // sync by am4UpdateQuietBadge on a slow interval and after a settings save.
    var quietBadge = document.createElement("span");
    quietBadge.id ="am4QuietBadge" ;
    quietBadge.style.cssText ="font-size:9px; font-weight:bold; color:#fbbf24; font-family:monospace; white-space:nowrap; display:none;" ;
    bar.appendChild(quietBadge);
    items.forEach(function(item) {
        var wrap = document.createElement("div");
        wrap.className ="am4-toggle" ;
        wrap.innerHTML ="<span class='am4-toggle-label'>" + item.label +"</span>" +
            "<label class='am4-switch'><input type='checkbox' id='" + item.id +"'><span class='am4-slider'></span></label>" ;
        bar.appendChild(wrap);
    });
    var statusWrap = document.createElement("div");
    statusWrap.id ="am4StatusWrap" ;
    statusWrap.innerHTML ="<span class='am4-toggle-label'>Fleet Status</span><span id='maintenanceStatusLabel' style='color:#5cb85c; font-weight:bold; font-size:10px; font-family:monospace;'>Fleet Healthy</span>" ;
    bar.appendChild(statusWrap);
    var gear = document.createElement("span");
    gear.id ="am4SettingsBtn" ;
    gear.title ="AM4 Suite Settings" ;
    gear.innerText ="⚙" ;
    bar.appendChild(gear);
    // Version tag right behind the ⚙ (so you can always see which build is loaded)
    var ver = document.createElement("span");
    ver.id ="am4VersionTag" ;
    ver.title ="AM4 Suite version (loaded build)" ;
    ver.style.cssText ="font-size:9px; color:#64748b; font-family:monospace; white-space:nowrap; margin-left:1px;" ;
    ver.innerText ="v" + AM4_SUITE_VERSION;
    bar.appendChild(ver);
    var ticker = document.createElement("span");
    ticker.id ="am4LiveTicker" ;
    ticker.title ="Last auto-depart / fuel / CO2 action" ;
    ticker.textContent = am4LastLiveAction.text || "" ;
    if (am4LastLiveAction.color) ticker.style.color = am4LastLiveAction.color;
    bar.appendChild(ticker);
    li.appendChild(bar);
    navbarTarget.appendChild(li);

    items.forEach(function(item) {
        document.getElementById(item.id).addEventListener("change", function() {
            if (!am4SuppressToggleSave) saveToggleStates();
            // Switching something back on by hand releases the low-funds brake -
            // otherwise it would stay latched until the page is reloaded
            if (this.checked) isBotPausedDueToFunds = false;
            item.trigger();
        });
    });
    gear.addEventListener("click", toggleSettingsPanel);
    // Research Explorer button (read-only tool - ranks hubs by good routes for the selected type).
    // Lives in the same control bar and is re-added by this function on every remount.
    am4ExpInjectButton();
    var oldStratBtn = document.getElementById('am4StrategyBtn');
    if (oldStratBtn && oldStratBtn.parentElement) oldStratBtn.parentElement.removeChild(oldStratBtn);
    var oldStratPanel = document.getElementById('am4StrategyPanel');
    if (oldStratPanel) oldStratPanel.remove();
    am4InjectStatusButton();
    am4FleetInjectButton();
    am4RbInjectButton();
    am4UpdateQuietBadge();
    restoreToggleStates();
    am4UiEverMounted = true;
    console.log("[AM4 Bot Log] Navbar control center interface mounted successfully.");
}

// AM4 re-renders its navbar over AJAX on some navigations, which takes the whole
// control bar and every listener on it with it. Without this the switches simply
// vanish until the page is reloaded.
var am4UiEverMounted = false;

function am4StartUiRemountWatcher() {
    setInterval(function() {
        if (document.hidden) return;
        // Only repairs a bar that was there before - during the very first mount the
        // injector is already retrying on its own, and racing it would stack retries
        if (!am4UiEverMounted) return;
        var bar = document.getElementById('am4ControlBar');
        if (bar && document.body.contains(bar) && document.getElementById('autoDepartCheckbox')) return;

        // Read the desired state from localStorage, NOT from the DOM. In the case this
        // watcher exists for - AM4 replaced the navbar and took the whole control bar
        // with it - the checkboxes are already detached, so reading them off the DOM
        // returned {} every time and nothing was ever restarted. saveToggleStates()
        // persists on every change, so this is the reliable source of truth.
        var desired = {};
        try { desired = JSON.parse(localStorage.getItem(AM4_TOGGLE_KEY) || '{}') || {}; } catch (err) { desired = {}; }

        // A partial mount would otherwise block the repair, because the guard only
        // looks for the depart checkbox
        if (bar && bar.parentElement) bar.parentElement.remove();
        console.log('[AM4 Bot Log] Control bar was removed by a page re-render - re-mounting it.');
        injectToggleControls();

        // Do not resurrect toggles the low-funds brake just switched off - re-firing
        // change with checked=true would also clear isBotPausedDueToFunds.
        if (isBotPausedDueToFunds) return;
        Object.keys(desired).forEach(function(id) {
            if (!desired[id]) return;
            var cb = document.getElementById(id);
            if (cb && !cb.checked) {
                cb.checked = true;
                cb.dispatchEvent(new Event("change", { bubbles: true }));
            }
        });
    }, 4000);
}

function saveToggleStates() {
    var state = {};
    ["autoDepartCheckbox","autoBuyerCheckbox" ,"autoMarketingCheckbox" ,"autoRepairCheckbox" ,"autoCheckCheckbox" ].forEach(function(id) {
        var cb = document.getElementById(id);
        if (cb) state[id] = cb.checked;
    });
    try { localStorage.setItem(AM4_TOGGLE_KEY, JSON.stringify(state)); } catch (err) { /* storage full/blocked */ }
}

function restoreToggleStates() {
    if (!AM4_CONFIG.restoreToggles) return;
    // The low-funds brake lives only in memory, so a reload would clear it and this
    // would switch the very automations back on that just ran the account dry.
    if (isBotPausedDueToFunds) return;
    var state = null;
    try { state = JSON.parse(localStorage.getItem(AM4_TOGGLE_KEY) || '{}'); } catch (err) { return; }
    // JSON.parse('null') does not throw, but Object.keys(null) does - and that throw
    // lands outside the try, taking the whole mount with it.
    if (!state || typeof state !== 'object' || Array.isArray(state)) return;
    Object.keys(state).forEach(function(id) {
        var cb = document.getElementById(id);
        if (cb && state[id] && !cb.checked) {
            cb.checked = true;
            cb.dispatchEvent(new Event("change", { bubbles: true }));
        }
    });
}

//================================================================================
// Part 4.5 of 13: Settings Panel & Hub List Editor (⚙ in the control bar)
//================================================================================
var AM4_SETTINGS_SCHEMA = [
    { section:"PURCHASE LIMITS" },
    { key:"fuelPriceThreshold" , label:"Fuel max price ($)" , type:"int" , min: 1 },
    { key:"co2PriceThreshold" , label:"CO2 max price ($)" , type:"int" , min: 1 },
    { key:"cashReserve" , label:"Always keep ($)" , type:"int" , min: 0 },
    { key:"buyerIntervalMin" , label:"Scan every (min)" , type:"float" , min: 1 },
    { section:"MAINTENANCE" },
    { key:"wearPercent" , label:"Repair at wear (%)" , type:"int" , min: 1, max: 99 },
    { key:"checkHours" , label:"A-Check below (hours)" , type:"int" , min: 1 },
    { key:"maintIntervalHrs" , label:"Re-run every (hrs)" , type:"float" , min: 0.1 },
    { section:"TICKET PRICE MULTIPLIERS" },
    { key:"paxMultiEco" , label:"Economy ×" , type:"float" , min: 0.5, step: 0.01 },
    { key:"paxMultiBiz" , label:"Business ×" , type:"float" , min: 0.5, step: 0.01 },
    { key:"paxMultiFirst" , label:"First ×" , type:"float" , min: 0.5, step: 0.01 },
    { key:"cargoMultiLarge" , label:"Cargo Large ×" , type:"float" , min: 0.5, step: 0.01 },
    { key:"cargoMultiHeavy" , label:"Cargo Heavy ×" , type:"float" , min: 0.5, step: 0.01 },
    { section:"DEPART" },
    { key:"departIntervalMin" , label:"Auto-Depart every (min)" , type:"float" , min: 1 },
    { key:"departMaxBatches" , label:"Max depart clicks per run" , type:"int" , min: 1 },
    { key:"departBatchDelaySec" , label:"Pause between clicks (sec)" , type:"float" , min: 1 },
    { section:"AUTO-BUY MARKETING" },
    { key:"campaignCheckMin" , label:"Check for expiry every (min)" , type:"float" , min: 1 },
    { section:"FINANCIAL OVERLAY" },
    { key:"overlayEnabled" , label:"Show overlay" , type:"bool" },
    { key:"overlayPosition" , label:"Screen side" , type:"select" , valueType:"string" , options: [["left","Bottom left" ], ["right","Bottom right" ]] },
    { key:"financeRefreshMin" , label:"Net income refresh (min)" , type:"float" , min: 2 },
    { section:"ALLIANCE CONTRIBUTION" },
    { key:"allianceMemberId" , label:"Member id (blank = auto)" , type:"text" , placeholder:"auto-detect" },
    { key:"allianceRefreshMin" , label:"Refresh every (min)" , type:"float" , min: 2 },
    { section:"QUIET HOURS (be idle overnight)" },
    { key:"quietHoursEnabled" , label:"Enable quiet hours" , type:"bool" },
    { key:"quietFrom" , label:"Quiet from (hour 0-23)" , type:"int" , min: 0, max: 23 },
    { key:"quietTo" , label:"Quiet until (hour 0-23)" , type:"int" , min: 0, max: 23 },
    { section:"SPEND GUARDS (fail-closed)" },
    { key:"neverSpendPoints" , label:"Never spend points" , type:"bool" },
    { key:"maxCampaignSpendPerDay" , label:"Max campaign $/day (0=off)" , type:"int" , min: 0 },
    { key:"maxSpendPerCycle" , label:"Max buyer $/cycle (0=off)" , type:"int" , min: 0 },
    { key:"fleetBuyerMaxPerBuy" , label:"Max aircraft per order" , type:"int" , min: 1, max: 100 },
    { key:"fleetBuyerSpendCap" , label:"Aircraft order $ cap (0=off)" , type:"int" , min: 0 },
    { section:"TIMERS & BEHAVIOR" },
    // Capped at 40 on purpose: the downside of a draw is clamped at 0.6x so functional
    // waits are never cut to nothing, which means anything above 40 would no longer be
    // symmetric - the box would promise a spread it does not actually apply.
    { key:"jitterPercent" , label:"Timing randomness (± %)" , type:"int" , min: 0, max: 40 },
    { key:"restoreToggles" , label:"Restore toggles after reload" , type:"bool" }
];

// Strength prices depend on the duration option (d=). Tier 4 at 4 h ≠ tier 4 at 24 h.
function am4CampaignTierPrices(c, duration) {
    if (!c) return {};
    duration = duration != null ? String(Number(duration)) : String(Number(c.duration));
    var byDur = c.tierPricesByDuration;
    if (byDur && byDur[duration] && typeof byDur[duration] === 'object' && Object.keys(byDur[duration]).length) {
        return byDur[duration];
    }
    return (c.tierPrices && typeof c.tierPrices === 'object') ? c.tierPrices : {};
}

function am4RefreshCampaignTierSelect(cType) {
    var panel = document.getElementById('am4SettingsPanel');
    if (!panel) return;
    var campaign = (AM4_CONFIG.campaigns || []).filter(function(c) { return c.type === cType; })[0];
    if (!campaign) return;
    var durSel = panel.querySelector('[data-campaign-type="' + cType + '"][data-campaign-field="duration"]');
    var tierSel = panel.querySelector('[data-campaign-type="' + cType + '"][data-campaign-field="tier"]');
    if (!tierSel || !campaign.allowedTiers || campaign.allowedTiers.length <= 1) return;
    var dur = durSel ? durSel.value : campaign.duration;
    var prices = am4CampaignTierPrices(campaign, dur);
    var curTier = tierSel.value;
    var tiers = campaign.allowedTiers;
    var hasPrices = Object.keys(prices).length > 0;
    tierSel.style.width = (hasPrices ?'120px' : '56px');
    tierSel.innerHTML = tiers.map(function(t) {
        var priceLabel = prices[t] ? (t + ' - ' + prices[t]) : String(t);
        return"<option value='" + t +"'" + (String(curTier) === String(t) ?' selected' : '') + '>' +
            am4EscapeHtml(priceLabel) + '</option>';
    }).join('');
}

function buildSettingsPanel() {
    var old = document.getElementById("am4SettingsPanel");
    if (old) old.remove();
    var panel = document.createElement("div");
    panel.id ="am4SettingsPanel" ;
    var html = ["<h3><span>AM4 SUITE SETTINGS</span><span id='am4SettingsClose'>[X]</span></h3>"];
    AM4_SETTINGS_SCHEMA.forEach(function(item) {
        if (item.section) {
            html.push("<div class='am4-set-section'>" + item.section +"</div>");
            return;
        }
        var val = AM4_CONFIG[item.key];
        if (item.type === "bool") {
            html.push("<div class='am4-set-row'><label>" + item.label +"</label><input type='checkbox' data-key='" + item.key +"' data-type='bool'" + (val ? " checked" : "") +"></div>");
        } else if (item.type === "select") {
            var opts = item.options.map(function(o) {
                return"<option value='" + am4EscapeHtml(o[0]) +"'" + (String(val) === String(o[0]) ? " selected" : "") +">" + am4EscapeHtml(o[1]) +"</option>" ;
            }).join("");
            html.push("<div class='am4-set-row'><label>" + item.label +"</label><select data-key='" + item.key +"' data-type='" + (item.valueType || "int") +"'>" + opts +"</select></div>");
        } else if (item.type === "text") {
            html.push("<div class='am4-set-row'><label>" + item.label +"</label><input type='text' data-key='" + item.key +"' data-type='text' value='" + am4EscapeHtml(val == null ?'' : val) +"' placeholder='" + am4EscapeHtml(item.placeholder || '') +"' style='width:110px;'></div>");
        } else {
            var step = item.step || (item.type === "int" ? 1 :"any");
            html.push("<div class='am4-set-row'><label>" + item.label +"</label><input type='number' data-key='" + item.key +"' data-type='" + item.type +"' value='" + val +"' step='" + step +"'" +
                (typeof item.min !== "undefined" ? " min='" + item.min +"'" : "") +
                (typeof item.max !== "undefined" ? " max='" + item.max +"'" : "") +"></div>");
        }
    });
    html.push("<div class='am4-set-section'>CAMPAIGNS <button class='am4-btn am4-btn-mini' id='am4ScanCampaigns' style='float:right;'>scan from game</button></div>");
    html.push("<div class='am4-hub-hint'>Tick every campaign type you want (pax, cargo, charter, eco, brand, plus anything the game adds). Each ticked type is re-bought as soon as it runs out, using the strength and duration you pick here - Save &amp; Apply after changing them. Strength 1 is the cheapest. Press \"scan from game\" (or just open this panel once) to read the real types and durations off your Marketing page. Scan while no campaign is running: the game hides the duration list while one is active. Ad-reward campaigns are listed if found but never auto-bought. <span id='am4CampaignScanStatus' style='color:#38bdf8;'></span></div>");
    (AM4_CONFIG.campaigns || []).forEach(function(c, idx) {
        var cType = am4EscapeHtml(String(c.type));
        var isPoints = (c.resourceKind === 'points');
        html.push("<div class='am4-set-row' style='margin-top:9px;'>" +
            "<input type='checkbox' data-campaign-idx='" + idx +"' data-campaign-type='" + cType +"' data-campaign-field='enabled'" + (c.enabled ? " checked" : "") +">" +
            "<label style='color:#e2e8f0;'>" + am4EscapeHtml(c.label) +
            " <span style='color:#64748b;'>(type=" + am4EscapeHtml(c.type) +")</span>" +
            (isPoints ? "<span class='am4-points-tag'>POINTS</span>" : "") +
            "</label></div>");
        if (c.description) {
            html.push("<div style='padding-left:22px; font-size:10px; color:#94a3b8; line-height:1.35; margin-bottom:3px;'>" +
                am4EscapeHtml(c.description) +"</div>");
        }
        if (isPoints) {
            html.push("<div class='am4-campaign-warn'>Paid with points, not cash - points are bought with real money. " +
                "Nothing here spends them unless you tick this box yourself.</div>");
        }
        var prices = am4CampaignTierPrices(c, c.duration);
        // Render exactly the strengths and durations the game really offers. The panel
        // used to print a fixed 1-4 / 4-24 h grid, which offered choices that do not
        // exist (Brand Marketing has three strengths and sells 4 or 7 DAYS).
        var tiers = (c.allowedTiers && c.allowedTiers.length) ? c.allowedTiers : [1];
        var tierOpts = tiers.map(function(t) {
            var priceLabel = prices[t] ? (t +" - " + prices[t]) : String(t);
            return"<option value='" + t +"'" + (Number(c.tier) === Number(t) ? " selected" : "") +">" + am4EscapeHtml(priceLabel) +"</option>" ;
        }).join("");
        var options = (c.durationOptions && c.durationOptions.length) ? c.durationOptions : [];
        var durOpts = options.map(function(o) {
            return"<option value='" + am4EscapeHtml(String(o.value)) +"'" +
                (Number(c.duration) === Number(o.value) ? " selected" : "") +">" + am4EscapeHtml(o.label) +"</option>" ;
        }).join("");
        var hasPrices = Object.keys(prices).length > 0;
        var canPickDuration = c.hasDuration && options.length > 0;
        html.push("<div class='am4-set-row' style='padding-left:22px;'>" +
            "<span style='color:#94a3b8;'>strength</span>" +
            (tiers.length > 1
                ? "<select style='width:" + (hasPrices ? "120px" :"56px") +";' data-campaign-idx='" + idx +"' data-campaign-type='" + cType +"' data-campaign-field='tier'>" + tierOpts +"</select>" 
                :"<span style='color:#64748b;'>n/a</span>") +
            "<span style='color:#94a3b8;'>duration</span>" +
            (canPickDuration
                ? "<select style='width:118px;' data-campaign-idx='" + idx +"' data-campaign-type='" + cType +"' data-campaign-field='duration'>" + durOpts +"</select>" 
                :"<span style='color:#64748b;'>" + (c.hasDuration ? "unknown - scan" : ("fixed " + (Number(c.fixedHours) || 12) +" h")) +"</span>") +
            "</div>");
        if (c.hasDuration && options.length === 0) {
            html.push("<div class='am4-campaign-warn'>Its length is not known yet, so the bot polls at the normal " +
                "interval instead of sleeping until it expires. Press \"scan from game\" while this campaign is NOT running.</div>");
        }
    });
    html.push("<div class='am4-set-section'>BEST HUB LISTS <button class='am4-btn am4-btn-mini' id='am4HubReset' style='float:right;'>restore defaults</button></div>");
    html.push("<div class='am4-hub-hint'>One entry per line. Accents, capitals, hyphens and punctuation are ignored when matching, so \"Sao Paulo Guarulhos\" also finds \"São Paulo Guarulhos\". Countries must match the whole dropdown entry; airports also match as part of a longer name. Countries get highlighted in the country dropdown, airports get the ⭐ [BEST HUB] tag.</div>");
    html.push("<div class='am4-set-row'><label>Elite Countries (" + AM4_CONFIG.eliteCountries.length +")</label></div>");
    html.push("<textarea id='am4EliteCountries'></textarea>");
    html.push("<div class='am4-set-row'><label>High-Yield Airports (" + AM4_CONFIG.highYieldAirports.length +")</label></div>");
    html.push("<textarea id='am4HighYieldAirports'></textarea>");
    html.push("<div class='am4-btn-row'><button class='am4-btn am4-btn-reset' id='am4ResetAll'>Reset all</button><button class='am4-btn am4-btn-save' id='am4SaveSettings'>Save & Apply</button></div>");
    panel.innerHTML = html.join("");
    // Fill the list textareas via .value (never innerHTML) so entries can neither break
    // out of the textarea nor get entity-decoded on each rebuild
    panel.querySelector("#am4EliteCountries").value = AM4_CONFIG.eliteCountries.join("\n");
    panel.querySelector("#am4HighYieldAirports").value = AM4_CONFIG.highYieldAirports.join("\n");
    document.body.appendChild(panel);

    document.getElementById("am4SettingsClose").addEventListener("click", function() {
        panel.style.display ="none" ;
    });
    document.getElementById("am4SaveSettings").addEventListener("click", applySettingsFromPanel);
    document.getElementById("am4ScanCampaigns").addEventListener("click", function() {
        //"scan" is a READ. It must not commit anything to localStorage and must not
        // restart the renewal cycle (which could immediately buy a campaign). Edits
        // typed in the panel are carried across the rebuild in the DOM instead.
        scanMarketingCampaigns();
    });
    panel.querySelectorAll('[data-campaign-field="duration"]').forEach(function(sel) {
        sel.addEventListener('change', function() {
            am4RefreshCampaignTierSelect(parseInt(this.getAttribute('data-campaign-type'), 10));
        });
    });
    document.getElementById("am4HubReset").addEventListener("click", function() {
        document.getElementById("am4EliteCountries").value = AM4_DEFAULT_CONFIG.eliteCountries.join("\n");
        document.getElementById("am4HighYieldAirports").value = AM4_DEFAULT_CONFIG.highYieldAirports.join("\n");
    });
    document.getElementById("am4ResetAll").addEventListener("click", function() {
        AM4_CONFIG = JSON.parse(JSON.stringify(AM4_DEFAULT_CONFIG));
        saveAm4Config();
        // The reset rewrote which campaigns are ticked, so the renewal cycle has to be
        // rebuilt from it - otherwise ticked campaigns would have no timer at all. The
        // runID bump inside clearCampaignTimers also kills any purchase still in flight.
        clearCampaignTimers();
        var resetMktCb = document.getElementById("autoMarketingCheckbox");
        if (resetMktCb && resetMktCb.checked) startCampaignRenewal();
        resetHubHighlights();
        buildFinancialOverlay();
        var scrollPos = panel.scrollTop;
        var newPanel = buildSettingsPanel();
        newPanel.style.display ="block" ;
        newPanel.scrollTop = scrollPos;
        console.log("[AM4 Bot Log] Settings reset to defaults.");
    });
    am4PanelChrome(panel,'settings');
    return panel;
}

// Captures what is currently typed into the panel without committing it, so a
// rebuild (e.g. after a scan) does not throw the user's unsaved work away.
// Campaign rows are keyed by campaign TYPE, never by position - the scan reorders
// and resizes that list.
function am4SnapshotPanelEdits() {
    var panel = document.getElementById("am4SettingsPanel");
    if (!panel) return null;
    var snap = { fields: [], campaigns: [], elite: null, airports: null };
    panel.querySelectorAll("[data-key]").forEach(function(input) {
        snap.fields.push([input.getAttribute("data-key"), input.type === "checkbox" ? input.checked : input.value]);
    });
    panel.querySelectorAll("[data-campaign-type]").forEach(function(input) {
        snap.campaigns.push([
            input.getAttribute("data-campaign-type"),
            input.getAttribute("data-campaign-field"),
            input.type === "checkbox" ? input.checked : input.value
        ]);
    });
    var elite = panel.querySelector("#am4EliteCountries");
    var airports = panel.querySelector("#am4HighYieldAirports");
    if (elite) snap.elite = elite.value;
    if (airports) snap.airports = airports.value;
    return snap;
}

function am4RestorePanelEdits(panel, snap) {
    if (!panel || !snap) return;
    snap.fields.forEach(function(pair) {
        var input = panel.querySelector('[data-key="' + pair[0] + '"]');
        if (!input) return;
        if (input.type === "checkbox") input.checked = !!pair[1];
        else input.value = pair[1];
    });
    (snap.campaigns || []).forEach(function(row) {
        var input = panel.querySelector('[data-campaign-type="' + row[0] + '"][data-campaign-field="' + row[1] + '"]');
        if (!input) return; // control no longer exists (e.g. campaign became fixed-duration)
        if (input.type === "checkbox") input.checked = !!row[2];
        else input.value = row[2];
    });
    if (snap.elite !== null) {
        var elite = panel.querySelector("#am4EliteCountries");
        if (elite) elite.value = snap.elite;
    }
    if (snap.airports !== null) {
        var airports = panel.querySelector("#am4HighYieldAirports");
        if (airports) airports.value = snap.airports;
    }
}

var am4CampaignScanAttempted = false;

function toggleSettingsPanel() {
    var panel = document.getElementById("am4SettingsPanel");
    if (panel && panel.style.display === "block") {
        panel.style.display ="none" ;
        return;
    }
    // Rebuild from AM4_CONFIG on every open so edits discarded via [X] never reappear
    buildSettingsPanel().style.display ="block" ;
    // The shipped list is only the known cash/points types. Opening Settings once
    // reads marketing.php so Charter and any extra types the game added actually
    // appear, instead of staying stuck on four rows.
    if (!am4CampaignScanAttempted) {
        am4CampaignScanAttempted = true;
        scanMarketingCampaigns();
    }
}

function applySettingsFromPanel() {
    var panel = document.getElementById("am4SettingsPanel");
    if (!panel) return;
    var prevOverlayEnabled = AM4_CONFIG.overlayEnabled;
    var prevOverlayPosition = AM4_CONFIG.overlayPosition;
    var prevCampaignsJson = JSON.stringify(AM4_CONFIG.campaigns || []);
    panel.querySelectorAll("[data-key]").forEach(function(input) {
        var key = input.getAttribute("data-key");
        var type = input.getAttribute("data-type");
        if (type === "bool") {
            AM4_CONFIG[key] = !!input.checked;
            return;
        }
        if (type === "string") {
            AM4_CONFIG[key] = input.value;
            return;
        }
        if (type === "text") {
            // The only text field is the alliance member id - keep it digits-only
            AM4_CONFIG[key] = String(input.value || '').replace(/[^0-9]/g,'').slice(0, 12);
            return;
        }
        var num = parseFloat(input.value);
        if (isNaN(num)) return; // keep previous value on invalid input
        if (input.min !== "" && !isNaN(parseFloat(input.min))) num = Math.max(num, parseFloat(input.min));
        if (input.max !== "" && !isNaN(parseFloat(input.max))) num = Math.min(num, parseFloat(input.max));
        AM4_CONFIG[key] = (type === "int") ? Math.round(num) : num;
    });
    var parseList = function(id) {
        return document.getElementById(id).value.split("\n")
            .map(function(s) { return s.trim(); })
            .filter(function(s) { return s.length > 0; });
    };
    // Keyed by campaign TYPE, not by row position - a scan reorders and resizes that
    // list, so an index could write one campaign's strength onto another one.
    panel.querySelectorAll("[data-campaign-type]").forEach(function(input) {
        var cType = parseInt(input.getAttribute("data-campaign-type"), 10);
        var field = input.getAttribute("data-campaign-field");
        var campaign = (AM4_CONFIG.campaigns || []).filter(function(c) { return c.type === cType; })[0];
        if (!campaign) return;
        if (field === "enabled") {
            campaign.enabled = !!input.checked;
        } else if (field === "duration") {
            var d = parseInt(input.value, 10);
            // Only values the game actually offers may be stored - otherwise a stale
            // selection survives a scan and builds a d= the game may reject
            var allowed = (campaign.durationOptions || []).map(function(o) { return Number(o.value); });
            if (!isNaN(d) && (allowed.length === 0 || allowed.indexOf(d) !== -1)) campaign.duration = d;
        } else if (field === "tier") {
            var t = parseInt(input.value, 10);
            var tiers = (campaign.allowedTiers && campaign.allowedTiers.length) ? campaign.allowedTiers : [1];
            if (!isNaN(t) && tiers.indexOf(t) !== -1) campaign.tier = t;
        }
    });
    AM4_CONFIG.eliteCountries = parseList("am4EliteCountries");
    AM4_CONFIG.highYieldAirports = parseList("am4HighYieldAirports");
    saveAm4Config();
    // A changed quiet-hours setting should reflect in the badge immediately. The
    // schedulers pick the new window up on their next tick on their own.
    am4UpdateQuietBadge();
    resetHubHighlights();
    // Only rebuild the overlay when something it renders actually changed - an
    // unconditional rebuild blanks the live metrics until the next 10s tick
    if (AM4_CONFIG.overlayEnabled !== prevOverlayEnabled ||
        AM4_CONFIG.overlayPosition !== prevOverlayPosition ||
        (AM4_CONFIG.overlayEnabled && !document.getElementById('am4FinancialMetricsDashboard'))) {
        buildFinancialOverlay();
    }
    // Campaign edits change what the renewal cycle should be watching
    var mktCb = document.getElementById("autoMarketingCheckbox");
    if (mktCb && mktCb.checked && JSON.stringify(AM4_CONFIG.campaigns || []) !== prevCampaignsJson) {
        startCampaignRenewal();
    }
    // A changed member id / interval / re-enabled overlay should refresh the alliance read now
    am4RefreshAllianceMetrics();
    // Likewise refresh the honest 24h income/expenses/net (interval or overlay may have changed)
    am4RefreshFinanceMetrics();
    var scrollPos = panel.scrollTop;
    var newPanel = buildSettingsPanel();
    newPanel.style.display ="block" ;
    newPanel.scrollTop = scrollPos;
}

function resetHubHighlights() {
    // Restores the game's own inline styles rather than blanking them. Emptying the
    // properties also wiped whatever colour the game itself had set on that element.
    document.querySelectorAll(".bot-premium-hub-painted").forEach(function(el) {
        el.classList.remove("bot-premium-hub-painted");
        el.style.backgroundColor = el.dataset.am4PrevBg || "" ;
        el.style.border = el.dataset.am4PrevBorder || "" ;
        el.style.color = el.dataset.am4PrevColor || "" ;
        el.style.fontWeight = el.dataset.am4PrevWeight || "" ;
        delete el.dataset.am4PrevBg;
        delete el.dataset.am4PrevBorder;
        delete el.dataset.am4PrevColor;
        delete el.dataset.am4PrevWeight;
    });
    document.querySelectorAll(".bot-premium-airport-tagged").forEach(function(opt) {
        opt.classList.remove("bot-premium-airport-tagged");
        if (opt.dataset.am4OrigText) opt.textContent = opt.dataset.am4OrigText;
        opt.style.backgroundColor = opt.dataset.am4PrevBg || "" ;
        opt.style.color = opt.dataset.am4PrevColor || "" ;
        opt.style.fontWeight = opt.dataset.am4PrevWeight || "" ;
        delete opt.dataset.am4OrigText;
        delete opt.dataset.am4PrevBg;
        delete opt.dataset.am4PrevColor;
        delete opt.dataset.am4PrevWeight;
    });
    document.body.classList.remove("market-shortlist-logged");
}

function setupClosePopProtection() {
    console.log("[AM4 Bot Log] Safety loop initialized using a decoupled background click interceptor.");
    // The game may only define closePop after we loaded. Capture it then - but never
    // accept a function this suite installed itself.
    if (!am4NativeClosePop && typeof window.closePop === 'function' && !window.closePop.__am4Wrapper) {
        am4NativeClosePop = window.closePop;
    }
    var wrapper = function() {
        if (am4MaintOwner) {
            console.log("[AM4 Bot Log] Auto-" + (am4MaintOwner === 'repair' ?'Repair' : 'Check') +
                " is working inside this popup - close blocked until it finishes.");
            return;
        }
        am4CloseGamePopup();
    };
    wrapper.__am4Wrapper = true;
    window.closePop = wrapper;
    // Kept only so third-party code that reads window.originalClosePop still finds
    // the native function. Nothing in this suite reads it back.
    window.originalClosePop = am4NativeClosePop;

    document.addEventListener('click', function(event) {
        if (!am4MaintOwner) return;
        var targetedElement = event.target;
        if (targetedElement && (targetedElement.closest('.close') || targetedElement.closest('[data-dismiss="modal"]'))) {
            event.stopImmediatePropagation();
            event.preventDefault();
            console.log("[AM4 Bot Log] Close action intercepted during active automated maintenance task.");
        }
    }, true);
}

//================================================================================
// Parts 5 & 6 of 13: Core Control Background Timers & Background Evaluators
//================================================================================
function autoDepartRoutine() {
    // Clear any existing timers first to prevent multiple stacked threads
    clearTimeout(autoDepartTimeoutID);

    // Quiet hours: skip entirely and re-check near the window's end (no request goes out)
    if (am4InQuietHours()) {
        autoDepartTimeoutID = setTimeout(autoDepartRoutine, am4QuietRescheduleMs());
        return;
    }

    var cb = document.getElementById("autoDepartCheckbox");
    if (cb && cb.checked) {
        if (am4DepartChainActive) {
            // A long queue can take longer than one interval - never stack two chains
            am4SetStatus('depart', { state: 'running', note: 'previous batch still running - skipped this cycle'});
            console.log("[AM4 Bot Log] Previous departure chain still running - skipping this cycle.");
        } else {
            console.log("[AM4 Bot Log] Initializing departure sequence...");
            am4DepartChainActive = true;
            am4ShowLiveAction('🛫 Departing aircraft…','#38bdf8');
            executeDepartAllAction(0, ++am4DepartRunID);
        }
    }

    // Unconditionally reschedule the loop (configurable interval + jitter), so it repeats forever
    var departWait = am4Jitter(AM4_CONFIG.departIntervalMin * 60 * 1000);
    am4SetStatus('depart', { next: Date.now() + departWait, at: am4Status.depart.at });
    autoDepartTimeoutID = setTimeout(autoDepartRoutine, departWait);
}

// Departs one server batch and reports how many aircraft actually left.
//
// Native Depart All is`Ajax('route_depart.php?mode=all&ids=x','runme',this)` — the
// response scripts move each row from #landedList to #inflightList via
// flightStatusChange(). We fire that same GET (not a fake click: the page reports
// untrusted clicks) and then inject the body into #runme so the Landed tab updates
// live. #listDepartAmount is a static summary the game never refreshes itself, so
// we still count`removeFromArray(flightData, …)` / flightStatusChange() in the
// body to know whether another ~20-plane batch remains.
function am4CountDepartures(responseText) {
    var html = responseText || '';
    var m = html.match(/removeFromArray\(\s*flightData,/g);
    if (m && m.length) return m.length;
    m = html.match(/flightStatusChange\(\s*\d+\s*,\s*['\"]inflight['\"]/g);
    if (m && m.length) return m.length;
    // No per-plane cleanup at all: either nothing was ready, or this was not a real
    // depart response (logged out / error page). Both mean"stop" , so 0 is correct.
    return 0;
}

function am4DepartOneBatch(runID, onResult) {
    var settled = false;
    var finish = function(count, note, body) {
        if (settled) return;
        settled = true;
        if (runID === am4DepartRunID) onResult(count, note, body || '');
    };
    var fb = (typeof window.fbSig !== 'undefined' && window.fbSig != null) ? String(window.fbSig) : '';
    var query = 'mode=all&ids=x&fbSig=' + encodeURIComponent(fb);
    var jq = (typeof window.jQuery !== 'undefined' && window.jQuery.ajax) ? window.jQuery
        : ((typeof window.$ !== 'undefined' && window.$.ajax) ? window.$ : null);
    // Same contract as the game's Depart button: GET route_depart.php into #runme.
    // We do NOT click the button — the page flags untrusted clicks (def227_j22.php).
    if (jq) {
        jq.ajax({
            type: 'GET',
            url: 'route_depart.php',
            data: query,
            cache: false,
            dataType: 'html',
            timeout: 25000,
            success: function (a) {
                finish(am4CountDepartures(a), null, a == null ?'' : String(a));
            },
            error: function (xhr) {
                if (xhr && xhr.status === 200) {
                    var body = xhr.responseText == null ?'' : String(xhr.responseText);
                    finish(am4CountDepartures(body), null, body);
                    return;
                }
                finish(-1, (xhr && xhr.status) ? ('HTTP ' + xhr.status) : 'network error','');
            }
        });
        return;
    }
    var xhr = new XMLHttpRequest();
    xhr.timeout = 25000;
    xhr.ontimeout = function() { finish(-1,'timed out'); };
    xhr.onerror = function() { finish(-1,'network error'); };
    xhr.onreadystatechange = function() {
        if (xhr.readyState !== 4 || settled) return;
        if (xhr.status !== 200) { finish(-1,'HTTP ' + xhr.status); return; }
        finish(am4CountDepartures(xhr.responseText), null, xhr.responseText);
    };
    xhr.open('GET','route_depart.php?' + query + '&_=' + Date.now(), true);
    xhr.setRequestHeader('X-Requested-With','XMLHttpRequest');
    xhr.send();
}

// Departs batch after batch until the server launches nothing more, the cap is hit,
// or the toggle/funds/lease say stop. runID is the generation token - every hop
// re-checks it, so flipping the toggle off aborts an in-flight chain immediately.
function executeDepartAllAction(batchIndex, runID) {
    var batch = batchIndex || 0;
    var stop = function(msg) {
        if (msg) console.log("[AM4 Bot Log] " + msg);
        if (runID === am4DepartRunID) am4DepartChainActive = false;
    };
    if (runID !== am4DepartRunID) return;
    var departCb = document.getElementById("autoDepartCheckbox");
    if (!departCb || !departCb.checked || isBotPausedDueToFunds) {
        stop("Departure chain aborted: toggle off or bot paused on funds.");
        return;
    }
    if (!am4CanMutate()) {
        stop("Departure skipped: another AM4 tab is the acting tab.");
        return;
    }
    if (batch >= AM4_CONFIG.departMaxBatches) {
        stop("Departure batch cap (" + AM4_CONFIG.departMaxBatches +") reached - more may remain, resuming next cycle.");
        return;
    }

    am4DepartOneBatch(runID, function(count, note, body) {
        if (runID !== am4DepartRunID) return;
        if (count < 0) {
            am4SetStatus('depart', { state: 'error', note: 'request failed: ' + note });
            am4ShowLiveAction('🛫 Depart failed: ' + note,'#ef4444');
            stop("Departure request failed (" + note +") - stopping this cycle, retrying next interval.");
            return;
        }
        if (count === 0) {
            am4SetStatus('depart', { state: 'idle', note: batch === 0
                ?'nothing ready to depart' 
                : 'all ready aircraft dispatched (' + batch + ' batch' + (batch === 1 ?'' : 'es') + ')'});
            if (batch === 0) am4ShowLiveAction('🛫 Nothing ready to depart','#94a3b8');
            else am4ShowLiveAction('🛫 All ready aircraft dispatched','#10b981');
            stop(batch === 0
                ? "Departure check: nothing ready to depart right now." 
                :"Departure queue empty after " + batch +" batch(es) - all ready aircraft dispatched.");
            return;
        }
        am4ApplyDepartClientVisual(body, count);
        am4SetStatus('depart', { state: 'running', note: 'dispatched ' + count + ' (batch ' + (batch + 1) + '), checking for more'});
        console.log("[AM4 Bot Log] Dispatched " + count +" aircraft (batch " + (batch + 1) +") - checking for more.");
        am4LogAction('depart','🛫 Departed ' + count + ' aircraft');
        setTimeout(function() {
            executeDepartAllAction(batch + 1, runID);
        }, am4Jitter(AM4_CONFIG.departBatchDelaySec * 1000));
    });
}

// marketing_new.php?type=<category>&c=<strength 1-4>&mode=do&d=<duration 1-6>
// Eco (type 5) takes no d= and requires the constant c=1.
function buildCampaignUrl(c) {
    var url = 'marketing_new.php?type=' + c.type + '&c=' + (c.hasDuration ? c.tier : 1) + '&mode=do';
    if (c.hasDuration) url +='&d=' + c.duration;
    return url;
}

// The duration option currently selected for this campaign, as the game defines it.
// There is no global formula: one step means 4 hours for the cash campaigns but 4 or
// 7 DAYS for Brand Marketing, so the hours always come from the campaign's own list.
function campaignSelectedDuration(c) {
    var options = Array.isArray(c.durationOptions) ? c.durationOptions : [];
    for (var i = 0; i < options.length; i++) {
        if (Number(options[i].value) === Number(c.duration)) return options[i];
    }
    return options.length ? options[0] : null;
}

function campaignDurationHours(c) {
    if (!c.hasDuration) return 'fixed (' + (Number(c.fixedHours) || 12) + ' h)';
    var option = campaignSelectedDuration(c);
    return option ? option.label : (c.duration + ' (unknown length)');
}

// Loading marketing_new.php WITHOUT mode=do only opens the campaign panel - it does
// not spend anything. That preview is what checkAndRenewCampaign() uses to see
// whether a campaign of this category is still running.
// How long a campaign of this kind runs, in hours
function campaignExpectedHours(c) {
    if (!c.hasDuration) return Number(c.fixedHours) || 12;
    var option = campaignSelectedDuration(c);
    if (option && isFinite(Number(option.hours)) && Number(option.hours) > 0) return Number(option.hours);
    // No known length: fall back to polling at the normal interval rather than
    // inventing a sleep that could leave the airline uncovered for a day.
    return 0;
}

function clearCampaignTimers() {
    am4CampaignRunID++; // anything already waiting on a reply is now stale
    Object.keys(am4CampaignTimers).forEach(function(t) { clearTimeout(am4CampaignTimers[t]); });
    am4CampaignTimers = {};
}

// True only if buying this campaign is still what the user wants, right now
function campaignStillWanted(campaign, runID) {
    if (runID !== am4CampaignRunID) return false;
    var cb = document.getElementById("autoMarketingCheckbox");
    if (!cb || !cb.checked) return false;
    if (!campaign || !campaign.enabled) return false;
    if (isBotPausedDueToFunds) return false;
    return true;
}

//`exact` marks a delay that comes from a campaign's own runtime. A percentage
// jitter on a 24 h sleep would be +/- 6 hours, which would leave the airline
// without a campaign for hours - the exact thing this design avoids. Those get a
// small additive margin instead, and are never shortened.
function scheduleCampaignCheck(type, delayMs, why, exact) {
    clearTimeout(am4CampaignTimers[type]);
    var wait = exact ? (delayMs + am4RandomDelay(60000, 600000)) : am4Jitter(delayMs);
    am4CampaignTimers[type] = setTimeout(function() { checkAndRenewCampaign(type); }, wait);
    // Every campaign transition passes through here with a human'why' - a single,
    // reliable place to reflect marketing into the status dashboard.
    am4SetStatus('marketing', {
        state: /blocked/i.test(why) ?'paused' : (/active|waiting|confirmed/i.test(why) ?'waiting' : 'running'),
        note: 'type ' + type + ': ' + why,
        next: Date.now() + wait
    });
    var mins = Math.round(wait / 60000);
    console.log('[AM4 Bot Log] Next campaign check for type ' + type + ' in ' +
        (mins >= 60 ? (mins / 60).toFixed(1) + ' h' : mins + ' min') + ' (' + why + ')');
}

// Each enabled campaign is renewed as soon as it has run out: the panel is loaded
// (a preview, which buys nothing), and when it shows no active campaign the purchase
// goes out. After buying, the next check is simply scheduled for when that campaign
// ends, so there is no constant polling while one is running.
function checkAndRenewCampaign(type) {
    var runID = am4CampaignRunID;
    var campaign = (AM4_CONFIG.campaigns || []).filter(function(c) { return c.type === type; })[0];
    if (!campaignStillWanted(campaign, runID)) return; // toggle off / unticked - let the chain die

    // Quiet hours: defer the campaign check/renewal until the window ends (no request)
    if (am4InQuietHours()) {
        scheduleCampaignCheck(type, am4QuietRescheduleMs(),'quiet hours');
        return;
    }

    // Campaigns cost millions, so honour the low-funds brake here too. The
    // maintenance loops are the only other place that raises it, and they may be off.
    if (checkAccountBalanceToastSafety()) {
        scheduleCampaignCheck(type, AM4_CONFIG.campaignCheckMin * 60 * 1000,'bot paused on low funds');
        return;
    }

    var x = new XMLHttpRequest();
    var xRetryMs = AM4_CONFIG.campaignCheckMin * 60 * 1000;
    var xSettled = false;
    // Without a timeout a stalled response (proxy holding the socket, laptop
    // suspend/resume) would leave THIS type with no timer at all - the one-shot that
    // started this check has already fired - so the campaign would silently never be
    // renewed again. Reschedule on timeout/error like every other request here.
    x.timeout = 20000;
    x.ontimeout = function() {
        if (xSettled) return;
        xSettled = true;
        console.log('[AM4 Bot Log] Campaign check for type ' + type + ' timed out - re-checking shortly.');
        if (runID === am4CampaignRunID) scheduleCampaignCheck(type, xRetryMs,'check timed out');
    };
    x.onerror = function() {
        if (xSettled) return;
        xSettled = true;
        if (runID === am4CampaignRunID) scheduleCampaignCheck(type, xRetryMs,'check errored');
    };
    x.onreadystatechange = function() {
        if (x.readyState !== 4 || xSettled) return;
        xSettled = true;
        var retryMs = xRetryMs;

        // Re-resolve from the live config: a scan may have replaced the whole array
        // while this request was in flight, and the decision must use current values
        var live = (AM4_CONFIG.campaigns || []).filter(function(c) { return c.type === type; })[0];
        if (live) campaign = live;

        // The reply can land after the user switched the toggle off or the funds
        // brake engaged. Never buy on a stale decision.
        if (!campaignStillWanted(campaign, runID)) {
            console.log('[AM4 Bot Log] Discarding campaign result for type ' + type +
                ' - switched off, unticked or paused while the panel was loading.');
            return;
        }
        if (x.status !== 200) {
            console.log('[AM4 Bot Log] Campaign check failed (HTTP ' + x.status + ') for ' + campaign.label + '.');
            scheduleCampaignCheck(type, retryMs,'request failed');
            return;
        }
        var body = x.responseText || '';
        var state = am4CampaignPanelState(body);
        if (state === 'active') {
            console.log('[AM4 Bot Log] Still running, not re-buying: ' + campaign.label);
            scheduleCampaignCheck(type, retryMs,'still active');
            return;
        }
        // HTTP 200 is not proof that this IS the campaign panel. A login page, a
        // maintenance page or an interstitial answers 200 too and contains none of
        // the wording above - so"expired" would be concluded from a page that never
        // showed a campaign, and millions spent on it.
        if (state !== 'idle') {
            console.log('[AM4 Bot Log] Panel for ' + campaign.label +
                ' answered but was not a readable campaign page (logged out / maintenance?) - not buying, re-checking shortly.');
            scheduleCampaignCheck(type, retryMs,'panel not recognised');
            return;
        }
        // Only the acting tab buys - a second tab would buy the same campaign again
        if (!am4CanMutate()) {
            scheduleCampaignCheck(type, retryMs,'another tab is the acting tab');
            return;
        }
        // Double-buy guard: if this type was bought moments ago (e.g. the cycle was
        // torn down and restarted while the first purchase was still settling on the
        // server), do not buy again - let the verify pass confirm the first one.
        if (am4CampaignLastBuyAt[type] && (Date.now() - am4CampaignLastBuyAt[type]) < 90000) {
            console.log('[AM4 Bot Log] ' + campaign.label + ' was just bought - not buying again, verifying instead.');
            am4VerifyCampaignStarted(type, runID, campaign.label, campaignExpectedHours(campaign));
            return;
        }
        // Spend guard 1 (A5): never auto-spend POINTS while the master switch is on.
        // Points are bought with real money, so this fails closed regardless of the tick.
        if (campaign.resourceKind === 'points' && AM4_CONFIG.neverSpendPoints) {
            console.log('[AM4 Bot Log] BLOCKED buying ' + campaign.label + ' - it costs points and "never spend points" is on.');
            scheduleCampaignCheck(type, retryMs,'blocked: never-spend-points');
            return;
        }
        if (campaign.resourceKind === 'ads') {
            console.log('[AM4 Bot Log] BLOCKED buying ' + campaign.label + ' - ad-reward campaigns are not auto-bought.');
            scheduleCampaignCheck(type, retryMs,'blocked: ad campaign');
            return;
        }
        // Spend guard 2 (A5): cash campaign daily cap. Fail closed if the rolling 24 h
        // spend already exceeds the cap, or if this purchase's estimated cost would.
        var boughtCost = (campaign.resourceKind === 'points') ? 0 : (am4ParseMoneyStr(am4CampaignTierPrices(campaign, campaign.duration)[campaign.tier]) || 0);
        var dayCap = Number(AM4_CONFIG.maxCampaignSpendPerDay) || 0;
        if (campaign.resourceKind !== 'points' && dayCap > 0 && (am4CampaignSpent24h() + boughtCost) > dayCap) {
            console.log('[AM4 Bot Log] BLOCKED buying ' + campaign.label + ' - would exceed the $' + dayCap.toLocaleString() +
                '/day campaign cap (already $' + am4CampaignSpent24h().toLocaleString() + ' in the last 24 h).');
            scheduleCampaignCheck(type, retryMs,'blocked: daily campaign cap reached');
            return;
        }

        // Snapshot what is actually being bought - the user may edit the settings
        // while the purchase is in flight, and the sleep must match the real campaign
        var boughtHours = campaignExpectedHours(campaign);
        var boughtLabel = campaign.label;
        console.log('[AM4 Bot Log] Campaign expired - buying ' + boughtLabel +
            ' (strength ' + (campaign.hasDuration ? campaign.tier : 'n/a') + ', ' + campaignDurationHours(campaign) + ')' +
            (campaign.resourceKind === 'points' ?' - THIS ONE COSTS POINTS, not cash.' : ''));
        am4CampaignLastBuyAt[type] = Date.now();
        call(buildCampaignUrl(campaign), 0, function(responseText) {
            if (runID !== am4CampaignRunID) return; // cycle was torn down meanwhile
            // A refused purchase still comes back as HTTP 200 with an error in the
            // body, so do not start the long sleep on those - keep the short re-check
            if (/too low|not enough|insufficient|cannot afford|denied|error/i.test(responseText || '')) {
                console.log('[AM4 Bot Log] Purchase of ' + boughtLabel + ' looks refused by the game - re-checking shortly.');
                scheduleCampaignCheck(type, retryMs,'purchase refused');
                return;
            }
            // Purchase looks accepted: record its cash cost against the rolling daily cap.
            if (boughtCost > 0) am4LogCampaignSpend(boughtCost);
            // HTTP 200 still is not proof the campaign started. Sleeping for its full
            // runtime on an unverified purchase is the worst case: the airline runs
            // uncovered for up to a day while the log claims it was bought.
            am4VerifyCampaignStarted(type, runID, boughtLabel, boughtHours);
        });
        // Safety net in case the purchase request never comes back at all
        scheduleCampaignCheck(type, retryMs,'purchase sent, verifying');
    };
    x.open('GET','marketing_new.php?type=' + type + '&_=' + Date.now(), true);
    x.send();
}

// Reads the panel back after a purchase and only commits to the long"sleep until it 
// expires" once the game itself reports a running campaign.
function am4VerifyCampaignStarted(type, runID, label, hours) {
    setTimeout(function() {
        if (runID !== am4CampaignRunID) return;
        var retryMs = AM4_CONFIG.campaignCheckMin * 60 * 1000;
        var v = new XMLHttpRequest();
        var vSettled = false;
        // A hung verify request must not leave this type without a timer either.
        v.timeout = 20000;
        var vFail = function(why) {
            if (vSettled) return;
            vSettled = true;
            if (runID === am4CampaignRunID) scheduleCampaignCheck(type, retryMs, why);
        };
        v.ontimeout = function() { vFail('verify timed out'); };
        v.onerror = function() { vFail('verify errored'); };
        v.onreadystatechange = function() {
            if (v.readyState !== 4 || vSettled) return;
            if (runID !== am4CampaignRunID) { vSettled = true; return; }
            vSettled = true;
            if (v.status !== 200) {
                scheduleCampaignCheck(type, retryMs,'could not verify the purchase');
                return;
            }
            if (am4CampaignPanelState(v.responseText) !== 'active') {
                console.log('[AM4 Bot Log] ' + label + ' does not show as running after the purchase - ' +
                    'not sleeping, re-checking shortly.');
                scheduleCampaignCheck(type, retryMs,'purchase not confirmed');
                return;
            }
            am4LogAction('marketing','📣 Campaign bought: ' + label + (hours > 0 ?' (' + hours + 'h)' : ''));
            if (hours > 0) {
                console.log('[AM4 Bot Log] ' + label + ' confirmed running for ' + hours + ' h.');
                scheduleCampaignCheck(type, (hours * 60 * 60 * 1000) + 120000,'confirmed - waiting for it to run out', true);
            } else {
                // Length unknown (e.g. a scanned campaign whose options could not be
                // read). Poll normally instead of inventing a duration.
                scheduleCampaignCheck(type, retryMs,'confirmed, but its length is unknown - polling');
            }
        };
        v.open('GET','marketing_new.php?type=' + type + '&_=' + Date.now(), true);
        v.send();
    }, am4RandomDelay(6000, 15000));
}

// Starts one independent renewal cycle per enabled campaign, staggered so the first
// checks do not all leave at the same instant.
function startCampaignRenewal() {
    clearCampaignTimers();
    var enabled = (AM4_CONFIG.campaigns || []).filter(function(c) { return c.enabled; });
    if (enabled.length === 0) {
        console.log('[AM4 Bot Log] Auto-Buy Mktg is on but no campaign is ticked in the settings panel.');
        return;
    }
    var stagger = 0;
    enabled.forEach(function(c) {
        stagger += am4RandomDelay(1500, 6000);
        scheduleCampaignCheck(c.type, stagger,'initial check');
    });
}

// Extracts marketing_new.php parameters out of a chunk of the game's own HTML.
// Every hit is folded into the shared`found` map keyed by campaign type.
// A campaign panel that really loaded always offers at least one strength link
// (marketing_new.php...c=<n>). A login page, a maintenance page or a Cloudflare
// interstitial all answer HTTP 200 without one, and must never be allowed to
// overwrite hasDuration or the description.
function am4LooksLikeCampaignPanel(html) {
    var sandbox = document.createElement('div');
    sandbox.innerHTML = html || '';
    sandbox.querySelectorAll('script, style').forEach(function(el) { el.remove(); });
    var links = sandbox.querySelectorAll('[onclick*="marketing_new.php"], a[href*="marketing_new.php"]');
    for (var i = 0; i < links.length; i++) {
        // getAttribute returns the entity-DECODED value - exactly what the harvester
        // parses. Testing the raw HTML instead would reject a valid panel that writes
        // its links as href="...?type=1&amp;c=1&amp;d=6".
        var raw = links[i].getAttribute('onclick') || links[i].getAttribute('href') || '';
        if (/type=\d+/.test(raw) && /[?&]c=\d/.test(raw)) return true;
    }
    return false;
}

function am4LooksLikeAdCampaignPanel(html) {
    var sandbox = document.createElement('div');
    sandbox.innerHTML = html || '';
    sandbox.querySelectorAll('script, style').forEach(function(el) { el.remove(); });
    var text = (sandbox.textContent || '').replace(/\s+/g,' ').trim();
    if (!/watch\s*(an?\s*)?(ad|video)|video\s*boost|rewarded\s*ad|btnWatch/i.test(text)) return false;
    return /marketing_new\.php\?type=\d+/.test(html || '') ||
        !!sandbox.querySelector('[onclick*="marketing_new.php"], a[href*="marketing_new.php"], #btnWatch, .btnWatch');
}

function am4DedupeDurationOptions(options) {
    if (!Array.isArray(options) || !options.length) return [];
    var best = {};
    options.forEach(function(o) {
        if (!o || !isFinite(Number(o.value))) return;
        var hours = Number(o.hours) || 0;
        var key = hours > 0 ? ('h' + hours) : ('v' + o.value);
        var cur = best[key];
        if (!cur || Number(o.value) < Number(cur.value)) {
            best[key] = { value: Number(o.value), label: String(o.label || ''), hours: hours };
        } else if (o.label && String(o.label).length > String(cur.label).length) {
            cur.label = String(o.label);
        }
    });
    return Object.keys(best).map(function(k) { return best[k]; })
        .sort(function(a, b) { return (a.hours || a.value) - (b.hours || b.value); });
}

// What a campaign panel is telling us: 'active' (one is running),'idle' (nothing
// running, safe to buy) or'unknown' (not a campaign page at all - never buy).
//
// The old test was a bare /active campaign/ on raw HTML."No active campaign" 
// contains that phrase, so an idle page could read as busy; and any 200 response
// without the phrase read as idle, which is the expensive direction. Negatives are
// therefore matched first and anything unrecognised is treated as unknown.
function am4CampaignPanelState(html) {
    var sandbox = document.createElement('div');
    sandbox.innerHTML = html || '';
    sandbox.querySelectorAll('script, style').forEach(function(el) { el.remove(); });
    var text = (sandbox.textContent || '').replace(/\s+/g,' ').trim();

    if (/\b(no|not\s+any|none)\s+(currently\s+)?active\s+campaigns?/i.test(text)) return 'idle';
    if (/you\s+(already\s+)?have\s+an?\s+active\s+campaign/i.test(text)) return 'active';
    if (/campaign\s+is\s+(currently\s+)?(still\s+)?(active|running)/i.test(text)) return 'active';
    if (/active\s+campaigns?/i.test(text)) return 'active'; // ambiguous wording: assume busy

    // A campaign panel that really loaded always offers at least one strength link.
    // Ad-reward video boosts use watch-ad UI instead of c= strength buttons.
    if (am4LooksLikeCampaignPanel(html)) return 'idle';
    if (am4LooksLikeAdCampaignPanel(html)) return 'idle';
    return 'unknown';
}

function am4CleanText(node) {
    if (!node) return '';
    // The scan parses into a DETACHED div, where innerText behaves like textContent
    // (no layout, so no line breaks). Everything is therefore normalised explicitly
    // instead of relying on innerText's line splitting.
    return String(node.textContent || '').replace(/\s+/g,' ').trim();
}

// The direct text of an element, ignoring nested elements. On the Marketing overview
// the campaign NAME sits in a cell's own text node while the DESCRIPTION is a nested
// element right after it, so this is what separates"Eco-friendly" from the sentence
// glued behind it.
function am4OwnText(el) {
    if (!el) return '';
    var out = '';
    for (var i = 0; i < el.childNodes.length; i++) {
        if (el.childNodes[i].nodeType === 3) out += el.childNodes[i].textContent;
    }
    return out.replace(/\s+/g,' ').trim();
}

// Reads the Marketing overview table (marketing.php), where each campaign is one
// <tr onclick="...Ajax('marketing_new.php?type=N'...)"> with a clean name, its real
// description and a"From <price>" cell. The single-panel parser cannot separate the
// name from the description (the panel glues them together), so these authoritative
// values override whatever the panel produced.
function am4HarvestOverviewMeta(html, found) {
    var box = document.createElement('div');
    box.innerHTML = html;
    box.querySelectorAll('script, style').forEach(function(el) { el.remove(); });

    var applyMeta = function(host, raw) {
        var tm = String(raw || '').match(/marketing_new\.php\?type=(\d+)/) || String(raw || '').match(/[?&]type=(\d+)/);
        if (!tm) return;
        var type = parseInt(tm[1], 10);
        if (!found[type]) {
            found[type] = { type: type, label: '', description: '', tiers: [], durationOptions: [], tierPrices: {}, tierPricesByDuration: {}, resourceKind: 'cash'};
        }
        var entry = found[type];
        var name = '', description = '', price = '';
        var cells = host.querySelectorAll ? host.querySelectorAll('td') : [];
        if (cells.length) {
            for (var i = 0; i < cells.length; i++) {
                var own = am4OwnText(cells[i]);
                var full = am4CleanText(cells[i]);
                if (own && !name) {
                    name = own;
                    if (full.indexOf(own) === 0) description = full.slice(own.length).trim();
                    else if (full !== own) description = full;
                }
                if (!price && /\$|point/i.test(full)) price = full.replace(/^from\s*/i,'').trim();
            }
        } else {
            var heading = host.querySelector ? host.querySelector('h1,h2,h3,h4,h5,h6,.card-title,b,strong') : null;
            name = heading ? am4CleanText(heading).slice(0, 60) : am4OwnText(host).slice(0, 60);
            description = am4CleanText(host);
            if (name && description.indexOf(name) === 0) description = description.slice(name.length).trim();
            var priceMatch = description.match(/\$\s?[\d.,]+\s?[kmb]?|\d[\d.,]*\s*points?/i);
            if (priceMatch) price = priceMatch[0];
        }
        if (/watch\s*ad|watchVideo|rewarded\s*ad/i.test(raw + ' ' + description + ' ' + name)) {
            entry.resourceKind = 'ads';
        }
        if (name) entry.label = name;
        if (description) entry.description = description.slice(0, 320);
        if (price) {
            entry.fromPrice = price;
            if (/point/i.test(price)) entry.resourceKind = 'points';
        }
    };

    box.querySelectorAll('tr').forEach(function(tr) {
        var oc = tr.getAttribute('onclick') || '';
        var link = tr.querySelector('[onclick*="marketing_new.php"], a[href*="marketing_new.php"]');
        var raw = oc || (link ? (link.getAttribute('onclick') || link.getAttribute('href') || '') : '');
        applyMeta(tr, raw);
    });
    // Newer Marketing layouts use cards/divs, not a table row per campaign.
    box.querySelectorAll('[onclick*="marketing_new.php"], a[href*="marketing_new.php"]').forEach(function(el) {
        var raw = el.getAttribute('onclick') || el.getAttribute('href') || '';
        var host = el.closest ? (el.closest('tr, .card, .col-sm-6, .col-md-6, [onclick*="marketing_new.php"]') || el) : el;
        applyMeta(host, raw);
    });
}

// Turns a duration option's caption into real hours. There is no global formula:
// the cash campaigns sell hours, Brand Marketing sells days from the same d=
// parameter."4 Days" must become 96 h, not 4 h.
function am4ParseDurationLabelToHours(label) {
    var m = String(label || '').match(/(\d+(?:[.,]\d+)?)\s*(hours?|hrs?|h|std|stunden?|days?|tage?|d)\b/i);
    if (!m) return null;
    var n = parseFloat(m[1].replace(',','.'));
    if (!isFinite(n) || n <= 0) return null;
    var unit = m[2].toLowerCase();
    if (unit.charAt(0) === 'd' || unit.charAt(0) === 't') return n * 24;
    return n;
}

function harvestCampaignLinks(html, found, panelType) {
    var sandbox = document.createElement('div');
    sandbox.innerHTML = html;
    sandbox.querySelectorAll('script, style').forEach(function(el) { el.remove(); });

    sandbox.querySelectorAll('[onclick*="marketing_new.php"], a[href*="marketing_new.php"]').forEach(function(el) {
        var raw = el.getAttribute('onclick') || el.getAttribute('href') || '';
        var typeMatch = raw.match(/type=(\d+)/);
        if (!typeMatch) return;
        var type = parseInt(typeMatch[1], 10);

        if (!found[type]) {
            found[type] = { type: type, label: '', description: '', tiers: [], durationOptions: [], tierPrices: {}, tierPricesByDuration: {}, resourceKind: 'cash'};
        }
        var entry = found[type];

        var ownText = am4CleanText(el);
        if (!entry.label) {
            var label = ownText.slice(0, 60);
            var card = el.closest('.card, .col-sm-6, .modal-body');
            if (card) {
                // Take a real heading node. Deriving the name from the whole clickable
                // element glued the title and the description together into things
                // like"Increase airline reputationCampaigns help ..." .
                var heading = card.querySelector('h1,h2,h3,h4,h5,h6,.card-title');
                if (!heading) heading = card.querySelector('b,strong');
                if (heading && am4CleanText(heading)) label = am4CleanText(heading).slice(0, 60);
            }
            entry.label = label || ('Campaign type ' + type);
        }
        var cMatch = raw.match(/[?&]c=(\d+)/);
        if (cMatch) {
            var tier = parseInt(cMatch[1], 10);
            if (entry.tiers.indexOf(tier) === -1) entry.tiers.push(tier);
            // The price the game prints on (or right next to) the strength button.
            // Brand Marketing is billed in POINTS, so a dollars-only parser silently
            // dropped its price and the panel looked free.
            var priceSource = ownText;
            if (!/\$|\d[\d.,]{2,}/.test(priceSource) && el.parentElement) {
                priceSource = am4CleanText(el.parentElement);
            }
            var pointsMatch = priceSource.match(/([\d.,]+)\s*(points?|pts?)\b/i);
            var cashMatch = priceSource.match(/\$\s?[\d.,]+\s?[kmb]?/i);
            var dMatchLink = raw.match(/[?&]d=(\d+)/);
            var durKey = dMatchLink ? String(parseInt(dMatchLink[1], 10)) : '';
            if (!entry.tierPricesByDuration) entry.tierPricesByDuration = {};
            var priceStr = null;
            if (pointsMatch) {
                entry.resourceKind = 'points';
                priceStr = pointsMatch[1] + ' points';
            } else if (cashMatch) {
                priceStr = cashMatch[0].trim();
            }
            if (priceStr) {
                if (durKey) {
                    if (!entry.tierPricesByDuration[durKey]) entry.tierPricesByDuration[durKey] = {};
                    entry.tierPricesByDuration[durKey][tier] = priceStr;
                }
                if (!entry.tierPrices[tier]) entry.tierPrices[tier] = priceStr;
            }
        }
        var dMatch = raw.match(/[?&]d=(\d+)/);
        if (dMatch) {
            var dur = parseInt(dMatch[1], 10);
            var known = entry.durationOptions.filter(function(o) { return o.value === dur; })[0];
            // A d= seen only in a link has no caption, so its real length is unknown.
            // Recording it with hours 0 is honest - the scheduler then polls instead
            // of sleeping for a made-up duration.
            if (!known) entry.durationOptions.push({ value: dur, label: 'option ' + dur, hours: 0 });
        }
    });

    // Everything below only makes sense for a single campaign's own panel, where all
    // the content belongs to that one campaign
    // (callers gate on am4LooksLikeCampaignPanel before passing panelType)
    if (typeof panelType === 'undefined') return;
    var entry = found[panelType];
    if (!entry) return;

    // The game's own wording for this campaign - the most useful thing on the panel.
    // Taken from real prose elements only; using the whole document would just yield
    // the page chrome, every button caption and every price mashed together.
    if (!entry.description) {
        var best = '';
        sandbox.querySelectorAll('p, .lead, .text-muted, small, .card-text').forEach(function(el) {
            if (el.querySelector('select, option, button, a, input, [onclick]')) return; // layout, not prose
            var t = am4CleanText(el);
            if (t.length < 25) return; // labels, not sentences
            if (/^[\s$\d.,%h-]+$/.test(t)) return; // pure price/duration text
            if (t.length > best.length) best = t;
        });
        if (best.length > 320) best = best.slice(0, 317) + '...';
        entry.description = best;
    }
    // The duration dropdown carries the d= values as option values, and its captions
    // are the only place the real length is written down. Read the options themselves
    // rather than a d=<digit> literal in the handler - the live Brand Marketing panel
    // builds its d from #dSelector at click time, so no literal exists to match.
    sandbox.querySelectorAll('select').forEach(function(sel) {
        sel.querySelectorAll('option').forEach(function(opt) {
            var v = parseInt(opt.value, 10);
            // 24 h is a real option (value 24 on some panels). The old cap of 20
            // dropped it, so the bot could only buy 12 h after a scan.
            if (isNaN(v) || v < 1 || v > 366) return;
            var caption = am4CleanText(opt);
            var hours = am4ParseDurationLabelToHours(caption);
            if (hours === null && /^\d+$/.test(caption.replace(/\s/g,''))) {
                var bare = parseInt(caption, 10);
                if (bare >= 1 && bare <= 168) hours = (bare <= 7 && v <= 7) ? bare * 24 : bare;
            }
            if (hours === null) hours = 0;
            var known = entry.durationOptions.filter(function(o) { return o.value === v; })[0];
            if (known) {
                known.label = caption;
                known.hours = hours;
            } else {
                entry.durationOptions.push({ value: v, label: caption, hours: hours });
            }
        });
    });
    sandbox.querySelectorAll('input[type="radio"], input[type="hidden"]').forEach(function(inp) {
        var name = String(inp.getAttribute('name') || inp.id || '').toLowerCase();
        if (!/^(d|duration|dselector)$/i.test(name) && name.indexOf('duration') === -1) return;
        var v = parseInt(inp.value, 10);
        if (isNaN(v) || v < 1 || v > 366) return;
        var caption = '';
        if (inp.id) {
            var lab = sandbox.querySelector('label[for="' + inp.id + '"]');
            if (lab) caption = am4CleanText(lab);
        }
        if (!caption && inp.parentElement) caption = am4CleanText(inp.parentElement);
        var hours = am4ParseDurationLabelToHours(caption) || 0;
        var known = entry.durationOptions.filter(function(o) { return o.value === v; })[0];
        if (!known) entry.durationOptions.push({ value: v, label: caption || ('option ' + v), hours: hours });
        else if (hours > 0) { known.hours = hours; if (caption) known.label = caption; }
    });
    if (!entry.fixedHoursHint && entry.durationOptions.length === 0) {
        var panelText = am4CleanText(sandbox);
        var fixedMatch = panelText.match(/\b(?:lasts?|fixed|for)\s+(\d+)\s*(hours?|hrs?|h)\b/i) ||
            panelText.match(/\b(\d+)\s*(hours?|hrs?|h)\b/i);
        if (fixedMatch) entry.fixedHoursHint = parseInt(fixedMatch[1], 10);
    }
    sandbox.querySelectorAll('a, button, label, span, option').forEach(function(el) {
        var caption = am4CleanText(el);
        if (!caption || caption.length > 28) return;
        var hours = am4ParseDurationLabelToHours(caption);
        if (!hours || hours < 4 || hours > 168) return;
        var raw = el.getAttribute('onclick') || el.getAttribute('href') || '';
        var dm = raw.match(/[?&]d=(\d+)/);
        var v;
        if (dm) {
            v = parseInt(dm[1], 10);
        } else {
            // Day-scale options (Brand Marketing) must come from <select>/links — guessing
            // v from hours produces fake entries like d=96 for"4 Days" .
            if (hours > 24 || entry.resourceKind === 'points') return;
            v = (hours <= 24 && hours % 4 === 0) ? (hours / 4) : hours;
        }
        if (!isFinite(v) || v < 1) return;
        var known = entry.durationOptions.filter(function(o) { return o.value === v; })[0];
        if (!known) entry.durationOptions.push({ value: v, label: caption, hours: hours });
        else if (hours > 0) { known.hours = hours; known.label = caption; }
    });
    entry.durationOptions = am4DedupeDurationOptions(entry.durationOptions);
}

// Two-stage scan: marketing.php lists the campaign categories, but the strength and
// duration buttons only exist on each category's own panel, so every discovered type
// gets its panel fetched too. Loading a panel without mode=do never buys anything.
var am4ScanRunID = 0;

// Fetch one campaign panel (preview only — no mode=do, never spends).
function am4FetchCampaignPanel(typeId, durationOpt, runID, done) {
    var panelReq = new XMLHttpRequest();
    panelReq.timeout = 20000;
    var settled = false;
    var finish = function(err, html, state) {
        if (settled) return;
        settled = true;
        if (runID !== am4ScanRunID) return;
        done(err, html, state);
    };
    panelReq.ontimeout = function() { finish('timed out'); };
    panelReq.onerror = function() { finish('network error'); };
    panelReq.onreadystatechange = function() {
        if (panelReq.readyState !== 4 || settled) return;
        if (panelReq.status !== 200) { finish('HTTP ' + panelReq.status); return; }
        finish(null, panelReq.responseText, am4CampaignPanelState(panelReq.responseText));
    };
    var url = 'marketing_new.php?type=' + typeId;
    if (durationOpt != null && durationOpt !== '') url +='&d=' + durationOpt;
    url +='&_=' + Date.now();
    panelReq.open('GET', url, true);
    panelReq.send();
}

function scanMarketingCampaigns() {
    // Pressing the button twice used to start two scans, and whichever FINISHED last
    // won - not the one started last. A generation makes the newest press the only
    // one that can commit anything.
    var runID = ++am4ScanRunID;
    var setStatus = function(msg) {
        var el = document.getElementById('am4CampaignScanStatus');
        if (el) el.innerText = msg;
    };
    var setBusy = function(busy) {
        var btn = document.getElementById('am4ScanCampaigns');
        if (btn) {
            btn.disabled = busy;
            btn.style.opacity = busy ?'0.5' : '';
        }
    };
    setBusy(true);
    setStatus('scanning categories...');

    var found = {};
    var overview = new XMLHttpRequest();
    // Without a timeout a request that never comes back leaves the scan on"pending" 
    // for the rest of the session and the button disabled with it.
    overview.timeout = 20000;
    var overviewFailed = function(why) {
        if (runID !== am4ScanRunID) return;
        setBusy(false);
        setStatus('scan failed (' + why + ')');
    };
    overview.ontimeout = function() { overviewFailed('timed out'); };
    overview.onerror = function() { overviewFailed('network error'); };
    overview.onreadystatechange = function() {
        if (overview.readyState !== 4) return;
        if (runID !== am4ScanRunID) return; // superseded by a newer scan
        if (overview.status !== 200) {
            overviewFailed('HTTP ' + overview.status);
            return;
        }
        harvestCampaignLinks(overview.responseText, found);
        // Clean names, real descriptions and"From <price>" come from the overview
        // table, which separates them properly - the per-panel parser cannot.
        am4HarvestOverviewMeta(overview.responseText, found);

        var types = Object.keys(found);
        if (types.length === 0) {
            setBusy(false);
            setStatus('no campaigns found - open Marketing in the game once, then scan again');
            return;
        }

        // Stage 2: open each category panel to read its strength/duration options.
        // Prices depend on d=, so each duration option gets its own panel fetch.
        setStatus('reading ' + types.length + ' campaign panel(s)...');
        var pending = types.length;
        var scannedOk = {}; // only panels that really loaded may overwrite settings
        types.forEach(function(t) {
            var typeNum = parseInt(t, 10);
            var settle = function(note) {
                if (runID !== am4ScanRunID) { return; }
                if (note) {
                    console.log('[AM4 Bot Log] Campaign panel type=' + t + ' ' + note +
                    ' - keeping its existing settings.');
                }
                pending--;
                if (pending === 0) {
                    setBusy(false);
                    finishCampaignScan(found, scannedOk, setStatus);
                }
            };
            am4FetchCampaignPanel(typeNum, null, runID, function(err, html, state) {
                if (err) { settle(String(err)); return; }
                if (state === 'active') {
                    settle('has a campaign running right now, so it shows no options');
                    return;
                }
                if (state !== 'idle') {
                    settle('answered but was not a campaign page (logged out?)');
                    return;
                }
                scannedOk[t] = true;
                harvestCampaignLinks(html, found, typeNum);
                var entry = found[t] || {};
                if (entry.resourceKind === 'ads' || typeNum === 5) { settle(null); return; }
                var durs = (entry.durationOptions || []).map(function(o) { return o.value; });
                if (durs.length === 0) durs = [1, 2, 3, 4, 5, 6];
                var seenDur = {};
                durs = durs.filter(function(d) {
                    var k = String(d);
                    if (seenDur[k]) return false;
                    seenDur[k] = true;
                    return true;
                });
                if (durs.length === 0) { settle(null); return; }
                var dLeft = durs.length;
                durs.forEach(function(d) {
                    am4FetchCampaignPanel(typeNum, d, runID, function(err2, html2, state2) {
                        if (!err2 && state2 === 'idle') harvestCampaignLinks(html2, found, typeNum);
                        dLeft--;
                        if (dLeft === 0) settle(null);
                    });
                });
            });
        });
    };
    overview.open('GET','marketing.php?_=' + Date.now(), true);
    overview.send();
}

function finishCampaignScan(found, scannedOk, setStatus) {
    var types = Object.keys(found);
    // Grab whatever is typed into the live panel right now. The scan runs for a few
    // seconds and the panel stays editable the whole time, so edits made DURING the
    // scan must survive the rebuild too.
    var livePanel = document.getElementById('am4SettingsPanel');
    var wasOpen = !!livePanel && livePanel.style.display === 'block';
    var scrollPos = livePanel ? livePanel.scrollTop : 0;
    var pendingEdits = am4SnapshotPanelEdits();

    // Keep the user's own choices for campaign types that are already configured
    var previous = {};
    (AM4_CONFIG.campaigns || []).forEach(function(c) { previous[c.type] = c; });

    var merged = types.map(function(t) {
        var f = found[t];
        var old = previous[f.type];
        var panelRead = !!scannedOk[t];

        // Merge the scanned duration options with what was already known. A d= seen
        // only in a link comes back with hours 0; if the previous config knew that
        // option's real length, keep it rather than losing the schedule.
        var oldOptions = (old && Array.isArray(old.durationOptions)) ? old.durationOptions : [];
        var scannedOptions = panelRead ? (f.durationOptions || []) : [];
        var options = am4DedupeDurationOptions(scannedOptions.map(function(o) {
            if (o.hours > 0) return { value: o.value, label: o.label, hours: o.hours };
            var previousOption = oldOptions.filter(function(p) { return p.value === o.value; })[0];
            return previousOption
                ? { value: o.value, label: previousOption.label, hours: previousOption.hours }
                : { value: o.value, label: o.label, hours: 0 };
        }));
        if (options.length === 0) options = am4DedupeDurationOptions(oldOptions.slice());

        // Only a panel that actually loaded may decide whether this campaign has a
        // duration - and even then"the parser found none" is NOT proof of a fixed
        // campaign. The live panels hide every control while a campaign is running,
        // so a scan during an active campaign would otherwise strip d= from the URL
        // of a campaign that definitely has one. Duration is promoted, never demoted.
        var parsedDuration = panelRead && scannedOptions.length > 0;
        var shipped = AM4_DEFAULT_CONFIG.campaigns.filter(function(c) { return c.type === f.type; })[0] || null;
        var hasDuration = parsedDuration || (old ? !!old.hasDuration : false) || !!(shipped && shipped.hasDuration);
        if (hasDuration && options.length === 0 && shipped && shipped.durationOptions && shipped.durationOptions.length) {
            options = shipped.durationOptions.slice();
        }
        // While hasDuration was false the panel showed"n/a" /"fixed by game", so the
        // stored tier/duration were never visible to the user and must not be adopted
        // at face value now (the shipped Eco default is duration 6 = 24 h = priciest).
        var flippedToDuration = !!(old && !old.hasDuration && hasDuration);
        if (flippedToDuration) {
            console.log('[AM4 Bot Log] Campaign type ' + f.type +
                ' now offers strength/duration - reset to the cheapest, shortest option, please review it.');
        }
        var keepChoice = old && !flippedToDuration;

        var allowedTiers = (panelRead && f.tiers.length) ? f.tiers.slice().sort(function(a, b) { return a - b; })
                         : ((old && old.allowedTiers && old.allowedTiers.length) ? old.allowedTiers.slice() : [1]);
        if (shipped && shipped.allowedTiers && shipped.allowedTiers.length > allowedTiers.length) {
            allowedTiers = shipped.allowedTiers.slice();
        }
        var optionValues = options.map(function(o) { return o.value; });

        var tier = keepChoice ? Number(old.tier) : allowedTiers[0];
        if (allowedTiers.indexOf(tier) === -1) tier = allowedTiers[0];
        var duration = keepChoice ? Number(old.duration) : (optionValues.length ? optionValues[0] : 1);
        if (!keepChoice && shipped && optionValues.indexOf(Number(shipped.duration)) !== -1) {
            duration = Number(shipped.duration);
        }
        if (optionValues.length && optionValues.indexOf(duration) === -1) {
            var remapped = optionValues[0];
            if (keepChoice) {
                var oldHours = 0;
                if (old && Array.isArray(old.durationOptions)) {
                    var oldOpt = old.durationOptions.filter(function(o) { return Number(o.value) === Number(old.duration); })[0];
                    if (oldOpt) oldHours = Number(oldOpt.hours) || 0;
                }
                if (!oldHours && old && Number(old.duration) >= 1 && Number(old.duration) <= 6) {
                    oldHours = Number(old.duration) * 4;
                }
                var mapped = options[options.length - 1];
                if (oldHours > 0) {
                    var closest = null;
                    var diff = Infinity;
                    options.forEach(function(o) {
                        var h = Number(o.hours) || 0;
                        if (!h) return;
                        var gap = Math.abs(h - oldHours);
                        if (gap < diff) { diff = gap; closest = o; }
                    });
                    if (closest) mapped = closest;
                }
                remapped = mapped.value;
            }
            duration = remapped;
        }

        // Prices: prefer the per-strength prices scanned off the panel; if the panel
        // had none (e.g. an active campaign hides them), fall back to the overview's
        //"From <price>" against the cheapest tier so the panel still shows a number.
        var tierPricesByDuration = {};
        if (f.tierPricesByDuration && typeof f.tierPricesByDuration === 'object') {
            Object.keys(f.tierPricesByDuration).forEach(function(dk) {
                tierPricesByDuration[dk] = f.tierPricesByDuration[dk];
            });
        }
        if (old && old.tierPricesByDuration && typeof old.tierPricesByDuration === 'object') {
            Object.keys(old.tierPricesByDuration).forEach(function(dk) {
                if (!tierPricesByDuration[dk]) {
                    tierPricesByDuration[dk] = old.tierPricesByDuration[dk];
                } else {
                    Object.keys(old.tierPricesByDuration[dk]).forEach(function(tk) {
                        if (!tierPricesByDuration[dk][tk]) {
                            tierPricesByDuration[dk][tk] = old.tierPricesByDuration[dk][tk];
                        }
                    });
                }
            });
        }
        var tierPrices = am4CampaignTierPrices({
            tierPricesByDuration: tierPricesByDuration,
            tierPrices: (f.tierPrices && Object.keys(f.tierPrices).length) ? f.tierPrices : ((old && old.tierPrices) || {}),
            duration: duration
        }, duration);
        if (!Object.keys(tierPrices).length && f.fromPrice) {
            tierPrices = {};
            tierPrices[allowedTiers[0]] = f.fromPrice;
        }

        return {
            type: f.type,
            // The game's own name from the overview table wins - it is clean, unlike
            // the single-panel text which glues the name and description together.
            label: f.label || (old && old.label) || ('Campaign type ' + f.type),
            // The game's own description, so the panel says exactly what the game says
            description: f.description || (old && old.description) || '',
            tierPrices: tierPrices,
            tierPricesByDuration: tierPricesByDuration,
            // Newly discovered campaigns start OFF at the cheapest, shortest setting.
            // Auto-enabling an unknown campaign at its longest duration would spend
            // millions - or points, which cost real money - on the first cycle.
            enabled: old ? old.enabled : false,
            tier: tier,
            duration: duration,
            hasDuration: hasDuration,
            fixedHours: hasDuration
                ? ((old && old.fixedHours) || (shipped && shipped.fixedHours) || 24)
                : ((panelRead && f.fixedHoursHint) ? f.fixedHoursHint : ((old && old.fixedHours) || 12)),
            allowedTiers: allowedTiers,
            durationOptions: options,
            // A campaign the game prices in points is never silently treated as cash
            resourceKind: (f.resourceKind === 'ads' || (old && old.resourceKind === 'ads')) ? 'ads' 
                : ((f.resourceKind === 'points' || (old && old.resourceKind === 'points')) ? 'points' : 'cash')
        };
    });

    // Never drop a campaign the scan happened not to see - the game only renders the
    // categories it currently offers, and losing an entry would lose its settings
    Object.keys(previous).forEach(function(t) {
        if (!found[t]) {
            merged.push(previous[t]);
            console.log('[AM4 Bot Log] Campaign type ' + t + ' was not offered on the page - keeping its saved settings.');
        }
    });
    AM4_CONFIG.campaigns = merged;
    merged.sort(function(a, b) {
        var order = { 5: 1, 1: 2, 2: 3, 10: 4, 9: 5 };
        var aa = order[a.type] || (50 + Number(a.type));
        var bb = order[b.type] || (50 + Number(b.type));
        return aa - bb;
    });
    var freshCount = merged.filter(function(c) { return !previous[c.type]; }).length;
    if (freshCount > 0) {
        console.log('[AM4 Bot Log] ' + freshCount + ' newly discovered campaign(s) added switched OFF - tick the ones you want.');
    }
    saveAm4Config();
    console.log('[AM4 Bot Log] Campaign scan result: ' + AM4_CONFIG.campaigns.map(function(c) {
        if (!found[c.type]) return c.label + ' (type=' + c.type + ', kept from previous settings)';
        return c.label + ' (type=' + c.type + ', paid in ' + c.resourceKind +
               ', strengths=' + (c.allowedTiers.join('/') || 'none') +
               ', durations=' + (c.durationOptions.map(function(o) { return o.label; }).join('/') || 'fixed') +
               ', ' + (c.enabled ?'ON' : 'off') + ')';
    }).join(' | '));

    // Only redraw if the panel was actually open - the response can land after the
    // user already closed it, and forcing it back over the game would be rude
    var newPanel = buildSettingsPanel();
    am4RestorePanelEdits(newPanel, pendingEdits); // unsaved edits survive the refresh
    (AM4_CONFIG.campaigns || []).forEach(function(c) {
        if (c.hasDuration) am4RefreshCampaignTierSelect(c.type);
    });
    newPanel.style.display = wasOpen ?'block' : 'none';
    newPanel.scrollTop = scrollPos;
    if (wasOpen) {
        var skipped = types.filter(function(t) { return !scannedOk[t]; }).length;
        var msg = 'found ' + types.length + ' campaign(s)';
        if (skipped) msg +=' (' + skipped + ' panel(s) skipped — see console)';
        setStatus(msg);
    }
}

// Shared entry point for both maintenance modules. Retries in seconds while the
// popup is busy (either by the game itself or by the other module) instead of
// barging in, and only ever starts a run it holds the lock for.
function am4MaintenanceLoop(owner, toggleId, start) {
    var retry = function() {
        var id = setTimeout(function() { am4MaintenanceLoop(owner, toggleId, start); }, am4Jitter(5000));
        if (owner === 'repair') { clearTimeout(autoRepairTimeoutID); autoRepairTimeoutID = id; }
        else { clearTimeout(autoCheckTimeoutID); autoCheckTimeoutID = id; }
    };

    if (checkAccountBalanceToastSafety() || isBotPausedDueToFunds) return;
    var cb = document.getElementById(toggleId);
    if (!cb || !cb.checked) return; // switched off - the toggle handler restarts us

    // Quiet hours: don't touch maintenance overnight; re-check near the window's end
    // via this owner's own timer slot so the two maintenance modules stay independent.
    if (am4InQuietHours()) {
        var qid = setTimeout(function() { am4MaintenanceLoop(owner, toggleId, start); }, am4QuietRescheduleMs());
        if (owner === 'repair') { clearTimeout(autoRepairTimeoutID); autoRepairTimeoutID = qid; }
        else { clearTimeout(autoCheckTimeoutID); autoCheckTimeoutID = qid; }
        return;
    }

    // Only the acting tab may click through the game's UI. A second tab would fight
    // this one for the same popup.
    if (!am4CanMutate()) { retry(); return; }

    if (am4MaintOwner || am4IsPopupVisible()) {
        am4SetStatus(owner, { state: 'waiting', note: 'waiting for the maintenance popup to free up'});
        retry();
        return;
    }

    var runID = am4AcquireMaintenance(owner);
    if (!runID) { retry(); return; }

    am4SetStatus(owner, { state: 'running', note: 'running the ' + (owner === 'repair' ?'repair' : 'A-check') + ' sequence…'});
    console.log("[AM4 Bot Log] Triggering visual Auto-" + (owner === 'repair' ?'Repair' : 'Check') +" sequence evaluation...");
    try {
        start(runID);
    } catch (err) {
        am4SetStatus(owner, { state: 'error', note: 'sequence failed to start: ' + err.message });
        console.log('[AM4 Bot Log] ' + owner + ' sequence failed to start: ' + err.message);
        am4ReleaseMaintenance(owner, runID);
        retry();
    }
}

function autoRepairCheckLoop() {
    am4MaintenanceLoop('repair','autoRepairCheckbox', runStandaloneRepairSequence);
}

function autoCheckCheckLoop() {
    am4MaintenanceLoop('check','autoCheckCheckbox', runStandaloneCheckSequence);
}

//================================================================================
// Part 7 of 13: Interaction Macro Click Solvers
//================================================================================
function humanClick(el) {
    if (!el) return false;
    ["mousedown","mouseup" ,"click" ].forEach(function (t) {
        el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    });
    return true;
}

// A selector can match markup that is present but hidden - notably leftovers of a
// previously closed popup. Clicking those does nothing and makes the macro believe
// it advanced a step.
function am4IsElementClickable(el) {
    if (!el || el.disabled) return false;
    var style = window.getComputedStyle ? window.getComputedStyle(el) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
    var box = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    return !!(box && box.width > 0 && box.height > 0);
}

function am4FirstClickable(root, selectors) {
    var scope = root || document;
    for (var s = 0; s < selectors.length; s++) {
        var hits = scope.querySelectorAll(selectors[s]);
        for (var i = 0; i < hits.length; i++) {
            if (am4IsElementClickable(hits[i])) return hits[i];
        }
    }
    return null;
}

function openMaintenancePopup() {
    // The live menu entry calls maintenance_main.php. The old selector looked for
    // maintenance.php, so only a very broad fallback ever matched - and that fallback
    // could pick up hidden leftovers inside #popup instead of the real menu item.
    var popup = document.getElementById('popup');
    var candidates = document.querySelectorAll('[onclick*="maintenance_main.php"], [onclick*="maintenance.php"], .btn-maintenance');
    for (var i = 0; i < candidates.length; i++) {
        var el = candidates[i];
        if (popup && popup.contains(el)) continue; // stale markup inside the popup itself
        if (!am4IsElementClickable(el)) continue;
        return humanClick(el);
    }
    console.log('[AM4 Bot Log] Maintenance menu entry not found on this page - retrying later.');
    return false;
}

// The find* helpers return the element (or null) so a caller can POLL for it; the
// click* wrappers keep the old one-shot behaviour for any other caller.
// Verified live 2026-08-15: the Plan tab is`#popBtn2` , whose onclick is
//`Ajax('maint_plan.php','maintAction',this,...)` - so the plan content, including
//`#maintPlanAction` , is loaded INSIDE`#maintAction` . Scoping the bulk loaders to
//`#maintAction` is therefore correct; the old failures were pure timing.
function findPlanTab() {
    var scope = document.getElementById("popup") || document;
    return am4FirstClickable(scope, ['#popBtn2','[onclick*="maint_plan.php"]' ]);
}
function clickPlanTab() {
    var btn = findPlanTab();
    return btn ? humanClick(btn) : false;
}

function findBulkRepair() {
    var scope = document.getElementById("maintAction") || document.getElementById("popup") || document;
    return am4FirstClickable(scope, ['[onclick*="bulkRepair"]','[onclick*="maint_plan_repair_bulk"]' ]);
}
function clickBulkRepair() {
    var btn = findBulkRepair();
    return btn ? humanClick(btn) : false;
}

function findBulkCheck() {
    var scope = document.getElementById("maintAction") || document.getElementById("popup") || document;
    return am4FirstClickable(scope, ['[onclick*="bulkCheck"]','[onclick*="maint_plan_check_bulk"]' ]);
}
function clickBulkCheck() {
    var btn = findBulkCheck();
    return btn ? humanClick(btn) : false;
}

//"The bulk CHECK panel has rendered" - not"an aircraft is due" . The panel
// (`maint_plan_check_bulk.php`, loaded into`#maintPlanAction` ) always brings its
// Select all / Select none controls plus the submit; the`.opa-check` cards are the
// aircraft that are actually due. Waiting on a STRUCTURAL element means an empty
// due-list still resolves as"panel ready, 0 aircraft" instead of timing out as an
// error - the distinction the check sequence depends on.
function findBulkCheckPanelReady() {
    var wrap = document.getElementById("maintPlanAction");
    if (!wrap) return null;
    return wrap.querySelector('[onclick*="addBulk"], #bulk-check-btn, .opa-check[data-id]');
}

// Same idea for the bulk REPAIR panel: the wear dropdown is what the next step needs.
function findBulkRepairPanelReady() {
    var wrap = document.getElementById("maintPlanAction") || document.getElementById("maintAction");
    if (!wrap) return null;
    return document.getElementById("repairPct") || wrap.querySelector('select');
}

// Selects the wear-% option matching AM4_CONFIG.wearPercent EXACTLY. The live
// dropdown only offers discrete steps (10, 20, ... 90) while the settings box takes
// any 1-99, so a mismatch is entirely possible - and it must abort the run rather
// than plan a repair at whatever value happened to be selected.
function selectConfiguredWearThreshold() {
    var wearTarget = Number(AM4_CONFIG.wearPercent);
    var scope = document.getElementById("maintAction") || document.getElementById("popup") || document;
    var selects = [];
    var pctSelect = document.getElementById("repairPct");
    if (pctSelect) selects.push(pctSelect);
    scope.querySelectorAll("select").forEach(function(s) {
        if (selects.indexOf(s) === -1) selects.push(s);
    });

    var offered = [];
    for (var i = 0; i < selects.length; i++) {
        var opts = selects[i].options;
        for (var j = 0; j < opts.length; j++) {
            var m = (opts[j].text || '').match(/\d+/);
            if (!m) continue;
            var value = parseInt(m[0], 10);
            if (offered.indexOf(value) === -1) offered.push(value);
            // Numeric compare, so 5 never matches"15%" or"50%" 
            if (value === wearTarget) {
                selects[i].selectedIndex = j;
                selects[i].dispatchEvent(new Event("change", { bubbles: true }));
                return true;
            }
        }
    }
    offered.sort(function(a, b) { return a - b; });
    console.log("[AM4 Bot Log] The game offers no " + wearTarget +"% wear option" +
        (offered.length ? " - available: " + offered.join("%, ") +"%." :".") +
        " Set 'Repair at wear (%)' in the ⚙ panel to one of those. Aborting this repair run so nothing gets planned at the wrong threshold.");
    return false;
}

// The button that actually submits the bulk repair. The live endpoint is
// maint_plan_do.php?type=bulkRepair...&mode=do; the old name is still accepted as a
// fallback. Returning the element (instead of clicking a document-wide text match)
// means the exact control that was verified is the one that gets clicked.
function findBulkRepairSubmit() {
    var scope = document.getElementById("repairRes") || document.getElementById("maintAction") ||
                document.getElementById("popup") || document;
    return am4FirstClickable(scope, [
        '[onclick*="maint_plan_do.php"][onclick*="bulkRepair"]',
        '[onclick*="bulkRepair"][onclick*="mode=do"]',
        '[onclick*="maint_plan_repair_bulk.php?mode=do"]'
    ]);
}

function findBulkCheckSubmit() {
    var scope = document.getElementById("maintPlanAction") || document.getElementById("popup") || document;
    return am4FirstClickable(scope, [
        '#bulk-check-btn',
        '[onclick*="maint_plan_do.php"][onclick*="bulkCheck"]',
        '[onclick*="maint_plan_check_bulk.php"]',
        '[onclick*="mode=acheckAll"]'
    ]);
}

// Returns the number of aircraft cards selected, or -1 when the plan panel is not
// there at all (which is a different situation from"nothing needed a check").
function selectPlanesBelowConfiguredCheckHours() {
    var wrapper = document.getElementById("maintPlanAction");
    if (!wrapper) return -1;
    var cards = wrapper.querySelectorAll(".opa-check[data-id]");
    if (cards.length === 0) cards = wrapper.querySelectorAll("div.col-sm-6, div[data-id]");

    var totalSelected = 0;
    var scanned = 0;
    cards.forEach(function(card) {
        // The page marks urgent aircraft with b.text-danger and the rest with
        // b.text-success. Reading only text-success skipped exactly the planes that
        // needed the A-check most urgently.
        var field = card.querySelector("b.text-success, b.text-danger, b");
        if (!field) return;
        var digits = (field.innerText || '').replace(/[^0-9]/g,"");
        if (digits === "") return;
        var hoursValue = parseInt(digits, 10);
        if (isNaN(hoursValue)) return;
        scanned++;
        //`parseInt(...) || 999999` turned a valid 0 hours - the single most urgent
        // case there is - into"never select this one" .
        if (hoursValue < AM4_CONFIG.checkHours && !card.classList.contains("selected")) {
            humanClick(card);
            totalSelected++;
        }
    });
    console.log("[AM4 Bot Log] Filter macro complete. " + scanned +" aircraft read, " + totalSelected +
        " selected with remaining hours under " + AM4_CONFIG.checkHours +".");
    return totalSelected;
}

//================================================================================
// Part 8 of 13: Repaired Macro Sequence Orchestrators (Focus Release Framework)
//================================================================================
// The fleet label used to say"Fleet Healthy" no matter what happened - including
// after an aborted run that planned nothing at all. It now reports the state the
// run actually reached.
function am4SetFleetStatus(text, color) {
    var lbl = document.getElementById('maintenanceStatusLabel');
    if (!lbl) return;
    lbl.innerText = text;
    lbl.style.color = color || '#5cb85c';
}

function runStandaloneRepairSequence(runID) {
    am4SetFleetStatus('Repair running','#38bdf8');
    if (!openMaintenancePopup()) {
        finishVisualCloseAction(true, true, runID,'maintenance menu not reachable');
        return;
    }
    // Wait for the popup's Plan tab rather than assuming it is there after 2 s.
    am4MaintWaitFor('repair', runID, findPlanTab, AM4_MAINT_SUBPANEL_TIMEOUT_MS, function(planTab) {
        humanClick(planTab);

        // The Plan tab renders the WHOLE fleet (~950 KB at ~470 aircraft, ~1.6 s before
        // its loaders are clickable). This used to be a flat 800 ms guess.
        am4MaintWaitFor('repair', runID, findBulkRepair, AM4_MAINT_PANEL_TIMEOUT_MS, function(bulkBtn) {
            humanClick(bulkBtn);

            am4MaintWaitFor('repair', runID, findBulkRepairPanelReady, AM4_MAINT_SUBPANEL_TIMEOUT_MS, function() {
                // No exact wear match means the plan would go out at whatever value the
                // dropdown happened to show. Abort - do not guess with real money.
                if (!selectConfiguredWearThreshold()) {
                    finishVisualCloseAction(true, false, runID,'wear % not offered by the game');
                    return;
                }

                // The submit only appears once the preview AJAX lands. This used to sleep a
                // flat 600 ms and look ONCE - the same shape as the bug that silently broke
                // Auto-Check when the fleet outgrew its 1200 ms guess. It has not bitten here
                // only because the repair preview is tiny (~1 KB) next to the ~950 KB Plan tab,
                // so polling closes it before the fleet grows into it too.
                am4MaintWaitFor('repair', runID, findBulkRepairSubmit, AM4_MAINT_SUBMIT_TIMEOUT_MS, function(submitBtn) {
                    // Click exactly the control that was verified - never a document-wide
                    // search for an English caption, which can hit hidden leftovers.
                    var clicked = humanClick(submitBtn);
                    am4MaintStep('repair', runID, 1500, function() {
                        finishVisualCloseAction(true, !clicked, runID, clicked ?'repair planned' : 'submit click failed');
                    });
                }, function() {
                    // No submit after a full wait. That is genuinely ambiguous, so it is
                    // resolved by what IS on screen: a rendered result panel with no submit
                    // means nothing is above the wear limit; no panel at all means the AJAX
                    // never arrived, which is a"come back shortly" , not a healthy fleet.
                    var resultPanel = document.getElementById('repairRes') || document.getElementById('maintPlanAction');
                    if (!resultPanel) {
                        finishVisualCloseAction(true, true, runID,'repair panel did not render');
                        return;
                    }
                    console.log("[AM4 Bot Log] Repair scan complete: no aircraft above the " +
                        AM4_CONFIG.wearPercent +"% wear limit (the game offers no submit).");
                    finishVisualCloseAction(true, false, runID,'nothing to repair');
                });
            }, function() {
                finishVisualCloseAction(true, true, runID,'bulk repair panel did not render in time');
            });
        }, function() {
            finishVisualCloseAction(true, true, runID,'bulk repair loader did not appear (plan tab still loading?)');
        });
    }, function() {
        finishVisualCloseAction(true, true, runID,'plan tab not reachable');
    });
}

function runStandaloneCheckSequence(runID) {
    am4SetFleetStatus('A-check running','#38bdf8');
    if (!openMaintenancePopup()) {
        finishVisualCloseAction(false, true, runID,'maintenance menu not reachable');
        return;
    }
    // Wait for the popup's Plan tab instead of assuming a flat 2 s was enough.
    am4MaintWaitFor('check', runID, findPlanTab, AM4_MAINT_SUBPANEL_TIMEOUT_MS, function(planTab) {
        humanClick(planTab);

        // ROOT CAUSE OF"bulk check panel not reachable" (diagnosed live 2026-08-15):
        // this step slept a flat 1200 ms and then looked ONCE. The Plan tab loads
        //`maint_plan.php` , which at ~470 aircraft is ~950 KB and needs ~1580 ms before
        // the Bulk check loader is clickable - measured on the live account. So the look
        // happened ~380 ms too early, every single time, and the run reported the panel
        // as unreachable and retried every 5 s forever. The button and its selector were
        // always correct; the fleet had simply outgrown the hard-coded delay. Polling
        // removes the assumption entirely.
        am4MaintWaitFor('check', runID, findBulkCheck, AM4_MAINT_PANEL_TIMEOUT_MS, function(bulkBtn) {
            humanClick(bulkBtn);

            // Wait for the bulk-check panel STRUCTURE (Select all / submit), not for
            // aircraft cards - so"panel ready, nothing due" stays distinguishable from
            //"panel never rendered" .
            am4MaintWaitFor('check', runID, findBulkCheckPanelReady, AM4_MAINT_SUBPANEL_TIMEOUT_MS, function() {
                var planesSelected = selectPlanesBelowConfiguredCheckHours();

                if (planesSelected < 0) {
                    // The plan panel never rendered - that is a"come back shortly" ,
                    // not a"fleet is fine" .
                    finishVisualCloseAction(false, true, runID,'plan panel did not render');
                    return;
                }
                if (planesSelected === 0) {
                    console.log("[AM4 Bot Log] Check scan complete: 0 aircraft under " + AM4_CONFIG.checkHours +" hours.");
                    am4MaintStep('check', runID, 3000, function() {
                        finishVisualCloseAction(false, false, runID,'nothing to check');
                    });
                    return;
                }

                // Aircraft ARE selected, so the submit must exist - but the readiness probe
                // above can match on Select-all or a card before the button itself is in the
                // DOM, so poll for it rather than looking once and reporting a false failure.
                am4MaintWaitFor('check', runID, findBulkCheckSubmit, AM4_MAINT_SUBMIT_TIMEOUT_MS, function(submitBtn) {
                    var clicked = humanClick(submitBtn);
                    am4MaintStep('check', runID, 1500, function() {
                        finishVisualCloseAction(false, !clicked, runID,
                            clicked ? (planesSelected + ' A-check(s) planned') : 'submit click failed');
                    });
                }, function() {
                    finishVisualCloseAction(false, true, runID,'bulk check submit not found');
                });
            }, function() {
                finishVisualCloseAction(false, true, runID,'bulk check panel did not render in time');
            });
        }, function() {
            finishVisualCloseAction(false, true, runID,'bulk check loader did not appear (plan tab still loading?)');
        });
    }, function() {
        finishVisualCloseAction(false, true, runID,'plan tab not reachable');
    });
}

// retrySoon: the sequence gave up because a panel was not there yet, so come back in
// seconds instead of burning the whole maintenance interval.
// runID identifies which run is finishing - a late callback from a run that was
// already superseded must not close the popup the current run is working in.
function finishVisualCloseAction(isRepairModule, retrySoon, runID, note) {
    var owner = isRepairModule ?'repair' : 'check';
    if (!am4ReleaseMaintenance(owner, runID)) {
        console.log('[AM4 Bot Log] Ignoring a late ' + owner + ' finish callback from a superseded run.');
        return;
    }

    // Release browser focus away from the popup so the browser can update
    // aria-hidden without fighting the render
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    if (document.body && document.body.focus) document.body.focus();

    am4CloseGamePopup();

    var failed = retrySoon || (note === 'submit click failed') || (note === 'wear % not offered by the game');
    if (failed) {
        am4SetFleetStatus('Needs attention','#f59e0b');
    } else if (note === 'repair planned' || (note && note.indexOf('A-check') !== -1)) {
        am4SetFleetStatus('Maintenance planned','#10b981');
    } else {
        am4SetFleetStatus('Fleet Healthy','#5cb85c');
    }

    // Bounded retry instead of an endless 5 s loop. A retryable failure used to
    // reschedule at a flat 5 s with no attempt counter, so a condition that did not
    // clear (a panel the macro could never reach) re-opened the maintenance popup every
    // 5 s indefinitely - visible to the user only as the same message over and over,
    // with no way to tell"briefly not ready" from"genuinely broken" . Now: exponential
    // backoff, and after AM4_MAINT_MAX_RETRIES consecutive failures the module stops
    // hammering, reports a real error state, and waits for the next regular interval.
    var label = isRepairModule ?'Auto-Repair' : 'Auto-Check';
    var normalDelay = AM4_CONFIG.maintIntervalHrs * 60 * 60 * 1000;
    var nextDelay, gaveUp = false;
    if (retrySoon) {
        am4MaintRetries[owner] = (am4MaintRetries[owner] || 0) + 1;
        if (am4MaintRetries[owner] > AM4_MAINT_MAX_RETRIES) {
            gaveUp = true;
            nextDelay = normalDelay;
        } else {
            nextDelay = Math.min(AM4_MAINT_RETRY_BASE_MS * Math.pow(2, am4MaintRetries[owner] - 1),
                                 AM4_MAINT_RETRY_CAP_MS);
        }
    } else {
        am4MaintRetries[owner] = 0;
        nextDelay = normalDelay;
    }
    var actualDelay = am4Jitter(nextDelay);
    var statusNote = (note || 'done');
    if (gaveUp) {
        statusNote +=' - failed ' + (am4MaintRetries[owner]) + 'x in a row, paused until the next regular run';
    } else if (retrySoon) {
        statusNote +=' - retry ' + am4MaintRetries[owner] + '/' + AM4_MAINT_MAX_RETRIES +
                      ' in ' + Math.round(actualDelay / 1000) + 's';
    }
    if (gaveUp) am4SetFleetStatus('Needs attention','#ef4444');
    am4SetStatus(owner, {
        state: failed ?'error' : 'idle',
        note: statusNote,
        next: Date.now() + actualDelay
    });
    if (gaveUp) {
        am4LogAction(owner,'⚠ ' + label + ' gave up after ' + AM4_MAINT_MAX_RETRIES +
        ' failed attempts: ' + (note || 'unknown reason'));
    }
    if (note === 'repair planned') {
        am4LogAction('repair','🔧 Repair planned');
    } else if (note && note.indexOf('A-check') !== -1) {
        am4LogAction('check','🔧 ' + note);
    }
    if (isRepairModule) {
        clearTimeout(autoRepairTimeoutID);
        autoRepairTimeoutID = setTimeout(autoRepairCheckLoop, actualDelay);
    } else {
        clearTimeout(autoCheckTimeoutID);
        autoCheckTimeoutID = setTimeout(autoCheckCheckLoop, actualDelay);
    }
    console.log('[AM4 Bot Log] ' + label + ' finished: ' + (note || 'done') +
        (gaveUp
            ? ' - GAVE UP after ' + AM4_MAINT_MAX_RETRIES + ' consecutive failures; next regular run in ' +
              AM4_CONFIG.maintIntervalHrs + ' h.'
            : retrySoon
                ? ' - retry ' + am4MaintRetries[owner] + '/' + AM4_MAINT_MAX_RETRIES + ' in ' +
                  Math.round(actualDelay / 1000) + ' s.'
                : ' - next run in ' + AM4_CONFIG.maintIntervalHrs + ' h.'));
}

//================================================================================
// Part 9 of 13: Custom Multiplier Pricing Interceptor
//
// Rewritten against the live game. Three things were wrong before:
//
// 1. It only reacted to buttons calling`ticketPriceSuggest` . The game's current
// auto-price handler is`autoPrice(e,t,a,o)` ;`ticketPriceSuggest` no longer
// exists anywhere, so this whole feature had silently stopped firing.
// 2. It then called the native four-argument autoPrice with FIVE arguments. The
// fifth is discarded and`Math.floor(baseY)` lands in the fourth slot, which the
// game reads as a special flag - it multiplied all three prices by 1.8 on top of
// the configured multiplier. Nothing here calls autoPrice any more.
// 3. Its verification pass ran 50 ms after the click, while the game writes Economy
// immediately, Business after ~200 ms and First after ~400 ms - so it"verified" 
// values that were still about to be overwritten.
//
// The native handler now runs completely untouched. Once it has finished writing,
// the multipliers are applied to what it produced.
//================================================================================
var am4PriceRunID = 0;

// Stamped onto each input the moment this script writes to it, so neither the click
// path nor the observer fallback can multiply the same value a second time - while a
// genuinely new base price (new route, auto pressed again) is still processed.
function am4AlreadyPriced(el) {
    return !!(el && el.dataset && el.dataset.am4Priced === String(el.value));
}

function am4WritePriceField(el, value, decimals) {
    if (!el) return false;
    var text = decimals ? value.toFixed(2) : String(Math.floor(value));
    el.value = text;
    el.dataset.am4Priced = text;
    if (typeof jQuery !== 'undefined') {
        jQuery(el).val(text).trigger('input').trigger('change');
    } else {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return true;
}

function am4ApplyPriceMultipliers(scope, source) {
    // The panel can be swapped out between the click and this call. Writing then
    // would put one route's prices into another route's form.
    if (!scope || !document.contains(scope)) {
        console.log('[AM4 Bot Log] Price form was replaced before the multipliers could be applied - skipped.');
        return false;
    }
    var eco = scope.querySelector('#eSeat, #eTicket, #price_y');
    var biz = scope.querySelector('#bSeat, #bTicket, #price_j');
    var first = scope.querySelector('#fSeat, #fTicket, #price_f');
    var cargoLarge = scope.querySelector('#price_l');
    var cargoHeavy = scope.querySelector('#price_h');

    // Cargo is recognised by its OWN fields being present, not by a passenger field
    // being absent somewhere on the page - a hidden leftover #fTicket used to make a
    // cargo route look like a passenger route.
    if (cargoLarge && cargoHeavy && !(eco && biz && first)) {
        var baseLarge = parseFloat(cargoLarge.value) || 0;
        var baseHeavy = parseFloat(cargoHeavy.value) || 0;
        if (baseLarge <= 0 || baseHeavy <= 0) return false;
        // If EITHER field already holds what we wrote, skip. Requiring BOTH (&&) let a
        // single unchanged field re-trigger the multiplication on the other one, so a
        // partial re-render (or a hand edit to one field) doubled the sibling's markup.
        if (am4AlreadyPriced(cargoLarge) || am4AlreadyPriced(cargoHeavy)) return false;
        var truncate = function(n) { return Math.floor(n * 100) / 100; };
        var calcLarge = truncate(baseLarge * AM4_CONFIG.cargoMultiLarge);
        var calcHeavy = truncate(baseHeavy * AM4_CONFIG.cargoMultiHeavy);
        am4WritePriceField(cargoLarge, calcLarge, true);
        am4WritePriceField(cargoHeavy, calcHeavy, true);
        // Deliberately NOT calling autoPrice here: the live handler writes the three
        // passenger seat fields only and does not know about cargo at all.
        console.log('[AM4 Bot Log] Cargo pricing (' + source + ') -> Large: $' + calcLarge.toFixed(2) +
            ' | Heavy: $' + calcHeavy.toFixed(2));
        return true;
    }

    if (!(eco && biz && first)) return false;
    var baseY = parseFloat(eco.value) || 0;
    var baseJ = parseFloat(biz.value) || 0;
    var baseF = parseFloat(first.value) || 0;
    if (baseY <= 0 || baseJ <= 0 || baseF <= 0) return false;
    // Any one field already holding our written value means this set was priced
    // already - skip. The old all-of (&&) test re-multiplied the two still-stamped
    // fields whenever the game re-rendered or the user hand-edited just one of them.
    if (am4AlreadyPriced(eco) || am4AlreadyPriced(biz) || am4AlreadyPriced(first)) return false;

    var calcY = Math.floor(baseY * AM4_CONFIG.paxMultiEco);
    var calcJ = Math.floor(baseJ * AM4_CONFIG.paxMultiBiz);
    var calcF = Math.floor(baseF * AM4_CONFIG.paxMultiFirst);
    am4WritePriceField(eco, calcY, false);
    am4WritePriceField(biz, calcJ, false);
    am4WritePriceField(first, calcF, false);
    am4AppliedPax = { y: calcY, j: calcJ, f: calcF };
    console.log('[AM4 Bot Log] Passenger pricing (' + source + ') -> base ' + Math.floor(baseY) + '/' +
        Math.floor(baseJ) + '/' + Math.floor(baseF) + ' -> Eco: $' + calcY + ' | Biz: $' + calcJ + ' | First: $' + calcF);
    return true;
}

document.addEventListener('click', function (e) {
    if (!e.target || typeof e.target.closest !== 'function') return;
    var btn = e.target.closest('button, a, [onclick]');
    if (!btn) return;
    var onclick = btn.getAttribute('onclick') || '';
    var isAutoPriceButton = /\bautoPrice\s*\(/.test(onclick) || btn.id === 'introAuto';
    if (!isAutoPriceButton) return;

    var runID = ++am4PriceRunID;
    // Remember which form this click belonged to, and validate it is still the one on
    // screen before writing anything.
    var scope = btn.closest('#popup, form, .modal-body, #routeMain') || document.body;
    // Long enough for the native handler to have written all three fields (First
    // lands last, around 400 ms).
    setTimeout(function() {
        if (runID !== am4PriceRunID) return;
        am4ApplyPriceMultipliers(scope,'auto button');
    }, 700);
}, true);
// PART 10 OF 13: CONSUMABLE BUYER (fuel + CO2)
//
// Price/capacity are still read in the background so Research's popup is never
// stolen for a market check. When a buy is actually placed and Research is idle,
// the game fuel/CO2 shop is opened so the purchase is visible; otherwise the same
// silent order is used and a live toast still reports it.
//
// One cycle is strictly: read fuel -> maybe buy fuel -> read CO2 with the money that
// is actually left -> maybe buy CO2 -> schedule the next cycle. Previously both ran
// off the SAME bank balance a few seconds apart, each sizing its order as"spend 
// almost everything", so the second order could exceed what was left.
var AM4_CONSUMABLES = {
    fuel: { url: 'fuel.php', rootId: 'fuelMain', label: 'Fuel', thresholdKey: 'fuelPriceThreshold',
            pricePath: [0, 0, 2, 0], buy: buyFuel, history: function() { return am4FuelPurchases; } },
    co2: { url: 'co2.php', rootId: 'co2Main', label: 'CO2', thresholdKey: 'co2PriceThreshold',
            pricePath: [0, 1, 2, 0], buy: buyCO2, history: function() { return am4Co2Purchases; } }
};

function am4ReadByPath(root, path) {
    var node = root;
    for (var i = 0; i < path.length; i++) {
        if (!node || !node.children || !node.children[path[i]]) return null;
        node = node.children[path[i]];
    }
    return node;
}

// Returns {price, capacity} or null. Fails closed: a panel it cannot read with
// confidence never results in a purchase.
function am4ParseConsumablePanel(html, spec) {
    var sandbox = document.createElement('div');
    sandbox.innerHTML = html;
    var root = sandbox.querySelector('#' + spec.rootId);
    if (!root) return null;

    var priceNode = am4ReadByPath(root, spec.pricePath);
    var price = NaN;
    if (priceNode) price = parseInt(String(priceNode.textContent).replace(/[^0-9]/g,''), 10);
    if (!isFinite(price) || price <= 0) {
        // The deep children[...] path breaks as soon as one wrapper is added, so fall
        // back to the first dollar figure the panel prints.
        var m = String(root.textContent || '').match(/\$\s?([\d.,]+)/);
        if (m) price = parseInt(m[1].replace(/[^0-9]/g,''), 10);
    }
    // Capacity has a dedicated element on the live page - far more stable than
    // counting children.
    var capNode = root.querySelector('#remCapacity') || sandbox.querySelector('#remCapacity');
    var capacity = capNode ? parseInt(String(capNode.textContent).replace(/[^0-9]/g,''), 10) : NaN;

    if (!isFinite(price) || price <= 0) return null;
    if (!isFinite(capacity) || capacity < 0) return null;
    return { price: price, capacity: capacity };
}

function am4ScheduleBuyer() {
    clearTimeout(autoBuyerTimeoutID);
    var wait = am4Jitter(AM4_CONFIG.buyerIntervalMin * 60 * 1000);
    am4SetStatus('buyer', { next: Date.now() + wait, at: am4Status.buyer.at });
    autoBuyerTimeoutID = setTimeout(scanConsumable, wait);
}

// state carries the money already committed earlier in this same cycle
function am4RunConsumableStep(runID, key, state, done) {
    if (runID !== am4BuyerRunID) return;
    var spec = AM4_CONSUMABLES[key];
    var req = new XMLHttpRequest();
    req.timeout = 25000;
    var settled = false;
    var finish = function(note) {
        if (settled) return;
        settled = true;
        if (note) console.log('[AM4 Bot Log] ' + spec.label + ' price check: ' + note);
        if (runID === am4BuyerRunID) done();
    };
    req.ontimeout = function() { finish('request timed out - skipped this cycle.'); };
    req.onerror = function() { finish('network error - skipped this cycle.'); };
    req.onreadystatechange = function() {
        if (req.readyState !== 4 || settled) return;
        if (runID !== am4BuyerRunID) { settled = true; return; }
        if (req.status !== 200) { finish('HTTP ' + req.status + ' - skipped this cycle.'); return; }

        var panel = am4ParseConsumablePanel(req.responseText, spec);
        if (!panel) { finish('could not read price/capacity off the page - nothing bought.'); return; }

        var threshold = Number(AM4_CONFIG[spec.thresholdKey]);
        console.log('[AM4 Bot Log] ' + spec.label + ' market -> $' + panel.price + ' | limit $' + threshold +
            ' | free capacity ' + panel.capacity);
        if (panel.price > threshold) {
            if (state.notes) state.notes.push(spec.label + ' $' + panel.price.toLocaleString() + ' over $' + threshold.toLocaleString() + ' limit');
            finish(null); return;
        }

        // Re-check the switches immediately before spending anything: this callback
        // arrives hundreds of milliseconds after the decision to scan was made.
        var cb = document.getElementById('autoBuyerCheckbox');
        if (!cb || !cb.checked || isBotPausedDueToFunds || !am4CanMutate()) {
            finish('skipped - switched off, paused, or another tab is the acting tab.');
            return;
        }

        var reserve = Number(AM4_CONFIG.cashReserve) || 0;
        // Subtract what this very cycle already committed. The header balance does not
        // update after a background purchase, so it cannot be trusted twice in a row.
        var available = getBankBalance() - reserve - state.spent;
        if (available <= 0) { finish('no money left after the cash reserve - nothing bought.'); return; }

        // Spend guard 3 (A5): a hard per-cycle ceiling on the fuel+CO2 buyer, on top of
        // the price thresholds. state.spent already holds what this cycle committed.
        var cycleCap = Number(AM4_CONFIG.maxSpendPerCycle) || 0;
        if (cycleCap > 0) {
            var cycleLeft = cycleCap - state.spent;
            if (cycleLeft <= 0) {
                if (state.notes) state.notes.push(spec.label + ': per-cycle spend cap ($' + cycleCap.toLocaleString() + ') reached');
                finish('per-cycle spend cap reached - nothing bought.'); return;
            }
            available = Math.min(available, cycleLeft);
        }

        var affordable = Math.floor(available / panel.price * 1000);
        var amount = Math.min(affordable, panel.capacity);
        if (amount <= 0) { finish('nothing to buy (capacity full or balance too low).'); return; }

        var cost = Math.ceil(amount * panel.price / 1000);
        state.spent += cost;
        console.log('[AM4 Bot Log] Buying ' + amount + ' ' + spec.label + ' for about $' + cost.toLocaleString() + '.');
        am4LogAction('buyer', (spec.label === 'Fuel' ?'⛽' : '🌱') + ' Bought ' + amount.toLocaleString() + ' ' + spec.label + ' (~$' + cost.toLocaleString() + ' @ $' + panel.price + ')');
        am4ConsumablePurchase(spec, amount, function() {
            if (runID !== am4BuyerRunID) return;
            // Recorded only after the server accepted it, so failed purchases never
            // pollute the overlay averages
            var history = spec.history();
            history.push({ price: panel.price, amount: amount });
            if (history.length > 20) history.shift();
            am4RefreshOverlayBuyRows();
        });
        finish(null);
    };
    req.open('GET', spec.url + '?_=' + Date.now(), true);
    req.send();
}

function scanConsumable() {
    var cb = document.getElementById("autoBuyerCheckbox");
    if (!cb || !cb.checked) {
        // Deliberately does NOT reschedule. A switched-off module that keeps polling
        // is a sleeping chain that wakes up at the worst possible moment; the toggle
        // handler is what restarts it.
        return;
    }
    if (checkAccountBalanceToastSafety() || isBotPausedDueToFunds) return;
    // Quiet hours: skip the market scan and re-check near the window's end
    if (am4InQuietHours()) {
        autoBuyerTimeoutID = setTimeout(scanConsumable, am4QuietRescheduleMs());
        return;
    }
    if (am4BuyerBusy) {
        console.log('[AM4 Bot Log] Previous consumables scan still running - skipping this cycle.');
        am4ScheduleBuyer();
        return;
    }
    if (!am4CanMutate()) { am4ScheduleBuyer(); return; }

    var runID = ++am4BuyerRunID;
    am4BuyerBusy = true;
    var state = { spent: 0, notes: [] };
    am4SetStatus('buyer', { state: 'running', note: 'checking fuel & CO2 prices…'});
    am4ShowLiveAction('⛽ Checking fuel & CO2…','#38bdf8');
    console.log("[AM4 Bot Log] Initiating fuel/CO2 market scan...");

    am4RunConsumableStep(runID,'fuel', state, function() {
        setTimeout(function() {
            if (runID !== am4BuyerRunID) return;
            am4RunConsumableStep(runID,'co2', state, function() {
                if (runID !== am4BuyerRunID) return;
                am4BuyerBusy = false;
                am4SetStatus('buyer', { state: 'idle', note: state.spent > 0
                    ?'bought ~$' + state.spent.toLocaleString() + ' of fuel/CO2 this cycle' 
                    : (state.notes.length ? state.notes.join('; ') : 'nothing bought (capacity full or nothing needed)') });
                console.log("[AM4 Bot Log] Consumable scan cycle complete" +
                    (state.spent > 0 ? " - spent about $" + state.spent.toLocaleString() +" this cycle." :" - nothing bought."));
                if (state.spent <= 0) {
                    am4ShowLiveAction(state.notes.length ? ('⛽ ' + state.notes.join('; ')) : '⛽ Nothing to buy this cycle','#94a3b8');
                }
                setTimeout(function () {
                    if (runID !== am4BuyerRunID) return;
                    am4BuyerCloseShopIfOurs();
                }, state.spent > 0 ? 2200 : 400);
                // The next cycle is scheduled only once this one has finished, so two
                // cycles can never overlap and decide from the same stale prices.
                am4ScheduleBuyer();
            });
        }, am4BuyerOpenedPopup ? am4RandomDelay(3500, 6500) : am4RandomDelay(2000, 9000));
    });
    // closePop is only used if THIS cycle opened the fuel/CO2 shop. A player-owned
    // or Research popup is never closed here.
}
// PART 11 OF 13: ROUTE CREATION VIEW DYNAMIC PRICE OVERRIDER
//
// Fallback for panels that fill the price inputs without a click this script can
// intercept. It goes through exactly the same writer as the button path, so the
// per-field stamp prevents a value from ever being multiplied twice - the old
// version used a permanent CSS marker on the economy field, which meant a later
// re-fill of the same form was never processed at all.
//
// Known limit: this reacts to nodes being inserted. If the game inserts the inputs
// empty and fills them later through jQuery .val(), no mutation fires and only the
// button path covers it.
var am4PricingObserverTimer = null;
var creationPricingObserver = new MutationObserver(function() {
    clearTimeout(am4PricingObserverTimer);
    am4PricingObserverTimer = setTimeout(function() {
        // Never rewrite a field the player is currently typing into
        var active = document.activeElement;
        if (active && active.tagName === 'INPUT' &&
            /^(eSeat|bSeat|fSeat|eTicket|bTicket|fTicket|price_y|price_j|price_f|price_l|price_h)$/.test(active.id || '')) {
            return;
        }
        // Research details reuse the same #eSeat ids. Only rewrite tickets once the
        // research FSM is actually on the creation/pricing panel.
        if (typeof am4Rte !== 'undefined' && am4Rte.state && am4Rte.state !== 'IDLE' &&
            !/^(VERIFY|RECOVER|WAIT_PRICE|AUTOPRICE|SUBMIT|WAIT_SUBMIT)$/.test(am4Rte.state)) {
            return;
        }
        var scope = document.getElementById('newRouteContainer') ||
            document.getElementById('newRouteInfo') ||
            document.getElementById('popup') || document.body;
        am4ApplyPriceMultipliers(scope,'route panel');
    }, 600);
});

function routeDistanceWatcher() {
    // Scan only the route containers (not every td/span on the page) and poll at 3s -
    // the old page-wide 1.5s scan was pure CPU waste.
    // #popup is where AM4 actually renders route research/detail views - without it
    // the scoped scan would match nothing and silently kill the distance log
    document.querySelectorAll('#popup, #routeInfo, .route-details, #newRouteInfo').forEach(function (root) {
        var candidates = [];
        root.querySelectorAll('td, span').forEach(function (el) { candidates.push(el); });
        candidates.forEach(function (el) {
            if (el.innerText && el.innerText.includes('km') && !el.classList.contains('distance-scanned')) {
                el.classList.add('distance-scanned');
                var dist = parseFloat(el.innerText.replace(/[^0-9.]/g,'')) || 0;
                if (dist > 0 && dist < 50000) {
                    var rng = dist < 3000 ?'Short Haul' : (dist < 7000 ?'Medium Haul' : 'Long Haul');
                    console.log("[AM4 Bot Log] Route Distance: " + dist +" km (" + rng +")");
                }
            }
        });
    });
    setTimeout(routeDistanceWatcher, am4Jitter(3000));
}

// cargoDemandWatcher / paxDemandWatcher removed in v1.2: they scanned the whole page
// every 2s but their results were never used anywhere - pure dead weight.

// Names are compared through this key, not literally. The game writes"São Paulo 
// Guarulhos" and "Dallas-Fort Worth"; a literal comparison against a hand-typed list
// fails on one accent or one hyphen, and the settings panel promised exact matching
// while countries and airports actually used two different rules.
function am4HubKey(value) {
    var text = String(value || '');
    if (text.normalize) text = text.normalize('NFD').replace(/[\u0300-\u036f]/g,'');
    return text.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
}

function am4HubKeySet(list) {
    var set = {};
    (list || []).forEach(function(entry) {
        var key = am4HubKey(entry);
        if (key) set[key] = true;
    });
    return set;
}

// Only the real New Hub dialog counts. The old test accepted any popup containing a
// <select>, which the repair-percentage dialog also satisfies - the highlighter then
// scanned and recoloured the wrong dialog.
function am4FindHubRoot() {
    var popup = document.getElementById('popup');
    if (!popup || !am4IsPopupVisible(popup)) return null;
    if (popup.querySelector('#hubcountrySelector, #hubCityContainer, #hubAirportSelector')) return popup;
    return null;
}

function scanMarketplaceForBestHubs() {
    var reschedule = function() { setTimeout(scanMarketplaceForBestHubs, am4Jitter(2500)); };
    // Nothing to look at while the tab is in the background
    if (document.hidden) { reschedule(); return; }

    var hubRoot = am4FindHubRoot();
    if (!hubRoot) {
        document.body.classList.remove('market-shortlist-logged');
        reschedule();
        return;
    }
    if (!document.body.classList.contains('market-shortlist-logged')) {
        document.body.classList.add('market-shortlist-logged');
        console.log("[AM4 Bot Log] New Hub dialog detected - highlighting the configured elite countries and airports.");
    }
    // Bound on every pass, guarded by a class so it stays a single listener. The old
    // code bound it once behind an early return that fired on hubs.php - before the
    // country dropdown even existed - so the listener was usually never attached and
    // only the 2.5 s poll made it look like it worked.
    var countrySelect = hubRoot.querySelector('#hubcountrySelector') || hubRoot.querySelector('select');
    if (countrySelect && !countrySelect.classList.contains("bot-listener-bound")) {
        countrySelect.classList.add("bot-listener-bound");
        countrySelect.addEventListener("change", function() {
            setTimeout(runVisualHubHighlighter, 400);
        });
    }
    runVisualHubHighlighter();
    reschedule();
}

function am4PaintHub(el) {
    if (el.classList.contains("bot-premium-hub-painted")) return;
    el.classList.add("bot-premium-hub-painted");
    // Remember the game's own inline values so reset restores them instead of
    // blanking whatever the game had set
    el.dataset.am4PrevBg = el.style.backgroundColor || '';
    el.dataset.am4PrevBorder = el.style.border || '';
    el.dataset.am4PrevColor = el.style.color || '';
    el.dataset.am4PrevWeight = el.style.fontWeight || '';
    el.style.backgroundColor ="rgba(92, 184, 92, 0.35)" ;
    el.style.border ="2px solid #5cb85c" ;
    el.style.color ="#1b5e20" ;
    el.style.fontWeight ="bold" ;
}

function runVisualHubHighlighter() {
    // 1. ELITE COUNTRIES: highlight the country dropdown. 2. HIGH-YIELD AIRPORTS: tag the
    // airport dropdown. Both lists live in AM4_CONFIG and are editable via the ⚙ panel.
    var hubRoot = am4FindHubRoot();
    if (!hubRoot) return;
    var countryKeys = am4HubKeySet(AM4_CONFIG.eliteCountries);
    var airportKeys = Object.keys(am4HubKeySet(AM4_CONFIG.highYieldAirports));

    // Scoped to the hub dialog.".modal-body td" used to reach into every other modal
    // on the page and colour cells there.
    hubRoot.querySelectorAll("option, tr, td").forEach(function(el) {
        var key = am4HubKey(el.textContent);
        if (!key) return;
        var isCountry = countryKeys[key] === true;
        var isAirport = airportKeys.some(function(target) {
            return key === target || (' ' + key + ' ').indexOf(' ' + target + ' ') !== -1;
        });
        var tag = el.tagName.toLowerCase();
        // Country names are only meaningful in the country dropdown, not in the
        // result table
        if ((tag === 'td' || tag === 'tr') && isCountry && !isAirport) return;
        if (isCountry || isAirport) am4PaintHub(el);
    });

    var airportSelector = hubRoot.querySelector("#hubAirportSelector") || hubRoot.querySelector("#hubCityContainer select");
    if (!airportSelector) return;
    airportSelector.querySelectorAll("option").forEach(function(opt) {
        if (opt.classList.contains("bot-premium-airport-tagged")) return;
        var optText = opt.textContent || "" ;
        var key = am4HubKey(optText);
        var matched = airportKeys.filter(function(target) {
            return key === target || (' ' + key + ' ').indexOf(' ' + target + ' ') !== -1;
        })[0];
        if (!matched) return;
        opt.classList.add("bot-premium-airport-tagged");
        opt.dataset.am4OrigText = optText;
        opt.dataset.am4PrevBg = opt.style.backgroundColor || '';
        opt.dataset.am4PrevColor = opt.style.color || '';
        opt.dataset.am4PrevWeight = opt.style.fontWeight || '';
        opt.textContent ="⭐ [BEST HUB] " + optText;
        opt.style.backgroundColor ="#5cb85c" ;
        opt.style.color ="#ffffff" ;
        opt.style.fontWeight ="bold" ;
        console.log("[AM4 Bot Log] Tagged premium airport in the dropdown: " + optText);
    });
}

//================================================================================
// Alliance contribution metrics
//
// Uses the same contribution/flight formula as the current Ultimate Auto Bot:
// floor((lifetimeContribution * 1000) / flights). Alliance sheets print dots as
// thousands separators (1.337.142.450), so those dots are stripped here only.
// Column order is resolved from header text, with the old 2/3/5 fallbacks.
//================================================================================
var am4AllianceCache = { perFlight: 0, perDay: 0, name: '', at: 0, memberId: ''};
var am4AllianceTimer = null;

(function loadAllianceCache() {
    try {
        var raw = JSON.parse(localStorage.getItem('am4AllianceMetrics') || 'null');
        if (raw && typeof raw === 'object') {
            am4AllianceCache = {
                perFlight: Number(raw.perFlight) || 0,
                perDay: Number(raw.perDay) || 0,
                name: String(raw.name || ''),
                at: Number(raw.at) || 0,
                memberId: String(raw.memberId || '')
            };
        }
    } catch (err) { /* ignore */ }
})();

function am4AllianceCellNumber(td) {
    if (!td) return 0;
    return am4ParseAllianceNumber(td.innerText || td.textContent || '');
}

function am4ParseAllianceNumber(raw) {
    var text = String(raw || '').trim();
    if (!text) return 0;
    if (/[kmbt]\b/i.test(text)) {
        var compact = parseFloat(text.replace(/[^0-9.]/g,'')) || 0;
        if (/b\b/i.test(text)) compact *= 1e9;
        else if (/m\b/i.test(text)) compact *= 1e6;
        else if (/k\b/i.test(text)) compact *= 1e3;
        return compact;
    }
    var value = parseFloat(text.replace(/[^0-9.]/g,'').replace(/\./g,'')) ||
        parseInt(text.replace(/[^0-9]/g,''), 10) || 0;
    if (value < 1000 && text.indexOf('.') !== -1 && text.indexOf(',') === -1) {
        value = parseInt(text.replace(/[^0-9]/g,''), 10) || 0;
    }
    return value;
}

function am4MapAllianceColumns(row) {
    var table = row && row.closest ? row.closest('table') : null;
    var headerCells = table ? table.querySelectorAll('thead th, thead td, tr:first-child th') : [];
    var map = { lifetime: -1, daily: -1, flights: -1 };
    for (var i = 0; i < headerCells.length; i++) {
        var label = String(headerCells[i].innerText || '').replace(/\s+/g,' ').trim().toLowerCase();
        if (!label) continue;
        if (map.daily < 0 && /(per day|\/ ?day|daily|today)/.test(label)) map.daily = i;
        else if (map.lifetime < 0 && /contrib/.test(label)) map.lifetime = i;
        if (map.flights < 0 && /flight/.test(label)) map.flights = i;
    }
    return map;
}

// Finds the member row: the configured id, else the highlighted own row (bg-light).
function am4FindAllianceRow(root, configuredId) {
    if (configuredId) {
        var byId = root.querySelector('#al-list-' + configuredId) ||
            root.querySelector("tr[id*='" + configuredId +"']");
        if (byId) return byId;
    }
    var highlighted = root.querySelector("tr[id^='al-list-'].me, tr[id^='al-list-'].active, " +
        "tr[id^='al-list-'].table-primary, tr[id^='al-list-'].bg-light, tr[id^='al-list-'][style*='bold']");
    if (highlighted) return highlighted;
    var rows = root.querySelectorAll("tr[id^='al-list-']");
    for (var i = 0; i < rows.length; i++) {
        if (/\bbg-light\b/.test(rows[i].className)) return rows[i];
    }
    return null;
}

function am4RefreshAllianceMetrics() {
    clearTimeout(am4AllianceTimer);
    var reschedule = function() {
        am4AllianceTimer = setTimeout(am4RefreshAllianceMetrics,
            am4Jitter((Number(AM4_CONFIG.allianceRefreshMin) || 10) * 60 * 1000));
    };
    // Only worth reading while the overlay is actually showing the numbers
    if (!AM4_CONFIG.overlayEnabled || document.hidden) { reschedule(); return; }
    // Quiet hours: skip the alliance read too, so nothing hits the server overnight
    if (am4InQuietHours()) { am4AllianceTimer = setTimeout(am4RefreshAllianceMetrics, am4QuietRescheduleMs()); return; }

    var xhr = new XMLHttpRequest();
    xhr.timeout = 20000;
    var done = false;
    var finish = function() { if (!done) { done = true; reschedule(); } };
    xhr.ontimeout = finish;
    xhr.onerror = finish;
    xhr.onreadystatechange = function() {
        if (xhr.readyState !== 4 || done) return;
        if (xhr.status !== 200) { finish(); return; }
        try {
            var box = document.createElement('div');
            box.innerHTML = xhr.responseText;
            var configuredId = String(AM4_CONFIG.allianceMemberId || '').replace(/[^0-9]/g,'');
            var row = am4FindAllianceRow(box, configuredId);
            if (row) {
                var tds = row.querySelectorAll('td');
                var map = am4MapAllianceColumns(row);
                var lifetimeIndex = map.lifetime >= 0 && map.lifetime < tds.length ? map.lifetime : 2;
                var dailyIndex = map.daily >= 0 && map.daily < tds.length ? map.daily : 3;
                var flightsIndex = map.flights >= 0 && map.flights < tds.length ? map.flights : 5;
                var contributed = am4AllianceCellNumber(tds[lifetimeIndex]);
                var perDay = am4AllianceCellNumber(tds[dailyIndex]);
                var flights = am4AllianceCellNumber(tds[flightsIndex]);
                var name = (tds[0] ? (tds[0].innerText || '') : '').replace(/\s+/g,' ').trim();
                if (perDay > 0 || (contributed > 0 && flights > 0)) {
                    am4AllianceCache = {
                        perFlight: (contributed > 0 && flights > 0) ? Math.floor((contributed * 1000) / flights) : am4AllianceCache.perFlight,
                        perDay: perDay || am4AllianceCache.perDay,
                        name: name || am4AllianceCache.name,
                        at: Date.now(),
                        memberId: row.id.replace('al-list-','')
                    };
                    try { localStorage.setItem('am4AllianceMetrics', JSON.stringify(am4AllianceCache)); } catch (e) {}
                    am4RenderAllianceMetrics();
                }
            }
        } catch (err) {
            console.log('[AM4 Bot Log] Alliance metrics read failed: ' + err.message);
        }
        finish();
    };
    xhr.open('GET','alliance.php?_=' + Date.now(), true);
    xhr.send();
}

function am4RenderAllianceMetrics() {
    var flt = document.getElementById('metricOverlayAllianceFlight');
    var day = document.getElementById('metricOverlayAllianceDay');
    if (flt) flt.innerText = am4AllianceCache.perFlight > 0 ?'$' + am4AllianceCache.perFlight.toLocaleString() : '—';
    if (day) day.innerText = am4AllianceCache.perDay > 0 ?'$' + am4AllianceCache.perDay.toLocaleString() + ' /d' : '—';
}

//================================================================================
// Real net income (Phase C). The header-balance movement the overlay samples is NOT
// accounting profit (it mixes in fuel/CO2/maintenance/campaign spend). The game's own
// 24-hour accounting lives at transactions.php?mode=summary (GAME_CONTRACTS §14):
// labelled Income / Expenses cells plus a category breakdown. We read it on a slow
// background cadence (same pattern as the alliance metrics), cache it, and show
// Income / Expenses / Net (24h) as honest figures. Net is computed as income - expenses
// (matches the page's own "Result" exactly). Quiet hours suppress the read.
//================================================================================
var am4FinanceCache = { income: 0, expenses: 0, net: 0, at: 0 };
var am4FinanceTimer = null;

(function loadFinanceCache() {
    try {
        var raw = JSON.parse(localStorage.getItem('am4FinanceMetrics') || 'null');
        if (raw && typeof raw === 'object') {
            am4FinanceCache = {
                income: Number(raw.income) || 0,
                expenses: Number(raw.expenses) || 0,
                net: Number(raw.net) || 0,
                at: Number(raw.at) || 0
            };
        }
    } catch (err) { /* ignore */ }
})();

function am4ParseFinanceMoney(s) {
    var digits = String(s || '').replace(/[^0-9]/g,'');
    if (!digits) return null;
    var n = parseInt(digits, 10);
    return isNaN(n) ? null : n;
}

// Maps each labelled cell to the next $-bearing span. Exact label text avoids the
//"Income" vs"Ticket income" and"Expenses" vs"Fuel expenses" collisions.
function am4ParseFinanceSummary(html) {
    var box = document.createElement('div');
    box.innerHTML = html;
    var wanted = {'Income' : 'income','Expenses' : 'expenses'};
    var found = {};
    var spans = box.querySelectorAll('span');
    for (var i = 0; i < spans.length; i++) {
        var label = (spans[i].textContent || '').trim();
        var key = wanted[label];
        if (!key || found[key] != null) continue;
        for (var j = i + 1; j < Math.min(i + 4, spans.length); j++) {
            var v = (spans[j].textContent || '').trim();
            if (v.indexOf('$') !== -1) { var n = am4ParseFinanceMoney(v); if (n != null) found[key] = n; break; }
        }
    }
    // Not the summary fragment (logged out / error) -> fail closed, keep the last cache
    if (found.income == null && found.expenses == null) return null;
    var income = found.income || 0, expenses = found.expenses || 0;
    return { income: income, expenses: expenses, net: income - expenses };
}

function am4RefreshFinanceMetrics() {
    clearTimeout(am4FinanceTimer);
    var reschedule = function() {
        am4FinanceTimer = setTimeout(am4RefreshFinanceMetrics,
            am4Jitter((Number(AM4_CONFIG.financeRefreshMin) || 15) * 60 * 1000));
    };
    // Only worth reading while the overlay is actually showing the numbers
    if (!AM4_CONFIG.overlayEnabled || document.hidden) { reschedule(); return; }
    // Quiet hours: don't hit the server overnight
    if (am4InQuietHours()) { am4FinanceTimer = setTimeout(am4RefreshFinanceMetrics, am4QuietRescheduleMs()); return; }

    var xhr = new XMLHttpRequest();
    xhr.timeout = 20000;
    var done = false;
    var finish = function() { if (!done) { done = true; reschedule(); } };
    xhr.ontimeout = finish;
    xhr.onerror = finish;
    xhr.onreadystatechange = function() {
        if (xhr.readyState !== 4 || done) return;
        if (xhr.status !== 200) { finish(); return; }
        try {
            var parsed = am4ParseFinanceSummary(xhr.responseText);
            if (parsed) {
                am4FinanceCache = { income: parsed.income, expenses: parsed.expenses, net: parsed.net, at: Date.now() };
                try { localStorage.setItem('am4FinanceMetrics', JSON.stringify(am4FinanceCache)); } catch (e) {}
                am4RenderFinanceMetrics();
            }
        } catch (err) {
            console.log('[AM4 Bot Log] Finance metrics read failed: ' + err.message);
        }
        finish();
    };
    xhr.open('GET','transactions.php?mode=summary&_=' + Date.now(), true);
    xhr.send();
}

function am4RenderFinanceMetrics() {
    var inc = document.getElementById('metricOverlayIncome24');
    var exp = document.getElementById('metricOverlayExpense24');
    var net = document.getElementById('metricOverlayNet24');
    var have = am4FinanceCache.at > 0;
    if (inc) inc.innerText = have ?'$' + am4FinanceCache.income.toLocaleString() : '—';
    if (exp) exp.innerText = have ?'$' + am4FinanceCache.expenses.toLocaleString() : '—';
    if (net) {
        if (!have) { net.innerText = '—'; net.style.color = '#10b981'; }
        else {
            var n = am4FinanceCache.net;
            net.innerText = (n >= 0 ?'+$' : '-$') + Math.abs(n).toLocaleString();
            net.style.color = n >= 0 ?'#10b981' : '#ef4444';
        }
    }
}

//================================================================================
// Status dashboard (Phase A3). A small in-memory board each automation updates so
// you can see, at a glance, what every module is doing and - importantly - WHY
// nothing is happening ("Depart: nothing ready","Fuel: $1560 over your $1000 
// limit"), instead of reading the F12 console. am4SetStatus() is a pure state write
// (no game request); the panel re-renders itself on a slow interval while open.
//================================================================================
var am4Status = {
    depart: { state: 'idle', note: '', at: 0, next: 0 },
    buyer: { state: 'idle', note: '', at: 0, next: 0 },
    marketing: { state: 'idle', note: '', at: 0, next: 0 },
    repair: { state: 'idle', note: '', at: 0, next: 0 },
    check: { state: 'idle', note: '', at: 0, next: 0 }
};
var am4StatusPanelTimer = null;

// ---- Action log: a chronological feed of REAL actions ("Departed 20","Bought fuel" ,
//"Campaign bought" ,"Repair planned" , build steps) shown in the 📊 dashboard. Persisted
// to localStorage so it survives reloads. am4LogAction() is a pure state write (no game
// request) and never throws into its caller.
var AM4_ACTION_LOG_KEY = 'am4ActionLog';
var AM4_ACTION_LOG_MAX = 250;
var am4ActionLog = [];
(function loadActionLog() {
    try {
        var raw = JSON.parse(localStorage.getItem(AM4_ACTION_LOG_KEY) || '[]');
        if (Array.isArray(raw)) am4ActionLog = raw.filter(function (e) { return e && typeof e.at === 'number' && typeof e.text === 'string'; }).slice(-AM4_ACTION_LOG_MAX);
    } catch (e) { am4ActionLog = []; }
})();
function am4PushAction(mod, text) {
    try {
        am4ActionLog.push({ at: Date.now(), mod: String(mod || ''), text: String(text || '') });
        if (am4ActionLog.length > AM4_ACTION_LOG_MAX) am4ActionLog = am4ActionLog.slice(-AM4_ACTION_LOG_MAX);
        try { localStorage.setItem(AM4_ACTION_LOG_KEY, JSON.stringify(am4ActionLog)); } catch (e2) { /* storage full */ }
        if (document.getElementById('am4StatusLog')) am4RenderActionLog();
    } catch (e) { /* best-effort */ }
}

function am4LogAction(mod, text) {
    am4PushAction(mod, text);
    try { am4NativeConsoleLog('[AM4 Bot Log] ▸ ' + text); } catch (e) { /* ignore */ }
    if (mod === 'depart' || mod === 'buyer') {
        try { am4ShowLiveAction(text,'#10b981'); } catch (eLive) { /* ignore */ }
    }
}

if (am4LogBuffer.length) {
    var am4Flush = am4LogBuffer.slice();
    am4LogBuffer.length = 0;
    for (var am4FlushI = 0; am4FlushI < am4Flush.length; am4FlushI++) am4PushAction('log', am4Flush[am4FlushI]);
}

// Modules call this at their key transitions. It never issues a request and never
// throws into the caller (a broken status write must not break an automation).
function am4SetStatus(mod, patch) {
    try {
        if (!am4Status[mod]) am4Status[mod] = { state: 'idle', note: '', at: 0, next: 0 };
        if (patch && typeof patch === 'object') {
            Object.keys(patch).forEach(function (k) { am4Status[mod][k] = patch[k]; });
            if (!('at' in patch)) am4Status[mod].at = Date.now();
        }
        if (document.getElementById('am4StatusPanel')) am4RenderStatusPanel();
    } catch (e) { /* status is best-effort */ }
}

function am4RelTime(ts) {
    if (!ts) return '—';
    var d = Date.now() - ts;
    var future = d < 0; d = Math.abs(d);
    var s = Math.round(d / 1000);
    var out = s < 60 ? s + 's' : s < 3600 ? Math.round(s / 60) + 'm' : (s / 3600).toFixed(1) + 'h';
    return future ? ('in ' + out) : (out + ' ago');
}

var AM4_STATUS_MODULES = [
    { key: 'depart', toggle: 'autoDepartCheckbox', label: 'Auto-Depart'},
    { key: 'buyer', toggle: 'autoBuyerCheckbox', label: 'Auto-Buy Specs'},
    { key: 'marketing', toggle: 'autoMarketingCheckbox', label: 'Auto-Buy Mktg'},
    { key: 'repair', toggle: 'autoRepairCheckbox', label: 'Auto-Repair'},
    { key: 'check', toggle: 'autoCheckCheckbox', label: 'Auto-Check'}
];

// The effective state shown is derived at render time so individual modules never
// have to know about the off / quiet / low-funds gates - those win over their state.
function am4EffectiveState(m) {
    var cb = document.getElementById(m.toggle);
    if (!cb || !cb.checked) return { s: 'off', c: '#64748b'};
    if (isBotPausedDueToFunds) return { s: 'paused · low funds', c: '#ef4444'};
    if (am4InQuietHours()) return { s: 'quiet', c: '#fbbf24'};
    var st = am4Status[m.key] || {};
    var colors = { running: '#38bdf8', idle: '#10b981', error: '#ef4444', paused: '#f59e0b', waiting: '#94a3b8'};
    return { s: st.state || 'idle', c: colors[st.state] || '#10b981'};
}

function am4InjectStatusButton() {
    var bar = document.getElementById('am4ControlBar');
    if (!bar || document.getElementById('am4StatusBtn')) return;
    am4ExpInjectStyles(); // reuse the Explorer's button styling block
    var btn = document.createElement('span');
    btn.id = 'am4StatusBtn';
    btn.className = '';
    btn.title = 'AM4 status dashboard - what each automation is doing and why';
    btn.style.cssText = 'cursor:pointer; color:#38bdf8; font-size:13px; line-height:1; padding:2px 6px; border-radius:4px; user-select:none; font-family:monospace; white-space:nowrap;';
    btn.innerText = '📊 Status';
    var explorer = document.getElementById('am4ExplorerBtn');
    if (explorer && explorer.parentElement === bar) bar.insertBefore(btn, explorer);
    else bar.appendChild(btn);
    btn.addEventListener('mouseenter', function () { btn.style.background = 'rgba(56,189,248,0.15)'; });
    btn.addEventListener('mouseleave', function () { btn.style.background = ''; });
    btn.addEventListener('click', am4ToggleStatusPanel);
}

function am4ToggleStatusPanel() {
    var panel = document.getElementById('am4StatusPanel');
    if (panel && panel.style.display === 'block') {
        panel.style.display = 'none';
        clearInterval(am4StatusPanelTimer); am4StatusPanelTimer = null;
        return;
    }
    am4BuildStatusPanel().style.display = 'block';
    am4RenderStatusPanel();
    clearInterval(am4StatusPanelTimer);
    am4StatusPanelTimer = setInterval(am4RenderStatusPanel, 2000);
}

function am4BuildStatusPanel() {
    var old = document.getElementById('am4StatusPanel');
    if (old) return old;
    var panel = document.createElement('div');
    panel.id = 'am4StatusPanel';
    panel.style.cssText = 'position:fixed; top:60px; right:20px; width:min(430px, calc(100vw - 24px)); max-height:84vh; overflow-y:auto; background:rgba(15,19,26,0.98); border:1px solid #34495e; border-radius:8px; color:#e2e8f0; font-family:monospace; font-size:12px; z-index:1041; padding:14px; box-shadow:0 6px 24px rgba(0,0,0,0.6); display:none;';
    panel.innerHTML =
        "<div style='display:flex; margin-bottom:6px;'><span style='flex-grow:1; font-size:13px; font-weight:bold; color:#38bdf8; letter-spacing:1px;'>📊 STATUS DASHBOARD</span>" +
        "<span id='am4StatusClose' style='cursor:pointer; color:#ef4444; font-weight:bold; padding:0 4px;'>[X]</span></div>" +
        "<div id='am4StatusGlobal' style='font-size:10px; color:#64748b; margin-bottom:8px; line-height:1.5;'></div>" +
        "<div id='am4StatusBody'></div>" +
        "<div style='display:flex; align-items:center; border-top:1px dashed #334155; margin-top:8px; padding-top:6px;'><span style='flex-grow:1; font-weight:bold; color:#f59e0b; font-size:11px; letter-spacing:0.5px;'>RECENT ACTIONS</span><span id='am4StatusLogClear' style='cursor:pointer; color:#64748b; font-size:10px;'>clear</span></div>" +
        "<div id='am4StatusLog' style='max-height:320px; overflow-y:auto; margin-top:4px;'></div>" +
        "<div style='font-size:9px; color:#64748b; margin-top:8px; border-top:1px dashed #334155; padding-top:6px;'>Live view of the in-memory status - no extra game requests. \"off\" = toggle is switched off; \"quiet\" = inside your quiet-hours window. RECENT ACTIONS is a persisted log of what actually happened (survives reloads).</div>";
    document.body.appendChild(panel);
    panel.querySelector('#am4StatusClose').addEventListener('click', am4ToggleStatusPanel);
    var _clr = panel.querySelector('#am4StatusLogClear');
    if (_clr) _clr.addEventListener('click', function () { am4ActionLog = []; try { localStorage.setItem(AM4_ACTION_LOG_KEY,'[]'); } catch (e) { /* ignore */ } am4RenderActionLog(); });
    am4PanelChrome(panel,'status');
    return panel;
}

function am4RenderStatusPanel() {
    var body = document.getElementById('am4StatusBody');
    if (!body) return;
    var rows = AM4_STATUS_MODULES.map(function (m) {
        var eff = am4EffectiveState(m);
        var st = am4Status[m.key] || {};
        var note = st.note ? am4EscapeHtml(st.note) : '<span style="color:#475569;">—</span>';
        var when = st.at ? am4RelTime(st.at) : '—';
        var next = (st.next && eff.s !== 'off') ? am4RelTime(st.next) : '';
        return"<div style='display:flex; align-items:baseline; gap:8px; padding:5px 0; border-bottom:1px solid #1e293b;'>" +
            "<span style='width:96px; color:#cbd5e1; flex-shrink:0;'>" + am4EscapeHtml(m.label) +"</span>" +
            "<span style='width:96px; flex-shrink:0; font-weight:bold; color:" + eff.c +";'>" + am4EscapeHtml(eff.s) +"</span>" +
            "<span style='flex-grow:1; color:#94a3b8; word-break:break-word;'>" + note +
                (next ? " <span style='color:#475569;'>· next " + next +"</span>" : "") +
                "<br><span style='color:#475569; font-size:10px;'>" + when +"</span></span>" +
            "</div>";
    }).join('');
    body.innerHTML = rows;

    var g = document.getElementById('am4StatusGlobal');
    if (g) {
        var acting = (typeof am4TabIsActing === 'function') ? am4TabIsActing() : true;
        var quiet = am4InQuietHours();
        g.innerHTML =
            'This tab: <b style="color: ' + (acting ? '#10b981' : '#f59e0b') + ';">' + (acting ? 'acting (lease held)' : 'read-only (another tab acts)') + '</b>' +
            ' · Quiet hours: <b style="color: ' + (quiet ? '#fbbf24' : '#64748b') + ';">' + (quiet ? 'ON' : 'off') + '</b>' +
            ' · Low-funds brake: <b style="color: ' + (isBotPausedDueToFunds ? '#ef4444' : '#64748b') + ';">' + (isBotPausedDueToFunds ? 'ENGAGED' : 'off') + '</b>';
    }
    am4RenderActionLog();
}

// Renders the newest-first action feed into the dashboard's RECENT ACTIONS box.
function am4RenderActionLog() {
    var el = document.getElementById('am4StatusLog');
    if (!el) return;
    if (!am4ActionLog.length) { el.innerHTML ="<div style='color:#475569; padding:2px 0;'>No actions logged yet — research, depart, buy, marketing, maintenance and build all appear here.</div>" ; return; }
    el.innerHTML = am4ActionLog.slice().reverse().map(function (e) {
        return"<div style='display:flex; gap:8px; padding:2px 0; border-bottom:1px solid #1e293b;'>" +
            "<span style='color:#64748b; font-size:10px; width:54px; flex-shrink:0;'>" + am4RelTime(e.at) +"</span>" +
            "<span style='color:#cbd5e1; word-break:break-word;'>" + am4EscapeHtml(e.text) +"</span></div>" ;
    }).join('');
}

// Exposed for headless (CDP) testing of the action log + dashboard.
window.AM4Status = { logAction: am4LogAction, buildPanel: am4BuildStatusPanel, renderLog: am4RenderActionLog, log: function () { return am4ActionLog.slice(); } };


// PART 12 OF 13: LIVE FINANCIAL OVERLAY INTERFACE CARRIER
function applyOverlayCollapseState(container) {
    var body = container.querySelector('#am4OverlayBody');
    var btn = container.querySelector('#am4OverlayCollapseBtn');
    var collapsed = !!AM4_CONFIG.overlayCollapsed;
    if (body) body.style.display = collapsed ?'none' : 'block';
    if (btn) {
        btn.innerText = collapsed ?'[+]' : '[-]';
        btn.title = collapsed ?'Expand metrics' : 'Collapse to title bar';
    }
    container.style.width = collapsed ?'auto' : '260px';
}

function buildFinancialOverlay() {
    var existing = document.getElementById('am4FinancialMetricsDashboard');
    if (existing) existing.remove();
    if (!AM4_CONFIG.overlayEnabled) {
        // Sampling stops while the overlay is gone, so drop the stale baseline and
        // rolling window - otherwise the whole hidden period comes back as one
        // enormous 10-second tick when the overlay is switched on again
        lastMonitoredBalance = null;
        am4BaselineCash = 0;
        netRevenueIntervalTicks.length = 0;
        return null;
    }

    var container = document.createElement('div');
    container.id = 'am4FinancialMetricsDashboard';
    container.style.position = 'fixed';
    container.style.bottom = '20px';
    // Side is configurable - the overlay used to sit permanently over the game's
    // bottom-left controls
    if (AM4_CONFIG.overlayPosition === 'right') {
        container.style.right = '20px';
        container.style.left = 'auto';
    } else {
        container.style.left = '20px';
        container.style.right = 'auto';
    }
    container.style.width = '260px';
    container.style.background = 'rgba(20,24,30,0.92)';
    container.style.border = '1px solid #34495e';
    container.style.borderRadius = '6px';
    container.style.color = '#fff';
    container.style.fontFamily = 'monospace';
    container.style.fontSize = '11px';
    // Below the game's own modals (which sit at 1050) so the overlay can never cover
    // dialog content or swallow a click meant for the game
    container.style.zIndex = '1040';
    container.style.padding = '10px';
    container.style.boxShadow = '0 4px 15px rgba(0,0,0,0.5)';
    container.style.pointerEvents = 'auto';
    container.innerHTML = [
        '<div style="font-weight:bold; color:#38bdf8; display:flex; align-items:center; white-space:nowrap;" id="am4OverlayHeader">',
        '<span style="flex-grow:1;">AM4 FINANCIAL METRICS</span>',
        '<span style="cursor:pointer; color:#94a3b8; font-weight:bold; padding:0 4px;" id="am4OverlayCollapseBtn">[-]</span>',
        '<span style="cursor:pointer; color:#ef4444; font-weight:bold; padding:0 4px;" id="closeOverlayBtn" title="Hide (bring back via the settings panel)">[X]</span>',
        '</div>',
        '<div id="am4OverlayBody">',
        '<div id="am4LiveAction" style="min-height:16px; font-size:11px; font-weight:bold; color: ' +
            (am4LastLiveAction.color || '#38bdf8') + '; margin:0 0 6px 0; line-height:1.3;">' +
            (am4LastLiveAction.text ? String(am4LastLiveAction.text).replace(/[<>]/g,'') : 'Waiting for auto-depart / fuel / CO2…') + '</div>',
        '<div style="border-bottom:1px solid #475569; margin-bottom:6px; padding-bottom:4px;"></div>',
        '<table style="width:100%; border-collapse:collapse;">',
        '<tr><td style="color:#aaa; padding:2px 0;">Cash flow/min:</td><td id="metricOverlayFlow" style="text-align:right; font-weight:bold; color:#38bdf8;">collecting…</td></tr>',
        '<tr><td style="color:#aaa; padding:2px 0;">Session change:</td><td id="metricOverlaySession" style="text-align:right; font-weight:bold; color:#10b981;">---</td></tr>',
        '<tr><td style="color:#aaa; padding:2px 0;">Avg fuel paid:</td><td id="metricOverlayFuelSpend" style="text-align:right; color:#f59e0b;">---</td></tr>',
        '<tr><td style="color:#aaa; padding:2px 0;">Avg CO2 paid:</td><td id="metricOverlayCo2Spend" style="text-align:right; color:#f59e0b;">---</td></tr>',
        '<tr><td style="color:#aaa; padding:2px 0; border-top:1px dashed #334155;">Alliance $/flight:</td><td id="metricOverlayAllianceFlight" style="text-align:right; color:#c084fc; font-weight:bold; border-top:1px dashed #334155;">—</td></tr>',
        '<tr><td style="color:#aaa; padding:2px 0;">Alliance $/day:</td><td id="metricOverlayAllianceDay" style="text-align:right; color:#c084fc; font-weight:bold;">—</td></tr>',
        '<tr><td style="color:#aaa; padding:2px 0; border-top:1px dashed #334155;">Income (24h):</td><td id="metricOverlayIncome24" style="text-align:right; color:#10b981; border-top:1px dashed #334155;">—</td></tr>',
        '<tr><td style="color:#aaa; padding:2px 0;">Expenses (24h):</td><td id="metricOverlayExpense24" style="text-align:right; color:#f59e0b;">—</td></tr>',
        '<tr><td style="color:#aaa; padding:2px 0;">Net (24h):</td><td id="metricOverlayNet24" style="text-align:right; font-weight:bold; color:#10b981;">—</td></tr>',
        '</table>',
        '<div style="font-size:9px; color:#64748b; margin-top:6px; border-top:1px dashed #334155; padding-top:4px; text-align:center;">Cash flow / session change = header-balance movement this browser session. Income / Expenses / Net (24h) = the game\'s own accounting (finances).</div>',
        '</div>'
    ].join('');
    document.body.appendChild(container);

    var collapseBtn = container.querySelector('#am4OverlayCollapseBtn');
    if (collapseBtn) {
        collapseBtn.addEventListener('click', function() {
            AM4_CONFIG.overlayCollapsed = !AM4_CONFIG.overlayCollapsed;
            persistAm4Config();
            applyOverlayCollapseState(container);
        });
    }
    var closeBtn = container.querySelector('#closeOverlayBtn');
    if (closeBtn) {
        closeBtn.addEventListener('click', function() {
            AM4_CONFIG.overlayEnabled = false;
            persistAm4Config();
            buildFinancialOverlay(); // removes the node and clears the sampling state
            // Keep an already-open settings panel in sync, otherwise its stale checked
            // box would resurrect the overlay on the next Save & Apply
            var mirror = document.querySelector('#am4SettingsPanel [data-key="overlayEnabled"]');
            if (mirror) mirror.checked = false;
            console.log('[AM4 Bot Log] Financial overlay hidden - re-enable it in the settings panel.');
        });
    }
    applyOverlayCollapseState(container);
    am4RenderAllianceMetrics(); // fill the alliance rows from the cache immediately
    am4RenderFinanceMetrics(); // and the 24h income/expenses/net rows from cache
    am4PanelChrome(container,'overlay', { noCollapse: true }); // it already has its own [-]/[+]
    return container;
}
// PART 13 OF 13: FINANCIAL ROLLING SCRAPER MASTER CALCULATIONS
//
// What this measures is the balance in the header moving up and down while the tab
// is open. That is NOT net income and never was: it mixes flight revenue with fuel,
// CO2, maintenance and campaign spending. The overlay says so now instead of calling
// it"Net Income" and printing a payback estimate derived from a hardcoded
// $45,000,000 that had no relation to the actual fleet.
//
// Samples carry their real elapsed time. A background tab has its timers throttled,
// so treating every tick as exactly ten seconds silently inflated the per-minute
// figure by whatever factor the browser had slowed the timer down.
function am4WeightedAveragePrice(list) {
    var value = 0;
    var units = 0;
    list.forEach(function(p) {
        var amount = Number(p.amount) || 0;
        if (amount <= 0) return;
        value += Number(p.price) * amount;
        units += amount;
    });
    if (units <= 0) return null;
    return value / units;
}

setInterval(function() {
    var overlayBox = document.getElementById('am4FinancialMetricsDashboard');
    if (!overlayBox || overlayBox.style.display === 'none') return;
    var headerElement = document.getElementById('headerAccount');
    if (!headerElement) return;
    var raw = String(headerElement.innerText || '').replace(/[^0-9-]/g,'');
    if (raw === '' || raw === '-') return;
    var currentCash = parseInt(raw, 10);
    if (!isFinite(currentCash)) return;

    var now = Date.now();
    // null, not 0 - a real balance of 0 used to re-baseline on every single tick
    if (lastMonitoredBalance === null) {
        lastMonitoredBalance = currentCash;
        am4BaselineCash = currentCash;
        am4LastSampleAt = now;
        return;
    }
    var elapsed = now - am4LastSampleAt;
    am4LastSampleAt = now;
    var netDifference = currentCash - lastMonitoredBalance;
    lastMonitoredBalance = currentCash;

    // No magnitude cutoff. Discarding every movement above $15M threw away exactly
    // the events that dominate an airline's cash flow - big arrivals, aircraft
    // purchases, bulk maintenance - and made the number look calm and wrong.
    if (elapsed > 0) {
        netRevenueIntervalTicks.push({ delta: netDifference, ms: elapsed });
        if (netRevenueIntervalTicks.length > 60) netRevenueIntervalTicks.shift();
    }

    var deltaSum = 0;
    var msSum = 0;
    netRevenueIntervalTicks.forEach(function(tick) {
        deltaSum += tick.delta;
        msSum += tick.ms;
    });

    var fField = document.getElementById('metricOverlayFlow');
    if (fField) {
        if (msSum < 30000) {
            fField.innerText = 'collecting…';
            fField.style.color = '#94a3b8';
        } else {
            var flowPerMin = Math.round(deltaSum / (msSum / 60000));
            fField.innerText = (flowPerMin >= 0 ?'+ ' : '') + flowPerMin.toLocaleString() + ' /m';
            fField.style.color = flowPerMin >= 0 ?'#10b981' : '#ef4444';
        }
    }
    var sField = document.getElementById('metricOverlaySession');
    if (sField) {
        var sessionChange = currentCash - am4BaselineCash;
        sField.innerText = (sessionChange >= 0 ?'+ ' : '') + sessionChange.toLocaleString();
        sField.style.color = sessionChange >= 0 ?'#10b981' : '#ef4444';
    }

    // Quantity-weighted, so one small top-up no longer counts as much as a full tank
    var fuelField = document.getElementById('metricOverlayFuelSpend');
    if (fuelField) {
        var fuelAvg = am4WeightedAveragePrice(am4FuelPurchases);
        fuelField.innerText = fuelAvg === null ?'no buys yet' : '$' + Math.round(fuelAvg).toLocaleString();
    }
    var co2Field = document.getElementById('metricOverlayCo2Spend');
    if (co2Field) {
        var co2Avg = am4WeightedAveragePrice(am4Co2Purchases);
        co2Field.innerText = co2Avg === null ?'no buys yet' : '$' + Math.round(co2Avg).toLocaleString();
    }
    // Keep the alliance + finance rows populated from the cache between background refreshes
    am4RenderAllianceMetrics();
    am4RenderFinanceMetrics();
}, 10000);

//================================================================================
// Part 14 of 14: RESEARCH EXPLORER (read-only)
//
// Ranks the airline's owned hubs by how many "good" A380-800 routes they offer and
// opens a results tab listing them, with an exact"X built / Y good / Z remaining" 
// counter per hub and overall. Nothing here spends money or points - it only reads
// research_main.php (the same search the game's Research page runs) and the live map
// globals`routeMarkers` +`airportIconData` to detect which routes already exist.
//
// A"good route" = destination runway >= minRwy, one-way distance <= the">= N 
// departures/day" ceiling (floor(24 / deps / 2 * cruiseKph)), and the demand-derived
// seat split fills the 600-seat plane to >= goodFillPct. Seat weights Y=1/J=2/F=4;
// ticket price Y=0.4d+170, J=0.8d+560, F=1.2d+1200 (all verified live - see
// GAME_CONTRACTS.md sec. 10). Two fill strategies: 'revenue' (J->Y->F, revenue-optimal)
// and'economy-first' (Y->J->F, the user's older habit).
//
// Built detection: every route the airline flies is a Leaflet polyline in the live
//`routeMarkers` object; its first/last coordinate resolve against`airportIconData` 
// (3900+ airports with lat/lon/icao/Id) to an airport Id. Because the research search
// row's onclick carries arr=<airportId> in that SAME id space, a good route counts as
// built iff its arr id is one of the hub's flown destination ids (undirected - the
// polyline direction is not reliable, so both endpoints are recorded).
//================================================================================

//================================================================================
// AIRCRAFT PROFILE — one selected type drives Strategy, Explorer, Fleet, Modify,
// Auto-Build and Rebuild. Defaults stay A380-800 so existing saves keep working
// until you pick another type in the Fleet / Strategy panels.
//================================================================================
var AM4_AIRCRAFT_KEY = 'am4MasterSuiteAircraft';
var AM4_AIRCRAFT_CATALOG_KEY = 'am4MasterSuiteAircraftCatalog';
var AM4_AIRCRAFT_PROFILES_KEY = 'am4MasterSuiteAircraftProfiles';
var AM4_STRAT_N_MIN = 1;
var AM4_STRAT_N_MAX = 24;
var AM4_STRAT_PRESETS = [2, 3, 4];

function am4AircraftDefault() {
    return {
        typeId: 2,
        name: 'A380-800',
        engineId: 7,
        engineName: 'RR Trent 972',
        engines: [{ id: 7, name: 'RR Trent 972'}],
        seats: 600,
        cruiseStock: 1049,
        cruiseMod: 1154,
        rangeKm: 14500,
        minRwy: 0,
        iconId: 13,
        unitCost: 215629503,
        cargo: false,
        cargoAft: 0,
        cargoFwd: 0,
        cargoAftH: 0,
        cargoFwdH: 0,
        orderAcid: 0,
        regMaxLen: 10,
        orderBind: null,
        orderY: 0,
        orderJ: 0,
        orderF: 0,
        cargoKg: 0,
        maxAcOrder: null,
        modCostEst: 10781475 + 15094065 + 17250360
    };
}

// Empty stats for a type that has not been read from the order page yet. Used on type
// switch so A380 speed/cost/engines cannot leak into an MC-21 (or any other model).
function am4AircraftBlank(typeId, name) {
    typeId = parseInt(typeId, 10) || 0;
    return {
        typeId: typeId,
        name: name || (typeId ? ('Type ' + typeId) : ''),
        engineId: 0,
        engineName: '',
        engines: [],
        seats: 0,
        cruiseStock: 0,
        cruiseMod: 0,
        rangeKm: 0,
        minRwy: 0,
        iconId: 0,
        unitCost: 0,
        cargo: false,
        cargoAft: 0,
        cargoFwd: 0,
        cargoAftH: 0,
        cargoFwdH: 0,
        orderAcid: 0,
        regMaxLen: 10,
        orderBind: null,
        orderY: 0,
        orderJ: 0,
        orderF: 0,
        cargoKg: 0,
        maxAcOrder: null,
        modCostEst: 0
    };
}

function am4AircraftEngineNameIsGeneric(name) {
    return !name || /^engine\s+\d+$/i.test(String(name).trim());
}

function am4AircraftSanitizeSeats(p) {
    if (!p || typeof p !== 'object') return p;
    var seats = Math.max(0, parseInt(p.seats, 10) || 0);
    var before = seats;
    // Hangar / UI leftovers are usually small (≤40). A long-range pax type with that
    //"capacity" is corrupt (Explorer then scores Y25 J0 F0 while range/speed stay correct).
    if (!p.cargo && seats > 0 && seats <= 40 && (p.rangeKm || 0) >= 3500 && !p.seatsFromMax) {
        seats = 0;
    }
    // A380-800 (type 2) is always 600 slots when capacity is missing or still corrupt.
    if ((p.typeId === 2 || (/A380-800(?!F)/i.test(String(p.name || '')) && !p.cargo)) &&
        (seats === 0 || seats < 200)) {
        seats = 600;
    }
    p.seats = seats;
    if (seats !== before) {
        console.log('[AM4 Bot Log] Seat capacity for ' + (p.name || ('type ' + p.typeId)) +
            ': ' + before + ' → ' + seats + (seats === 600 && before && before < 200 ?' (A380 restore)' : ''));
        try {
            if (p === am4AircraftCurrent || (am4AircraftCurrent && p.typeId === am4AircraftCurrent.typeId)) {
                localStorage.setItem(AM4_AIRCRAFT_KEY, JSON.stringify(am4AircraftMerge(null, p)));
                am4AircraftStoreProfile(p);
            }
        } catch (eSave) { /* ignore */ }
    }
    return p;
}

function am4AircraftParseCapacityFromDom(box) {
    if (!box || !box.querySelector) return 0;
    var best = 0;
    ['eSeat', 'bSeat', 'fSeat'].forEach(function (id) {
        var el = box.querySelector('#' + id) || box.querySelector('[name="' + id + '"]');
        if (!el) return;
        var mx = parseInt(String(el.getAttribute('max') || el.getAttribute('data-max') || ''), 10);
        if (mx > best) best = mx;
    });
    var text = String(box.innerText || box.textContent || '').replace(/\s+/g, ' ');
    var totM = text.match(/(\d{2,4})\s*\/\s*(\d{2,4})\s*(?:seat|slot|pax)/i) ||
        text.match(/(?:total|max(?:imum)?)\s*(?:seat|slot|pax|capacity)[^0-9]{0,20}(\d{2,4})/i) ||
        text.match(/(?:seat|slot|pax|capacity)\s*(?:cap(?:acity)?)?[^0-9]{0,12}(\d{2,4})/i);
    if (totM) {
        var n = parseInt(String(totM[totM.length - 1] || totM[1]).replace(/[^0-9]/g, ''), 10);
        if (n > best) best = n;
    }
    return (best >= 41 && best <= 1000) ? best : 0;
}

function am4AircraftParseCapacity(html, prevSeats, asCargo) {
    var raw = String(html || '');
    var prev = Math.max(0, parseInt(prevSeats, 10) || 0);
    if (asCargo) {
        var kgM = raw.match(/cargoCap\s*=\s*(\d+)/i) || raw.match(/maxCargo\s*=\s*(\d+)/i) ||
            raw.match(/maxLoad\s*=\s*(\d+)/i) || raw.match(/\b([\d,]{4,7})\s*kg\b/i);
        if (kgM) {
            var kg = parseInt(String(kgM[1]).replace(/[^0-9]/g,''), 10);
            if (kg >= 1000 && kg <= 2000000) return kg;
        }
    }
    var jsNames = ['maxSeats', 'totalSeats', 'acCapacity', 'defSeats', 'maxPax', 'seatMax', 'maxSeat', 'paxMax', 'capacityMax'];
    var si, sm, sn, bestJs = 0;
    for (si = 0; si < jsNames.length; si++) {
        sm = new RegExp('(?:var\\s+)?' + jsNames[si] + '\\s*=\\s*(\\d+)', 'i').exec(raw);
        if (!sm) continue;
        sn = parseInt(sm[1], 10);
        if (asCargo && sn >= 1000 && sn <= 2000000) return sn;
        if (sn >= 10 && sn <= 1000 && sn > bestJs) bestJs = sn;
    }
    if (bestJs) return bestJs;
    var strong = raw.match(/maxSeats\s*=\s*(\d+)/i) || raw.match(/totalSeats\s*=\s*(\d+)/i);
    if (strong) {
        sn = parseInt(strong[1], 10);
        if (asCargo && sn >= 1000 && sn <= 2000000) return sn;
        if (sn >= 10 && sn <= 1000) return sn;
    }
    var box = document.createElement('div');
    box.innerHTML = raw;
    var domCap = am4AircraftParseCapacityFromDom(box);
    if (domCap) return domCap;
    var weak = raw.match(/\bcapacity[^0-9]{0,24}([\d,]{2,7})\b/i) ||
        raw.match(/\b([\d,]{2,4})\s*PAX\b/i) ||
        raw.match(/\b([\d,]{2,4})\s*seats\b/i);
    if (!weak) return 0;
    var wn = parseInt(String(weak[1]).replace(/[^0-9]/g,''), 10);
    if (asCargo && wn >= 1000 && wn <= 2000000) return wn;
    if (!(wn >= 10 && wn <= 1000)) return 0;
    // Never let a weak match shrink a known widebody capacity down to hangar/order leftovers.
    if (prev >= 100 && wn < Math.min(100, Math.floor(prev * 0.4))) return 0;
    // Order-form defaults (often Y=25) are not max capacity — ignore on long-range types.
    var rangeM = raw.match(/([\d,]+)\s*km/i);
    var rangeHint = rangeM ? parseInt(String(rangeM[1]).replace(/[^0-9]/g,''), 10) : 0;
    if (wn <= 40 && rangeHint >= 3500) return prev > 0 ? prev : 0;
    return wn;
}

function am4AircraftMerge(base, extra) {
    var src = extra && typeof extra === 'object' ? extra : {};
    var typeId = parseInt(src.typeId, 10) || parseInt((base && base.typeId), 10) || 0;
    var out = (typeId === 2) ? am4AircraftDefault() : am4AircraftBlank(typeId, src.name || (base && base.name));
    [base, src].forEach(function (from) {
        if (!from || typeof from !== 'object') return;
        var fromId = parseInt(from.typeId, 10);
        if (fromId && typeId && fromId !== typeId) return;
        Object.keys(out).forEach(function (k) {
            if (from[k] === undefined || from[k] === null || from[k] === '') return;
            out[k] = from[k];
        });
    });
    out.typeId = parseInt(out.typeId, 10) || typeId || 2;
    out.engineId = parseInt(out.engineId, 10) || 0;
    out.seats = Math.max(0, parseInt(out.seats, 10) || 0);
    out.cruiseStock = Math.max(0, parseInt(out.cruiseStock, 10) || 0);
    out.cruiseMod = out.cruiseStock ? Math.max(out.cruiseStock, parseInt(out.cruiseMod, 10) || Math.round(out.cruiseStock * 1.1)) : 0;
    out.rangeKm = Math.max(0, parseInt(out.rangeKm, 10) || 0);
    out.minRwy = Math.max(0, parseInt(out.minRwy, 10) || 0);
    out.iconId = parseInt(out.iconId, 10) || 0;
    out.cargo = !!out.cargo;
    out.cargoAft = Math.max(0, parseInt(out.cargoAft, 10) || 0);
    out.cargoFwd = Math.max(0, parseInt(out.cargoFwd, 10) || 0);
    out.cargoAftH = Math.max(0, parseInt(out.cargoAftH, 10) || 0);
    out.cargoFwdH = Math.max(0, parseInt(out.cargoFwdH, 10) || 0);
    out.orderY = Math.max(0, parseInt(out.orderY, 10) || 0);
    out.orderJ = Math.max(0, parseInt(out.orderJ, 10) || 0);
    out.orderF = Math.max(0, parseInt(out.orderF, 10) || 0);
    out.cargoKg = Math.max(0, parseInt(out.cargoKg, 10) || 0);
    out.unitCost = Math.max(0, parseInt(out.unitCost, 10) || 0);
    out.modCostEst = Math.max(0, parseInt(out.modCostEst, 10) || 0);
    if (am4AircraftIsGenericName(out.name)) out.name = 'Type ' + out.typeId;
    if (!Array.isArray(out.engines)) out.engines = [];
    out.engines = out.engines.filter(function (e) { return e && parseInt(e.id, 10); }).map(function (e) {
        return { id: parseInt(e.id, 10), name: String(e.name || '').trim() };
    });
    if (out.engineId && out.engines.length) {
        var keep = out.engines.filter(function (e) { return e.id === out.engineId; })[0];
        if (!keep) {
            out.engineId = out.engines[0].id;
            out.engineName = out.engines[0].name;
        } else if (!am4AircraftEngineNameIsGeneric(keep.name)) {
            out.engineName = keep.name;
        }
    }
    return am4AircraftSanitizeCargo(am4AircraftSanitizeSeats(out));
}

function am4AircraftLooksFreighter(name) {
    name = String(name || '');
    return /freighter|cargo\s*plane|\bBCF\b|\bSF\b|-\d+F\b|-\d+F$|-800F|-400F|-200F|-300F/i.test(name);
}

function am4AircraftSanitizeCargo(p) {
    if (!p || typeof p !== 'object') return p;
    // Stale cargo flag saved before detection was fixed — pax types carry seats, not kg payload.
    if (p.cargo && !(p.cargoKg > 0) && !am4AircraftLooksFreighter(p.name) && (p.seats || 0) > 0) {
        p.cargo = false;
        p.cargoKg = 0;
        p.cargoAft = 0;
        p.cargoFwd = 0;
        p.cargoAftH = 0;
        p.cargoFwdH = 0;
    }
    return p;
}

function am4AircraftLoad() {
    try {
        var raw = JSON.parse(localStorage.getItem(AM4_AIRCRAFT_KEY) || 'null');
        if (raw && typeof raw === 'object') return am4AircraftMerge(null, raw);
    } catch (e) { /* ignore */ }
    return am4AircraftDefault();
}

function am4AircraftSave(profile) {
    var p = am4AircraftMerge(null, profile);
    try { localStorage.setItem(AM4_AIRCRAFT_KEY, JSON.stringify(p)); } catch (e) { /* ignore */ }
    am4AircraftStoreProfile(p);
    return p;
}

var am4AircraftProfiles = {};
(function loadAircraftProfiles() {
    try {
        var raw = JSON.parse(localStorage.getItem(AM4_AIRCRAFT_PROFILES_KEY) || '{}');
        if (raw && typeof raw === 'object') {
            Object.keys(raw).forEach(function (k) {
                var p = am4AircraftMerge(null, raw[k]);
                if (p && p.typeId) am4AircraftProfiles[String(p.typeId)] = p;
            });
        }
    } catch (e) { am4AircraftProfiles = {}; }
})();

function am4AircraftSaveProfiles() {
    try { localStorage.setItem(AM4_AIRCRAFT_PROFILES_KEY, JSON.stringify(am4AircraftProfiles)); } catch (e) { /* ignore */ }
}

function am4AircraftStoreProfile(p) {
    if (!p || !p.typeId) return;
    am4AircraftProfiles[String(p.typeId)] = am4AircraftMerge(null, p);
    am4AircraftSaveProfiles();
}

function am4AircraftLoadProfile(typeId) {
    typeId = parseInt(typeId, 10);
    var p = am4AircraftProfiles[String(typeId)];
    return (p && p.typeId === typeId) ? am4AircraftMerge(null, p) : null;
}

var am4AircraftCurrent = am4AircraftLoad();
function am4AircraftProfile() { return am4AircraftCurrent; }
function am4AircraftName() { return am4AircraftCurrent.name || ('Type ' + am4AircraftCurrent.typeId); }
function am4AircraftTypeId() { return am4AircraftCurrent.typeId; }
function am4AircraftEngineId() { return am4AircraftCurrent.engineId; }
function am4AircraftSeats() {
    am4AircraftSanitizeSeats(am4AircraftCurrent);
    return am4AircraftCurrent.seats;
}
function am4AircraftRangeKm() { return am4AircraftCurrent.rangeKm; }
function am4AircraftIconId() { return am4AircraftCurrent.iconId || 0; }
function am4AircraftIsCargo() {
    var p = am4AircraftCurrent || {};
    if (!p.cargo) return false;
    if (p.cargoKg > 0 || am4AircraftLooksFreighter(p.name)) return true;
    if ((p.seats || 0) > 40) return false;
    return !!p.cargo;
}
function am4AircraftCargoKg() { return Math.max(0, parseInt(am4AircraftCurrent.cargoKg, 10) || 0); }
function am4AircraftCargoSplit() {
    var p = am4AircraftCurrent || {};
    var l = (p.cargoAftH || 0) + (p.cargoFwdH || 0);
    var h = (p.cargoAft || 0) + (p.cargoFwd || 0);
    if (l + h < 1) { l = 50; h = 50; }
    return { l: l, h: h, tot: l + h };
}
function am4AircraftUnitCost() {
    if (am4FleetOrderInfo && am4FleetOrderInfo.typeId === am4AircraftCurrent.typeId && am4FleetOrderInfo.unitCost) {
        return am4FleetOrderInfo.unitCost;
    }
    return am4AircraftCurrent.unitCost || 0;
}

function am4AircraftSet(partial) {
    am4AircraftCurrent = am4AircraftSave(am4AircraftMerge(am4AircraftCurrent, partial));
    return am4AircraftCurrent;
}

var am4AircraftCatalog = [];
(function loadAircraftCatalog() {
    try {
        var raw = JSON.parse(localStorage.getItem(AM4_AIRCRAFT_CATALOG_KEY) || '[]');
        if (Array.isArray(raw)) {
            am4AircraftCatalog = raw.filter(function (t) {
                return t && parseInt(t.id, 10);
            }).map(function (t) {
                var nm = String(t.name || '');
                // Drop generic names cached by an earlier build ("Aircraft details") so the next
                // refresh re-learns the real model from the fleet pages.
                if (am4AircraftIsGenericName(nm)) { nm = 'Type ' + parseInt(t.id, 10); }
                return { id: parseInt(t.id, 10), name: nm, owned: !!t.owned };
            });
        }
    } catch (e) { am4AircraftCatalog = []; }
})();

function am4AircraftSaveCatalog() {
    try { localStorage.setItem(AM4_AIRCRAFT_CATALOG_KEY, JSON.stringify(am4AircraftCatalog)); } catch (e) { /* ignore */ }
}

function am4AircraftRememberType(id, name, owned) {
    id = parseInt(id, 10);
    if (!id) return;
    var found = null;
    for (var i = 0; i < am4AircraftCatalog.length; i++) {
        if (am4AircraftCatalog[i].id === id) { found = am4AircraftCatalog[i]; break; }
    }
    if (!found) {
        found = { id: id, name: name || ('Type ' + id), owned: !!owned };
        am4AircraftCatalog.push(found);
    } else {
        // A real model name always wins; a placeholder never overwrites one already learned.
        if (name && (am4AircraftLooksLikeModelName(name, true) || !am4AircraftLooksLikeModelName(found.name, true))) found.name = name;
        if (owned) found.owned = true;
    }
}

// The order page's heading is the generic "Aircraft details", and the fleet/order list
// markup is full of chrome words. Anything matching this is NOT a model name, so it must
// never be saved as one - that is what turned both panels into"Aircraft details" .
function am4AircraftIsGenericName(name) {
    var n = String(name == null ?'' : name).replace(/\s+/g,' ').trim();
    if (!n || n.length > 48) return true;
    return /^(aircraft|details|order|orders|fleet|type|charter|pax|cargo|number|ajax|onclick|href|mode|loading|options|hangar|new|buy|sell|price|cost|range|speed|capacity|runway|fuel|co2|staff|maintenance|check|seats|profit|status|registration|hub|route|routes|total|available|purchase)\b/i.test(n);
}

// Trusted sources (a fleet row's .s-text) print the model verbatim, so any non-generic string
// is taken as-is - that keeps digit-free names such as"Concorde" . Untrusted heuristic scans
// over page markup must additionally see a digit, which is what rules out stray chrome words.
function am4AircraftLooksLikeModelName(name, trusted) {
    var n = String(name == null ?'' : name).replace(/\s+/g,' ').trim();
    if (!n || am4AircraftIsGenericName(n)) return false;
    if (!/^[A-Za-z0-9][A-Za-z0-9 .\/()\-]{1,40}$/.test(n)) return false;
    return trusted ? true : /\d/.test(n);
}

function am4AircraftParseTypeLinks(html, owned) {
    var text = String(html || '');
    var re = /(?:ac_orders\.php[^"'<>]*[?&](?:amp;)?(?:mode=detail&(?:amp;)?)?id=|fleet\.php[^"'<>]*[?&](?:amp;)?type=)(\d{1,12})/gi;
    var m;
    while ((m = re.exec(text)) !== null) {
        var id = m[1];
        var around = text.slice(Math.max(0, m.index - 220), Math.min(text.length, m.index + 260))
            .replace(/<[^>]+>/g,' ').replace(/&[a-z]+;/gi,' ').replace(/\s+/g,' ');
        // Take the first candidate that actually looks like a model name rather than the
        // first word-ish run, which was picking up"Ajax" ,"detail" and"Aircraft details" .
        var name = '';
        var cand = around.match(/[A-Za-z][A-Za-z0-9 .\/()\-]{1,40}/g) || [];
        for (var ci = 0; ci < cand.length; ci++) {
            var c = cand[ci].replace(/Number of aircraft.*$/i,'').trim();
            if (am4AircraftLooksLikeModelName(c)) { name = c; break; }
        }
        am4AircraftRememberType(id, name || ('Type ' + id), owned);
    }
}

// fleet.php prints one summary block per owned type ("A380-800 Number of aircraft: 12") in
// the same order as its fleet.php?type=<id> links, so the Nth label belongs to the Nth id.
// A cheap second name source that needs no extra request.
function am4AircraftLearnNamesFromFleetSummary(html) {
    if (typeof am4FleetParseSummary !== 'function') return;
    var text = String(html || '');
    var ids = [], seen = {};
    var re = /fleet\.php\?type=(\d+)/gi, m;
    while ((m = re.exec(text)) !== null) {
        if (!seen[m[1]]) { seen[m[1]] = 1; ids.push(m[1]); }
    }
    var labels = am4FleetParseSummary(html) || [];
    if (!ids.length || labels.length !== ids.length) return; // order not trustworthy
    for (var i = 0; i < ids.length; i++) {
        var nm = String(labels[i].label || '').replace(/^[^A-Za-z0-9]+/,'').trim();
        if (am4AircraftLooksLikeModelName(nm)) am4AircraftRememberType(ids[i], nm, true);
    }
}

// Authoritative model names: every fleet type page prints the model in a .s-text span on
// each aircraft row ("MC-21-400"), which am4FleetParseA380Rows already captures. This maps
// typeId -> real model name for every type the airline owns.
function am4AircraftLearnNamesFromFleet() {
    if (typeof am4FleetListAllRows !== 'function') return Promise.resolve(am4AircraftCatalog);
    return am4FleetListAllRows().then(function (rows) {
        var byType = {};
        rows.forEach(function (p) {
            if (!p.typeId || !p.model) return;
            if (!byType[p.typeId] && am4AircraftLooksLikeModelName(p.model, true)) byType[p.typeId] = p.model;
        });
        Object.keys(byType).forEach(function (tid) {
            am4AircraftRememberType(tid, byType[tid], true);
        });
        // Repair the selected profile if an earlier build stored a generic heading as its name.
        var cur = am4AircraftProfile();
        if (cur && byType[cur.typeId] && byType[cur.typeId] !== cur.name) {
            am4AircraftSet({ name: byType[cur.typeId] });
        }
        am4AircraftSaveCatalog();
        return am4AircraftCatalog;
    }).catch(function () { return am4AircraftCatalog; });
}

function am4AircraftRefreshCatalog() {
    return Promise.all([
        fetch('fleet.php', { credentials: 'include'}).then(function (r) { return r.text(); }).catch(function () { return ''; }),
        fetch('ac_orders.php', { credentials: 'include'}).then(function (r) { return r.text(); }).catch(function () { return ''; }),
        fetch('ac_orders.php?first=true', { credentials: 'include'}).then(function (r) { return r.text(); }).catch(function () { return ''; }),
        fetch('ac_orders.php?cargo=1', { credentials: 'include'}).then(function (r) { return r.text(); }).catch(function () { return ''; })
    ]).then(function (res) {
        am4AircraftParseTypeLinks(res[0], true);
        am4AircraftParseTypeLinks(res[1], false);
        am4AircraftParseTypeLinks(res[2], false);
        am4AircraftParseTypeLinks(res[3], false);
        am4AircraftLearnNamesFromFleetSummary(res[0]);
        if (am4AircraftCurrent && am4AircraftCurrent.typeId && am4AircraftLooksLikeModelName(am4AircraftCurrent.name, true)) {
            am4AircraftRememberType(am4AircraftCurrent.typeId, am4AircraftCurrent.name, true);
        }
        // Then overwrite every owned type's name with the exact model from its fleet page.
        return am4AircraftLearnNamesFromFleet();
    }).then(function () {
        am4AircraftCatalog.sort(function (a, b) {
            if (a.owned !== b.owned) return a.owned ? -1 : 1;
            return String(a.name).localeCompare(String(b.name), undefined, { numeric: true });
        });
        am4AircraftSaveCatalog();
        am4AircraftPrefetchOwnedProfiles();
        return am4AircraftCatalog;
    });
}

// Background-read order pages for every owned type so Explorer/Strategy always have
// seats / range / cruise — not only for the type you clicked last.
var am4AircraftPrefetchBusy = false;
function am4AircraftProfileNeedsOrderPage(p) {
    return am4AircraftProfileIncomplete(p);
}
function am4AircraftPrefetchOwnedProfiles() {
    if (am4AircraftPrefetchBusy) return;
    var owned = (am4AircraftCatalog || []).filter(function (t) { return t && t.owned && t.id; });
    if (!owned.length) return;
    am4AircraftPrefetchBusy = true;
    var i = 0;
    var fetched = 0;
    var step = function () {
        if (i >= owned.length) {
            am4AircraftPrefetchBusy = false;
            if (fetched) console.log('[AM4 Bot Log] Prefetched order-page stats for ' + fetched + ' owned type(s).');
            if (typeof am4StrategyRender === 'function') am4StrategyRender();
            if (typeof am4ExpRefreshScoringDisplay === 'function') am4ExpRefreshScoringDisplay();
            return;
        }
        var t = owned[i++];
        var stored = am4AircraftLoadProfile(t.id);
        if (stored && !am4AircraftProfileNeedsOrderPage(stored)) {
            setTimeout(step, 40);
            return;
        }
        fetch('ac_orders.php?mode=detail&id=' + t.id + '&charter=0', { credentials: 'include'})
            .then(function (r) { return r.text(); })
            .then(function (html) {
                if (html) {
                    am4AircraftApplyOrderPage(html, t.id, true);
                    fetched++;
                }
            })
            .catch(function () { /* ignore */ })
            .then(function () { setTimeout(step, 280); });
    };
    setTimeout(step, 200);
}

function am4AircraftFillSelect(sel, selectedId) {
    if (!sel) return;
    var want = String(selectedId || am4AircraftTypeId());
    var list = am4AircraftCatalog.slice();
    if (!list.filter(function (t) { return String(t.id) === want; }).length) {
        list.unshift({ id: parseInt(want, 10), name: am4AircraftName(), owned: true });
    }
    sel.innerHTML = list.map(function (t) {
        return"<option value='" + t.id +"'" + (String(t.id) === want ? " selected" : "") +">" +
            am4FleetEsc(t.name) + (t.owned ? "" :" (shop)") +"</option>" ;
    }).join('');
}

function am4AircraftParseEngines(html) {
    var byId = {};
    var box = document.createElement('div');
    box.innerHTML = html || '';
    var sel = box.querySelector('#engSelection');
    if (sel) {
        Array.prototype.forEach.call(sel.querySelectorAll('option'), function (o) {
            var id = parseInt(o.value, 10);
            if (!id) return;
            var name = String(o.textContent || '').replace(/\s+/g,' ').trim();
            byId[id] = { id: id, name: name || ('engine ' + id) };
        });
    }
    var re = /engineData\s*\[\s*['"]?(\d+)['"]?\s*\]\s*=\s*\{([^}]*)\}/g;
    var m;
    while ((m = re.exec(html || '')) !== null) {
        var id = parseInt(m[1], 10);
        if (!id) continue;
        var nameM = m[2].match(/name\s*:\s*['"]([^'"]+)['"]/i) || m[2].match(/title\s*:\s*['"]([^'"]+)['"]/i);
        var dataName = nameM ? nameM[1] : '';
        if (!byId[id]) {
            byId[id] = { id: id, name: dataName || ('engine ' + id) };
        } else if (am4AircraftEngineNameIsGeneric(byId[id].name) && dataName && !am4AircraftEngineNameIsGeneric(dataName)) {
            byId[id].name = dataName;
        }
    }
    var engines = Object.keys(byId).map(function (k) { return byId[k]; });
    engines.sort(function (a, b) { return a.id - b.id; });
    return engines;
}

function am4AircraftParseSpecs(html, box) {
    var inner = ((box && (box.innerText || box.textContent)) || '').replace(/\s+/g,' ');
    var stripped = String(html || '').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<[^>]+>/g,' ')
        .replace(/&nbsp;/gi,' ').replace(/&[a-z]+;/gi,' ').replace(/\s+/g,' ');
    var raw = String(html || '');
    var sources = [inner, stripped, raw];
    var pairRes = [
        /([\d,.\s]{3,})\s*km\s*\/\s*([\d,.\s]{2,})\s*kph/i,
        /([\d,]+)\s*km\/\s*([\d,]+)\s*kph/i,
        /([\d,]+)km\/([\d,]+)kph/i,
        /([\d,.\s]{3,})\s*km\s*\/\s*([\d,.\s]{2,})\s*km\s*\/\s*h/i
    ];
    var rangeKm = 0, cruiseStock = 0, si, pi, m;
    for (si = 0; si < sources.length && !cruiseStock; si++) {
        for (pi = 0; pi < pairRes.length; pi++) {
            m = sources[si].match(pairRes[pi]);
            if (!m) continue;
            rangeKm = parseInt(String(m[1]).replace(/[^0-9]/g,''), 10) || 0;
            cruiseStock = parseInt(String(m[2]).replace(/[^0-9]/g,''), 10) || 0;
            if (cruiseStock >= 200 && cruiseStock <= 3000) break;
            cruiseStock = 0;
        }
    }
    if (!cruiseStock) {
        m = (inner + ' ' + stripped).match(/(?:speed|cruise)[^0-9]{0,32}([\d,.]+)\s*(?:kph|km\/h)/i) ||
            raw.match(/(?:acSpeed|defSpeed|cruiseSpeed|speed)\s*=\s*(\d{3,4})/i);
        if (m) cruiseStock = parseInt(String(m[1]).replace(/[^0-9]/g,''), 10) || 0;
        if (cruiseStock < 200 || cruiseStock > 3000) cruiseStock = 0;
    }
    if (!rangeKm) {
        m = (inner + ' ' + stripped).match(/range[^0-9]{0,32}([\d,.]+)\s*km/i) ||
            raw.match(/(?:acRange|defRange|range)\s*=\s*(\d{3,5})/i);
        if (m) rangeKm = parseInt(String(m[1]).replace(/[^0-9]/g,''), 10) || 0;
        if (rangeKm < 100 || rangeKm > 30000) rangeKm = 0;
    }
    var minRwy = 0;
    m = (inner + ' ' + stripped).match(/runway[^0-9]{0,32}([\d,.]+)\s*(ft|m)\b/i) ||
        raw.match(/(?:minRwy|runway|rwyLength)\s*=\s*(\d{3,5})/i);
    if (m) {
        var rv = parseInt(String(m[1]).replace(/[^0-9]/g,''), 10) || 0;
        var unit = String(m[2] || '').toLowerCase();
        if (unit === 'm' || (unit !== 'ft' && rv >= 800 && rv <= 4000)) minRwy = Math.round(rv * 3.28084);
        else minRwy = rv;
        if (minRwy < 500 || minRwy > 20000) minRwy = 0;
    }
    return { rangeKm: rangeKm, cruiseStock: cruiseStock, minRwy: minRwy };
}

function am4AircraftInputVal(box, sel) {
    var el = box && box.querySelector(sel);
    if (!el) return null;
    var n = parseInt(String(el.value || el.getAttribute('value') || '').replace(/[^0-9-]/g,''), 10);
    return isFinite(n) ? n : null;
}

function am4AircraftParseUnitCost(html, box) {
    var raw = String(html || '');
    var js = raw.match(/defCost\s*=\s*(\d+)/) ||
        raw.match(/acCost\s*=\s*(\d+)/) ||
        raw.match(/planeCost\s*=\s*(\d+)/) ||
        raw.match(/purchaseCost\s*=\s*(\d+)/) ||
        raw.match(/var\s+cost\s*=\s*(\d{4,})/);
    if (js) {
        var jn = parseInt(js[1], 10);
        if (jn > 0) return jn;
    }
    var text = ((box && (box.innerText || box.textContent)) || raw.replace(/<[^>]+>/g,' ')).replace(/\s+/g,' ');
    var m = text.match(/Cost[^$]{0,40}\$\s*([\d,]+)/i) || text.match(/\$\s*([\d,]{5,})/);
    if (m) {
        var n = parseInt(String(m[1]).replace(/[^0-9]/g,''), 10);
        if (n > 0) return n;
    }
    return 0;
}

function am4AircraftParseOrderBindings(html) {
    var s = String(html || '').replace(/&amp;/g,'&');
    var pageCargo = /btnPurchaseCargoDo|#cargoAft\b|btnPurchaseCargo/i.test(s);
    var pagePax = /btnPurchasePaxDo|#eSeat\b|btnPurchasePax/i.test(s);
    var idx = s.search(/ac_order_do\.php/i);
    var map = {};
    if (idx >= 0) {
        var chunk = s.slice(idx, idx + 2800);
        var re = /[?&]([A-Za-z0-9_]+)=\s*(?:['"][^'"]*['"]\s*\+\s*)?(?:Number\s*\(\s*)?\$\(\s*['"]#([^'"]+)['"]\s*\)/g;
        var m;
        while ((m = re.exec(chunk))) map[m[1]] = String(m[2] || '').replace(/^#/,'');
    }
    return { pageCargo: pageCargo, pagePax: pagePax, map: map, foundDo: idx >= 0 };
}

function am4AircraftParseCargoLayout(html, box) {
    box = box || document.createElement('div');
    if (!box.querySelector) { box = document.createElement('div'); box.innerHTML = html || ''; }
    var has = !!(box.querySelector('#cargoAft, #cargoFwd, #cargoAftH, #cargoFwdH, #btnPurchaseCargoDo'));
    if (!has && !/btnPurchaseCargoDo|#cargoAft\b|#cargoFwd\b/i.test(html || '')) {
        return { cargo: false };
    }
    var aft = am4AircraftInputVal(box,'#cargoAft');
    var fwd = am4AircraftInputVal(box,'#cargoFwd');
    var aftH = am4AircraftInputVal(box,'#cargoAftH');
    var fwdH = am4AircraftInputVal(box,'#cargoFwdH');
    var any = aft != null || fwd != null || aftH != null || fwdH != null;
    // Missing fields are 0, not 50. Defaulting Large to 50+50 while Heavy read as 0/0
    // produced a fake L100/H0 split and Explorer then ignored all Heavy demand.
    if (!any) {
        return { cargo: true, cargoAft: 25, cargoFwd: 25, cargoAftH: 25, cargoFwdH: 25 };
    }
    return {
        cargo: true,
        cargoAft: aft == null ? 0 : aft,
        cargoFwd: fwd == null ? 0 : fwd,
        cargoAftH: aftH == null ? 0 : aftH,
        cargoFwdH: fwdH == null ? 0 : fwdH
    };
}

function am4AircraftResolveCargoMode(html, box, profile) {
    profile = profile || {};
    var s = String(html || '');
    var bind = am4AircraftParseOrderBindings(s);
    var cargoLay = am4AircraftParseCargoLayout(s, box);
    var name = String(profile.name || '');

    if (bind.pageCargo && !bind.pagePax) return true;
    if (bind.pagePax && !bind.pageCargo) return false;
    if (am4AircraftLooksFreighter(name) && (cargoLay.cargo || bind.pageCargo)) return true;
    if (cargoLay.cargo && bind.pageCargo) return true;
    if ((profile.seats || 0) > 40 && !bind.pageCargo) return false;
    return !!(cargoLay.cargo && /#cargoAft\b|btnPurchaseCargoDo/i.test(s));
}

function am4AircraftApplyOrderPage(html, typeId) {
    typeId = parseInt(typeId, 10) || am4AircraftTypeId();
    var stored = am4AircraftLoadProfile(typeId);
    var known = am4AircraftCatalog.filter(function (t) { return t.id === typeId; })[0];
    var p = am4AircraftBlank(typeId, (stored && stored.name) || (known && known.name));
    if (stored && stored.typeId === typeId) p = am4AircraftMerge(p, stored);
    var box = document.createElement('div');
    box.innerHTML = html || '';
    var nameCands = [];
    Array.prototype.forEach.call(box.querySelectorAll('.s-text, .l-text, h1, h2, h3, .font-weight-bold, title'), function (el) {
        nameCands.push((el.innerText || el.textContent || '').replace(/\s+/g,' ').trim());
    });
    var picked = '';
    for (var ni = 0; ni < nameCands.length; ni++) {
        if (am4AircraftLooksLikeModelName(nameCands[ni])) { picked = nameCands[ni]; break; }
    }
    if (known && am4AircraftLooksLikeModelName(known.name, true)) p.name = known.name;
    else if (picked) p.name = picked;
    else if (!am4AircraftLooksLikeModelName(p.name, true)) p.name = 'Type ' + p.typeId;
    var parsedCost = am4AircraftParseUnitCost(html, box);
    if (parsedCost > 0) p.unitCost = parsedCost;
    var maxM = (html || '').match(/maxAcOrder\s*=\s*(\d+)/);
    if (maxM) p.maxAcOrder = parseInt(maxM[1], 10);
    var parsedCap = am4AircraftParseCapacity(html, p.seats, false);
    var domCap = am4AircraftParseCapacityFromDom(box);
    if (domCap > parsedCap) parsedCap = domCap;
    if (/maxSeats\s*=\s*\d+|totalSeats\s*=\s*\d+/i.test(html || '') || domCap >= 41) p.seatsFromMax = true;
    if (parsedCap > 0 && parsedCap <= 1000) p.seats = parsedCap;
    am4AircraftSanitizeSeats(p);
    var specs = am4AircraftParseSpecs(html, box);
    if (specs.rangeKm) p.rangeKm = specs.rangeKm;
    if (specs.cruiseStock) {
        p.cruiseStock = specs.cruiseStock;
        p.cruiseMod = Math.round(p.cruiseStock * 1.1);
    }
    if (specs.minRwy) p.minRwy = specs.minRwy;
    var cargoLay = am4AircraftParseCargoLayout(html, box);
    p.cargo = am4AircraftResolveCargoMode(html, box, p);
    if (p.cargo) {
        if (cargoLay.cargo) {
            p.cargoAft = cargoLay.cargoAft;
            p.cargoFwd = cargoLay.cargoFwd;
            p.cargoAftH = cargoLay.cargoAftH;
            p.cargoFwdH = cargoLay.cargoFwdH;
        }
        if (p.maxAcOrder == null || p.maxAcOrder > 1) p.maxAcOrder = 1;
        var cargoKg = am4AircraftParseCapacity(html, p.cargoKg || 0, true);
        if (cargoKg >= 1000) p.cargoKg = cargoKg;
    } else {
        p.cargoKg = 0;
        p.cargoAft = 0;
        p.cargoFwd = 0;
        p.cargoAftH = 0;
        p.cargoFwdH = 0;
    }
    var buyBtn = box.querySelector('#btnPurchaseCargoDo, #btnPurchasePaxDo, .btnPurchaseCargo, .btnPurchasePax');
    var buyId = buyBtn && (buyBtn.getAttribute('data-id') || buyBtn.getAttribute('data-acid') || buyBtn.getAttribute('acid'));
    if (buyId && /^\d+$/.test(String(buyId))) p.orderAcid = parseInt(buyId, 10);
    var regEl = box.querySelector('#reg, input[name="r"]');
    if (regEl && regEl.getAttribute('maxlength')) {
        var rmax = parseInt(regEl.getAttribute('maxlength'), 10);
        if (rmax > 0) p.regMaxLen = rmax;
    }
    p.orderBind = am4AircraftParseOrderBindings(html);
    if (!p.orderY && !p.orderJ && !p.orderF && p.seats) p.orderY = p.seats;
    var engines = am4AircraftParseEngines(html);
    if (engines.length) {
        p.engines = engines;
        var keep = engines.filter(function (e) { return e.id === p.engineId; })[0];
        if (!keep) {
            p.engineId = engines[0].id;
            p.engineName = engines[0].name;
        } else {
            p.engineName = keep.name;
        }
    }
    if (am4AircraftLooksLikeModelName(p.name, true)) am4AircraftRememberType(p.typeId, p.name, true);
    am4AircraftSaveCatalog();
    // quiet = background prefetch for another type: store profile only, do not switch selection.
    if (arguments.length >= 3 && arguments[2] && am4AircraftTypeId() !== typeId) {
        am4AircraftStoreProfile(p);
        return p;
    }
    var out = am4AircraftSet(p);
    if (typeof am4StratEnsurePossibleN === 'function') am4StratEnsurePossibleN();
    return out;
}

function am4AircraftSelectType(typeId, onDone) {
    typeId = parseInt(typeId, 10);
    if (!typeId) { if (typeof onDone === 'function') onDone(am4AircraftProfile()); return Promise.resolve(am4AircraftProfile()); }
    var known = am4AircraftCatalog.filter(function (t) { return t.id === typeId; })[0];
    var stored = am4AircraftLoadProfile(typeId);
    var next = (stored && stored.typeId === typeId)
        ? stored
        : ((typeId === 2) ? am4AircraftDefault() : am4AircraftBlank(typeId, known && known.name));
    if (known && am4AircraftLooksLikeModelName(known.name, true)) next.name = known.name;
    if (known && known.name && !am4AircraftLooksFreighter(known.name) && ((next.seats || 0) > 0 || (next.cargoKg || 0) <= 0)) {
        next.cargo = false;
        next.cargoKg = 0;
        next.cargoAft = 0;
        next.cargoFwd = 0;
        next.cargoAftH = 0;
        next.cargoFwdH = 0;
    }
    am4AircraftCurrent = am4AircraftSave(next);
    if (typeof am4StratEnsurePossibleN === 'function') am4StratEnsurePossibleN();
    if (typeof am4FleetOrderInfo !== 'undefined' && am4FleetOrderInfo && am4FleetOrderInfo.typeId !== typeId) {
        am4FleetOrderInfo = { hubs: [], maxAcOrder: null, unitCost: null, typeId: typeId };
    }
    if (typeof am4FleetFillEngineSelect === 'function') am4FleetFillEngineSelect();
    if (typeof am4StrategyRender === 'function') am4StrategyRender();
    return fetch('ac_orders.php?mode=detail&id=' + typeId + '&charter=0', { credentials: 'include'})
        .then(function (r) { return r.text(); })
        .then(function (html) {
            if (am4AircraftTypeId() !== typeId) {
                if (typeof onDone === 'function') onDone(am4AircraftProfile());
                return am4AircraftProfile();
            }
            var p = am4AircraftApplyOrderPage(html, typeId);
            if (!(am4AircraftSeats() > 0) && !am4AircraftIsCargo()) {
                return am4AircraftFetchCapacityFallback(typeId).then(function (cap) {
                    if (cap > 0 && am4AircraftTypeId() === typeId) {
                        var prof = am4AircraftProfile();
                        prof.seats = cap;
                        prof.seatsFromMax = true;
                        am4AircraftSanitizeSeats(prof);
                        am4AircraftSet(prof);
                        p = prof;
                    }
                    if (typeof am4StrategyRender === 'function') am4StrategyRender();
                    if (typeof am4FleetFillEngineSelect === 'function') am4FleetFillEngineSelect();
                    if (typeof onDone === 'function') onDone(p);
                    return p;
                });
            }
            if (typeof am4StrategyRender === 'function') am4StrategyRender();
            if (typeof am4FleetFillEngineSelect === 'function') am4FleetFillEngineSelect();
            if (typeof onDone === 'function') onDone(p);
            return p;
        })
        .catch(function () {
            if (typeof onDone === 'function') onDone(am4AircraftProfile());
            return am4AircraftProfile();
        });
}

function am4StratClampN(n) {
    n = parseInt(n, 10);
    if (!isFinite(n) || n < AM4_STRAT_N_MIN) return AM4_STRAT_N_MIN;
    if (n > AM4_STRAT_N_MAX) return AM4_STRAT_N_MAX;
    return n;
}

// Fewest flights this type can actually fly: the N you get at max range.
// Shorter hops = higher N. N below this needs a longer route than the plane can fly.
function am4StratLongestN(cfg) {
    var rs = am4StratRealSpeed(cfg || am4StratLoadCfg());
    var range = am4StratRangeKm();
    if (!(rs > 0) || !(range > 0)) return 2;
    var n = Math.floor(24 * rs / range);
    if (n < AM4_STRAT_N_MIN) n = AM4_STRAT_N_MIN;
    if (n > AM4_STRAT_N_MAX) n = AM4_STRAT_N_MAX;
    return n;
}

function am4StratNs() {
    var cfg = am4StratLoadCfg();
    var longest = am4StratLongestN(cfg);
    var set = {};
    set[longest] = true;
    set[Math.min(AM4_STRAT_N_MAX, longest + 1)] = true;
    set[Math.min(AM4_STRAT_N_MAX, longest + 2)] = true;
    AM4_STRAT_PRESETS.forEach(function (p) {
        if (am4StratBand(p, cfg).possible) set[p] = true;
    });
    set[am4StratClampN(cfg.n)] = true;
    return Object.keys(set).map(function (k) { return parseInt(k, 10); }).filter(function (n) {
        return n >= AM4_STRAT_N_MIN && n <= AM4_STRAT_N_MAX;
    }).sort(function (a, b) { return a - b; });
}

function am4StratOptionNs() {
    var cfg = am4StratLoadCfg();
    var start = am4StratLongestN(cfg);
    var out = [];
    for (var i = start; i <= AM4_STRAT_N_MAX; i++) out.push(i);
    if (out.indexOf(cfg.n) === -1) out.push(cfg.n);
    return out.sort(function (a, b) { return a - b; });
}

//================================================================================
// STRATEGY (flights per 24h) — the user's core lever; drives Explorer + Buy.
//
// Choose how many one-way FLIGHTS (legs) the selected aircraft does per 24 h.
// More flights = more throughput per (expensive) plane, IF the distance lets that
// many fit in 24 h AND the demand fills each. Flight time is VERIFIED from AM4's
// own costIndex() JS (GAME_CONTRACTS): one-way time = dist / (cruiseKph × 1.5) at
// cost index 200. So N legs fit iff dist ≤ 24·realSpeed/N; a plane does EXACTLY N
// legs when its distance sits in the band ( 24·realSpeed/(N+1) , 24·realSpeed/N ].
// The smallest N that still fits inside the type's range is max-range (A380 often 2×; MC-21 often 6×).
//================================================================================
var AM4_STRAT_KEY = 'am4StrategyCfg';
var AM4_STRAT_REALSPEED_MULT = 1.5; // AM4's own multiplier (verified from the game's costIndex JS)

function am4StratCruiseStock() { return am4AircraftProfile().cruiseStock; }
function am4StratCruiseMod() { return am4AircraftProfile().cruiseMod; }
function am4StratRangeKm() { return am4AircraftProfile().rangeKm; }

function am4StratLoadCfg() {
    var cfg = { n: 2, modded: true };
    try {
        var s = JSON.parse(localStorage.getItem(AM4_STRAT_KEY) || '{}');
        if (s && typeof s === 'object') {
            cfg.n = am4StratClampN(s.n);
            if (typeof s.modded === 'boolean') cfg.modded = s.modded;
        }
    } catch (e) { /* defaults */ }
    return cfg;
}
function am4StratSaveCfg(cfg) { try { localStorage.setItem(AM4_STRAT_KEY, JSON.stringify(cfg)); } catch (e) { /* ignore */ } }
function am4StratCruiseKph(cfg) { return (cfg && cfg.modded === false) ? am4StratCruiseStock() : am4StratCruiseMod(); }
function am4StratRealSpeed(cfg) { return am4StratCruiseKph(cfg) * AM4_STRAT_REALSPEED_MULT; }
function am4StratKphLabel(kph, suffix) {
    return (kph > 0) ? (Number(kph).toLocaleString() + ' kph' + (suffix || '')) : 'unknown';
}

// Distance band [lo, hi] km in which a plane does EXACTLY n one-way flights/24h.
// If that N needs a longer hop than this type's range, possible=false — do NOT collapse
// to a 1 km sliver (that made Explorer/Rebuild report 0 routes on MC-21 Strategy 4).
function am4StratBand(n, cfg) {
    n = am4StratClampN(n);
    var rs = am4StratRealSpeed(cfg);
    var range = am4StratRangeKm();
    var hiNat = (rs > 0 && n > 0) ? Math.floor(24 * rs / n) : 0;
    var loNat = (rs > 0) ? Math.ceil(24 * rs / (n + 1)) : 0;
    var hi = Math.min(range || 0, hiNat);
    var possible = !!(rs > 0 && range > 0 && hi > loNat && hi > 0);
    if (!possible) {
        return { lo: loNat, hi: hiNat, realSpeed: rs, n: n, possible: false, clipped: hiNat > range };
    }
    return { lo: loNat, hi: hi, realSpeed: rs, n: n, possible: true, clipped: hiNat > range };
}

// If the saved N is impossible for this type (A380 2× leftover on an MC-21), move to
// the max-range N so Explorer/Rebuild score a real window instead of 5,499–5,500 km.
function am4StratEnsurePossibleN() {
    var cfg = am4StratLoadCfg();
    if (!(am4StratCruiseKph(cfg) > 0) && !(am4StratCruiseStock() > 0)) return cfg;
    if (!(am4StratRangeKm() > 0)) return cfg;
    var band = am4StratBand(cfg.n, cfg);
    if (band.possible) return cfg;
    var n2 = am4StratLongestN(cfg);
    if (n2 === cfg.n) return cfg;
    var old = cfg.n;
    cfg.n = n2;
    am4StratSaveCfg(cfg);
    try {
        am4LogAction('strategy','🎯 ' + am4AircraftName() + ' cannot fly ' + old +
            '×/24h (that band starts at ' + Number(band.lo).toLocaleString() + ' km, range is ' +
            Number(am4StratRangeKm()).toLocaleString() + ' km). Using ' + n2 + '×/24h (max-range).');
    } catch (eLog) { /* ignore */ }
    return cfg;
}

function am4StrategyInjectButton() {
    // Strategy controls live inside 🔎 Explorer — no separate navbar button.
}
function am4StrategyTogglePanel() {
    if (typeof am4ExpTogglePanel === 'function') am4ExpTogglePanel();
}
function am4StrategyBuildPanel() {
    if (typeof am4ExpBuildPanel === 'function') return am4ExpBuildPanel();
    return null;
}
function am4AircraftProfileIncomplete(p) {
    p = p || am4AircraftProfile();
    if (p === am4AircraftCurrent) am4AircraftSanitizeSeats(am4AircraftCurrent);
    if (p.cargo) {
        return !(p.cargoKg > 0) || !(p.rangeKm > 0) || !(p.cruiseStock > 0);
    }
    var seats = (p === am4AircraftCurrent) ? am4AircraftSeats() : Math.max(0, parseInt(p.seats, 10) || 0);
    if (!(seats > 0)) return true;
    if (seats <= 40 && (p.rangeKm || 0) >= 3500) return true;
    if (seats >= 400 && p.typeId !== 2 && !p.cargo &&
        !/\b(747|777|787-10|A350-1000|A380)\b/i.test(String(p.name || ''))) return true;
    return !(p.rangeKm > 0) || !(p.cruiseStock > 0);
}

function am4AircraftCapacityLabel() {
    if (am4AircraftIsCargo()) {
        var kg = am4AircraftCargoKg() || 0;
        return kg > 0
            ? (kg.toLocaleString() + ' kg capacity · Large uses 0.7 / Heavy 1.0 · demand L=Y×500 H=J×1000')
            : '<span style="color:#ef4444;">unread — pick the type again below</span>';
    }
    var s = am4AircraftSeats();
    return s > 0
        ? (s + ' seat slots (Y/J/F physical cap from the order page)')
        : '<span style="color:#ef4444;">unread — pick the type again below (order stats loading…)</span>';
}

function am4AircraftFetchCapacityFallback(typeId) {
    typeId = parseInt(typeId, 10) || am4AircraftTypeId();
    var prof = am4AircraftLoadProfile(typeId) || {};
    var eng = prof.engineId || am4AircraftEngineId() || 0;
    var url = 'ac_orders.php?mode=detail&id=' + typeId + '&charter=0' + (eng ? ('&engine=' + eng) : '');
    return fetch(url, { credentials: 'include' }).then(function (r) { return r.text(); }).then(function (html) {
        var cap = am4AircraftParseCapacity(html, 0, false);
        return cap > 0 ? cap : 0;
    }).catch(function () { return 0; });
}

function am4StrategyRender() {
    var tid = am4AircraftTypeId();
    if (am4AircraftProfileIncomplete() && typeof am4AircraftSelectType === 'function') {
        if (am4StrategyRender._fetching !== tid) {
            am4StrategyRender._fetching = tid;
            am4AircraftSelectType(tid, function () {
                am4StrategyRender._fetching = null;
                am4StrategyRender();
            });
        }
    }
    am4StratEnsurePossibleN();
    var cfg = am4StratLoadCfg();
    var nBox = document.getElementById('am4StratN');
    if (nBox) {
        nBox.innerHTML = am4StratNs().map(function (n) {
            var on = (cfg.n === n);
            return"<button data-strat-n='" + n +"' style='flex:1; min-width:72px; cursor:pointer; border:none; border-radius:6px; padding:10px 0; font-family:monospace; font-size:14px; font-weight:bold; " +
                (on ? "background:#10b981; color:#04211a;" :"background:#334155; color:#cbd5e1;") +"'>" + n +"&times; / 24h</button>" ;
        }).join('');
        nBox.querySelectorAll('[data-strat-n]').forEach(function (b) {
            b.addEventListener('click', function () {
                var c = am4StratLoadCfg(); c.n = am4StratClampN(this.getAttribute('data-strat-n')); am4StratSaveCfg(c); am4StrategyRender();
            });
        });
    }
    var custom = document.getElementById('am4StratNCustom');
    if (custom && String(custom.value) !== String(cfg.n)) custom.value = cfg.n;
    var speedSel = document.getElementById('am4StratSpeed');
    if (speedSel) {
        speedSel.innerHTML ="<option value='mod'" + (cfg.modded ? " selected" : "") +">modified " + am4StratKphLabel(am4StratCruiseMod(),' (+10%)') +"</option>" +
            "<option value='stock'" + (!cfg.modded ? " selected" : "") +">stock " + am4StratKphLabel(am4StratCruiseStock()) +"</option>" ;
    }
    am4AircraftFillSelect(document.getElementById('am4StratType'), am4AircraftTypeId());
    var nameEl = document.getElementById('am4StratTypeName');
    if (nameEl) nameEl.innerText = am4AircraftName();
    if (typeof am4ExpRefreshScoringDisplay === 'function') am4ExpRefreshScoringDisplay();
    var bBox = document.getElementById('am4StratBands');
    if (!bBox) return;
    var longest = am4StratLongestN(cfg);
    var rows = am4StratNs().map(function (n) {
        var band = am4StratBand(n, cfg);
        var sel = (cfg.n === n);
        var km = band.possible
            ? (Number(band.lo).toLocaleString() +"&ndash;" + Number(band.hi).toLocaleString() +" km")
            : ("cannot fly — needs " + Number(band.lo).toLocaleString() +"+ km, range is " + Number(am4StratRangeKm()).toLocaleString() +" km");
        return"<div style='display:flex; align-items:baseline; gap:8px; padding:6px 8px; border-radius:6px; margin:3px 0; " +
            (sel ? "background:#0e1b14; border:1px solid #10b981;" :"background:#101722; border:1px solid #1e293b;") +"'>" +
            "<span style='width:56px; font-weight:bold; color:" + (sel ?'#10b981' : '#94a3b8') +";'>" + n +"&times;/24h</span>" +
            "<span style='flex-grow:1; color:" + (band.possible ?'#e2e8f0' : '#f87171') +";'>" + km +"</span>" +
            "<span style='color:#64748b; font-size:10px;'>demand&divide;" + n +"</span></div>" ;
    }).join('');
    var cur = am4StratBand(cfg.n, cfg);
    var maxNote = (longest > 2)
        ? "<div style='margin-top:8px; padding:8px; background:#1c1408; border:1px solid #b45309; border-radius:6px; color:#fde68a; line-height:1.5; font-size:11px;'>Max-range for <b>" + am4FleetEsc(am4AircraftName()) +"</b> is <b>" + longest +"×/24h</b> (" +
            Number(am4StratBand(longest, cfg).lo).toLocaleString() +"&ndash;" + Number(am4StratBand(longest, cfg).hi).toLocaleString() +
            " km). Fewer flights need a longer hop than this plane's " + Number(am4StratRangeKm()).toLocaleString() +" km range.</div>" 
        : '';
    bBox.innerHTML ="<div style='color:#f59e0b; font-size:11px; font-weight:bold; border-top:1px dashed #334155; padding-top:6px; margin-bottom:4px;'>DISTANCE BANDS · " + am4FleetEsc(am4AircraftName()) +"</div>" + rows + maxNote +
        "<div style='margin-top:8px; padding:8px; background:#0e1b14; border:1px solid #10b981; border-radius:6px; color:#d1fae5; line-height:1.6;'>" +
        "<b>Selected: " + cfg.n +" flights / 24 h</b><br>Build routes with a distance of <b>" + Number(cur.lo).toLocaleString() +" &ndash; " + Number(cur.hi).toLocaleString() +" km</b>." +
        "<br>Capacity for Explorer fill: <b>" + am4AircraftCapacityLabel() + ".</b>" +
        "<br>Demand per flight = demand &divide; " + cfg.n +" &middot; $/day = revenue &times; " + cfg.n +" &middot; cruise " + am4StratKphLabel(am4StratCruiseKph(cfg)) +" &rarr; real " + (cur.realSpeed ? Math.round(cur.realSpeed).toLocaleString() +" kph" :"unknown") +".</div>" ;
}

// Expose for headless testing.
window.AM4Strategy = { loadCfg: am4StratLoadCfg, saveCfg: am4StratSaveCfg, band: am4StratBand, realSpeed: am4StratRealSpeed, longestN: am4StratLongestN, ensurePossibleN: am4StratEnsurePossibleN, buildPanel: am4StrategyBuildPanel };

var AM4_EXP_CFG_KEY = 'am4ExplorerCfg';
var AM4_EXP_CACHE_KEY = 'am4ExplorerCache';
var AM4_EXP_META_KEY = 'am4ExplorerMeta'; // owned hubs + country list, cached
var AM4_EXP_META_V = 2; // v2: country names from option text, not numeric values

var AM4_EXP_DEFAULT_CFG = {
    // Default is economy-first: the user's real A380 configs are all economy-dominant with
    // modest business/first (Y350-600, J0-71, F0-40) - never the all-business"Y0 J300 F0" 
    // the pure-revenue order produces.'revenue' stays available as an option.
    seatStrategy: 'economy-first', //'economy-first' |'revenue' 
    cargoStrategy: 'large-first', //'large-first' |'heavy-first' 
    seats: 600,
    cruiseKph: 1049,
    rangeKm: 14500,
    minKm: 0,
    minRwy: 0,
    distCap: 14500,
    goodFillPct: 99,
    throttleMs: 350 // delay between country requests (ban-safety)
};

var am4ExpRunID = 0; // bumping this cancels an in-flight scan
var am4ExpScanning = false;
var am4ExpResults = {}; // hubId -> result (in memory for the current session)

function am4ExpEsc(s) {
    if (typeof am4EscapeHtml === 'function') return am4EscapeHtml(s);
    return String(s == null ?'' : s).replace(/[&<>"']/g, function (c) {
        return {'&' : '&amp;','<' : '&lt;','>' : '&gt;','"' : '&quot;',"'" : '&#39;'}[c];
    });
}

function am4ExpLoadCfg() {
    var cfg = JSON.parse(JSON.stringify(AM4_EXP_DEFAULT_CFG));
    var stored = {};
    try {
        stored = JSON.parse(localStorage.getItem(AM4_EXP_CFG_KEY) || '{}');
        if (!stored || typeof stored !== 'object') stored = {};
        if (stored.seatStrategy === 'economy-first' || stored.seatStrategy === 'revenue') cfg.seatStrategy = stored.seatStrategy;
        if (stored.cargoStrategy === 'large-first' || stored.cargoStrategy === 'heavy-first') cfg.cargoStrategy = stored.cargoStrategy;
        ['distCap','goodFillPct','throttleMs','cruiseKph','seats','rangeKm' ].forEach(function (k) {
            var n = Number(stored[k]);
            if (isFinite(n) && n > 0) cfg[k] = n;
        });
        var mk = Number(stored.minKm);
        if (isFinite(mk) && mk >= 0) cfg.minKm = mk;
        var storedRwy = Number(stored.minRwy);
        if (isFinite(storedRwy) && storedRwy >= 0) cfg.minRwy = storedRwy;
    } catch (e) { stored = {}; }
    var tid = (typeof am4AircraftTypeId === 'function') ? am4AircraftTypeId() : 0;
    var by = (stored.byType && stored.byType[String(tid)]) || null;
    if (by && typeof by === 'object') {
        var br = Number(by.minRwy);
        if (isFinite(br) && br >= 0) cfg.minRwy = br;
        var bf = Number(by.goodFillPct);
        if (isFinite(bf) && bf >= 0) cfg.goodFillPct = bf;
    } else if (Number(stored.typeId) === tid) {
        // same type as the last save — keep the stored runway/fill
    } else {
        // First visit for this type, or leftover A380 6800 ft after switching to MC-21.
        var profRwy = (typeof am4AircraftProfile === 'function') ? (am4AircraftProfile().minRwy || 0) : 0;
        cfg.minRwy = profRwy;
    }
    // clamp to sane bounds
    cfg.rangeKm = Math.min(Math.max(cfg.rangeKm, 500), 20000);
    cfg.minKm = Math.min(Math.max(cfg.minKm, 0), cfg.rangeKm);
    cfg.distCap = Math.min(Math.max(cfg.distCap, 1000), 20000);
    cfg.minRwy = Math.min(Math.max(cfg.minRwy, 0), 20000);
    cfg.goodFillPct = Math.min(Math.max(cfg.goodFillPct, 0), 100);
    cfg.throttleMs = Math.min(Math.max(cfg.throttleMs, 100), 5000);
    // Strategy overlay (🎯 panel is the single source for N + speed). It DRIVES the
    // scoring band, the per-flight demand split (÷N) and the search distance. An impossible
    // leftover N (A380 4× saved on an MC-21) is snapped to max-range before scoring.
    if (typeof am4StratEnsurePossibleN === 'function') am4StratEnsurePossibleN();
    var strat = (typeof am4StratLoadCfg === 'function') ? am4StratLoadCfg() : { n: 2, modded: true };
    var band = am4StratBand(strat.n, strat);
    cfg.flightsPerDay = strat.n;
    cfg.cruiseKph = am4StratCruiseKph(strat);
    cfg.realSpeed = band.realSpeed;
    cfg.bandPossible = !!band.possible;
    if (!band.possible && typeof am4StratLongestN === 'function') {
        var nMax = am4StratLongestN(strat);
        var band2 = am4StratBand(nMax, strat);
        if (band2.possible) {
            strat.n = nMax;
            band = band2;
            cfg.flightsPerDay = nMax;
            cfg.bandPossible = true;
        }
    }
    cfg.bandLo = band.lo;
    cfg.bandHi = band.hi;
    cfg.rangeKm = band.hi; // upper edge of the chosen band (also the range cap)
    cfg.minKm = band.lo; // lower edge of the band
    cfg.distCap = band.hi; // research only needs candidates up to the band top
    cfg.seats = am4AircraftSeats();
    cfg.cargo = am4AircraftIsCargo();
    cfg.cargoKg = cfg.cargo ? am4AircraftCargoKg() : 0;
    cfg.cargoSplit = cfg.cargo ? am4AircraftCargoSplit() : { l: 0, h: 0, tot: 0 };
    cfg.typeId = am4AircraftTypeId();
    return cfg;
}
function am4ExpSaveCfg(cfg) {
    try {
        cfg = cfg || {};
        cfg.typeId = (typeof am4AircraftTypeId === 'function') ? am4AircraftTypeId() : cfg.typeId;
        var stored = {};
        try { stored = JSON.parse(localStorage.getItem(AM4_EXP_CFG_KEY) || '{}') || {}; } catch (e1) { stored = {}; }
        stored.byType = stored.byType || {};
        if (cfg.typeId) {
            stored.byType[String(cfg.typeId)] = {
                minRwy: cfg.minRwy,
                goodFillPct: cfg.goodFillPct
            };
        }
        ['seatStrategy','cargoStrategy','minRwy','distCap','goodFillPct','throttleMs','cruiseKph','seats','rangeKm','minKm','typeId' ].forEach(function (k) {
            if (cfg[k] !== undefined) stored[k] = cfg[k];
        });
        stored.byType = stored.byType;
        localStorage.setItem(AM4_EXP_CFG_KEY, JSON.stringify(stored));
    } catch (e) { /* storage blocked */ }
}
// A cached hub result is only valid for the SETTINGS IT WAS SCORED WITH. The cache used to be
// keyed by hub id alone, so this happened silently: scan at Strategy 2, switch the 🎯 panel to
// Strategy 3, scan again with"use cached" ticked -> you got the Strategy-2 result back, with a
// green"✓ N good" badge and no hint that it answered a different question. Everything the
// scoring or the search depends on therefore goes into the key: N (drives the band AND the
// demand split), the cruise speed (drives the band), the runway floor, the fill threshold, the
// seat strategy and the seat count. Changing any of them now simply misses the cache and rescans.
function am4ExpCacheKey(hubId, cfg) {
    var split = cfg.cargoSplit || {};
    return String(hubId) +
        '|n' + (cfg.flightsPerDay || 2) +
        '|s' + Math.round(cfg.cruiseKph || 0) +
        '|r' + (cfg.minRwy || 0) +
        '|f' + (cfg.goodFillPct || 0) +
        '|' + (cfg.seatStrategy || '') +
        '|' + (cfg.cargoStrategy || '') +
        '|c' + (cfg.cargo ? ('g' + (cfg.cargoKg || 0) + 'w07v2lh' + (split.l || 0) + '-' + (split.h || 0)) : (cfg.seats || 0)) +
        '|t' + (cfg.typeId || (typeof am4AircraftTypeId === 'function' ? am4AircraftTypeId() : 0));
}
function am4ExpCacheUsable(entry, cfg) {
    if (!entry || !entry.good) return false;
    if (cfg) {
        var wantCargo = !!cfg.cargo;
        var gotCargo = !!entry.cargo;
        if (wantCargo !== gotCargo) return false;
        if (wantCargo && entry.cargo === false) return false;
        if (wantCargo && !entry.cargo && (entry.seats || 0) > 0 && (entry.seats || 0) <= 40) return false;
    }
    return true;
}
function am4ExpLoadCache() {
    try {
        var c = JSON.parse(localStorage.getItem(AM4_EXP_CACHE_KEY) || '{}');
        if (!c || typeof c !== 'object') return {};
        // Migration: entries written before the fingerprint existed are keyed by a bare hub id
        // and cannot be attributed to any settings, so they are dropped rather than trusted.
        var out = {}, dropped = 0;
        Object.keys(c).forEach(function (k) {
            if (k.indexOf('|') === -1) { dropped++; return; }
            out[k] = c[k];
        });
        if (dropped) {
            console.log('[AM4 Bot Log] Explorer cache: dropped ' + dropped +
            ' entry/entries from before the strategy fingerprint - they could not be matched to any settings.');
        }
        return out;
    } catch (e) { return {}; }
}
function am4ExpSaveCache(cache) {
    try { localStorage.setItem(AM4_EXP_CACHE_KEY, JSON.stringify(cache)); } catch (e) { /* storage full - drop silently */ }
}

// Departures/day DERIVED from the one-way distance: round-trip hours = 2*dist/speed,
// so departures/day = 24 / round-trip-hours = 12*speed/dist. A 14,500 km route ⇒ ~0.87/day
// (long-haul, low frequency); a short route ⇒ many/day. This is what divides the daily demand.
function am4ExpDeps(distKm, cfg) {
    if (!distKm || distKm <= 0) return 1;
    return 24 / (2 * distKm / (cfg.cruiseKph || am4StratCruiseStock()));
}

// Short human line under the scoring inputs.
function am4ExpCeilText(cfg) {
    cfg = cfg || am4ExpLoadCfg();
    var cargo = !!cfg.cargo;
    var n = cfg.flightsPerDay || 2;
    if (cfg.bandPossible === false) {
        return 'Strategy <b>' + n + ' flights/24 h</b> is beyond this type\'s range. Open &#127919; Strategy and pick the max-range N.';
    }
    return 'Strategy: <b>' + n + ' flights/24 h</b> &middot; routes <b>' + Number(cfg.bandLo).toLocaleString() +
        '&ndash;' + Number(cfg.bandHi).toLocaleString() + ' km</b> &middot; demand per flight = demand&divide;' + n +
        ' &middot; scoring <b>' + (cargo
            ? ((cfg.cargoKg || am4AircraftCargoKg() || 0).toLocaleString() + ' kg cargo')
            : ((cfg.seats || am4AircraftSeats() || 0) + ' seats')) + '</b> &middot; rwy &ge; <b>' + Number(cfg.minRwy || 0).toLocaleString() +
        ' ft</b> &middot; $/day = revenue&times;' + n + ' &middot; (change it in the &#127919; Strategy panel)';
}

// ---- Airport resolver + flown-route map from the live map globals -------------
function am4ExpBuildFlownMap() {
    var aid = window.airportIconData;
    var rm = window.routeMarkers;
    if (!Array.isArray(aid) || !aid.length || !rm || typeof rm !== 'object') {
        return { ok: false, map: {}, byId: {}, routeCount: 0 };
    }
    var byId = {}, byCoord = {};
    function ckey(lat, lon) { return (Math.round(lat * 100) / 100) + ',' + (Math.round(lon * 100) / 100); }
    for (var i = 0; i < aid.length; i++) {
        var a = aid[i];
        if (!a) continue;
        byId[String(a.Id)] = a;
        if (a.lat != null && a.lon != null) byCoord[ckey(+a.lat, +a.lon)] = a;
    }
    function resolveCoord(lat, lon) {
        var e = byCoord[ckey(lat, lon)];
        if (e) return e;
        var best = null, bd = 1e9;
        for (var j = 0; j < aid.length; j++) {
            var b = aid[j]; if (!b || b.lat == null) continue;
            var dl = +b.lat - lat, dg = +b.lon - lon, d = dl * dl + dg * dg;
            if (d < bd) { bd = d; best = b; }
        }
        // only trust a nearest match within ~0.15 degrees (~16km) to avoid mislabels
        return (best && bd <= 0.0225) ? best : null;
    }
    var map = {}, count = 0, rid2pair = {};
    Object.keys(rm).forEach(function (rid) {
        var ll = rm[rid] && rm[rid]._latlngs;
        if (!ll) return;
        var pts = [];
        (Array.isArray(ll) ? ll : []).forEach(function (seg) {
            if (Array.isArray(seg)) seg.forEach(function (p) { if (p && p.lat != null) pts.push([p.lat, p.lng]); });
            else if (seg && seg.lat != null) pts.push([seg.lat, seg.lng]);
        });
        if (pts.length < 2) return;
        var A = resolveCoord(pts[0][0], pts[0][1]);
        var B = resolveCoord(pts[pts.length - 1][0], pts[pts.length - 1][1]);
        if (!A || !B) return;
        (map[A.Id] = map[A.Id] || {})[B.Id] = true;
        (map[B.Id] = map[B.Id] || {})[A.Id] = true;
        rid2pair[String(rid)] = { a: A.Id, b: B.Id };
        count++;
    });

    // ---- Per-route PLANE COUNT (so the Explorer can show e.g. Addis->KSFO x2) --------------
    // routeMarkers dedupes an airport-pair to ONE polyline, so a 2nd A380 on the same pair is
    // invisible there. But statusData lists EVERY aircraft with its own routeId. Method
    // (live-verified 2026-08-13, yields the real Addis<->KSFO = 2 and the other true doubles):
    // - a plane whose routeId IS in routeMarkers -> that pair, +1 (the base plane).
    // - a plane whose routeId is NOT in routeMarkers (the extra on a doubled pair) -> resolve via
    // its TWIN: the user names the pair"<CODE>" and"<CODE>-2" , so strip the trailing"-N" ,
    // find the sibling plane with that exact base reg, and use ITS routeMarkers-known pair.
    // This never guesses a hub from the destination alone (San Francisco is served from 5 hubs).
    // Zero requests - all from live globals. Only undercounts a doubled pair where NEITHER plane is
    // route-named (rare, e.g. a stock"A380/74M"); it never overcounts.`unresolved` is surfaced.
    var counts = {}, unresolved = 0;
    var sd = window.statusData;
    if (sd && typeof sd === 'object') {
        var byReg = {};
        Object.keys(sd).forEach(function (k) {
            var r = sd[k] && String(sd[k].reg == null ?'' : sd[k].reg).trim();
            if (r) byReg[r.toUpperCase()] = sd[k];
        });
        var incCount = function (h, d) { (counts[h] = counts[h] || {})[d] = (counts[h][d] || 0) + 1; };
        Object.keys(sd).forEach(function (k) {
            var p = sd[k];
            if (!p || !p.routeId || p.routeId === 0) return;
            var wantIcon = am4AircraftIconId();
            if (wantIcon && p.icon && p.icon !== wantIcon) return;
            var pr = rid2pair[String(p.routeId)];
            if (!pr) {
                var m = String(p.reg == null ?'' : p.reg).trim().match(/^(.*?)[\s-]+(\d+)$/);
                if (m) { var tw = byReg[m[1].trim().toUpperCase()]; if (tw) pr = rid2pair[String(tw.routeId)]; }
            }
            if (!pr) { unresolved++; return; }
            incCount(pr.a, pr.b); incCount(pr.b, pr.a);
        });
    }
    return { ok: true, map: map, counts: counts, unresolved: unresolved, byId: byId, routeCount: count };
}

// ---- Scoring ------------------------------------------------------------------
function am4ExpPrices(d) { return { y: 0.4 * d + 170, j: 0.8 * d + 560, f: 1.2 * d + 1200 }; }
// Per-kg cargo ticket formulas used by AM4 calculators (Large / Heavy).
function am4ExpCargoPrices(d) {
    return {
        l: 0.0007763975155 * d + 0.1401945289,
        h: 0.0005175983437 * d + 0.0934782609
    };
}

// AM4 cargo capacity weights (official): Large costs 0.7 capacity units per kg,
// Heavy costs 1.0. 100% Large config therefore carries 0.7 × raw capacity.
var AM4_CARGO_W_L = 0.7;
var AM4_CARGO_W_H = 1.0;

// Research rows expose Y/J/F always. Cargo demand is Y×500 / J×1000 (game formula).
// data-large / data-heavy are used when they already look like that cargo scale.
function am4ExpCargoDailyDemand(r) {
    var y = Math.max(0, r.dY || 0);
    var j = Math.max(0, r.dJ || 0);
    var fromPaxL = y * 500;
    var fromPaxH = j * 1000;
    var attrL = Math.max(0, r.dL || 0);
    var attrH = Math.max(0, r.dH || 0);
    var dL = attrL;
    var dH = attrH;
    // Attribute missing, or still on the pax scale → convert from Y/J.
    if (!(attrL > 0) || (y > 0 && attrL < fromPaxL * 0.45)) dL = fromPaxL;
    if (!(attrH > 0) || (j > 0 && attrH < fromPaxH * 0.45)) dH = fromPaxH;
    // If both attr and pax are empty, keep zeros.
    if (!dL && fromPaxL) dL = fromPaxL;
    if (!dH && fromPaxH) dH = fromPaxH;
    return { l: dL, h: dH };
}

function am4ExpFillCargo(dL, dH, dist, cfg) {
    // Pack into raw capacity C with weights L=0.7 / H=1.0. Prefer Large or Heavy
    // per the Cargo pack setting. Research lists BOTH demands on every row —
    // sort-by-large / sort-by-heavy only changes row order.
    var C = Number(cfg.cargoKg) || 0;
    var p = am4ExpCargoPrices(dist);
    var demand = { l: Math.max(0, dL || 0), h: Math.max(0, dH || 0) };
    var load = { l: 0, h: 0 };
    var left = C;
    var order = (cfg.cargoStrategy === 'heavy-first') ? ['h','l' ] : ['l','h' ];
    var w = { l: AM4_CARGO_W_L, h: AM4_CARGO_W_H };
    var i;
    for (i = 0; i < order.length; i++) {
        var c = order[i];
        if (!(w[c] > 0) || left <= 0) continue;
        var maxByCap = left / w[c];
        var take = Math.min(demand[c], maxByCap);
        if (take < 0) take = 0;
        load[c] = take;
        left -= take * w[c];
    }
    var used = C - left;
    var fillPct = C > 0 ? Math.round(used / C * 100) : ((load.l + load.h) > 0 ? 100 : 0);
    var rev = load.l * p.l + load.h * p.h;
    return {
        s: { l: Math.round(load.l), h: Math.round(load.h), y: 0, j: 0, f: 0 },
        revPerDep: Math.round(rev),
        fillPct: fillPct,
        usedCap: Math.round(used),
        dailyDemand: demand
    };
}

function am4PaxSeatSlots(y, j, f) {
    return (Math.max(0, parseInt(y, 10) || 0)) + 2 * (Math.max(0, parseInt(j, 10) || 0)) +
        3 * (Math.max(0, parseInt(f, 10) || 0));
}

function am4PaxSeatMaxAt(y, j, f, cap) {
    y = Math.max(0, parseInt(y, 10) || 0);
    j = Math.max(0, parseInt(j, 10) || 0);
    f = Math.max(0, parseInt(f, 10) || 0);
    cap = Math.max(0, parseInt(cap, 10) || 0);
    return {
        y: Math.max(0, cap - 2 * j - 3 * f),
        j: Math.max(0, Math.floor((cap - y - 3 * f) / 2)),
        f: Math.max(0, Math.floor((cap - y - 2 * j) / 3))
    };
}

// After demand is packed, AM4 still allows raising classes until Y+2J+3F = capacity.
// The order/modify form tops up (e.g. Y248/J50 demand → F84 to fill 600 slots).
function am4PaxSeatFillPhysical(s, cap, topOrder) {
    var W = { y: 1, j: 2, f: 3 };
    s = {
        y: Math.max(0, parseInt(s.y, 10) || 0),
        j: Math.max(0, parseInt(s.j, 10) || 0),
        f: Math.max(0, parseInt(s.f, 10) || 0)
    };
    cap = Math.max(0, parseInt(cap, 10) || 0);
    topOrder = topOrder || ['f','j','y' ];
    var guard = 0;
    while (cap - am4PaxSeatSlots(s.y, s.j, s.f) > 0 && guard++ < cap * 3) {
        var left = cap - am4PaxSeatSlots(s.y, s.j, s.f);
        var maxAt = am4PaxSeatMaxAt(s.y, s.j, s.f, cap);
        var added = false;
        var i;
        for (i = 0; i < topOrder.length; i++) {
            var c = topOrder[i];
            if (W[c] > left) continue;
            if (s[c] >= maxAt[c]) continue;
            s[c]++;
            added = true;
            break;
        }
        if (!added) break;
    }
    return s;
}

function am4PaxSeatNormalize(y, j, f, cap, topOrder) {
    var s = am4PaxSeatFillPhysical({ y: y, j: j, f: f }, cap, topOrder);
    while (am4PaxSeatSlots(s.y, s.j, s.f) > cap && s.y > 0) s.y--;
    while (am4PaxSeatSlots(s.y, s.j, s.f) > cap && s.j > 0) s.j--;
    while (am4PaxSeatSlots(s.y, s.j, s.f) > cap && s.f > 0) s.f--;
    return s;
}

function am4ExpFill(order, caps, d, cfg) {
    // Slot weights VERIFIED from the user's real A380 configs (2026-08-13): a First seat
    // costs 3 economy slots, NOT 4. e.g. Y449 J30 F30 = 449 + 60 + 90 = 599 ≈ 600 (F=4 gave 629).
    var W = { y: 1, j: 2, f: 3 };
    var cap = cfg.seats;
    var s = { y: 0, j: 0, f: 0 };
    var slots = cap;
    order.forEach(function (c) {
        var maxAt = am4PaxSeatMaxAt(s.y, s.j, s.f, cap);
        var take = Math.min(caps[c], maxAt[c], Math.floor(slots / W[c]));
        if (take < 0) take = 0;
        s[c] = take;
        slots -= take * W[c];
    });
    var keys = ['y','j','f' ], changed = true;
    while (slots > 0 && changed) {
        changed = false;
        for (var k = 0; k < keys.length; k++) {
            var c = keys[k];
            var maxAt2 = am4PaxSeatMaxAt(s.y, s.j, s.f, cap);
            if (s[c] < caps[c] && s[c] < maxAt2[c] && W[c] <= slots) {
                s[c]++; slots -= W[c]; changed = true; break;
            }
        }
    }
    var topOrder = (cfg.seatStrategy === 'economy-first') ? ['y','j','f' ] : ['f','j','y' ];
    s = am4PaxSeatFillPhysical(s, cap, topOrder);
    var p = am4ExpPrices(d);
    var used = am4PaxSeatSlots(s.y, s.j, s.f);
    return {
        s: s,
        revPerDep: Math.round(s.y * p.y + s.j * p.j + s.f * p.f),
        fillPct: cap > 0 ? Math.round(used / cap * 100) : 0
    };
}

function am4ExpParseNum(v) {
    var n = parseInt(String(v == null ?'' : v).replace(/[^0-9]/g,''), 10);
    return isFinite(n) ? n : 0;
}
function am4ExpAttrNum(el, names) {
    var i, n, v;
    for (i = 0; i < names.length; i++) {
        v = el.getAttribute(names[i]);
        if (v == null || v === '') continue;
        n = am4ExpParseNum(v);
        if (n > 0) return n;
    }
    return 0;
}
function am4ExpRowCargoDemand(el) {
    var dL = am4ExpAttrNum(el, ['data-large','data-lclass','data-lcargo','data-clarge','data-cargol','data-largedemand' ]);
    var dH = am4ExpAttrNum(el, ['data-heavy','data-hclass','data-hcargo','data-cheavy','data-cargoh','data-heavydemand' ]);
    if (!dL && !dH && el.attributes) {
        Array.prototype.forEach.call(el.attributes, function (a) {
            var n = String(a.name || '').toLowerCase();
            var val = am4ExpParseNum(a.value);
            if (!val) return;
            if (/large/.test(n) && !/yclass|jclass|fclass|distance|rwy/.test(n)) dL = dL || val;
            if (/heavy/.test(n) && !/distance|rwy/.test(n)) dH = dH || val;
        });
    }
    return { l: dL, h: dH };
}

function am4ExpParseRows(html) {
    var box = document.createElement('div');
    box.innerHTML = html;
    var out = [];
    var seen = {};
    box.querySelectorAll('.sorter[data-distance], [data-distance][data-rwy], [data-large], [data-heavy]').forEach(function (el) {
        var oc = el.getAttribute('onclick') || '';
        var m = oc.match(/arr=(\d+)/) || String(el.getAttribute('data-arr') || '').match(/(\d+)/);
        var arrId = m ? m[1] : null;
        var dist = Math.round(parseFloat(el.getAttribute('data-distance')) || 0);
        var key = (arrId || '') + ':' + dist;
        if (seen[key]) return;
        seen[key] = true;
        var exo = el.querySelector('.exo');
        var texts = el.querySelectorAll('.s-text');
        var cargo = am4ExpRowCargoDemand(el);
        out.push({
            pair: exo ? (exo.innerText || '').replace(/\s+/g,'') : '',
            destName: (texts && texts.length >= 2) ? (texts[1].innerText || '').trim() : '',
            arrId: arrId,
            dist: dist,
            rwy: am4ExpParseNum(el.getAttribute('data-rwy')),
            dY: am4ExpParseNum(el.getAttribute('data-yclass')),
            dJ: am4ExpParseNum(el.getAttribute('data-jclass')),
            dF: am4ExpParseNum(el.getAttribute('data-fclass')),
            dL: cargo.l,
            dH: cargo.h
        });
    });
    return out;
}

function am4ExpScoreRoutes(rows, flownSet, cfg, countSet) {
    // economy-first = Y→J→F (the user's real style). revenue = F→J→Y: with the corrected F=3
    // weight, revenue-per-slot is First (0.4d+400) > Business (0.4d+280) > Economy (0.4d+170).
    var cargo = !!cfg.cargo;
    var order = (cfg.seatStrategy === 'economy-first') ? ['y','j','f' ] : ['f','j','y' ];
    var N = cfg.flightsPerDay || 2; // one-way FLIGHTS (legs) per 24 h — the chosen strategy
    var starFloor = cfg.bandLo + (cfg.bandHi - cfg.bandLo) * (2 / 3);
    var good = [];
    var seen = {}; // dedupe destinations that appear under more than one country
    var stats = { rows: 0, unique: 0, rwyFail: 0, distFail: 0, inBand: 0, fillFail: 0, zeroRev: 0, bestFill: 0, bestDemand: 0 };
    rows.forEach(function (r) {
        stats.rows++;
        if (!r.arrId || seen[r.arrId]) return;
        seen[r.arrId] = true;
        stats.unique++;
        if (r.rwy < cfg.minRwy) { stats.rwyFail++; return; }
        if (r.dist > cfg.bandHi || r.dist < cfg.bandLo) { stats.distFail++; return; }
        stats.inBand++;
        var plan;
        var cargoDem = null;
        if (cargo) {
            cargoDem = am4ExpCargoDailyDemand(r);
            // Per-flight share of daily cargo demand (same ÷N rule as pax).
            plan = am4ExpFillCargo(Math.floor(cargoDem.l / N), Math.floor(cargoDem.h / N), r.dist, cfg);
            if (plan.fillPct > stats.bestFill) stats.bestFill = plan.fillPct;
            var demTot = (cargoDem.l || 0) + (cargoDem.h || 0);
            if (demTot > stats.bestDemand) stats.bestDemand = demTot;
        } else {
            var caps = { y: Math.floor(r.dY / N), j: Math.floor(r.dJ / N), f: Math.floor(r.dF / N) };
            plan = am4ExpFill(order, caps, r.dist, cfg);
        }
        var capOk = cargo ? ((cfg.cargoKg || 0) > 0 || (plan.s.l + plan.s.h) > 0) : (cfg.seats > 0);
        if (!capOk || plan.revPerDep <= 0) { stats.zeroRev++; return; }
        if (plan.fillPct < cfg.goodFillPct) { stats.fillFail++; return; }
        good.push({
            pair: r.pair, dest: r.destName, arrId: r.arrId, km: r.dist, rwy: r.rwy,
            deps: N,
            demand: cargo
                ? { y: r.dY || 0, j: r.dJ || 0, f: r.dF || 0, l: cargoDem.l, h: cargoDem.h }
                : { y: r.dY, j: r.dJ, f: r.dF, l: r.dL || 0, h: r.dH || 0 },
            cfg: plan.s, fillPct: plan.fillPct, cargo: cargo,
            revPerDay: Math.round(plan.revPerDep * N),
            preferred: (r.dist >= starFloor),
            built: !!(flownSet && flownSet[r.arrId]),
            planes: (countSet && countSet[r.arrId]) || ((flownSet && flownSet[r.arrId]) ? 1 : 0)
        });
    });
    good.sort(function (a, b) { return (Number(b.preferred) - Number(a.preferred)) || (b.km - a.km) || (b.revPerDay - a.revPerDay); });
    var builtN = good.filter(function (g) { return g.built; }).length;
    return { good: good, goodCount: good.length, built: builtN, remaining: good.length - builtN, stats: stats };
}

// ---- Owned hubs + country list (read once, cached) ----------------------------
// A newly bought hub has to be able to appear on its own.
//
// Reported 2026-08-17: a hub was bought and never showed up in the Explorer. The list was
// not wrong, it was FROZEN - this cache had no expiry at all and`force` was never passed by
// any caller, so whatever hubs existed the first time the Explorer was opened stayed the
// answer forever. The only way out was clearing localStorage by hand, which nobody can be
// expected to know.
//
// It is worse than a stale list, because the Rebuild module reads the same cache to decide
// which end of a route is home: an aircraft based at a hub the cache has never heard of gets
// hubCertain:false and is quietly left out of every rebuild plan (see am4RbClassifyFleet).
//
// Six hours: hubs are bought rarely, the read is one request, and the ⟳ next to the hub count
// forces it immediately for the case where you just bought one and want it NOW.
var AM4_EXP_META_TTL_MS = 6 * 60 * 60 * 1000;

function am4ExpMetaCached() {
    try {
        var c = JSON.parse(localStorage.getItem(AM4_EXP_META_KEY) || 'null');
        if (c && c.v === AM4_EXP_META_V && c.hubs && c.hubs.length && c.countries && c.countries.length) {
            if (/^\d+$/.test(String(c.countries[0] || ''))) return null;
            return c;
        }
    } catch (e) { /* unreadable - treat as absent */ }
    return null;
}
function am4ExpMetaAgeMs() {
    var c = am4ExpMetaCached();
    if (!c || !c.at) return null;
    var t = Date.parse(c.at);
    return isFinite(t) ? (Date.now() - t) : null;
}

// research_main search uses the visible country NAME in arr=, not a numeric option value.
function am4ExpCountryFromOption(o) {
    if (!o) return '';
    var val = (o.value || '').trim();
    var text = (o.textContent || '').trim();
    if (/^-\s*select/i.test(val) || /^-\s*select/i.test(text)) return '';
    if (text.length > 1 && !/^\d+$/.test(text)) return text;
    if (val.length > 1 && !/^\d+$/.test(val)) return val;
    return '';
}

function am4ExpFetchMeta(force) {
    return new Promise(function (resolve) {
        var cached = am4ExpMetaCached();
        if (!force && cached) {
            var age = am4ExpMetaAgeMs();
            // A cache entry written before this version has no usable timestamp; refresh it
            // once rather than trusting it indefinitely.
            if (age != null && age < AM4_EXP_META_TTL_MS) { return resolve(cached); }
        }
        fetch('research_main.php', { credentials: 'include'})
            .then(function (r) { return r.text(); })
            .then(function (html) {
                var box = document.createElement('div'); box.innerHTML = html;
                var hubSel = box.querySelector('#hubSelect');
                var countrySel = box.querySelector('#countrySelector');
                var hubs = [];
                if (hubSel) {
                    Array.prototype.forEach.call(hubSel.querySelectorAll('option'), function (o) {
                        if (o.value && /^\d+$/.test(o.value)) {
                            hubs.push({ id: o.value, name: (o.textContent || '').trim() });
                        }
                    });
                }
                var countries = [];
                if (countrySel) {
                    Array.prototype.forEach.call(countrySel.querySelectorAll('option'), function (o) {
                        var c = am4ExpCountryFromOption(o);
                        if (c) countries.push(c);
                    });
                }
                // A logged-out page, an error page or a half-rendered response all answer 200
                // with no dropdowns. Overwriting a good hub list with that would be worse than
                // the staleness this refresh exists to fix, so an empty read never replaces a
                // list we already have.
                if ((!hubs.length || !countries.length) && cached) {
                    console.log('[AM4 Bot Log] Explorer: the research page returned no hub list - keeping the previous one.');
                    return resolve(cached);
                }
                var meta = { v: AM4_EXP_META_V, hubs: hubs, countries: countries, at: (new Date()).toISOString() };
                try { localStorage.setItem(AM4_EXP_META_KEY, JSON.stringify(meta)); } catch (e) { /* ignore */ }
                // The Rebuild module decides which end of a route is home from this hub list, so
                // its derived classification has to be recomputed against the new one.
                am4RbFleetCache = null;
                resolve(meta);
            })
            .catch(function () { resolve(cached || { hubs: [], countries: [], at: null }); });
    });
}

// ---- Scan one hub across the country list -------------------------------------
function am4ExpScanOneHub(hub, countries, flownMap, cfg, runID, onCountry) {
    return new Promise(function (resolve) {
        var flownSet = flownMap.map[hub.id] || {};
        var countSet = (flownMap.counts && flownMap.counts[hub.id]) || {};
        var rows = [], i = 0;
        (function next() {
            if (runID !== am4ExpRunID) { resolve(null); return; } // cancelled
            if (i >= countries.length) {
                var scored = am4ExpScoreRoutes(rows, flownSet, cfg, countSet);
                resolve({
                    hubId: hub.id, hubName: hub.name, candidate: !!hub.candidate,
                    flownFromHub: Object.keys(flownSet).length,
                    destinationsSeen: rows.length,
                    goodCount: scored.goodCount, built: scored.built, remaining: scored.remaining,
                    good: scored.good, stats: scored.stats, seats: cfg.seats, minRwy: cfg.minRwy,
                    cargo: !!cfg.cargo, cargoKg: cfg.cargoKg || 0,
                    strategy: cfg.seatStrategy, at: (new Date()).toISOString()
                });
                return;
            }
            var url = 'research_main.php?mode=search&rwy=' + cfg.minRwy + '&dist=' + cfg.distCap +
                '&depId=' + encodeURIComponent(hub.id) + '&arr=' + encodeURIComponent(countries[i]) +
                '&arrId=0&charter=0&_=' + Date.now();
            fetch(url, { credentials: 'include'})
                .then(function (r) { return r.text(); })
                .then(function (h) { rows = rows.concat(am4ExpParseRows(h)); })
                .catch(function () { /* skip this country */ })
                .then(function () {
                    var doneCountry = countries[i];
                    i++;
                    if (typeof onCountry === 'function') onCountry(i, countries.length, doneCountry, hub);
                    setTimeout(next, cfg.throttleMs);
                });
        })();
    });
}

// ---- Orchestrate a scan over a list of hubs ------------------------------------
// callbacks: { onHubStart, onCountry, onHubDone, onDone, onCancel }
function am4ExpScan(hubList, cfg, useCache, callbacks) {
    callbacks = callbacks || {};
    if (am4ExpScanning) { if (callbacks.onBusy) callbacks.onBusy(); return; }
    var flownMap = am4ExpBuildFlownMap();
    am4ExpScanning = true;
    am4ExpRunID++;
    var runID = am4ExpRunID;
    var cache = am4ExpLoadCache();

    am4ExpFetchMeta(false).then(function (meta) {
        var countries = meta.countries && meta.countries.length ? meta.countries : [];
        var idx = 0;
        (function nextHub() {
            if (runID !== am4ExpRunID) { am4ExpScanning = false; if (callbacks.onCancel) callbacks.onCancel(); return; }
            if (idx >= hubList.length) {
                am4ExpScanning = false;
                if (callbacks.onDone) callbacks.onDone(am4ExpResults, flownMap);
                return;
            }
            var hub = hubList[idx];
            var ck = am4ExpCacheKey(hub.id, cfg); // fingerprinted: a cached result only counts for THESE settings
            if (useCache && cache[ck] && am4ExpCacheUsable(cache[ck], cfg)) {
                cache[ck]._ck = ck;
                am4ExpResults[hub.id] = cache[ck];
                if (callbacks.onHubDone) callbacks.onHubDone(cache[ck], idx, hubList.length, true);
                idx++;
                nextHub();
                return;
            }
            if (callbacks.onHubStart) callbacks.onHubStart(hub, idx, hubList.length);
            am4ExpScanOneHub(hub, countries, flownMap, cfg, runID, callbacks.onCountry).then(function (res) {
                if (!res) { am4ExpScanning = false; if (callbacks.onCancel) callbacks.onCancel(); return; }
                res._ck = ck;
                res.strategyN = cfg.flightsPerDay;
                am4ExpResults[hub.id] = res;
                cache[ck] = res;
                am4ExpSaveCache(cache);
                if (callbacks.onHubDone) callbacks.onHubDone(res, idx, hubList.length, false);
                idx++;
                nextHub();
            });
        })();
    });
    return runID;
}

function am4ExpCancel() { am4ExpRunID++; am4ExpScanning = false; }

// Expose the engine for headless (CDP) testing.
window.AM4Explorer = {
    loadCfg: am4ExpLoadCfg, saveCfg: am4ExpSaveCfg,
    loadCache: am4ExpLoadCache, saveCache: am4ExpSaveCache, cacheKey: am4ExpCacheKey,
    buildFlownMap: am4ExpBuildFlownMap, scoreRoutes: am4ExpScoreRoutes,
    parseRows: am4ExpParseRows, fetchMeta: am4ExpFetchMeta,
    metaCached: am4ExpMetaCached, metaAge: am4ExpMetaAgeMs, loadMeta: am4ExpLoadMeta, metaTtl: AM4_EXP_META_TTL_MS,
    scanOneHub: am4ExpScanOneHub, scan: am4ExpScan, cancel: am4ExpCancel,
    deps: am4ExpDeps, results: function () { return am4ExpResults; }
};

// ================= Research Explorer UI (control-bar button + panel + tab) ======
function am4ExpInjectStyles() {
    if (document.getElementById('am4ExplorerStyles')) return;
    var st = document.createElement('style');
    st.id = 'am4ExplorerStyles';
    st.textContent = [
        "#am4ExplorerBtn { cursor:pointer; color:#38bdf8; font-size:13px; line-height:1; padding:2px 6px; border-radius:4px; transition:background .15s; user-select:none; font-family:monospace; white-space:nowrap; }",
        "#am4ExplorerBtn:hover { background:rgba(56,189,248,0.15); }",
        "#am4ExplorerPanel { position:fixed; top:60px; right:20px; width:min(420px, calc(100vw - 24px)); max-height:84vh; overflow-y:auto; background:rgba(15,19,26,0.98); border:1px solid #34495e; border-radius:8px; color:#e2e8f0; font-family:monospace; font-size:12px; z-index:1041; padding:14px; box-shadow:0 6px 24px rgba(0,0,0,0.6); display:none; }",
        "#am4ExplorerPanel h3 { margin:0 0 6px 0; font-size:13px; color:#38bdf8; letter-spacing:1px; display:flex; }",
        "#am4ExplorerPanel h3 span:first-child { flex-grow:1; }",
        "#am4ExpClose { cursor:pointer; color:#ef4444; font-weight:bold; padding:0 4px; }",
        ".am4-exp-meta { font-size:10px; color:#64748b; margin:2px 0 8px 0; line-height:1.4; }",
        ".am4-exp-sec { border-top:1px dashed #334155; margin-top:10px; padding-top:7px; font-weight:bold; color:#f59e0b; font-size:11px; letter-spacing:0.5px; }",
        ".am4-exp-row { display:flex; justify-content:space-between; align-items:center; margin:5px 0; gap:8px; flex-wrap:wrap; }",
        ".am4-exp-row label { color:#94a3b8; }",
        ".am4-exp-row input[type=number], .am4-exp-row select { width:78px; background:#1e293b; border:1px solid #475569; color:#e2e8f0; border-radius:4px; padding:2px 5px; font-family:monospace; font-size:12px; }",
        ".am4-exp-row select { width:auto; }",
        ".am4-exp-hublist { max-height:200px; overflow-y:auto; border:1px solid #334155; border-radius:5px; padding:5px 7px; margin-top:5px; }",
        ".am4-exp-hub { display:flex; align-items:center; gap:6px; padding:2px 0; font-size:11px; }",
        ".am4-exp-hub label { color:#cbd5e1; flex-grow:1; cursor:pointer; }",
        ".am4-exp-hub .cached { color:#10b981; font-size:9px; white-space:nowrap; }",
        ".am4-exp-eta { font-size:10px; color:#f59e0b; margin:6px 0; line-height:1.4; }",
        ".am4-exp-prog { font-size:10px; color:#38bdf8; margin-top:6px; min-height:14px; word-break:break-word; }",
        ".am4-exp-bar { height:6px; background:#1e293b; border-radius:3px; overflow:hidden; margin-top:4px; }",
        ".am4-exp-bar > div { height:100%; width:0%; background:#10b981; transition:width .2s; }",
        ".am4-exp-btn { cursor:pointer; border:none; border-radius:5px; padding:6px 10px; font-family:monospace; font-size:12px; font-weight:bold; }",
        ".am4-exp-btn-go { background:#10b981; color:#04211a; }",
        ".am4-exp-btn-go:hover { background:#34d399; }",
        ".am4-exp-btn-stop { background:#7f1d1d; color:#fecaca; }",
        ".am4-exp-btn-tab { background:#1d4ed8; color:#dbeafe; }",
        ".am4-exp-btn-mini { background:#334155; color:#94a3b8; font-size:10px; padding:2px 7px; font-weight:normal; }",
        ".am4-exp-btnrow { display:flex; gap:8px; margin-top:10px; align-items:center; flex-wrap:wrap; }",
        "#am4ExpInlineResults { margin-top:10px; max-height:280px; overflow:auto; border:1px solid #1e293b; border-radius:6px; padding:8px; font-size:11px; display:none; }",
        "#am4ExpInlineResults h4 { margin:0 0 6px 0; color:#38bdf8; font-size:11px; letter-spacing:0.4px; }",
        "#am4ExpInlineResults table { width:100%; border-collapse:collapse; }",
        "#am4ExpInlineResults th, #am4ExpInlineResults td { padding:3px 5px; border-bottom:1px solid #1e293b; text-align:left; }",
        "#am4ExpInlineResults th { color:#94a3b8; font-size:10px; }",
        "#am4ExpInlineResults .am4-exp-build { cursor:pointer; border:none; border-radius:4px; padding:2px 8px; background:#1d4ed8; color:#dbeafe; font-size:10px; font-weight:bold; font-family:monospace; }",
        "#am4ExpInlineResults .dim { color:#64748b; }"
    ].join("\n");
    document.head.appendChild(st);
}

function am4ExpInjectButton() {
    var bar = document.getElementById('am4ControlBar');
    if (!bar || document.getElementById('am4ExplorerBtn')) return;
    am4ExpInjectStyles();
    var btn = document.createElement('span');
    btn.id = 'am4ExplorerBtn';
    btn.title = 'AM4 Research Explorer — strategy (flights/24h), hub scan, route ranking';
    btn.innerText = '🔎 Explorer';
    var gear = document.getElementById('am4SettingsBtn');
    if (gear && gear.parentElement === bar) bar.insertBefore(btn, gear);
    else bar.appendChild(btn);
    btn.addEventListener('click', am4ExpTogglePanel);
}

function am4ExpTogglePanel() {
    var panel = document.getElementById('am4ExplorerPanel');
    if (panel && panel.style.display === 'block') { panel.style.display = 'none'; return; }
    am4ExpBuildPanel().style.display = 'block';
}

// Renders one labelled number input (used two-per-row).
function am4ExpNumCell(label, key, cfg) {
    return"<label>" + label +"</label><input type='number' data-exp-key='" + key +"' value='" + cfg[key] +"'>" ;
}

var am4ExpMeta = { hubs: [], countries: [] };

function am4ExpScoringModeHTML(cfg) {
    cfg = cfg || am4ExpLoadCfg();
    var h = [];
    if (typeof am4AircraftIsCargo === 'function' && am4AircraftIsCargo()) {
        var sp = am4AircraftCargoSplit();
        h.push("<div class='am4-exp-row'><label>Order holds</label><span style='color:#94a3b8;'>L" + sp.l +" / H" + sp.h +
            " on the purchase form (Auto-Build). Explorer fill uses AM4 weights (Large 0.7 / Heavy 1.0 of " +
            Number(am4AircraftCargoKg() || 0).toLocaleString() +" capacity) and demand L=Y×500, H=J×1000 — both columns every row.</span></div>");
        h.push("<div class='am4-exp-row'><label>Cargo pack</label><select data-exp-key='cargoStrategy'>" +
            "<option value='large-first'" + (cfg.cargoStrategy !== 'heavy-first' ?' selected' : '') +">Large first (then Heavy)</option>" +
            "<option value='heavy-first'" + (cfg.cargoStrategy === 'heavy-first' ?' selected' : '') +">Heavy first (then Large)</option>" +
            "</select></div>");
    } else {
        h.push("<div class='am4-exp-row'><label>Seat strategy</label><select data-exp-key='seatStrategy'>" +
            "<option value='revenue'" + (cfg.seatStrategy === 'revenue' ?' selected' : '') +">Revenue (J&rarr;Y&rarr;F)</option>" +
            "<option value='economy-first'" + (cfg.seatStrategy === 'economy-first' ?' selected' : '') +">Economy-first (Y&rarr;J&rarr;F)</option>" +
            "</select></div>");
    }
    return h.join('');
}

function am4ExpBindScoringInputs(root) {
    if (!root) return;
    root.querySelectorAll('[data-exp-key]').forEach(function (inp) {
        if (inp.getAttribute('data-am4-bound')) return;
        inp.setAttribute('data-am4-bound','1');
        inp.addEventListener('change', function () {
            am4ExpReadCfgFromPanel();
            var ceil = document.getElementById('am4ExpCeil');
            if (ceil) ceil.innerHTML = am4ExpCeilText(am4ExpLoadCfg());
            am4ExpUpdateEta();
        });
    });
}

function am4ExpBuildPanel() {
    var old = document.getElementById('am4ExplorerPanel');
    if (old) old.remove();
    am4ExpInjectStyles();
    var cfg = am4ExpLoadCfg();
    var cache = am4ExpLoadCache();
    var panel = document.createElement('div');
    panel.id = 'am4ExplorerPanel';
    var h = [];
    h.push("<h3><span>🔎 EXPLORER &amp; STRATEGY</span><span id='am4ExpClose'>[X]</span></h3>");
    h.push("<div class='am4-exp-meta' id='am4ExpMeta'>reading owned hubs &amp; country list…</div>");
    h.push("<div class='am4-exp-sec' id='am4ExpStratHost'>🎯 STRATEGY <span style='font-weight:normal; color:#64748b;'>(drives distance band + demand÷N)</span></div>");
    h.push("<div style='font-size:10px; color:#94a3b8; margin:4px 0 6px 0; line-height:1.45;'>How often should one <b id='am4StratTypeName'>" + am4ExpEsc(am4AircraftName()) +"</b> fly per 24 h? Sets the distance band and demand÷N for scans below.</div>");
    h.push("<div class='am4-exp-row'><label>Aircraft</label><select id='am4StratType' style='max-width:250px; background:#1e293b; border:1px solid #475569; color:#e2e8f0; border-radius:4px; padding:2px 6px; font-family:monospace; font-size:12px;'></select></div>");
    h.push("<div id='am4StratN' style='display:flex; gap:6px; margin:6px 0; flex-wrap:wrap;'></div>");
    h.push("<div class='am4-exp-row'><label>Custom N</label><input type='number' id='am4StratNCustom' min='1' max='24' value='" + ((typeof am4StratLoadCfg === 'function' ? am4StratLoadCfg().n : 2)) +"' style='width:70px;'></div>");
    h.push("<div class='am4-exp-row'><label>Speed assumption</label><select id='am4StratSpeed' style='width:auto; max-width:220px;'></select></div>");
    h.push("<div id='am4StratBands' style='margin:4px 0 8px 0;'></div>");
    h.push("<div class='am4-exp-sec'>SCORING</div>");
    h.push("<div id='am4ExpScoringBody'>");
    h.push(am4ExpScoringModeHTML(cfg));
    h.push("</div>");
    h.push("<div class='am4-exp-row'>" + am4ExpNumCell('Fill ≥ (%)','goodFillPct', cfg) + am4ExpNumCell('Min runway (ft)','minRwy', cfg) +"</div>");
    h.push("<div class='am4-exp-row'>" + am4ExpNumCell('Throttle (ms)','throttleMs', cfg) +"</div>");
    h.push("<div style='font-size:9px; color:#64748b; margin:0 0 6px 0; line-height:1.4;'>Throttle = pause between each country research request during a scan (default 350 ms). Higher = slower but safer against rate-limits. Distance band comes from Strategy above — not separate range boxes.</div>");
    h.push("<div class='am4-exp-row'><span style='font-size:10px;color:#64748b;' id='am4ExpCeil'>" + am4ExpCeilText(cfg) +"</span></div>");
    h.push("<div class='am4-exp-sec'>HUBS TO ANALYSE <span style='float:right;font-weight:normal;'>" +
        "<button class='am4-exp-btn am4-exp-btn-mini' id='am4ExpAll'>all</button> " +
        "<button class='am4-exp-btn am4-exp-btn-mini' id='am4ExpNone'>none</button></span></div>");
    h.push("<div class='am4-exp-hublist' id='am4ExpHubList'>loading&hellip;</div>");
    h.push("<div class='am4-exp-sec' style='margin-top:8px;'>CANDIDATE HUBS (not owned) &mdash; optional</div>");
    h.push("<div style='font-size:9px; color:#64748b; margin:2px 0 4px 0;'>Score airports you don't own yet as future hubs. ICAO/IATA or name, comma-separated.</div>");
    h.push("<input type='text' id='am4ExpCandidates' placeholder='e.g. EHAM, KJFK, Amsterdam' style='width:100%; box-sizing:border-box; background:#1e293b; border:1px solid #475569; color:#e2e8f0; border-radius:4px; padding:3px 6px; font-family:monospace; font-size:11px;'>");
    h.push("<div class='am4-exp-row' style='margin-top:8px;'><label style='cursor:pointer;'><input type='checkbox' id='am4ExpUseCache' checked> use cached hub results</label></div>");
    h.push("<div class='am4-exp-eta' id='am4ExpEta'></div>");
    h.push("<div class='am4-exp-btnrow'>" +
        "<button class='am4-exp-btn am4-exp-btn-go' id='am4ExpStart'>Start scan</button>" +
        "<button class='am4-exp-btn am4-exp-btn-stop' id='am4ExpStop'>Cancel</button>" +
        "<button class='am4-exp-btn am4-exp-btn-tab' id='am4ExpTab'>Open results tab</button></div>");
    h.push("<div class='am4-exp-prog' id='am4ExpProg'></div>");
    h.push("<div class='am4-exp-bar'><div id='am4ExpBarFill'></div></div>");
    h.push("<div id='am4ExpInlineResults'></div>");
    panel.innerHTML = h.join('');
    document.body.appendChild(panel);

    document.getElementById('am4ExpClose').addEventListener('click', function () { panel.style.display = 'none'; });
    document.getElementById('am4ExpAll').addEventListener('click', function () { am4ExpSetAllHubs(true); });
    document.getElementById('am4ExpNone').addEventListener('click', function () { am4ExpSetAllHubs(false); });
    document.getElementById('am4ExpStart').addEventListener('click', am4ExpStartScan);
    document.getElementById('am4ExpStop').addEventListener('click', function () { am4ExpCancel(); am4ExpSetProg('Cancelled.'); });
    document.getElementById('am4ExpTab').addEventListener('click', am4ExpOpenResultsTab);
    var inlineBox = document.getElementById('am4ExpInlineResults');
    if (inlineBox && !inlineBox.getAttribute('data-am4-bound')) {
        inlineBox.setAttribute('data-am4-bound','1');
        inlineBox.addEventListener('click', am4ExpOnInlineBuildClick);
    }
    panel.querySelectorAll('[data-exp-key]').forEach(function (inp) {
        if (inp.closest('#am4ExpScoringBody')) return;
        if (inp.getAttribute('data-am4-bound')) return;
        inp.setAttribute('data-am4-bound','1');
        inp.addEventListener('change', function () {
            am4ExpReadCfgFromPanel();
            var ceil = document.getElementById('am4ExpCeil');
            if (ceil) ceil.innerHTML = am4ExpCeilText(am4ExpLoadCfg());
            am4ExpUpdateEta();
        });
    });
    am4ExpBindScoringInputs(document.getElementById('am4ExpScoringBody'));
    document.getElementById('am4ExpUseCache').addEventListener('change', am4ExpUpdateEta);
    var candBox = document.getElementById('am4ExpCandidates');
    if (candBox) candBox.addEventListener('input', am4ExpUpdateEta);

    // Strategy controls live in this panel (same IDs as the old standalone Strategy window).
    var stratSpeed = document.getElementById('am4StratSpeed');
    if (stratSpeed && !stratSpeed.getAttribute('data-am4-bound')) {
        stratSpeed.setAttribute('data-am4-bound','1');
        stratSpeed.addEventListener('change', function () {
            var c = am4StratLoadCfg(); c.modded = (this.value === 'mod'); am4StratSaveCfg(c); am4StrategyRender();
        });
    }
    var stratCustom = document.getElementById('am4StratNCustom');
    if (stratCustom && !stratCustom.getAttribute('data-am4-bound')) {
        stratCustom.setAttribute('data-am4-bound','1');
        stratCustom.addEventListener('change', function () {
            var c = am4StratLoadCfg(); c.n = am4StratClampN(this.value); am4StratSaveCfg(c); am4StrategyRender();
        });
    }
    var stratType = document.getElementById('am4StratType');
    if (stratType && !stratType.getAttribute('data-am4-bound')) {
        stratType.setAttribute('data-am4-bound','1');
        stratType.addEventListener('change', function () {
            am4AircraftSelectType(this.value, function () {
                am4StrategyRender();
                if (typeof am4RbOnAircraftTypeChanged === 'function') am4RbOnAircraftTypeChanged();
            });
        });
    }
    if (typeof am4StrategyRender === 'function') am4StrategyRender();
    if (typeof am4AircraftRefreshCatalog === 'function') {
        am4AircraftRefreshCatalog().then(function () {
            am4AircraftFillSelect(document.getElementById('am4StratType'), am4AircraftTypeId());
            am4AircraftFillSelect(document.getElementById('am4FleetType'), am4AircraftTypeId());
            if (typeof am4StrategyRender === 'function') am4StrategyRender();
        });
    }

    am4ExpLoadMeta(false);
    am4PanelChrome(panel,'explorer');
    if (am4ExpResults && Object.keys(am4ExpResults).length) am4ExpFillInlineResults(am4ExpResults);
    return panel;
}

// Loads the hub/country list into the open Explorer panel and redraws everything that depends
// on it. force=true is the"I just bought a hub, show it now" path behind the ⟳.
function am4ExpLoadMeta(force) {
    var mEl = document.getElementById('am4ExpMeta');
    if (mEl && force) mEl.innerHTML = 'reading your hubs from the game…';
    return am4ExpFetchMeta(!!force).then(function (meta) {
        am4ExpMeta = meta;
        var cfg = am4ExpLoadCfg();
        var cache = am4ExpLoadCache();
        var el = document.getElementById('am4ExpMeta');
        if (el) {
            var age = am4ExpMetaAgeMs();
            el.innerHTML = 'Owned hubs: <b>' + meta.hubs.length + '</b> &middot; Countries: <b>' + meta.countries.length +
                // Count only entries scored with the CURRENT settings - a total across every strategy
                // would claim hits the scan will not use.
                '</b> &middot; Cached: <b>' + meta.hubs.filter(function (h) {
                    var e = cache[am4ExpCacheKey(h.id, cfg)];
                    return !!(e && am4ExpCacheUsable(e, cfg));
                }).length +
                '</b> hubs at these settings' +
                " <span id='am4ExpMetaReload' title='Re-read your hubs from the game. Use this right after buying a new hub.' " +
                "style='cursor:pointer; color:#38bdf8; margin-left:4px;'>⟳</span>" +
                (age != null ? (" <span style='color:#475569;'>hub list read " + am4RbHuman(age) +" ago</span>") : '');
            var rl = document.getElementById('am4ExpMetaReload');
            if (rl) rl.addEventListener('click', function () { am4ExpLoadMeta(true); });
        }
        am4ExpRenderHubList(meta.hubs, cache, cfg);
        am4ExpUpdateEta();
        return meta;
    });
}

function am4ExpRenderHubList(hubs, cache, cfg) {
    var box = document.getElementById('am4ExpHubList');
    if (!box) return;
    if (!hubs.length) { box.innerHTML ="<span style='color:#ef4444;'>Could not read your hubs (open the game first).</span>" ; return; }
    cfg = cfg || am4ExpLoadCfg();
    box.innerHTML = hubs.map(function (hub) {
        // Only a result scored with the CURRENT settings counts as cached - otherwise the badge
        // would promise a hit that the scan then (correctly) ignores.
        var c = cache[am4ExpCacheKey(hub.id, cfg)];
        if (c && !am4ExpCacheUsable(c, cfg)) c = null;
        var badge = c ? "<span class='cached'>&#10003; " + c.goodCount +" good</span>" : '';
        return"<div class='am4-exp-hub'><input type='checkbox' class='am4-exp-hubcb' value='" + am4ExpEsc(hub.id) +
            "' data-name='" + am4ExpEsc(hub.name) +"'><label>" + am4ExpEsc(hub.name) +"</label>" + badge +"</div>" ;
    }).join('');
    box.querySelectorAll('.am4-exp-hubcb').forEach(function (cb) { cb.addEventListener('change', am4ExpUpdateEta); });
}

function am4ExpSetAllHubs(on) {
    document.querySelectorAll('.am4-exp-hubcb').forEach(function (cb) { cb.checked = on; });
    am4ExpUpdateEta();
}

function am4ExpSelectedHubs() {
    var out = [], seen = {};
    document.querySelectorAll('.am4-exp-hubcb:checked').forEach(function (cb) {
        out.push({ id: cb.value, name: cb.getAttribute('data-name') });
        seen[cb.value] = true;
    });
    // Candidate (non-owned) airports typed into the candidate box - scored the same way,
    // since the research search's depId is simply the airport's airportIconData.Id.
    var candBox = document.getElementById('am4ExpCandidates');
    if (candBox && candBox.value.trim()) {
        am4ExpResolveCandidates(candBox.value).forEach(function (c) {
            if (!seen[c.id]) { out.push(c); seen[c.id] = true; }
        });
    }
    return out;
}

// Parses a free-text list of ICAO/IATA codes or airport names into scan targets, using
// the live airportIconData. depId = the airport's Id (works for ANY airport, owned or not).
function am4ExpResolveCandidates(text) {
    var aid = window.airportIconData || [];
    var byIcao = {}, byIata = {};
    aid.forEach(function (a) {
        if (a.icao) byIcao[String(a.icao).toUpperCase()] = a;
        if (a.iata) byIata[String(a.iata).toUpperCase()] = a;
    });
    var out = [], seen = {};
    (text || '').split(/[,\n;]+/).forEach(function (tok) {
        tok = tok.trim(); if (!tok) return;
        var up = tok.toUpperCase();
        var a = byIcao[up] || byIata[up] || null;
        if (!a) {
            var low = tok.toLowerCase();
            for (var i = 0; i < aid.length; i++) {
                if (aid[i].name && aid[i].name.toLowerCase().indexOf(low) !== -1) { a = aid[i]; break; }
            }
        }
        if (a && !seen[a.Id]) {
            seen[a.Id] = true;
            out.push({ id: String(a.Id), name: '★ ' + (a.icao || a.iata || '') + ' ' + (a.name || '').slice(0, 28) + ' (candidate)', candidate: true });
        }
    });
    return out;
}

function am4ExpReadCfgFromPanel() {
    var cfg = am4ExpLoadCfg();
    document.querySelectorAll('#am4ExplorerPanel [data-exp-key]').forEach(function (inp) {
        var key = inp.getAttribute('data-exp-key');
        if (key === 'seatStrategy') { cfg.seatStrategy = inp.value; return; }
        if (key === 'cargoStrategy') { cfg.cargoStrategy = inp.value; return; }
        var n = Number(inp.value);
        if (isFinite(n)) cfg[key] = n;
    });
    am4ExpSaveCfg(cfg);
    return am4ExpLoadCfg(); // re-load so clamping is applied
}

function am4ExpUpdateEta() {
    var el = document.getElementById('am4ExpEta');
    if (!el) return;
    var cfg = am4ExpLoadCfg();
    var hubs = am4ExpSelectedHubs();
    var useCache = document.getElementById('am4ExpUseCache');
    var cache = am4ExpLoadCache();
    var toScan = hubs.filter(function (h) { return !(useCache && useCache.checked && cache[am4ExpCacheKey(h.id, cfg)]); });
    var perHubSec = Math.round((am4ExpMeta.countries.length || 0) * cfg.throttleMs / 1000);
    var totalSec = toScan.length * perHubSec;
    var mins = Math.floor(totalSec / 60), secs = totalSec % 60;
    el.innerHTML = hubs.length === 0 ?'Select at least one hub.' :
        ('Selected: ' + hubs.length + ' hubs &middot; to scan: ' + toScan.length + ' (rest cached) &middot; ~' + perHubSec +
         's/hub &middot; ETA ~' + (mins ? mins + 'm ' : '') + secs + 's');
}

function am4ExpSetProg(msg, pct) {
    var p = document.getElementById('am4ExpProg');
    if (p) p.innerText = msg;
    if (typeof pct === 'number') { var f = document.getElementById('am4ExpBarFill'); if (f) f.style.width = Math.max(0, Math.min(100, pct)) + '%'; }
}

function am4ExpRefreshScoringDisplay() {
    var panel = document.getElementById('am4ExplorerPanel');
    if (!panel) return;
    var cfg = am4ExpLoadCfg();
    var body = document.getElementById('am4ExpScoringBody');
    if (body) {
        body.innerHTML = am4ExpScoringModeHTML(cfg);
        am4ExpBindScoringInputs(body);
    }
    panel.querySelectorAll('[data-exp-key]').forEach(function (inp) {
        if (inp.closest('#am4ExpScoringBody')) return;
        var key = inp.getAttribute('data-exp-key');
        if (key === 'seatStrategy' || key === 'cargoStrategy') return;
        if (cfg[key] != null && inp.type === 'number') inp.value = cfg[key];
    });
    var ceil = document.getElementById('am4ExpCeil');
    if (ceil) ceil.innerHTML = am4ExpCeilText(cfg);
    if (am4ExpMeta && am4ExpMeta.hubs) am4ExpRenderHubList(am4ExpMeta.hubs, am4ExpLoadCache(), cfg);
    am4ExpUpdateEta();
}

function am4ExpStartScan() {
    if (am4ExpScanning) { am4ExpSetProg('Already scanning…'); return; }
    if (typeof am4StratEnsurePossibleN === 'function') am4StratEnsurePossibleN();
    var cfg = am4ExpReadCfgFromPanel();
    if (cfg.bandPossible === false) {
        am4ExpSetProg('This strategy N is beyond the plane\'s range. Open 🎯 Strategy and pick the max-range N, then scan again.');
        return;
    }
    if (am4AircraftIsCargo()) {
        if (!(am4AircraftCargoKg() > 0) && ((am4AircraftCargoSplit().l + am4AircraftCargoSplit().h) < 1)) {
            am4ExpSetProg('Blocked: cargo capacity is unread for ' + am4AircraftName() + '. Open ✈ Fleet, re-select the freighter, set Large/Heavy holds, then scan again.');
            return;
        }
    } else if (!(cfg.seats > 0)) {
        am4ExpSetProg('Blocked: seat capacity is 0 for ' + am4AircraftName() + '. Wait for auto profile prefetch, or open ✈ Fleet and re-select the type, then scan again.');
        return;
    }
    if (cfg.seats <= 40 && am4AircraftRangeKm() >= 3500 && !am4AircraftIsCargo()) {
        am4AircraftSanitizeSeats(am4AircraftProfile());
        cfg.seats = am4AircraftSeats();
        if (!(cfg.seats > 40)) {
            am4ExpSetProg('Blocked: seat capacity still looks corrupt (' + cfg.seats + ') for ' + am4AircraftName() + '. Re-select the type in Fleet/Explorer so the order page is re-read.');
            return;
        }
    }
    var hubs = am4ExpSelectedHubs();
    if (!hubs.length) { am4ExpSetProg('Select at least one hub first.'); return; }
    var useCache = document.getElementById('am4ExpUseCache');
    var totalHubs = hubs.length, doneHubs = 0;
    am4ExpSetProg('Starting…', 0);
    am4ExpScan(hubs, cfg, !!(useCache && useCache.checked), {
        onBusy: function () { am4ExpSetProg('A scan is already running.'); },
        onHubStart: function (hub, i, n) { am4ExpSetProg('Hub ' + (i + 1) + '/' + n + ': ' + hub.name + ' …'); },
        onCountry: function (i, n, country, hub) {
            var within = (i / n) / totalHubs;
            var hubName = (hub && hub.name) ? hub.name : '';
            am4ExpSetProg('Hub ' + (doneHubs + 1) + '/' + totalHubs + ': ' + hubName +
                ' · country ' + i + '/' + n + (country ? (' (' + country + ')') : ''),
                (doneHubs / totalHubs + within) * 100);
        },
        onHubDone: function (res, i, n, fromCache) {
            doneHubs++;
            am4ExpSetProg('✓ ' + res.hubName + ': ' + res.goodCount + ' good (' + res.built + ' built)' + (fromCache ?' [cache]' : '') + ' — ' + doneHubs + '/' + totalHubs, doneHubs / totalHubs * 100);
        },
        onCancel: function () { am4ExpSetProg('Cancelled.'); },
        onDone: function (results) {
            var hubsN = Object.keys(results).length, good = 0, built = 0;
            Object.keys(results).forEach(function (k) { good += results[k].goodCount; built += results[k].built; });
            am4ExpSetProg('Done. ' + hubsN + ' hubs · ' + good + ' good routes · ' + built + ' built.', 100);
            am4ExpRenderHubList(am4ExpMeta.hubs, am4ExpLoadCache(), cfg);
            am4ExpOpenResultsTab();
            if (typeof am4FleetOnPlaneSelect === 'function' && document.getElementById('am4RtePlane')) {
                am4FleetOnPlaneSelect();
            }
        }
    });
}

// ================= Research Explorer results tab (self-contained HTML) ==========
function am4ExpFmt(n) { return (n == null ? 0 : Math.round(n)).toLocaleString(); }

function am4ExpHubRouteRows(res) {
    // Key each row to (hub, destination) so the results tab can live-match it against the
    // build queue (window.opener.AM4Build) and show a"🏗 ordered/building/routing" badge —
    // the same idea as the"✓ built ×N" flown-plane indicator, but for a build in progress.
    var hubKey = String(res.hubName || '').split(',')[0].trim().toLowerCase();
    return res.good.map(function (g) {
        //"x N" = how many A380s currently fly this exact route (the user runs e.g. Addis->KSFO x2).
        var n = g.planes || (g.built ? 1 : 0);
        var cnt = g.built
            ? (n >= 2
                ? " <span title='" + n +" aircraft on this route' style='color:#38bdf8;font-weight:bold;'>&times;" + n +"</span>" 
                :" <span title='1 aircraft on this route' style='color:#64748b;'>&times;1</span>")
            : "" ;
        var built = g.built
            ? "<span style='color:#10b981;font-weight:bold;'>&#10003; built</span>" + cnt
            :"<span style='color:#f59e0b;'>&mdash; not built</span>" ;
        var pref = g.preferred ? "<span title='longest routes in the band (greatest distance) — build these first' style='color:#fbbf24;'>&#9733; </span>" : "" ;
        var rowStyle = g.preferred ? " style='border-left:3px solid #fbbf24;" + (g.built ? "background:#0e1b14;" : "") +"'" 
                                   : (g.built ? " style='background:#0e1b14;'" : "");
        // Build button — calls back into the game tab (this results page is a child window;
        // window.opener is the game tab where the suite + AM4Fleet run). It pre-fills the ✈ Fleet
        // route builder for this destination (auto-picking the parked plane named for it), so you
        // just review & Create. Nothing is spent from this click alone.
        var arr = am4ExpEsc(String(g.arrId || ''));
        // The hub name has to survive a trip through a JS string inside an HTML attribute, and
        // it is ALSO the only thing that identifies the hub on the order page. Deleting the
        // characters that would break the quoting used to do both jobs at once - and broke the
        // second one:"Saint George's, Grenada" arrived as"Saint Georges, Grenada" and matched
        // nothing, so every auto-build from that hub failed with"no order-hub id" .
        // Percent-encoding is safe for the transport AND lossless, so the name that arrives is
        // the name the order page uses. (encodeURIComponent leaves' alone, hence the extra pass.) 
        var enc = function (s) { return encodeURIComponent(String(s == null ?'' : s)).replace(/'/g, '%27'); };
        var hn = enc(res.hubName || '');
        // dest label for the confirm shown IN THE RESULTS TAB (that tab has no airport dictionary)
        var destLbl = enc((String(g.pair || '').split('-')[1] || g.dest || String(g.arrId || '')));
        var cargoRow = !!(g.cargo || (g.cfg && (g.cfg.l || g.cfg.h)));
        var demandTxt = cargoRow
            ? ((g.demand && g.demand.l || 0) +" / " + (g.demand && g.demand.h || 0))
            : (g.demand.y +" / " + g.demand.j +" / " + g.demand.f);
        var cfgTxt = cargoRow
            ? ("L" + (g.cfg.l || 0) +" H" + (g.cfg.h || 0))
            : ("Y" + g.cfg.y +" J" + g.cfg.j +" F" + g.cfg.f);
        var buildBtn = g.arrId
            ? "<button class='build-btn' onclick=\"am4ExpBuildClick('" + arr +"','" + hn +"'," +
                (cargoRow ? (g.cfg.l || 0) : (g.cfg.y || 0)) +"," +
                (cargoRow ? (g.cfg.h || 0) : (g.cfg.j || 0)) +"," +
                (cargoRow ? 0 : (g.cfg.f || 0)) +",'" + destLbl +"'," + (cargoRow ? 1 : 0) +")\">Build &#9992;</button>" 
            :"<span class='dim'>&mdash;</span>" ;
        return"<tr" + rowStyle +">" +
            "<td class='mono'>" + pref + am4ExpEsc(g.pair) +"</td>" +
            "<td>" + am4ExpEsc(g.dest) +"</td>" +
            "<td class='num'>" + am4ExpFmt(g.km) +"</td>" +
            "<td class='num dim'>" + (g.deps != null ? g.deps : '?') +"</td>" +
            "<td class='num dim'>" + demandTxt +"</td>" +
            "<td class='num'>" + cfgTxt +"</td>" +
            "<td class='num'>" + g.fillPct +"%</td>" +
            "<td class='num money'>$" + am4ExpFmt(g.revPerDay) +"</td>" +
            "<td class='num'>" + built +"<span class='am4-bq' data-bk='" + am4ExpEsc(hubKey + '~' + String(g.arrId || '')) +"'></span></td>" +
            "<td class='num'>" + buildBtn +"</td>" +
        "</tr>";
    }).join('');
}

function am4ExpResultsHTML(results, cfg) {
    var hubs = Object.keys(results).map(function (k) { return results[k]; })
        .filter(function (r) { return r && r.good; });
    // rank: most good routes first, then most total potential $/day
    hubs.forEach(function (r) { r._total = r.good.reduce(function (s, g) { return s + g.revPerDay; }, 0); r._best = r.good.length ? r.good[0].revPerDay : 0; });
    hubs.sort(function (a, b) { return (b.goodCount - a.goodCount) || (b._total - a._total); });

    var totGood = 0, totBuilt = 0, totPot = 0;
    hubs.forEach(function (r) { totGood += r.goodCount; totBuilt += r.built; totPot += r._total; });
    var totRemaining = totGood - totBuilt;

    // Plane-count roll-up for the built routes shown (the user runs some routes with 2 A380s).
    var totPlanes = 0, doubledRoutes = 0;
    hubs.forEach(function (r) { r.good.forEach(function (g) { if (g.built) { var n = g.planes || 1; totPlanes += n; if (n >= 2) doubledRoutes++; } }); });
    var fmU = am4ExpBuildFlownMap();
    var unresolvedPlanes = (fmU && fmU.unresolved) || 0;

    var cargoMode = !!cfg.cargo;
    var stratLabel = cargoMode
        ? ('Cargo L/H ' + ((cfg.cargoSplit && cfg.cargoSplit.l) || '?') + '/' + ((cfg.cargoSplit && cfg.cargoSplit.h) || '?'))
        : ((cfg.seatStrategy === 'economy-first') ?'Economy-first (Y&rarr;J&rarr;F)' : 'Revenue-optimal (J&rarr;Y&rarr;F)');
    var when = new Date().toLocaleString();
    var stratN = cfg.flightsPerDay || 2;

    var rankRows = hubs.map(function (r, i) {
        return"<tr>" +
            "<td class='num dim'>" + (i + 1) +"</td>" +
            "<td><a href='#hub" + am4ExpEsc(r.hubId) +"'>" + am4ExpEsc(r.hubName) +"</a></td>" +
            "<td class='num'><b>" + r.goodCount +"</b></td>" +
            "<td class='num'>" + r.built +"</td>" +
            "<td class='num' style='color:#f59e0b;'>" + (r.goodCount - r.built) +"</td>" +
            "<td class='num money'>$" + am4ExpFmt(r._best) +"</td>" +
            "<td class='num money'>$" + am4ExpFmt(r._total) +"</td>" +
            "<td class='num dim'>" + (r.flownFromHub || 0) +"</td>" +
        "</tr>";
    }).join('');

    var hubBlocks = hubs.map(function (r) {
        return"<details id='hub" + am4ExpEsc(r.hubId) +"'" + (r.goodCount > 0 && hubs.length <= 3 ?' open' : '') +">" +
            "<summary><b>" + am4ExpEsc(r.hubName) +"</b> &mdash; " + r.goodCount +" good, " +
            "<span style='color:#f59e0b;'>" + (r.goodCount - r.built) +" remaining</span>, " + r.built +" built &middot; " +
            "$" + am4ExpFmt(r._total) +"/day potential</summary>" +
            (r.goodCount === 0
                ? "<p class='dim' style='padding:8px 12px;'>No good routes (runway &ge; " + am4ExpFmt(cfg.minRwy) +" ft, band " + am4ExpFmt(cfg.bandLo) +"&ndash;" + am4ExpFmt(cfg.bandHi) +" km, fills &ge; " + cfg.goodFillPct +"% at " + stratN +" flights/24h) in the scanned countries.</p>" 
                :"<table class='routes'><thead><tr>" +
                    "<th>Route</th><th>Destination</th><th class='num'>km</th><th class='num'>Dep/day</th><th class='num'>" +
                    (cargoMode ? "Demand L/H" :"Demand Y/J/F") +"</th>" +
                    "<th class='num'>" + (cargoMode ? "Load L/H" :"Seat config") +"</th><th class='num'>Fill</th><th class='num'>$/day</th><th class='num'>Status</th><th class='num'>Build</th>" +
                    "</tr></thead><tbody>" + am4ExpHubRouteRows(r) +"</tbody></table>") +
        "</details>";
    }).join('');

    var css = [
        "*{box-sizing:border-box}",
        "body{margin:0;background:#0b0f16;color:#e2e8f0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;padding:24px;}",
        "h1{font-size:20px;color:#38bdf8;margin:0 0 4px 0;letter-spacing:1px;}",
        ".sub{color:#64748b;font-size:12px;margin-bottom:18px;line-height:1.6;}",
        ".sub b{color:#94a3b8;}",
        ".cards{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:22px;}",
        ".card{background:#141a24;border:1px solid #24303f;border-radius:10px;padding:14px 18px;min-width:150px;}",
        ".card .n{font-size:24px;font-weight:bold;}",
        ".card .l{font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;margin-top:2px;}",
        "table{border-collapse:collapse;width:100%;font-size:13px;}",
        "th,td{padding:6px 10px;text-align:left;border-bottom:1px solid #1e293b;}",
        "th{color:#94a3b8;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.4px;position:sticky;top:0;background:#0b0f16;}",
        ".build-btn{cursor:pointer;border:none;border-radius:5px;padding:4px 10px;font-size:11px;font-weight:bold;background:#1d4ed8;color:#dbeafe;font-family:inherit;white-space:nowrap;}",
        ".build-btn:hover{background:#2563eb;}",
        ".num{text-align:right;} .dim{color:#64748b;} .mono{font-family:monospace;color:#cbd5e1;} .money{color:#10b981;font-weight:600;}",
        "a{color:#38bdf8;text-decoration:none;} a:hover{text-decoration:underline;}",
        "h2{font-size:15px;color:#f59e0b;margin:26px 0 8px 0;border-top:1px solid #24303f;padding-top:16px;}",
        "details{background:#101722;border:1px solid #1e293b;border-radius:8px;margin:8px 0;overflow:hidden;}",
        "summary{cursor:pointer;padding:10px 14px;font-size:13px;user-select:none;}",
        "summary:hover{background:#151d29;}",
        "table.routes{margin:0;} table.routes th{background:#0e141d;top:0;}",
        ".rank-wrap{max-height:none;overflow:auto;border:1px solid #24303f;border-radius:8px;}",
        ".note{color:#64748b;font-size:11px;margin-top:20px;line-height:1.6;border-top:1px solid #1e293b;padding-top:12px;}"
    ].join('');

    var body = [
        "<h1>&#128269; AM4 Research Explorer</h1>",
        "<div class='sub'>Generated <b>" + am4ExpEsc(when) +"</b> &middot; Seats: <b>" + stratLabel +"</b> &middot; " +
            "Strategy <b>" + stratN +" flights/24h</b> &middot; band <b>" + am4ExpFmt(cfg.bandLo) +"&ndash;" + am4ExpFmt(cfg.bandHi) +" km</b> " +
            "(" + am4ExpFmt(cfg.cruiseKph) +" kph &times;1.5 = " + am4ExpFmt(Math.round(cfg.realSpeed)) +" kph real) &middot; " +
            "demand&divide;" + stratN +" per flight &middot; $/day = rev&times;" + stratN +" &middot; Min runway <b>" + am4ExpFmt(cfg.minRwy) +" ft</b> &middot; Fill &ge; <b>" + cfg.goodFillPct +"%</b></div>" ,
        "<div class='cards'>",
        "<div class='card'><div class='n'>" + hubs.length +"</div><div class='l'>Hubs analysed</div></div>" ,
        "<div class='card'><div class='n'>" + am4ExpFmt(totGood) +"</div><div class='l'>Good routes</div></div>" ,
        "<div class='card'><div class='n' style='color:#10b981;'>" + am4ExpFmt(totBuilt) +"</div><div class='l'>Already built" + (doubledRoutes > 0 ? " &middot; " + doubledRoutes +" with &times;2+" : "") +"</div></div>" ,
        "<div class='card'><div class='n' style='color:#f59e0b;'>" + am4ExpFmt(totRemaining) +"</div><div class='l'>Remaining</div></div>" ,
        "<div class='card'><div class='n money'>$" + am4ExpFmt(totPot) +"</div><div class='l'>Total $/day potential</div></div>" ,
        "</div>",
        "<h2>Hub ranking &mdash; most good " + am4ExpEsc(am4AircraftName()) +" routes first</h2>" ,
        "<div class='rank-wrap'><table><thead><tr>" +
            "<th class='num'>#</th><th>Hub</th><th class='num'>Good</th><th class='num'>Built</th>" +
            "<th class='num'>Remaining</th><th class='num'>Best $/day</th><th class='num'>Total $/day</th><th class='num'>Current routes</th>" +
            "</tr></thead><tbody>" + rankRows +"</tbody></table></div>" ,
        "<h2>Routes per hub</h2>",
        hubBlocks,
        "<div class='note'>&quot;Good route&quot; = runway &ge; " + am4ExpFmt(cfg.minRwy) +" ft, one-way distance in the strategy band <b>" + am4ExpFmt(cfg.bandLo) +"&ndash;" + am4ExpFmt(cfg.bandHi) +
            " km</b> (so the plane does exactly <b>" + stratN +" flights/24h</b>), and the demand&divide;" + stratN +" seat split fills the " + cfg.seats +"-seat " + am4ExpEsc(am4AircraftName()) +" to &ge; " + cfg.goodFillPct +"%. " +
            "<b>&#9733; = the longest routes in the band</b> (top third by distance = greatest distance, highest ticket price) &mdash; those are sorted to the top and flagged; unstarred in-band routes are shorter and lower priority. " +
            "<b>Only airports meeting the min-runway filter are shown</b> &mdash; a hub&rsquo;s routes flown by other types (shorter runways) do not appear here. " +
            "<b>Flights/24h = your chosen strategy N</b> (flight time/leg = dist&nbsp;/&nbsp;(" + am4ExpFmt(cfg.cruiseKph) +"&nbsp;kph&times;1.5); N legs fit iff dist &le; 24&times;realSpeed/N &mdash; AM4's own formula), and the daily demand is divided by N per flight. " +
            "Seat weights Y=1 / J=2 / F=3; ticket price Y=0.4&times;km+170, J=0.8&times;km+560, F=1.2&times;km+1200. " +
            "<b>&quot;Built&quot;</b> is detected from the live map: a route counts as built when your airline already flies from this hub to that destination (highlighted green). " +
            "<b>&times;N</b> after &quot;built&quot; = how many " + am4ExpEsc(am4AircraftName()) +"s currently fly that exact route &mdash; counted from your live fleet (a 2nd plane on the same airport-pair is matched via its route name, e.g. <i>KSFO</i> + <i>KSFO-2</i>). " +
            (unresolvedPlanes > 0 ? "<b>Note:</b> " + unresolvedPlanes +" aircraft with no route-name could not be attributed to a specific route, so a doubled route flown by two <i>un-named</i> planes may show &times;1 instead of &times;2. " : "") +
            "<b>&#127959; ordered / building / routing</b> next to the status = an auto-build for that exact hub&rarr;destination is queued or in progress (from the &#127959; Build Queue). It updates live and clears once the plane is routed &mdash; so you can see at a glance which routes you already queued and not order them twice. " +
            "$/day = one plane at " + stratN +" flights/day at full seat prices &mdash; before load factor, fuel, CO2 and upkeep.</div>" 
    ].join('');

    // Click handler runs IN THIS RESULTS TAB (a child window), so its confirm()/alert() are visible
    // right where the user clicks. It calls window.opener.am4ExpBuildRoute (the game tab) to enqueue.
    var clickScript ="<script>function am4ExpBuildClick(arr,hub,y,j,f,dest,cargo){var o=window.opener;" +
        "try{hub=decodeURIComponent(hub);dest=decodeURIComponent(dest);}catch(e){}" +
        "if(!(o&&!o.closed&&o.am4ExpBuildRoute)){alert('Open the game tab (the AM4 suite must be running there), then click Build again.');return;}" +
        "if(!confirm('Auto-build '+dest+ ' from '+String(hub).split(',')[0]+ '?\\n\\nQueues the full chain: order a named + configured " + String(am4AircraftName()).replace(/'/g, '') + ", then after delivery modify CO2/Speed/Fuel, then create the route.\\n\\nIt runs ONLY when you tick Auto-run in the game tab Build Queue.\\n\\nQueue it now?')){return;}" +
        "try{o.am4ExpBuildRoute(arr,hub,y,j,f,!!cargo);}catch(e){alert('Build failed: '+e);return;}try{o.focus();}catch(e){}" +
        "setTimeout(am4RenderBQ,300);setTimeout(am4RenderBQ,1200);setTimeout(am4RenderBQ,3000);" +
        "alert('Queued '+dest+ '. Now switch to the game tab, open the Build Queue button, and tick Auto-run to start.');}" +
        // Live build-queue status per route: reads window.opener.AM4Build.queue() and fills each
        // row's .am4-bq span with "🏗 ordered/building/routing (×N)" so a queued order shows up
        // right in the results, matched by hub+destination. Refreshes on load + every 3s.
        "function am4RenderBQ(){try{var o=window.opener;var q=(o&&!o.closed&&o.AM4Build&&o.AM4Build.queue)?o.AM4Build.queue():null;if(!q)return;" +
        "var A={order: 'ordered',await_delivery: 'ordered',modify: 'building',await_modify: 'building',route: 'routing',done: 'built \\u2713'};" +
        "var map={};for(var i=0;i<q.length;i++){var j=q[i];if(!j||!A[j.state])continue;var hk=String(j.hubName|| '').split(',')[0].trim().toLowerCase();var key=hk+ '~'+String(j.destId|| '');if(!map[key])map[key]={n:0,st:j.state};map[key].n++;map[key].st=j.state;}" +
        "var s=document.querySelectorAll('.am4-bq');for(var k=0;k<s.length;k++){var bk=s[k].getAttribute('data-bk')|| '';var m=map[bk];" +
        "if(m){s[k].innerHTML=\" <span title='auto-build queued / in progress (from the game-tab Build Queue)' style='color:#fbbf24;font-weight:bold;'>\\ud83c\\udfd7 \"+A[m.st]+(m.n>1?' \\u00d7'+m.n: '')+\"</span>\";}else{s[k].innerHTML='';}}}catch(e){}}" +
        "am4RenderBQ();setInterval(am4RenderBQ,3000);</script>" ;
    return"<!doctype html><html><head><meta charset='utf-8'><title>AM4 Research Explorer</title><style>" + css +"</style></head><body>" + body + clickScript +"</body></html>" ;
}

function am4ExpFillInlineResults(results, cfg) {
    var box = document.getElementById('am4ExpInlineResults');
    if (!box) return;
    results = results || am4ExpResults;
    cfg = cfg || am4ExpLoadCfg();
    if (!results || !Object.keys(results).length) {
        box.style.display = 'none';
        box.innerHTML = '';
        return;
    }
    var hubs = Object.keys(results).map(function (k) { return results[k]; })
        .filter(function (r) { return r && r.good; });
    hubs.sort(function (a, b) { return (b.goodCount - a.goodCount) || ((b.remaining || 0) - (a.remaining || 0)); });
    var rows = [];
    hubs.forEach(function (r) {
        var unbuilt = (r.good || []).filter(function (g) { return g && g.arrId && !g.built; });
        if (!unbuilt.length && !(r.good && r.good.length)) {
            var why = '';
            if (r.stats) {
                var capLabel = (cfg.cargo || r.cargo)
                    ? ((r.cargoKg || cfg.cargoKg || 0).toLocaleString() + ' kg')
                    : ((r.seats || cfg.seats || 0) + ' seats');
                why = ' · saw ' + (r.destinationsSeen || 0) + ' dests, ' + (r.stats.inBand || 0) + ' in band, ' +
                    (r.stats.fillFail || 0) + ' failed fill ' + cfg.goodFillPct + '% of ' + capLabel +
                    ', ' + (r.stats.zeroRev || 0) + ' zero cargo/pax load, ' +
                    (r.stats.rwyFail || 0) + ' failed rwy ' + (r.minRwy != null ? r.minRwy : cfg.minRwy) + ' ft' +
                    ((cfg.cargo || r.cargo) && r.stats.bestFill != null
                        ? (' · best fill ' + r.stats.bestFill + '% · best daily demand ' +
                            Number(r.stats.bestDemand || 0).toLocaleString() + ' (L=Y×500, H=J×1000)')
                        : '');
            }
            rows.push("<tr><td colspan='5' class='dim'>" + am4ExpEsc(r.hubName) +" — 0 good in " +
                am4ExpFmt(cfg.bandLo) +"&ndash;" + am4ExpFmt(cfg.bandHi) +" km" + why +"</td></tr>");
            return;
        }
        unbuilt.slice(0, 40).forEach(function (g) {
            var destLbl = String(g.pair || '').split('-')[1] || g.dest || String(g.arrId || '');
            var cfgTxt = (g.cargo || (g.cfg && (g.cfg.l || g.cfg.h)))
                ? ("L" + ((g.cfg && g.cfg.l) || 0) +"/H" + ((g.cfg && g.cfg.h) || 0))
                : ("Y" + (g.cfg && g.cfg.y || 0) +"/J" + (g.cfg && g.cfg.j || 0) +"/F" + (g.cfg && g.cfg.f || 0));
            rows.push("<tr>" +
                "<td>" + am4ExpEsc((r.hubName || '').split(',')[0]) +"</td>" +
                "<td>" + (g.preferred ? "★ " : "") + am4ExpEsc(destLbl) +"</td>" +
                "<td>" + am4ExpFmt(g.km) +"</td>" +
                "<td>" + cfgTxt +"</td>" +
                "<td><button type='button' class='am4-exp-build' data-am4-build='1' data-arr='" + am4ExpEsc(String(g.arrId)) +
                "' data-hub='" + encodeURIComponent(r.hubName || '') +
                "' data-y='" + ((g.cargo ? (g.cfg && g.cfg.l) : (g.cfg && g.cfg.y)) || 0) +
                "' data-j='" + ((g.cargo ? (g.cfg && g.cfg.h) : (g.cfg && g.cfg.j)) || 0) +
                "' data-f='" + (g.cargo ? 0 : ((g.cfg && g.cfg.f) || 0)) +
                "' data-cargo='" + (g.cargo ?'1' : '0') +
                "' data-dest='" + encodeURIComponent(destLbl) +
                "'>Build ✈</button></td></tr>");
        });
        if (unbuilt.length > 40) {
            rows.push("<tr><td colspan='5' class='dim'>" + (unbuilt.length - 40) +" more from " +
                am4ExpEsc((r.hubName || '').split(',')[0]) +" — open the results tab for the full list</td></tr>");
        }
        if (!unbuilt.length && r.good && r.good.length) {
            rows.push("<tr><td colspan='5' class='dim'>" + am4ExpEsc(r.hubName) +" — " + r.good.length +
                " good, all already built</td></tr>");
        }
    });
    box.style.display = 'block';
    box.innerHTML ="<h4>RESULTS in this tab · Strategy " + (cfg.flightsPerDay || '?') +
        " · " + am4ExpFmt(cfg.bandLo) +"&ndash;" + am4ExpFmt(cfg.bandHi) +" km · click Build ✈ to queue</h4>" +
        "<table><thead><tr><th>Hub</th><th>Dest</th><th>km</th><th>Seats</th><th></th></tr></thead><tbody>" +
        (rows.length ? rows.join('') :"<tr><td colspan='5' class='dim'>No unbuilt good routes. Rescan after the strategy band is a real window.</td></tr>") +
        "</tbody></table>";
}

function am4ExpOnInlineBuildClick(ev) {
    var b = ev.target && ev.target.closest ? ev.target.closest('[data-am4-build]') : null;
    if (!b) return;
    ev.preventDefault();
    var arr = b.getAttribute('data-arr');
    var hub = '';
    var dest = '';
    try { hub = decodeURIComponent(b.getAttribute('data-hub') || ''); } catch (e1) { hub = b.getAttribute('data-hub') || ''; }
    try { dest = decodeURIComponent(b.getAttribute('data-dest') || ''); } catch (e2) { dest = b.getAttribute('data-dest') || ''; }
    var y = parseInt(b.getAttribute('data-y'), 10) || 0;
    var j = parseInt(b.getAttribute('data-j'), 10) || 0;
    var f = parseInt(b.getAttribute('data-f'), 10) || 0;
    var cargo = b.getAttribute('data-cargo') === '1';
    if (!arr) return;
    if (!confirm('Auto-build ' + dest + ' from ' + String(hub).split(',')[0] +
        '?\n\nQueues the full chain: order a named + configured ' + am4AircraftName() +
        ', then after delivery modify CO2/Speed/Fuel, then create the route.\n\nIt runs ONLY when you tick Auto-run in the Build Queue.\n\nQueue it now?')) {
        return;
    }
    am4ExpBuildFromResults(arr, hub, y, j, f, cargo);
}

function am4ExpOpenResultsTab() {
    var results = am4ExpResults;
    if (!results || !Object.keys(results).length) { am4ExpSetProg('No results yet - run a scan first.'); return; }
    var cfg = am4ExpLoadCfg();
    am4ExpFillInlineResults(results, cfg);
    var html = am4ExpResultsHTML(results, cfg);
    var w = window.open('','am4ExplorerResults');
    if (!w) {
        am4ExpSetProg('Results are in this panel (the extra tab was blocked). Use Build ✈ here, then open the Build Queue.');
        return;
    }
    w.document.open();
    w.document.write(html);
    w.document.close();
    try { w.focus(); } catch (e) { /* ignore */ }
    am4ExpSetProg('Results opened in a tab. The same unbuilt list is also in this panel.');
}

// Bridge from the Explorer results tab's "Build" button back into the game tab (the results page is
// a child window → its buttons call window.opener.am4ExpBuildRoute(...)). This ENQUEUES the full
// auto-build chain for the route (order named+configured → await delivery → modify CO2/Speed/Fuel →
// route). It spends NOTHING on click; the chain runs from the 🏗 Build Queue only while Auto-run is ON.
// If a parked A380 already named for the dest exists, the chain skips ordering and just modifies+routes it.
function am4ExpBuildFromResults(arrId, hubName, cy, cj, cf, cargoFlag) {
    var air = (typeof am4FleetResolveAirport === 'function') ? am4FleetResolveAirport(String(arrId)) : null;
    if (!air) { console.log('[AM4 Bot Log] Build: destination not found ' + arrId); return; }
    var destIcao = air.icao || air.iata || String(air.Id);
    var cargo = !!(cargoFlag || (typeof am4AircraftIsCargo === 'function' && am4AircraftIsCargo()));
    var e = Number(cy) || 0, b = Number(cj) || 0, f = Number(cf) || 0;
    if (!cargo) {
        if (e < 1) e = 1; if (b < 1) b = 1; if (f < 1) f = 1;
        var cap = am4AircraftSeats();
        var expCfg = (typeof am4ExpLoadCfg === 'function') ? am4ExpLoadCfg() : {};
        var topOrder = (expCfg.seatStrategy === 'economy-first') ? ['y','j','f' ] : ['f','j','y' ];
        var norm = am4PaxSeatNormalize(e, b, f, cap, topOrder);
        e = norm.y; b = norm.j; f = norm.f;
    }
    var proceed = function () {
        var hubOrderId = (typeof am4FleetOrderHubIdByName === 'function') ? am4FleetOrderHubIdByName(hubName) : null;
        var job = { destId: String(air.Id), destIcao: destIcao, hubName: hubName || '', hubOrderId: hubOrderId };
        if (cargo) {
            var p = am4AircraftProfile();
            job.cargo = true;
            job.cargoAft = p.cargoAft || 0;
            job.cargoFwd = p.cargoFwd || 0;
            job.cargoAftH = p.cargoAftH || 0;
            job.cargoFwdH = p.cargoFwdH || 0;
            job.e = 0; job.b = 0; job.f = 0;
        } else {
            job.e = e; job.b = b; job.f = f; job.cargo = false;
        }
        am4BuildEnqueue(job);
        var qp = am4BuildQueuePanel();
        if (qp) qp.style.display = 'block';
        am4BuildRenderQueue();
        var fleet = document.getElementById('am4FleetPanel') || (typeof am4FleetBuildPanel === 'function' ? am4FleetBuildPanel() : null);
        if (fleet) fleet.style.display = 'block';
        try { window.focus(); } catch (e2) { /* ignore */ }
    };
    // Ensure the order info (hub map + unit cost) is loaded before we build the job.
    if (am4FleetOrderInfo && am4FleetOrderInfo.hubs && am4FleetOrderInfo.hubs.length &&
        am4FleetOrderInfo.typeId === am4AircraftTypeId()) proceed();
    else if (typeof am4FleetFetchOrderInfo === 'function') am4FleetFetchOrderInfo().then(function (info) { am4FleetOrderInfo = info; proceed(); });
    else proceed();
}
// Exposed as a plain window global so the results-tab child window can call window.opener.am4ExpBuildRoute
window.am4ExpBuildRoute = am4ExpBuildFromResults;

if (window.AM4Explorer) {
    window.AM4Explorer.resultsHTML = am4ExpResultsHTML;
    window.AM4Explorer.openResultsTab = am4ExpOpenResultsTab;
    window.AM4Explorer.fillInlineResults = am4ExpFillInlineResults;
    window.AM4Explorer.injectButton = am4ExpInjectButton;
    window.AM4Explorer.buildPanel = am4ExpBuildPanel;
    window.AM4Explorer.buildFromResults = am4ExpBuildFromResults;
}


//================================================================================
// Part 15: FLEET ASSISTANT (Phase B — B1 fleet state + B3 plane buyer + B5 route builder + B5b modify)
//
// B1 (read-only): reads fleet.php (per-type counts) + fleet.php?type=2 (A380 Routed /
// Parked / Maintenance) + routes.php (Routes/Parked/Pending) and the A380 order page
// (hangar headroom maxAcOrder), so you can see how many A380s are parked/unassigned
// and how much hangar room is left before buying more.
//
// B3 (spends money — MANUAL + hard-gated): orders A380-800 (id 2) with the RR Trent
// 972 (engine 7) to a chosen hub via the verified ac_order_do.php contract
// (GAME_CONTRACTS §9). It is deliberately NOT an auto-loop: every order is a button
// press with a confirm dialog, capped by fleetBuyerMaxPerBuy and the fail-closed
// fleetBuyerSpendCap, and only the acting tab may buy. The purchase is verified by
// re-reading routes.php Pending afterwards.
//
// B5 (spends a small route fee — MANUAL + hard-gated): assigns a PARKED A380 to a
// destination and creates the route via the verified new_route_info.php?mode=do
// contract (GAME_CONTRACTS §10). Pick a parked plane + destination →"Check route" 
// (read-only: validates range/demand/seats and shows the hub→dest, per-flight demand vs
// the plane's seat fill) → "Create route" fires behind a confirm() and every fail-closed
// gate. It sends the plane's OWN installed seat config (no reconfig cost); a plane with a
// 0-seat class is blocked because the game requires all three classes > 0.
//
// B5b (spends real money + a modify timer — MANUAL + hard-gated): reconfigures a parked
// A380's seats (the fix that makes a 600/0/0 plane routable) and/or applies the
// CO2/Speed/Fuel upgrades via the verified maint_plan_do.php?mode=do modify contract
// (GAME_CONTRACTS §12 — Maintenance → Plan → Modify). Pick a parked plane → adjust seats
// and/or tick upgrades (already-applied ones are ticked + locked) → live cost preview →
//"Apply modify" behind a confirm() and every fail-closed gate. mod1=CO2/mod2=Speed/mod3=Fuel.
//
// NOTE (2026-08-12/13): the buy AND route-create paths could NOT be live-tested from here
// — the harness auto-mode classifier blocks an automated mutation. The read-only sides
// (B1, and B5's parked-list + route-config readers) are fully live-verified; treat your
// FIRST real order/route as the live test (buy → Pending +N; route → plane leaves Parked).
//================================================================================
function am4FleetEsc(s) { return (typeof am4EscapeHtml === 'function') ? am4EscapeHtml(s) : String(s == null ?'' : s); }

function am4FleetParseSummary(html) {
    var b = document.createElement('div'); b.innerHTML = html;
    var text = (b.innerText || '').replace(/\s+/g,' ');
    var types = [], re = /([A-Za-z0-9\-\/ .]+?)Number of aircraft:\s*(\d+)/g, m;
    while ((m = re.exec(text)) !== null) types.push({ label: m[1].trim().slice(-40), count: parseInt(m[2], 10) });
    return types;
}

// Each A380 block in fleet.php?type=2 ends with a status token after"F class: N" .
function am4FleetParseA380(html) {
    var b = document.createElement('div'); b.innerHTML = html;
    var text = (b.innerText || '').replace(/\s+/g,' ');
    var s = { routed: 0, parked: 0, maintenance: 0, other: 0, total: 0 };
    var re = /F class:\s*\d+\s*(Routed|Parked|Maintenance|In flight|Grounded|En route)?/g, m;
    while ((m = re.exec(text)) !== null) {
        s.total++;
        var st = (m[1] || '').trim();
        if (st === 'Routed') s.routed++;
        else if (st === 'Parked') s.parked++;
        else if (st === 'Maintenance') s.maintenance++;
        else s.other++;
    }
    return s;
}

function am4FleetParseRoutesHeader(html) {
    var b = document.createElement('div'); b.innerHTML = html;
    var m = (b.innerText || '').replace(/\s+/g,' ').match(/Routes\((\d+)\)\s*Fleet\((\d+)\)\s*Parked\((\d+)\)\s*Pending\s*\((\d+)\)/i);
    return m ? { routes: +m[1], fleet: +m[2], parked: +m[3], pending: +m[4] } : null;
}

// Reads the A380 order page for the live hub list (order-page id space), the hangar
// headroom (maxAcOrder) and the per-plane cost (defCost). Read-only.
function am4FleetFetchOrderInfo() {
    var typeId = am4AircraftTypeId();
    return fetch('ac_orders.php?mode=detail&id=' + typeId + '&charter=0', { credentials: 'include'})
        .then(function (r) { return r.text(); })
        .then(function (html) {
            if (am4AircraftTypeId() === typeId) { am4AircraftApplyOrderPage(html, typeId); }
            var b = document.createElement('div'); b.innerHTML = html;
            var hubs = [];
            var hs = b.querySelector('#hubSelection');
            if (hs) {
                Array.prototype.forEach.call(hs.querySelectorAll('option'), function (o) {
                    hubs.push({ v: o.value, t: (o.textContent || '').trim() });
                });
            }
            var p = (am4AircraftTypeId() === typeId) ? am4AircraftProfile() : (am4AircraftLoadProfile(typeId) || am4AircraftBlank(typeId));
            var unitCost = am4AircraftParseUnitCost(html);
            if (!unitCost) unitCost = p.unitCost;
            return {
                hubs: hubs,
                maxAcOrder: p.cargo ? 1 : p.maxAcOrder,
                unitCost: unitCost,
                engine7Ok: !!(p.engines && p.engines.length),
                engines: p.engines || [],
                typeId: typeId,
                name: p.name,
                cargo: !!p.cargo
            };
        })
        .catch(function () { return { hubs: [], maxAcOrder: null, unitCost: null, engine7Ok: false, typeId: typeId }; });
}

function am4FleetReadState() {
    return Promise.all([
        fetch('fleet.php', { credentials: 'include'}).then(function (r) { return r.text(); }).catch(function () { return ''; }),
        fetch('fleet.php?type=' + am4AircraftTypeId(), { credentials: 'include'}).then(function (r) { return r.text(); }).catch(function () { return ''; }),
        fetch('routes.php', { credentials: 'include'}).then(function (r) { return r.text(); }).catch(function () { return ''; })
    ]).then(function (res) {
        return {
            byType: am4FleetParseSummary(res[0]),
            a380: am4FleetParseA380(res[1]),
            header: am4FleetParseRoutesHeader(res[2]),
            at: Date.now()
        };
    });
}

// ---- UI ----------------------------------------------------------------------
var am4FleetOrderInfo = { hubs: [], maxAcOrder: null, unitCost: null };

function am4FleetInjectButton() {
    var bar = document.getElementById('am4ControlBar');
    if (!bar || document.getElementById('am4FleetBtn')) return;
    if (typeof am4ExpInjectStyles === 'function') am4ExpInjectStyles();
    var btn = document.createElement('span');
    btn.id = 'am4FleetBtn';
    btn.title = 'AM4 Fleet Assistant - fleet state + aircraft buyer (manual, capped)';
    btn.style.cssText = 'cursor:pointer; color:#38bdf8; font-size:13px; line-height:1; padding:2px 6px; border-radius:4px; user-select:none; font-family:monospace; white-space:nowrap;';
    btn.innerText = '✈ Fleet';
    var status = document.getElementById('am4StatusBtn');
    if (status && status.parentElement === bar) bar.insertBefore(btn, status);
    else bar.appendChild(btn);
    btn.addEventListener('mouseenter', function () { btn.style.background = 'rgba(56,189,248,0.15)'; });
    btn.addEventListener('mouseleave', function () { btn.style.background = ''; });
    btn.addEventListener('click', am4FleetTogglePanel);
}

function am4FleetTogglePanel() {
    var p = document.getElementById('am4FleetPanel');
    if (p && p.style.display === 'block') { p.style.display = 'none'; return; }
    am4FleetBuildPanel().style.display = 'block';
}

function am4FleetBuildPanel() {
    var old = document.getElementById('am4FleetPanel');
    if (old) old.remove();
    var panel = document.createElement('div');
    panel.id = 'am4FleetPanel';
    panel.style.cssText = 'position:fixed; top:60px; right:20px; width:min(440px, calc(100vw - 24px)); max-height:84vh; overflow-y:auto; background:rgba(15,19,26,0.98); border:1px solid #34495e; border-radius:8px; color:#e2e8f0; font-family:monospace; font-size:12px; z-index:1041; padding:14px; box-shadow:0 6px 24px rgba(0,0,0,0.6); display:none;';
    panel.innerHTML =
        "<div style='display:flex; margin-bottom:6px;'><span style='flex-grow:1; font-size:13px; font-weight:bold; color:#38bdf8; letter-spacing:1px;'>✈ FLEET ASSISTANT</span>" +
        "<span id='am4FleetRefresh' title='Reload fleet state' style='cursor:pointer; color:#38bdf8; padding:0 6px;'>⟳</span>" +
        "<span id='am4FleetClose' style='cursor:pointer; color:#ef4444; font-weight:bold; padding:0 4px;'>[X]</span></div>" +
        "<div class='am4-fleet-sec' style='color:#f59e0b; font-size:11px; font-weight:bold; letter-spacing:0.5px; border-top:1px dashed #334155; padding-top:6px;'>FLEET STATE (read-only)</div>" +
        "<div id='am4FleetState' style='margin:6px 0; line-height:1.7;'>reading fleet…</div>" +
        "<div class='am4-fleet-sec' style='color:#f59e0b; font-size:11px; font-weight:bold; letter-spacing:0.5px; border-top:1px dashed #334155; padding-top:6px; margin-top:8px;'>BUY AIRCRAFT</div>" +
        "<div style='font-size:10px; color:#f87171; margin:5px 0; line-height:1.4;'>⚠ Spends in-game cash. Pick any type from your fleet or the shop. Treat your FIRST order of a new type as the test: after it, the fleet \"Pending\" count must rise by the amount you ordered.</div>" +
        "<div class='am4-exp-row' style='display:flex; justify-content:space-between; align-items:center; gap:8px; margin:5px 0;'><label style='color:#94a3b8;'>Aircraft</label><select id='am4FleetType' style='max-width:250px; background:#1e293b; border:1px solid #475569; color:#e2e8f0; border-radius:4px; padding:2px 5px; font-family:monospace; font-size:12px;'></select></div>" +
        "<div class='am4-exp-row' style='display:flex; justify-content:space-between; align-items:center; gap:8px; margin:5px 0;'><label style='color:#94a3b8;'>Engine</label><select id='am4FleetEngine' style='max-width:250px; background:#1e293b; border:1px solid #475569; color:#e2e8f0; border-radius:4px; padding:2px 5px; font-family:monospace; font-size:12px;'></select></div>" +
        "<div class='am4-exp-row' style='display:flex; justify-content:space-between; align-items:center; gap:8px; margin:5px 0;'><label style='color:#94a3b8;'>Hub</label><select id='am4FleetHub' style='max-width:250px; background:#1e293b; border:1px solid #475569; color:#e2e8f0; border-radius:4px; padding:2px 5px; font-family:monospace; font-size:12px;'><option>loading…</option></select></div>" +
        "<div class='am4-exp-row' style='display:flex; justify-content:space-between; align-items:center; gap:8px; margin:5px 0;'><label style='color:#94a3b8;'>Quantity</label><input type='number' id='am4FleetQty' value='1' min='1' style='width:70px; background:#1e293b; border:1px solid #475569; color:#e2e8f0; border-radius:4px; padding:2px 5px; font-family:monospace;'></div>" +
        "<div id='am4FleetCfgBox' style='margin:6px 0; padding:6px; border:1px dashed #334155; border-radius:6px;'></div>" +
        "<div id='am4FleetCost' style='font-size:11px; color:#94a3b8; margin:4px 0;'></div>" +
        "<div class='am4-exp-btnrow' style='display:flex; gap:8px; margin-top:8px; align-items:center; flex-wrap:wrap;'>" +
        "<button id='am4FleetBuy' style='cursor:pointer; border:none; border-radius:5px; padding:6px 12px; font-family:monospace; font-size:12px; font-weight:bold; background:#7f1d1d; color:#fecaca;'>Order (in-game cash)</button>" +
        "<button id='am4FleetBuyCargoMore' style='display:none; cursor:pointer; border:none; border-radius:5px; padding:6px 12px; font-family:monospace; font-size:11px; font-weight:bold; background:#1e3a5f; color:#7dd3fc;'>Auto-order cargo 1-by-1</button>" +
        "<span id='am4FleetBuyMsg' style='font-size:10px; color:#38bdf8; word-break:break-word; flex-grow:1;'></span></div>" +
        "<div style='font-size:9px; color:#64748b; margin-top:8px; border-top:1px dashed #334155; padding-top:6px;'>Set seating / cargo holds before ordering — the game will not accept an empty config. Pax: Y/J/F (full economy is allowed). Cargo: Heavy aft/fwd + Large aft/fwd; cargo orders are 1 aircraft per send. After ~4 h delivery, CO₂ −10% / Speed +10% / Fuel −10% are applied automatically. Capped by \"Max aircraft per order\" and the fail-closed \"Aircraft order $ cap\" in ⚙ settings. Only the acting (lease-holding) tab can order.</div>" +
        "<div id='am4FleetModHost' style='margin-top:10px;'></div>" +
        "<div id='am4FleetBuildHost' style='margin-top:10px;'></div>" +
        "<div class='am4-fleet-sec' style='color:#f59e0b; font-size:11px; font-weight:bold; letter-spacing:0.5px; border-top:1px dashed #334155; padding-top:6px; margin-top:8px;'>BUILD ROUTE · assign an aircraft at base</div>" +
        "<div style='font-size:10px; color:#f87171; margin:5px 0; line-height:1.4;'>⚠ Spends a small route fee (~$1.5M). Uses the plane's OWN seat config (all 3 classes must be &gt; 0). Every aircraft the game lists as Parked or Grounded is offered, any model. Pick one, press Check route, then Create.</div>" +
        "<div class='am4-exp-row' style='display:flex; justify-content:space-between; align-items:center; gap:8px; margin:5px 0;'><label style='color:#94a3b8;'>Aircraft at base</label><select id='am4RtePlane' style='max-width:250px; background:#1e293b; border:1px solid #475569; color:#e2e8f0; border-radius:4px; padding:2px 5px; font-family:monospace; font-size:12px;'><option>loading…</option></select></div>" +
        "<div class='am4-exp-row' style='display:flex; justify-content:space-between; align-items:center; gap:8px; margin:5px 0;'><label style='color:#94a3b8;'>Destination</label><select id='am4RteDest' style='max-width:250px; background:#1e293b; border:1px solid #475569; color:#e2e8f0; border-radius:4px; padding:2px 5px; font-family:monospace; font-size:12px;'><option value=''>pick a researched route</option></select></div>" +
        "<div id='am4RteDestNote' style='font-size:9px; color:#64748b; margin:0 0 4px 0; line-height:1.4;'></div>" +
        "<div class='am4-exp-row' style='display:flex; justify-content:space-between; align-items:center; gap:8px; margin:5px 0;'><label style='color:#94a3b8;'>Route name</label><input id='am4RteReg' maxlength='10' style='width:150px; background:#1e293b; border:1px solid #475569; color:#e2e8f0; border-radius:4px; padding:2px 5px; font-family:monospace; font-size:12px;'></div>" +
        "<div class='am4-exp-row' style='display:flex; justify-content:space-between; align-items:center; gap:8px; margin:5px 0;'><label style='color:#94a3b8;'>Cost index (0-200)</label><input type='number' id='am4RteCi' value='200' min='0' max='200' style='width:70px; background:#1e293b; border:1px solid #475569; color:#e2e8f0; border-radius:4px; padding:2px 5px; font-family:monospace;'></div>" +
        "<div class='am4-exp-btnrow' style='display:flex; gap:8px; margin-top:6px; align-items:center;'><button id='am4RteCheck' style='cursor:pointer; border:none; border-radius:5px; padding:6px 12px; font-family:monospace; font-size:12px; font-weight:bold; background:#334155; color:#e2e8f0;'>Check route</button></div>" +
        "<div id='am4RteInfo' style='font-size:11px; color:#cbd5e1; margin:6px 0; line-height:1.6;'></div>" +
        "<div class='am4-exp-btnrow' style='display:flex; gap:8px; margin-top:6px; align-items:center;'><button id='am4RteCreate' disabled style='cursor:pointer; border:none; border-radius:5px; padding:6px 12px; font-family:monospace; font-size:12px; font-weight:bold; background:#7f1d1d; color:#fecaca; opacity:0.5;'>Create route (in-game cash)</button><span id='am4RteMsg' style='font-size:10px; color:#38bdf8; word-break:break-word; flex-grow:1;'></span></div>" +
        "<div style='font-size:9px; color:#64748b; margin-top:8px; border-top:1px dashed #334155; padding-top:6px;'>Only the acting tab can create. Route created via the verified new_route_info.php?mode=do contract; the plane moves from Parked to Routed. Set ticket prices after creation with the game's Auto button (the suite applies your multipliers). To change seats or add speed/fuel/CO₂ upgrades, use 🔧 Modify in this same Fleet panel.</div>";
    document.body.appendChild(panel);

    document.getElementById('am4FleetClose').addEventListener('click', function () { panel.style.display = 'none'; });
    document.getElementById('am4FleetRefresh').addEventListener('click', function () { am4FleetRenderState(); am4FleetRenderParkedPicker(); });
    document.getElementById('am4FleetQty').addEventListener('input', am4FleetUpdateCost);
    document.getElementById('am4FleetHub').addEventListener('change', am4FleetUpdateCost);
    document.getElementById('am4FleetBuy').addEventListener('click', function () { am4FleetOnBuyClick(false); });
    var more = document.getElementById('am4FleetBuyCargoMore');
    if (more) more.addEventListener('click', function () { am4FleetOnBuyClick(true); });
    var typeSel = document.getElementById('am4FleetType');
    if (typeSel) {
        am4AircraftFillSelect(typeSel, am4AircraftTypeId());
        typeSel.addEventListener('change', function () {
            am4AircraftSelectType(this.value, function () {
                am4FleetReloadOrderAndLists();
                am4StrategyRender();
                if (typeof am4RbOnAircraftTypeChanged === 'function') am4RbOnAircraftTypeChanged();
            });
        });
    }
    var engSel = document.getElementById('am4FleetEngine');
    if (engSel) {
        am4FleetFillEngineSelect();
        engSel.addEventListener('change', function () {
            var id = parseInt(this.value, 10);
            var p = am4AircraftProfile();
            var hit = (p.engines || []).filter(function (e) { return e.id === id; })[0];
            am4AircraftSet({ engineId: id, engineName: hit ? hit.name : p.engineName });
            am4FleetUpdateCost();
        });
    }
    document.getElementById('am4RtePlane').addEventListener('change', am4FleetOnPlaneSelect);
    document.getElementById('am4RteDest').addEventListener('change', am4FleetResetCreateBtn);
    document.getElementById('am4RteCheck').addEventListener('click', am4FleetOnCheckRoute);
    document.getElementById('am4RteCreate').addEventListener('click', am4FleetOnCreateClick);

    am4FleetRenderState();
    am4FleetRenderParkedPicker();
    am4FleetReloadOrderAndLists();
    am4FleetEmbedTools();
    am4AircraftRefreshCatalog().then(function () {
        am4AircraftFillSelect(document.getElementById('am4FleetType'), am4AircraftTypeId());
        am4AircraftFillSelect(document.getElementById('am4StratType'), am4AircraftTypeId());
        am4FleetRenderState(); // the state line names the selected model
        if (typeof am4StrategyRender === 'function') am4StrategyRender();
    });
    am4PanelChrome(panel,'fleet');
    am4FleetRenderCfg();
    return panel;
}

function am4FleetFillEngineSelect() {
    var sel = document.getElementById('am4FleetEngine');
    if (!sel) return;
    var p = am4AircraftProfile();
    var engines = (p.engines && p.engines.length) ? p.engines : [];
    if (!engines.length) {
        sel.innerHTML ="<option value=''>loading engines…</option>" ;
        return;
    }
    sel.innerHTML = engines.map(function (e) {
        return"<option value='" + e.id +"'" + (e.id === p.engineId ? " selected" : "") +">" +
            am4FleetEsc(e.name || ('engine ' + e.id)) +"</option>" ;
    }).join('');
}

function am4FleetReloadOrderAndLists() {
    am4FleetRenderState();
    am4FleetRenderParkedPicker();
    if (typeof am4FleetRenderModPicker === 'function') am4FleetRenderModPicker();
    am4FleetFetchOrderInfo().then(function (info) {
        if (info.typeId && info.typeId !== am4AircraftTypeId()) return;
        am4FleetOrderInfo = info;
        var sel = document.getElementById('am4FleetHub');
        if (sel) {
            if (!info.hubs.length) { sel.innerHTML ="<option value=''>could not read hubs</option>" ; }
            else sel.innerHTML = info.hubs.map(function (h) { return"<option value='" + am4FleetEsc(h.v) +"'>" + am4FleetEsc(h.t) +"</option>" ; }).join('');
        }
        var qty = document.getElementById('am4FleetQty');
        if (qty && info.cargo) {
            qty.max = 100;
            qty.title = 'Cargo: each send is 1 aircraft. Quantity = how many 1-by-1 orders to run.';
            if (parseInt(qty.value, 10) > 1) qty.value = '1';
        } else if (qty && info.maxAcOrder) qty.max = info.maxAcOrder;
        am4FleetFillEngineSelect();
        am4FleetRenderCfg();
        am4FleetUpdateCost();
    });
}

function am4FleetRenderState() {
    var el = document.getElementById('am4FleetState');
    if (!el) return;
    el.innerHTML = 'reading fleet…';
    am4FleetReadState().then(function (st) {
        var a = st.a380, h = st.header;
        var rows = [];
        if (h) rows.push("<div>Routes <b>" + h.routes +"</b> · Fleet <b>" + h.fleet +"</b> · Parked <b>" + h.parked +"</b> · Pending <b style='color:#f59e0b;'>" + h.pending +"</b></div>");
        rows.push("<div style='margin-top:4px; color:#cbd5e1;'>" + am4FleetEsc(am4AircraftName()) +" (" + a.total +"): " +
            "<b style='color:#10b981;'>" + a.routed +"</b> routed · " +
            "<b style='color:#f59e0b;'>" + a.parked +"</b> parked · " +
            "<b style='color:#c084fc;'>" + a.maintenance +"</b> maint" +
            (a.other ? " · " + a.other +" other" : "") +"</div>");
        if (a.parked > 0) rows.push("<div style='font-size:10px; color:#64748b;'>→ " + a.parked +" parked (unassigned) — ready to put on routes.</div>");
        var others = st.byType.filter(function (t) {
            return String(t.label || '').toLowerCase().indexOf(String(am4AircraftName()).toLowerCase()) === -1;
        });
        if (others.length) rows.push("<div style='font-size:10px; color:#64748b; margin-top:2px;'>Other: " + others.map(function (t) { return am4FleetEsc(t.label.replace(/(Airbus|Boeing|Bombardier|Cessna)$/,'').trim()) +" " + t.count; }).join(' · ') +"</div>");
        el.innerHTML = rows.join('');
    }).catch(function () { el.innerHTML ="<span style='color:#ef4444;'>could not read fleet state</span>" ; });
}

function am4FleetInp(id) {
    var el = document.getElementById(id);
    var n = parseInt(el && el.value, 10);
    return isFinite(n) && n >= 0 ? n : 0;
}

function am4FleetReadCfg() {
    var p = am4AircraftProfile();
    if (p.cargo) {
        return {
            cargo: true,
            cargoAft: am4FleetInp('am4FleetCargoAft'),
            cargoFwd: am4FleetInp('am4FleetCargoFwd'),
            cargoAftH: am4FleetInp('am4FleetCargoAftH'),
            cargoFwdH: am4FleetInp('am4FleetCargoFwdH'),
            e: 0, b: 0, f: 0
        };
    }
    return {
        cargo: false,
        e: am4FleetInp('am4FleetSeatY'),
        b: am4FleetInp('am4FleetSeatJ'),
        f: am4FleetInp('am4FleetSeatF'),
        cargoAft: 0, cargoFwd: 0, cargoAftH: 0, cargoFwdH: 0
    };
}

function am4FleetSaveCfgFromUi() {
    var c = am4FleetReadCfg();
    if (c.cargo) {
        am4AircraftSet({ cargoAft: c.cargoAft, cargoFwd: c.cargoFwd, cargoAftH: c.cargoAftH, cargoFwdH: c.cargoFwdH });
    } else {
        am4AircraftSet({ orderY: c.e, orderJ: c.b, orderF: c.f });
    }
}

function am4FleetRenderCfg() {
    var box = document.getElementById('am4FleetCfgBox');
    var more = document.getElementById('am4FleetBuyCargoMore');
    if (!box) return;
    var p = am4AircraftProfile();
    if (more) more.style.display = p.cargo ?'' : 'none';
    if (p.cargo) {
        box.innerHTML =
            "<div style='color:#f59e0b; font-size:10px; font-weight:bold; margin-bottom:4px;'>CARGO HOLDS (required)</div>" +
            "<div style='display:flex; justify-content:space-between; gap:8px; font-size:10px; color:#94a3b8; margin:4px 0;'>" +
            "<label>Heavy aft <input type='number' id='am4FleetCargoAft' min='0' max='99' value='" + (p.cargoAft || 0) +"' style='width:52px; background:#1e293b; border:1px solid #475569; color:#e2e8f0; border-radius:4px; padding:2px 4px;'></label>" +
            "<label>Heavy fwd <input type='number' id='am4FleetCargoFwd' min='0' max='99' value='" + (p.cargoFwd || 0) +"' style='width:52px; background:#1e293b; border:1px solid #475569; color:#e2e8f0; border-radius:4px; padding:2px 4px;'></label></div>" +
            "<div style='display:flex; justify-content:space-between; gap:8px; font-size:10px; color:#94a3b8; margin:4px 0;'>" +
            "<label>Large aft <input type='number' id='am4FleetCargoAftH' min='0' max='99' value='" + (p.cargoAftH || 0) +"' style='width:52px; background:#1e293b; border:1px solid #475569; color:#e2e8f0; border-radius:4px; padding:2px 4px;'></label>" +
            "<label>Large fwd <input type='number' id='am4FleetCargoFwdH' min='0' max='99' value='" + (p.cargoFwdH || 0) +"' style='width:52px; background:#1e293b; border:1px solid #475569; color:#e2e8f0; border-radius:4px; padding:2px 4px;'></label></div>" +
            "<div style='font-size:9px; color:#64748b;'>Heavy = #cargoAft / #cargoFwd. Large = #cargoAftH / #cargoFwdH. Cargo orders click the game's #btnPurchaseCargoDo on the real order form (not a guessed URL). Only 1 cargo aircraft per order.</div>";
        ['am4FleetCargoAft','am4FleetCargoFwd','am4FleetCargoAftH','am4FleetCargoFwdH' ].forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.addEventListener('input', function () { am4FleetSaveCfgFromUi(); am4FleetUpdateCost(); });
        });
    } else {
        var y = p.orderY || p.seats || 0;
        box.innerHTML =
            "<div style='color:#f59e0b; font-size:10px; font-weight:bold; margin-bottom:4px;'>SEATING (required before order)</div>" +
            "<div style='display:flex; gap:8px; align-items:center; font-size:10px; color:#94a3b8;'>" +
            "<label>Y <input type='number' id='am4FleetSeatY' min='0' max='" + (p.seats || 600) +"' value='" + y +"' style='width:52px; background:#1e293b; border:1px solid #475569; color:#e2e8f0; border-radius:4px; padding:2px 4px;'></label>" +
            "<label>J <input type='number' id='am4FleetSeatJ' min='0' max='300' value='" + (p.orderJ || 0) +"' style='width:52px; background:#1e293b; border:1px solid #475569; color:#e2e8f0; border-radius:4px; padding:2px 4px;'></label>" +
            "<label>F <input type='number' id='am4FleetSeatF' min='0' max='200' value='" + (p.orderF || 0) +"' style='width:52px; background:#1e293b; border:1px solid #475569; color:#e2e8f0; border-radius:4px; padding:2px 4px;'></label>" +
            "<span style='color:#64748b;'>of " + (p.seats || '?') +" seats</span></div>" ;
        ['am4FleetSeatY','am4FleetSeatJ','am4FleetSeatF' ].forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.addEventListener('input', function () { am4FleetSaveCfgFromUi(); am4FleetUpdateCost(); });
        });
    }
}

function am4FleetCfgValid(c) {
    if (!c) return 'Set the configuration first.';
    if (c.cargo) {
        if ((c.cargoAft + c.cargoFwd + c.cargoAftH + c.cargoFwdH) < 1) return 'Cargo holds are empty — set Large and/or Heavy before ordering.';
        return null;
    }
    if ((c.e + c.b + c.f) < 1) return 'Seating is empty — set Y/J/F before ordering.';
    return null;
}

function am4FleetMakeReg(p) {
    var max = parseInt(p && p.regMaxLen, 10);
    if (!(max > 0) || max > 12) max = 10;
    var prefix = String((p && p.name) || 'AC').replace(/[^A-Za-z0-9]/g,'').slice(0, Math.min(4, Math.max(2, max - 3))).toUpperCase();
    var need = Math.max(1, max - prefix.length);
    var rest = Math.random().toString(36).replace(/[^a-z0-9]/gi,'').slice(2, 2 + need + 2).toUpperCase();
    return (prefix + rest).slice(0, max);
}

function am4FleetOrderAcid() {
    var p = am4AircraftProfile();
    if (p && p.orderAcid) return p.orderAcid;
    return am4AircraftTypeId();
}

function am4FleetBuildOrderUrl(hubId, amount, reg, cfg, bind) {
    bind = bind || (am4AircraftProfile() && am4AircraftProfile().orderBind) || null;
    var cargo = !!(cfg && (cfg.cargo || (am4AircraftProfile() && am4AircraftProfile().cargo)));
    var params = {
        id: String(am4FleetOrderAcid()),
        hub: String(hubId),
        r: String(reg),
        engine: String(am4AircraftEngineId()),
        amount: String(amount),
        charter: '0' 
    };
    var holds = {
        cargoAft: cfg.cargoAft,
        cargoFwd: cfg.cargoFwd,
        cargoAftH: cfg.cargoAftH,
        cargoFwdH: cfg.cargoFwdH,
        eSeat: cfg.e,
        bSeat: cfg.b,
        fSeat: cfg.f,
        hubSelection: hubId,
        reg: reg,
        engSelection: am4AircraftEngineId(),
        acAmount: amount
    };
    var map = (bind && bind.map && Object.keys(bind.map).length) ? bind.map : null;
    var appliedHold = false;
    if (map) {
        Object.keys(map).forEach(function (q) {
            if (q === 'id') return;
            var src = map[q];
            if (!Object.prototype.hasOwnProperty.call(holds, src)) return;
            params[q] = String(holds[src]);
            if (/^cargo/.test(src) || src === 'eSeat' || src === 'bSeat' || src === 'fSeat') appliedHold = true;
        });
    }
    if (cargo) {
        if (!appliedHold) {
            // Same four letters as pax e/b plus cargo l/h: large→e/b, heavy→l/h.
            params.l = String(cfg.cargoAft);
            params.h = String(cfg.cargoFwd);
            params.e = String(cfg.cargoAftH);
            params.b = String(cfg.cargoFwdH);
        }
    } else if (!appliedHold) {
        params.e = String(cfg.e);
        params.b = String(cfg.b);
        params.f = String(cfg.f);
    }
    var q = Object.keys(params).map(function (k) {
        return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
    }).join('&');
    return 'ac_order_do.php?' + q;
}

function am4FleetOrderBodyHint(body) {
    var d = document.createElement('div');
    d.innerHTML = body || '';
    var node = d.querySelector('.alert, .text-danger, .error, #error, .red');
    var t = ((node && (node.innerText || node.textContent)) || d.innerText || '').replace(/\s+/g,' ').trim();
    if (!t) return '';
    return t.slice(0, 140);
}

function am4FleetSendOrder(url) {
    if (typeof am4RteGameGet === 'function') {
        return am4RteGameGet(url).then(function (res) { return (res && res.body) || ''; });
    }
    return fetch(url, { credentials: 'include'}).then(function (r) { return r.text(); });
}

function am4FleetLoadOrderBindings() {
    var typeId = am4AircraftTypeId();
    var getter = (typeof am4RteGameGet === 'function')
        ? function () { return am4RteGameGet('ac_orders.php?mode=detail&id=' + typeId + '&charter=0'); }
        : function () {
            return fetch('ac_orders.php?mode=detail&id=' + typeId + '&charter=0', { credentials: 'include'})
                .then(function (r) { return r.text().then(function (body) { return { body: body }; }); });
        };
    return getter().then(function (res) {
        var html = (res && res.body) || (typeof res === 'string' ? res : '');
        if (am4AircraftTypeId() === typeId) am4AircraftApplyOrderPage(html, typeId);
        return am4AircraftParseOrderBindings(html);
    }).catch(function () {
        return (am4AircraftProfile() && am4AircraftProfile().orderBind) || { pageCargo: false, map: {}, foundDo: false };
    });
}

function am4FleetOrderHost() {
    var el = document.getElementById('am4CargoOrderHost');
    if (!el) {
        el = document.createElement('div');
        el.id = 'am4CargoOrderHost';
        el.style.cssText = 'position:absolute;left:-9999px;top:0;width:640px;height:1px;overflow:hidden;';
        document.body.appendChild(el);
    }
    return el;
}

function am4FleetClearOrderHost() {
    var el = document.getElementById('am4CargoOrderHost');
    if (el) el.innerHTML = '';
}

function am4FleetSetAll(sel, val) {
    var nodes = document.querySelectorAll(sel);
    var i;
    for (i = 0; i < nodes.length; i++) {
        nodes[i].value = String(val);
        if (window.jQuery) {
            try { window.jQuery(nodes[i]).val(String(val)).trigger('input').trigger('change'); } catch (eSet) { /* ignore */ }
        }
    }
    return nodes.length;
}

function am4FleetHubIdFromLiveSelect(select, hubId, hubName) {
    if (!select || !select.options) return '';
    var opts = [], i, o;
    for (i = 0; i < select.options.length; i++) {
        o = select.options[i];
        opts.push({ v: String(o.value || ''), t: String(o.textContent || '').trim() });
    }
    if (hubId) {
        for (i = 0; i < opts.length; i++) if (opts[i].v === String(hubId)) return opts[i].v;
    }
    var wantTight = typeof am4FleetHubKeyTight === 'function' ? am4FleetHubKeyTight(hubName) : String(hubName || '').toLowerCase();
    var exact = opts.filter(function (h) {
        var k = typeof am4FleetHubKeyTight === 'function' ? am4FleetHubKeyTight(h.t) : String(h.t || '').toLowerCase();
        return k && k === wantTight;
    });
    if (exact.length === 1) return exact[0].v;
    return '';
}

function am4FleetCargoDestEl() {
    var ac = document.getElementById('acModel');
    if (ac) return ac;
    return am4FleetOrderHost();
}

function am4FleetInjectCargoDetail(typeId) {
    // Always inject into our hidden host — #acModel on the live page is often Research /
    // another panel and does not contain the order form, which broke #btnPurchasePaxDo lookup.
    var host = am4FleetOrderHost();
    var destId = host.id;
    var jq = (typeof window.jQuery !== 'undefined' && window.jQuery.ajax) ? window.jQuery : null;
    var fb = (typeof window.fbSig !== 'undefined' && window.fbSig != null) ? String(window.fbSig) : '';
    var data = 'mode=detail&id=' + encodeURIComponent(typeId) + '&charter=0';
    if (fb && data.indexOf('fbSig=') === -1) data +='&fbSig=' + encodeURIComponent(fb);
    return new Promise(function (resolve, reject) {
        if (!jq) {
            reject(new Error('game jQuery missing'));
            return;
        }
        jq.ajax({
            type: 'GET',
            url: 'ac_orders.php',
            data: data,
            cache: false,
            dataType: 'html',
            success: function (html) {
                try { jq(host).html(html); } catch (eHtml) { host.innerHTML = html || ''; }
                console.log('[AM4 Bot Log] cargo order form injected into #' + destId + ' (' + String(html || '').length + ' chars)');
                resolve(html == null ?'' : String(html));
            },
            error: function (xhr) {
                reject(new Error('order detail HTTP ' + ((xhr && xhr.status) || 0)));
            }
        });
    });
}

function am4FleetPlacePaxViaOrderUrl(hubId, hubName, reg, cfg, beforeOpt) {
    var p = am4AircraftProfile();
    cfg = cfg || {};
    var e = Math.max(0, parseInt(cfg.e, 10) || 0);
    var b = Math.max(0, parseInt(cfg.b, 10) || 0);
    var f = Math.max(0, parseInt(cfg.f, 10) || 0);
    if (e + b + f < 1) {
        return Promise.resolve({ ok: false, refused: true, reg: reg, hint: 'seating empty'});
    }
    if (typeof am4SuiteResearchBusy === 'function' && am4SuiteResearchBusy()) {
        return Promise.resolve({ ok: false, refused: true, before: beforeOpt, nowPending: beforeOpt, reg: reg, hint: 'Research is running — order paused'});
    }
    function send(before) {
        return am4FleetLoadOrderBindings().then(function (bind) {
            if (bind.pageCargo && !bind.pagePax) {
                return { ok: false, refused: true, bindFail: true, before: before, nowPending: before, reg: reg, hint: 'order page is cargo-only for this type'};
            }
            var liveHub = String(hubId || '');
            if (!liveHub && hubName && typeof am4FleetOrderHubResolve === 'function') {
                var hr = am4FleetOrderHubResolve(hubName);
                if (hr.id) liveHub = String(hr.id);
            }
            if (!liveHub) {
                return { ok: false, refused: true, before: before, nowPending: before, reg: reg, hint: 'hub "' + hubName + '" is not on the order page'};
            }
            var regElMax = 0;
            try {
                var host = am4FleetOrderHost();
                var regEl = host.querySelector('#reg, input[name="r"]');
                regElMax = parseInt(regEl && regEl.getAttribute('maxlength'), 10) || 0;
            } catch (eReg) { /* ignore */ }
            if (!regElMax && p && p.regMaxLen) regElMax = p.regMaxLen;
            if (regElMax > 0) reg = String(reg).slice(0, regElMax);
            if (!reg) reg = am4FleetMakeReg({ name: p.name, regMaxLen: regElMax });
            var url = am4FleetBuildOrderUrl(liveHub, 1, reg, { e: e, b: b, f: f, cargo: false }, bind);
            console.log('[AM4 Bot Log] Fleet pax via ac_order_do URL type=' + am4AircraftTypeId() +
                ' hub=' + liveHub + ' r=' + reg + ' seats Y' + e + '/J' + b + '/F' + f);
            return am4FleetSendOrder(url).then(function (body) {
                var refused = /too low|not enough|insufficient|cannot afford|account low|denied|invalid/i.test(body || '');
                var hint = am4FleetOrderBodyHint(body);
                return new Promise(function (resolve) {
                    setTimeout(function () {
                        am4FleetReadState().then(function (after) {
                            am4FleetClearOrderHost();
                            var nowPending = after.header ? after.header.pending : null;
                            var delta = (before != null && nowPending != null) ? (nowPending - before) : null;
                            resolve({
                                ok: !!(delta && delta >= 1),
                                refused: refused || (delta != null && delta < 1),
                                before: before,
                                nowPending: nowPending,
                                delta: delta,
                                reg: reg,
                                hint: hint || (refused ?'order refused by game' : ''),
                                nativeUrl: url
                            });
                        }).catch(function () {
                            am4FleetClearOrderHost();
                            resolve({ ok: false, refused: true, before: before, reg: reg });
                        });
                    }, 2500);
                });
            });
        });
    }
    if (beforeOpt != null) return send(beforeOpt);
    return am4FleetReadState().then(function (st) {
        return send(st.header ? st.header.pending : null);
    });
}

function am4FleetSpyAcOrderDo(during) {
    var captured = { url: ''};
    var origAjax = window.Ajax;
    var jq = (typeof window.jQuery !== 'undefined' && window.jQuery.ajax) ? window.jQuery : null;
    var origJqAjax = jq && jq.ajax;
    function note(u) {
        var s = String(u || '');
        if (!/ac_order_do\.php/i.test(s)) return;
        captured.url = s;
        console.log('[AM4 Bot Log] native #btnPurchaseCargoDo request: ' + s);
    }
    if (typeof origAjax === 'function') {
        window.Ajax = function () {
            var args = Array.prototype.slice.call(arguments);
            note(args[0]);
            if (/ac_order_do\.php/i.test(String(args[0] || ''))) {
                if (args[1] === 'routeAction' || args[1] === 'acModel') args[1] = 'am4CargoOrderHost';
            }
            return origAjax.apply(this, args);
        };
    }
    if (origJqAjax) {
        jq.ajax = function (url, options) {
            var u = '', d = '';
            if (typeof url === 'string') {
                u = url;
                d = (options && options.data) || '';
            } else if (url && typeof url === 'object') {
                u = url.url || '';
                d = url.data || '';
            }
            note(u + (d ? ((String(u).indexOf('?') === -1 ?'?' : '&') + d) : ''));
            return origJqAjax.apply(this, arguments);
        };
    }
    function restore() {
        if (origAjax) window.Ajax = origAjax;
        if (jq && origJqAjax) jq.ajax = origJqAjax;
    }
    return Promise.resolve().then(during).then(function (result) {
        restore();
        result = result || {};
        result.nativeUrl = captured.url;
        return result;
    }, function (err) {
        restore();
        throw err;
    });
}

function am4FleetPlaceCargoViaGameButton(hubId, hubName, cfg, regOpt) {
    var p = am4AircraftProfile();
    var typeId = am4AircraftTypeId();
    var reg = regOpt || am4FleetMakeReg(p);
    var before = null;
    if (typeof am4SuiteResearchBusy === 'function' && am4SuiteResearchBusy()) {
        return Promise.resolve({ ok: false, refused: true, before: null, nowPending: null, reg: reg, hint: 'Research is running — cargo order paused'});
    }
    return am4FleetReadState().then(function (st) {
        before = st.header ? st.header.pending : null;
        return am4FleetInjectCargoDetail(typeId);
    }).then(function () {
        var host = am4FleetOrderHost();
        var btn = host.querySelector('#btnPurchaseCargoDo') || host.querySelector('.btnPurchaseCargo');
        if (!btn) {
            return { ok: false, refused: true, bindFail: true, before: before, nowPending: before, reg: reg, hint: 'no #btnPurchaseCargoDo on order form'};
        }
        var hubSel = host.querySelector('#hubSelection');
        var liveHub = am4FleetHubIdFromLiveSelect(hubSel, hubId, hubName);
        if (!liveHub) {
            return { ok: false, refused: true, before: before, nowPending: before, reg: reg, hint: 'hub "' + hubName + '" is not on the cargo order form (panel id ' + hubId + ')'};
        }
        var regEl = host.querySelector('#reg, input[name="r"]');
        var max = parseInt(regEl && regEl.getAttribute('maxlength'), 10);
        if (max > 0) reg = String(reg).slice(0, max);
        if (regEl && !reg) reg = am4FleetMakeReg({ name: p.name, regMaxLen: max });
        am4FleetSetAll('#cargoAft', cfg.cargoAft);
        am4FleetSetAll('#cargoFwd', cfg.cargoFwd);
        am4FleetSetAll('#cargoAftH', cfg.cargoAftH);
        am4FleetSetAll('#cargoFwdH', cfg.cargoFwdH);
        am4FleetSetAll('#hubSelection', liveHub);
        am4FleetSetAll('#engSelection, #engineSelection, select[name="engine"]', am4AircraftEngineId());
        am4FleetSetAll('#reg, input[name="r"]', reg);
        am4FleetSetAll('#acAmount', 1);
        console.log('[AM4 Bot Log] Fleet cargo via #btnPurchaseCargoDo type=' + typeId +
            ' hub=' + liveHub + ' (panel had ' + hubId + ') engine=' + am4AircraftEngineId() +
            ' r=' + reg + ' holds ' + cfg.cargoAft + '/' + cfg.cargoFwd + '/' + cfg.cargoAftH + '/' + cfg.cargoFwdH);
        return am4FleetSpyAcOrderDo(function () {
            btn.click();
            return new Promise(function (resolve) { setTimeout(resolve, 900); });
        }).then(function (spy) {
            return { clicked: true, nativeUrl: spy && spy.nativeUrl, liveHub: liveHub, reg: reg };
        });
    }).then(function (mid) {
        if (!mid || mid.bindFail || mid.ok === false) return mid;
        if (!mid.nativeUrl) {
            console.log('[AM4 Bot Log] cargo click did not call Ajax(ac_order_do.php) — form handler may be jQuery-only');
        }
        return new Promise(function (resolve) {
            setTimeout(function () {
                am4FleetReadState().then(function (after) {
                    am4FleetClearOrderHost();
                    var nowPending = after.header ? after.header.pending : null;
                    var delta = (before != null && nowPending != null) ? (nowPending - before) : null;
                    resolve({
                        ok: !!(delta && delta >= 1),
                        refused: false,
                        before: before,
                        nowPending: nowPending,
                        delta: delta,
                        reg: mid.reg || reg,
                        hint: mid.nativeUrl ? ('sent ' + mid.nativeUrl) : '',
                        nativeUrl: mid.nativeUrl
                    });
                }).catch(function () {
                    am4FleetClearOrderHost();
                    resolve({ ok: false, refused: true, reg: reg, before: before });
                });
            }, 2500);
        });
    }).catch(function (e) {
        am4FleetClearOrderHost();
        throw e;
    });
}

function am4FleetPlacePaxViaGameButton(hubId, hubName, reg, cfg) {
    var p = am4AircraftProfile();
    var typeId = am4AircraftTypeId();
    cfg = cfg || {};
    var e = Math.max(0, parseInt(cfg.e, 10) || 0);
    var b = Math.max(0, parseInt(cfg.b, 10) || 0);
    var f = Math.max(0, parseInt(cfg.f, 10) || 0);
    if (e + b + f < 1) {
        return Promise.resolve({ ok: false, refused: true, reg: reg, hint: 'seating empty'});
    }
    var before = null;
    if (typeof am4SuiteResearchBusy === 'function' && am4SuiteResearchBusy()) {
        return Promise.resolve({ ok: false, refused: true, before: null, nowPending: null, reg: reg, hint: 'Research is running — order paused'});
    }
    return am4FleetReadState().then(function (st) {
        before = st.header ? st.header.pending : null;
        return am4FleetInjectCargoDetail(typeId);
    }).then(function (html) {
        var host = am4FleetOrderHost();
        var btn = host.querySelector('#btnPurchasePaxDo') || host.querySelector('.btnPurchasePax');
        if (!btn) {
            var snippet = String(html || host.innerHTML || '').replace(/\s+/g,' ').slice(0, 120);
            console.log('[AM4 Bot Log] no #btnPurchasePaxDo after inject (' + snippet + '…) — using ac_order_do URL');
            return am4FleetPlacePaxViaOrderUrl(hubId, hubName, reg, cfg, before);
        }
        var hubSel = host.querySelector('#hubSelection');
        var liveHub = am4FleetHubIdFromLiveSelect(hubSel, hubId, hubName);
        if (!liveHub) {
            return { ok: false, refused: true, before: before, nowPending: before, reg: reg, hint: 'hub "' + hubName + '" is not on the order form (panel id ' + hubId + ')'};
        }
        var regEl = host.querySelector('#reg, input[name="r"]');
        var max = parseInt(regEl && regEl.getAttribute('maxlength'), 10);
        if (max > 0) reg = String(reg).slice(0, max);
        if (regEl && !reg) reg = am4FleetMakeReg({ name: p.name, regMaxLen: max });
        am4FleetSetAll('#eSeat, input[name="eSeat"]', e);
        am4FleetSetAll('#bSeat, input[name="bSeat"]', b);
        am4FleetSetAll('#fSeat, input[name="fSeat"]', f);
        am4FleetSetAll('#hubSelection', liveHub);
        am4FleetSetAll('#engSelection, #engineSelection, select[name="engine"]', am4AircraftEngineId());
        am4FleetSetAll('#reg, input[name="r"]', reg);
        am4FleetSetAll('#acAmount', 1);
        console.log('[AM4 Bot Log] Fleet pax via #btnPurchasePaxDo type=' + typeId +
            ' hub=' + liveHub + ' (panel had ' + hubId + ') engine=' + am4AircraftEngineId() +
            ' r=' + reg + ' seats Y' + e + '/J' + b + '/F' + f);
        return am4FleetSpyAcOrderDo(function () {
            btn.click();
            return new Promise(function (resolve) { setTimeout(resolve, 900); });
        }).then(function (spy) {
            return { clicked: true, nativeUrl: spy && spy.nativeUrl, liveHub: liveHub, reg: reg };
        });
    }).then(function (mid) {
        if (!mid || mid.bindFail || mid.ok === false) return mid;
        if (!mid.nativeUrl) {
            console.log('[AM4 Bot Log] pax click did not call Ajax(ac_order_do.php) — form handler may be jQuery-only');
        }
        return new Promise(function (resolve) {
            setTimeout(function () {
                am4FleetReadState().then(function (after) {
                    am4FleetClearOrderHost();
                    var nowPending = after.header ? after.header.pending : null;
                    var delta = (before != null && nowPending != null) ? (nowPending - before) : null;
                    resolve({
                        ok: !!(delta && delta >= 1),
                        refused: false,
                        before: before,
                        nowPending: nowPending,
                        delta: delta,
                        reg: mid.reg || reg,
                        hint: mid.nativeUrl ? ('sent ' + mid.nativeUrl) : '',
                        nativeUrl: mid.nativeUrl
                    });
                }).catch(function () {
                    am4FleetClearOrderHost();
                    resolve({ ok: false, refused: true, reg: reg, before: before });
                });
            }, 2500);
        });
    }).catch(function (e) {
        am4FleetClearOrderHost();
        throw e;
    });
}

var AM4_FLEET_WATCH_KEY = 'am4MasterSuiteOrderWatch';
function am4FleetWatchLoad() {
    try { return JSON.parse(localStorage.getItem(AM4_FLEET_WATCH_KEY) || '[]') || []; } catch (e) { return []; }
}
function am4FleetWatchSave(list) {
    try { localStorage.setItem(AM4_FLEET_WATCH_KEY, JSON.stringify(list || [])); } catch (e) { /* ignore */ }
}
function am4FleetWatchAdd(item) {
    var list = am4FleetWatchLoad();
    list.push(item);
    am4FleetWatchSave(list);
}

function am4FleetWatchTick() {
    if (typeof am4SuiteResearchBusy === 'function' && am4SuiteResearchBusy()) return;
    var list = am4FleetWatchLoad();
    if (!list.length) return;
    if (typeof am4BuildFindParkedByReg !== 'function' || typeof am4FleetFetchModifyInfo !== 'function') return;
    list.forEach(function (item, idx) {
        if (!item || item.done || !item.reg) return;
        if (item.at && Date.now() - item.at > 12 * 60 * 60 * 1000) { item.done = true; item.note = 'expired'; return; }
        am4BuildFindParkedByReg(item.reg).then(function (p) {
            if (!p) return;
            return am4FleetFetchModifyInfo(p.planeId).then(function (info) {
                if (!info || !info.looksValid) return;
                if (info.mod1on && info.mod2on && info.mod3on) {
                    item.done = true; item.note = 'already modified';
                    am4FleetWatchSave(list);
                    return;
                }
                if (typeof am4CanMutate === 'function' && !am4CanMutate()) return;
                var e = info.cargo ? (info.curL || 0) : info.curE;
                var b = info.cargo ? (info.curH || 0) : info.curB;
                var f = info.cargo ? 0 : info.curF;
                if (info.cargo && (e + b) < 1) {
                    var fromProf = am4FleetCargoLHFromProfile();
                    if (fromProf) { e = fromProf.l; b = fromProf.h; }
                }
                if (info.cargo && (e + b) < 1) {
                    console.log('[AM4 Bot Log] Post-delivery modify skipped — cargo L/H unread for ' + item.reg);
                    return;
                }
                if (info.cargo) {
                    return am4FleetApplyCargoModifyViaGame(p.planeId, e, b, true, true, true).then(function (res) {
                        if (res && res.ok) {
                            item.done = true; item.note = 'modify sent';
                            am4FleetWatchSave(list);
                            am4FleetSetBuyMsg('Delivery of ' + item.reg + ' found — applying CO₂/Speed/Fuel.','#10b981');
                        }
                    });
                }
                var url = am4FleetBuildModifyUrl(p.planeId, e, b, f, true, true, true, false);
                console.log('[AM4 Bot Log] Post-delivery modify: ' + url);
                return fetch(url, { credentials: 'include'}).then(function (r) { return r.text(); }).then(function () {
                    item.done = true; item.note = 'modify sent';
                    am4FleetWatchSave(list);
                    am4FleetSetBuyMsg('Delivery of ' + item.reg + ' found — applying CO₂/Speed/Fuel.','#10b981');
                });
            });
        }).catch(function () { /* retry next tick */ });
        list[idx] = item;
    });
    am4FleetWatchSave(list.filter(function (x) { return x && !x.done; }));
}

var am4FleetWatchTimer = null;
function am4FleetWatchStart() {
    if (am4FleetWatchTimer) return;
    am4FleetWatchTimer = setInterval(am4FleetWatchTick, 45000);
}

function am4FleetPlaceOneOrder(hubId, hubName, cfg) {
    var p = am4AircraftProfile();
    if (cfg && cfg.cargo) return am4FleetPlaceCargoViaGameButton(hubId, hubName, cfg);
    var reg = am4FleetMakeReg(p);
    return am4FleetInjectCargoDetail(am4AircraftTypeId()).then(function () {
        return am4FleetPlacePaxViaGameButton(hubId, hubName, reg, cfg);
    });
}

function am4FleetEmbedTools() {
    am4FleetWatchStart();
    if (typeof am4ModifyBuildPanel === 'function') am4ModifyBuildPanel();
    if (typeof am4BuildQueuePanel === 'function') {
        var qp = am4BuildQueuePanel();
        if (qp) qp.style.display = 'block';
        if (typeof am4BuildRenderQueue === 'function') am4BuildRenderQueue();
    }
}

function am4FleetUpdateCost() {
    var costEl = document.getElementById('am4FleetCost');
    if (!costEl) return;
    var p = am4AircraftProfile();
    var qty = Math.max(1, parseInt((document.getElementById('am4FleetQty') || {}).value, 10) || 1);
    var unit = am4AircraftUnitCost();
    var total = qty * unit;
    var cap = Number(AM4_CONFIG.fleetBuyerSpendCap) || 0;
    var maxPer = Number(AM4_CONFIG.fleetBuyerMaxPerBuy) || 1;
    var warn = '';
    if (!unit) warn =" <span style='color:#ef4444;'>· unit cost unread — will not order</span>" ;
    else if (!p.cargo && qty > maxPer) warn =" <span style='color:#ef4444;'>· over your max/order (" + maxPer +")</span>" ;
    else if (cap > 0 && total > cap) warn =" <span style='color:#ef4444;'>· over your $ cap ($" + cap.toLocaleString() +")</span>" ;
    else if (!p.cargo && am4FleetOrderInfo.maxAcOrder && qty > am4FleetOrderInfo.maxAcOrder) warn =" <span style='color:#ef4444;'>· over hangar headroom (" + am4FleetOrderInfo.maxAcOrder +")</span>" ;
    var eachNote = p.cargo ? (qty + ' × 1 cargo @ $' + unit.toLocaleString()) : (qty + ' × $' + unit.toLocaleString());
    costEl.innerHTML = 'Total: <b>$' + total.toLocaleString() + '</b> (' + eachNote + ')' + warn;
}

function am4FleetSetBuyMsg(msg, color) {
    var el = document.getElementById('am4FleetBuyMsg');
    if (el) { el.innerText = msg; el.style.color = color || '#38bdf8'; }
}

var am4FleetCargoChain = { running: false, left: 0 };

function am4FleetOnBuyClick(autoCargo) {
    var sel = document.getElementById('am4FleetHub'), qtyEl = document.getElementById('am4FleetQty');
    if (!sel || !qtyEl) return;
    var hubId = sel.value, hubName = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : hubId;
    var p = am4AircraftProfile();
    var cfg = am4FleetReadCfg();
    am4FleetSaveCfgFromUi();
    var want = Math.max(1, parseInt(qtyEl.value, 10) || 1);
    var perSend = p.cargo ? 1 : want;
    var chainN = p.cargo ? want : 1;
    if (autoCargo && p.cargo) chainN = want;
    var unit = am4FleetOrderInfo.unitCost || p.unitCost || 0;
    var total = want * unit;
    var maxPer = Number(AM4_CONFIG.fleetBuyerMaxPerBuy) || 1;
    var cap = Number(AM4_CONFIG.fleetBuyerSpendCap) || 0;

    if (!hubId || !/^\d+$/.test(hubId)) { am4FleetSetBuyMsg('Pick a hub first.','#ef4444'); return; }
    if (typeof am4CanMutate === 'function' && !am4CanMutate()) { am4FleetSetBuyMsg('Blocked: another tab is the acting tab.','#ef4444'); return; }
    if (!am4AircraftEngineId()) { am4FleetSetBuyMsg('Blocked: no engine selected.','#ef4444'); return; }
    if (!unit) { am4FleetSetBuyMsg('Blocked: order-page cost is $0 / unread. Open the type in Fleet again, then retry.','#ef4444'); return; }
    var cfgErr = am4FleetCfgValid(cfg);
    if (cfgErr) { am4FleetSetBuyMsg(cfgErr,'#ef4444'); return; }
    if (!p.cargo && perSend > maxPer) { am4FleetSetBuyMsg('Blocked: ' + perSend + ' exceeds your max/order (' + maxPer + ') - raise it in ⚙ settings.','#ef4444'); return; }
    if (!p.cargo && am4FleetOrderInfo.maxAcOrder && perSend > am4FleetOrderInfo.maxAcOrder) { am4FleetSetBuyMsg('Blocked: over hangar headroom (' + am4FleetOrderInfo.maxAcOrder + ').','#ef4444'); return; }
    if (cap > 0 && total > cap) { am4FleetSetBuyMsg('Blocked: $' + total.toLocaleString() + ' over your $ cap ($' + cap.toLocaleString() + ').','#ef4444'); return; }
    if (typeof getBankBalance === 'function') {
        var bal = getBankBalance();
        if (bal && total > bal) { am4FleetSetBuyMsg('Blocked: cost $' + total.toLocaleString() + ' exceeds your balance.','#ef4444'); return; }
    }
    if (am4FleetOrderInfo.engine7Ok === false) { am4FleetSetBuyMsg('Blocked: could not read engines on the order page - not ordering.','#ef4444'); return; }
    if (am4FleetCargoChain.running && p.cargo) { am4FleetSetBuyMsg('Cargo auto-order already running.','#f59e0b'); return; }

    var confirmN = p.cargo ? chainN : perSend;
    var extra = p.cargo ? ('\nCargo is ordered 1 at a time' + (chainN > 1 ? (' × ' + chainN) : '') + '.') : '';
    if (!window.confirm('Order ' + confirmN + ' × ' + p.name + ' (' + (p.engineName || ('engine ' + p.engineId)) + ') to ' + hubName + extra +
            '\n\nThis spends in-game cash: about $' + total.toLocaleString() + '.\n\nPending must rise after each send. After delivery (~4 h), CO₂/Speed/Fuel will be applied.')) {
        am4FleetSetBuyMsg('Cancelled.','#94a3b8');
        return;
    }

    var runOne = function (left, doneOk) {
        if (left < 1) {
            am4FleetCargoChain.running = false;
            am4FleetSetBuyMsg('Cargo chain done (' + doneOk + ' ordered).','#10b981');
            am4FleetRenderState();
            return;
        }
        am4FleetSetBuyMsg('Ordering 1 ' + p.name + ' to ' + hubName + ' (' + (chainN - left + 1) + '/' + chainN + ')…','#38bdf8');
        am4FleetPlaceOneOrder(hubId, hubName, cfg).then(function (res) {
            if (res.ok) {
                am4FleetWatchAdd({
                    reg: res.reg, typeId: am4AircraftTypeId(), cargo: !!p.cargo, at: Date.now()
                });
                am4FleetSetBuyMsg('✓ Ordered ' + res.reg + ' — Pending ' + res.before + ' → ' + res.nowPending + '.','#10b981');
                am4FleetRenderState();
                if (left > 1) setTimeout(function () { runOne(left - 1, doneOk + 1); }, 1800);
                else {
                    am4FleetCargoChain.running = false;
                    if (doneOk + 1 > 1) am4FleetSetBuyMsg('✓ Ordered ' + (doneOk + 1) + ' ' + p.name + '. Watch Pending, then delivery for auto-modify.','#10b981');
                }
            } else {
                am4FleetCargoChain.running = false;
                if (res.bindFail) am4FleetSetBuyMsg('Stopped: order page is not cargo for this type id. Pick A380-800F from the shop again.','#ef4444');
                else if (res.refused) am4FleetSetBuyMsg('Order looks REFUSED (Pending ' + res.before + '→' + res.nowPending + '). ' + (res.hint || 'Check funds/hangar/config.'),'#ef4444');
                else am4FleetSetBuyMsg('Sent, but Pending did not rise (' + res.before + '→' + res.nowPending + ').' + (res.hint ? ' Game: ' + res.hint : '') + ' Verify manually before ordering again.', '#f59e0b');
            }
        }).catch(function (e) {
            am4FleetCargoChain.running = false;
            am4FleetSetBuyMsg('Order request failed: ' + String(e),'#ef4444');
        });
    };

    if (p.cargo) {
        am4FleetCargoChain.running = true;
        am4FleetCargoChain.left = chainN;
        runOne(chainN, 0);
        return;
    }

    var reg = am4FleetMakeReg(p);
    am4FleetSetBuyMsg('Ordering ' + perSend + ' ' + p.name + ' to ' + hubName + '…','#38bdf8');
    var before = null;
    am4FleetLoadOrderBindings().then(function (bind) {
        var url = am4FleetBuildOrderUrl(hubId, perSend, reg, cfg, bind);
        console.log('[AM4 Bot Log] Fleet Assistant ordering: ' + url);
        return am4FleetReadState().then(function (st) {
            before = st.header ? st.header.pending : null;
            return am4FleetSendOrder(url);
        }).then(function (body) {
            var refused = /too low|not enough|insufficient|cannot afford|account low|denied|invalid/i.test(body || '');
            var hint = am4FleetOrderBodyHint(body);
            setTimeout(function () {
                am4FleetReadState().then(function (after) {
                    var nowPending = after.header ? after.header.pending : null;
                    var delta = (before != null && nowPending != null) ? (nowPending - before) : null;
                    if (delta && delta >= perSend) {
                        am4FleetWatchAdd({ reg: reg, typeId: am4AircraftTypeId(), cargo: false, at: Date.now() });
                        am4FleetSetBuyMsg('✓ Ordered ' + perSend + ' ' + p.name + ' to ' + hubName + ' - Pending ' + before + ' → ' + nowPending + '.','#10b981');
                    } else if (refused) {
                        am4FleetSetBuyMsg('Order looks REFUSED by the game (Pending unchanged). ' + (hint || 'Check funds/hangar/seating.'),'#ef4444');
                    } else {
                        am4FleetSetBuyMsg('Sent, but Pending did not rise (' + before + '→' + nowPending + ').' + (hint ? ' Game: ' + hint : '') + ' Verify manually before ordering again.', '#f59e0b');
                    }
                    am4FleetRenderState();
                });
            }, 2500);
        });
    }).catch(function (e) { am4FleetSetBuyMsg('Order request failed: ' + String(e),'#ef4444'); });
}

//================================================================================
// B5 ROUTE BUILDER (MANUAL, hard-gated). Assign a PARKED A380 to a destination and
// create the route via the verified contract (GAME_CONTRACTS §10, captured live
// 2026-08-13):
// new_route_info.php?mode=do&id=<planeId>&airportId=<destId>&reg=<reg>
// &e=<Y ticket>&b=<J ticket>&f=<F ticket>&endCostIndex=<ci>&stopoverId=0&ferry=0&intro=<intro>
// Verified facts this rests on:
// - e/b/f are prices read from the route panel's native Auto values, then multiplied by the
// configured Y/J/F factors. The installed seat configuration remains on the aircraft.
// - The game's Create button still requires all installed passenger classes to be non-empty;
// a plane bought 600/0/0 must therefore be reconfigured before it can be routed.
// - endCostIndex default 200 (max; the game's cost slider spans 0..200). intro = the page
// global`intro` (0 for an established account; only 1 during the first-route tutorial).
// - A parked plane's HUB is NOT in fleet.php / statusData — it is shown in the config panel
// header ("<hubICAO> <dist>km <destICAO>"); B5 reads range/speed/demand/hub from there.
// - #capAc is NOT a parked-plane source (it lists routed planes too). Parked = fleet.php
// ?type=2 rows whose status is"Parked" (statusData[id].routeId === 0).
// - statusData[id].reg is the user's plane NAME = the intended destination ICAO — used as
// the default destination + route name.
// - The panel does NOT enforce range; B5 refuses a destination beyond the plane's range.
//================================================================================
var AM4_FLEET_ROUTE_CI_DEFAULT = 200;
var am4FleetParkedCache = []; // last-read at-base list (Parked or Grounded, any model)
var am4FleetRouteCheck = null; // last validated route {planeId, destId, ...}

// ICAO/IATA/numeric-Id/name → airportIconData entry (same id space the route search uses).
function am4FleetResolveAirport(token) {
    var t = String(token == null ?'' : token).trim();
    if (!t) return null;
    var aid = window.airportIconData || [];
    var up = t.toUpperCase(), i;
    for (i = 0; i < aid.length; i++) if (aid[i].icao && String(aid[i].icao).toUpperCase() === up) return aid[i];
    for (i = 0; i < aid.length; i++) if (aid[i].iata && String(aid[i].iata).toUpperCase() === up) return aid[i];
    if (/^\d+$/.test(t)) for (i = 0; i < aid.length; i++) if (String(aid[i].Id) === t) return aid[i];
    var low = t.toLowerCase();
    for (i = 0; i < aid.length; i++) if (aid[i].name && aid[i].name.toLowerCase().indexOf(low) !== -1) return aid[i];
    return null;
}

// Shared parser for fleet.php?type=2 rows. statusRe filters which statuses to include
// (e.g. /Parked|Grounded/i for at-base, /Parked|Routed|Grounded/i for the modify picker;
// pass null to keep every row and read the statuses yourself). Each row carries planeId,
// status, seat config and the plane name (statusData.reg → the intended-destination ICAO).
function am4FleetParseA380Rows(html, statusRe) {
    var box = document.createElement('div'); box.innerHTML = html;
    var sd = window.statusData || {};
    var out = [];
    box.querySelectorAll('.row.border').forEach(function (row) {
        // Fleet id: the row's own id ("fleetListBulkGround_128729462") is the primary
        // source; the showFlightInfo onclick is the fallback for older markup.
        var idm = String(row.id || '').match(/fleetListBulkGround_(\d+)/) ||
            row.innerHTML.match(/showFlightInfo\(this,(\d+)/);
        if (!idm) return;
        var pid = idm[1];
        var model = ((row.querySelector('.s-text') || {}).textContent || '').trim();
        var status = ((row.querySelector('.col-2.m-text') || {}).innerText || '').trim();
        if (statusRe && !statusRe.test(status)) return;
        var seatTxt = (row.querySelector('.col-4.m-text') || {}).innerText || '';
        var y = parseInt((seatTxt.match(/Y class:\s*(\d+)/) || [])[1], 10) || 0;
        var j = parseInt((seatTxt.match(/J class:\s*(\d+)/) || [])[1], 10) || 0;
        var f = parseInt((seatTxt.match(/F class:\s*(\d+)/) || [])[1], 10) || 0;
        var l = parseInt((seatTxt.match(/Large(?:\s+load)?\s*:\s*(\d+)/i) ||
            seatTxt.match(/L class:\s*(\d+)/i) || [])[1], 10) || 0;
        var h = parseInt((seatTxt.match(/Heavy(?:\s+load)?\s*:\s*(\d+)/i) ||
            seatTxt.match(/H class:\s*(\d+)/i) || [])[1], 10) || 0;
        // Plane NAME (reg): read it from the row HTML itself - the text of the
        // fleet_details.php anchor - NOT from window.statusData. statusData is a
        // page-LOAD snapshot, so a plane ordered after load (the auto-build case)
        // is absent from it and would resolve to reg='' until a reload, breaking
        // the"awaiting delivery -> found by reg" match. The HTML is always current.
        var reg = '';
        var anchors = row.querySelectorAll('a');
        for (var ai = 0; ai < anchors.length; ai++) {
            var aoc = anchors[ai].getAttribute('onclick') || '';
            if (/fleet_details\.php/i.test(aoc)) { reg = (anchors[ai].textContent || '').trim(); break; }
        }
        if (!reg) reg = String((sd[pid] || {}).reg || '').trim(); // fallback for odd markup
        var air = am4FleetResolveAirport((reg.split(/[\s-]+/)[0] || ''));
        var cargo = !!(l || h) || !!((sd[pid] || {}).cargo) || /freighter|-800F|\bcargo\b/i.test(model);
        out.push({
            planeId: pid, reg: reg, model: model, status: status, y: y, j: j, f: f, l: l, h: h,
            cargo: cargo,
            slots: cargo ? (l + h) : (y + 2 * j + 3 * f),
            pax: cargo ? (l + h) : (y + j + f),
            intendedDestId: air ? String(air.Id) : null,
            intendedDestIcao: air ? (air.icao || air.iata || '') : '' 
        });
    });
    return out;
}

// ---- Whole-fleet listing (EVERY type, every fleet id) --------------------------
// fleet.php only shows per-type summaries; the per-plane rows (fleetListBulkGround_<id>)
// live on fleet.php?type=<typeId>. So: read fleet.php once for the type links, then read
// every type page and concatenate. A short cache stops the parked + modify pickers from
// double-fetching the same ~20 pages when they refresh together.
var am4FleetTypeIdsCache = { at: 0, ids: [] };
function am4FleetListTypeIds() {
    if (am4FleetTypeIdsCache.ids.length && (Date.now() - am4FleetTypeIdsCache.at) < 10 * 60 * 1000) {
        return Promise.resolve(am4FleetTypeIdsCache.ids.slice());
    }
    return fetch('fleet.php', { credentials: 'include'})
        .then(function (r) { return r.text(); })
        .then(function (html) {
            var ids = [], seen = {};
            function add(v) {
                var n = parseInt(v, 10);
                if (n && !seen[n]) { seen[n] = 1; ids.push(n); }
            }
            var re = /fleet\.php\?type=(\d+)/gi, m;
            while ((m = re.exec(html || '')) !== null) add(m[1]);
            // Union with the owned types already in the catalog and the selected type: if the
            // type links ever change shape, the whole-fleet read must not silently collapse to
            // a single type and make every picker look empty.
            (am4AircraftCatalog || []).forEach(function (t) { if (t && t.owned) add(t.id); });
            add(am4AircraftTypeId());
            am4FleetTypeIdsCache = { at: Date.now(), ids: ids };
            return ids.slice();
        })
        .catch(function () { return [am4AircraftTypeId()]; });
}

var am4FleetAllRowsCache = { at: 0, rows: [] };
function am4FleetListAllRows(force) {
    if (!force && am4FleetAllRowsCache.rows.length && (Date.now() - am4FleetAllRowsCache.at) < 30000) {
        return Promise.resolve(am4FleetAllRowsCache.rows.slice());
    }
    return am4FleetListTypeIds().then(function (ids) {
        return Promise.all(ids.map(function (tid) {
            return fetch('fleet.php?type=' + tid, { credentials: 'include'})
                .then(function (r) { return r.text(); })
                .then(function (html) {
                    return am4FleetParseA380Rows(html, null).map(function (p) { p.typeId = tid; return p; });
                })
                .catch(function () { return []; });
        })).then(function (lists) {
            var rows = [];
            lists.forEach(function (l) { rows = rows.concat(l); });
            am4FleetAllRowsCache = { at: Date.now(), rows: rows };
            return rows.slice();
        });
    });
}

//"At base and routable" is Parked OR Grounded: the game labels an aircraft with no route
//"Parked" , but one that was grounded off a route keeps reading"Grounded" while sitting at
// its hub - see am4RbListAtBase, where filtering Parked alone is what stalled the first live
// conversion test. The route builder needs both, or a fleet full of grounded aircraft looks
// empty to it.
var AM4_FLEET_AT_BASE_RE = /Parked|Grounded/i;

// What the fleet actually reported, for the pickers' empty state: "no parked aircraft" alone
// cannot distinguish"nothing is at base" from"the fleet could not be read at all" .
function am4FleetStatusTally(rows) {
    var counts = {}, order = [];
    (rows || []).forEach(function (p) {
        var s = String(p.status || '').replace(/\s+/g,' ').trim() || 'no status';
        if (!counts[s]) { counts[s] = 0; order.push(s); }
        counts[s]++;
    });
    if (!order.length) return 'read 0 aircraft';
    order.sort(function (a, b) { return counts[b] - counts[a]; });
    return 'read ' + (rows || []).length + ': ' + order.map(function (s) {
        return s + ' ' + counts[s];
    }).join(' · ');
}

// Parked planes of ANY type — the route builder (B5) can only assign a plane that has no
// route. Every fleet id in the game is read, so the picker offers N-XXX / N-XXX-X /
// N-XXX-XX regardless of model.
var am4FleetParkedTally = '';
function am4FleetListParkedA380() {
    return am4FleetListAllRows().then(function (rows) {
        am4FleetParkedTally = am4FleetStatusTally(rows);
        var out = rows.filter(function (p) { return AM4_FLEET_AT_BASE_RE.test(p.status); });
        am4FleetParkedCache = out;
        return out;
    });
}

// The fleet list calls a landed aircraft"Routed" , exactly like an aircraft in the air.
// statusData.arrived cheaply narrows the set to aircraft whose current leg has ended; the
// aircraft page then proves there is no live"Arrives in" timer, and the game's modify panel
// is the final at-home oracle. This is the same fail-closed sequence used by Strategy Rebuild.
var am4FleetRouteCandidateCache = { at: 0, rows: [], tally: ''};
function am4FleetListRouteCandidates(force, onPartial) {
    if (!force && am4FleetRouteCandidateCache.rows.length &&
        (Date.now() - am4FleetRouteCandidateCache.at) < 30000) {
        am4FleetParkedCache = am4FleetRouteCandidateCache.rows.slice();
        am4FleetParkedTally = am4FleetRouteCandidateCache.tally;
        if (typeof onPartial === 'function') onPartial(am4FleetRouteCandidateCache.rows.slice(), am4FleetRouteCandidateCache.tally);
        return Promise.resolve(am4FleetRouteCandidateCache.rows.slice());
    }
    return am4FleetListAllRows(force).then(function (rows) {
        var ready = rows.filter(function (p) { return AM4_FLEET_AT_BASE_RE.test(p.status); });
        var sd = window.statusData || {};
        var now = Math.floor(Date.now() / 1000);
        var landed = rows.filter(function (p) {
            if (!/Routed/i.test(p.status)) return false;
            var snap = sd[p.planeId] || {};
            var arrived = Number(snap.arrived) || 0;
            return arrived > 0 && arrived <= now;
        });
        var tally = am4FleetStatusTally(rows) +
            (landed.length ?' · landed candidates ' + landed.length : '');
        am4FleetParkedTally = tally;
        if (typeof onPartial === 'function') onPartial(ready.slice(), tally);
        var verified = [], next = 0, active = 0, fail = {};
        return new Promise(function (resolve) {
            function failWhy(why) { fail[why] = (fail[why] || 0) + 1; }
            function finish() {
                var failTxt = Object.keys(fail).map(function (k) { return k + ' ' + fail[k]; }).join(', ');
                if (failTxt) tally +=' · not at base (' + failTxt + ')';
                var all = ready.concat(verified);
                all.sort(function (a, b) {
                    var da = AM4_FLEET_AT_BASE_RE.test(a.status) ? 0 : 1;
                    var db = AM4_FLEET_AT_BASE_RE.test(b.status) ? 0 : 1;
                    return (da - db) || String(a.reg).localeCompare(String(b.reg));
                });
                am4FleetRouteCandidateCache = { at: Date.now(), rows: all, tally: tally };
                am4FleetParkedCache = all.slice();
                am4FleetParkedTally = tally;
                resolve(all.slice());
            }
            function verifyLandedPlane(p) {
                active++;
                am4RbFetchAircraftPage(p.planeId).then(function (page) {
                    if (!page) { failWhy('unreadable'); return null; }
                    if (page.inFlight) { failWhy('still arriving'); return null; }
                    if (!page.routeId) { failWhy('no route id'); return null; }
                    return am4RbReadAircraftState(p.planeId).then(function (st) {
                        if (!st || !st.atBase) { failWhy((st && st.reason) || 'away'); return null; }
                        var copy = {};
                        Object.keys(p).forEach(function (k) { copy[k] = p[k]; });
                        copy.reroute = true;
                        copy.oldRouteId = String(page.routeId);
                        copy.status = 'Routed · landed at base';
                        return copy;
                    });
                }).then(function (ok) {
                    if (ok) { verified.push(ok); }
                }).catch(function () {
                    failWhy('unreadable');
                }).then(function () {
                    active--;
                    if (next >= landed.length && active === 0) { finish(); }
                    else { pump(); }
                });
            }
            function pump() {
                while (active < 5 && next < landed.length) {
                    verifyLandedPlane(landed[next++]);
                }
                if (next >= landed.length && active === 0) { finish(); }
            }
            pump();
        });
    });
}

function am4FleetRouteOptionHtml(p) {
    var zero = (p.y === 0 || p.j === 0 || p.f === 0) ?' ⚠no J/F' : '';
    var mdl = p.model ? (' · ' + p.model) : '';
    var st = p.status ? (' · ' + p.status) : '';
    return"<option value='" + am4FleetEsc(p.planeId) +"'>" + am4FleetEsc(p.reg || p.planeId) +
        " (" + p.y +"/" + p.j +"/" + p.f +")" + am4FleetEsc(mdl + st) + zero +"</option>" ;
}

// Parked, grounded AND routed planes of ANY type — the modify/reconfigure picker (B5b)
// accepts all three: routed planes can still get upgrades (the game pulls them off the route
// during the modify timer and needs them at base). Maintenance planes are excluded (mid-check).
var am4FleetModListCache = [];
var am4FleetModTally = '';
function am4FleetListModifyA380() {
    return am4FleetListAllRows().then(function (rows) {
        am4FleetModTally = am4FleetStatusTally(rows);
        var out = rows.filter(function (p) { return /Parked|Routed|Grounded/i.test(p.status); });
        am4FleetModListCache = out;
        return out;
    });
}

// Parse the game's own route-config panel (new_route_info.php ...&mode=res, read-only).
function am4FleetParseRouteConfig(html) {
    var box = document.createElement('div'); box.innerHTML = html;
    var text = (box.innerText || '').replace(/\s+/g,' ').trim();
    var toN = function (s) { var n = parseInt(String(s == null ?'' : s).replace(/[^0-9]/g,''), 10); return isFinite(n) ? n : 0; };
    var specs = text.match(/([\d,]+)km\/([\d,]+)kph\/([\d,]+)PAX/i);
    var route = text.match(/([A-Z]{3,4})\s+([\d,]+)km\s+([A-Z]{3,4})/);
    var demand = text.match(/Daily pax demand\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)/i);
    var acr = text.match(/A\/C on route\s+(\d+)/i);
    var reg = (box.querySelector('#routeReg') || {}).value;
    var fieldNumber = function (selectors) {
        var el = box.querySelector(selectors);
        var n = el ? parseFloat(String(el.value || el.getAttribute('value') || '').replace(/,/g,'')) : NaN;
        return isFinite(n) && n > 0 ? n : 0;
    };
    var nativePrices = null;
    var py = fieldNumber('#eSeat, #eTicket, #price_y');
    var pj = fieldNumber('#bSeat, #bTicket, #price_j');
    var pf = fieldNumber('#fSeat, #fTicket, #price_f');
    var pl = fieldNumber('#price_l');
    var ph = fieldNumber('#price_h');
    if (pl > 0 && ph > 0) {
        nativePrices = { type: 'cargo', l: pl, h: ph, source: 'route fields'};
    } else if (py > 0 && pj > 0 && pf > 0) {
        nativePrices = { type: 'pax', y: py, j: pj, f: pf, source: 'route fields'};
    } else {
        // A fresh panel can leave the fields empty until Auto is pressed, but its onclick
        // carries the game's own base Y/J/F values. Read those rather than guessing the
        // account mode's formula.
        var autoNode = box.querySelector('[onclick*="autoPrice"], [onclick*="ticketPriceSuggest"]');
        var autoCode = autoNode ? String(autoNode.getAttribute('onclick') || '') : String(html || '');
        var am = autoCode.match(/(?:autoPrice|ticketPriceSuggest)\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
        if (am) {
            py = parseFloat(am[1]); pj = parseFloat(am[2]); pf = parseFloat(am[3]);
            if (py > 0 && pj > 0 && pf > 0) {
                nativePrices = { type: 'pax', y: py, j: pj, f: pf, source: 'game Auto values'};
            }
        }
    }
    var distKm = route ? toN(route[2]) : null;
    return {
        hasCreate: /btnCreateNewRoute/.test(html),
        rangeKm: specs ? toN(specs[1]) : null,
        speedKph: specs ? toN(specs[2]) : null,
        hubIcao: route ? route[1] : null,
        distKm: distKm,
        destIcao: route ? route[3] : null,
        demand: demand ? { y: toN(demand[1]), j: toN(demand[2]), f: toN(demand[3]) } : null,
        acOnRoute: acr ? toN(acr[1]) : null,
        routeRegDefault: reg || null,
        nativePrices: nativePrices
    };
}

// Read-only: load the config panel for plane+dest. NEVER mode=do (that would create).
function am4FleetFetchRouteConfig(planeId, destId) {
    return fetch('new_route_info.php?id=' + encodeURIComponent(planeId) + '&airportId=' + encodeURIComponent(destId) + '&mode=res', { credentials: 'include'})
        .then(function (r) { return r.text(); })
        .then(function (html) { return am4FleetParseRouteConfig(html); });
}

// Per-flight demand = shown daily demand / 2 (the demand is both directions over 24h,
// each one-way flight serves one). A class fills when installed seats <= per-flight demand.
function am4FleetSeatFill(cfg, demand) {
    var pf = { y: Math.floor((demand.y || 0) / 2), j: Math.floor((demand.j || 0) / 2), f: Math.floor((demand.f || 0) / 2) };
    var fills = {}, warnings = [];
    ['y','j','f' ].forEach(function (c) {
        if (cfg[c] <= 0) { fills[c] = null; return; }
        fills[c] = Math.min(100, Math.floor(pf[c] / cfg[c] * 100));
        if (pf[c] < cfg[c]) warnings.push(c.toUpperCase() + ' fills only ' + fills[c] + '% (' + pf[c] + ' demand/flight for ' + cfg[c] + ' seats)');
    });
    return { perFlight: pf, fills: fills, warnings: warnings };
}

// mode=do's e/b/f values are TICKET PRICES, not seat counts. The aircraft keeps its installed
// seat configuration. Earlier builds sent Y/J/F seat counts here, creating severely underpriced
// routes. Base tickets come from the game's own Auto values on the route panel — the same
// contract the Ultimate Auto Bot used — then the configured multipliers are applied. There is
// no Easy/Realism formula here: guessing the wrong mode would misprice every route.
function am4FleetPricePlan(rc, cargo) {
    if (!rc || cargo) return null;
    var n = rc.nativePrices;
    if (!n || n.type !== 'pax') return null;
    var y = Number(n.y), j = Number(n.j), f = Number(n.f);
    if (!(y > 0 && j > 0 && f > 0)) return null;
    return {
        type: 'pax',
        y: Math.floor(y * Number(AM4_CONFIG.paxMultiEco)),
        j: Math.floor(j * Number(AM4_CONFIG.paxMultiBiz)),
        f: Math.floor(f * Number(AM4_CONFIG.paxMultiFirst)),
        source: n.source
    };
}

function am4FleetBuildRouteUrl(planeId, destId, reg, prices, ci) {
    if (!prices || prices.type !== 'pax') return null;
    var intro = (typeof window.intro === 'number') ? window.intro : 0;
    return 'new_route_info.php?mode=do&id=' + encodeURIComponent(planeId) +
        '&airportId=' + encodeURIComponent(destId) + '&reg=' + encodeURIComponent(reg) +
        '&e=' + encodeURIComponent(prices.y) +
        '&b=' + encodeURIComponent(prices.j) +
        '&f=' + encodeURIComponent(prices.f) +
        '&endCostIndex=' + ci +
        '&stopoverId=0&ferry=0&intro=' + intro;
}

function am4FleetSetRouteMsg(msg, color) {
    var el = document.getElementById('am4RteMsg');
    if (el) { el.innerText = msg; el.style.color = color || '#38bdf8'; }
}

function am4FleetSelectedParked() {
    var sel = document.getElementById('am4RtePlane');
    if (!sel) return null;
    var pid = sel.value;
    var fromCandidates = am4FleetRouteCandidateCache.rows.filter(function (p) { return p.planeId === pid; })[0];
    if (fromCandidates) return fromCandidates;
    return am4FleetParkedCache.filter(function (p) { return p.planeId === pid; })[0] || null;
}

function am4FleetResetCreateBtn() {
    var btn = document.getElementById('am4RteCreate');
    if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }
    am4FleetRouteCheck = null;
}

function am4FleetRenderParkedPicker() {
    var sel = document.getElementById('am4RtePlane');
    if (!sel) return;
    sel.innerHTML ="<option value=''>reading parked aircraft…</option>" ;
    am4FleetListRouteCandidates(true, function (partial, tally) {
        if (!partial.length) {
            sel.innerHTML ="<option value=''>" + am4FleetEsc('checking landed at home — ' + tally) +"</option>" ;
            return;
        }
        sel.innerHTML = partial.map(am4FleetRouteOptionHtml).join('');
        am4FleetOnPlaneSelect();
    }).then(function (list) {
        if (!list.length) {
            sel.innerHTML ="<option value=''>" + am4FleetEsc('no aircraft at base — ' + am4FleetParkedTally) +"</option>" ;
            return;
        }
        sel.innerHTML = list.map(am4FleetRouteOptionHtml).join('');
        am4FleetOnPlaneSelect();
    }).catch(function () { sel.innerHTML ="<option value=''>could not read fleet</option>" ; });
}

var am4FleetPlaneHubCache = {};

function am4FleetSetDestNote(msg, color) {
    var el = document.getElementById('am4RteDestNote');
    if (!el) return;
    el.innerText = msg || '';
    el.style.color = color || '#64748b';
}

function am4FleetDestLabel(g) {
    var air = am4FleetResolveAirport(String(g.arrId));
    var icao = air ? (air.icao || air.iata || '') : '';
    var name = g.dest || (air && air.name) || '';
    var star = g.preferred ?'★ ' : '';
    var km = g.km ? (Number(g.km).toLocaleString() + ' km') : '';
    return star + (icao || g.arrId) + (km ? (' · ' + km) : '') + (name ? (' · ' + name) : '');
}

function am4FleetDestsFromHub(hubId) {
    hubId = String(hubId || '');
    if (!hubId || typeof am4ExpLoadCfg !== 'function') return [];
    var cfg = am4ExpLoadCfg();
    var ck = am4ExpCacheKey(hubId, cfg);
    var cache = am4ExpLoadCache();
    var mem = am4ExpResults[hubId];
    var res = (mem && mem.good && mem._ck === ck) ? mem : cache[ck];
    if (!res || !res.good || !res.good.length) return [];
    var fm = (typeof am4ExpBuildFlownMap === 'function') ? am4ExpBuildFlownMap() : { map: {} };
    var flown = (fm.map && fm.map[hubId]) || {};
    var out = res.good.filter(function (g) {
        return g && g.arrId && !g.built && !flown[String(g.arrId)];
    }).slice();
    out.sort(function (a, b) {
        return (Number(b.preferred) - Number(a.preferred)) || (b.km - a.km) || ((b.revPerDay || 0) - (a.revPerDay || 0));
    });
    return out;
}

function am4FleetFillDestSelect(hub, preferArrId) {
    var sel = document.getElementById('am4RteDest');
    if (!sel) return [];
    var hubId = hub && hub.hubId ? String(hub.hubId) : '';
    var hubIcao = (hub && hub.hubIcao) || '';
    var dests = hubId ? am4FleetDestsFromHub(hubId) : [];
    var prefer = preferArrId ? String(preferArrId) : '';
    var preferOk = false;
    if (!hubId) {
        sel.innerHTML ="<option value=''>scan this hub in Explorer</option>" ;
        am4FleetSetDestNote('Home hub is unknown — scan it in Explorer first.','#f59e0b');
        return [];
    }
    if (!dests.length) {
        sel.innerHTML ="<option value=''>scan this hub in Explorer</option>" ;
        var n = (typeof am4StratLoadCfg === 'function' ? am4StratLoadCfg().n : 2);
        var band = (typeof am4StratBand === 'function') ? am4StratBand(n, am4StratLoadCfg()) : null;
        var bandTxt = (band && band.possible)
            ? (Number(band.lo).toLocaleString() + '–' + Number(band.hi).toLocaleString() + ' km')
            : 'this strategy band';
        am4FleetSetDestNote('No unbuilt Strategy ' + n + ' routes cached for ' + (hubIcao || hubId) +
            ' (' + bandTxt + '). Scan this hub in Explorer at the current strategy — a previous N\'s cache is not reused.','#f59e0b');
        return [];
    }
    sel.innerHTML ="<option value=''>pick a researched route</option>" + dests.map(function (g) {
        if (prefer && String(g.arrId) === prefer) preferOk = true;
        return"<option value='" + am4FleetEsc(String(g.arrId)) +"'" +
            (prefer && String(g.arrId) === prefer ? " selected" : "") +">" +
            am4FleetEsc(am4FleetDestLabel(g)) +"</option>" ;
    }).join('');
    if (!preferOk) sel.value = '';
    var stratN = (typeof am4StratLoadCfg === 'function') ? am4StratLoadCfg().n : 2;
    am4FleetSetDestNote(dests.length + ' unbuilt Strategy ' + stratN + ' routes from ' + (hubIcao || hubId) +
        '. Check route is still required before Create.','#94a3b8');
    return dests;
}

function am4FleetProbeHubFromRouteConfig(p) {
    var destId = p && p.intendedDestId;
    if (!destId) {
        var aid = window.airportIconData || [];
        destId = aid.length ? aid[0].Id : null;
    }
    if (!p || !p.planeId || !destId) return Promise.resolve(null);
    return am4FleetFetchRouteConfig(p.planeId, destId).then(function (rc) {
        if (!rc || !rc.hubIcao) return null;
        var air = am4FleetResolveAirport(rc.hubIcao);
        return { hubId: air ? String(air.Id) : null, hubIcao: rc.hubIcao };
    }).catch(function () { return null; });
}

function am4FleetResolvePlaneHub(p) {
    if (!p || !p.planeId) return Promise.resolve(null);
    var cached = am4FleetPlaneHubCache[p.planeId];
    if (cached && cached.hubId) return Promise.resolve(cached);
    var fromClassify = function () {
        if (typeof am4RbClassifyFleet !== 'function') return Promise.resolve(null);
        return am4RbClassifyFleet(false).then(function (cls) {
            var hit = ((cls && cls.planes) || []).filter(function (x) {
                return String(x.aircraftId) === String(p.planeId) && x.hubCertain !== false;
            })[0];
            if (hit && hit.hubId) return { hubId: String(hit.hubId), hubIcao: hit.hubIcao || ''};
            return null;
        }).catch(function () { return null; });
    };
    var start = fromClassify();
    return start.then(function (hub) {
        if (hub && hub.hubId) {
            am4FleetPlaneHubCache[p.planeId] = hub;
            return hub;
        }
        return am4FleetProbeHubFromRouteConfig(p).then(function (probed) {
            if (probed && probed.hubId) am4FleetPlaneHubCache[p.planeId] = probed;
            return probed;
        });
    });
}

// Picking a plane fills researched unbuilt destinations for its home hub. The registration
// is still used as the route name; it is only pre-selected as destination if it is in band
// and not already built.
function am4FleetOnPlaneSelect() {
    var p = am4FleetSelectedParked();
    var dest = document.getElementById('am4RteDest');
    var reg = document.getElementById('am4RteReg');
    var info = document.getElementById('am4RteInfo');
    if (reg) reg.value = p ? (p.reg || '') : '';
    if (info) info.innerHTML = '';
    am4FleetSetRouteMsg('','#38bdf8');
    am4FleetResetCreateBtn();
    if (!p) {
        if (dest) dest.innerHTML ="<option value=''>pick an aircraft first</option>" ;
        am4FleetSetDestNote('','#64748b');
        return;
    }
    if (dest) dest.innerHTML ="<option value=''>reading home hub…</option>" ;
    am4FleetSetDestNote('Reading this plane\'s home hub…','#94a3b8');
    var wantPlane = p.planeId;
    am4FleetResolvePlaneHub(p).then(function (hub) {
        if ((am4FleetSelectedParked() || {}).planeId !== wantPlane) return;
        var prefer = p.intendedDestId || '';
        am4FleetFillDestSelect(hub, prefer);
    }).catch(function () {
        if ((am4FleetSelectedParked() || {}).planeId !== wantPlane) return;
        am4FleetFillDestSelect(null,'');
    });
}

//================================================================================
// DETAILS-CLICK ROUTE ENGINE (same sequence as Ultimate Auto Bot)
// User clicks Details. That is what binds the PHP/session aircraft. Preflight
// reads range/origin/runway from the open card, then the suite clicks the live
// Research tab: #popBtn3 → Ajax('research_main.php','routeAction',...). The
// native URL has no aircraft id — do not rewrite it. Then fill search, pick a
// route with <2 A/C, create via new_route_info.php?id=<locked>&ferry=0.
// Never clicks Modify or Maintenance. Never clicks the landed-list leftover plane.
//================================================================================
var AM4_RTE_DETAILS_SEL = 'button[onclick*="mode=details"], #singleDeparter button[onclick*="details"], button[onclick*="fleet_details.php"], button[onclick*="showFlightInfo"]';
var AM4_RTE_RESEARCH_SEL = '#popBtn3, button[onclick*="research_main.php"], button[onclick*="research-main.php"]';
var AM4_RTE_MAX_AC_ON_ROUTE = 1;
var AM4_RTE_MAX_ATTEMPTS = 30;
var AM4_RTE_TICK_MS = 280;
var AM4_RTE_SUBMIT_TIMEOUT_MS = 20000;
var am4Rte = {
    state: 'IDLE', enteredAt: 0, timer: null, gen: 0,
    planeId: '', reg: '', specs: null,
    rejected: {}, attempted: {}, attemptCount: 0,
    selectedRow: null, selectedId: '', selectedLabel: '',
    detailsButton: null,
    detailsBefore: '', acceptedSig: '', backstepSig: '',
    backstepClicks: 0, deselectClicked: false,
    autoPriceClicked: false, pricesApplied: false, confirmClicked: false,
    actionDone: false, submitSig: '',
    arrId: '', arrIdSource: '', depId: '', arrCode: '', depCode: '',
    nextClicked: false, fixAttempts: 0, seenReg: '',
    createAt: 0, directOpen: false, mountClicked: false,
    recoverWaitUntil: 0, recoverRequested: false,
    suggestionDrawn: false, ajaxAfterDraw: false, hideStubLogged: false,
    lastPlaneId: '',
    staleReg: '', staleOrigin: '', staleRange: 0, waitLogged: false,
    researchBefore: '', researchClickAt: 0, resultsBefore: '', demandClicked: false, sawEmptyResults: false,
    hubResolveBusy: false, hubResolveDone: false,
    headless: { phase: '', rc: null, prices: null, error: '', body: '', retried: false, gen: 0 }
};
var am4RteListenerOn = false;

function am4RteLog(msg, level) {
    var mark = level === 'warn' ?'⚠ ' : (level === 'error' ?'✖ ' : '');
    am4LogAction('research','🔎 ' + mark + msg);
}

function am4RteNorm(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
}
function am4RteNum(s) { return parseInt(String(s || '').replace(/[^0-9]/g,''), 10) || 0; }
function am4RteElapsed() { return Date.now() - (am4Rte.enteredAt || 0); }

function am4RteExtractAircraftId(text) {
    var value = String(text || '');
    var patterns = [
        /fleet_details\.php\?id=(\d+)/i,
        /new_route_info\.php\?id=(\d+)/i,
        /research_main\.php\?id=(\d+)/i,
        /showFlightInfo\s*\(\s*[^,]+,\s*(\d+)/i,
        /maint_plan_do\.php[^"'<>]*[?&]id=(\d+)/i,
        /maintenance_main\.php\?action=(\d+)/i,
        /[?&]id=(\d+)/i
    ];
    for (var i = 0; i < patterns.length; i++) {
        var m = value.match(patterns[i]);
        if (m) return m[1];
    }
    return '';
}

function am4RteExtractLockedId(text) {
    var value = String(text || '');
    var m = value.match(/research_main\.php\?id=(\d+)/i) ||
        value.match(/fleet_details\.php\?id=(\d+)/i);
    return m ? m[1] : '';
}

function am4RteAircraftId(el) {
    if (!el || !el.getAttribute) return '';
    var direct = am4RteExtractAircraftId(el.getAttribute('onclick')) ||
        am4RteExtractAircraftId(el.getAttribute('href'));
    if (direct) return direct;
    var node = el, depth = 0;
    while (node && node.getAttribute && depth < 4) {
        var data = node.getAttribute('data-ac-id') || node.getAttribute('data-aircraft-id') ||
            (depth === 0 ? node.getAttribute('data-id') : null);
        if (data && /^\d+$/.test(String(data).trim())) return String(data).trim();
        node = node.parentElement;
        depth++;
    }
    return '';
}

function am4RteInsideExcluded(el) {
    return !!(el && el.closest && el.closest('#landedList, #pendingList, #flightInfoSecContainerContent'));
}

function am4RteIsForbidden(el) {
    if (!el || !el.getAttribute) return true;
    var oc = String(el.getAttribute('onclick') || '');
    if (/maint_plan_do\.php\?[^"'<>]*type=modify/i.test(oc)) return true;
    if (/maintenance_main\.php/i.test(oc)) return true;
    if (/mode=details/i.test(oc)) return true;
    if (el.closest && (el.closest('#list-actions') || el.closest('[id^="controls"]'))) {
        if (/modify/i.test(oc) || /maintenance_main/i.test(oc) || /maint_plan_do/i.test(oc)) return true;
    }
    return false;
}

function am4RteVisible(el) {
    return typeof am4IsElementClickable === 'function' ? am4IsElementClickable(el) : !!(el && el.offsetWidth);
}

function am4RteRoot() {
    var candidates = [
        document.getElementById('popup'),
        document.getElementById('box'),
        document.querySelector('.modal.show'),
        document.querySelector('.modal-content')
    ];
    for (var i = 0; i < candidates.length; i++) {
        if (candidates[i] && am4RteVisible(candidates[i])) return candidates[i];
    }
    var routeAction = document.getElementById('routeAction');
    if (routeAction && am4RteVisible(routeAction)) {
        return (routeAction.closest && routeAction.closest('#popup')) || routeAction;
    }
    return document;
}

function am4RteFindResearchButton() {
    var btn = document.querySelector('#popBtn3');
    var oc = btn ? String(btn.getAttribute('onclick') || '') : '';
    if (btn && /research_main\.php/i.test(oc) && am4RteVisible(btn)) return btn;
    var root = document.getElementById('popup') || document;
    var nodes = root.querySelectorAll('#popBtn3, button[onclick*="research_main.php"], button[onclick*="research-main.php"]');
    for (var i = 0; i < nodes.length; i++) {
        var code = String(nodes[i].getAttribute('onclick') || '');
        if (!/research_main\.php/i.test(code)) continue;
        if (am4RteVisible(nodes[i])) return nodes[i];
    }
    return null;
}

function am4RteClickResearch(btn) {
    if (!btn || !btn.isConnected) return false;
    var oc = String(btn.getAttribute('onclick') || '');
    if (!/research_main\.php/i.test(oc)) {
        am4RteLog('refused click (Research): that button is not research_main.php','warn');
        return false;
    }
    am4RteLog('clicked Research');
    return humanClick(btn);
}

function am4RteVisibleOne(root, selectors) {
    root = root || document;
    var list = typeof selectors === 'string' ? selectors.split(',') : selectors;
    for (var s = 0; s < list.length; s++) {
        var nodes = root.querySelectorAll(list[s].trim());
        for (var i = 0; i < nodes.length; i++) {
            if (am4RteInsideExcluded(nodes[i])) continue;
            if (am4RteIsForbidden(nodes[i])) continue;
            if (am4RteVisible(nodes[i])) return nodes[i];
        }
    }
    return null;
}

function am4RteClick(el, why) {
    if (!el || am4RteIsForbidden(el) || am4RteInsideExcluded(el)) {
        am4RteLog('refused click (' + why + ')','warn');
        return false;
    }
    am4RteLog('clicked ' + why);
    return humanClick(el);
}

function am4RteClickLockedDetails(why) {
    var btn = am4Rte.detailsButton;
    if (!btn || !btn.isConnected) return false;
    var oc = String(btn.getAttribute('onclick') || '');
    if (!/mode=details|fleet_details|showFlightInfo/i.test(oc)) {
        am4RteLog('refused click (' + why + '): not a Details control','warn');
        return false;
    }
    am4RteLog('clicked ' + why);
    return humanClick(btn);
}

function am4RteDetailsPanel() {
    return document.getElementById('detailsGroundedBg') ||
        document.getElementById('detailsAction') ||
        document.querySelector('[id*="detailsGrounded"]');
}

function am4RtePanelAircraftId(panel) {
    panel = panel || am4RteDetailsPanel();
    if (!panel) return '';
    return am4RteExtractLockedId(panel.innerHTML) || '';
}

function am4RteResearchFormSig() {
    var ra = document.getElementById('routeAction');
    var hub = document.getElementById('hubSelect');
    var dist = document.getElementById('maxDist');
    var rwy = document.getElementById('rwyLength');
    return [
        ra ? String(ra.innerHTML || '').length : 0,
        hub ? hub.options.length : 0,
        dist ? String(dist.value) : '',
        rwy ? String(rwy.value) : '' 
    ].join('|');
}

function am4RteResultsSig() {
    var table = am4RteTable();
    if (!table) return '';
    var rows = am4RteRows(table);
    return rows.length + ':' + (rows[0] ? am4RteRouteId(rows[0]) : '');
}

function am4RteLockedIsCargo() {
    try {
        if (typeof am4AircraftIsCargo === 'function' && am4AircraftIsCargo()) { return true; }
    } catch (e) { /* ignore */ }
    try {
        var sd = window.statusData && am4Rte.planeId && window.statusData[am4Rte.planeId];
        if (sd && sd.cargo) { return true; }
    } catch (e2) { /* ignore */ }
    var panel = am4RteDetailsPanel();
    var blob = ((panel && panel.innerText) || '') + ' ' + ((am4Rte.specs && am4Rte.specs.reg) || '');
    return /large load|heavy load|freighter|\bcargo\b/i.test(blob);
}

function am4RteClickDemandClass() {
    var root = document.getElementById('routeAction') || am4RteRoot();
    if (!root) return false;
    var cargo = am4RteLockedIsCargo();
    var nodes = root.querySelectorAll('button, a, span, label, div, th, td');
    for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        if (el.closest && el.closest('.sorter[data-distance], .row.border.sorter, #list')) continue;
        if (!am4RteVisible(el)) continue;
        var text = String(el.innerText || el.textContent || '').replace(/\s+/g,' ').trim();
        var oc = String(el.getAttribute('onclick') || '');
        if (!cargo && (/^Y$/i.test(text) || /data-yclass|yclass|type=['"]?y\b/i.test(oc))) {
            am4RteLog('clicked Y (pax demand)');
            return humanClick(el);
        }
        if (cargo && (/^Large$/i.test(text) || /data-large|cLarge|type=['"]?l\b/i.test(oc))) {
            am4RteLog('clicked Large (cargo demand)');
            return humanClick(el);
        }
    }
    return false;
}

function am4RtePanelMatchesLocked() {
    var live = am4RteExtractSpecs();
    if (!live || !live.range) {
        return { ok: false, live: live, reason: 'card not ready'};
    }
    // Only wait when this click is a different aircraft than the last locked one.
    // Same-plane / first-plane clicks keep the open card; that is not leftover.
    var differentClick = !!(am4Rte.planeId && am4Rte.lastPlaneId &&
        am4Rte.planeId !== am4Rte.lastPlaneId);
    if (!differentClick) {
        return { ok: true, live: live, reason: ''};
    }
    var sameReg = !!(am4Rte.staleReg && live.reg && am4RteRegsMatch(live.reg, am4Rte.staleReg));
    var sameOrigin = !!(am4Rte.staleOrigin && live.origin &&
        am4RteNorm(live.origin) === am4RteNorm(am4Rte.staleOrigin));
    var sameRange = !!(am4Rte.staleRange && live.range &&
        am4RteNum(live.range) === am4RteNum(am4Rte.staleRange));
    if (sameReg || (sameOrigin && sameRange)) {
        return {
            ok: false,
            live: live,
            reason: live.reg || am4Rte.staleReg || 'previous aircraft' 
        };
    }
    return { ok: true, live: live, reason: ''};
}

function am4RteSetValue(el, value) {
    if (!el) return;
    var proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto,'value');
    if (desc && desc.set) desc.set.call(el, String(value));
    else el.value = String(value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
}

function am4RteDetailsPane() {
    var root = am4RteRoot();
    return root.querySelector('#rDetails') || document.getElementById('rDetails') ||
        root.querySelector('.route-details-pop');
}

function am4RteSig(pane) {
    if (!pane) return '';
    return am4RteNorm(pane.innerText || pane.textContent || '').slice(0, 600);
}

function am4RteOriginBadLabel(norm, raw) {
    if (!norm || norm.length < 2) return true;
    var label = String(raw || norm);
    if (/[\/\\]/.test(label)) return true;
    if (/\b(flight\s*hours?|hours?\s*to\s*check|cycles?|charter\s*hours?|wear|at base|not at base|inbound|outbound|pending|timer|utc)\b/i.test(label)) return true;
    return /^(aircraft|route|routes|status|maintenance|plan|research|details|grounded|parked|routed|cargo|pax|passenger|freighter|model|type|class|speed|range|runway|rwy|engine|fuel|co2|seat|seats|large|heavy|economy|business|first|vip|loading|depart|arrive|flight|flights|name|registration|reg|airline|manager|total|daily|weekly|monthly|cost|price|profit|load|factor|utilization|turnaround|turn|around|hours|days|weeks|yes|no|on|off|new|old|next|back|close|open|select|none|unknown|n a|na)$/.test(norm) ||
        /^y class|^j class|^f class|^l class|^h class/.test(norm) ||
        /^(flight hours cycles|hours to check|flight hours|hours cycles)$/.test(norm) ||
        /^\d+$/.test(norm);
}

function am4RteOwnedHubNames() {
    var hubs = (am4ExpMeta && am4ExpMeta.hubs) || [];
    if (hubs.length) return hubs;
    try {
        var cached = typeof am4ExpMetaCached === 'function' ? am4ExpMetaCached() : null;
        if (cached && cached.hubs && cached.hubs.length) return cached.hubs;
    } catch (eHub) { /* ignore */ }
    var sel = document.querySelector('#hubSelect');
    if (sel && sel.options && sel.options.length) {
        var out = [];
        for (var i = 0; i < sel.options.length; i++) {
            var v = String(sel.options[i].value || '');
            var t = String(sel.options[i].textContent || '').replace(/\s+/g,' ').trim();
            if (v && /^\d+$/.test(v) && t) out.push({ id: v, name: t });
        }
        if (out.length) return out;
    }
    return [];
}

function am4RteDetailsSearchBlob() {
    var parts = [];
    ['detailsGroundedBg','detailsAction','popContent','popup','flightInfo','box' ].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) parts.push(el.innerText || el.textContent || '');
    });
    return parts.join(' ').replace(/\s+/g,' ').trim();
}

function am4RteHubScoreInText(name, blobLow) {
    var score = 0;
    var hubName = String(name || '').replace(/\s+/g,' ').trim();
    if (!hubName || !blobLow) return 0;
    if (blobLow.indexOf(hubName.toLowerCase()) !== -1) score = 220 + hubName.length;
    else {
        var city = hubName.split(',')[0].trim();
        if (city.length >= 4 && blobLow.indexOf(city.toLowerCase()) !== -1) score = 170 + city.length;
    }
    if (!score && typeof am4FleetHubKey === 'function') {
        var hk = am4FleetHubKey(hubName);
        var words = hk.split(' ').filter(function (w) { return w.length >= 4; });
        var matched = 0;
        for (var w = 0; w < words.length; w++) {
            if (blobLow.indexOf(words[w]) !== -1) matched++;
        }
        if (matched >= 2 || (matched === 1 && words.length === 1 && words[0].length >= 6)) score = 130 + matched * 20;
    }
    return score;
}

function am4RteFindOwnedHubInText(text) {
    var blob = String(text || '').replace(/\s+/g,' ').trim();
    if (!blob) return '';
    var blobLow = blob.toLowerCase();
    var hubs = am4RteOwnedHubNames();
    var best = { name: '', score: 0 };
    for (var i = 0; i < hubs.length; i++) {
        var sc = am4RteHubScoreInText(hubs[i].name, blobLow);
        if (sc > best.score) best = { name: String(hubs[i].name || '').trim(), score: sc };
    }
    return best.name;
}

function am4RteMatchHubFromPanelText(select) {
    if (!select || !select.options) return null;
    var blob = am4RteDetailsSearchBlob();
    if (!blob) return null;
    var blobLow = blob.toLowerCase();
    var best = null, tied = false;
    for (var i = 0; i < select.options.length; i++) {
        var opt = select.options[i];
        if (!opt.value || !/^\d+$/.test(String(opt.value))) continue;
        var score = am4RteHubScoreInText(opt.textContent, blobLow);
        if (!score) continue;
        if (best && score === best.score) tied = true;
        if (!best || score > best.score) { best = { option: opt, index: i, score: score }; tied = false; }
    }
    return best && !tied ? best : null;
}

function am4RteHubNameFromResolved(hub) {
    if (!hub) return '';
    var hubs = am4RteOwnedHubNames();
    var i;
    for (i = 0; i < hubs.length; i++) {
        if (String(hubs[i].id) === String(hub.hubId)) return String(hubs[i].name || '').trim();
    }
    if (hub.hubName) return String(hub.hubName).trim();
    if (hub.hubIcao && typeof am4FleetResolveAirport === 'function') {
        var air = am4FleetResolveAirport(hub.hubIcao);
        if (air && air.name) return String(air.name).trim();
    }
    return String(hub.hubIcao || '').trim();
}

function am4RteResolveHubFromFleetDetails(planeId) {
    return am4RteGameGet('fleet_details.php?id=' + encodeURIComponent(planeId)).then(function (res) {
        var html = (res && res.body) || '';
        if (!html || html.length < 80) return null;
        var fromText = am4RteFindOwnedHubInText(html);
        if (fromText) {
            var hubs = am4RteOwnedHubNames();
            for (var i = 0; i < hubs.length; i++) {
                if (String(hubs[i].name || '').trim() === fromText) {
                    return { hubId: String(hubs[i].id), hubIcao: '', hubName: fromText };
                }
            }
        }
        var box = document.createElement('div');
        box.innerHTML = html;
        var ends = [];
        box.querySelectorAll('.col-5.bg-light span.l-text.exo').forEach(function (el) {
            var t = (el.textContent || '').trim();
            if (/^[A-Z0-9]{3,4}$/.test(t)) ends.push(t);
        });
        var hubIds = {};
        am4RteOwnedHubNames().forEach(function (h) { hubIds[String(h.id)] = h.name; });
        var byIcao = {};
        (window.airportIconData || []).forEach(function (a) {
            if (!a) return;
            if (a.icao) byIcao[String(a.icao).toUpperCase()] = a;
            if (a.iata) byIcao[String(a.iata).toUpperCase()] = a;
        });
        var routeM = html.match(/([A-Z]{3,4})\s+[\d,]+\s*km\s+([A-Z]{3,4})/);
        if (routeM) {
            ends.push(routeM[1]);
            ends.push(routeM[2]);
        }
        var ei, code, airEnd;
        for (ei = 0; ei < ends.length; ei++) {
            code = ends[ei];
            airEnd = byIcao[String(code).toUpperCase()];
            if (airEnd && hubIds[String(airEnd.Id)]) {
                return {
                    hubId: String(airEnd.Id),
                    hubIcao: code,
                    hubName: hubIds[String(airEnd.Id)]
                };
            }
        }
        return null;
    });
}

function am4RteResolvePlaneHub(planeId) {
    planeId = String(planeId || '');
    if (!planeId) return Promise.resolve(null);
    if (typeof am4FleetResolvePlaneHub === 'function') {
        return am4FleetResolvePlaneHub({ planeId: planeId }).then(function (hub) {
            if (hub && hub.hubId) {
                return {
                    hubId: String(hub.hubId),
                    hubIcao: hub.hubIcao || '',
                    hubName: am4RteHubNameFromResolved(hub)
                };
            }
            return am4RteResolveHubFromFleetDetails(planeId);
        }).catch(function () {
            return am4RteResolveHubFromFleetDetails(planeId);
        });
    }
    return am4RteResolveHubFromFleetDetails(planeId);
}

function am4RteEnsurePlaneHub(cb) {
    if (am4Rte.specs && am4Rte.specs.hubId && am4Rte.specs.originLabel &&
        !am4RteOriginBadLabel(am4Rte.specs.origin, am4Rte.specs.originLabel)) {
        if (typeof cb === 'function') cb(true);
        return;
    }
    if (!am4Rte.planeId) {
        if (typeof cb === 'function') cb(false);
        return;
    }
    if (am4Rte.hubResolveDone) {
        if (typeof cb === 'function') cb(!!(am4Rte.specs && am4Rte.specs.hubId));
        return;
    }
    if (am4Rte.hubResolveBusy) return;
    am4Rte.hubResolveBusy = true;
    am4RteResolvePlaneHub(am4Rte.planeId).then(function (hub) {
        am4Rte.hubResolveBusy = false;
        am4Rte.hubResolveDone = true;
        if (hub && hub.hubId && am4Rte.specs) {
            am4Rte.specs.hubId = String(hub.hubId);
            am4Rte.specs.originLabel = hub.hubName || am4RteHubNameFromResolved(hub);
            am4Rte.specs.origin = am4RteNorm(am4Rte.specs.originLabel);
            am4RteLog('resolved home hub ' + am4Rte.specs.originLabel + ' (id ' + hub.hubId + ') from fleet_details');
        }
        if (typeof cb === 'function') cb(!!(hub && hub.hubId));
    }).catch(function () {
        am4Rte.hubResolveBusy = false;
        am4Rte.hubResolveDone = true;
        if (typeof cb === 'function') cb(false);
    });
}

function am4RteOriginCandidateScore(raw) {
    var label = String(raw || '').replace(/\s+/g,' ').trim();
    if (!label || label.length < 3 || label.length > 120) return 0;
    var norm = am4RteNorm(label);
    if (am4RteOriginBadLabel(norm, label)) return 0;
    var score = 10 + Math.min(label.length, 40);
    if (/,/.test(label)) score += 55;
    if (/\b(south korea|united states|united kingdom|canada|australia|germany|france|japan|china|india|brazil|mexico|spain|italy|netherlands|uae|qatar|singapore|hong kong)\b/i.test(label)) score += 25;
    if (/^[A-Z]{3,4}$/.test(label.trim()) && typeof am4FleetResolveAirport === 'function' && am4FleetResolveAirport(label)) score += 70;
    var owned = am4RteOwnedHubNames();
    var i, hk, tight = typeof am4FleetHubKeyTight === 'function' ? am4FleetHubKeyTight(label) : norm.replace(/ /g,'');
    for (i = 0; i < owned.length; i++) {
        hk = owned[i].name || '';
        if (!hk) continue;
        if (typeof am4FleetHubKeyTight === 'function' && am4FleetHubKeyTight(hk) === tight) score += 120;
        else if (typeof am4FleetHubKey === 'function') {
            var k1 = am4FleetHubKey(label), k2 = am4FleetHubKey(hk);
            if (k1 && k2 && k1 === k2) score += 110;
            else if (k1 && k2 && ((k1 + ' ').indexOf(k2 + ' ') === 0 || (k2 + ' ').indexOf(k1 + ' ') === 0)) score += 80;
        }
    }
    if (!/,/.test(label) && norm.split(' ').length === 1 && norm.length < 8 && score < 70) score = 0;
    return score;
}

function am4RtePickOriginLabel(panel, panelText) {
    var blob = am4RteDetailsSearchBlob() || String(panelText || '');
    // Most reliable: an owned hub name appears somewhere in the open Details popup.
    var fromOwned = am4RteFindOwnedHubInText(blob);
    if (fromOwned) return fromOwned;
    var best = { label: '', score: 0 };
    function consider(raw) {
        var sc = am4RteOriginCandidateScore(raw);
        if (sc > best.score) best = { label: String(raw || '').replace(/\s+/g,' ').trim(), score: sc };
    }
    var routeM = String(blob || '').match(/\b([A-Z]{3,4})\s+[\d,]+\s*km\s+[A-Z]{3,4}\b/);
    if (routeM && typeof am4FleetResolveAirport === 'function') {
        var air = am4FleetResolveAirport(routeM[1]);
        if (air && air.name) consider(air.name);
    }
    if (panel) {
        var texts = panel.querySelectorAll('.s-text');
        for (var t = 0; t < texts.length; t++) consider(texts[t].innerText);
        var centers = panel.querySelectorAll('.col-sm-6.text-center, .text-center');
        for (var c = 0; c < centers.length; c++) {
            var ct = String(centers[c].innerText || '').replace(/\s+/g,' ').trim();
            if (ct.indexOf(',') !== -1) consider((ct.split('\n')[0] || ct).trim());
        }
    }
    return best.label;
}

function am4RteExtractSpecs() {
    var panel = document.getElementById('detailsGroundedBg') ||
        document.getElementById('detailsAction') ||
        document.querySelector('[id*="detailsGrounded"]');
    if (!panel) return null;
    var panelText = String(panel.innerText || '').replace(/\s+/g,' ');
    var range = 0, speed = 0, runway = 0;
    var rangeNode = document.querySelector('#detailsGroundedBg > div.col-sm-6.bg-light.border > div > div:nth-child(1)');
    var rangeText = rangeNode ? String(rangeNode.innerText || '').replace(/\s+/g,' ') : panelText;
    var kmM = rangeText.match(/([\d,.]+)\s*km/i);
    var kphM = rangeText.match(/([\d,.]+)\s*kph/i);
    if (kmM) range = am4RteNum(kmM[1]);
    if (kphM) speed = am4RteNum(kphM[1]);
    if (!range) {
        var allKm = panelText.match(/([\d,.]+)\s*km/ig) || [];
        for (var i = 0; i < allKm.length; i++) {
            var v = am4RteNum(allKm[i]);
            if (v >= 100 && v <= 30000) { range = v; break; }
        }
    }
    var rwyNode = document.querySelector('#detailsGroundedBg > div.col-sm-6.bg-light.border > div > div:nth-child(2) > span:nth-child(7)');
    if (rwyNode) runway = am4RteNum(rwyNode.innerText || rwyNode.textContent);
    if (!runway || runway < 100 || runway > 20000) {
        var rwyM = panelText.match(/([\d,.]+)\s*(?:m|ft)\b/i);
        runway = rwyM ? am4RteNum(rwyM[1]) : 0;
        if (runway < 100 || runway > 20000) runway = 0;
    }
    var originLabel = am4RtePickOriginLabel(panel, panelText);
    var origin = am4RteNorm(originLabel);
    var nameEl = document.getElementById('ff-name');
    var reg = nameEl ? String(nameEl.innerText || '').replace(/\s+/g,' ').trim() : '';
    if (!range) return null;
    return { range: range, runway: runway, origin: origin, originLabel: originLabel || origin, speed: speed, reg: reg };
}

function am4RteLearnSpeed(specs) {
    if (!specs || !specs.speed || specs.speed < 200 || specs.speed > 3000) return;
    var p = am4AircraftProfile();
    if (p.cruiseStock) return;
    am4AircraftSet({ cruiseStock: specs.speed, cruiseMod: Math.round(specs.speed * 1.1) });
    if (typeof am4StrategyRender === 'function') am4StrategyRender();
}

function am4RteMatchHub(select, origin) {
    if (!select || !select.options) return null;
    var labels = [String(origin || '')];
    if (am4Rte.specs && am4Rte.specs.originLabel && labels.indexOf(am4Rte.specs.originLabel) === -1) {
        labels.push(am4Rte.specs.originLabel);
    }
    if (typeof am4FleetResolveAirport === 'function') {
        for (var li = 0; li < labels.length; li++) {
            var air = am4FleetResolveAirport(labels[li]);
            if (air && air.name && labels.indexOf(air.name) === -1) labels.push(air.name);
        }
    }
    var best = null, tied = false;
    for (var i = 0; i < select.options.length; i++) {
        var optText = String(select.options[i].textContent || '').replace(/\s+/g,' ').trim();
        var text = am4RteNorm(optText);
        var score = 0;
        for (var a = 0; a < labels.length; a++) {
            var alt = am4RteNorm(labels[a]);
            if (!alt) continue;
            if (text === alt) score = Math.max(score, 100);
            else if (typeof am4FleetHubKeyTight === 'function' &&
                am4FleetHubKeyTight(optText) === am4FleetHubKeyTight(labels[a])) score = Math.max(score, 98);
            else if (typeof am4FleetHubKey === 'function') {
                var k1 = am4FleetHubKey(labels[a]), k2 = am4FleetHubKey(optText);
                if (k1 && k2 && k1 === k2) score = Math.max(score, 95);
                else if (k1 && k2 && ((k1 + ' ').indexOf(k2 + ' ') === 0 || (k2 + ' ').indexOf(k1 + ' ') === 0)) score = Math.max(score, 85);
            }
            else if (text.indexOf(alt) === 0) score = Math.max(score, 80);
            else if (alt.indexOf(text) === 0 && text.length >= 4) score = Math.max(score, 70);
            else {
                var tw = alt.split(' '), ow = text.split(' ');
                if (tw[0] && ow[0] && tw[0] === ow[0] && tw[0].length >= 4) score = Math.max(score, 40);
            }
        }
        if (!score) continue;
        if (best && score === best.score) tied = true;
        if (!best || score > best.score) { best = { option: select.options[i], index: i, score: score }; tied = false; }
    }
    return best && !tied ? best : null;
}

function am4RteTable() {
    var root = am4RteRoot();
    return root.querySelector('#list') || document.getElementById('list') ||
        root.querySelector('#research_results_container');
}

function am4RteRows(table) {
    if (!table) return [];
    var rows = table.querySelectorAll('.row.border.sorter, .sorter[data-distance], [data-dep][data-arr]');
    return Array.prototype.slice.call(rows);
}

function am4RteRouteId(row) {
    if (!row) return '';
    var dep = am4RteNorm(row.getAttribute('data-dep'));
    var arr = am4RteNorm(row.getAttribute('data-arr'));
    if (dep && arr) return dep + '>' + arr;
    var label = row.querySelector('.exo') || row.querySelector('b') || row;
    return am4RteNorm(label.innerText || label.textContent || '').slice(0, 160);
}

function am4RteRouteLabel(row) {
    if (!row) return '';
    var label = row.querySelector('.exo') || row.querySelector('b') || row;
    return String(label.innerText || label.textContent || '').replace(/\[.*?\]/g,'').trim();
}

function am4RteDemandScore(row) {
    return am4RteNum(row.getAttribute('data-yclass')) +
        am4RteNum(row.getAttribute('data-jclass')) * 2 +
        am4RteNum(row.getAttribute('data-fclass')) * 3 +
        am4RteNum(row.getAttribute('data-large')) +
        am4RteNum(row.getAttribute('data-heavy')) * 0.7;
}

function am4RteChooseRow(table) {
    var rows = am4RteRows(table), best = null;
    for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var id = am4RteRouteId(row);
        if (!id || am4Rte.rejected[id] || am4Rte.attempted[id] || row.getAttribute('data-bot-rejected') === '1') continue;
        var score = am4RteDemandScore(row);
        if (!best || score > best.score) best = { row: row, id: id, label: am4RteRouteLabel(row), score: score };
    }
    return best;
}

function am4RteAcCount(pane) {
    if (!pane) return null;
    var rows = pane.querySelectorAll('tr');
    for (var i = 0; i < rows.length; i++) {
        var cells = rows[i].querySelectorAll('td, th');
        if (cells.length < 2) continue;
        var label = am4RteNorm(cells[0].innerText);
        if (label.indexOf('a c on route') !== -1 || label.indexOf('aircraft on route') !== -1) {
            return am4RteNum(cells[cells.length - 1].innerText);
        }
    }
    var m = String(pane.innerText || '').match(/(?:a\s*\/?\s*c|aircraft)\s+on\s+route[^\d]*(\d+)/i);
    return m ? am4RteNum(m[1]) : null;
}

function am4RteFindCreate(pane) {
    var roots = [pane, am4RteRoot(), document.getElementById('popup')].filter(Boolean);
    var sels = ['#sugNewRoute',"[onclick*='new_route_info']" ,'#newRouteNext',
        "[onclick*='drawRouteSuggestion']","button[onclick*='newRoute']" ,"button[onclick*='createRoute']" ];
    var locked = am4Rte.planeId, fallback = null, r, s, i;
    for (r = 0; r < roots.length; r++) {
        for (s = 0; s < sels.length; s++) {
            var nodes = roots[r].querySelectorAll(sels[s]);
            for (i = 0; i < nodes.length; i++) {
                if (!am4RteVisible(nodes[i]) || am4RteIsForbidden(nodes[i]) || am4RteInsideExcluded(nodes[i])) continue;
                if (nodes[i].id === 'btnCreateNewRoute' || nodes[i].id === 'introAuto') continue;
                var found = { element: nodes[i], acId: am4RteAircraftId(nodes[i]), sel: sels[s] };
                if (locked && found.acId && found.acId === locked) return found;
                if (!fallback) fallback = found;
            }
        }
        var btns = roots[r].querySelectorAll('button, a.btn, span.btn, input[type="button"]');
        for (i = 0; i < btns.length; i++) {
            if (!am4RteVisible(btns[i]) || am4RteIsForbidden(btns[i]) || am4RteInsideExcluded(btns[i])) continue;
            if (btns[i].id === 'btnCreateNewRoute' || btns[i].id === 'introAuto') continue;
            var text = am4RteNorm(btns[i].innerText || btns[i].value);
            if (!text || text.indexOf('create') === -1) continue;
            if (text.indexOf('research') !== -1 || text.indexOf('auto') !== -1) continue;
            var foundBtn = { element: btns[i], acId: am4RteAircraftId(btns[i]), sel: 'text: ' + text };
            if (locked && foundBtn.acId && foundBtn.acId === locked) return foundBtn;
            if (!fallback) fallback = foundBtn;
        }
    }
    return fallback;
}

function am4RteNumericAttr(node, name) {
    if (!node || !node.getAttribute) return '';
    var raw = String(node.getAttribute(name) || '').trim();
    return /^\d+$/.test(raw) ? raw : '';
}

function am4RteScanAirportId(root) {
    if (!root) return '';
    var pattern = /(?:airportId|arr)=(\d+)/i;
    var own = String((root.getAttribute && root.getAttribute('onclick')) || '') + ' ' +
        String((root.getAttribute && root.getAttribute('href')) || '');
    var ownMatch = own.match(pattern);
    if (ownMatch) return ownMatch[1];
    if (!root.querySelectorAll) return '';
    var nodes = root.querySelectorAll('[onclick], [href]');
    for (var i = 0; i < nodes.length; i++) {
        var text = String(nodes[i].getAttribute('onclick') || '') + ' ' +
            String(nodes[i].getAttribute('href') || '');
        var match = text.match(pattern);
        if (match) return match[1];
    }
    return '';
}

function am4RteAirportCode(value) {
    var code = String(value || '').replace(/^\s+|\s+$/g,'').toUpperCase();
    return /^[A-Z0-9]{3,4}$/.test(code) && /[A-Z]/.test(code) ? code : '';
}

function am4RteAirportIdFromCode(code) {
    var normalized = am4RteAirportCode(code);
    if (!normalized) return '';
    var aid = window.airportIconData || [];
    var i;
    for (i = 0; i < aid.length; i++) {
        if (aid[i] && String(aid[i].icao || '').toUpperCase() === normalized) return String(aid[i].Id);
    }
    for (i = 0; i < aid.length; i++) {
        if (aid[i] && String(aid[i].iata || '').toUpperCase() === normalized) return String(aid[i].Id);
    }
    return '';
}

function am4RteArrivalId() {
    if (am4Rte.arrId) return am4Rte.arrId;
    var fromRow = am4RteNumericAttr(am4Rte.selectedRow,'data-arr') || am4RteScanAirportId(am4Rte.selectedRow);
    if (fromRow) {
        am4Rte.arrId = fromRow;
        am4Rte.arrIdSource = 'selected row';
        return fromRow;
    }
    var fromPane = am4RteScanAirportId(am4RteDetailsPane());
    if (fromPane) {
        am4Rte.arrId = fromPane;
        am4Rte.arrIdSource = 'route details';
        return fromPane;
    }
    var fromCode = am4RteAirportIdFromCode(am4Rte.arrCode);
    if (fromCode) {
        am4Rte.arrId = fromCode;
        am4Rte.arrIdSource = 'airportIconData for ' + am4Rte.arrCode;
        return fromCode;
    }
    return '';
}

function am4RteNormReg(value) {
    return String(value || '').replace(/\s+/g,' ').trim().toUpperCase()
        .replace(/[^A-Z0-9-]/g,'').replace(/^-+|-+$/g,'');
}

function am4RteRegsMatch(a, b) {
    var left = am4RteNormReg(a), right = am4RteNormReg(b);
    return !!(left && right && left === right);
}

function am4RteReadCreationReg() {
    var empty = { reg: '', source: '#newRouteContainer header'};
    var container = document.getElementById('newRouteContainer');
    if (!container || am4RteInsideExcluded(container)) return empty;
    var node = document.querySelector('#newRouteContainer > div:nth-child(1) > div');
    if (!node || !container.contains(node)) node = container.querySelector('.blue-bg');
    if (!node || !container.contains(node) || am4RteInsideExcluded(node)) return empty;
    var i;
    for (i = 0; i < node.childNodes.length; i++) {
        var child = node.childNodes[i];
        if (child.nodeType !== 3) continue;
        var direct = am4RteNormReg(child.nodeValue);
        if (direct) return { reg: direct, source: '#newRouteContainer header'};
    }
    var clone = node.cloneNode(true);
    var kids = clone.querySelectorAll('*');
    for (i = 0; i < kids.length; i++) {
        if (kids[i].parentNode) kids[i].parentNode.removeChild(kids[i]);
    }
    return { reg: am4RteNormReg(clone.textContent), source: '#newRouteContainer header'};
}

function am4RteRunInlineScripts(root) {
    if (!root || !root.querySelectorAll) return;
    var scripts = root.querySelectorAll('script');
    for (var i = 0; i < scripts.length; i++) {
        var code = String(scripts[i].textContent || '');
        if (!code) continue;
        try { (new Function(code)).call(window); } catch (e) {
            am4RteLog('inline script in creation panel failed: ' + e.message,'warn');
        }
    }
}

function am4RteEnsureCreationTarget() {
    var nodes = document.querySelectorAll('#newRouteInfo');
    var target = null;
    var i;
    for (i = 0; i < nodes.length; i++) {
        if (nodes[i].closest && nodes[i].closest('#popup')) {
            try { nodes[i].parentNode.removeChild(nodes[i]); } catch (e) { /* ignore */ }
            continue;
        }
        target = nodes[i];
    }
    if (!target) {
        var host = document.getElementById('map') || document.body;
        target = document.createElement('div');
        target.id = 'newRouteInfo';
        target.style.top = '10px';
        target.style.left = '0px';
        target.style.zIndex = '1050';
        target.style.position = 'absolute';
        target.style.width = '100%';
        target.style.maxWidth = '500px';
        target.style.maxHeight = '99%';
        target.style.overflowY = 'auto';
        host.appendChild(target);
        am4RteLog('created map-layer #newRouteInfo so the locked-id request has a place to land');
    }
    return target;
}

function am4RteRevealCreation() {
    var ids = ['newRouteInfo','newRouteContainer' ];
    for (var i = 0; i < ids.length; i++) {
        var el = document.getElementById(ids[i]);
        if (!el) continue;
        el.classList.remove('hidden');
        el.style.display = 'block';
        el.style.visibility = 'visible';
        el.style.opacity = '1';
        if (el.id === 'newRouteInfo') el.style.zIndex = '20000';
        if (typeof jQuery !== 'undefined') {
            try { jQuery(el).show(); } catch (e) { /* ignore */ }
        }
    }
}

function am4RteCreationHasContent(root) {
    if (!root) return false;
    if (am4RteCreationHasForm(root)) return true;
    if (root.querySelector && root.querySelector('#newRouteNext, #newRouteContainer, .blue-bg')) return true;
    var text = String(root.innerText || root.textContent || '').replace(/\s+/g,' ').trim();
    return text.length > 80;
}

function am4RteCreationLooksHiddenStub(root) {
    if (!root) return false;
    var html = String(root.innerHTML || '').replace(/\s+/g,' ').trim();
    return html.length < 200 && /#newRouteInfo['"]\)\.hide\(/.test(html);
}

function am4RteInjectCreation(url) {
    var target = document.getElementById('newRouteInfo');
    if (!target) return false;
    var fb = (typeof window.fbSig !== 'undefined' && window.fbSig != null) ? String(window.fbSig) : '';
    if (fb && url.indexOf('fbSig=') === -1) {
        url += (url.indexOf('?') === -1 ?'?' : '&') + 'fbSig=' + encodeURIComponent(fb);
    }
    try {
        var xhr = new XMLHttpRequest();
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) return;
            if (xhr.status < 200 || xhr.status >= 300) {
                am4RteLog('creation request returned HTTP ' + xhr.status,'warn');
                return;
            }
            var body = xhr.responseText || '';
            if (body.length < 120) {
                am4RteLog('creation request returned only ' + body.length +
                    ' chars: ' + body.replace(/\s+/g,' ').substring(0, 120),'warn');
            }
            if (!body || body.length < 80) return;
            if (/#newRouteInfo['"]\)\.hide\(/.test(body) && body.length < 200) {
                am4RteLog('server hid #newRouteInfo — not overwriting the panel with a hide stub','warn');
                return;
            }
            target.innerHTML = body;
            am4RteRunInlineScripts(target);
            am4RteRevealCreation();
            am4RteLog('injected creation HTML for locked id ' + (am4Rte.planeId || '?') +
                ' (' + body.length + ' chars)');
        };
        xhr.open('GET', url, true);
        xhr.withCredentials = true;
        xhr.send();
        return true;
    } catch (error) {
        am4RteLog('creation inject failed: ' + error.message,'warn');
        return false;
    }
}

function am4RteRewriteResearchUrl(url, planeId) {
    var next = String(url || '');
    var id = String(planeId || '');
    if (!id || !/research_main\.php/i.test(next)) return next;
    if (/research_main\.php\?id=\d+/i.test(next)) {
        return next.replace(/research_main\.php\?id=\d+/ig,'research_main.php?id=' + id);
    }
    return next.replace(/research_main\.php(\?|')/i, function (m, sep) {
        return sep === '?' ?'research_main.php?id=' + id + '&' : 'research_main.php?id=' + id + sep;
    });
}

function am4RteBindResearchClick(btn, planeId) {
    if (!btn || !planeId) return '';
    var oc = String(btn.getAttribute('onclick') || '');
    if (!oc || oc.indexOf('research_main.php') === -1) return oc;
    var next = am4RteRewriteResearchUrl(oc, planeId);
    if (next !== oc) {
        try { btn.setAttribute('onclick', next); } catch (e) { /* ignore */ }
        am4RteLog('rewrote Research click to research_main.php?id=' + planeId);
    }
    return next;
}

function am4RteStartLockedCreation(reason, createControl) {
    am4RteInstallAjaxGuard();
    am4RteBindLockedSelection();
    return Promise.resolve(am4RteOpenCreationDirect(reason, createControl));
}

function am4RteRequestCreationPanel(url) {
    var container = document.getElementById('newRouteContainer');
    if (container && container.parentNode) container.parentNode.removeChild(container);
    var jq = (typeof window.jQuery !== 'undefined' && window.jQuery.ajax) ? window.jQuery
        : ((typeof window.$ !== 'undefined' && window.$.ajax) ? window.$ : null);
    if (jq) {
        var parts = String(url || '').split('?');
        var fb = (typeof window.fbSig !== 'undefined' && window.fbSig != null) ? window.fbSig : '';
        var job = am4Rte.gen;
        jq.ajax({
            type: 'GET',
            url: parts[0],
            data: (parts[1] || '') + '&fbSig=' + fb,
            cache: false,
            dataType: 'html',
            success: function (response) {
                if (job !== am4Rte.gen) return;
                var body = response == null ?'' : String(response);
                am4RteLog('creation Ajax returned ' + body.length + ' chars for locked id ' +
                    (am4Rte.planeId || '?') + ' dest ' + (am4RteArrivalId() || '?'));
                if (am4RteHtmlIsHideStub(body)) {
                    am4Rte.hideStubLogged = true;
                    am4RteLog('server hid #newRouteInfo — left the map panel alone','warn');
                    return;
                }
                jq('#newRouteInfo').fadeIn(50).html(response);
            },
            error: function (xhr) {
                am4RteLog('creation Ajax HTTP ' + ((xhr && xhr.status) || 0) + ' failed','warn');
            }
        });
        return"the game's Ajax() into #newRouteInfo" ;
    }
    if (typeof window.Ajax === 'function') {
        try {
            window.Ajax(url,'newRouteInfo', false, false, true);
            return"the game's Ajax()" ;
        } catch (error) {
            am4RteLog('Ajax() refused ' + url + ': ' + error.message,'warn');
        }
    }
    return am4RteInjectCreation(url) ?'a same-origin request into #newRouteInfo' : '';
}

function am4RteFindDeselectRouteControl() {
    return am4RteVisibleOne(document, [
        '#newRouteContainer .glyphicons-remove',
        '#newRouteInfo .glyphicons-remove',
        "[onclick*='removeNewRouteSelection']"
    ]);
}

function am4RteClearNewRouteSelection() {
    var discard = am4RteFindDeselectRouteControl();
    if (discard) am4RteClick(discard,'Remove wrong aircraft selection');
    if (typeof window.removeNewRouteSelection === 'function') {
        try { window.removeNewRouteSelection(); } catch (e) { /* ignore */ }
    }
}

function am4RteFindNewRouteRequest() {
    var roots = [];
    var ids = ['newRouteContainer','newRouteInfo' ];
    var ri;
    for (ri = 0; ri < ids.length; ri++) {
        var n = document.getElementById(ids[ri]);
        if (n && n.isConnected && roots.indexOf(n) === -1) roots.push(n);
    }
    var root = am4RteRoot();
    if (root && root !== document && roots.indexOf(root) === -1) roots.push(root);
    roots.push(document);
    for (var r = 0; r < roots.length; r++) {
        if (!roots[r].querySelectorAll) continue;
        var nodes = roots[r].querySelectorAll('[onclick], [href], form');
        for (var i = 0; i < nodes.length; i++) {
            var text = String(nodes[i].getAttribute('onclick') || '') + ' ' +
                String(nodes[i].getAttribute('href') || '') + ' ' +
                String(nodes[i].getAttribute('action') || '');
            var match = text.match(/new_route_info\.php\?[^'"\s)]+/i);
            if (match) return match[0];
        }
    }
    return '';
}

function am4RteBuildCreationUrl(createControl) {
    var lockedId = am4Rte.planeId;
    var arrivalId = am4RteArrivalId();
    if (!lockedId || !arrivalId) return '';
    var url = 'new_route_info.php?id=' + lockedId + '&airportId=' + arrivalId + '&ferry=0';
    if (!createControl || !createControl.element) return url;
    var code = String(createControl.element.getAttribute('onclick') || '');
    var airportMatch = code.match(/airportId=(\d+)/i);
    if (airportMatch) url = url.replace(/(airportId=)\d+/i,'$1' + airportMatch[1]);
    var ferryMatch = code.match(/ferry=(\d+)/i);
    if (ferryMatch) url = url.replace(/(ferry=)\d+/i,'$1' + ferryMatch[1]);
    var stopMatch = code.match(/stopoverId=(\d+)/i);
    if (stopMatch && stopMatch[1] !== '0') {
        if (/stopoverId=\d+/i.test(url)) url = url.replace(/(stopoverId=)\d+/i,'$1' + stopMatch[1]);
        else url +='&stopoverId=' + stopMatch[1];
    }
    return url;
}

function am4RteInstallAjaxGuard() {
    am4RteSetPageGlobal('__am4RteLockId', am4Rte.planeId || '');
    am4RteSetPageGlobal('__am4RteLockArr', am4RteArrivalId() || '');
    if (window.Ajax && window.Ajax.__am4RteGuard && window.jQuery && window.jQuery.__am4RtePrefilter) return;
    var tag = document.createElement('script');
    tag.textContent = [
        '(function(){',
        '  function rw(s) {',
        '    var lock = String(window.__am4RteLockId || "");',
        '    var arr = String(window.__am4RteLockArr || "");',
        '    var next = String(s == null ? "" : s);',
        '    if (!lock || !next) return next;',
        '    if (/mode=do/i.test(next) || /mode=res/i.test(next)) return next;',
        '    if (/([?&]id=)\\d+/i.test(next)) next = next.replace(/([?&]id=)\\d+/i, "$1" + lock);',
        '    else if (/(^|&)id=\\d+/i.test(next)) next = next.replace(/(^|&)id=\\d+/i, function(m, p){ return p + "id=" + lock; });',
        '    if (arr && /([?&]airportId=)\\d+/i.test(next)) next = next.replace(/([?&]airportId=)\\d+/i, "$1" + arr);',
        '    else if (arr && /(^|&)airportId=\\d+/i.test(next)) next = next.replace(/(^|&)airportId=\\d+/i, function(m, p){ return p + "airportId=" + arr; });',
        '    return next;',
        '  }',
        '  function isCreate(u, d) {',
        '    var a = String(u || ""), b = String(d || "");',
        '    return /new_route_info\\.php/i.test(a) || /new_route_info\\.php/i.test(b);',
        '  }',
        '  if (window.Ajax && !window.Ajax.__am4RteGuard) {',
        '    var orig = window.Ajax;',
        '    window.Ajax = function() {',
        '      var args = Array.prototype.slice.call(arguments);',
        '      try {',
        '        var s = String(args[0] || "");',
        '        if (isCreate(s, "") && !/mode=res/i.test(s) && !/mode=do/i.test(s)) {',
        '          var next = rw(s);',
        '          if (next !== s) {',
        '            args[0] = next;',
        '            if (window.console && console.log) console.log("[AM4 Bot Log] rewrote creation Ajax to locked id " + window.__am4RteLockId + ": " + next);',
        '          }',
        '        }',
        '      } catch (e) {}',
        '      return orig.apply(this, args);',
        '    };',
        '    window.Ajax.__am4RteGuard = true;',
        '  }',
        '  if (window.jQuery && window.jQuery.ajaxPrefilter && !window.jQuery.__am4RtePrefilter) {',
        '    window.jQuery.ajaxPrefilter(function(options) {',
        '      try {',
        '        var lock = String(window.__am4RteLockId || "");',
        '        if (!lock) return;',
        '        var u = String(options.url || "");',
        '        var d = typeof options.data === "string" ? options.data : "";',
        '        if (!isCreate(u, d)) return;',
        '        if (/mode=do/i.test(u) || /mode=do/i.test(d) || /mode=res/i.test(u) || /mode=res/i.test(d)) return;',
        '        var nu = rw(u), nd = d ? rw(d) : d;',
        '        if (nu !== u) options.url = nu;',
        '        if (nd !== d) options.data = nd;',
        '        if (nu !== u || nd !== d) {',
        '          if (window.console && console.log) console.log("[AM4 Bot Log] rewrote creation Ajax to locked id " + lock + ": " + (nu.indexOf("id=") !== -1 ? nu : (nu + (nd ? "? " + nd : ""))));',
        '        }',
        '      } catch (e2) {}',
        '    });',
        '    window.jQuery.__am4RtePrefilter = true;',
        '  }',
        '})();'
    ].join('\n');
    (document.documentElement || document.head || document.body).appendChild(tag);
    if (tag.parentNode) tag.parentNode.removeChild(tag);
    am4RteLog('installed creation Ajax guard for locked id ' + (am4Rte.planeId || '?'));
}

function am4RteBindLockedSelection() {
    am4RteSetOriginCoords();
    if (!am4Rte.planeId) return;
    am4RteSetPageGlobal('selectedFlight', Number(am4Rte.planeId) || am4Rte.planeId);
    am4RteLog('bound selectedFlight to locked id ' + am4Rte.planeId + ' (' + (am4Rte.reg || 'no reg') + ')');
}

function am4RteHeadlessReset() {
    am4Rte.headless = { phase: '', rc: null, prices: null, error: '', body: '', retried: false, gen: 0 };
}

function am4RteHtmlIsHideStub(html) {
    var s = String(html || '');
    return s.length < 220 && /newRouteInfo|#newRouteInfo/i.test(s) && /hide\s*\(/i.test(s);
}

function am4RteSignedUrl(url) {
    var next = String(url || '');
    var fb = (typeof window.fbSig !== 'undefined' && window.fbSig != null) ? String(window.fbSig) : '';
    if (next && next.indexOf('fbSig=') === -1) {
        next += (next.indexOf('?') === -1 ?'?' : '&') + 'fbSig=' + encodeURIComponent(fb);
    }
    return next;
}

// Game Ajax() is GET path + query as`data` + fbSig + cache:false. Bare fetch() of
// fleet_details.php returned 0 chars in live Research, so session never bound and
// mode=res kept hiding. dataType is`text` so the response is never .html()'d into
// #popup / #flightInfo (those injects either replace Research or throw).
function am4RteGameGet(url) {
    var raw = String(url || '');
    var path = raw.split('?')[0];
    var query = raw.indexOf('?') === -1 ?'' : raw.split('?').slice(1).join('?');
    var fb = (typeof window.fbSig !== 'undefined' && window.fbSig != null) ? String(window.fbSig) : '';
    if (!/(^|&)fbSig=/.test(query)) {
        query += (query ?'&' : '') + 'fbSig=' + encodeURIComponent(fb);
    }
    var jq = (typeof window.jQuery !== 'undefined' && window.jQuery.ajax) ? window.jQuery
        : ((typeof window.$ !== 'undefined' && window.$.ajax) ? window.$ : null);
    return new Promise(function (resolve, reject) {
        if (jq) {
            jq.ajax({
                type: 'GET',
                url: path,
                data: query,
                cache: false,
                dataType: 'text',
                success: function (response, _st, xhr) {
                    resolve({
                        status: (xhr && xhr.status) ? xhr.status : 200,
                        body: response == null ?'' : String(response)
                    });
                },
                error: function (xhr) {
                    resolve({
                        status: (xhr && xhr.status) || 0,
                        body: (xhr && xhr.responseText) ? String(xhr.responseText) : '' 
                    });
                }
            });
            return;
        }
        fetch(path + (query ?'?' + query : ''), {
            credentials: 'include',
            cache: 'no-store',
            headers: {'X-Requested-With' : 'XMLHttpRequest'}
        }).then(function (r) {
            return r.text().then(function (body) {
                resolve({ status: r.status, body: body || ''});
            });
        }).catch(reject);
    });
}

function am4RtePingLockedDetails() {
    var id = String(am4Rte.planeId || '');
    if (!id) return Promise.resolve('');
    var st = (window.statusData && window.statusData[id]) || null;
    var url = 'fleet_details.php?id=' + encodeURIComponent(id);
    am4RteLog('session ping for locked id ' + id + ' (' + (am4Rte.reg || 'no reg') + ')' +
        (st ? ' statusData routeId=' + (st.routeId || 0) : ' (not in statusData — likely parked after page load)'));
    function afterGet(res) {
        var html = (res && res.body) || '';
        am4RteLog('fleet_details.php ping HTTP ' + ((res && res.status) || 0) +
            ' ' + html.length + ' chars for locked id ' + id + ' (left Research popup alone)');
        if (html.length === 0 && typeof window.Ajax === 'function') {
            try {
                window.Ajax(url, 0, false, false, true);
                am4RteLog('issued game Ajax fleet_details ping with target 0 (no DOM inject)');
            } catch (e) { /* ignore */ }
            return new Promise(function (resolve) { setTimeout(function () { resolve(html); }, 400); });
        }
        return html;
    }
    return am4RteGameGet(url).then(afterGet);
}

function am4RteFetchModeRes(planeId, destId) {
    return am4RteGameGet('new_route_info.php?id=' + encodeURIComponent(planeId) +
        '&airportId=' + encodeURIComponent(destId) + '&mode=res')
        .then(function (res) {
            var html = (res && res.body) || '';
            am4RteLog('mode=res HTTP ' + ((res && res.status) || 0) + ' ' + html.length +
                ' chars for locked id ' + planeId + ' dest ' + destId);
            return html;
        });
}

function am4RteBeginHeadlessCreate() {
    var lockedId = am4Rte.planeId;
    var arrivalId = am4RteArrivalId();
    var gen = am4Rte.gen;
    am4Rte.headless = { phase: 'bind', rc: null, prices: null, error: '', body: '', retried: false, gen: gen };
    am4RteLog('loading route config for locked id ' + lockedId + ' (' + (am4Rte.reg || 'no reg') +
        ') dest airport ' + arrivalId + ' via signed mode=res GET');

    function finish(html) {
        if (gen !== am4Rte.gen) return;
        var raw = String(html || '');
        if (am4RteHtmlIsHideStub(html)) {
            am4Rte.headless.phase = 'error';
            am4Rte.headless.error = 'mode=res returned the hide stub for locked id ' + lockedId +
                ' (' + raw.length + ' chars)';
            return;
        }
        if (!raw || raw.length < 80) {
            am4Rte.headless.phase = 'error';
            am4Rte.headless.error = 'mode=res returned only ' + raw.length +
                ' chars for locked id ' + lockedId;
            return;
        }
        var rc = am4FleetParseRouteConfig(html);
        am4Rte.headless.rc = rc;
        am4Rte.headless.phase = 'ready';
        am4RteLog('mode=res config loaded for locked id ' + lockedId +
            ' (' + raw.length + ' chars)' +
            (rc && rc.hasCreate ? ' Create offered' : ' no Create button') +
            (rc && rc.hubIcao && rc.destIcao ?' ' + rc.hubIcao + '-' + rc.destIcao : ''));
    }

    function loadConfig() {
        return am4RteFetchModeRes(lockedId, arrivalId).then(function (html) {
            if (gen !== am4Rte.gen) return;
            if (am4RteHtmlIsHideStub(html) && !am4Rte.headless.retried) {
                am4Rte.headless.retried = true;
                am4RteLog('mode=res hid; pinging fleet_details again then retrying','warn');
                return am4RtePingLockedDetails().then(function () {
                    if (gen !== am4Rte.gen) return;
                    return new Promise(function (resolve) { setTimeout(resolve, 500); });
                }).then(function () {
                    if (gen !== am4Rte.gen) return;
                    return am4RteFetchModeRes(lockedId, arrivalId);
                }).then(function (html2) {
                    finish(html2);
                });
            }
            finish(html);
        });
    }

    am4Rte.headless.phase = 'bind';
    am4RtePingLockedDetails().then(function () {
        if (gen !== am4Rte.gen) return;
        am4Rte.headless.phase = 'fetch';
        return loadConfig();
    }).catch(function (err) {
        if (gen !== am4Rte.gen) return;
        am4Rte.headless.phase = 'error';
        am4Rte.headless.error = String((err && err.message) || err);
    });
    return true;
}

function am4RteSubmitHeadless() {
    var rc = am4Rte.headless && am4Rte.headless.rc;
    var prices = am4Rte.headless && am4Rte.headless.prices;
    var lockedId = am4Rte.planeId;
    var arrivalId = am4RteArrivalId();
    var routeName = am4Rte.reg || (rc && rc.routeRegDefault) || 'N';
    var url = am4FleetBuildRouteUrl(lockedId, arrivalId, routeName, prices, 200);
    if (!url) return false;
    var gen = am4Rte.gen;
    am4Rte.headless.phase = 'sending';
    am4RteLog('submitting Create (mode=do) for locked id ' + lockedId + ' (' + routeName +
        ') dest airport ' + arrivalId + ' with ' + (prices.source || 'multiplied Auto prices'));
    console.log('[AM4 Bot Log] Research creating route: ' + url);
    am4RteGameGet(url).then(function (res) {
        if (gen !== am4Rte.gen) return;
        var body = (res && res.body) || '';
        am4Rte.headless.body = body;
        am4RteLog('mode=do HTTP ' + ((res && res.status) || 0) + ' ' + body.length +
            ' chars for locked id ' + lockedId);
        if (/too low|not enough|insufficient|cannot afford|denied|invalid|failed/i.test(body)) {
            am4Rte.headless.phase = 'fail';
            am4Rte.headless.error = 'game refused the route request';
        } else {
            am4Rte.headless.phase = 'done';
        }
    }).catch(function (err) {
        if (gen !== am4Rte.gen) return;
        am4Rte.headless.phase = 'fail';
        am4Rte.headless.error = String((err && err.message) || err);
    });
    return true;
}

function am4RteClearAjaxGuardLock() {
    try {
        am4RteSetPageGlobal('__am4RteLockId','');
        am4RteSetPageGlobal('__am4RteLockArr','');
    } catch (e) { /* ignore */ }
}

function am4RteOpenCreationDirect(reason, createControl) {
    var lockedId = am4Rte.planeId;
    var arrivalId = am4RteArrivalId();
    if (!lockedId || !arrivalId) return false;
    var url = am4RteBuildCreationUrl(createControl);
    var how = am4RteRequestCreationPanel(url);
    if (!how) return false;
    am4Rte.createAt = Date.now();
    am4Rte.directOpen = true;
    am4RteLog('opened creation for locked id ' + lockedId + ' (' + (am4Rte.reg || 'no reg') +
        ') dest airport ' + arrivalId + ' from ' + (am4Rte.arrIdSource || 'the selected route') +
        ' via ' + how + ': ' + url + '. ' + reason);
    return true;
}

function am4RteReopenCreationForLocked() {
    var lockedId = am4Rte.planeId;
    if (!lockedId) return false;
    am4RteInstallAjaxGuard();
    am4RteBindLockedSelection();
    if (am4RteOpenCreationDirect('recover locked id ' + lockedId)) return true;
    am4RteLog('cannot recover — creation Ajax for locked id ' + lockedId + ' could not be sent','error');
    return false;
}

function am4RteAirportRecord(token) {
    if (typeof am4FleetResolveAirport === 'function') return am4FleetResolveAirport(token);
    var t = String(token == null ?'' : token).trim();
    if (!t) return null;
    var aid = window.airportIconData || [];
    var up = t.toUpperCase(), i;
    for (i = 0; i < aid.length; i++) if (aid[i] && String(aid[i].Id) === t) return aid[i];
    for (i = 0; i < aid.length; i++) if (aid[i] && String(aid[i].icao || '').toUpperCase() === up) return aid[i];
    for (i = 0; i < aid.length; i++) if (aid[i] && String(aid[i].iata || '').toUpperCase() === up) return aid[i];
    return null;
}

function am4RteAirportCoord(rec, key) {
    if (!rec) return NaN;
    var v = rec[key];
    if (v == null) v = rec[key.charAt(0).toUpperCase() + key.slice(1)];
    return Number(v);
}

function am4RteSetPageGlobal(name, value) {
    try { window[name] = value; } catch (e) { /* ignore */ }
    var lit = (typeof value === 'number' && isFinite(value)) ? String(value)
        : (value == null ?'null' : JSON.stringify(String(value)));
    if (typeof value === 'number' && isFinite(value)) lit = String(value);
    else if (typeof value === 'boolean') lit = value ?'true' : 'false';
    else if (typeof value === 'string' && /^\d+$/.test(value)) lit = value;
    else lit = JSON.stringify(value == null ?'' : String(value));
    var tag = document.createElement('script');
    tag.textContent = 'window["' + name + '"]=' + lit + ';try{' + name + '=' + lit + ';}catch(e){}';
    (document.documentElement || document.head || document.body).appendChild(tag);
    if (tag.parentNode) tag.parentNode.removeChild(tag);
}

function am4RteOriginRecord() {
    var rec = am4RteAirportRecord(am4Rte.depId) || am4RteAirportRecord(am4Rte.depCode);
    if (rec) return rec;
    var origin = String((am4Rte.specs && (am4Rte.specs.originLabel || am4Rte.specs.origin)) || '');
    rec = am4RteAirportRecord(origin);
    if (rec) return rec;
    var aid = window.airportIconData || [];
    var low = origin.toLowerCase();
    var tokens = low.split(/[^a-z0-9]+/).filter(function (tok) {
        return tok.length >= 4 &&
            tok !== 'united' && tok !== 'kingdom' && tok !== 'intl' &&
            tok !== 'international' && tok !== 'airport';
    });
    var i, name, t;
    for (i = 0; i < aid.length; i++) {
        name = String((aid[i] && aid[i].name) || '').toLowerCase();
        if (!name) continue;
        if (low && (name.indexOf(low) !== -1 || (low.length >= 8 && low.indexOf(name) !== -1))) return aid[i];
        for (t = 0; t < tokens.length; t++) {
            if (name.indexOf(tokens[t]) !== -1) return aid[i];
        }
    }
    return null;
}

function am4RteSetOriginCoords() {
    var rec = am4RteOriginRecord();
    if (!rec) {
        am4RteLog('origin airport not in airportIconData (dep ' +
            (am4Rte.depCode || am4Rte.depId || 'unknown') + ', label ' +
            ((am4Rte.specs && am4Rte.specs.originLabel) || 'none') + ')','warn');
        return false;
    }
    var lat = am4RteAirportCoord(rec,'lat');
    var lon = am4RteAirportCoord(rec,'lon');
    if (!isFinite(lat) || !isFinite(lon)) return false;
    am4RteSetPageGlobal('startLat', lat);
    am4RteSetPageGlobal('startLon', lon);
    am4RteLog('set page startLat/startLon from ' + (rec.icao || rec.name || am4Rte.depCode) +
        ' (' + lat + ',' + lon + ')');
    return true;
}

function am4RteFindIconIndex(planeId) {
    var id = String(planeId || '');
    if (!id) return 0;
    var row = document.getElementById('flightStatus' + id);
    if (row && /^\d+$/.test(String(row.getAttribute('data-iconid') || ''))) {
        return Number(row.getAttribute('data-iconid'));
    }
    var nodes = document.querySelectorAll('[onclick*="showFlightInfo"]');
    var i, m, oc;
    var re = new RegExp('showFlightInfo\\s*\\(\\s*[^,]+\\s*,\\s*' + id + '\\s*,\\s*(\\d+)');
    for (i = 0; i < nodes.length; i++) {
        oc = String(nodes[i].getAttribute('onclick') || '');
        m = oc.match(re);
        if (m) return Number(m[1]);
    }
    return 0;
}

function am4RteEnsureCreateGlobals() {
    am4RteSetOriginCoords();
    if (am4Rte.planeId) am4RteSetPageGlobal('selectedFlight', Number(am4Rte.planeId) || am4Rte.planeId);
    var icon = am4RteFindIconIndex(am4Rte.planeId);
    var tag = document.createElement('script');
    tag.textContent = [
        '(function(){',
        '  try {',
        '    var iconIdx = ' + icon + ';',
        '    var planeId = ' + JSON.stringify(String(am4Rte.planeId || '')) + ';',
        '    if (planeId && typeof markers !== "undefined" && markers[planeId]) {',
        '      try { markerTarget = markers[planeId]; } catch (e0) {}',
        '    }',
        '    if (typeof newRoutIcon === "undefined" || !newRoutIcon) {',
        '      if (typeof mouseoverMarker !== "undefined" && mouseoverMarker[iconIdx]) newRoutIcon = mouseoverMarker[iconIdx];',
        '      else if (typeof newRouteIcon !== "undefined" && newRouteIcon) newRoutIcon = newRouteIcon;',
        '      else if (typeof standardAirport !== "undefined") newRoutIcon = standardAirport;',
        '      else if (typeof airportIcon !== "undefined") newRoutIcon = airportIcon;',
        '    }',
        '  } catch (e) {}',
        '})();'
    ].join('\n');
    (document.documentElement || document.head || document.body).appendChild(tag);
    if (tag.parentNode) tag.parentNode.removeChild(tag);
    am4RteLog('bound map globals for locked id ' + (am4Rte.planeId || '?') +
        ' icon ' + icon + ' startLat=' + (window.startLat != null ? window.startLat : 'unset') +
        ' newRoutIcon=' + (typeof window.newRoutIcon === 'undefined' ?'missing' : 'set'));
    return true;
}

function am4RteDrawLockedSuggestion() {
    am4RteEnsureCreateGlobals();
    var lockedId = am4Rte.planeId;
    var arrivalId = am4RteArrivalId();
    var dest = am4RteAirportRecord(arrivalId) || am4RteAirportRecord(am4Rte.arrCode);
    if (!lockedId || !dest) return false;
    if (!am4RteSetOriginCoords()) {
        am4RteLog('refusing drawRouteSuggestion2 — startLat is not defined on the page yet','warn');
        return false;
    }
    if (am4Rte.planeId) am4RteSetPageGlobal('selectedFlight', Number(am4Rte.planeId) || am4Rte.planeId);
    var lat = am4RteAirportCoord(dest,'lat');
    var lon = am4RteAirportCoord(dest,'lon');
    if (!isFinite(lat) || !isFinite(lon)) {
        am4RteLog('cannot draw suggestion — dest ' + arrivalId + ' has no lat/lon','warn');
        return false;
    }
    var label = dest.name || dest.icao || am4Rte.arrCode || String(arrivalId);
    var range = (am4Rte.specs && am4Rte.specs.range) || 0;
    var speed = (am4Rte.specs && am4Rte.specs.speed) || 850;
    var depId = am4Rte.depId || '';
    if (!depId && am4Rte.depCode) {
        var originRec = am4RteOriginRecord();
        if (originRec && originRec.Id) depId = String(originRec.Id);
    }
    try {
        if (typeof window.removeNewRouteSelection === 'function') {
            try { window.removeNewRouteSelection(true); } catch (e1) {
                try { window.removeNewRouteSelection(); } catch (e2) { /* ignore */ }
            }
        }
        if (typeof window.drawRouteSuggestion2 === 'function') {
            var drawn = window.drawRouteSuggestion2(lat, lon, speed, 0, range, lockedId, Number(arrivalId), 0,'manual', 0, 0, Number(depId || 0));
            am4RteLog('drew map suggestion via drawRouteSuggestion2 for locked id ' + lockedId +
                ' dest ' + arrivalId + ' (' + label + ')');
            if (drawn && typeof drawn.then === 'function') {
                drawn.then(function () {
                    am4RteLog('map suggestion finished for locked id ' + lockedId);
                }, function (err) {
                    am4RteLog('map suggestion rejected: ' + ((err && err.message) || err),'error');
                });
            }
            return true;
        }
        if (typeof window.drawRouteSuggestion === 'function') {
            window.drawRouteSuggestion(lat, lon, speed, label, range, lockedId, Number(arrivalId), 0,'manual');
            am4RteLog('drew map suggestion via drawRouteSuggestion for locked id ' + lockedId +
                ' dest ' + arrivalId + ' (' + label + ')');
            return true;
        }
    } catch (error) {
        am4RteLog('draw suggestion failed: ' + error.message,'warn');
        return false;
    }
    am4RteLog('game has no drawRouteSuggestion — will Ajax new_route_info.php after map bind','warn');
    return false;
}

function am4RteFindPendingNext() {
    var nodes = document.querySelectorAll('#newRouteNext');
    var locked = am4Rte.planeId;
    var fallback = null;
    var i;
    for (i = 0; i < nodes.length; i++) {
        if (am4RteInsideExcluded(nodes[i])) continue;
        var found = { element: nodes[i], acId: am4RteAircraftId(nodes[i]), sel: '#newRouteNext'};
        if (locked && found.acId && found.acId === locked) return found;
        if (!fallback) fallback = found;
    }
    return fallback;
}

function am4RteInvokePendingNext(pending) {
    if (!pending || !pending.element) return false;
    if (pending.acId && pending.acId === am4Rte.planeId) {
        var code = String(pending.element.getAttribute('onclick') || '');
        if (code) {
            try {
                (new Function(code)).call(pending.element);
                am4RteLog('invoked #newRouteNext for locked id ' + am4Rte.planeId);
                am4Rte.createAt = Date.now();
                return true;
            } catch (e) { /* fall through to click */ }
        }
        return am4RteClick(pending.element,'Continue to new route panel');
    }
    am4RteInstallAjaxGuard();
    am4RteBindLockedSelection();
    if (am4RteInvokeLocked(pending)) return true;
    am4RteLog('clicking #newRouteNext with Ajax guard rewriting id to ' + (am4Rte.planeId || '?'));
    return am4RteClick(pending.element,'Continue to new route panel for locked id ' + (am4Rte.planeId || '?'));
}

function am4RteHeaderMismatch() {
    var header = am4RteReadCreationReg();
    if (am4Rte.reg && header.reg && !am4RteRegsMatch(am4Rte.reg, header.reg)) {
        am4Rte.seenReg = header.reg;
        return header;
    }
    return null;
}

function am4RteClearPriceMarkers() {
    document.querySelectorAll('[data-am4-priced]').forEach(function (el) {
        try { delete el.dataset.am4Priced; } catch (e) { /* ignore */ }
    });
}

function am4RteDismissToasts() {
    var toasts = document.querySelectorAll('.jq-toast-single.jq-icon-error, .jq-toast-single.jq-icon-warning');
    for (var i = 0; i < toasts.length; i++) {
        var closer = toasts[i].querySelector('.close-jq-toast-single') || toasts[i].querySelector('.jq-close');
        if (closer) { try { closer.click(); } catch (e) { /* ignore */ } }
        if (toasts[i].parentNode) {
            try { toasts[i].parentNode.removeChild(toasts[i]); } catch (e2) { /* ignore */ }
        }
    }
}

function am4RteVisibleBlockMessage() {
    var patterns = /can't|cannot|unable to|not possible|insufficient|too many|already exists|not enough|access denied|limit reached|no slots|not allowed|route limit|slot.{0,12}(?:full|unavailable)/i;
    var toasts = document.querySelectorAll('.jq-toast-wrap .jq-toast-single, .jq-toast-single');
    for (var t = 0; t < toasts.length; t++) {
        if (!am4RteVisible(toasts[t])) continue;
        var toastText = toasts[t].innerText || toasts[t].textContent || '';
        if (toasts[t].classList.contains('jq-icon-error') ||
            toasts[t].classList.contains('jq-icon-warning') ||
            patterns.test(toastText)) return toasts[t];
    }
    var root = am4RteRoot();
    var alerts = root.querySelectorAll('.alert-danger, .alert-warning, #error-msg');
    for (var i = 0; i < alerts.length; i++) {
        if (am4RteVisible(alerts[i]) && patterns.test(alerts[i].innerText || alerts[i].textContent || '')) return alerts[i];
    }
    return null;
}

function am4RteBlockMessageText(el) {
    if (!el) return 'route blocked';
    var clone = el.cloneNode(true);
    clone.querySelectorAll('.jq-close, .jq-toast-heading, .jq-toast-loader').forEach(function (node) {
        if (node.parentNode) node.parentNode.removeChild(node);
    });
    var text = (clone.innerText || clone.textContent || '').replace(/\s+/g,' ').replace(/^×\s*/,'').trim();
    return text.slice(0, 120) || 'route blocked';
}

function am4RteTextHasAirportTerm(text, value) {
    var term = String(value || '').replace(/^\s+|\s+$/g,'').toUpperCase();
    if (!term) return false;
    if (/^[A-Z0-9]{3,4}$/.test(term)) {
        return new RegExp('(^|[^A-Z0-9])' + term + '([^A-Z0-9]|$)').test(text);
    }
    return term.length >= 5 && text.indexOf(term) !== -1;
}

function am4RteCreationDestinationMatches() {
    var expectedCode = am4RteAirportCode(am4Rte.arrCode);
    if (!expectedCode || String(am4Rte.arrIdSource || '').indexOf('airportIconData') === -1) return true;
    var panel = am4RteCreationPanel();
    if (!panel) return null;
    var text = String(panel.innerText || panel.textContent || '').replace(/\s+/g,' ').toUpperCase();
    if (am4RteTextHasAirportTerm(text, expectedCode)) return true;
    var codes = text.match(/\b[A-Z]{3,4}\b/g) || [];
    for (var i = 0; i < codes.length; i++) {
        var shownId = am4RteAirportIdFromCode(codes[i]);
        if (shownId && shownId !== am4Rte.arrId && shownId !== am4Rte.depId) {
            am4RteLog('DESTINATION MISMATCH: expected ' + expectedCode + ' (id ' + am4Rte.arrId +
                ') but creation panel shows ' + codes[i] + ' (id ' + shownId + ')','error');
            return false;
        }
    }
    return null;
}

function am4RteCreationScopes() {
    var scopes = [];
    var ids = ['newRouteContainer','newRouteInfo' ];
    for (var i = 0; i < ids.length; i++) {
        var n = document.getElementById(ids[i]);
        if (n && n.isConnected && scopes.indexOf(n) === -1) scopes.push(n);
    }
    return scopes;
}

function am4RteCreationHasForm(root) {
    if (!root || !root.querySelector) return false;
    return !!(root.querySelector('#eSeat, #bSeat, #fSeat, #eTicket, #price_y, #price_l, #btnCreateNewRoute, #introAuto, #newRouteNext, #newRouteContainer'));
}

function am4RteCreationRoots() {
    var roots = am4RteCreationScopes().filter(function (n) {
        return am4RteVisible(n) || am4RteCreationHasForm(n);
    });
    if (!roots.length) return roots;
    var flow = am4RteRoot();
    if (flow && flow !== document && roots.indexOf(flow) === -1 &&
        (flow.contains(roots[0]) || am4RteCreationHasForm(flow))) {
        roots.push(flow);
    }
    return roots;
}

function am4RteCreationPanel() {
    var scopes = am4RteCreationScopes();
    var i, n;
    for (i = 0; i < scopes.length; i++) {
        n = scopes[i];
        if (am4RteVisible(n) && am4RteCreationHasForm(n)) return n;
    }
    for (i = 0; i < scopes.length; i++) {
        n = scopes[i];
        if (am4RteCreationHasForm(n)) return n;
    }
    return null;
}

function am4RtePickPriceField(scopes, ids) {
    var s, i, el;
    for (s = 0; s < scopes.length; s++) {
        if (!scopes[s] || !scopes[s].querySelector) continue;
        for (i = 0; i < ids.length; i++) {
            el = scopes[s].querySelector('#' + ids[i]);
            if (el) return el;
        }
    }
    return null;
}

function am4RteInvokeLocked(control) {
    var lockedId = am4Rte.planeId;
    if (!lockedId || !control || !control.element) return false;
    var code = String(control.element.getAttribute('onclick') || '');
    if (!code) return false;
    var arrivalId = am4RteArrivalId();
    var rebound = code;
    if (code.indexOf('new_route_info.php') !== -1) {
        rebound = code.replace(/(new_route_info\.php\?id=)\d+/ig,'$1' + lockedId);
        if (rebound === code && /new_route_info\.php\?/i.test(code) && !/new_route_info\.php\?id=/i.test(code)) {
            rebound = code.replace(/new_route_info\.php\?/ig,'new_route_info.php?id=' + lockedId + '&');
        }
        if (arrivalId) {
            if (/airportId=\d+/i.test(rebound)) {
                rebound = rebound.replace(/(airportId=)\d+/ig,'$1' + arrivalId);
            } else if (rebound.indexOf('new_route_info.php?') !== -1) {
                rebound = rebound.replace(/new_route_info\.php\?[^'"\s)]*/i, function (url) {
                    return url + (url.indexOf('airportId=') === -1 ?'&airportId=' + arrivalId : '');
                });
            }
        }
    } else if (code.indexOf('drawRouteSuggestion') !== -1) {
        rebound = code.replace(/drawRouteSuggestion\s*\(\s*(\d+|[^,)]*)/i,'drawRouteSuggestion(' + lockedId);
        if (arrivalId) {
            rebound = rebound.replace(/drawRouteSuggestion\s*\(\s*(\d+|[^,)]*)\s*,\s*(\d+|[^,)]*)/i,
                'drawRouteSuggestion(' + lockedId + ',' + arrivalId);
        }
    } else if (/new_route_info\.php/i.test(code)) {
        var rebuilt = am4RteBuildCreationUrl(control);
        if (rebuilt && typeof window.Ajax === 'function') {
            am4RteRevealCreation();
            am4RteRequestCreationPanel(rebuilt);
            am4RteLog('ran locked Ajax() from ' + (control.sel || 'create control') +
                ' onclick without a literal aircraft id','warn');
            am4Rte.createAt = Date.now();
            return true;
        }
        return false;
    } else {
        return false;
    }
    if (rebound === code && code.indexOf('new_route_info.php') === -1) return false;
    if (code.indexOf('new_route_info.php') !== -1 && rebound.indexOf('id=' + lockedId) === -1) return false;
    try {
        am4RteRevealCreation();
        (new Function(rebound)).call(control.element);
        am4RteLog('rebound create control to locked id ' + lockedId + ' dest ' + (arrivalId || '?') +
            ' (was ' + (control.acId || 'none') + ')','warn');
        am4Rte.createAt = Date.now();
        return true;
    } catch (error) {
        am4RteLog('could not rebind create control: ' + error.message,'warn');
        return false;
    }
}

function am4RteResolveClickable(node) {
    if (!node) return node;
    if (node.getAttribute && node.getAttribute('onclick')) return node;
    var tag = String(node.tagName || '').toLowerCase();
    if (tag === 'button' || tag === 'a' || tag === 'input') return node;
    var inner = node.querySelector('[onclick], button, a.btn');
    return inner && am4RteVisible(inner) ? inner : node;
}

function am4RteFindAutoPrice() {
    var roots = am4RteCreationRoots();
    var sels = ["[onclick*='autoPrice']","[onclick*='ticketPriceSuggest']" ,"[onclick*='autoprice']" ,'#introAuto' ];
    var r, s, nodes, i;
    for (r = 0; r < roots.length; r++) {
        for (s = 0; s < sels.length; s++) {
            nodes = roots[r].querySelectorAll(sels[s]);
            for (i = 0; i < nodes.length; i++) {
                if (!am4RteVisible(nodes[i])) continue;
                var el = am4RteResolveClickable(nodes[i]);
                if (el && !am4RteIsForbidden(el)) return el;
            }
        }
        if (roots[r] === document) continue;
        nodes = roots[r].querySelectorAll('button, a, span.btn, input[type="button"], input[type="submit"]');
        for (i = 0; i < nodes.length; i++) {
            if (!am4RteVisible(nodes[i]) || am4RteIsForbidden(nodes[i])) continue;
            var text = am4RteNorm(nodes[i].innerText || nodes[i].value);
            if (!text) continue;
            if (/auto\s*price/.test(text) || (text.indexOf('auto') !== -1 && (text.indexOf('price') !== -1 || text.indexOf('ticket') !== -1))) {
                return nodes[i];
            }
        }
    }
    return null;
}

function am4RteFindConfirm() {
    var roots = am4RteCreationRoots();
    if (!roots.length) return null;
    var sels = ['#btnCreateNewRoute',"[onclick*='createNewRoute']" ,"[onclick*='mode=do']" ];
    var i, s, r, nodes;
    for (r = 0; r < roots.length; r++) {
        for (s = 0; s < sels.length; s++) {
            nodes = roots[r].querySelectorAll(sels[s]);
            for (i = 0; i < nodes.length; i++) {
                if (am4RteIsForbidden(nodes[i])) continue;
                var oc = String(nodes[i].getAttribute('onclick') || '');
                if (/new_route_info\.php\?(?!.*mode=do)/i.test(oc) && nodes[i].id !== 'btnCreateNewRoute') continue;
                if (am4RteVisible(nodes[i]) || nodes[i].id === 'btnCreateNewRoute') return nodes[i];
            }
        }
    }
    var panel = am4RteCreationPanel();
    if (!panel) return null;
    var buttons = panel.querySelectorAll('button, a.btn, input[type="button"], input[type="submit"]');
    for (i = 0; i < buttons.length; i++) {
        if (am4RteIsForbidden(buttons[i])) continue;
        var text = am4RteNorm(buttons[i].innerText || buttons[i].value);
        if (text && /create|confirm/.test(text) && !/research/.test(text) && !/auto/.test(text)) {
            return buttons[i];
        }
    }
    return null;
}

function am4RtePriceFields() {
    var scopes = am4RteCreationScopes();
    if (!scopes.length) return null;
    var y = am4RtePickPriceField(scopes, ['eSeat','eTicket','price_y' ]);
    var j = am4RtePickPriceField(scopes, ['bSeat','bTicket','price_j' ]);
    var f = am4RtePickPriceField(scopes, ['fSeat','fTicket','price_f' ]);
    if (y && j && f) return { y: y, j: j, f: f };
    var large = am4RtePickPriceField(scopes, ['price_l']);
    var heavy = am4RtePickPriceField(scopes, ['price_h']);
    if (large && heavy) return { l: large, h: heavy, cargo: true };
    return null;
}

function am4RtePricesReady(fields) {
    if (!fields) return false;
    if (fields.cargo) {
        return am4RteNum(fields.l.value) > 0 && am4RteNum(fields.h.value) > 0;
    }
    return am4RteNum(fields.y.value) > 0 && am4RteNum(fields.j.value) > 0 && am4RteNum(fields.f.value) > 0;
}

function am4RtePriceLabels(fields) {
    if (!fields) return 'none';
    if (fields.cargo) return 'L=' + (fields.l.value || '') + ' H=' + (fields.h.value || '');
    return 'Y=' + (fields.y.value || '') + ' J=' + (fields.j.value || '') + ' F=' + (fields.f.value || '');
}

function am4RteCreationSignature() {
    var panel = am4RteCreationPanel();
    var fields = am4RtePriceFields();
    return (panel ? String(panel.innerHTML || '').length : 0) + ':' + am4RtePriceLabels(fields);
}

function am4RteInvokeAutoPriceHandler() {
    var roots = am4RteCreationRoots();
    var r, i, nodes, code;
    for (r = 0; r < roots.length; r++) {
        if (!roots[r].querySelectorAll) continue;
        nodes = roots[r].querySelectorAll("[onclick*='autoPrice'], [onclick*='ticketPriceSuggest']");
        for (i = 0; i < nodes.length; i++) {
            code = String(nodes[i].getAttribute('onclick') || '');
            if (!code) continue;
            try {
                (new Function(code)).call(nodes[i]);
                am4RteLog('ran Auto price handler from onclick');
                return true;
            } catch (error) {
                am4RteLog('Auto price handler failed: ' + error.message,'warn');
            }
        }
    }
    return false;
}

function am4RteApplyCreationPrices() {
    var panel = am4RteCreationPanel();
    var fields = am4RtePriceFields();
    if (!panel || !am4RtePricesReady(fields)) return false;
    if (fields.cargo) {
        if (am4AlreadyPriced(fields.l) || am4AlreadyPriced(fields.h)) return true;
    } else if (am4AlreadyPriced(fields.y) || am4AlreadyPriced(fields.j) || am4AlreadyPriced(fields.f)) {
        return true;
    }
    return am4ApplyPriceMultipliers(panel,'research create');
}

function am4RteFindBack(pane) {
    if (!pane) return null;
    var cands = pane.querySelectorAll('button, a.btn, a');
    for (var i = 0; i < cands.length; i++) {
        if (!am4RteVisible(cands[i]) || am4RteIsForbidden(cands[i])) continue;
        var text = am4RteNorm(cands[i].innerText || cands[i].textContent || '');
        var oc = String(cands[i].getAttribute('onclick') || '').toLowerCase();
        if (cands[i].id === 'sugNewRoute' || cands[i].id === 'introAuto' || cands[i].id === 'btnCreateNewRoute') continue;
        if (text.indexOf('back') !== -1 || text.indexOf('return') !== -1 || oc.indexOf('back') !== -1) { return cands[i]; }
    }
    return null;
}

function am4RteGo(state, msg) {
    am4Rte.state = state;
    am4Rte.enteredAt = Date.now();
    am4Rte.actionDone = false;
    if (msg) am4RteLog(msg);
}

function am4RteStop(msg, level) {
    am4Rte.gen++;
    am4RteClearAjaxGuardLock();
    am4RteGo('IDLE', msg || 'stopped');
    if (am4Rte.timer) { clearTimeout(am4Rte.timer); am4Rte.timer = null; }
    if (level === 'error') am4RteLog(msg,'error');
}

function am4RteReject(reason) {
    am4Rte.gen++;
    am4Rte.hideStubLogged = false;
    am4RteDismissToasts();
    if (am4Rte.selectedId) am4Rte.rejected[am4Rte.selectedId] = reason || true;
    if (am4Rte.selectedRow) {
        try { am4Rte.selectedRow.setAttribute('data-bot-rejected','1'); } catch (e) { /* ignore */ }
    }
    am4RteLog('rejected ' + (am4Rte.selectedLabel || am4Rte.selectedId || 'route') + ': ' + reason,'warn');
    am4Rte.backstepSig = am4RteSig(am4RteDetailsPane());
    am4Rte.backstepClicks = 0;
    am4Rte.deselectClicked = false;
    am4Rte.nextClicked = false;
    am4Rte.fixAttempts = 0;
    am4Rte.seenReg = '';
    am4Rte.createAt = 0;
    am4Rte.directOpen = false;
    am4Rte.mountClicked = false;
    am4Rte.recoverWaitUntil = 0;
    am4Rte.recoverRequested = false;
    am4Rte.suggestionDrawn = false;
    am4Rte.ajaxAfterDraw = false;
    am4Rte.hideStubLogged = false;
    am4Rte.confirmClicked = false;
    am4Rte.autoPriceClicked = false;
    am4Rte.pricesApplied = false;
    am4RteHeadlessReset();
    am4RteGo('BACKSTEP');
}

function am4RteSchedule(delayMs) {
    if (am4Rte.timer) clearTimeout(am4Rte.timer);
    var gen = am4Rte.gen;
    am4Rte.timer = setTimeout(function () {
        if (gen !== am4Rte.gen) return;
        am4RteTick();
    }, delayMs || AM4_RTE_TICK_MS);
}

function am4RteStart(lock) {
    am4Rte.gen++;
    am4Rte.planeId = lock.planeId || '';
    am4Rte.reg = '';
    am4Rte.specs = { range: 0, runway: 0, origin: '', originLabel: '', speed: 0, reg: ''};
    am4Rte.staleReg = lock.staleReg || '';
    am4Rte.staleOrigin = lock.staleOrigin || '';
    am4Rte.staleRange = lock.staleRange || 0;
    am4Rte.waitLogged = false;
    am4Rte.researchBefore = '';
    am4Rte.researchClickAt = 0;
    am4Rte.resultsBefore = '';
    am4Rte.demandClicked = false;
    am4Rte.sawEmptyResults = false;
    am4Rte.detailsButton = lock.detailsButton || null;
    am4Rte.rejected = {};
    am4Rte.attempted = {};
    am4Rte.attemptCount = 0;
    am4Rte.selectedRow = null;
    am4Rte.selectedId = '';
    am4Rte.selectedLabel = '';
    am4Rte.autoPriceClicked = false;
    am4Rte.pricesApplied = false;
    am4Rte.confirmClicked = false;
    am4Rte.actionDone = false;
    am4Rte.arrId = '';
    am4Rte.arrIdSource = '';
    am4Rte.depId = '';
    am4Rte.arrCode = '';
    am4Rte.depCode = '';
    am4Rte.nextClicked = false;
    am4Rte.fixAttempts = 0;
    am4Rte.seenReg = '';
    am4Rte.createAt = 0;
    am4Rte.directOpen = false;
    am4Rte.mountClicked = false;
    am4Rte.recoverWaitUntil = 0;
    am4Rte.recoverRequested = false;
    am4Rte.suggestionDrawn = false;
    am4Rte.ajaxAfterDraw = false;
    am4Rte.hideStubLogged = false;
    am4Rte.hubResolveBusy = false;
    am4Rte.hubResolveDone = false;
    am4RteHeadlessReset();
    am4RteInstallAjaxGuard();
    if (!am4RteOwnedHubNames().length && typeof am4ExpFetchMeta === 'function') {
        am4ExpFetchMeta(false).then(function (meta) {
            if (meta && meta.hubs && meta.hubs.length) am4ExpMeta = meta;
        });
    }
    am4RteGo('PREFLIGHT','aircraft selected; starting preflight');
    am4RteSchedule();
}

function am4RteTick() {
    if (am4Rte.state === 'IDLE') return;
    var root = am4RteRoot();
    var pane, table, hub, distance, runway, search, choice, create, prices, autoBtn, confirm;
    var block, header, pending, destMatch, submitHeader;
    try {
        switch (am4Rte.state) {
            case'PREFLIGHT' :
                var matchPanel = am4RtePanelMatchesLocked();
                if (!matchPanel.ok) {
                    if (!am4Rte.waitLogged) {
                        am4Rte.waitLogged = true;
                        am4RteLog('waiting for Details of id ' + (am4Rte.planeId || '?') +
                            ' (panel still shows ' + (matchPanel.reason || 'previous aircraft') + ')');
                    }
                    if (am4RteElapsed() > 10000) am4RteStop('preflight timed out: Details did not switch to the clicked aircraft','error');
                    break;
                }
                am4Rte.specs = matchPanel.live;
                if (matchPanel.live.reg) am4Rte.reg = matchPanel.live.reg;
                var hubResolved = am4RteFindOwnedHubInText(am4RteDetailsSearchBlob());
                if (hubResolved) {
                    am4Rte.specs.originLabel = hubResolved;
                    am4Rte.specs.origin = am4RteNorm(hubResolved);
                } else if (am4Rte.specs.originLabel &&
                    am4RteOriginBadLabel(am4Rte.specs.origin, am4Rte.specs.originLabel)) {
                    am4Rte.specs.originLabel = '';
                    am4Rte.specs.origin = '';
                }
                if (am4Rte.planeId && (!am4Rte.specs.hubId ||
                    !am4Rte.specs.originLabel ||
                    am4RteOriginBadLabel(am4Rte.specs.origin, am4Rte.specs.originLabel))) {
                    if (!am4Rte.hubResolveDone) {
                        am4RteEnsurePlaneHub(function () {
                            if (am4Rte.state === 'PREFLIGHT') am4RteSchedule(80);
                        });
                    }
                    if (!am4Rte.hubResolveDone || am4Rte.hubResolveBusy) {
                        if (am4RteElapsed() > 12000) {
                            am4RteStop('could not read this aircraft\'s home hub from fleet_details — reload and try again','error');
                        }
                        break;
                    }
                }
                if (am4Rte.planeId) am4Rte.lastPlaneId = am4Rte.planeId;
                if (!am4Rte.reg && !am4Rte.planeId && am4RteElapsed() < 2500) break;
                am4RteLearnSpeed(am4Rte.specs);
                am4RteLog('locked ' + (am4Rte.reg || am4Rte.planeId || 'this aircraft') +
                    ' origin ' + (am4Rte.specs.originLabel || am4Rte.specs.origin || '(resolve at Research)') +
                    ' range ' + am4Rte.specs.range + ' km rwy ' + (am4Rte.specs.runway || 0) + ' m');
                if (am4Rte.planeId) am4RteLog('locked aircraft id ' + am4Rte.planeId);
                am4RteGo('OPEN_RESEARCH','preflight complete; opening Research');
                break;

            case'OPEN_RESEARCH' :
                if (!am4Rte.actionDone) {
                    var researchBtn = am4RteFindResearchButton();
                    if (researchBtn) {
                        am4Rte.researchBefore = am4RteResearchFormSig();
                        am4Rte.researchClickAt = Date.now();
                        am4Rte.actionDone = am4RteClickResearch(researchBtn);
                        if (am4Rte.actionDone) am4RteGo('FILL','Research opened');
                    } else if (am4RteElapsed() > 10000) {
                        am4RteStop('Research tab was not found','error');
                    }
                }
                break;

            case'FILL' :
                if (am4Rte.researchClickAt && Date.now() - am4Rte.researchClickAt < 400) break;
                if (am4Rte.researchBefore && am4RteResearchFormSig() === am4Rte.researchBefore &&
                    am4RteElapsed() < 2500) break;
                hub = am4RteVisibleOne(root,'#hubSelect');
                distance = am4RteVisibleOne(root,'#maxDist');
                runway = am4RteVisibleOne(root,'#rwyLength');
                search = am4RteVisibleOne(root,'#resSearch');
                if (hub && distance && runway && search && !am4Rte.actionDone) {
                    if (hub.options.length < 1) {
                        if (am4RteElapsed() > 10000) am4RteStop('departure hub list never loaded','error');
                        break;
                    }
                    var match = null;
                    if (am4Rte.specs && am4Rte.specs.hubId) {
                        for (var hi = 0; hi < hub.options.length; hi++) {
                            if (String(hub.options[hi].value) === String(am4Rte.specs.hubId)) {
                                match = { option: hub.options[hi], index: hi, score: 250 };
                                break;
                            }
                        }
                    }
                    if (!match) {
                        match = am4RteMatchHub(hub, (am4Rte.specs && (am4Rte.specs.originLabel || am4Rte.specs.origin)) || '');
                    }
                    if (!match) match = am4RteMatchHubFromPanelText(hub);
                    if (!match && am4Rte.planeId && !am4Rte.hubResolveDone) {
                        am4RteEnsurePlaneHub(function () {
                            if (am4Rte.state === 'FILL') am4RteSchedule(80);
                        });
                        break;
                    }
                    if (!match && am4RteOwnedHubNames().length === 0 && typeof am4ExpFetchMeta === 'function') {
                        am4ExpFetchMeta(false).then(function () {
                            if (am4Rte.state === 'FILL') am4RteSchedule(120);
                        });
                        break;
                    }
                    if (!match) {
                        if (am4RteElapsed() < 10000) break;
                        am4RteStop('could not match this aircraft to an owned hub in the Details popup — open Explorer once (⟳ refresh hubs) or confirm the plane is at one of your hubs','error');
                        break;
                    }
                    if (am4Rte.specs && match.option) {
                        am4Rte.specs.originLabel = String(match.option.textContent || '').replace(/\s+/g,' ').trim();
                        am4Rte.specs.origin = am4RteNorm(am4Rte.specs.originLabel);
                    }
                    hub.selectedIndex = match.index;
                    am4RteSetValue(hub, match.option.value);
                    am4RteSetValue(distance, am4Rte.specs.range);
                    am4RteSetValue(runway, am4Rte.specs.runway || 0);
                    if (String(hub.value) !== String(match.option.value) ||
                        am4RteNum(distance.value) !== am4RteNum(am4Rte.specs.range) ||
                        am4RteNum(runway.value) !== am4RteNum(am4Rte.specs.runway || 0)) {
                        am4RteLog('research form did not keep hub/distance/runway; re-applying','warn');
                        if (am4RteElapsed() > 10000) am4RteStop('research form rejected hub/distance/runway values','error');
                        break;
                    }
                    if (!am4Rte.demandClicked) {
                        am4Rte.demandClicked = true;
                        am4RteClickDemandClass();
                    }
                    var chosen = hub.options[hub.selectedIndex];
                    var chosenText = String((chosen && chosen.textContent) || '').trim();
                    am4RteLog('research form set to origin ' + (chosenText || '(unreadable)') +
                        ' (#hubSelect ' + String(hub.value) + '), max distance ' +
                        String(distance.value) + ' km, min runway ' + String(runway.value) + ' m');
                    am4Rte.actionDone = true;
                    am4Rte.resultsBefore = am4RteResultsSig();
                    var genFill = am4Rte.gen;
                    setTimeout(function () {
                        if (genFill !== am4Rte.gen) return;
                        if (am4RteClick(search,'Search')) am4RteGo('WAIT_RESULTS','search submitted');
                        am4RteSchedule();
                    }, 450);
                    return;
                }
                if (am4RteElapsed() > 10000) am4RteStop('research form did not load','error');
                break;

            case'WAIT_RESULTS' :
                table = am4RteTable();
                var rowCount = table ? am4RteRows(table).length : 0;
                var resultsNow = am4RteResultsSig();
                if (!rowCount) am4Rte.sawEmptyResults = true;
                if (rowCount && (am4Rte.sawEmptyResults || !am4Rte.resultsBefore ||
                    resultsNow !== am4Rte.resultsBefore)) {
                    am4RteGo('SELECT','results loaded');
                } else if (am4RteElapsed() > 15000) am4RteStop('research results timed out','error');
                break;

            case'SELECT' :
                table = am4RteTable();
                if (!table) {
                    if (am4RteElapsed() > 10000) am4RteStop('results disappeared','error');
                    break;
                }
                if (am4Rte.attemptCount >= AM4_RTE_MAX_ATTEMPTS) {
                    am4RteStop('maximum route attempts reached','error');
                    break;
                }
                choice = am4RteChooseRow(table);
                if (!choice) {
                    am4RteStop('no untried routes remain','error');
                    break;
                }
                am4Rte.attemptCount++;
                am4Rte.selectedRow = choice.row;
                am4Rte.selectedId = choice.id;
                am4Rte.selectedLabel = choice.label;
                am4Rte.attempted[choice.id] = true;
                am4Rte.arrId = am4RteNumericAttr(choice.row,'data-arr') || am4RteScanAirportId(choice.row);
                am4Rte.depId = am4RteNumericAttr(choice.row,'data-dep');
                am4Rte.arrIdSource = am4Rte.arrId ?'selected row' : '';
                var pair = String(choice.label || '').toUpperCase().match(/\b([A-Z]{3,4})\s*(?:-|>|\/|→|–|—)\s*([A-Z]{3,4})\b/);
                am4Rte.depCode = pair ? pair[1] : am4RteAirportCode(choice.row.getAttribute('data-dep'));
                am4Rte.arrCode = pair ? pair[2] : am4RteAirportCode(choice.row.getAttribute('data-arr'));
                if (!am4Rte.arrId && am4Rte.arrCode) {
                    am4Rte.arrId = am4RteAirportIdFromCode(am4Rte.arrCode);
                    if (am4Rte.arrId) am4Rte.arrIdSource = 'airportIconData for ' + am4Rte.arrCode;
                }
                am4Rte.detailsBefore = am4RteSig(am4RteDetailsPane());
                am4RteLog('trying ' + am4Rte.attemptCount + ': ' + choice.label +
                    ' (score ' + Math.round(choice.score) + ', dest id ' + (am4Rte.arrId || 'unknown') +
                    ', locked aircraft ' + (am4Rte.planeId || '?') + ')');
                if (am4RteClick(choice.row,'route ' + choice.label)) am4RteGo('WAIT_DETAILS');
                else am4RteReject('row click failed');
                break;

            case'WAIT_DETAILS' :
                pane = am4RteDetailsPane();
                if (pane && am4RteSig(pane) && am4RteSig(pane) !== am4Rte.detailsBefore) {
                    am4Rte.acceptedSig = am4RteSig(pane);
                    am4RteGo('EVALUATE','route details opened');
                } else if (am4RteElapsed() > 10000) am4RteReject('route details timeout');
                break;

            case'EVALUATE' :
                pane = am4RteDetailsPane();
                if (!pane || (am4Rte.acceptedSig && am4RteSig(pane) !== am4Rte.acceptedSig)) {
                    if (am4RteElapsed() > 2500) am4RteReject('route details became stale');
                    break;
                }
                var count = am4RteAcCount(pane);
                if (count === null) {
                    if (am4RteElapsed() > 3000) am4RteReject('aircraft-on-route count missing');
                    break;
                }
                if (count > AM4_RTE_MAX_AC_ON_ROUTE) {
                    am4RteReject(count + ' aircraft already on route (need < 2)');
                    break;
                }
                if (!am4Rte.arrId) {
                    am4Rte.arrId = am4RteScanAirportId(pane);
                    if (am4Rte.arrId) am4Rte.arrIdSource = 'route details';
                    else if (am4Rte.arrCode) {
                        am4Rte.arrId = am4RteAirportIdFromCode(am4Rte.arrCode);
                        if (am4Rte.arrId) am4Rte.arrIdSource = 'airportIconData for ' + am4Rte.arrCode;
                    }
                }
                am4RteGo('OPEN_CREATE','accepted with ' + count + ' A/C on route');
                break;

            case'BACKSTEP' :
                if (!am4Rte.deselectClicked) {
                    var deselect = am4RteFindDeselectRouteControl();
                    if (deselect) {
                        am4Rte.deselectClicked = true;
                        am4RteClick(deselect,'Discard pending route selection');
                        am4Rte.enteredAt = Date.now();
                        break;
                    }
                    am4Rte.deselectClicked = true;
                }
                pane = am4RteDetailsPane();
                table = am4RteTable();
                if ((!am4RteSig(pane) || am4RteSig(pane) !== am4Rte.backstepSig) && table && am4RteRows(table).length) {
                    am4Rte.selectedRow = null;
                    am4Rte.selectedId = '';
                    am4RteGo('SELECT','backstep completed');
                    break;
                }
                if (!am4Rte.actionDone || (am4RteElapsed() > 3000 && am4Rte.backstepClicks < 3)) {
                    var back = am4RteFindBack(pane);
                    if (back) {
                        am4Rte.backstepClicks++;
                        am4Rte.actionDone = am4RteClick(back,'Back');
                        am4Rte.enteredAt = Date.now();
                    } else if (table && am4RteRows(table).length) {
                        am4Rte.selectedRow = null;
                        am4Rte.selectedId = '';
                        am4RteGo('SELECT','results still open; resuming');
                    } else if (am4RteElapsed() > 10000) am4RteStop('could not back out of the route panel','error');
                } else if (am4RteElapsed() > 10000) am4RteStop('backstep did not change the panel','error');
                break;

            case'OPEN_CREATE' :
                pane = am4RteDetailsPane();
                if (am4Rte.acceptedSig && am4RteSig(pane) !== am4Rte.acceptedSig) {
                    am4RteReject('details changed before creation');
                    break;
                }
                if (typeof am4CanMutate === 'function' && !am4CanMutate()) {
                    if (am4RteElapsed() > 10000) am4RteStop('blocked: another tab is the acting tab','error');
                    break;
                }
                if (!am4Rte.planeId) {
                    am4RteReject('no locked aircraft id');
                    break;
                }
                if (!am4RteArrivalId()) {
                    if (am4RteElapsed() > 10000) am4RteReject('no destination airport id');
                    break;
                }
                if (!am4Rte.actionDone) {
                    am4Rte.actionDone = true;
                    am4Rte.hideStubLogged = false;
                    am4Rte.confirmClicked = false;
                    am4Rte.autoPriceClicked = false;
                    am4Rte.pricesApplied = false;
                    create = am4RteFindCreate(pane);
                    if (create) {
                        am4RteLog('Create control ' + create.sel + ' carries aircraft id ' +
                            (create.acId || 'none') + '; locked to id ' + (am4Rte.planeId || 'unknown') +
                            ' (' + (am4Rte.reg || 'no reg') + ') dest airport ' + (am4RteArrivalId() || 'unknown'));
                    }
                    var genCreate = am4Rte.gen;
                    var createCtrl = create;
                    var why = create
                        ? create.sel + ' carries aircraft id ' + (create.acId || 'none')
                        : 'no create control was bound to the locked aircraft';
                    am4RteStartLockedCreation(why, createCtrl).then(function (started) {
                        if (genCreate !== am4Rte.gen) return;
                        if (am4Rte.state !== 'OPEN_CREATE') return;
                        if (started) {
                            am4Rte.nextClicked = true;
                            am4RteGo('VERIFY','creation requested; verifying aircraft identity');
                        } else {
                            am4RteReject('create-route start failed');
                        }
                        am4RteSchedule();
                    }).catch(function (err) {
                        if (genCreate !== am4Rte.gen) return;
                        if (am4Rte.state !== 'OPEN_CREATE') return;
                        am4RteReject('create-route start failed: ' + ((err && err.message) || err));
                        am4RteSchedule();
                    });
                } else if (am4RteElapsed() > 15000) {
                    am4RteReject('create-route start failed');
                }
                break;

            case'VERIFY' :
                block = am4RteVisibleBlockMessage();
                if (block) {
                    am4RteReject('creation blocked: ' + am4RteBlockMessageText(block));
                    break;
                }
                if (am4Rte.hideStubLogged) {
                    am4RteReject('creation Ajax hid for locked id ' + (am4Rte.planeId || '?') +
                        ' — moving to the next route');
                    break;
                }
                header = am4RteReadCreationReg();
                if (!header.reg) {
                    pending = am4RteFindPendingNext();
                    if (pending && !am4Rte.nextClicked) {
                        am4Rte.nextClicked = true;
                        am4RteLog('creation is waiting on ' + pending.sel +
                            ' (aircraft id ' + (pending.acId || 'none') + ')');
                        if (am4Rte.planeId && am4RteArrivalId() &&
                            (!pending.acId || pending.acId !== am4Rte.planeId)) {
                            if (!am4RteOpenCreationDirect(pending.sel +
                                ' was not bound to the locked aircraft')) {
                                am4RteLog('direct creation request failed; unbound ' +
                                    pending.sel + ' was not clicked','error');
                            }
                        } else {
                            am4RteInvokePendingNext(pending);
                        }
                        am4Rte.enteredAt = Date.now();
                        break;
                    }
                    if (am4RtePriceFields() || am4RteFindAutoPrice()) {
                        am4RteLog('creation panel exposed no registration header; identity check skipped','warn');
                        am4RteGo('WAIT_PRICE','opening pricing');
                    } else if (am4RteElapsed() > 10000) {
                        am4RteReject('creation panel never appeared');
                    }
                    break;
                }
                destMatch = am4RteCreationDestinationMatches();
                if (destMatch === false) {
                    am4Rte.seenReg = header.reg;
                    am4RteGo('RECOVER','creation destination did not match ' +
                        (am4Rte.arrCode || 'the selected route'));
                    break;
                }
                if (destMatch === null) {
                    if (am4RteElapsed() > 10000) {
                        am4Rte.seenReg = header.reg;
                        am4RteGo('RECOVER','could not confirm destination ' + am4Rte.arrCode);
                    }
                    break;
                }
                am4Rte.seenReg = header.reg;
                am4RteLog('header shows ' + header.reg + ' (from ' + header.source +
                    '); expected ' + (am4Rte.reg || 'nothing'));
                if (!am4Rte.reg || am4RteRegsMatch(am4Rte.reg, header.reg)) {
                    am4RteLog('aircraft confirmed for creation: ' + header.reg +
                        ' id ' + am4Rte.planeId);
                    am4RteGo('WAIT_PRICE','opening pricing');
                } else {
                    am4RteLog('AIRCRAFT MISMATCH: expected ' + am4Rte.reg + ' (id ' +
                        am4Rte.planeId + ') but the creation panel shows ' + header.reg,'error');
                    am4RteGo('RECOVER');
                }
                break;

            case'RECOVER' :
                if (am4Rte.fixAttempts >= 2) {
                    am4RteClearNewRouteSelection();
                    am4RteReject('could not bind the route to ' + (am4Rte.reg || am4Rte.planeId) +
                        ' (creation Ajax hid or panel kept opening for ' +
                        (am4Rte.seenReg || 'another aircraft') + ')');
                    break;
                }
                if (!am4Rte.actionDone) {
                    am4Rte.actionDone = true;
                    am4Rte.fixAttempts++;
                    am4Rte.hideStubLogged = false;
                    var genRec = am4Rte.gen;
                    // Bind PHP/session to the locked aircraft again before retrying
                    // creation. Sometimes a plain fleet_details ping isn't enough; the
                    // robust recovery is to re-open the locked aircraft's Details.
                    am4RteReopenLockedDetails().then(function () {
                        if (genRec !== am4Rte.gen) return;
                        return am4RtePingLockedDetails();
                    }).then(function () {
                        if (genRec !== am4Rte.gen) return;
                        return am4RteStartLockedCreation('recover locked id ' + am4Rte.planeId);
                    }).then(function (started) {
                        if (genRec !== am4Rte.gen) return;
                        if (started) {
                            am4Rte.nextClicked = true;
                            am4Rte.seenReg = '';
                            am4RteGo('VERIFY','creation re-requested for ' +
                                (am4Rte.reg || 'the locked aircraft') +
                                ' (fix attempt ' + am4Rte.fixAttempts + ')');
                        } else {
                            am4RteReject('could not bind the route to ' + (am4Rte.reg || am4Rte.planeId));
                        }
                        am4RteSchedule();
                    }).catch(function (err) {
                        if (genRec !== am4Rte.gen) return;
                        am4RteReject('could not bind the route to ' + (am4Rte.reg || am4Rte.planeId) +
                            ': ' + ((err && err.message) || err));
                        am4RteSchedule();
                    });
                } else if (am4RteElapsed() > 15000) {
                    am4RteReject('aircraft recovery timed out');
                }
                break;

            case'WAIT_PRICE' :
                block = am4RteVisibleBlockMessage();
                if (block) {
                    am4RteReject('creation blocked: ' + am4RteBlockMessageText(block));
                    break;
                }
                prices = am4RtePriceFields();
                autoBtn = am4RteFindAutoPrice();
                if (prices || autoBtn) {
                    am4RteLog('pricing panel ready; fields: ' + am4RtePriceLabels(prices) +
                        '; auto price control: ' + (autoBtn ? (autoBtn.id || 'onclick') : 'not found yet'));
                    am4RteGo('AUTOPRICE');
                } else if (am4RteElapsed() > 10000) {
                    am4RteReject('pricing screen timeout');
                }
                break;

            case'AUTOPRICE' :
                block = am4RteVisibleBlockMessage();
                if (block) {
                    am4RteReject('pricing blocked: ' + am4RteBlockMessageText(block));
                    break;
                }
                prices = am4RtePriceFields();
                autoBtn = am4RteFindAutoPrice();
                if (!am4Rte.autoPriceClicked) {
                    if (autoBtn) {
                        am4Rte.autoPriceClicked = am4RteClick(autoBtn,'Auto price');
                        am4Rte.enteredAt = Date.now();
                        break;
                    }
                    if (am4RtePricesReady(prices)) {
                        am4RteLog('no Auto price control visible, but ticket prices are already filled (' +
                            am4RtePriceLabels(prices) + '); using them as the base','warn');
                        am4Rte.autoPriceClicked = true;
                        am4Rte.enteredAt = Date.now();
                        break;
                    }
                    if (am4RteElapsed() > 900 && am4RteInvokeAutoPriceHandler()) {
                        am4Rte.autoPriceClicked = true;
                        am4Rte.enteredAt = Date.now();
                        break;
                    }
                    if (am4RteElapsed() > 10000) am4RteReject('auto-price control not found');
                    break;
                }
                if (!prices) {
                    if (am4RteElapsed() > 10000) am4RteReject('auto-price controls disappeared');
                    break;
                }
                if (am4Rte.pricesApplied) break;
                if (!am4RtePricesReady(prices) || am4RteElapsed() < 600) {
                    if (am4RteElapsed() > 5000) am4RteReject('auto-price returned invalid prices');
                    break;
                }
                if (am4RteApplyCreationPrices()) {
                    am4Rte.pricesApplied = true;
                    am4RteLog('auto-price complete; configured multipliers applied (' +
                        am4RtePriceLabels(am4RtePriceFields()) + ')');
                    am4RteGo('SUBMIT','auto-price complete; multipliers applied');
                } else if (am4RteElapsed() > 5000) {
                    am4RteReject('auto-price returned invalid prices');
                }
                break;

            case'SUBMIT' :
                block = am4RteVisibleBlockMessage();
                if (block) {
                    am4RteReject('pricing validation failed: ' + am4RteBlockMessageText(block));
                    break;
                }
                if (typeof am4CanMutate === 'function' && !am4CanMutate()) {
                    if (am4RteElapsed() > 10000) am4RteStop('blocked: another tab is the acting tab','error');
                    break;
                }
                destMatch = am4RteCreationDestinationMatches();
                if (destMatch === false) {
                    am4RteGo('RECOVER','destination was not confirmed at submit');
                    break;
                }
                if (am4Rte.reg) {
                    submitHeader = am4RteReadCreationReg();
                    if (submitHeader.reg && !am4RteRegsMatch(am4Rte.reg, submitHeader.reg)) {
                        am4RteLog('AIRCRAFT MISMATCH at submit: expected ' + am4Rte.reg +
                            ' but header shows ' + submitHeader.reg,'error');
                        am4Rte.seenReg = submitHeader.reg;
                        am4RteGo('RECOVER');
                        break;
                    }
                }
                prices = am4RtePriceFields();
                confirm = am4RteFindConfirm();
                if (confirm && am4Rte.pricesApplied) {
                    am4Rte.submitSig = am4RteCreationSignature();
                    am4RteLog('clicking confirm to create the route for ' +
                        (am4Rte.reg || am4Rte.planeId) + ' with ' + am4RtePriceLabels(prices));
                    if (am4RteClick(confirm,'Confirm route')) {
                        am4Rte.confirmClicked = true;
                        am4RteGo('WAIT_SUBMIT','route submitted; waiting for server result');
                    }
                } else if (am4RteElapsed() > 10000) {
                    am4RteReject('confirm button or valid prices missing');
                }
                break;

            case'WAIT_SUBMIT' :
                block = am4RteVisibleBlockMessage();
                if (block) {
                    am4RteReject('server rejected route: ' + am4RteBlockMessageText(block));
                    break;
                }
                prices = am4RtePriceFields();
                var panel = am4RteCreationPanel();
                var sigNow = panel ? am4RteCreationSignature() : 0;
                var confirmNow = am4RteFindConfirm();
                // Server accepts the route by tearing down the create panel; if that
                // doesn't happen immediately, the confirm control disappears and/or
                // the panel signature changes.
                if ((!confirmNow && panel && prices) ||
                    (!confirmNow && panel && sigNow !== am4Rte.submitSig) ||
                    (!prices && (!panel || sigNow !== am4Rte.submitSig))) {
                    am4RteStop('route created for ' + (am4Rte.reg || am4Rte.planeId));
                    return;
                }
                if (am4RteElapsed() > AM4_RTE_SUBMIT_TIMEOUT_MS) {
                    am4RteReject('route submission was not confirmed');
                }
                break;
        }
    } catch (err) {
        am4RteStop('tick error: ' + err,'error');
        return;
    }
    if (am4Rte.state !== 'IDLE') am4RteSchedule();
}

function am4RteReopenLockedDetails() {
    // Re-opening Details is what binds the PHP/session aircraft.
    // This is used as a recovery step when the creation panel keeps opening
    // for the wrong map-selected aircraft.
    var btn = am4Rte.detailsButton;
    if (!btn || !btn.isConnected) return Promise.resolve(false);
    try {
        am4RteLog('reopening Details for locked id ' + (am4Rte.planeId || '?'),'warn');
        am4RteClickLockedDetails('Details recover');
        return new Promise(function (resolve) { setTimeout(function () { resolve(true); }, 1200); });
    } catch (e) {
        return Promise.resolve(false);
    }
}

function am4RteOnDetailsClick(event) {
    var btn = event.target && event.target.closest ? event.target.closest(AM4_RTE_DETAILS_SEL) : null;
    if (!btn) return;
    if (am4RteIsForbidden(btn) && !/mode=details|fleet_details|showFlightInfo/i.test(String(btn.getAttribute('onclick') || ''))) return;
    if (/maint_plan_do\.php\?[^"'<>]*type=modify/i.test(String(btn.getAttribute('onclick') || ''))) return;
    if (/maintenance_main\.php/i.test(String(btn.getAttribute('onclick') || ''))) return;
    if (!event.isTrusted) return;
    if (am4RteInsideExcluded(btn) && !event.isTrusted) return;
    if (typeof am4BuildBusy !== 'undefined' && am4BuildBusy) {
        am4RteLog('queued behind Auto-Build — click Details again when it is idle','warn');
        return;
    }
    if (typeof am4RbBusy !== 'undefined' && am4RbBusy) {
        am4RteLog('queued behind Rebuild — click Details again when it is idle','warn');
        return;
    }
    // Never restart an active cycle while we are mid-create/submit.
    // This is exactly what breaks the aircraft binding in your log.
    if (am4Rte.state !== 'IDLE') {
        am4RteLog('already running (' + am4Rte.state + '); ignoring extra Details click','warn');
        return;
    }
    var planeId = am4RteAircraftId(btn) ||
        am4RteExtractAircraftId((btn.getAttribute && btn.getAttribute('onclick')) || '');
    var leftover = am4RteExtractSpecs() || {};
    am4RteStart({
        planeId: planeId || '',
        staleReg: leftover.reg || '',
        staleOrigin: leftover.origin || '',
        staleRange: leftover.range || 0,
        detailsButton: btn
    });
}

function am4RteInstallListener() {
    if (am4RteListenerOn) return;
    am4RteListenerOn = true;
    document.addEventListener('click', am4RteOnDetailsClick, true);
    if (!am4Rte.observer) {
        am4Rte.observer = new MutationObserver(function () {
            if (am4Rte.state !== 'IDLE') am4RteSchedule(60);
        });
        am4Rte.observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class','style','aria-hidden','value' ]
        });
    }
}

function am4DetailsInstallListener() { am4RteInstallListener(); }

// Read-only validation: fetch the game's own route panel, show hub→dest / distance vs
// range / per-flight demand vs the plane's seat fill, and only enable Create if valid.
function am4FleetOnCheckRoute(onDone) {
    var done = (typeof onDone === 'function') ? onDone : function () {};
    am4FleetResetCreateBtn();
    var p = am4FleetSelectedParked();
    var info = document.getElementById('am4RteInfo');
    if (info) info.innerHTML = '';
    if (!p) { am4FleetSetRouteMsg('Pick an aircraft at base first.','#ef4444'); done(null); return; }
    var air = am4FleetResolveAirport((document.getElementById('am4RteDest') || {}).value);
    if (!air) { am4FleetSetRouteMsg('Pick a researched destination from the list, then Check route.','#ef4444'); done(null); return; }
    am4FleetSetRouteMsg('Reading the route from the game…','#38bdf8');
    am4FleetFetchRouteConfig(p.planeId, air.Id).then(function (rc) {
        if (!rc || (!rc.hasCreate && !p.reroute)) { am4FleetSetRouteMsg('The game did not return a valid route panel for this plane/destination.','#ef4444'); done(null); return; }
        var cfg = { y: p.y, j: p.j, f: p.f };
        var range = rc.rangeKm || am4AircraftRangeKm();
        var fill = rc.demand ? am4FleetSeatFill(cfg, rc.demand) : null;
        var blockers = [];
        var prices = am4FleetPricePlan(rc, p.cargo);
        if (p.y <= 0 || p.j <= 0 || p.f <= 0) blockers.push('plane has a 0-seat class (Y' + p.y + ' J' + p.j + ' F' + p.f + ') — the game needs all 3 classes > 0; reconfigure it first');
        if (rc.distKm && rc.distKm > range) blockers.push('distance ' + rc.distKm.toLocaleString() + ' km exceeds the plane range ' + range.toLocaleString() + ' km');
        if (!prices) blockers.push('the game did not provide readable base ticket prices; route creation is blocked rather than submitting guessed prices');
        var rows = [];
        rows.push("<div><b>" + am4FleetEsc(rc.hubIcao || '?') +"</b> &rarr; <b>" + am4FleetEsc(rc.destIcao || air.icao || '') +"</b> " + am4FleetEsc(air.name || '') +"</div>");
        rows.push("<div>" + (rc.distKm ? rc.distKm.toLocaleString() : '?') +" km / range " + range.toLocaleString() +" km &middot; " + (rc.speedKph || '?') +" kph &middot; A/C on route " + (rc.acOnRoute == null ?'?' : rc.acOnRoute) +"</div>");
        if (rc.demand && fill) {
            rows.push("<div>Demand/day Y" + rc.demand.y +" J" + rc.demand.j +" F" + rc.demand.f +" &middot; per flight Y" + fill.perFlight.y +" J" + fill.perFlight.j +" F" + fill.perFlight.f +"</div>");
            rows.push("<div>Plane seats Y" + p.y +" J" + p.j +" F" + p.f +" &middot; fill " +
                ['y','j','f' ].map(function (c) { return c.toUpperCase() + (fill.fills[c] == null ? ' n/a' : ' ' + fill.fills[c] + '%'); }).join(' ') +"</div>");
            if (fill.warnings.length) rows.push("<div style='color:#f59e0b;'>&#9888; " + am4FleetEsc(fill.warnings.join('; ')) +"</div>");
        }
        if (rc.acOnRoute && rc.acOnRoute > 0) rows.push("<div style='color:#f59e0b;'>&#9888; " + rc.acOnRoute +" A/C already on this route — use a distinct route name for a 2nd plane (e.g. add \"-2\").</div>");
        if (blockers.length) rows.push("<div style='color:#ef4444;'>&#10006; " + am4FleetEsc(blockers.join('; ')) +"</div>");
        if (info) info.innerHTML = rows.join('');
        if (blockers.length) { am4FleetSetRouteMsg('Cannot create: ' + blockers[0],'#ef4444'); done(null); return; }
        am4FleetRouteCheck = {
            planeId: p.planeId, destId: String(air.Id), destIcao: rc.destIcao || air.icao || '',
            hubIcao: rc.hubIcao || '?', distKm: rc.distKm || 0, rangeKm: range,
            acOnRoute: rc.acOnRoute || 0,
            willFill: fill ? (fill.warnings.length === 0) : true,
            demand: rc.demand || null,
            prices: prices,
            reroute: !!p.reroute,
            oldRouteId: p.oldRouteId || null
        };
        am4FleetSetRouteMsg('Route looks valid — review, then Create route.','#10b981');
        var btn = document.getElementById('am4RteCreate');
        if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
        done(am4FleetRouteCheck);
    }).catch(function (e) { am4FleetSetRouteMsg('Route read failed: ' + String(e),'#ef4444'); done(null); });
}

function am4FleetDelay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// A routed aircraft must be proved landed at its own base immediately before mutation.
// Grounding preserves the old route, so any failure can safely toggle it back on. The new
// route is considered successful only when the live route id changes.
function am4FleetSubmitCheckedRoute(p, chk, reg, ci) {
    var oldRouteId = null;
    var grounded = false;
    function rollback(err) {
        if (!grounded || !oldRouteId) return Promise.reject(err);
        return am4RbFetchGroundRouteId(p.planeId).then(function (live) {
            if (live && String(live) !== String(oldRouteId)) return Promise.reject(err);
            return am4FleetGround(oldRouteId).then(function () { throw err; });
        }).catch(function (rollbackErr) {
            if (rollbackErr === err) throw err;
            throw new Error(String(err) + ' (old route may still be grounded; verify ' + (p.reg || p.planeId) + ')');
        });
    }
    var prepare = Promise.resolve();
    if (chk.reroute) {
        prepare = am4RbFetchAircraftPage(p.planeId).then(function (page) {
            if (!page || !page.routeId) throw new Error('could not read the existing route id');
            if (page.inFlight) throw new Error('aircraft is no longer landed; wait until it returns to base');
            oldRouteId = String(page.routeId);
            if (chk.oldRouteId && oldRouteId !== String(chk.oldRouteId)) {
                throw new Error('existing route changed since Check route; check again');
            }
            return am4RbReadAircraftState(p.planeId);
        }).then(function (st) {
            if (!st || !st.atBase) throw new Error('aircraft is no longer at its home base');
            return am4FleetGround(oldRouteId);
        }).then(function () {
            grounded = true;
            return am4FleetDelay(1200);
        }).then(function () {
            return am4FleetListAllRows(true);
        }).then(function (rows) {
            var row = rows.filter(function (x) { return x.planeId === p.planeId; })[0];
            if (!row || !/Grounded/i.test(row.status)) {
                throw new Error('the existing route did not enter Grounded state');
            }
        });
    }
    return prepare.then(function () {
        // Re-read after grounding. This is the last authority for origin, range and native
        // Auto prices, and prevents a stale Check result from creating out of the wrong airport.
        return am4FleetFetchRouteConfig(p.planeId, chk.destId);
    }).then(function (rc) {
        if (!rc || !rc.hasCreate) throw new Error('the game did not offer Create route');
        if (chk.hubIcao && chk.hubIcao !== '?' && rc.hubIcao &&
            String(rc.hubIcao) !== String(chk.hubIcao)) {
            throw new Error('route origin changed from ' + chk.hubIcao + ' to ' + rc.hubIcao);
        }
        if (rc.distKm && rc.rangeKm && rc.distKm > rc.rangeKm) throw new Error('destination is out of range');
        var prices = am4FleetPricePlan(rc, p.cargo);
        if (!prices) throw new Error('the game did not provide readable base ticket prices');
        var url = am4FleetBuildRouteUrl(p.planeId, chk.destId, reg, prices, ci);
        if (!url) throw new Error('ticket prices were not available');
        console.log('[AM4 Bot Log] Fleet Assistant creating route with ' + prices.source +
            ' and configured multipliers: ' + url);
        return fetch(url, { credentials: 'include'}).then(function (r) { return r.text(); });
    }).then(function (body) {
        if (/too low|not enough|insufficient|cannot afford|denied|invalid|error|failed/i.test(body || '')) {
            throw new Error('the game refused the route request');
        }
        return am4FleetDelay(2500).then(function () { return am4RbFetchGroundRouteId(p.planeId); });
    }).then(function (liveRouteId) {
        if (!liveRouteId) throw new Error('could not verify the new route id');
        if (oldRouteId && String(liveRouteId) === String(oldRouteId)) {
            throw new Error('the aircraft is still on its old route');
        }
        return { routeId: String(liveRouteId), replaced: !!oldRouteId };
    }).catch(rollback);
}

// Manual, hard-gated create. Fails closed on every gate; only the acting tab may create.
function am4FleetOnCreateClick() {
    var chk = am4FleetRouteCheck;
    if (!chk) { am4FleetSetRouteMsg('Press "Check route" first.','#ef4444'); return; }
    var p = am4FleetSelectedParked();
    if (!p || p.planeId !== chk.planeId) { am4FleetSetRouteMsg('Plane changed — press "Check route" again.','#ef4444'); return; }
    var air = am4FleetResolveAirport((document.getElementById('am4RteDest') || {}).value);
    if (!air || String(air.Id) !== chk.destId) { am4FleetSetRouteMsg('Destination changed — press "Check route" again.','#ef4444'); return; }
    var reg = String((document.getElementById('am4RteReg') || {}).value || '').trim();
    if (!reg) { am4FleetSetRouteMsg('Route name (reg) is required.','#ef4444'); return; }
    var ci = parseInt((document.getElementById('am4RteCi') || {}).value, 10);
    if (!isFinite(ci) || ci < 0 || ci > 200) ci = AM4_FLEET_ROUTE_CI_DEFAULT;

    if (typeof am4CanMutate === 'function' && !am4CanMutate()) { am4FleetSetRouteMsg('Blocked: another tab is the acting tab.','#ef4444'); return; }
    if (p.y <= 0 || p.j <= 0 || p.f <= 0) { am4FleetSetRouteMsg('Blocked: plane has a 0-seat class — the game requires all 3 > 0.','#ef4444'); return; }
    if (p.y + 2 * p.j + 3 * p.f > am4AircraftSeats()) { am4FleetSetRouteMsg('Blocked: seat config exceeds the ' + am4AircraftSeats() + '-slot capacity.','#ef4444'); return; }
    if (chk.distKm && chk.rangeKm && chk.distKm > chk.rangeKm) { am4FleetSetRouteMsg('Blocked: distance exceeds the plane range.','#ef4444'); return; }
    if (typeof getBankBalance === 'function') { var bal = getBankBalance(); if (bal && bal < 5000000) { am4FleetSetRouteMsg('Blocked: balance too low for the route fee.','#ef4444'); return; } }

    if (!window.confirm((chk.reroute ?'Replace the existing route with ' : 'Create route ') + chk.hubIcao + ' → ' + chk.destIcao + ' with ' + (p.reg || p.planeId) + '?\n\n' +
        'Seats Y' + p.y + ' J' + p.j + ' F' + p.f + ' (the plane\'s own config), cost index ' + ci + '.\n' +
        'This spends in-game cash — a route fee (~$1.5M).' +
        (chk.reroute ?'\n\nThe current route is grounded only after the aircraft is re-confirmed at home; it is restored if creation fails.' : '') +
        '\n\nConfigured ticket-price multipliers are applied automatically.')) {
        am4FleetSetRouteMsg('Cancelled.','#94a3b8');
        return;
    }
    am4FleetResetCreateBtn(); // one create per check; a fresh check is needed for another
    am4FleetSetRouteMsg((chk.reroute ?'Re-confirming aircraft at home, then rerouting ' : 'Creating route ') +
        chk.hubIcao + ' → ' + chk.destIcao + '…','#38bdf8');
    am4FleetSubmitCheckedRoute(p, chk, reg, ci).then(function (result) {
        am4FleetSetRouteMsg('✓ Route ' + (result.replaced ?'replaced' : 'created') + ' — ' +
            (p.reg || p.planeId) + ' is routed with multiplied ticket prices.','#10b981');
        am4FleetRenderState();
        am4FleetRenderParkedPicker();
    }).catch(function (e) {
        am4FleetSetRouteMsg('Route not changed: ' + String(e && e.message ? e.message : e),'#ef4444');
    });
}

//================================================================================
// B5b MODIFY / RECONFIGURE (MANUAL, hard-gated). Reconfigure a parked A380's seats
// (the fix that makes a 600/0/0 plane routable) and/or apply the CO2/Speed/Fuel
// upgrades, via the verified contract (GAME_CONTRACTS §12 — Maintenance → Plan → Modify):
// maint_plan_do.php?mode=do&modType=pax&id=<id>&type=modify&eSeat=&bSeat=&fSeat=&mod1=&mod2=&mod3=
// mod1 = CO2 -10%, mod2 = Speed +10%, mod3 = Fuel -10% (each a checkbox, final state 0/1).
// Seat-change cost = (addedBusiness*8000) + (addedFirst*16000); only ADDED J/F seats cost.
// Modify is a timed maintenance event ("kostet Zeit und Geld") AND a MUTATION → user-triggered
// behind confirm() and every fail-closed gate; only parked A380s (which sit at base) are offered.
//================================================================================
var am4FleetModCache = null; // last-read modify info for the selected plane
var am4FleetModInfoCache = {}; // planeId -> parsed modify info
var am4FleetModScanTimer = null;
var am4FleetModParseMissLogged = 0;

function am4SuiteResearchBusy() {
    try {
        return typeof am4Rte !== 'undefined' && am4Rte && am4Rte.state && am4Rte.state !== 'IDLE';
    } catch (e) { return false; }
}

function am4FleetParseModifyInfo(html) {
    html = String(html || '');
    var box = document.createElement('div');
    try { box.innerHTML = html; } catch (e) { box = document.createElement('div'); }
    var jsNum = function (names) {
        for (var i = 0; i < names.length; i++) {
            var re = new RegExp('(?:var\\s+)?' + names[i] + '\\s*=\\s*(-?[\\d.]+)','i');
            var m = html.match(re);
            if (!m) continue;
            var x = parseInt(m[1], 10);
            if (isFinite(x)) return x;
        }
        return null;
    };
    var inpNum = function (sel) {
        var el = box.querySelector(sel);
        if (!el) return null;
        var x = parseInt(String(el.value || el.getAttribute('value') || '').replace(/[^0-9-]/g,''), 10);
        return isFinite(x) ? x : null;
    };
    var modOn = function (n) {
        var v = jsNum(['mod' + n]);
        if (v === 1) return true;
        var el = box.querySelector('#mod' + n + ', #acMod' + n + ', input[name="mod' + n + '"]');
        if (el) {
            var outer = String(el.outerHTML || '');
            if (el.checked || /\bchecked\b/i.test(outer)) return true;
            var host = el.parentElement;
            var lab = host ? String(host.innerText || '') : '';
            if (/already|installed|applied|owned|done/i.test(lab)) return true;
        }
        var idx = html.search(new RegExp('mod' + n + '(?:cost)?','i'));
        if (idx >= 0) {
            var blob = html.slice(idx, idx + 320);
            if (/(already|installed|applied)/i.test(blob) && new RegExp('mod' + n,'i').test(blob)) return true;
        }
        return false;
    };
    var attrNum = function (name) {
        var re = new RegExp('(?:id|name)=["\']' + name + '["\'][^>]*value=["\'](-?\\d+)','i');
        var m = html.match(re);
        if (!m) {
            re = new RegExp('value=["\'](-?\\d+)["\'][^>]*(?:id|name)=["\']' + name + '["\']','i');
            m = html.match(re);
        }
        if (!m) return null;
        var x = parseInt(m[1], 10);
        return isFinite(x) ? x : null;
    };
    var curE = jsNum(['eSeat']); if (curE == null) curE = inpNum('#eSeat, input[name="eSeat"]'); if (curE == null) curE = attrNum('eSeat');
    var curB = jsNum(['bSeat']); if (curB == null) curB = inpNum('#bSeat, input[name="bSeat"]'); if (curB == null) curB = attrNum('bSeat');
    var curF = jsNum(['fSeat']); if (curF == null) curF = inpNum('#fSeat, input[name="fSeat"]'); if (curF == null) curF = attrNum('fSeat');
    var curL = jsNum(['lSeat','lCargo','largeLoad','largeCargo','cargoL' ]);
    if (curL == null) curL = inpNum('#lSeat, input[name="lSeat"], #largeLoad, #lCargo, input[name="largeLoad"]');
    if (curL == null) curL = attrNum('lSeat') || attrNum('largeLoad') || attrNum('lCargo');
    var curH = jsNum(['hSeat','hCargo','heavyLoad','heavyCargo','cargoH' ]);
    if (curH == null) curH = inpNum('#hSeat, input[name="hSeat"], #heavyLoad, #hCargo, input[name="heavyLoad"]');
    if (curH == null) curH = attrNum('hSeat') || attrNum('heavyLoad') || attrNum('hCargo');
    var text = String(box.innerText || box.textContent || '').replace(/\s+/g,' ');
    if (curL == null) {
        var lm = text.match(/Large(?:\s+load)?\s*[:=]?\s*([\d,]+)/i);
        if (lm) curL = parseInt(String(lm[1]).replace(/[^0-9]/g,''), 10);
    }
    if (curH == null) {
        var hm = text.match(/Heavy(?:\s+load)?\s*[:=]?\s*([\d,]+)/i);
        if (hm) curH = parseInt(String(hm[1]).replace(/[^0-9]/g,''), 10);
    }
    // Cargo modify uses a Large↔Heavy slider; read range/value when L/H inputs are empty.
    if ((curL == null || curH == null) && box.querySelector) {
        var range = box.querySelector('input[type="range"], #cargoSlider, #paxConfig, #seatSlider, #configSlider');
        if (range) {
            var pct = parseFloat(String(range.value || range.getAttribute('value') || ''));
            var cap = jsNum(['maxSeats','totalSeats','capacity','acCapacity','cargoCap' ]) || 0;
            if (!(cap > 0)) {
                var capM = text.match(/capacity[^0-9]{0,24}([\d,]+)/i) || html.match(/maxSeats\s*=\s*(\d+)/i);
                if (capM) cap = parseInt(String(capM[1]).replace(/[^0-9]/g,''), 10) || 0;
            }
            if (isFinite(pct) && cap > 0) {
                // Slider 0 = all heavy, 100 = all large (AM4 cargo configure convention).
                var largeShare = Math.max(0, Math.min(100, pct)) / 100;
                var heavyShare = 1 - largeShare;
                if (curL == null) curL = Math.floor((cap * largeShare) / 0.7);
                if (curH == null) curH = Math.floor(cap * heavyShare);
            }
        }
    }
    var cargo = /modType\s*=\s*['"]cargo['"]/i.test(html) ||
        /Large load|Heavy load|cargoSlider|#lSeat|#hSeat/i.test(html) ||
        !!box.querySelector('#lSeat, #hSeat, #largeLoad, #heavyLoad, input[type="range"]') ||
        ((curL != null || curH != null) && curE == null && curB == null && curF == null);
    // Seat numbers or a real modify checkbox — not a bare"eSeat" string from the
    // game shell / route panel, which used to mark unread pages as valid.
    var looksValid = curE != null || curL != null || curH != null || jsNum(['mod1cost']) != null ||
        !!box.querySelector('#mod1, #eSeat, #lSeat, input[name="eSeat"], input[name="lSeat"], input[type="range"]');
    var reason = 'ok';
    if (!looksValid) {
        if (/not at a base|inbound to a base/i.test(html)) reason = 'away';
        else if (/pending maintenance/i.test(html)) reason = 'pending';
        else if ((html || '').length > 2000) reason = 'busy';
        else reason = 'unreadable';
    }
    return {
        looksValid: !!looksValid,
        scanned: true,
        reason: reason,
        cargo: !!cargo,
        curE: curE, curB: curB, curF: curF, curL: curL, curH: curH,
        mod1cost: jsNum(['mod1cost']) || 0,
        mod2cost: jsNum(['mod2cost']) || 0,
        mod3cost: jsNum(['mod3cost']) || 0,
        mod1on: modOn(1),
        mod2on: modOn(2),
        mod3on: modOn(3),
        at: Date.now()
    };
}

function am4FleetModBadge(info) {
    if (!info || info.paused) return 'mods?';
    if (!info.looksValid) {
        if (info.reason === 'away') return 'away';
        if (info.reason === 'pending') return 'maint';
        if (info.reason === 'busy') return 'timer';
        return 'mods?';
    }
    return (info.mod1on ?'✓CO₂' : 'CO₂') + ' ' +
        (info.mod2on ?'✓Spd' : 'Spd') + ' ' +
        (info.mod3on ?'✓Fuel' : 'Fuel');
}

function am4FleetModOptionText(p, info) {
    var seats = (info && info.cargo) || p.cargo
        ? ('L' + ((info && info.curL != null) ? info.curL : (p.l || 0)) + '/H' + ((info && info.curH != null) ? info.curH : (p.h || 0)))
        : ((p.y || 0) + '/' + (p.j || 0) + '/' + (p.f || 0));
    var st = p.status ? (' [' + p.status + ']') : '';
    var mdl = p.model ? (' · ' + p.model) : '';
    var zero = (!info || !info.cargo) && !p.cargo && (p.y === 0 || p.j === 0 || p.f === 0) ?' ⚠no J/F' : '';
    var cargoEmpty = ((info && info.cargo) || p.cargo) &&
        ((((info && info.curL) || p.l || 0) + ((info && info.curH) || p.h || 0)) < 1) ?' ⚠no L/H' : '';
    return (p.reg || p.planeId) + ' (' + seats + ') · ' + am4FleetModBadge(info) + mdl + st + zero + cargoEmpty;
}

function am4FleetModUpdateOption(planeId, info) {
    var sel = document.getElementById('am4ModPlane');
    if (!sel) return;
    var p = am4FleetModListCache.filter(function (x) { return String(x.planeId) === String(planeId); })[0];
    if (!p) return;
    for (var i = 0; i < sel.options.length; i++) {
        if (String(sel.options[i].value) === String(planeId)) {
            sel.options[i].text = am4FleetModOptionText(p, info);
            break;
        }
    }
}

function am4FleetModScanStatus(msg) {
    var el = document.getElementById('am4ModScanStatus');
    if (el) el.innerText = msg || '';
}

function am4FleetModScanStop() {
    if (am4FleetModScanTimer) { clearTimeout(am4FleetModScanTimer); am4FleetModScanTimer = null; }
}

// Skip only planes we actually read (or that the game refused). Unreadable / busy
// stay in the queue so they are retried instead of freezing as"mods? " .
function am4FleetModScanSettled(info) {
    if (!info || info.paused) return false;
    if (info.looksValid) return true;
    return info.reason === 'away' || info.reason === 'pending';
}

function am4FleetModScanStart(ids) {
    am4FleetModScanStop();
    ids = (ids || []).slice();
    var i = 0;
    var pass = 0;
    var tick = function () {
        am4FleetModScanTimer = null;
        if (!document.getElementById('am4ModifyPanel')) return;
        if (am4SuiteResearchBusy()) {
            am4FleetModScanStatus('Upgrade scan paused — Research is using this aircraft.');
            am4FleetModScanTimer = setTimeout(tick, 1200);
            return;
        }
        while (i < ids.length && am4FleetModScanSettled(am4FleetModInfoCache[ids[i]])) i++;
        if (i >= ids.length) {
            if (pass === 0) {
                var retry = ids.filter(function (id) { return !am4FleetModScanSettled(am4FleetModInfoCache[id]); });
                if (retry.length) {
                    pass = 1;
                    ids = retry;
                    i = 0;
                    am4FleetModScanStatus('Retrying ' + retry.length + ' unread upgrade panels…');
                    am4FleetModScanTimer = setTimeout(tick, 800);
                    return;
                }
            }
            am4FleetModScanStatus('Upgrade scan complete — ✓ means that modification is already on the plane.');
            return;
        }
        var id = ids[i++];
        am4FleetModScanStatus('Reading upgrades ' + i + '/' + ids.length + '…');
        am4FleetFetchModifyInfo(id, true).then(function (info) {
            if (info && info.paused) {
                i--;
                am4FleetModScanTimer = setTimeout(tick, 1200);
                return;
            }
            am4FleetModUpdateOption(id, info);
            am4FleetModScanTimer = setTimeout(tick, 380);
        }).catch(function () {
            am4FleetModScanTimer = setTimeout(tick, 600);
        });
    };
    tick();
}

// Read-only: load the game's own per-plane modify panel (no mode=do).
// Never uses Ajax() into a game container, so Research's popup is left alone.
function am4FleetFetchModifyInfo(planeId, fromScan) {
    var cached = am4FleetModInfoCache[planeId];
    if (cached && cached.looksValid && (Date.now() - (cached.at || 0)) < 120000) {
        return Promise.resolve(cached);
    }
    if (am4SuiteResearchBusy()) {
        return Promise.resolve(cached || { looksValid: false, paused: true });
    }
    return am4RteGameGet('maint_plan_do.php?type=modify&id=' + encodeURIComponent(planeId))
        .then(function (res) {
            var html = (res && res.body) || '';
            var info = am4FleetParseModifyInfo(html);
            info.scanned = am4FleetModScanSettled(info);
            if (info.looksValid || info.reason === 'away' || info.reason === 'pending') {
                am4FleetModInfoCache[planeId] = info;
            }
            if (!info.looksValid && am4FleetModParseMissLogged < 4) {
                am4FleetModParseMissLogged++;
                try {
                    am4LogAction('mod','🔎 modify unread id ' + planeId + ' ' + (html || '').length +
                        'b reason=' + (info.reason || '?') +
                        ' eSeat=' + /eSeat/i.test(html) + ' mod1=' + /[#\s]mod1\b/i.test(html));
                } catch (eLog) { /* ignore */ }
            }
            return info;
        });
}

// modN = the FINAL desired state (already-applied mods stay 1); mod1=CO2, mod2=Speed, mod3=Fuel.
function am4FleetBuildModifyUrl(planeId, e, b, f, m1, m2, m3, cargo) {
    var id = encodeURIComponent(planeId);
    var mods = '&mod1=' + (m1 ? 1 : 0) + '&mod2=' + (m2 ? 1 : 0) + '&mod3=' + (m3 ? 1 : 0);
    if (cargo) {
        return 'maint_plan_do.php?mode=do&modType=cargo&id=' + id +
            '&type=modify&lSeat=' + e + '&hSeat=' + b + mods;
    }
    return 'maint_plan_do.php?mode=do&modType=pax&id=' + id +
        '&type=modify&eSeat=' + e + '&bSeat=' + b + '&fSeat=' + f + mods;
}

function am4FleetCargoLHFromProfile() {
    var p = am4AircraftProfile();
    if (!p || !p.cargo) return null;
    var L = (p.cargoAftH || 0) + (p.cargoFwdH || 0);
    var H = (p.cargoAft || 0) + (p.cargoFwd || 0);
    if (L + H < 1) return null;
    return { l: L, h: H };
}

function am4FleetCargoModHost() {
    var el = document.getElementById('am4CargoModHost');
    if (!el) {
        el = document.createElement('div');
        el.id = 'am4CargoModHost';
        el.style.cssText = 'position:absolute;left:-9999px;top:0;width:640px;height:1px;overflow:hidden;';
        document.body.appendChild(el);
    }
    return el;
}

function am4FleetClearCargoModHost() {
    var el = document.getElementById('am4CargoModHost');
    if (el) el.innerHTML = '';
}

function am4FleetInjectCargoModify(planeId) {
    var host = am4FleetCargoModHost();
    host.innerHTML = '';
    var jq = (typeof window.jQuery !== 'undefined' && window.jQuery.ajax) ? window.jQuery : null;
    var fb = (typeof window.fbSig !== 'undefined' && window.fbSig != null) ? String(window.fbSig) : '';
    var data = 'type=modify&id=' + encodeURIComponent(planeId);
    if (fb && data.indexOf('fbSig=') === -1) data +='&fbSig=' + encodeURIComponent(fb);
    return new Promise(function (resolve, reject) {
        if (!jq) {
            reject(new Error('game jQuery missing'));
            return;
        }
        jq.ajax({
            type: 'GET',
            url: 'maint_plan_do.php',
            data: data,
            cache: false,
            dataType: 'html',
            success: function (html) {
                try { jq(host).html(html); } catch (eHtml) { host.innerHTML = html || ''; }
                console.log('[AM4 Bot Log] cargo modify form injected (' + String(html || '').length + ' chars)');
                resolve(html == null ?'' : String(html));
            },
            error: function (xhr) {
                reject(new Error('modify detail HTTP ' + ((xhr && xhr.status) || 0)));
            }
        });
    });
}

function am4FleetSetModField(host, selectors, val) {
    if (!host || !host.querySelectorAll) return 0;
    var nodes = host.querySelectorAll(selectors);
    var i, n = 0;
    for (i = 0; i < nodes.length; i++) {
        nodes[i].value = String(val);
        if (window.jQuery) {
            try { window.jQuery(nodes[i]).val(String(val)).trigger('input').trigger('change'); } catch (eSet) { /* ignore */ }
        }
        try {
            nodes[i].dispatchEvent(new Event('input', { bubbles: true }));
            nodes[i].dispatchEvent(new Event('change', { bubbles: true }));
        } catch (eEv) { /* ignore */ }
        n++;
    }
    return n;
}

function am4FleetSetModCheckbox(host, n, on) {
    if (!host) return;
    var el = host.querySelector('#mod' + n + ', #acMod' + n + ', input[name="mod' + n + '"]');
    if (!el) return;
    el.checked = !!on;
    if (window.jQuery) {
        try { window.jQuery(el).prop('checked', !!on).trigger('change'); } catch (eCb) { /* ignore */ }
    }
}

function am4FleetSpyMaintDo(during) {
    var captured = { url: ''};
    var origAjax = window.Ajax;
    var jq = (typeof window.jQuery !== 'undefined' && window.jQuery.ajax) ? window.jQuery : null;
    var origJqAjax = jq && jq.ajax;
    function note(u) {
        var s = String(u || '');
        if (!/maint_plan_do\.php/i.test(s) || !/mode=do/i.test(s)) return;
        captured.url = s;
        console.log('[AM4 Bot Log] native cargo modify request: ' + s);
    }
    if (typeof origAjax === 'function') {
        window.Ajax = function () {
            var args = Array.prototype.slice.call(arguments);
            note(args[0]);
            if (/maint_plan_do\.php/i.test(String(args[0] || '')) && /mode=do/i.test(String(args[0] || ''))) {
                if (args[1] === 'maintPlanAction' || args[1] === 'maintAction' || args[1] === 'routeAction') {
                    args[1] = 'am4CargoModHost';
                }
            }
            return origAjax.apply(this, args);
        };
    }
    if (origJqAjax) {
        jq.ajax = function (url, options) {
            var u = '', d = '';
            if (typeof url === 'string') {
                u = url;
                d = (options && options.data) || '';
            } else if (url && typeof url === 'object') {
                u = url.url || '';
                d = url.data || '';
            }
            note(u + (d ? ((String(u).indexOf('?') === -1 ?'?' : '&') + d) : ''));
            return origJqAjax.apply(this, arguments);
        };
    }
    function restore() {
        if (origAjax) window.Ajax = origAjax;
        if (jq && origJqAjax) jq.ajax = origJqAjax;
    }
    return Promise.resolve().then(during).then(function (result) {
        restore();
        result = result || {};
        result.nativeUrl = captured.url;
        return result;
    }, function (err) {
        restore();
        throw err;
    });
}

function am4FleetFindCargoModifyButton(host) {
    if (!host || !host.querySelectorAll) return null;
    var nodes = host.querySelectorAll('button, a.btn, input[type="button"], input[type="submit"], [onclick]');
    var i, best = null;
    for (i = 0; i < nodes.length; i++) {
        var oc = String(nodes[i].getAttribute('onclick') || '');
        var text = String(nodes[i].innerText || nodes[i].value || '').replace(/\s+/g,' ').trim();
        if (/maint_plan_do\.php/i.test(oc) && /mode=do/i.test(oc)) return nodes[i];
        if (/modType=cargo/i.test(oc)) return nodes[i];
        if (/modify|confirm|apply|reconfigure/i.test(text) && /maint_plan_do|mode=do|modType/i.test(oc)) best = best || nodes[i];
        if (!best && /^(modify|confirm|apply)$/i.test(text)) best = nodes[i];
    }
    return best || host.querySelector('#btnModifyDo, #btnModDo, .btnModify, [id*="Modify"]');
}

// Cargo modify: drive the game's own form (slider + Large/Heavy), same idea as #btnPurchaseCargoDo.
function am4FleetApplyCargoModifyViaGame(planeId, l, h, m1, m2, m3) {
    return am4FleetInjectCargoModify(planeId).then(function () {
        var host = am4FleetCargoModHost();
        am4FleetSetModField(host,'#lSeat, input[name="lSeat"], #largeLoad, #lCargo', l);
        am4FleetSetModField(host,'#hSeat, input[name="hSeat"], #heavyLoad, #hCargo', h);
        // If the form is slider-driven, push a matching % so the game JS stays consistent.
        var range = host.querySelector('input[type="range"], #cargoSlider, #paxConfig, #seatSlider, #configSlider');
        if (range && (l + h) > 0) {
            var pct = Math.round((l / (l + h)) * 100);
            am4FleetSetModField(host,'input[type="range"], #cargoSlider, #paxConfig, #seatSlider, #configSlider', pct);
            am4FleetSetModField(host,'#lSeat, input[name="lSeat"], #largeLoad, #lCargo', l);
            am4FleetSetModField(host,'#hSeat, input[name="hSeat"], #heavyLoad, #hCargo', h);
        }
        am4FleetSetModCheckbox(host, 1, m1);
        am4FleetSetModCheckbox(host, 2, m2);
        am4FleetSetModCheckbox(host, 3, m3);
        var btn = am4FleetFindCargoModifyButton(host);
        if (!btn) {
            return { ok: false, refused: true, hint: 'no cargo Modify confirm button on the game form'};
        }
        console.log('[AM4 Bot Log] Fleet cargo modify via game form id=' + planeId +
            ' L=' + l + ' H=' + h + ' mods=' + (m1 ? 1 : 0) + (m2 ? 1 : 0) + (m3 ? 1 : 0));
        return am4FleetSpyMaintDo(function () {
            btn.click();
            return new Promise(function (resolve) { setTimeout(resolve, 900); });
        }).then(function (spy) {
            return { clicked: true, nativeUrl: spy && spy.nativeUrl };
        });
    }).then(function (mid) {
        if (!mid || mid.ok === false) return mid;
        return new Promise(function (resolve) {
            setTimeout(function () {
                delete am4FleetModInfoCache[planeId];
                am4FleetFetchModifyInfo(planeId).then(function (after) {
                    am4FleetClearCargoModHost();
                    var loadOk = after && after.looksValid && after.curL === l && after.curH === h;
                    var modsOk = after && (!m1 || after.mod1on) && (!m2 || after.mod2on) && (!m3 || after.mod3on);
                    resolve({
                        ok: !!(after && after.looksValid && (loadOk || modsOk)),
                        refused: false,
                        after: after,
                        nativeUrl: mid.nativeUrl,
                        hint: mid.nativeUrl ? ('sent ' + mid.nativeUrl) : '' 
                    });
                }).catch(function () {
                    am4FleetClearCargoModHost();
                    resolve({ ok: false, refused: false, hint: 'could not re-read after cargo modify'});
                });
            }, 2500);
        });
    }).catch(function (e) {
        am4FleetClearCargoModHost();
        throw e;
    });
}

// Cost = seat-add cost (only added J/F) + cost of NEWLY-ticked mods (already-applied ones are free).
function am4FleetModifyCost(info, newB, newF, want1, want2, want3) {
    var bDiff = info.cargo ? 0 : Math.max(0, newB - (info.curB || 0));
    var fDiff = info.cargo ? 0 : Math.max(0, newF - (info.curF || 0));
    var seatCost = bDiff * 8000 + fDiff * 16000;
    var modCost = 0;
    if (want1 && !info.mod1on) modCost += info.mod1cost;
    if (want2 && !info.mod2on) modCost += info.mod2cost;
    if (want3 && !info.mod3on) modCost += info.mod3cost;
    return { seatCost: seatCost, modCost: modCost, total: seatCost + modCost };
}

function am4FleetSetModMsg(msg, color) {
    var el = document.getElementById('am4ModMsg');
    if (el) { el.innerText = msg; el.style.color = color || '#38bdf8'; }
}

function am4FleetSelectedModPlane() {
    var sel = document.getElementById('am4ModPlane');
    if (!sel) return null;
    return am4FleetModListCache.filter(function (p) { return p.planeId === sel.value; })[0] || null;
}

function am4FleetRenderModPicker() {
    var sel = document.getElementById('am4ModPlane');
    if (!sel) return;
    sel.innerHTML ="<option value=''>reading aircraft…</option>" ;
    am4FleetListModifyA380().then(function (list) {
        if (!list.length) {
            sel.innerHTML ="<option value=''>" + am4FleetEsc('no aircraft — ' + am4FleetModTally) +"</option>" ;
            return;
        }
        // At base first (the routing-prep case), then routed; then by reg for stable scanning.
        list.sort(function (a, b) {
            var d = (AM4_FLEET_AT_BASE_RE.test(a.status) ? 0 : 1) - (AM4_FLEET_AT_BASE_RE.test(b.status) ? 0 : 1);
            return d || String(a.reg).localeCompare(String(b.reg));
        });
        sel.innerHTML = list.map(function (p) {
            return"<option value='" + am4FleetEsc(p.planeId) +"'>" +
                am4FleetEsc(am4FleetModOptionText(p, am4FleetModInfoCache[p.planeId])) +"</option>" ;
        }).join('');
        am4FleetOnModPlaneSelect();
        am4FleetModScanStart(list.map(function (p) { return p.planeId; }));
    }).catch(function () { sel.innerHTML ="<option value=''>could not read fleet</option>" ; });
}

// On plane select: read the game's modify panel, pre-fill the seat inputs with the plane's
// current config, and reflect which upgrades are already applied (those become checked + locked).
function am4FleetOnModPlaneSelect() {
    var p = am4FleetSelectedModPlane();
    var apply = document.getElementById('am4ModApply');
    if (apply) { apply.disabled = true; apply.style.opacity = '0.5'; }
    am4FleetModCache = null;
    if (!p) return;
    if (am4SuiteResearchBusy()) {
        am4FleetSetModMsg('Research is running — upgrade read paused so the route stays on that aircraft.','#f59e0b');
        setTimeout(function () {
            var again = am4FleetSelectedModPlane();
            if (document.getElementById('am4ModPlane') && again && again.planeId === p.planeId) am4FleetOnModPlaneSelect();
        }, 1200);
        return;
    }
    am4FleetSetModMsg('Reading this aircraft\'s current seats and upgrades…','#38bdf8');
    ['am4ModE','am4ModB','am4ModF' ].forEach(function (id) { var el = document.getElementById(id); if (el) el.value = ''; });
    am4FleetFetchModifyInfo(p.planeId).then(function (info) {
        if (info && info.paused) {
            am4FleetSetModMsg('Research is running — upgrade read paused so the route stays on that aircraft.','#f59e0b');
            setTimeout(function () {
                var again = am4FleetSelectedModPlane();
                if (document.getElementById('am4ModPlane') && again && again.planeId === p.planeId) am4FleetOnModPlaneSelect();
            }, 1200);
            return;
        }
        if (info && (info.reason === 'away' || info.reason === 'pending')) {
            am4FleetSetModMsg('This plane is not at base / has pending maintenance — the game will refuse a modify.','#ef4444');
            return;
        }
        if (!info) info = { looksValid: false, cargo: false, reason: 'unreadable'};
        if (info.curE == null) info.curE = p.y;
        if (info.curB == null) info.curB = p.j;
        if (info.curF == null) info.curF = p.f;
        if (info.cargo || p.cargo) {
            info.cargo = true;
            if (info.curL == null && p.l != null) info.curL = p.l;
            if (info.curH == null && p.h != null) info.curH = p.h;
            if ((info.curL == null || info.curH == null || (info.curL + info.curH) < 1)) {
                var fromProf = am4FleetCargoLHFromProfile();
                if (fromProf) {
                    if (!(info.curL > 0)) info.curL = fromProf.l;
                    if (!(info.curH > 0)) info.curH = fromProf.h;
                }
            }
            if (info.curL == null) info.curL = 0;
            if (info.curH == null) info.curH = 0;
        } else {
            if (info.curL == null) info.curL = p.y;
            if (info.curH == null) info.curH = p.j;
        }
        info.mod1on = !!info.mod1on;
        info.mod2on = !!info.mod2on;
        info.mod3on = !!info.mod3on;
        info.mod1cost = info.mod1cost || 0;
        info.mod2cost = info.mod2cost || 0;
        info.mod3cost = info.mod3cost || 0;
        am4FleetModCache = info;
        am4FleetModUpdateOption(p.planeId, info);
        var seatLabel = document.getElementById('am4ModSeatLabel');
        if (seatLabel) seatLabel.innerText = info.cargo ?'Load Large / Heavy' : 'Seats Y / J / F';
        var fInput = document.getElementById('am4ModF');
        if (fInput) fInput.style.display = info.cargo ?'none' : '';
        var setV = function (id, v) { var el = document.getElementById(id); if (el && v != null) el.value = v; };
        if (info.cargo) {
            setV('am4ModE', info.curL); setV('am4ModB', info.curH); setV('am4ModF', 0);
            var note = document.getElementById('am4ModCargoNote');
            if (!note) {
                note = document.createElement('div');
                note.id = 'am4ModCargoNote';
                note.style.cssText = 'font-size:9px; color:#64748b; margin:2px 0 4px;';
                var seatRow = document.getElementById('am4ModE');
                if (seatRow && seatRow.parentElement && seatRow.parentElement.parentElement) {
                    seatRow.parentElement.parentElement.insertAdjacentElement('afterend', note);
                }
            }
            note.innerText = 'Cargo uses the game\'s Large↔Heavy slider. Enter Large / Heavy totals (not Y/J/F). Empty 0/0 is refused.';
        } else {
            setV('am4ModE', info.curE); setV('am4ModB', info.curB); setV('am4ModF', info.curF);
            var noteOff = document.getElementById('am4ModCargoNote');
            if (noteOff) noteOff.innerText = '';
        }
        [['am4ModCo2','mod1on' ], ['am4ModSpeed','mod2on' ], ['am4ModFuel','mod3on' ]].forEach(function (pair) {
            var cb = document.getElementById(pair[0]);
            if (!cb) return;
            var applied = info[pair[1]];
            cb.checked = applied;
            cb.disabled = applied;
        });
        var apply2 = document.getElementById('am4ModApply');
        if (apply2) { apply2.disabled = false; apply2.style.opacity = '1'; }
        try { am4FleetUpdateModCost(); } catch (eCost) {
            try { am4LogAction('mod','🔎 modify cost preview failed: ' + String(eCost)); } catch (eLog) { /* ignore */ }
        }
        var have = [];
        if (info.mod1on) have.push('CO₂ −10%');
        if (info.mod2on) have.push('Speed +10%');
        if (info.mod3on) have.push('Fuel −10%');
        var miss = [];
        if (!info.mod1on) miss.push('CO₂');
        if (!info.mod2on) miss.push('Speed');
        if (!info.mod3on) miss.push('Fuel');
        am4FleetSetModMsg(
            (info.looksValid ?'' : 'Upgrade list was unread — seats taken from the fleet table. Tick the missing upgrades and Apply. ') +
            (have.length ? ('Already on this plane: ' + have.join(', ') + '. ') : 'No upgrades installed yet. ') +
            (miss.length ? ('Still missing: ' + miss.join(', ') + '.') : 'All three upgrades are installed.'),
            info.looksValid ? (have.length === 3 ?'#10b981' : '#94a3b8') : '#f59e0b' 
        );
    }).catch(function (e) { am4FleetSetModMsg('Modify read failed: ' + String(e),'#ef4444'); });
}

function am4FleetReadModForm() {
    var iv = function (id) { return parseInt((document.getElementById(id) || {}).value, 10); };
    var cb = function (id) { var el = document.getElementById(id); return !!(el && el.checked); };
    return {
        e: iv('am4ModE'), b: iv('am4ModB'), f: iv('am4ModF'),
        co2: cb('am4ModCo2'), speed: cb('am4ModSpeed'), fuel: cb('am4ModFuel')
    };
}

// Slot capacity is a property of the MODEL. It is only known reliably for the selected
// type (read from its order page); for any other model the hard cap is skipped and the
// game itself is the gate (it refuses an over-capacity config).
function am4FleetModSlotCap(p) {
    if (p && p.model && String(p.model).toLowerCase() !== String(am4AircraftName()).toLowerCase()) return 0;
    return am4AircraftSeats();
}

function am4FleetUpdateModCost() {
    try {
        var el = document.getElementById('am4ModCost');
        var cache = am4FleetModCache;
        if (!el || !cache) return;
        var f = am4FleetReadModForm();
        var e = isFinite(f.e) ? f.e : 0, b = isFinite(f.b) ? f.b : 0, fst = isFinite(f.f) ? f.f : 0;
        var cost = am4FleetModifyCost(cache, b, fst, f.co2, f.speed, f.fuel);
        if (cache.cargo) {
            var warnC = '';
            if ((e + b) < 1) warnC =" <span style='color:#ef4444;'>· Large+Heavy must be &gt; 0 (game slider config)</span>" ;
            el.innerHTML = 'Load L' + e + ' / H' + b + ' · cost <b>$' +
                cost.total.toLocaleString() + '</b> (config $' + cost.seatCost.toLocaleString() +
                ' + upgrades $' + cost.modCost.toLocaleString() + ')' + warnC;
            return;
        }
        var slots = e + 2 * b + 3 * fst;
        var cap = am4FleetModSlotCap(am4FleetSelectedModPlane());
        var warn = '';
        if (cap && slots > cap) warn =" <span style='color:#ef4444;'>· " + slots +"/" + cap +" slots (too many)</span>" ;
        else if (e <= 0 || b <= 0 || fst <= 0) warn =" <span style='color:#f59e0b;'>· a 0-seat class stays un-routable</span>" ;
        else if (!cap) warn =" <span style='color:#94a3b8;'>· capacity of this model is not tracked — the game refuses an over-capacity config</span>" ;
        el.innerHTML = 'Seats ' + e + '/' + b + '/' + fst + ' = ' + slots + (cap ?'/' + cap : '') + ' slots · cost <b>$' +
            cost.total.toLocaleString() + '</b> (seats $' + cost.seatCost.toLocaleString() + ' + upgrades $' + cost.modCost.toLocaleString() + ')' + warn;
    } catch (eCost) {
        try { am4LogAction('mod','🔎 modify cost preview failed: ' + String(eCost)); } catch (eLog) { /* ignore */ }
    }
}

// Manual, hard-gated modify. Fails closed; only the acting tab may apply.
function am4FleetOnModifyClick() {
    var p = am4FleetSelectedModPlane();
    var info = am4FleetModCache;
    if (!p || !info) { am4FleetSetModMsg('Pick a plane first.','#ef4444'); return; }
    var f = am4FleetReadModForm();
    if (info.cargo) {
        if (![f.e, f.b].every(function (x) { return isFinite(x) && x >= 0; })) {
            am4FleetSetModMsg('Large / Heavy must be 0 or more.','#ef4444');
            return;
        }
        if ((f.e + f.b) < 1) {
            am4FleetSetModMsg('Blocked: cargo Large+Heavy is 0/0. Set the load (game slider totals) before applying upgrades.','#ef4444');
            return;
        }
    } else if (![f.e, f.b, f.f].every(function (x) { return isFinite(x) && x >= 0; })) {
        am4FleetSetModMsg('Seats must be 0 or more.','#ef4444');
        return;
    }
    var slots = info.cargo ? (f.e + f.b) : (f.e + 2 * f.b + 3 * f.f);
    var slotCap = info.cargo ? 0 : am4FleetModSlotCap(p);
    if (slotCap && slots > slotCap) { am4FleetSetModMsg('Blocked: ' + slots + ' > ' + slotCap + ' slots. Reduce seats.','#ef4444'); return; }
    var seatsChanged = info.cargo
        ? (f.e !== info.curL || f.b !== info.curH)
        : (f.e !== info.curE || f.b !== info.curB || f.f !== info.curF);
    var newMods = (f.co2 && !info.mod1on) || (f.speed && !info.mod2on) || (f.fuel && !info.mod3on);
    if (!seatsChanged && !newMods) { am4FleetSetModMsg('Nothing to change (same seats, no new upgrades).','#f59e0b'); return; }
    if (am4SuiteResearchBusy()) { am4FleetSetModMsg('Blocked: Research is creating a route. Wait until it finishes.','#ef4444'); return; }
    if (typeof am4CanMutate === 'function' && !am4CanMutate()) { am4FleetSetModMsg('Blocked: another tab is the acting tab.','#ef4444'); return; }
    var cost = am4FleetModifyCost(info, f.b, f.f, f.co2, f.speed, f.fuel);
    if (typeof getBankBalance === 'function') { var bal = getBankBalance(); if (bal && cost.total > bal) { am4FleetSetModMsg('Blocked: cost $' + cost.total.toLocaleString() + ' exceeds balance.','#ef4444'); return; } }

    var addsUp = [];
    if (f.co2 && !info.mod1on) addsUp.push('CO2 -10%');
    if (f.speed && !info.mod2on) addsUp.push('Speed +10%');
    if (f.fuel && !info.mod3on) addsUp.push('Fuel -10%');
    var routedWarn = (p.status && !AM4_FLEET_AT_BASE_RE.test(p.status))
        ?'\n\n⚠ This plane is ' + p.status + ' — modifying pulls it OFF its route during the modify timer (it must be at base, or the game will refuse).' 
        : '';
    if (!window.confirm('Modify ' + (p.reg || p.planeId) + '?\n\n' +
        (info.cargo
            ? ('Load ' + info.curL + '/' + info.curH + ' → ' + f.e + '/' + f.b)
            : ('Seats ' + info.curE + '/' + info.curB + '/' + info.curF + ' → ' + f.e + '/' + f.b + '/' + f.f)) +
        (addsUp.length ?'\nUpgrades: ' + addsUp.join(', ') : '\nNo new upgrades') +
        '\n\nCost: ~$' + cost.total.toLocaleString() + ' (in-game cash) + a modification timer.\n' +
        'The plane is unavailable while it is being modified.' + routedWarn)) {
        am4FleetSetModMsg('Cancelled.','#94a3b8');
        return;
    }
    var apply = document.getElementById('am4ModApply');
    if (apply) { apply.disabled = true; apply.style.opacity = '0.5'; }
    var want1 = !!(f.co2 || info.mod1on);
    var want2 = !!(f.speed || info.mod2on);
    var want3 = !!(f.fuel || info.mod3on);
    delete am4FleetModInfoCache[p.planeId];
    am4FleetSetModMsg('Applying modification…','#38bdf8');

    if (info.cargo) {
        am4FleetApplyCargoModifyViaGame(p.planeId, f.e, f.b, want1, want2, want3).then(function (res) {
            if (res && res.ok) {
                am4FleetSetModMsg('✓ Cargo modification applied to ' + (p.reg || p.planeId) +
                    (res.nativeUrl ? ' (game form).' : ' (a timer may run).'), '#10b981');
                am4FleetRenderState();
                am4FleetRenderModPicker();
            } else if (res && res.refused) {
                am4FleetSetModMsg('Modify looks REFUSED. ' + (res.hint || 'Check funds / that the plane is at base / Large+Heavy.'),'#ef4444');
                if (apply) { apply.disabled = false; apply.style.opacity = '1'; }
            } else {
                am4FleetSetModMsg('Sent — but not yet confirmed' +
                    (res && res.hint ? (' (' + res.hint + ')') : '') +
                    '. Verify Large/Heavy and upgrades in-game.','#f59e0b');
                if (apply) { apply.disabled = false; apply.style.opacity = '1'; }
            }
        }).catch(function (e) {
            am4FleetSetModMsg('Cargo modify failed: ' + String(e),'#ef4444');
            if (apply) { apply.disabled = false; apply.style.opacity = '1'; }
        });
        return;
    }

    var url = am4FleetBuildModifyUrl(p.planeId, f.e, f.b, f.f, want1, want2, want3, false);
    console.log('[AM4 Bot Log] Fleet Assistant modifying: ' + url);
    am4RteGameGet(url).then(function (res) {
        var body = (res && res.body) || '';
        var refused = /too low|not enough|insufficient|cannot afford|denied|invalid|failed/i.test(body || '');
        setTimeout(function () {
            am4FleetFetchModifyInfo(p.planeId).then(function (after) {
                var seatsNow = after && (after.curE === f.e && after.curB === f.b && after.curF === f.f);
                var modsNow = after && (!f.co2 || after.mod1on) && (!f.speed || after.mod2on) && (!f.fuel || after.mod3on);
                if (after && after.looksValid && (seatsNow || modsNow)) {
                    am4FleetSetModMsg('✓ Modification applied to ' + (p.reg || p.planeId) + ' (a timer may run before it completes).','#10b981');
                    am4FleetRenderState();
                    am4FleetRenderModPicker();
                } else if (refused) {
                    am4FleetSetModMsg('Modify looks REFUSED by the game. Check funds / that the plane is at base.','#ef4444');
                } else {
                    am4FleetSetModMsg('Sent — but not yet confirmed (a modify timer may be running). Verify in-game.','#f59e0b');
                }
            }).catch(function () { am4FleetSetModMsg('Sent — could not re-read to confirm; verify in-game.','#f59e0b'); });
        }, 2500);
    }).catch(function (e) { am4FleetSetModMsg('Modify request failed: ' + String(e),'#ef4444'); });
}

// ---- Separate 🔧 Modify panel (split out of ✈ Fleet so the Fleet panel stays readable) ----
function am4ModifyInjectButton() { /* Modify lives under ✈ Fleet */ }

function am4ModifyTogglePanel() {
    var fleet = document.getElementById('am4FleetPanel');
    if (!fleet) fleet = am4FleetBuildPanel();
    fleet.style.display = 'block';
    am4ModifyBuildPanel();
    var host = document.getElementById('am4FleetModHost');
    if (host && host.scrollIntoView) try { host.scrollIntoView({ block: 'nearest'}); } catch (e) { /* ignore */ }
}

function am4ModifyBuildPanel() {
    var host = document.getElementById('am4FleetModHost');
    var old = document.getElementById('am4ModifyPanel');
    if (old && host && host.contains(old)) return old;
    if (old) old.remove();
    var panel = document.createElement('div');
    panel.id = 'am4ModifyPanel';
    if (host) {
        panel.style.cssText = 'margin-top:8px; border-top:1px dashed #334155; padding-top:8px;';
        host.appendChild(panel);
    } else {
        panel.style.cssText = 'position:fixed; top:60px; right:20px; width:min(440px, calc(100vw - 24px)); max-height:84vh; overflow-y:auto; background:rgba(15,19,26,0.98); border:1px solid #34495e; border-radius:8px; color:#e2e8f0; font-family:monospace; font-size:12px; z-index:1041; padding:14px; box-shadow:0 6px 24px rgba(0,0,0,0.6); display:none;';
        document.body.appendChild(panel);
    }
    panel.innerHTML =
        "<div style='display:flex; margin-bottom:6px;'><span style='flex-grow:1; font-size:13px; font-weight:bold; color:#38bdf8; letter-spacing:1px;'>🔧 MODIFY / RECONFIGURE</span>" +
        "<span id='am4ModifyRefresh' title='Reload aircraft list' style='cursor:pointer; color:#38bdf8; padding:0 6px;'>⟳</span>" +
        "<span id='am4ModifyClose' style='cursor:pointer; color:#ef4444; font-weight:bold; padding:0 4px;'>[X]</span></div>" +
        "<div style='font-size:10px; color:#f87171; margin:5px 0; line-height:1.4;'>⚠ Spends in-game cash + a modification timer. Reconfigure an aircraft's seats (fixes all-economy → routable) and/or apply CO₂/Speed/Fuel upgrades. Every aircraft in the fleet is listed except those in maintenance, with its model and status; a routed one is pulled off its route while modifying. Already-applied upgrades show ticked &amp; locked.</div>" +
        "<div id='am4ModScanStatus' style='font-size:10px; color:#64748b; margin:2px 0 6px;'></div>" +
        "<div class='am4-exp-row' style='display:flex; justify-content:space-between; align-items:center; gap:8px; margin:5px 0;'><label style='color:#94a3b8;'>Aircraft</label><select id='am4ModPlane' style='max-width:250px; background:#1e293b; border:1px solid #475569; color:#e2e8f0; border-radius:4px; padding:2px 5px; font-family:monospace; font-size:12px;'><option>loading…</option></select></div>" +
        "<div class='am4-exp-row' style='display:flex; justify-content:space-between; align-items:center; gap:6px; margin:5px 0;'><label id='am4ModSeatLabel' style='color:#94a3b8;'>Seats Y / J / F</label><span style='display:flex; gap:4px;'>" +
        "<input type='number' id='am4ModE' min='0' max='" + am4AircraftSeats() +"' style='width:52px; background:#1e293b; border:1px solid #475569; color:#e2e8f0; border-radius:4px; padding:2px 4px; font-family:monospace;'>" +
        "<input type='number' id='am4ModB' min='0' max='300' style='width:52px; background:#1e293b; border:1px solid #475569; color:#e2e8f0; border-radius:4px; padding:2px 4px; font-family:monospace;'>" +
        "<input type='number' id='am4ModF' min='0' max='200' style='width:52px; background:#1e293b; border:1px solid #475569; color:#e2e8f0; border-radius:4px; padding:2px 4px; font-family:monospace;'></span></div>" +
        "<div class='am4-exp-row' style='display:flex; gap:12px; align-items:center; margin:5px 0; font-size:11px; color:#cbd5e1;'>" +
        "<label style='cursor:pointer;'><input type='checkbox' id='am4ModCo2'> CO₂ −10%</label>" +
        "<label style='cursor:pointer;'><input type='checkbox' id='am4ModSpeed'> Speed +10%</label>" +
        "<label style='cursor:pointer;'><input type='checkbox' id='am4ModFuel'> Fuel −10%</label></div>" +
        "<div id='am4ModCost' style='font-size:11px; color:#94a3b8; margin:4px 0;'></div>" +
        "<div class='am4-exp-btnrow' style='display:flex; gap:8px; margin-top:6px; align-items:center;'><button id='am4ModApply' disabled style='cursor:pointer; border:none; border-radius:5px; padding:6px 12px; font-family:monospace; font-size:12px; font-weight:bold; background:#7f1d1d; color:#fecaca; opacity:0.5;'>Apply modify (in-game cash)</button><span id='am4ModMsg' style='font-size:10px; color:#38bdf8; word-break:break-word; flex-grow:1;'></span></div>" +
        "<div style='font-size:9px; color:#64748b; margin-top:8px; border-top:1px dashed #334155; padding-top:6px;'>Pax: maint_plan_do.php?mode=do&modType=pax… (eSeat/bSeat/fSeat). Cargo: uses the game's Large↔Heavy slider form (not pax seats); empty 0/0 is blocked. mod1=CO₂ / mod2=Speed / mod3=Fuel. The plane enters a modification timer, then returns configured — then route it via ✈ Fleet.</div>";
    var closeBtn = document.getElementById('am4ModifyClose');
    if (closeBtn) {
        if (host) closeBtn.style.display = 'none';
        else closeBtn.addEventListener('click', function () { panel.style.display = 'none'; am4FleetModScanStop(); });
    }
    document.getElementById('am4ModifyRefresh').addEventListener('click', am4FleetRenderModPicker);
    document.getElementById('am4ModPlane').addEventListener('change', am4FleetOnModPlaneSelect);
    var am4ModCostPreview = function () { try { am4FleetUpdateModCost(); } catch (eCost) { /* ignore */ } };
    ['am4ModE','am4ModB','am4ModF' ].forEach(function (id) { document.getElementById(id).addEventListener('input', am4ModCostPreview); });
    ['am4ModCo2','am4ModSpeed','am4ModFuel' ].forEach(function (id) { document.getElementById(id).addEventListener('change', am4ModCostPreview); });
    document.getElementById('am4ModApply').addEventListener('click', am4FleetOnModifyClick);
    am4FleetRenderModPicker();
    if (!host && typeof am4PanelChrome === 'function') am4PanelChrome(panel,'modify');
    return panel;
}

// Open the Modify panel pre-selected on a plane, optionally overriding the seat target (used by
// the Explorer Build flow's "reconfigure to fit" path). e/b/f may be omitted to keep the plane's config.
function am4ModifyPrefill(planeId, e, b, f) {
    var panel = document.getElementById('am4ModifyPanel');
    if (!panel || panel.style.display !== 'block') { panel = am4ModifyBuildPanel(); panel.style.display = 'block'; }
    var tries = 0;
    (function wait() {
        var sel = document.getElementById('am4ModPlane');
        if (sel && sel.options.length > 0 && am4FleetModListCache.length) {
            if (am4FleetModListCache.filter(function (p) { return p.planeId === String(planeId); })[0]) {
                sel.value = String(planeId);
                sel.dispatchEvent(new Event('change', { bubbles: true }));
                if (e != null && b != null && f != null) {
                    // wait for the modify info to load (am4FleetOnModPlaneSelect fetch), then override seats
                    var t2 = 0;
                    (function wait2() {
                        if (am4FleetModCache) {
                            var setV = function (id, v) { var el = document.getElementById(id); if (el) { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); } };
                            setV('am4ModE', e); setV('am4ModB', b); setV('am4ModF', f);
                        } else if (t2++ < 30) { setTimeout(wait2, 200); }
                    })();
                }
            }
        } else if (tries++ < 40) { setTimeout(wait, 200); }
    })();
}

// Pre-select an order hub in the ✈ Fleet BUY dropdown by matching an Explorer hub name
// ("Prishtina, Kosovo") against the order option text ("Prishtina" — the pre-comma part).
function am4FleetSelectHubForOrder(hubName) {
    var sel = document.getElementById('am4FleetHub');
    if (!sel || !hubName) return false;
    var want = String(hubName).split(',')[0].trim().toLowerCase();
    for (var i = 0; i < sel.options.length; i++) {
        var t = (sel.options[i].text || '').trim().toLowerCase();
        if (t && (t === want || want.indexOf(t) === 0 || t.indexOf(want) === 0)) {
            sel.selectedIndex = i;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        }
    }
    return false;
}

// Expose read-only pieces for headless testing (the buy + route-create are user-triggered only).
window.AM4Fleet = {
    readState: am4FleetReadState, fetchOrderInfo: am4FleetFetchOrderInfo,
    parseSummary: am4FleetParseSummary, parseA380: am4FleetParseA380,
    injectButton: am4FleetInjectButton, buildPanel: am4FleetBuildPanel,
    // B5 route builder (read-only helpers + URL builder; the create is user-triggered)
    listParkedA380: am4FleetListParkedA380, resolveAirport: am4FleetResolveAirport,
    listTypeIds: am4FleetListTypeIds, listAllRows: am4FleetListAllRows,
    listRouteCandidates: am4FleetListRouteCandidates,
    statusTally: am4FleetStatusTally,
    fetchRouteConfig: am4FleetFetchRouteConfig, parseRouteConfig: am4FleetParseRouteConfig,
    seatFill: am4FleetSeatFill, pricePlan: am4FleetPricePlan, buildRouteUrl: am4FleetBuildRouteUrl,
    // B5b modify/reconfigure (read-only helpers + URL builder; the apply is user-triggered)
    fetchModifyInfo: am4FleetFetchModifyInfo, parseModifyInfo: am4FleetParseModifyInfo,
    modifyCost: am4FleetModifyCost, buildModifyUrl: am4FleetBuildModifyUrl,
    listModifyA380: am4FleetListModifyA380, modifyPanel: am4ModifyBuildPanel,
    modifyPrefill: am4ModifyPrefill, selectHubForOrder: am4FleetSelectHubForOrder
};


//================================================================================
// Part 16: AUTO-BUILD PIPELINE (B6 — the full chain from one Explorer"Build" click)
//
// One click on a route enqueues a job that runs itself in the background over ~6 h:
// order (named + seat-configured, so nothing needs re-seating after delivery)
// → await delivery (~5 h) → modify (CO2 + Speed + Fuel; seats already set, ~40 min)
// → await modify → create route. Departures then happen via normal Auto-Depart.
//
// HIGH-STAKES: each job auto-spends that type's order cost + seat cost + mods +
// route ~$1.5M. Fail-closed everywhere:
// - Runs only while"Auto-run" is ON (default OFF) AND this tab holds the lease AND
// not in quiet hours AND the low-funds brake is off.
// - Every spend step re-checks the balance (and the A380 $ cap on the order).
// - Queue persisted in localStorage → survives reloads across the 5 h wait.
// - Any unexpected/ambiguous game response HALTS that job ('error') — never a blind
// retry of a spend. Scheduler advances at most ONE job-step per tick (slow + observable).
// Contracts reused (all verified): ac_order_do.php (§9, custom e/b/f + reg),
// maint_plan_do.php modify (§12), new_route_info.php create (§10). No new contract.
//================================================================================
var AM4_BUILD_QUEUE_KEY = 'am4BuildQueue';
var AM4_BUILD_AUTORUN_KEY = 'am4BuildAutoRun';
var AM4_BUILD_TICK_MS = 120000;
var AM4_BUILD_POLL_MS = 300000; // await-delivery / await-modify re-check spacing
var am4BuildQueue = [];
var am4BuildTimer = null;
var am4BuildBusy = false;

(function loadBuildQueue() {
    try { var raw = JSON.parse(localStorage.getItem(AM4_BUILD_QUEUE_KEY) || '[]'); if (Array.isArray(raw)) am4BuildQueue = raw; } catch (e) { am4BuildQueue = []; }
    setTimeout(function () {
        if (typeof am4BuildSweepRoutedJobs === 'function') am4BuildSweepRoutedJobs();
    }, 2500);
})();
function am4BuildSweepRoutedJobs() {
    var routeJobs = am4BuildQueue.filter(function (j) { return j.state === 'route' && j.planeId; });
    if (!routeJobs.length) return Promise.resolve(false);
    return am4FleetListAllRows(true).then(function (rows) {
        routeJobs.forEach(function (job) {
            var p = rows.filter(function (x) { return String(x.planeId) === String(job.planeId); })[0];
            if (p && am4BuildJobAlreadyRouted(p, job)) am4BuildSetState(job,'done','already routed ✓');
        });
    }).catch(function () { /* ignore */ });
}

function am4BuildSaveQueue() { try { localStorage.setItem(AM4_BUILD_QUEUE_KEY, JSON.stringify(am4BuildQueue)); } catch (e) { /* ignore */ } }
function am4BuildAutoRun() { try { return localStorage.getItem(AM4_BUILD_AUTORUN_KEY) === '1'; } catch (e) { return false; } }
function am4BuildSetAutoRun(on) { try { localStorage.setItem(AM4_BUILD_AUTORUN_KEY, on ?'1' : '0'); } catch (e) { /* ignore */ } am4BuildKeepAlive(on); }
var AM4_BUILD_ACTIVE = ['order','await_delivery','modify','await_modify','route' ];

// While a backlog exists, drain at this fast cadence (still ONE spend at a time) instead of waiting
// the full 2-min heartbeat between steps - a 100-plane pile must not take hours. Only fires after a
// step that made real PROGRESS (see am4BuildRunStep), so a gated/awaiting job is never hot-refetched.
var AM4_BUILD_DRAIN_MS = 8000;

// Background-tab keepalive (v1.28). THE fix for"the queue only advances when I trigger it" : Chrome
// FREEZES / heavily throttles a backgrounded tab's timers after a few minutes, so the setInterval
// scheduler stops ticking and the whole queue stalls until the tab is foregrounded again. A tab that
// is"playing media" is exempt from that freeze, so while Auto-run is ON we hold a silent, looping
// <audio> element. Best-effort: play() can be blocked until a user gesture, so it is (re)started from
// the Auto-run checkbox change (which IS a gesture) and retried on load; the visibilitychange/focus
// catch-up in am4BuildStartScheduler covers the transitions. It spends nothing and never touches the
// game - it only keeps the timer alive. (Chrome may show a speaker icon on the tab; it stays silent.)
var am4BuildKeepAliveEl = null;
var AM4_BUILD_SILENT_WAV = 'data:audio/wav;base64,UklGRrQBAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YZABAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA';
var am4KeepAliveWanted = false;

function am4BuildKeepAlive(on) {
    am4KeepAliveWanted = !!on;
    try {
        if (on) {
            if (!am4BuildKeepAliveEl) {
                var a = document.createElement('audio');
                a.loop = true;
                a.setAttribute('aria-hidden','true');
                a.style.display = 'none';
                a.src = AM4_BUILD_SILENT_WAV;
                a.volume = 0.001; // effectively silent, but non-zero so the browser counts it as real playback
                (document.body || document.documentElement).appendChild(a);
                // THE CLOCK THE BROWSER CANNOT FREEZE. Media playback is exempt from the
                // background throttling that stops setInterval, so a PLAYING audio element
                // keeps firing timeupdate about four times a second no matter how long the
                // window has been in the background. Everything funnels through the throttled
                // am4Heartbeat, so this costs nothing when there is no work to do.
                a.addEventListener('timeupdate', function () { am4Heartbeat('audio'); });
                am4BuildKeepAliveEl = a;
            }
            am4KeepAliveEnsure();
        } else if (am4BuildKeepAliveEl) {
            try { am4BuildKeepAliveEl.pause(); } catch (e2) { /* ignore */ }
        }
    } catch (e) { /* keepalive is best-effort; the scheduler still works while the tab is visible */ }
    am4WireHeartbeat();
}

// play() needs a user gesture, and a page reload silently leaves the element paused - which
// is exactly how a queue ends up"asleep until you click something" . So instead of trying
// once, keep trying: on every real interaction and on a slow timer, until it actually plays.
function am4KeepAliveEnsure() {
    if (!am4KeepAliveWanted) return false;
    var a = am4BuildKeepAliveEl;
    if (!a) return false;
    if (!a.paused) return true;
    try {
        var p = a.play();
        if (p && p.catch) p.catch(function () { /* still no gesture - try again next time */ });
    } catch (e) { /* ignore */ }
    return !a.paused;
}
function am4KeepAliveRunning() { return !!(am4BuildKeepAliveEl && !am4BuildKeepAliveEl.paused); }

//================================================================================
// Freeze-proof heartbeat
//
// Why this exists (reported live 2026-08-16):"the window sleeps and doesn't start by 
// itself - I have to trigger something." That is real. Chrome does not merely slow a
// hidden tab's timers, it can freeze them for minutes, and the keepalive that is supposed
// to exempt the tab needs a user gesture before it may start - so after a reload it
// frequently never started, and nothing on screen said so.
//
// Three independent sources feed one throttled entry point, because any single one of them
// can fail on its own:
// 1. the playing audio's timeupdate  - immune to background throttling (the real fix)
// 2. a plain interval - correct while the window is in the foreground
// 3. every wake-up signal the page can see (visibility, focus, pointer, key)
//
// The throttle means the queue advances about once a minute and never faster, no matter
// how many sources fire - the audio clock alone would otherwise call it 4x per second.
//================================================================================
var AM4_HEARTBEAT_MS = 60000;
var am4HeartbeatLast = 0;
var am4HeartbeatSource = '';
var am4HeartbeatCount = 0;
var am4HeartbeatWired = false;

function am4Heartbeat(source) {
    var now = Date.now();
    if (now - am4HeartbeatLast < AM4_HEARTBEAT_MS) return false;
    am4HeartbeatLast = now;
    am4HeartbeatSource = source || '?';
    am4HeartbeatCount++;
    // One queue throwing must never stop the other from being served.
    try { if (typeof am4RbTick === 'function') am4RbTick(); } catch (e) { /* ignore */ }
    try { if (typeof am4BuildTick === 'function') am4BuildTick(); } catch (e) { /* ignore */ }
    return true;
}
function am4HeartbeatAge() { return am4HeartbeatLast ? (Date.now() - am4HeartbeatLast) : null; }

function am4WireHeartbeat() {
    if (am4HeartbeatWired) return;
    am4HeartbeatWired = true;
    setInterval(function () { am4Heartbeat('interval'); }, AM4_HEARTBEAT_MS);
    // Re-arm the background clock on a slow timer as well as on interaction: a reload leaves
    // it paused, and without this it stays paused until the user happens to click something.
    setInterval(am4KeepAliveEnsure, 20000);
    // The pulse readout is a pure DOM write - no game requests - and only does anything
    // while the Rebuild panel is open. It exists so a stalled queue is VISIBLE.
    setInterval(function () { try { am4RbRenderPulse(); } catch (e) { /* ignore */ } }, 5000);
    var wake = function (src) {
        return function () { am4KeepAliveEnsure(); am4Heartbeat(src); };
    };
    try { document.addEventListener('visibilitychange', function () { if (!document.hidden) wake('visible')(); }); } catch (e) { /* ignore */ }
    try { window.addEventListener('focus', wake('focus')); } catch (e) { /* ignore */ }
    // Passive so they can never delay the game's own handling of the same event.
    try { window.addEventListener('pointerdown', wake('pointer'), { passive: true }); } catch (e) { /* ignore */ }
    try { window.addEventListener('keydown', wake('key'), { passive: true }); } catch (e) { /* ignore */ }
}

// order-page hub id for an Explorer hub name ("X, Country" → order option"X")
// Bridging the two hub name spaces. The research page names a hub"City, Country" with one
// set of ids; the order page names the same hub"City" with a DIFFERENT set. Nothing links
// them but the text, so the text has to be compared carefully.
//
// Measured on two live accounts, 2026-08-17. Two ways the old prefix-on-lowercase test went
// wrong, one loud and one silent:
//
// 1."Saint George's, Grenada" never matched, because the results tab strips apostrophes
// before handing the name over (they would otherwise break out of the JS string it is
// embedded in) and"saint georges" is not a prefix of"saint george's" . Present on BOTH
// accounts checked - it simply had not been used yet on one of them.
// 2. An account with hubs in Georgetown/Guyana AND Georgetown/Cayman Islands has TWO order
// entries reading"Georgetown" . The old code took the first match, so an aircraft could
// be ordered - $216M, silently - to the wrong continent.
//
// So: compare on a key with accents and punctuation removed, and REFUSE when the name is
// ambiguous instead of guessing. A wrong hub is far worse than a stopped job.
function am4FleetHubKey(s) {
    var t = String(s == null ?'' : s).split(',')[0];
    if (t.normalize) t = t.normalize('NFD');
    return t.replace(/[^ -~]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
}

// Same key with the word gaps closed. Needed because the two spellings of one city can
// disagree about whether punctuation is a separator:"Saint George's" ->"saint george s" 
// but the apostrophe-stripped spelling still sitting in old queued jobs ->"saint georges" .
// Compared tightly, both are"saintgeorges" . Used for the EXACT test only - the prefix
// fallback below stays on the spaced key so it can insist on a whole-word boundary.
function am4FleetHubKeyTight(s) { return am4FleetHubKey(s).replace(/ /g,''); }


// Returns { id, why, candidates }. id is null whenever the answer is not unambiguous.
function am4FleetOrderHubResolve(hubName) {
    var hubs = (am4FleetOrderInfo && am4FleetOrderInfo.hubs) || [];
    if (!hubs.length) return { id: null, why: 'the aircraft order page could not be read, so no hub could be resolved', candidates: [] };
    var want = am4FleetHubKey(hubName);
    if (!want) return { id: null, why: 'no hub name was given', candidates: [] };
    var wantTight = am4FleetHubKeyTight(hubName);
    var exact = hubs.filter(function (h) { return am4FleetHubKeyTight(h.t) === wantTight; });
    // Only if nothing matches outright: accept one name being the other's opening WORDS.
    // The trailing space is what makes it a word boundary - without it"San Jose" would
    // match"San Jose del Cabo" , a different airport on a different continent.
    var hits = exact.length ? exact : hubs.filter(function (h) {
        var k = am4FleetHubKey(h.t);
        return k && ((want + ' ').indexOf(k + ' ') === 0 || (k + ' ').indexOf(want + ' ') === 0);
    });
    if (hits.length === 1) return { id: hits[0].v, why: '', candidates: hits };
    if (hits.length === 0) return { id: null, why: 'the order page lists no hub matching "' + hubName + '"', candidates: [] };
    // Several hubs share this city name. The order page gives us nothing else to tell them
    // apart, so this stops here rather than picking one and ordering to the wrong place.
    return { id: null, candidates: hits,
             why: 'the order page lists ' + hits.length + ' hubs called "' + hits[0].t +
                  '" and nothing distinguishes them, so the aircraft could go to the wrong one - ' +
                  'order this one by hand in the ✈ Fleet panel'};
}

function am4FleetOrderHubIdByName(hubName) { return am4FleetOrderHubResolve(hubName).id; }

// Profile for cost/display — uses the job's typeId, not whatever is selected in Fleet.
function am4BuildJobTypeProfile(job) {
    var prof = (job && job.typeId && typeof am4AircraftLoadProfile === 'function')
        ? am4AircraftLoadProfile(job.typeId) : null;
    return prof || am4AircraftProfile();
}

function am4BuildJobUnitCost(job) {
    if (job && job.unitCost) return job.unitCost;
    var typeId = (job && job.typeId) || am4AircraftTypeId();
    if (am4FleetOrderInfo && am4FleetOrderInfo.typeId === typeId && am4FleetOrderInfo.unitCost) {
        return am4FleetOrderInfo.unitCost;
    }
    var prof = am4BuildJobTypeProfile(job);
    return (prof && prof.unitCost) || am4AircraftUnitCost() || 0;
}

// est. total for the confirm/display: order base + order-page seat cost + 3 mods + route fee
function am4BuildJobCost(job) {
    var unit = am4BuildJobUnitCost(job);
    var seatCost = ((job && job.b) || 0) * 5000 + ((job && job.f) || 0) * 10000;
    var prof = am4BuildJobTypeProfile(job);
    var mods = (job && job.modCost != null) ? Number(job.modCost) || 0 : (prof.modCostEst || 0);
    return unit + seatCost + mods + 1500000;
}

function am4BuildCostLabel(job) {
    var prof = am4BuildJobTypeProfile(job);
    var name = (job && job.typeName) || prof.name || am4AircraftName();
    return '~$' + am4BuildJobCost(job).toLocaleString() + (name ? (' (' + name + ')') : '');
}

function am4BuildBannerText() {
    var intro = 'Each job auto-spends order + seat upgrades + 3 mods + route fee (~$1.5M) over ~6 h (order named+configured → modify CO₂/Speed/Fuel → route). Works for every plane type — queued jobs use whichever type was selected in Explorer when you clicked Build. It only runs while Auto-run is ON, this tab is the acting tab, funds are OK and it\'s not quiet hours.';
    var owned = (typeof am4AircraftCatalog !== 'undefined' && am4AircraftCatalog.length)
        ? am4AircraftCatalog.filter(function (t) { return t && t.owned && t.id; })
        : [];
    if (!owned.length) {
        var p = am4AircraftProfile();
        var sample = { typeId: p.typeId, typeName: p.name, unitCost: am4AircraftUnitCost(), b: 0, f: 0, modCost: p.modCostEst || 0 };
        return intro + ' Example (currently selected type): ' + am4BuildCostLabel(sample) + '. Watch your FIRST job of each type.';
    }
    owned.sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || '')); });
    var parts = owned.map(function (t) {
        var prof = (typeof am4AircraftLoadProfile === 'function') ? am4AircraftLoadProfile(t.id) : null;
        return am4BuildCostLabel({
            typeId: t.id, typeName: t.name || (prof && prof.name),
            unitCost: (am4FleetOrderInfo && am4FleetOrderInfo.typeId === t.id && am4FleetOrderInfo.unitCost)
                ? am4FleetOrderInfo.unitCost : ((prof && prof.unitCost) || 0),
            b: 0, f: 0, modCost: (prof && prof.modCostEst) || 0
        });
    });
    return intro + ' Your owned types (base + mods, seats extra): ' + parts.join(' · ') + '. Watch your FIRST job of each type.';
}

function am4BuildEnqueue(job) {
    var p = am4AircraftProfile();
    job.typeId = job.typeId || p.typeId;
    job.engineId = job.engineId || p.engineId;
    job.typeName = job.typeName || p.name;
    if (job.unitCost == null) job.unitCost = am4AircraftUnitCost();
    if (job.modCost == null) job.modCost = p.modCostEst || 0;
    if (!job.cargo) {
        job.e = Math.max(0, parseInt(job.e, 10) || 0);
        job.b = Math.max(0, parseInt(job.b, 10) || 0);
        job.f = Math.max(0, parseInt(job.f, 10) || 0);
        if (job.e + job.b + job.f < 3) {
            job.e = job.e || p.orderY || 0;
            job.b = job.b || p.orderJ || 0;
            job.f = job.f || p.orderF || 0;
        }
        if (job.e + job.b + job.f < 3 && (p.orderY || p.orderJ || p.orderF)) {
            job.e = p.orderY || job.e;
            job.b = p.orderJ || job.b;
            job.f = p.orderF || job.f;
        }
        var cap = am4AircraftSeats();
        var expCfg = (typeof am4ExpLoadCfg === 'function') ? am4ExpLoadCfg() : {};
        var topOrder = (expCfg.seatStrategy === 'economy-first') ? ['y','j','f' ] : ['f','j','y' ];
        var norm = am4PaxSeatNormalize(job.e, job.b, job.f, cap, topOrder);
        job.e = norm.y; job.b = norm.j; job.f = norm.f;
    }
    job.id = 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    job.at = Date.now(); job.updatedAt = Date.now();
    job.state = 'order'; job.planeId = null; job.note = 'queued';
    am4BuildQueue.push(job); am4BuildSaveQueue(); am4BuildRenderQueue();
    console.log('[AM4 Bot Log] Build job queued: ' + job.destIcao + ' → ' + (job.hubName || '?') +
        (job.cargo ? (' (cargo L/H holds ' + (job.cargoAftH || 0) + '/' + (job.cargoAft || 0) + ')') : (' (Y' + job.e + '/J' + job.b + '/F' + job.f + ')')) +
        ', type ' + job.typeId + ', ' + am4BuildCostLabel(job) + ')');
}

function am4BuildSetState(job, state, note) {
    job.state = state; job.note = note || ''; job.updatedAt = Date.now();
    if (state === 'done') {
        am4BuildQueue = am4BuildQueue.filter(function (j) { return j.id !== job.id; });
    }
    am4BuildSaveQueue(); am4BuildRenderQueue();
    console.log('[AM4 Bot Log] Build ' + job.destIcao + ' → ' + state + (note ?' (' + note + ')' : ''));
    var _al = { await_delivery: 'ordered (' + am4BuildCostLabel(job) + ')', modify: 'delivered', await_modify: 'modifying (CO2/Speed/Fuel)', route: 'modified', done: 'ROUTED ✓', error: ('error — ' + (note || '')) }[state];
    if (_al) am4LogAction('build','🏗 ' + job.destIcao + ': ' + _al);
}
function am4BuildNote(job, note) { job.note = note; job.updatedAt = Date.now(); am4BuildSaveQueue(); am4BuildRenderQueue(); }

// Gate for a spend step; returns a reason string when blocked, or null when OK to spend.
function am4BuildCanSpend(cost) {
    if (typeof isBotPausedDueToFunds !== 'undefined' && isBotPausedDueToFunds) return 'low-funds brake';
    if (typeof am4InQuietHours === 'function' && am4InQuietHours()) return 'quiet hours';
    if (typeof am4CanMutate === 'function' && !am4CanMutate()) return 'another tab is acting';
    if (typeof getBankBalance === 'function') { var bal = getBankBalance(); if (bal && cost && cost > bal) return 'balance too low'; }
    return null;
}

// A parked A380 with this reg not already claimed by another active job (arrived + available).
function am4BuildFindParkedByReg(reg) {
    var claimed = {};
    am4BuildQueue.forEach(function (j) { if (j.planeId) claimed[j.planeId] = 1; });
    return am4FleetListParkedA380().then(function (list) {
        return list.filter(function (p) { return String(p.reg).toUpperCase() === String(reg).toUpperCase() && !claimed[p.planeId]; })[0] || null;
    });
}

// Plane reg is the route name (dest ICAO, or dest-2 if taken).
function am4BuildRegMatchesDest(reg, destIcao) {
    var r = String(reg || '').toUpperCase().trim();
    var d = String(destIcao || '').toUpperCase().trim();
    if (!r || !d) return false;
    return r === d || r.indexOf(d + '-') === 0;
}

function am4BuildJobAlreadyRouted(plane, job) {
    if (!plane || !job || !/Routed/i.test(plane.status || '')) return false;
    if (job.destIcao && am4BuildRegMatchesDest(plane.reg, job.destIcao)) return true;
    if (job.orderReg && String(plane.reg || '').toUpperCase() === String(job.orderReg).toUpperCase()) return true;
    if (job.destIcao && String(plane.intendedDestIcao || '').toUpperCase() === String(job.destIcao).toUpperCase()) return true;
    return false;
}

// Advance ONE job by one step (returns a Promise). Every spend is gated + fail-closed.
function am4BuildAdvanceJob(job) {
    if (job.state === 'order') {
        // One fleet read (parked+routed) serves BOTH the reuse check and the unique-name set.
        return am4FleetListModifyA380().then(function (fleet) {
            var claimed = {};
            am4BuildQueue.forEach(function (j) { if (j.planeId) claimed[j.planeId] = 1; });
            // Reuse an already-parked plane named exactly for this dest (unclaimed by another job).
            var existing = fleet.filter(function (p) {
                return /Parked/i.test(p.status) && String(p.reg).toUpperCase() === String(job.destIcao).toUpperCase() && !claimed[p.planeId];
            })[0];
            if (existing) { job.planeId = existing.planeId; am4BuildSetState(job,'modify','using existing parked ' + existing.reg); return; }
            var orderCost = am4BuildJobUnitCost(job) + job.b * 5000 + job.f * 10000;
            var cap = Number(AM4_CONFIG.fleetBuyerSpendCap) || 0;
            if (cap > 0 && orderCost > cap) { am4BuildSetState(job,'error','order $' + orderCost.toLocaleString() + ' over your aircraft $ cap'); return; }
            var gate = am4BuildCanSpend(orderCost);
            if (gate) { am4BuildNote(job,'waiting to order: ' + gate); return; }
            // Resolve the hub again here rather than trusting what was worked out at queue
            // time: the order page may simply not have been loaded yet when the job was
            // created, and that must not brand the job permanently broken.
            if (!job.hubOrderId) {
                var r = am4FleetOrderHubResolve(job.hubName);
                if (r.id) job.hubOrderId = r.id;
                else { am4BuildSetState(job,'error', r.why); return; }
            }
            // UNIQUE plane registration. The game REFUSES a 2nd aircraft whose reg is already in
            // use (live-confirmed 2026-08-14: the same dest queued from two hubs → the 2nd order
            // was rejected while the 1st was still pending). Name the plane dest, dest-2, dest-3…
            // skipping any reg already in the fleet (parked+routed) OR already claimed by another
            // queued job (covers a pending sibling that hasn't been delivered into the fleet yet).
            var taken = {};
            fleet.forEach(function (p) { if (p.reg) taken[String(p.reg).toUpperCase()] = 1; });
            am4BuildQueue.forEach(function (j) { if (j !== job && j.orderReg) taken[String(j.orderReg).toUpperCase()] = 1; });
            var base = String(job.destIcao), reg = base, seq = 2;
            while (taken[reg.toUpperCase()]) { reg = base + '-' + seq; seq++; }
            job.orderReg = reg; // unique across the fleet + the queue (user convention: named for its dest)
            var typeId = job.typeId || am4AircraftTypeId();
            var prof = am4AircraftProfile();
            var orderCfg;
            if (prof.cargo || job.cargo) {
                orderCfg = {
                    cargo: true,
                    cargoAft: job.cargoAft != null ? job.cargoAft : (prof.cargoAft || 0),
                    cargoFwd: job.cargoFwd != null ? job.cargoFwd : (prof.cargoFwd || 0),
                    cargoAftH: job.cargoAftH != null ? job.cargoAftH : (prof.cargoAftH || 0),
                    cargoFwdH: job.cargoFwdH != null ? job.cargoFwdH : (prof.cargoFwdH || 0)
                };
                if ((orderCfg.cargoAft + orderCfg.cargoFwd + orderCfg.cargoAftH + orderCfg.cargoFwdH) < 1) {
                    am4BuildSetState(job,'error','cargo holds empty — set them in ✈ Fleet before Auto-build');
                    return;
                }
            } else {
                if (((job.e || 0) + (job.b || 0) + (job.f || 0)) < 3) {
                    am4BuildSetState(job,'error','seating empty — cannot order (re-queue from Explorer)');
                    return;
                }
                orderCfg = { e: job.e, b: job.b, f: job.f, cargo: false };
            }
            am4BuildSetState(job,'await_delivery','ordering ' + job.orderReg + '…');
            var typeSwitch = (typeId !== am4AircraftTypeId() && typeof am4AircraftSelectType === 'function')
                ? am4AircraftSelectType(typeId) : Promise.resolve(prof);
            return typeSwitch.then(function () {
                return am4FleetLoadOrderBindings();
            }).then(function () {
                if (orderCfg.cargo) {
                    return am4FleetPlaceCargoViaGameButton(job.hubOrderId, job.hubName, orderCfg, job.orderReg);
                }
                return am4FleetPlacePaxViaOrderUrl(job.hubOrderId, job.hubName, job.orderReg, orderCfg);
            }).then(function (res) {
                if (!res || res.refused || res.bindFail || res.ok === false) {
                    var why = (res && res.hint) ? res.hint : 'order refused by game';
                    am4BuildSetState(job,'error', why);
                    return;
                }
                am4BuildNote(job,'ordered ' + job.orderReg + ' — waiting ~5h for delivery');
            }).catch(function (e) { am4BuildSetState(job,'error','order request failed: ' + e); });
        });
    }
    if (job.state === 'await_delivery') {
        return am4BuildFindParkedByReg(job.orderReg || job.destIcao).then(function (p) {
            if (p) { job.planeId = p.planeId; am4BuildSetState(job,'modify','delivered (' + p.reg + ')'); }
            else am4BuildNote(job,'awaiting delivery');
        });
    }
    if (job.state === 'modify') {
        if (!job.planeId) { am4BuildSetState(job,'error','lost plane id'); return Promise.resolve(); }
        return am4FleetFetchModifyInfo(job.planeId).then(function (info) {
            if (info && info.paused) { am4BuildNote(job,'waiting: Research is using an aircraft'); return; }
            if (!info || !info.looksValid) { am4BuildNote(job,'cannot read modify panel — retrying'); return; }
            var est = (info.mod1cost || 0) + (info.mod2cost || 0) + (info.mod3cost || 0);
            if (est > 0 && job.typeId === am4AircraftTypeId()) {
                am4AircraftSet({ modCostEst: est });
                job.modCost = est;
            }
            if (info.mod1on && info.mod2on && info.mod3on) { am4BuildSetState(job,'route','already fully modified'); return; }
            var e, b, f;
            if (info.cargo) {
                e = info.curL || 0;
                b = info.curH || 0;
                f = 0;
            } else {
                var cap = am4AircraftSeats();
                var topOrder = ['f','j','y' ];
                var norm = am4PaxSeatNormalize(
                    (job.e > 0) ? job.e : (info.curE || 0),
                    (job.b > 0) ? job.b : (info.curB || 0),
                    (job.f > 0) ? job.f : (info.curF || 0),
                    cap, topOrder);
                e = norm.y; b = norm.j; f = norm.f;
            }
            if (info.cargo && (e + b) < 1) {
                var fromProf = am4FleetCargoLHFromProfile();
                if (fromProf) { e = fromProf.l; b = fromProf.h; }
            }
            if (info.cargo && (e + b) < 1) {
                am4BuildNote(job,'waiting: cargo Large/Heavy unread — set load in ✈ Fleet Modify first');
                return;
            }
            var modCost = (info.mod1on ? 0 : info.mod1cost) + (info.mod2on ? 0 : info.mod2cost) + (info.mod3on ? 0 : info.mod3cost);
            var gate = am4BuildCanSpend(modCost);
            if (gate) { am4BuildNote(job,'waiting to modify: ' + gate); return; }
            am4BuildSetState(job,'await_modify','modifying (CO2/Speed/Fuel)…');
            if (info.cargo) {
                console.log('[AM4 Bot Log] Build cargo modifying via game form L=' + e + ' H=' + b);
                return am4FleetApplyCargoModifyViaGame(job.planeId, e, b, true, true, true).then(function (res) {
                    if (res && res.refused) am4BuildSetState(job,'error','modify refused');
                    else am4BuildNote(job,'modifying — waiting for the timer');
                }).catch(function (err) { am4BuildSetState(job,'error','modify request failed: ' + err); });
            }
            var url = am4FleetBuildModifyUrl(job.planeId, e, b, f, true, true, true, false);
            console.log('[AM4 Bot Log] Build modifying: ' + url);
            return fetch(url, { credentials: 'include'}).then(function (r) { return r.text(); }).then(function (body) {
                if (/too low|not enough|insufficient|denied|invalid|failed/i.test(body || '')) am4BuildSetState(job,'error','modify refused');
                else am4BuildNote(job,'modifying — waiting for the timer');
            }).catch(function (err) { am4BuildSetState(job,'error','modify request failed: ' + err); });
        });
    }
    if (job.state === 'await_modify') {
        return am4FleetFetchModifyInfo(job.planeId).then(function (info) {
            if (info && info.looksValid && info.mod1on && info.mod2on && info.mod3on) am4BuildSetState(job,'route','modified');
            else am4BuildNote(job,'awaiting modify timer');
        });
    }
    if (job.state === 'route') {
        if (!job.planeId) { am4BuildSetState(job,'error','lost plane id'); return Promise.resolve(); }
        return am4FleetListAllRows().then(function (rows) {
            var p = rows.filter(function (x) { return x.planeId === job.planeId; })[0];
            if (!p) { am4BuildNote(job,'plane not found in fleet — retrying'); return; }
            if (am4BuildJobAlreadyRouted(p, job)) {
                am4BuildSetState(job,'done','already routed ✓');
                return;
            }
            if (!AM4_FLEET_AT_BASE_RE.test(p.status)) {
                am4BuildNote(job,'waiting: plane not parked yet (modify timer?)');
                return;
            }
            if (p.y <= 0 || p.j <= 0 || p.f <= 0) { am4BuildSetState(job,'error','plane has a 0-seat class — cannot route'); return; }
            var gate = am4BuildCanSpend(1500000);
            if (gate) { am4BuildNote(job,'waiting to route: ' + gate); return; }
            return am4FleetFetchRouteConfig(job.planeId, job.destId).then(function (rc) {
                if (!rc || !rc.hasCreate) { am4BuildSetState(job,'error','route panel not available'); return; }
                if (rc.distKm && rc.rangeKm && rc.distKm > rc.rangeKm) { am4BuildSetState(job,'error','out of range'); return; }
                var reg = (job.orderReg || job.destIcao) + (rc.acOnRoute > 0 ?'-2' : '');
                var prices = am4FleetPricePlan(rc, p.cargo);
                if (!prices) { am4BuildSetState(job,'error','could not read the game base ticket prices'); return; }
                var url = am4FleetBuildRouteUrl(job.planeId, job.destId, reg, prices, 200);
                am4BuildNote(job,'creating route…');
                console.log('[AM4 Bot Log] Build routing with multiplied ticket prices (' + prices.source + '): ' + url);
                return fetch(url, { credentials: 'include'}).then(function (r) { return r.text(); }).then(function () {
                    return am4FleetListAllRows().then(function (after) {
                        var plane = after.filter(function (x) { return x.planeId === job.planeId; })[0];
                        if (plane && am4BuildJobAlreadyRouted(plane, job)) {
                            am4BuildSetState(job,'done','route created — plane routed ✓');
                        } else if (plane && AM4_FLEET_AT_BASE_RE.test(plane.status)) {
                            am4BuildNote(job,'route sent, plane still parked — will re-check');
                        } else if (plane && /Routed/i.test(plane.status)) {
                            am4BuildSetState(job,'done','route created — plane routed ✓');
                        } else {
                            am4BuildNote(job,'route sent — waiting for fleet status to update');
                        }
                    });
                }).catch(function (e) { am4BuildSetState(job,'error','route request failed: ' + e); });
            });
        });
    }
    return Promise.resolve();
}

// A job is ready to act this tick: spend/transition states always; await states throttled to AM4_BUILD_POLL_MS.
function am4BuildJobReady(job) {
    if (AM4_BUILD_ACTIVE.indexOf(job.state) === -1) return false;
    if (job.state === 'await_delivery' || job.state === 'await_modify') return (Date.now() - (job.updatedAt || 0)) >= AM4_BUILD_POLL_MS;
    return true;
}

// ACTIONABLE states DO something (and thus always change state) when processed: 'order' places the
// order,'modify' fires the modify,'route' creates the route. The await_* states only POLL a timer
// and usually change nothing. The fast-drain lane prefers actionable jobs so a big block of awaiting
// jobs can never throttle the actionable backlog behind them (v1.30 fix — see am4BuildTick).
function am4BuildActionableState(state) { return state === 'order' || state === 'modify' || state === 'route'; }

// Runs ONE job step behind a busy-lock that ALWAYS releases - a hung fetch (fetch has
// no timeout) can therefore never freeze the whole queue (that was the real"it stopped 
// after 3" cause together with the background-tab guard below). Shared by the auto
// scheduler and the manual"▶ now" button.
function am4BuildRunStep(job, errLabel) {
    if (am4BuildBusy) return false;
    am4BuildBusy = true;
    var stateBefore = job.state;
    var released = false;
    var release = function () { if (!released) { released = true; am4BuildBusy = false; } };
    var safety = setTimeout(release, 45000); // never stay busy longer than this
    Promise.resolve().then(function () { return am4BuildAdvanceJob(job); })
        .catch(function (e) { try { am4BuildSetState(job,'error', (errLabel || 'step') + ' error: ' + e); } catch (x) { /* ignore */ } })
        .then(function () {
            clearTimeout(safety); release(); am4BuildRenderQueue();
            if (!am4BuildAutoRun()) return;
            // Backlog drain: run the next step SOON (~8 s) instead of waiting the full 2-min heartbeat -
            // that is what lets a 100-plane pile clear in reasonable time. The fast tick prefers
            // ACTIONABLE jobs (order/modify/route), which always make progress.
            // v1.30 FIX: keep the fast drain alive across a no-progress AWAIT poll as long as actionable
            // work is still waiting. Before v1.30 the drain only re-fired on PROGRESS, so every await
            // poll (a ~40-min modify timer that isn't done yet ⇒ no state change) KILLED the cascade -
            // a block of ~60'awaiting modify' jobs then throttled every actionable job behind them down
            // to the 2-min interval, starving the tail for hours (live-caught 2026-08-14). We still do
            // NOT fast-chase after a no-progress ACTIONABLE step (a gated/unreadable job) - that would
            // hot-loop hammering it; the 2-min interval retries those calmly. And with no actionable work
            // left, the await polls fall back to the 2-min interval too (never hot-polled every 8 s).
            var progressed = (job.state !== stateBefore);
            var wasActionable = am4BuildActionableState(stateBefore);
            var actionableWaiting = am4BuildQueue.some(function (j) { return am4BuildJobReady(j) && am4BuildActionableState(j.state); });
            var fast = (progressed && am4BuildQueue.some(am4BuildJobReady)) || (!progressed && !wasActionable && actionableWaiting);
            if (fast) setTimeout(function () { am4BuildTick(true); }, am4Jitter(AM4_BUILD_DRAIN_MS));
        });
    return true;
}

// Round-robin cursor so one perpetually-ready job (e.g. a gated order/modify/route that keeps
// returning to the same state) can never starve the jobs behind it - each tick advances to the NEXT
// ready job, BY QUEUE POSITION, after the last one processed.
// v1.29 STARVATION FIX: the cursor is tracked by the last job's index in the FULL queue, not by its
// index in the (constantly changing) ready list. The old code looked am4BuildLastId up in the ready
// list and, when it was no longer there - the COMMON case, because a job that just made progress
// transitions into an await_* / done / error state and thus LEAVES the ready set - fell back to
// start=0, resetting the cursor to the FRONT on essentially every successful step. On a long queue
// that silently STARVED the tail: the cursor never walked past the front block of freshly-delivered
//'modify' jobs, so the last-enqueued planes sat unprocessed for hours (live-caught 2026-08-14: 10
// tail jobs frozen ~2 h while ~120 jobs ahead of them flowed). Tracking the queue index makes the
// cursor march forward through ALL jobs and wrap cleanly to the front.
var am4BuildLastId = null;
function am4BuildTick(preferActionable) {
    am4BuildRenderQueue();
    if (typeof am4FleetWatchTick === 'function') am4FleetWatchTick();
    if (!am4BuildBusy && am4BuildQueue.some(function (j) { return j.state === 'route' && j.planeId; })) {
        am4BuildSweepRoutedJobs();
    }
    if (am4BuildBusy || !am4BuildAutoRun()) return;
    if (typeof am4SuiteResearchBusy === 'function' && am4SuiteResearchBusy()) return;
    var ready = am4BuildQueue.filter(am4BuildJobReady);
    if (!ready.length) return;
    // Fast-drain lane (preferActionable, from am4BuildRunStep's ~8 s reschedule) walks ACTIONABLE jobs
    // first - they always make progress, so the cascade reaches the tail without dying on an await poll
    // (v1.30 fix). The slow 2-min interval + visibility/focus catch-ups call this with NO flag → they
    // round-robin ALL ready jobs, so the await_delivery / await_modify timers still get polled (~2 min).
    var pool = ready;
    if (preferActionable) {
        var act = ready.filter(function (j) { return am4BuildActionableState(j.state); });
        if (act.length) pool = act;
    }
    var lastIdx = -1;
    if (am4BuildLastId) {
        for (var qi = 0; qi < am4BuildQueue.length; qi++) { if (am4BuildQueue[qi].id === am4BuildLastId) { lastIdx = qi; break; } }
    }
    // First job in the pool positioned AFTER the last-processed job in the queue (round-robin by queue
    // position, robust to the last job having left the ready set), wrapping to the pool's front.
    var job = null;
    for (var k = 0; k < pool.length; k++) { if (am4BuildQueue.indexOf(pool[k]) > lastIdx) { job = pool[k]; break; } }
    if (!job) job = pool[0];
    am4BuildLastId = job.id;
    am4BuildRunStep(job,'tick');
}

// Manual"order now" / advance-now for ONE specific job - bypasses the 2-min tick and the
// 5-min await-throttle, but NOT the fail-closed spend gates inside am4BuildAdvanceJob
// (funds / lease / quiet hours / $ cap). Works even while Auto-run is OFF, because clicking
// it IS the deliberate go-ahead for that plane.
function am4BuildForceStep(id) {
    var job = am4BuildQueue.filter(function (j) { return j.id === id; })[0];
    if (!job || AM4_BUILD_ACTIVE.indexOf(job.state) === -1) return;
    if (!am4BuildRunStep(job,'manual')) am4BuildNote(job,'busy - try again in a moment');
}

function am4BuildStartScheduler() {
    if (am4BuildTimer) return;
    // Ticks REGARDLESS of tab visibility. The old`if (!document.hidden)` guard silently
    // paused the whole queue whenever the tab was not the focused one, so a background
    // marathon barely advanced. The lease + auto-run + funds gates already protect spends.
    am4BuildTimer = setInterval(am4BuildTick, AM4_BUILD_TICK_MS);
    // Catch up the INSTANT the tab regains focus/visibility. A backgrounded tab's setInterval may
    // have been frozen/throttled by the browser (Chrome freezes hidden tabs after a few minutes), so
    // instead of waiting up to 2 min after you look at it, tick immediately - the fast-drain then
    // clears any backlog. This makes"just glance at the tab and it flows" work even if the keepalive
    // is imperfect on a given setup.
    try { document.addEventListener('visibilitychange', function () { if (!document.hidden) am4BuildTick(); }); } catch (e) { /* ignore */ }
    try { window.addEventListener('focus', function () { am4BuildTick(); }); } catch (e) { /* ignore */ }
    // If Auto-run was already on from a previous session, (re)start the keepalive so background ticks
    // survive the wait. play() may need a user gesture; it retries when Auto-run is toggled.
    if (am4BuildAutoRun()) am4BuildKeepAlive(true);
    if (typeof am4FleetWatchStart === 'function') am4FleetWatchStart();
}

// ---- Build Queue UI (control-bar button + panel) ----
function am4BuildInjectButton() { /* Build queue lives under ✈ Fleet */ }
function am4BuildTogglePanel() {
    var fleet = document.getElementById('am4FleetPanel');
    if (!fleet && typeof am4FleetBuildPanel === 'function') fleet = am4FleetBuildPanel();
    if (fleet) fleet.style.display = 'block';
    var qp = am4BuildQueuePanel();
    if (qp) qp.style.display = 'block';
    am4BuildRenderQueue();
    var host = document.getElementById('am4FleetBuildHost');
    if (host && host.scrollIntoView) try { host.scrollIntoView({ block: 'nearest'}); } catch (e) { /* ignore */ }
}
function am4BuildQueuePanel() {
    var host = document.getElementById('am4FleetBuildHost');
    var old = document.getElementById('am4BuildPanel');
    if (old && host && host.contains(old)) return old;
    if (old && !host) return old;
    if (old) old.remove();
    var panel = document.createElement('div');
    panel.id = 'am4BuildPanel';
    if (host) {
        panel.style.cssText = 'margin-top:8px; border-top:1px dashed #334155; padding-top:8px;';
        host.appendChild(panel);
    } else {
        panel.style.cssText = 'position:fixed; top:60px; right:20px; width:min(460px, calc(100vw - 24px)); max-height:84vh; overflow-y:auto; background:rgba(15,19,26,0.98); border:1px solid #34495e; border-radius:8px; color:#e2e8f0; font-family:monospace; font-size:12px; z-index:1041; padding:14px; box-shadow:0 6px 24px rgba(0,0,0,0.6); display:none;';
        document.body.appendChild(panel);
    }
    panel.innerHTML =
        "<div style='display:flex; margin-bottom:6px;'><span style='flex-grow:1; font-size:13px; font-weight:bold; color:#38bdf8; letter-spacing:1px;'>🏗 AUTO-BUILD QUEUE</span>" +
        "<span id='am4BuildClose' style='cursor:pointer; color:#ef4444; font-weight:bold; padding:0 4px;'>[X]</span></div>" +
        "<div id='am4BuildBanner' style='font-size:10px; color:#f87171; margin:5px 0; line-height:1.4;'>⚠ " + am4FleetEsc(am4BuildBannerText()) +"</div>" +
        "<div class='am4-exp-row' style='display:flex; align-items:center; gap:8px; margin:6px 0;'><label style='cursor:pointer; color:#e2e8f0; font-weight:bold;'><input type='checkbox' id='am4BuildAutoRun'> ▶ Auto-run queue (spends in-game cash)</label></div>" +
        "<div id='am4BuildBody' style='margin-top:6px;'></div>" +
        "<div class='am4-exp-btnrow' style='display:flex; gap:8px; margin-top:8px;'><button id='am4BuildClearDone' class='am4-exp-btn am4-exp-btn-mini' style='cursor:pointer;border:none;border-radius:5px;padding:4px 8px;background:#334155;color:#94a3b8;font-family:monospace;font-size:10px;'>clear done/errored</button></div>" +
        "<div style='font-size:9px; color:#64748b; margin-top:8px; border-top:1px dashed #334155; padding-top:6px;'>Add jobs by clicking “Build ✈” on a route in the 🔎 Explorer results. A job survives reloads. Cancel a job any time (it won't undo an order already placed).</div>";
    var bClose = document.getElementById('am4BuildClose');
    if (bClose) {
        if (host) bClose.style.display = 'none';
        else bClose.addEventListener('click', function () { panel.style.display = 'none'; });
    }
    var ar = document.getElementById('am4BuildAutoRun');
    ar.checked = am4BuildAutoRun();
    ar.addEventListener('change', function () { am4BuildSetAutoRun(ar.checked); if (ar.checked) am4BuildTick(); });
    document.getElementById('am4BuildClearDone').addEventListener('click', function () {
        am4BuildQueue = am4BuildQueue.filter(function (j) { return AM4_BUILD_ACTIVE.indexOf(j.state) !== -1; });
        am4BuildSaveQueue(); am4BuildRenderQueue();
    });
    if (!host && typeof am4PanelChrome === 'function') am4PanelChrome(panel,'build');
    return panel;
}
var AM4_BUILD_STATE_LABEL = { order: '① order', await_delivery: '② awaiting delivery', modify: '③ modify', await_modify: '④ awaiting modify', route: '⑤ route', done: '✓ done', error: '✖ error', cancelled: 'cancelled'};
var AM4_BUILD_STATE_COLOR = { order: '#38bdf8', await_delivery: '#94a3b8', modify: '#38bdf8', await_modify: '#94a3b8', route: '#38bdf8', done: '#10b981', error: '#ef4444', cancelled: '#64748b'};
function am4BuildRenderQueue() {
    var banner = document.getElementById('am4BuildBanner');
    if (banner) banner.innerText = '⚠ ' + am4BuildBannerText();
    var body = document.getElementById('am4BuildBody');
    if (!body) return;
    if (!am4BuildQueue.length) { body.innerHTML ="<div style='color:#64748b;'>Queue empty. Click “Build ✈” on a route in the Explorer results.</div>" ; return; }
    body.innerHTML = am4BuildQueue.map(function (j) {
        var lbl = AM4_BUILD_STATE_LABEL[j.state] || j.state;
        var col = AM4_BUILD_STATE_COLOR[j.state] || '#e2e8f0';
        var canCancel = AM4_BUILD_ACTIVE.indexOf(j.state) !== -1;
        var nowMap = { order: '▶ order now', await_delivery: '▶ check', modify: '▶ modify now', await_modify: '▶ check', route: '▶ route now'};
        var nowBtn = canCancel ? "<span data-build-now='" + j.id +"' title='Advance this job now - skip the 2-min wait (spend gates still apply)' style='cursor:pointer; color:#10b981; font-weight:bold; margin-left:8px; white-space:nowrap;'>" + (nowMap[j.state] || '▶ now') +"</span>" : "" ;
        // Errored jobs (e.g. a duplicate name that got refused before v1.26) can be re-queued -
        // the retry restarts them from the order step, where they now get a fresh UNIQUE plane name.
        var retryBtn = (j.state === 'error') ? "<span data-build-retry='" + j.id +"' title='Re-queue this job from the order step (gets a fresh unique plane name)' style='cursor:pointer; color:#38bdf8; font-weight:bold; margin-left:8px; white-space:nowrap;'>↻ retry</span>" : "" ;
        return"<div style='border-bottom:1px solid #1e293b; padding:5px 0;'>" +
            "<div style='display:flex; align-items:baseline; gap:8px;'>" +
            "<b style='color:#cbd5e1;'>" + am4FleetEsc(j.destIcao) +"</b> <span style='color:#64748b;'>→ " + am4FleetEsc((j.hubName || '').split(',')[0]) +"</span>" +
            "<span style='flex-grow:1;'></span><span style='font-weight:bold; color:" + col +";'>" + lbl +"</span>" +
            nowBtn + retryBtn +
            (canCancel ? "<span data-build-cancel='" + j.id +"' style='cursor:pointer; color:#ef4444; margin-left:8px;'>✕</span>" : "") +
            "</div>" +
            "<div style='color:#94a3b8; font-size:10px;'>Y" + j.e +"/J" + j.b +"/F" + j.f +" &middot; ~$" + am4BuildJobCost(j).toLocaleString() + (j.note ? " &middot; " + am4FleetEsc(j.note) : "") +"</div>" +
            "</div>";
    }).join('');
    body.querySelectorAll('[data-build-cancel]').forEach(function (el) {
        el.addEventListener('click', function () {
            var id = el.getAttribute('data-build-cancel');
            var job = am4BuildQueue.filter(function (j) { return j.id === id; })[0];
            if (job) { am4BuildSetState(job,'cancelled','cancelled by user'); }
        });
    });
    body.querySelectorAll('[data-build-now]').forEach(function (el) {
        el.addEventListener('click', function () { am4BuildForceStep(el.getAttribute('data-build-now')); });
    });
    body.querySelectorAll('[data-build-retry]').forEach(function (el) {
        el.addEventListener('click', function () {
            var id = el.getAttribute('data-build-retry');
            var job = am4BuildQueue.filter(function (j) { return j.id === id; })[0];
            // Reset to the order step; drop any stale plane/reg so it re-derives a unique name.
            if (job && job.state === 'error') { job.planeId = null; job.orderReg = null; am4BuildSetState(job,'order','re-queued (retry)'); }
        });
    });
}

// Expose the pipeline for headless testing (read-only logic; the spend steps run in the user's browser).
window.AM4Build = {
    queue: function () { return am4BuildQueue; },
    enqueue: am4BuildEnqueue, advanceJob: am4BuildAdvanceJob, jobCost: am4BuildJobCost,
    orderHubIdByName: am4FleetOrderHubIdByName, autoRun: am4BuildAutoRun, setAutoRun: am4BuildSetAutoRun,
    // hub matching, exposed so it can be exercised without the order page in front of it
    orderHubResolve: am4FleetOrderHubResolve, hubKey: am4FleetHubKey,
    fetchOrderInfo: am4FleetFetchOrderInfo,
    orderInfo: function () { return am4FleetOrderInfo; },
    setOrderInfo: function (i) { am4FleetOrderInfo = i; },
    tick: am4BuildTick, renderQueue: am4BuildRenderQueue,
    forceStep: am4BuildForceStep, runStep: am4BuildRunStep, buildPanel: am4BuildQueuePanel,
    busy: function () { return am4BuildBusy; }
};

//================================================================================
// Part 18: STRATEGY REBUILD V2 — layers L1 (data) and L2 (planner)
//
// Rebuilds an existing routed A380 from ANY strategy to ANY other. A"strategy" is
// N = one-way flights per 24 h (2, 3 or 4); it is a pure function of route distance via the
// verified flight-time formula, so a rebuild = pick a new destination from the SAME hub inside
// band(TO), reconfigure seats to demand÷TO, re-route. Direction is irrelevant to the machinery:
// 2→3 and 4→2 run the identical pipeline. Full design in REBUILD_V2_PLAN.md.
//
// This part supersedes Part 17 (the 2×→3×-only conversion module).
//================================================================================

// ── L1: CACHE ───────────────────────────────────────────────────────────────────
// Why the cache is keyed per (hub, distCap) and not once per hub: recon R1 measured that
// research_main.php returns AT MOST 50 ROWS, sorted longest-first, filtered to <= dist. A
// dist=14500 sweep and a dist=13848 sweep of the same hub+country overlap in ZERO rows, so a
// wide sweep is NOT a superset of a narrow one and cannot serve every strategy. Each target
// strategy therefore gets its own cached sweep. (GAME_CONTRACTS §10.)
//
// The 50-row cap also means a dense country is TRUNCATED: everything below the 50th-longest is
// invisible. We record which countries hit the cap so the UI can report a floor ("≥ N found")
// instead of implying completeness.
var AM4_RB_CACHE_KEY = 'am4RbRawCache';
var AM4_RB_CACHE_V = 1;
var AM4_RB_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
var AM4_RB_CACHE_MAX_ENTRIES = 20;
var AM4_RB_SEARCH_ROW_CAP = 50; // the game's per-request row limit (measured)
// Rebuild scores with a lower fill bar than Explorer's default 99%. At high N (e.g. 8×/24h)
// demand÷N is thin on a ~230-seat MC-21 — 99% fill rejects every route even when the band is fine.
var AM4_RB_GOOD_FILL_PCT = 85;
// Union of all strategy bands: nothing outside this can ever serve any strategy, so it is
// pruned on write. (Strategy 4 floor .. A380 range.)
var AM4_RB_ROW_MIN_KM = 8309;
var AM4_RB_ROW_MAX_KM = 14500;

function am4RbCacheLoad() {
    try {
        var c = JSON.parse(localStorage.getItem(AM4_RB_CACHE_KEY) || 'null');
        if (c && c.v === AM4_RB_CACHE_V && c.hubs && typeof c.hubs === 'object') return c;
    } catch (e) { /* unreadable or foreign shape - start clean */ }
    return { v: AM4_RB_CACHE_V, hubs: {} };
}

function am4RbCacheKey(hubId, distCap) { return String(hubId) + ':' + String(distCap); }

// Oldest-first eviction. Returns how many entries were dropped.
function am4RbCacheEvict(cache, keepCount) {
    var keys = Object.keys(cache.hubs);
    if (keys.length <= keepCount) return 0;
    keys.sort(function (a, b) { return (cache.hubs[a].at || 0) - (cache.hubs[b].at || 0); });
    var drop = keys.slice(0, keys.length - keepCount);
    drop.forEach(function (k) { delete cache.hubs[k]; });
    return drop.length;
}

// Quota-safe write: localStorage can be full (the Explorer cache and the queues share it).
// On failure evict the oldest half and retry ONCE; if it still fails, give up silently and
// let the caller run uncached rather than throwing in the middle of a scan.
function am4RbCacheSave(cache) {
    am4RbCacheEvict(cache, AM4_RB_CACHE_MAX_ENTRIES);
    try {
        localStorage.setItem(AM4_RB_CACHE_KEY, JSON.stringify(cache));
        return true;
    } catch (e) {
        am4RbCacheEvict(cache, Math.max(1, Math.floor(AM4_RB_CACHE_MAX_ENTRIES / 2)));
        try {
            localStorage.setItem(AM4_RB_CACHE_KEY, JSON.stringify(cache));
            console.log('[AM4 Bot Log] Rebuild cache was over quota - evicted the oldest half.');
            return true;
        } catch (e2) {
            console.log('[AM4 Bot Log] Rebuild cache could not be saved (storage full) - continuing uncached.');
            return false;
        }
    }
}

// Rows are stored as compact numeric tuples [arrId, dist, dY, dJ, dF, rwy]; names/ICAO/coords
// are resolved live from airportIconData at render time, so none of that is duplicated here.
function am4RbRowEncode(r) {
    return [Number(r.arrId), Number(r.dist) || 0, Number(r.dY) || 0, Number(r.dJ) || 0, Number(r.dF) || 0, Number(r.rwy) || 0];
}
function am4RbRowDecode(t) {
    return { arrId: String(t[0]), dist: t[1], dY: t[2], dJ: t[3], dF: t[4], rwy: t[5], pair: '', destName: ''};
}

function am4RbCacheGet(hubId, distCap, ttlMs) {
    var cache = am4RbCacheLoad();
    var e = cache.hubs[am4RbCacheKey(hubId, distCap)];
    if (!e || !e.rows) return null;
    var ttl = (ttlMs == null) ? AM4_RB_CACHE_TTL_MS : ttlMs;
    if (ttl > 0 && (Date.now() - (e.at || 0)) > ttl) return null;
    return { at: e.at, capped: e.capped || [], rows: e.rows.map(am4RbRowDecode) };
}

function am4RbCachePut(hubId, distCap, rows, cappedCountries) {
    var cache = am4RbCacheLoad();
    var kept = [];
    var seen = {};
    rows.forEach(function (r) {
        if (!r.arrId || seen[r.arrId]) return; // dedupe across countries
        if (!(r.dist > 0 && r.dist <= am4AircraftRangeKm())) return; // outside this type's range
        seen[r.arrId] = true;
        kept.push(am4RbRowEncode(r));
    });
    cache.hubs[am4RbCacheKey(hubId, distCap)] = {
        at: Date.now(), rows: kept, capped: (cappedCountries || []).slice(0, 40)
    };
    am4RbCacheSave(cache);
    return kept.length;
}

function am4RbCacheStats() {
    var cache = am4RbCacheLoad();
    var out = [];
    Object.keys(cache.hubs).forEach(function (k) {
        var e = cache.hubs[k], parts = k.split(':');
        out.push({
            hubId: parts[0], distCap: Number(parts[1]), at: e.at,
            ageMs: Date.now() - (e.at || 0), rows: (e.rows || []).length,
            cappedCountries: (e.capped || []).length
        });
    });
    out.sort(function (a, b) { return b.at - a.at; });
    return out;
}
function am4RbCacheClear() {
    try { localStorage.removeItem(AM4_RB_CACHE_KEY); } catch (e) { /* ignore */ }
}

// ── L1: LIVE READS (never from the page-load snapshot) ──────────────────────────

// Recon B1: statusData[id].routeId CAN BE STALE. One of three checked A380s had
// statusData.routeId = 35104065 while its live fleet_details page wired BOTH ground buttons to
// fleet_ground.php?id=201917752. Grounding from the snapshot would act on the wrong route, so
// the rebuild always resolves the ground id live, immediately before grounding.
function am4RbFetchGroundRouteId(aircraftId) {
    return fetch('fleet_details.php?id=' + encodeURIComponent(aircraftId), { credentials: 'include'})
        .then(function (r) { return r.text(); })
        .then(function (html) {
            var m = (html || '').match(/fleet_ground\.php\?id=(\d+)/);
            return m ? m[1] : null;
        });
}

// Recon R2: fleet_details carries the route's UTC times, so the UI can say WHEN an aircraft is
// back instead of a bland"away from base" .
//
// It deliberately does NOT try to read the two airport codes out of the page text. The obvious
// approach - grab the first two /\b[A-Z]{4}\b/ tokens - is wrong on this account: the aircraft's
// own registration is itself a four-letter ICAO (the user names each aircraft after its
// destination), so it is matched before the real airports and the panel would confidently name
// the wrong places. The route endpoints are already known reliably from the fleet classification
// (routeMarkers + airportIconData), so the caller supplies them and this only adds the times.
// fleet_details.php in ONE read: the live route id AND the countdown the game itself shows.
//
// MEASURED 2026-08-15. The page ends with`timer('timer', <seconds>)` and renders it under a
// label -"Arrives in 03:01:53" for an aircraft still in the air. That countdown is the only
// machine-readable"when is this aircraft available again" the game offers, and it is what
// distinguishes AT BASE from INBOUND TO BASE. That distinction matters: the modify panel
// renders for BOTH (the game's own refusal wording is "not at a base or inbound to a base"),
// so using the panel alone as an at-hub test grounds aircraft that are still hours out - which
// is exactly what happened to five aircraft before this was found.
//
// Only an explicit"Arrives in" counts as in-flight. Anything else (a"Departs in" countdown
// on an aircraft sitting at base, or no timer at all) falls through to the panel check, so an
// unfamiliar label can never block a rebuild that would otherwise be safe.
function am4RbFetchAircraftPage(aircraftId) {
    return fetch('fleet_details.php?id=' + encodeURIComponent(aircraftId), { credentials: 'include'})
        .then(function (r) { return r.text(); })
        .then(function (html) {
            var box = document.createElement('div');
            box.innerHTML = html || '';
            var text = (box.innerText || '').replace(/\s+/g,' ').trim();
            var gm = (html || '').match(/fleet_ground\.php\?id=(\d+)/);
            var tm = (html || '').match(/timer\(\s*['"]timer['"]\s*,\s*(\d+)\s*\)/);
            var lm = (html || '').match(/>\s*([A-Za-z]+)\s+in\s*<span[^>]*id=['"]timer['"]/i);
            var secs = tm ? Number(tm[1]) : 0;
            var label = lm ? String(lm[1]).toLowerCase() : '';
            return {
                routeId: gm ? gm[1] : null,
                timerSecs: (isFinite(secs) && secs > 0) ? secs : 0,
                timerLabel: label,
                inFlight: (label === 'arrives' && secs > 0),
                plannedMaintenance: /Planned maintenance/i.test(text),
                utcTimes: (text.match(/\d{2}:\d{2}:\d{2} UTC/g) || []).slice(0, 2)
            };
        });
}

function am4RbFetchWhereabouts(aircraftId) {
    return fetch('fleet_details.php?id=' + encodeURIComponent(aircraftId), { credentials: 'include'})
        .then(function (r) { return r.text(); })
        .then(function (html) {
            var box = document.createElement('div');
            box.innerHTML = html || '';
            var text = (box.innerText || '').replace(/\s+/g,' ').trim();
            var times = (text.match(/\d{2}:\d{2}:\d{2} UTC/g) || []).slice(0, 2);
            var gm = (html || '').match(/fleet_ground\.php\?id=(\d+)/);
            return {
                routeId: gm ? gm[1] : null,
                timeA: times[0] || null, timeB: times[1] || null,
                raw: text.slice(0, 200)
            };
        });
}

// Recon B2:`looksValid:false` is NOT one condition. Classify it so the user gets a real reason.
// away from base ~38 KB"Aircraft is not at a base or inbound to a base" 
// pending maintenance 614 B"Aircraft is currently pending maintenance" 
// modify timer running — seat form absent while the timer runs
// Returns {atBase, reason, info} where reason is one of:
//'at_base' |'away' |'pending_maintenance' |'busy' |'unreadable' 
var AM4_RB_REASON_TEXT = {
    at_base: 'at its base',
    away: 'away from base (or inbound) - it returns on its own next leg',
    pending_maintenance: 'queued for maintenance (A-check/repair) - the game blocks modifications until that clears',
    busy: 'its modification timer is still running',
    unreadable: 'the game did not return a readable panel' 
};
function am4RbReadAircraftState(aircraftId) {
    return am4RteGameGet('maint_plan_do.php?type=modify&id=' + encodeURIComponent(aircraftId))
        .then(function (res) {
            var html = (res && res.body) || '';
            var info = (typeof am4FleetParseModifyInfo === 'function') ? am4FleetParseModifyInfo(html) : null;
            if (info && info.looksValid) return { atBase: true, reason: 'at_base', info: info, bytes: (html || '').length };
            var reason = 'unreadable';
            if (/not at a base|inbound to a base/i.test(html)) reason = 'away';
            else if (/pending maintenance/i.test(html)) reason = 'pending_maintenance';
            else if ((html || '').length > 2000) reason = 'busy'; // big panel, no seat form => timer
            return { atBase: false, reason: reason, info: info, bytes: (html || '').length };
        })
        .catch(function (e) { return { atBase: false, reason: 'unreadable', info: null, error: String(e) }; });
}

// ── L2: PLANNER ─────────────────────────────────────────────────────────────────

// Bands are ADJACENT (hi(N+1) === lo(N)), so membership must be HALF-OPEN: lo < dist <= hi.
// Closed bands would let a route exactly on a boundary belong to two strategies at once and
// disagree with legsForDist(). am4ExpScoreRoutes filters inclusively, so callers pass bandLo+1.
function am4RbBand(n) { return am4StratBand(n, { n: n, modded: true }); }
function am4RbRealSpeed() { return am4StratRealSpeed({ n: 2, modded: true }); }
function am4RbLegsForDist(dist) { return dist > 0 ? Math.floor(24 * am4RbRealSpeed() / dist) : 0; }
function am4RbStrategyForDist(dist) {
    var n = am4RbLegsForDist(dist);
    return (n >= AM4_STRAT_N_MIN && n <= AM4_STRAT_N_MAX) ? n : null;
}
function am4RbInBand(dist, band) { return dist > band.lo && dist <= band.hi; }

// Great-circle km between two airport ids, straight from the live airport table. Zero
// requests, and independent of any panel - which matters because the game's route panel
// measures from where the AIRCRAFT currently is, not from its hub (see the note in ①).
function am4RbHubDistance(fromId, toId) {
    var aid = window.airportIconData || [];
    var a = null, b = null;
    for (var i = 0; i < aid.length; i++) {
        if (String(aid[i].Id) === String(fromId)) a = aid[i];
        if (String(aid[i].Id) === String(toId)) b = aid[i];
        if (a && b) break;
    }
    if (!a || !b || a.lat == null || b.lat == null) return 0;
    var R = 6371, p = Math.PI / 180;
    var dLat = (+b.lat - +a.lat) * p, dLon = (+b.lon - +a.lon) * p;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(+a.lat * p) * Math.cos(+b.lat * p) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

// Classify every routed A380 by the strategy its CURRENT route distance implies.
// Reuses the same verified resolution the 2×-fleet list was built on: routeMarkers polyline
// endpoints -> airportIconData by coordinate -> the owned-hub side is the hub, the other is the
// destination -> haversine distance.
// NOTE: routeId here comes from the statusData snapshot and is for DISPLAY/PAIRING ONLY -
// grounding must re-read it live (am4RbFetchGroundRouteId), see recon B1.
var am4RbFleetCache = null;
function am4RbClassifyFleet(force) {
    if (am4RbFleetCache && !force) return Promise.resolve(am4RbFleetCache);
    return am4ExpFetchMeta(false).then(function (meta) {
        var hubIds = {};
        (meta.hubs || []).forEach(function (h) { hubIds[String(h.id)] = h.name; });
        var aid = window.airportIconData || [], rm = window.routeMarkers || {}, sd = window.statusData || {};
        var byCoord = {};
        var ck = function (la, lo) { return (Math.round(la * 100) / 100) + ',' + (Math.round(lo * 100) / 100); };
        aid.forEach(function (a) { if (a && a.lat != null) byCoord[ck(+a.lat, +a.lon)] = a; });
        var resolve = function (la, lo) {
            var e = byCoord[ck(la, lo)];
            if (e) return e;
            var best = null, bd = 1e9;
            for (var i = 0; i < aid.length; i++) {
                var b = aid[i]; if (!b || b.lat == null) continue;
                var dl = +b.lat - la, dg = +b.lon - lo, d = dl * dl + dg * dg;
                if (d < bd) { bd = d; best = b; }
            }
            return (best && bd <= 0.0225) ? best : null;
        };
        var hav = function (a, o, c, d) {
            var R = 6371, p = Math.PI / 180;
            var x = (c - a) * p, y = (d - o) * p;
            var h = Math.sin(x / 2) * Math.sin(x / 2) + Math.cos(a * p) * Math.cos(c * p) * Math.sin(y / 2) * Math.sin(y / 2);
            return 2 * R * Math.asin(Math.sqrt(h));
        };
        var r2p = {};
        Object.keys(rm).forEach(function (rid) {
            var ll = rm[rid] && rm[rid]._latlngs; if (!ll) return;
            var pts = [];
            (Array.isArray(ll) ? ll : []).forEach(function (sg) {
                if (Array.isArray(sg)) sg.forEach(function (p) { if (p && p.lat != null) pts.push([p.lat, p.lng]); });
                else if (sg && sg.lat != null) pts.push([sg.lat, sg.lng]);
            });
            if (pts.length < 2) return;
            var A = resolve(pts[0][0], pts[0][1]), B = resolve(pts[pts.length - 1][0], pts[pts.length - 1][1]);
            if (A && B) r2p[String(rid)] = { A: A, B: B, dist: Math.round(hav(+A.lat, +A.lon, +B.lat, +B.lon)) };
        });
        var planes = [], unresolved = 0, uncertain = 0;
        Object.keys(sd).forEach(function (k) {
            var p = sd[k];
            if (!p || !p.routeId || p.routeId === 0) return;
            var wantIcon = am4AircraftIconId();
            if (wantIcon && p.icon && p.icon !== wantIcon) return;
            var pr = r2p[String(p.routeId)];
            if (!pr) { unresolved++; return; }
            // WHICH END IS HOME: the polyline is drawn FROM the route's departure hub.
            //
            // Measured across all 467 live routes on 2026-08-15: the FIRST point was an owned
            // hub 449 times, the LAST point was the only owned end ZERO times, and the
            // remaining 18 routes run between two owned hubs (where the same rule decides).
            // Cross-checked against the aircraft naming convention on the 178 aircraft named
            // after an endpoint: 176 agree, and the 2 apparent misses are aircraft named after
            // their own HUB rather than their destination - a naming exception, not a
            // classification error. So the direction is authoritative and this is not a guess.
            //
            // Anything that contradicts the rule is marked UNCERTAIN and kept out of planning
            // rather than resolved by preference - searching destinations from the wrong city
            // is exactly the failure this whole module has to avoid.
            var hub = pr.A, dest = pr.B, certain = true;
            if (!hubIds[String(pr.A.Id)]) {
                certain = false;
                if (hubIds[String(pr.B.Id)]) { hub = pr.B; dest = pr.A; }
            }
            if (!certain) uncertain++;
            planes.push({
                aircraftId: String(k), reg: String(p.reg == null ? k : p.reg),
                snapshotRouteId: p.routeId,
                hubId: String(hub.Id), hubIcao: hub.icao || hub.iata || String(hub.Id),
                curDestId: String(dest.Id), curDestIcao: dest.icao || dest.iata || String(dest.Id),
                curDist: pr.dist,
                bothEndsAreHubs: !!(hubIds[String(pr.A.Id)] && hubIds[String(pr.B.Id)]),
                hubCertain: certain,
                legs: am4RbLegsForDist(pr.dist),
                strategy: am4RbStrategyForDist(pr.dist)
            });
        });
        am4RbFleetCache = { planes: planes, hubIds: hubIds, unresolved: unresolved, uncertain: uncertain, at: Date.now() };
        return am4RbFleetCache;
    });
}

// ── Reading the fleet from the GAME instead of from the page snapshot ───────────
//
// am4RbClassifyFleet above reads window.statusData + window.routeMarkers, and BOTH are
// filled once when the page loads and never again. Measured 2026-08-17 while two aircraft
// were grounded for a rebuild: the game reported them as"Maintenance" with their old
// routes gone, while the snapshot still listed them on route 40820482 / 37614672 - and the
// route total had moved from 467 to 445 without the snapshot noticing. So the panel's
// strategy counts silently describe the fleet as it was hours ago, and forcing a
// re-classification changes nothing at all because it re-reads the same frozen data.
//
// The route list is NOT available from the server (routes.php returns a 7 KB shell; the
// game builds the list in the browser from those same globals). What IS available is the
// aircraft page: fleet_details.php carries the live route id AND both endpoints, in
//`div.col-5.bg-light > span.l-text.exo` .
//
// One catch, measured: those two are the CURRENT LEG's departure and arrival, not
// hub-then-destination. Aircraft A380/7M read"FZAA → KLAX" with KLAX as its owned hub.
// So the hub is identified by WHICH END IS OWNED, not by position - and for a route
// between two owned hubs that test cannot decide. Those keep the snapshot's answer while
// their route is unchanged (matched on route id, where the verified polyline-direction rule
// still applies) and are marked uncertain only if the route really moved. Uncertain
// aircraft are excluded from planning, never guessed.
//
// Cost is honest and stated in the UI: one request per routed A380 (~420), throttled like
// every other sweep, so roughly two and a half minutes.
var am4RbFleetSource = 'snapshot'; //'snapshot' (page load) |'live' (read from the game)
var am4RbFleetReadAt = 0;
var am4RbFleetLiveBusy = false;

// Both endpoints + the live route id for ONE aircraft. Returns null when unreadable.
function am4RbFetchRouteEnds(aircraftId) {
    return fetch('fleet_details.php?id=' + encodeURIComponent(aircraftId), { credentials: 'include'})
        .then(function (r) { return r.text(); })
        .then(function (html) {
            var d = document.createElement('div');
            d.innerHTML = html || '';
            var ends = [];
            d.querySelectorAll('.col-5.bg-light span.l-text.exo').forEach(function (el) {
                var t = (el.textContent || '').trim();
                if (/^[A-Z0-9]{3,4}$/.test(t)) ends.push(t);
            });
            var gm = (html || '').match(/fleet_ground\.php\?id=(\d+)/);
            // Exactly two is the shape every aircraft returned in testing; anything else is
            // not understood and must not be turned into a route.
            if (ends.length !== 2) return { routeId: gm ? gm[1] : null, ends: null };
            return { routeId: gm ? gm[1] : null, ends: ends };
        })
        .catch(function () { return null; });
}

// Re-reads every routed A380 from the game and replaces the classification with it.
// onProgress(done, total, reg) is called per aircraft so the UI can show real progress.
function am4RbRefreshFleetLive(onProgress) {
    if (am4RbFleetLiveBusy) return Promise.resolve(null);
    am4RbFleetLiveBusy = true;
    var throttle = (am4ExpLoadCfg().throttleMs) || 350;
    // The owned-hub list decides which end is home, so it has to be current too - a hub
    // bought today would otherwise make every aircraft based there look uncertain.
    return am4ExpFetchMeta(false).then(function (meta) {
        var hubIds = {};
        (meta.hubs || []).forEach(function (h) { hubIds[String(h.id)] = h.name; });
        var byIcao = {};
        (window.airportIconData || []).forEach(function (a) {
            if (!a) return;
            if (a.icao) byIcao[String(a.icao).toUpperCase()] = a;
            if (a.iata) byIcao[String(a.iata).toUpperCase()] = a;
        });
        // Whatever the snapshot knew, keyed by aircraft - used to keep the verified
        // polyline answer for aircraft whose route has not moved.
        var prior = {};
        var priorFleet = am4RbFleetCache;
        if (priorFleet && priorFleet.planes) priorFleet.planes.forEach(function (p) { prior[p.aircraftId] = p; });

        return am4RbListAtBaseOrRouted().then(function (fleet) {
            var routed = fleet.filter(function (p) { return /Routed/i.test(p.status); });
            var planes = [], unresolved = 0, uncertain = 0, i = 0;
            return new Promise(function (resolve) {
                (function next() {
                    if (i >= routed.length) { resolve({ planes: planes, unresolved: unresolved, uncertain: uncertain, hubIds: hubIds, total: routed.length }); return; }
                    var ac = routed[i];
                    am4RbFetchRouteEnds(ac.planeId).then(function (res) {
                        if (!res || !res.ends) { unresolved++; }
                        else {
                            var A = byIcao[res.ends[0]], B = byIcao[res.ends[1]];
                            if (!A || !B) { unresolved++; }
                            else {
                                var aOwned = !!hubIds[String(A.Id)], bOwned = !!hubIds[String(B.Id)];
                                var hub = null, dest = null, certain = true;
                                var was = prior[String(ac.planeId)];
                                var routeUnchanged = !!(was && res.routeId && String(was.snapshotRouteId) === String(res.routeId));
                                if (aOwned && !bOwned) { hub = A; dest = B; }
                                else if (bOwned && !aOwned) { hub = B; dest = A; }
                                else if (aOwned && bOwned) {
                                    // Both ends are ours. The endpoint order here is the current
                                    // leg's direction, so it cannot answer this - but if the route
                                    // is the same one the snapshot classified, its verified
                                    // polyline direction still holds.
                                    //
                                    //`was.hubCertain !== false` is load-bearing: carrying over an
                                    // answer that was ITSELF a guess would launder it into a
                                    // confident one, and the planner only excludes what is marked
                                    // uncertain. Caught by the v1.48 test before it shipped.
                                    if (routeUnchanged && was.hubCertain !== false) {
                                        hub = byIcao[String(was.hubIcao).toUpperCase()] || A;
                                        dest = (hub === A) ? B : A;
                                    } else { hub = A; dest = B; certain = false; }
                                } else { hub = A; dest = B; certain = false; }
                                if (!certain) uncertain++;
                                var dist = am4RbHubDistance(hub.Id, dest.Id);
                                planes.push({
                                    aircraftId: String(ac.planeId), reg: String(ac.reg || ac.planeId),
                                    snapshotRouteId: res.routeId,
                                    hubId: String(hub.Id), hubIcao: hub.icao || hub.iata || String(hub.Id),
                                    curDestId: String(dest.Id), curDestIcao: dest.icao || dest.iata || String(dest.Id),
                                    curDist: dist,
                                    bothEndsAreHubs: !!(aOwned && bOwned),
                                    hubCertain: certain,
                                    legs: am4RbLegsForDist(dist),
                                    strategy: am4RbStrategyForDist(dist)
                                });
                            }
                        }
                        i++;
                        if (typeof onProgress === 'function') onProgress(i, routed.length, ac.reg || ac.planeId);
                        setTimeout(next, throttle);
                    });
                })();
            });
        });
    }).then(function (r) {
        am4RbFleetLiveBusy = false;
        if (!r) return null;
        am4RbFleetCache = { planes: r.planes, hubIds: r.hubIds, unresolved: r.unresolved,
                            uncertain: r.uncertain, at: Date.now(), source: 'live'};
        am4RbFleetSource = 'live';
        am4RbFleetReadAt = Date.now();
        return am4RbFleetCache;
    }).catch(function (e) {
        am4RbFleetLiveBusy = false;
        throw e;
    });
}

// Every A380 the game currently lists, with its status - one request.
function am4RbListAtBaseOrRouted() {
    return fetch('fleet.php?type=' + am4AircraftTypeId(), { credentials: 'include'})
        .then(function (r) { return r.text(); })
        .then(function (html) { return am4FleetParseA380Rows(html, null); });
}

// Hubs that have aircraft on the chosen FROM strategy, most first. Feeds the multi-hub picker.
function am4RbHubsForStrategy(fromN, force) {
    return am4RbClassifyFleet(force).then(function (fa) {
        var byHub = {};
        fa.planes.forEach(function (p) {
            if (p.strategy !== fromN) return;
            // An aircraft whose home hub could not be established is never offered for a
            // rebuild: its destinations would be searched from the wrong city.
            if (p.hubCertain === false) return;
            if (!byHub[p.hubId]) byHub[p.hubId] = { hubId: p.hubId, hubIcao: p.hubIcao, planes: [] };
            byHub[p.hubId].planes.push(p);
        });
        return Object.keys(byHub).map(function (k) { return byHub[k]; })
            .sort(function (a, b) { return b.planes.length - a.planes.length || String(a.hubIcao).localeCompare(String(b.hubIcao)); });
    });
}

// A per-strategy summary of the whole fleet, for the FROM/TO selectors ("87 aircraft on S2").
function am4RbStrategyCounts(force) {
    return am4RbClassifyFleet(force).then(function (fa) {
        var c = { other: 0, total: fa.planes.length,
                  unresolved: fa.unresolved, uncertain: fa.uncertain || 0, bothEndsAreHubs: 0 };
        fa.planes.forEach(function (p) {
            if (p.strategy) c[p.strategy] = (c[p.strategy] || 0) + 1; else c.other++;
            if (p.bothEndsAreHubs) c.bothEndsAreHubs++;
        });
        return c;
    });
}

// Raw per-hub sweep for ONE target strategy, cache-first. Returns decoded rows plus which
// countries hit the game's 50-row cap (so the caller can report a floor, not a total).
var am4RbScanRunID = 0;
function am4RbEnsureAircraftStats() {
    if (!am4AircraftProfileIncomplete()) return Promise.resolve(am4AircraftProfile());
    if (typeof am4AircraftSelectType !== 'function') return Promise.resolve(am4AircraftProfile());
    am4RbAnalyseMsg('reading ' + am4AircraftName() + ' order stats…', '#38bdf8');
    return am4AircraftSelectType(am4AircraftTypeId());
}

function am4RbBuildScoreCfg(toN) {
    var band = am4RbBand(toN);
    if (!band.possible) return null;
    am4AircraftSanitizeSeats(am4AircraftCurrent);
    var prof = am4AircraftProfile();
    var expCfg = am4ExpLoadCfg();
    var seats = am4AircraftSeats();
    var minRwy = (prof.minRwy > 0) ? prof.minRwy : expCfg.minRwy;
    return {
        seatStrategy: expCfg.seatStrategy,
        cargoStrategy: expCfg.cargoStrategy,
        throttleMs: expCfg.throttleMs,
        flightsPerDay: toN,
        cruiseKph: am4StratCruiseKph({ n: toN, modded: true }),
        realSpeed: band.realSpeed,
        bandLo: band.lo,
        bandHi: band.hi,
        minKm: band.lo,
        rangeKm: band.hi,
        distCap: band.hi,
        seats: seats,
        cargo: am4AircraftIsCargo(),
        cargoKg: am4AircraftIsCargo() ? am4AircraftCargoKg() : 0,
        cargoSplit: am4AircraftCargoSplit(),
        typeId: am4AircraftTypeId(),
        minRwy: minRwy,
        goodFillPct: Math.min(expCfg.goodFillPct, AM4_RB_GOOD_FILL_PCT)
    };
}

function am4RbFormatScoreStats(stats) {
    if (!stats) return '';
    var parts = [];
    if (stats.rows) parts.push(stats.rows + ' raw');
    if (stats.inBand) parts.push(stats.inBand + ' in band');
    if (stats.fillFail) parts.push(stats.fillFail + ' low fill');
    if (stats.rwyFail) parts.push(stats.rwyFail + ' runway');
    if (stats.distFail) parts.push(stats.distFail + ' distance');
    if (stats.zeroRev) parts.push(stats.zeroRev + ' no rev');
    return parts.join(' · ');
}

function am4RbScanHubRaw(hubId, toN, opts, onProgress) {
    opts = opts || {};
    var band = am4RbBand(toN);
    var distCap = band.hi;
    if (!opts.force) {
        var hit = am4RbCacheGet(hubId, distCap, opts.ttlMs);
        if (hit) return Promise.resolve({ rows: hit.rows, capped: hit.capped, fromCache: true, at: hit.at, distCap: distCap });
    }
    var cfg = am4ExpLoadCfg();
    var minRwy = (am4AircraftProfile().minRwy > 0) ? am4AircraftProfile().minRwy : cfg.minRwy;
    var runID = ++am4RbScanRunID;
    return am4ExpFetchMeta(false).then(function (meta) {
        var countries = (meta.countries && meta.countries.length) ? meta.countries : [];
        return new Promise(function (resolve) {
            var rows = [], capped = [], i = 0;
            (function next() {
                if (runID !== am4RbScanRunID) { resolve(null); return; } // cancelled
                if (i >= countries.length) {
                    am4RbCachePut(hubId, distCap, rows, capped);
                    var stored = am4RbCacheGet(hubId, distCap, 0);
                    resolve({ rows: stored ? stored.rows : rows, capped: capped, fromCache: false, at: Date.now(), distCap: distCap });
                    return;
                }
                var country = countries[i];
                var url = 'research_main.php?mode=search&rwy=' + minRwy + '&dist=' + distCap +
                          '&depId=' + encodeURIComponent(hubId) + '&arr=' + encodeURIComponent(country) +
                          '&arrId=0&charter=0&_=' + Date.now();
                fetch(url, { credentials: 'include'})
                    .then(function (r) { return r.text(); })
                    .then(function (h) {
                        var parsed = am4ExpParseRows(h);
                        // Exactly the cap => the game truncated this country's list.
                        if (parsed.length >= AM4_RB_SEARCH_ROW_CAP) capped.push(country);
                        rows = rows.concat(parsed);
                    })
                    .catch(function () { /* skip this country, keep sweeping */ })
                    .then(function () {
                        i++;
                        if (typeof onProgress === 'function') onProgress(i, countries.length, country);
                        setTimeout(next, cfg.throttleMs);
                    });
            })();
        });
    });
}
function am4RbCancelScan() { am4RbScanRunID++; }

// Score raw rows for the TARGET strategy. Uses this type's real seats/runway (not stale A380
// Explorer defaults) and a rebuild fill cap (85%) so high-N bands still find candidates.
function am4RbScoreDests(rows, hubId, toN, flownMap) {
    var cfg = am4RbBuildScoreCfg(toN);
    if (!cfg || !(cfg.seats > 0)) {
        return { good: [], goodCount: 0, built: 0, remaining: 0, stats: { zeroRev: (rows || []).length }, cfg: cfg };
    }
    var fm = flownMap || am4ExpBuildFlownMap();
    var flownSet = (fm.map && fm.map[hubId]) || {};
    var countSet = (fm.counts && fm.counts[hubId]) || {};
    var scored = am4ExpScoreRoutes(rows, flownSet, cfg, countSet);
    // ★ longest-in-band first, then prefer UNBUILT (spread aircraft onto fresh routes), then km.
    scored.good.sort(function (a, b) {
        return (Number(b.preferred) - Number(a.preferred)) ||
               (Number(!!a.built) - Number(!!b.built)) ||
               (b.km - a.km);
    });
    scored.cfg = cfg;
    return scored;
}

// Seats for the NEW route: caps = demand ÷ TO per class (each of the N daily flights serves its
// share), economy-first cascade into the 600 slots (weights Y1/J2/F3), every class >= 1 because
// route creation silently no-ops unless e>0 && b>0 && f>0.
function am4RbTargetSeats(demand, toN) {
    var n = toN || 3;
    var caps = {
        y: Math.floor((demand.y || 0) / n),
        j: Math.floor((demand.j || 0) / n),
        f: Math.floor((demand.f || 0) / n)
    };
    var cap = am4AircraftSeats();
    var expCfg = (typeof am4ExpLoadCfg === 'function') ? am4ExpLoadCfg() : {};
    var topOrder = (expCfg.seatStrategy === 'economy-first') ? ['y', 'j', 'f'] : ['f', 'j', 'y'];
    var norm = am4PaxSeatNormalize(caps.y, caps.j, caps.f, cap, topOrder);
    if (norm.y + norm.j + norm.f < 3) {
        norm = am4PaxSeatNormalize(
            Math.max(1, caps.y), Math.max(1, caps.j), Math.max(1, caps.f), cap, topOrder);
    }
    return { y: norm.y, j: norm.j, f: norm.f };
}

// Destinations claimed by an in-flight rebuild or auto-build job for this hub. Existing
// routes are NOT reserved — AM4 allows multiple aircraft on the same hub→destination pair,
// and a rebuild often moves planes onto destinations that already have other aircraft on S8.
function am4RbReservedDests(hubId, hubIcao) {
    var taken = {};
    try {
        (am4RbQueue || []).forEach(function (j) {
            if (!j || !j.newDestId || String(j.hubId) !== String(hubId)) return;
            if (AM4_RB_ACTIVE.indexOf(j.state) !== -1) taken[String(j.newDestId)] = 'queued for ' + j.reg;
        });
    } catch (e) { /* queue not loaded yet */ }
    try {
        if (typeof am4BuildQueue !== 'undefined') {
            (am4BuildQueue || []).forEach(function (j) {
                if (!j || !j.arrId) return;
                var sameHub = !hubIcao || !j.hubName || String(j.hubName).toLowerCase().indexOf(String(hubIcao).toLowerCase()) === 0;
                if (sameHub && ['done','error','cancelled' ].indexOf(j.state) === -1) taken[String(j.arrId)] = 'queued in the build pipeline';
            });
        }
    } catch (e) { /* build module absent */ }
    return taken;
}

// Pair aircraft to destinations. Prefers unbuilt routes (spread onto fresh pairs) but allows
// built ones when needed — unlike Auto-Build, rebuild is allowed to stack aircraft on an
// existing hub→destination. Skips each plane's current destination (no-op rebuild).
function am4RbPair(planes, dests, hubId, hubIcao, toN) {
    var reserved = am4RbReservedDests(hubId, hubIcao);
    var pool = dests.filter(function (d) { return !reserved[String(d.arrId)]; });
    var unbuilt = pool.filter(function (d) { return !d.built; });
    var built = pool.filter(function (d) { return !!d.built; });
    var pairs = [], unpaired = [];
    var ui = 0, bi = 0;

    function pickForPlane(plane) {
        var cur = plane.curDestId ? String(plane.curDestId) : '';
        var i, d;
        for (i = ui; i < unbuilt.length; i++) {
            d = unbuilt[i];
            if (String(d.arrId) === cur) continue;
            ui = i + 1;
            return d;
        }
        for (i = 0; i < unbuilt.length; i++) {
            d = unbuilt[i];
            if (String(d.arrId) === cur) continue;
            return d;
        }
        for (i = bi; i < built.length; i++) {
            d = built[i];
            if (String(d.arrId) === cur) continue;
            bi = i + 1;
            return d;
        }
        for (i = 0; i < built.length; i++) {
            d = built[i];
            if (String(d.arrId) === cur) continue;
            return d;
        }
        return null;
    }

    planes.forEach(function (p) {
        var chosen = pickForPlane(p);
        if (!chosen) {
            var why = pool.length
                ? ('no Strategy ' + toN + ' destination left (queue holds ' + Object.keys(reserved).length + ')')
                : ('no fillable Strategy ' + toN + ' destinations from this hub');
            unpaired.push({ plane: p, why: why });
            return;
        }
        var air = (typeof am4FleetResolveAirport === 'function') ? am4FleetResolveAirport(String(chosen.arrId)) : null;
        var icao = air ? (air.icao || air.iata || String(chosen.arrId)) : String(chosen.arrId);
        pairs.push({
            plane: p, dest: chosen, destIcao: icao,
            seats: am4RbTargetSeats(chosen.demand || { y: 0, j: 0, f: 0 }, toN),
            fromStrategy: p.strategy, toStrategy: toN
        });
    });
    return { pairs: pairs, unpaired: unpaired, reservedCount: Object.keys(reserved).length, poolCount: pool.length };
}

// A route/aircraft name that is not already in use. Aircraft registrations must be UNIQUE
// (verified §9 - duplicate regs got a batch of auto-build orders refused), and a rebuild renames
// the aircraft to its new destination, so the same derivation is applied here.
function am4RbUniqueName(baseIcao, extraTaken) {
    var used = {};
    try {
        var sd = window.statusData || {};
        Object.keys(sd).forEach(function (k) { if (sd[k] && sd[k].reg != null) used[String(sd[k].reg).toUpperCase()] = true; });
    } catch (e) { /* ignore */ }
    try {
        (am4RbQueue || []).forEach(function (j) { if (j && j.newReg) used[String(j.newReg).toUpperCase()] = true; });
    } catch (e) { /* ignore */ }
    (extraTaken || []).forEach(function (n) { used[String(n).toUpperCase()] = true; });
    var base = String(baseIcao || 'RB').toUpperCase();
    if (!used[base]) return base;
    for (var i = 2; i < 100; i++) {
        var cand = base + '-' + i;
        if (!used[cand]) return cand;
    }
    return base + '-' + Date.now().toString(36).slice(-3).toUpperCase();
}

//================================================================================
// Part 18 (continued): STRATEGY REBUILD V2 — L3 job engine, L4 orchestrator, L5 UI.
//
// This REPLACES the old Part 17 conversion module (2×→3× only, German UI, single hub,
// no error taxonomy, no crash safety). Everything proven there is carried over: the
// at-hub oracle, the fleet_ground toggle, the recovery tool and the v1.29/v1.30
// anti-starvation scheduler. Everything that stranded 41 aircraft is fixed or bounded.
//
// Design notes that matter (measured, see GAME_CONTRACTS + REBUILD_V2_PLAN):
// - Ground ONLY when the modify panel confirms the aircraft is at a base, and ground in
// the same step so Auto-Depart cannot re-launch it in between.
// - Resolve the ground routeId LIVE from fleet_details; statusData's copy can be stale
// and would ground the wrong route.
// - A failure AFTER grounding rolls back (un-grounds) so the aircraft earns again
// instead of sitting in limbo.
// - One aircraft's failure never stops the queue; 5 fatal failures in a row trip a
// circuit breaker and pause the whole run.
//================================================================================
var AM4_RB_QUEUE_KEY = 'am4RbQueue';
var AM4_RB_AUTORUN_KEY = 'am4RbAutoRun';
var AM4_RB_TOTAL_KEY = 'am4RbRebuiltTotal';
var AM4_RB_QUEUE_SCHEMA = 1;

// Finished aircraft leave the working list on their own after this long. Reported live
// 2026-08-16:"they stay in the list and only confuse me" - and that is fair, a queue is a
// list of what still has to happen. The count is NOT lost: every completion is added to a
// persisted total that the panel shows above the list, so the tally survives both the
// clean-up and a reload. Ten minutes is long enough to see a rebuild land in the list and
// read it, short enough that the list stays about the work that is left.
var AM4_RB_DONE_KEEP_MS = 10 * 60 * 1000;

function am4RbTotal() {
    try { var n = parseInt(localStorage.getItem(AM4_RB_TOTAL_KEY), 10); return isFinite(n) ? n : 0; }
    catch (e) { return 0; }
}
function am4RbBumpTotal() {
    try { localStorage.setItem(AM4_RB_TOTAL_KEY, String(am4RbTotal() + 1)); } catch (e) { /* ignore */ }
}
// Drops finished jobs once they have had their moment on screen. Never touches anything that
// still needs a decision - cancelled stays until cleared by hand, needs_attention never goes.
function am4RbPruneDone() {
    var now = Date.now(), before = am4RbQueue.length;
    am4RbQueue = am4RbQueue.filter(function (j) {
        if (j.state !== 'done') return true;
        return (now - (j.updatedAt || 0)) < AM4_RB_DONE_KEEP_MS;
    });
    if (am4RbQueue.length !== before) am4RbSaveQueue();
    return before - am4RbQueue.length;
}

var AM4_RB_TICK_MS = 120000; // slow heartbeat: polls every ready job
var AM4_RB_DRAIN_MS = 8000; // fast drain between steps that made progress
var AM4_RB_BASE_POLL_MS = 60000; // awaiting_base: how often to ask"are you home yet? " 
var AM4_RB_CONFIG_POLL_MS = 300000; // awaiting_config: the modify timer runs up to ~8 h

// Safety limits. 0 = unlimited.
//
// Both throughput caps are OFF by default, at the user's explicit instruction (2026-08-16):
// process every queued aircraft at once. What that costs is real and worth stating plainly -
// a grounded aircraft earns nothing, so with the concurrency cap off the whole batch stops
// earning for the length of its modification timers instead of five at a time.
//
// What the caps were originally protecting against no longer depends on them. The
// 41-aircraft incident was NOT caused by volume: it was caused by grounding aircraft at the
// far end of their route, which the arrival-countdown check in ② now makes impossible.
// The circuit breaker below is the guard that actually matters and it stays on - five fatal
// failures in a row stop the entire run, whatever the batch size.
var AM4_RB_MAX_QUEUE_PER_RUN = 0; // most aircraft one"Queue selected" may enqueue (0 = all)
var AM4_RB_MAX_GROUNDED_AT_ONCE = 0; // how many may be grounded for a rebuild at once (0 = no cap)
var AM4_RB_BREAKER_THRESHOLD = 5; // consecutive fatal jobs that pause the whole run
var AM4_RB_MAX_ATTEMPTS = 6; // transient retries per state before it becomes fatal
var AM4_RB_BACKOFF_MS = [30000, 120000, 480000, 1800000]; // 30 s, 2 m, 8 m, 30 m (then capped)

// States the scheduler will advance. needs_attention/done/cancelled are deliberately NOT
// here: they wait for the user, they are not retried behind their back.
var AM4_RB_ACTIVE = ['queued','validating','awaiting_base','grounding','configuring',
                     'awaiting_config','routing','verifying','rolling_back' ];
// Actionable = always changes state when it runs. The fast drain prefers these so a block
// of polling jobs can never throttle real work (the v1.30 lesson).
var AM4_RB_ACTIONABLE = ['queued','validating','grounding','configuring','routing','verifying','rolling_back' ];

var AM4_RB_STEP_LABEL = {
    queued: '① Queued', validating: '① Checking', awaiting_base: '② Waiting for base',
    grounding: '③ Grounding', configuring: '④ Configuring', awaiting_config: '⑤ Config timer',
    routing: '⑥ Creating route', verifying: '⑦ Verifying', done: '✓ Done',
    rolling_back: '↩ Restoring', needs_attention: '⚠ Needs attention', cancelled: 'Cancelled' 
};
var AM4_RB_STEP_COLOR = {
    queued: '#94a3b8', validating: '#94a3b8', awaiting_base: '#94a3b8', grounding: '#a78bfa',
    configuring: '#a78bfa', awaiting_config: '#94a3b8', routing: '#a78bfa', verifying: '#a78bfa',
    done: '#10b981', rolling_back: '#f59e0b', needs_attention: '#ef4444', cancelled: '#64748b' 
};

var am4RbQueue = [];
var am4RbTimer = null;
var am4RbBusy = false;
var am4RbLastId = null;
var am4RbBreaker = { consecutiveFatal: 0, trippedAt: 0, reason: ''};

(function am4RbLoadQueue() {
    try {
        var raw = JSON.parse(localStorage.getItem(AM4_RB_QUEUE_KEY) || 'null');
        if (raw && raw.schema === AM4_RB_QUEUE_SCHEMA && Array.isArray(raw.jobs)) am4RbQueue = raw.jobs;
        else if (Array.isArray(raw)) am4RbQueue = []; // pre-schema shape: start clean rather than misread it
    } catch (e) { am4RbQueue = []; }
    // MIGRATION. The running total arrived in v1.45, after rebuilds had already been done -
    // and v1.45 also starts removing finished jobs from the list. Without this, upgrading
    // mid-run would clear the finished aircraft off the screen while the counter still read
    // zero, quietly erasing the evidence of everything achieved so far. Seed it once from
    // whatever the queue already contains.
    try {
        if (localStorage.getItem(AM4_RB_TOTAL_KEY) === null) {
            var already = am4RbQueue.filter(function (j) { return j && j.state === 'done'; }).length;
            localStorage.setItem(AM4_RB_TOTAL_KEY, String(already));
            if (already) {
                console.log('[AM4 Bot Log] Strategy Rebuild: carried ' + already +
                ' completed rebuild(s) over into the new running total.');
            }
        }
    } catch (e) { /* storage blocked - the total simply starts at 0 */ }
})();
function am4RbSaveQueue() {
    try { localStorage.setItem(AM4_RB_QUEUE_KEY, JSON.stringify({ schema: AM4_RB_QUEUE_SCHEMA, jobs: am4RbQueue })); }
    catch (e) { /* storage full - the queue still runs in memory this session */ }
}
function am4RbAutoRun() { try { return localStorage.getItem(AM4_RB_AUTORUN_KEY) === '1'; } catch (e) { return false; } }
function am4RbSetAutoRun(on) {
    try { localStorage.setItem(AM4_RB_AUTORUN_KEY, on ?'1' : '0'); } catch (e) { /* ignore */ }
    if (typeof am4BuildKeepAlive === 'function') am4BuildKeepAlive(on);
}

// ── shared game calls ───────────────────────────────────────────────────────────
// Ground / un-ground. VERIFIED: the same URL does both - fleet_details wires its"Ground" 
// and its hidden"Unground" button to the identical link. Takes the ROUTE id.
function am4FleetGround(routeId) {
    return fetch('fleet_ground.php?id=' + encodeURIComponent(routeId), { credentials: 'include'})
        .then(function (r) { return r.text(); });
}
// A grounded aircraft reports status"Grounded" , not"Parked" , yet it IS at base and fully
// modifiable + routable. The shared fleet helpers filter Parked / Parked|Routed and would
// miss it - which is exactly what stalled the first live conversion test.
function am4RbListAtBase() {
    return fetch('fleet.php?type=' + am4AircraftTypeId(), { credentials: 'include'})
        .then(function (r) { return r.text(); })
        .then(function (html) { return am4FleetParseA380Rows(html, /Parked|Grounded/i); });
}
function am4RbListGrounded() {
    return fetch('fleet.php?type=' + am4AircraftTypeId(), { credentials: 'include'})
        .then(function (r) { return r.text(); })
        .then(function (html) { return am4FleetParseA380Rows(html, /Grounded/i); });
}
// One aircraft's row exactly as the fleet list reports it, status included and UNFILTERED.
// Needed because the status a rebuilt aircraft carries is not one of the two the helpers
// above look for - see the note on am4RbListAtBase's use in the routing step.
function am4RbFleetRow(aircraftId) {
    return fetch('fleet.php?type=' + am4AircraftTypeId(), { credentials: 'include'})
        .then(function (r) { return r.text(); })
        .then(function (html) {
            var rows = am4FleetParseA380Rows(html, null);
            return rows.filter(function (x) { return x.planeId === String(aircraftId); })[0] || null;
        });
}

// ── L3: job bookkeeping ─────────────────────────────────────────────────────────

// The transparency triple. Every job row answers: what step is this, why is it here, and
// what happens next - the user should never have to guess whether something is stuck.
function am4RbSay(job, what, why, next) {
    if (what != null) job.what = what;
    if (why != null) job.why = why;
    if (next != null) job.next = next;
    job.updatedAt = Date.now();
    am4RbSaveQueue();
    am4RbRenderQueue();
}
function am4RbSetState(job, state, why, next) {
    var was = job.state;
    job.state = state;
    job.what = AM4_RB_STEP_LABEL[state] || state;
    if (why != null) job.why = why;
    job.next = (next == null) ?'' : next;
    job.updatedAt = Date.now();
    if (state !== was) { job.attempts = 0; job.nextTryAt = 0; }
    // Counted the moment it happens, so the tally is independent of how long the finished
    // job stays in the list - and survives the clean-up and a reload.
    if (state === 'done' && was !== 'done') am4RbBumpTotal();
    am4RbSaveQueue();
    am4RbRenderQueue();
    if (typeof am4LogAction === 'function') {
        var l = { grounding: 'grounded, off its old route', configuring: 'configuring seats + mods',
                  routing: 'creating the new route', done: 'REBUILT ✓',
                  rolling_back: 'restoring to its old route',
                  needs_attention: 'needs attention - ' + (why || '') }[state];
        if (l) am4LogAction('rebuild','🔄 ' + job.reg + ' (S' + job.fromStrategy + '→S' + job.toStrategy + '): ' + l);
    }
}

// Failure classification is what keeps one aircraft from killing the run.
//'gate' not a failure at all - a precondition (funds/lease/quiet/cap). Just wait.
//'transient' retry with backoff; after AM4_RB_MAX_ATTEMPTS it becomes fatal.
//'fatal' stop THIS job. If we grounded the aircraft, roll back first so it earns again.
function am4RbGate(job, reason) {
    am4RbSay(job, null,'waiting: ' + reason,'retrying on the next cycle');
}
function am4RbTransient(job, message) {
    job.attempts = (job.attempts || 0) + 1;
    if (job.attempts > AM4_RB_MAX_ATTEMPTS) {
        am4RbFatal(job, message + ' (gave up after ' + AM4_RB_MAX_ATTEMPTS + ' attempts)');
        return;
    }
    var wait = AM4_RB_BACKOFF_MS[Math.min(job.attempts - 1, AM4_RB_BACKOFF_MS.length - 1)];
    job.nextTryAt = Date.now() + wait;
    am4RbRecordError(job,'transient', message);
    am4RbSay(job, null, message,'retry ' + job.attempts + '/' + AM4_RB_MAX_ATTEMPTS +
        ' in ' + am4RbHuman(wait));
}
function am4RbFatal(job, message) {
    am4RbRecordError(job,'fatal', message);
    am4RbBreaker.consecutiveFatal++;
    if (job.grounded) {
        am4RbSetState(job,'rolling_back', message,
            'un-grounding it so it resumes its old route and keeps earning');
    } else {
        am4RbSetState(job,'needs_attention', message,'waiting for you - Retry or Skip');
    }
    am4RbCheckBreaker();
}
function am4RbRecordError(job, cls, message) {
    job.lastError = { at: Date.now(), state: job.state, cls: cls, message: String(message) };
    job.errorHistory = (job.errorHistory || []).concat([job.lastError]).slice(-10);
}

// THE RACE, and why it gets its own path (measured live 2026-08-16, aircraft MBGT).
//
// Grounding is the last thing ② does after confirming the aircraft is at its base, but
// Auto-Depart can launch it in the same second: MBGT departed PGUM at 15:53:26 UTC and the
// ground landed at 15:54. The result is the one state that must never persist - GROUNDED and
// AIRBORNE at once. It then flies to the far end, lands there grounded, and cannot leave.
// That is precisely the v1.33 stranding, arrived at from a different direction.
//
// Without this path the module never recognised the situation: it only saw"modify panel 
// unreadable", spent six retries across ~40 minutes and rolled back by accident, on the last
// attempt. That worked for MBGT solely because its leg was eight hours long; on a short leg
// the aircraft would have landed and stranded first.
//
// The evidence is already in hand - the same page that says"Grounded" also carries the
// game's own "Arrives in" countdown - so the fix is to look, and to undo the grounding at
// once. It deliberately does NOT count toward the circuit breaker: this is a known, fully
// recoverable collision, not a sign that something systemic broke.
function am4RbRaceRollback(job, detail) {
    am4RbRecordError(job,'race', detail);
    am4RbSetState(job,'rolling_back',
        job.reg + ' was taken off its route in the same moment Auto-Depart launched it, so it is ' +
        'grounded AND in the air - if it landed like that it could not take off again',
        'un-grounding it immediately so it finishes its flight normally and can be rebuilt on its next return');
}

// Is this aircraft grounded by US and airborne right now? Only asked when something already
// looks wrong, so the happy path costs no extra request.
function am4RbCaughtByRace(job) {
    if (!job.grounded) return Promise.resolve(false);
    return am4RbFetchAircraftPage(job.aircraftId)
        .then(function (page) { return !!(page && page.inFlight); })
        .catch(function () { return false; }); // unreadable: fall through to the normal handling
}
// A wave must be able to stop itself. Five fatal jobs in a row means something systemic
// (a changed contract, a logged-out session) - keep going and you repeat the 41-aircraft event.
function am4RbCheckBreaker() {
    if (am4RbBreaker.consecutiveFatal < AM4_RB_BREAKER_THRESHOLD || am4RbBreaker.trippedAt) return;
    am4RbBreaker.trippedAt = Date.now();
    am4RbBreaker.reason = am4RbBreaker.consecutiveFatal + ' jobs failed in a row';
    am4RbSetAutoRun(false);
    var cb = document.getElementById('am4RbAutoRunBox');
    if (cb) cb.checked = false;
    if (typeof am4LogAction === 'function') {
        am4LogAction('rebuild','⛔ Rebuild paused itself: ' + am4RbBreaker.reason + '. Nothing else was touched.');
    }
    console.log('[AM4 Bot Log] Strategy Rebuild circuit breaker tripped: ' + am4RbBreaker.reason);
    am4RbRenderQueue();
}
function am4RbResetBreaker() {
    am4RbBreaker = { consecutiveFatal: 0, trippedAt: 0, reason: ''};
    am4RbRenderQueue();
}
function am4RbHuman(ms) {
    if (ms == null) return '—';
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + ' s';
    var m = Math.round(s / 60);
    if (m < 60) return m + ' min';
    var h = Math.floor(m / 60);
    return h + ' h ' + (m % 60) + ' min';
}
function am4RbGroundedCount() {
    return am4RbQueue.filter(function (j) {
        return j.grounded && AM4_RB_ACTIVE.indexOf(j.state) !== -1;
    }).length;
}

// ── L3: the state machine ───────────────────────────────────────────────────────
// Advance ONE job by one step. Always returns a Promise. Never throws past its own catch.
function am4RbAdvance(job) {
    switch (job.state) {

    // ---- ① pre-flight: everything that can be checked before anything is touched ----
    case'queued' :
    case'validating' : {
        var air = (typeof am4FleetResolveAirport === 'function') ? am4FleetResolveAirport(String(job.newDestId)) : null;
        if (!air) { am4RbFatal(job,'destination ' + job.newDestIcao + ' could not be resolved'); return Promise.resolve(); }
        var band = am4RbBand(job.toStrategy);
        // Independent of the game and of any request: the great-circle distance from the HUB
        // to the destination. The scan's own distance came from research_main.php?depId=<hub>,
        // so the two are measured the same way and must agree; if they do not, something is
        // wrong with the plan and the job stops rather than guessing.
        var geo = am4RbHubDistance(job.hubId, job.newDestId);
        var planned = Number(job.newDistKm) || 0;
        if (!planned || !geo) {
            am4RbFatal(job,'the planned distance for ' + job.newDestIcao + ' could not be confirmed independently');
            return Promise.resolve();
        }
        if (Math.abs(geo - planned) > Math.max(50, planned * 0.02)) {
            am4RbFatal(job,'the planned ' + planned.toLocaleString() + ' km to ' + job.newDestIcao +
                ' does not match the ' + geo.toLocaleString() + ' km measured from ' + job.hubIcao);
            return Promise.resolve();
        }
        if (!am4RbInBand(planned, band)) {
            am4RbFatal(job, job.newDestIcao + ' is ' + planned.toLocaleString() + ' km from ' + job.hubIcao +
                ', which is outside the Strategy ' + job.toStrategy + ' band (' +
                band.lo.toLocaleString() + '–' + band.hi.toLocaleString() + ' km)');
            return Promise.resolve();
        }
        return am4FleetFetchRouteConfig(job.aircraftId, job.newDestId).then(function (rc) {
            if (!rc) { am4RbTransient(job,'the game did not return a route panel'); return; }
            // THE PANEL MEASURES FROM WHERE THE AIRCRAFT IS, NOT FROM ITS HUB.
            //
            // Measured live 2026-08-15: aircraft"KSJC" is based at HAAB and was sitting at the
            // far end of its route in San Jose. Its route panel read"KSJC 823km KONP" - the
            // distance from San Jose, not from Addis Ababa. Eight jobs were failed as
            //"outside the band" on numbers that were never the hub's. A routed aircraft spends
            // half its life at the far end, so this is the normal case, not an edge case.
            //
            // So the panel's distance is only authority when its ORIGIN is the hub. Otherwise
            // the band is judged on the hub-measured distance above, and the panel is re-read
            // as the final gate in ⑥, by which point the aircraft is provably at its base.
            var originIsHub = !!(rc.hubIcao && job.hubIcao && String(rc.hubIcao) === String(job.hubIcao));
            if (originIsHub) {
                if (rc.distKm && !am4RbInBand(rc.distKm, band)) {
                    am4RbFatal(job,'the game reports ' + Number(rc.distKm).toLocaleString() + ' km to ' +
                        job.newDestIcao + ' from ' + rc.hubIcao + ', which is outside the Strategy ' +
                        job.toStrategy + ' band (' + band.lo.toLocaleString() + '–' + band.hi.toLocaleString() + ' km)');
                    return;
                }
                if (rc.distKm && rc.rangeKm && rc.distKm > rc.rangeKm) { am4RbFatal(job,'destination is out of range'); return; }
                if (rc.distKm) job.newDistKm = rc.distKm;
            }
            if (rc.demand && originIsHub) job.seats = am4RbTargetSeats(rc.demand, job.toStrategy);
            am4RbSetState(job,'awaiting_base',
                'checks passed: ' + job.newDestIcao + ' is ' + planned.toLocaleString() + ' km from ' +
                job.hubIcao + ', inside the Strategy ' + job.toStrategy + ' band' +
                (originIsHub ? ' (confirmed by the game)' : ' — the game will confirm it once ' + job.reg + ' is home'),
                'waiting until the aircraft is at its base so it can be taken off its route');
        }).catch(function (e) { am4RbTransient(job,'pre-flight check failed: ' + e); });
    }

    // ---- ② wait for the aircraft to be AT ITS BASE, then ground it in the same step ----
    // This is the step that stranded 41 aircraft in v1.33. Two rules make it safe now:
    // (a) the modify panel is the only trustworthy at-hub oracle (arrived<=now merely means
    //"landed somewhere" , which is how aircraft got grounded at the far end), and
    // (b) the ground fires IMMEDIATELY after that check, so Auto-Depart cannot re-launch
    // the aircraft in the gap. The routeId is fetched FIRST, so the at-base check stays
    // the last thing before the mutation.
    case'awaiting_base' : {
        return am4RbFetchAircraftPage(job.aircraftId).then(function (page) {
            if (!page.routeId) { am4RbTransient(job,'could not read the route id from the aircraft page'); return; }
            job.groundRouteId = String(page.routeId);
            // FIRST test: is it still flying? The game's own "Arrives in" countdown answers that
            // exactly, and it is the test the modify panel cannot make (it opens for an inbound
            // aircraft too). Without this, an aircraft three hours from home reads as"at base" .
            if (page.inFlight) {
                job.etaAt = Date.now() + page.timerSecs * 1000;
                am4RbSay(job, null,
                    job.reg + ' is still in the air on ' + job.hubIcao + ' ↔ ' + job.oldDestIcao +
                    ' — the game says it reaches ' + job.hubIcao + ' in ' + am4RbHuman(page.timerSecs * 1000) + '.',
                    'checking again just after it lands, then taking it off its route (keep Auto-Depart ON so it flies home)');
                return;
            }
            job.etaAt = 0;
            return am4RbReadAircraftState(job.aircraftId).then(function (st) {
                if (!st.atBase) {
                    var nextStep = (st.reason === 'pending_maintenance')
                        ?'waiting for that maintenance to clear — turn Auto-Repair and Auto-Check off during a rebuild' 
                        : 'checking again in ' + am4RbHuman(AM4_RB_BASE_POLL_MS) + ' (keep Auto-Depart ON so it flies home)';
                    am4RbSay(job, null,
                        job.reg + ' is ' + AM4_RB_REASON_TEXT[st.reason] +
                        '. Its route is ' + job.hubIcao + ' ↔ ' + job.oldDestIcao + '.', nextStep);
                    return;
                }
                // At base for real: no arrival countdown AND the modify panel renders.
                if (AM4_RB_MAX_GROUNDED_AT_ONCE > 0 &&
                    am4RbGroundedCount() >= AM4_RB_MAX_GROUNDED_AT_ONCE && !job.grounded) {
                    am4RbGate(job, AM4_RB_MAX_GROUNDED_AT_ONCE + ' aircraft are already grounded for a rebuild ' +
                        '(a grounded aircraft earns nothing, so the queue holds the rest back)');
                    return;
                }
                var gate = am4BuildCanSpend(0);
                if (gate) { am4RbGate(job, gate); return; }
                return am4RbDoGround(job);
            });
        }).catch(function (e) { am4RbTransient(job,'base check failed: ' + e); });
    }

    // ---- ③ grounding is re-entered only by the reconciler ----
    case'grounding' :
        return am4RbDoGround(job);

    // ---- ④ seats for the target strategy + the three mods (Speed is what makes the bands true) ----
    case'configuring' : {
        return am4FleetFetchModifyInfo(job.aircraftId).then(function (info) {
            if (info && info.paused) { am4RbTransient(job,'waiting: Research is using an aircraft'); return; }
            if (!info || !info.looksValid) {
                // An unreadable panel on a grounded aircraft has two very different causes:
                // the game is briefly busy with it, or it is airborne because Auto-Depart won
                // the race in ②. Only the second one is urgent, and only the second one is
                // made worse by waiting - so ask before retrying.
                return am4RbCaughtByRace(job).then(function (racing) {
                    if (racing) am4RbRaceRollback(job,'the modify panel is unreadable because the aircraft is in the air while grounded');
                    else am4RbTransient(job,'the modify panel is not readable right now');
                });
            }
            return am4FleetFetchRouteConfig(job.aircraftId, job.newDestId).then(function (rc) {
                var seats = (rc && rc.demand) ? am4RbTargetSeats(rc.demand, job.toStrategy)
                                              : (job.seats || { y: info.curE, j: info.curB, f: info.curF });
                job.seats = seats;
                var needSeats = (info.curE !== seats.y || info.curB !== seats.j || info.curF !== seats.f);
                var needMods = !info.mod1on || !info.mod2on || !info.mod3on;
                if (!needSeats && !needMods) {
                    am4RbSetState(job,'routing','seats and modifications are already correct - nothing to change',
                        'creating the route to ' + job.newDestIcao);
                    return;
                }
                var cost = am4FleetModifyCost(info, seats.j, seats.f, true, true, true).total;
                var gate = am4BuildCanSpend(cost);
                if (gate) { am4RbGate(job, gate + ' (modification costs ~$' + Math.round(cost / 1e6) + 'M)'); return; }
                job.pending = { action: 'modify', at: Date.now(), seats: seats };
                am4RbSaveQueue();
                var url = am4FleetBuildModifyUrl(job.aircraftId, seats.y, seats.j, seats.f, true, true, true, info.cargo);
                return fetch(url, { credentials: 'include'}).then(function (r) { return r.text(); }).then(function (body) {
                    job.pending = null;
                    if (/too\s+low|denied|invalid|error|failed/i.test(body || '')) {
                        am4RbFatal(job,'the game refused the modification');
                        return;
                    }
                    job.configStartedAt = Date.now();
                    am4RbSetState(job,'awaiting_config',
                        'modification started: seats → Y' + seats.y + '/J' + seats.j + '/F' + seats.f +
                        (needMods ?' plus CO₂/Speed/Fuel' : ''),
                        'the game\'s modification timer now runs — it can take up to ~8 hours, which is normal');
                }).catch(function (e) { job.pending = null; am4RbTransient(job,'modification request failed: ' + e); });
            });
        }).catch(function (e) { am4RbTransient(job,'configuration step failed: ' + e); });
    }

    // ---- ⑤ the modify timer. Tens of minutes here are expected, not a stall ----
    //
    // MEASURED 2026-08-15, and it corrects an assumption this step was built on: the modify
    // panel is NOT a completion oracle. It reports the TARGET seats and upgrades the moment
    // the modification is BOOKED, so testing it alone declared the job finished within
    // seconds and pushed it into ⑥ while the game was still working - where the route
    // request was then refused. The signal that actually tracks the timer is the FLEET LIST
    // STATUS:"Maintenance" while the modification is pending, back to"Grounded" (or
    //"Parked") when it has really completed. So the status decides, and the panel is only
    // used afterwards to confirm the resulting configuration is the one that was asked for.
    case'awaiting_config' : {
        return am4RbFleetRow(job.aircraftId).then(function (row) {
            var since = Date.now() - (job.configStartedAt || job.updatedAt || Date.now());
            if (!row || !/Parked|Grounded/i.test(row.status)) {
                am4RbSay(job, null,
                    'the game\'s modification timer has been running for ' + am4RbHuman(since) +
                    '; the aircraft shows as "' + ((row && row.status) || 'Maintenance') +
                    '" until it finishes, and it cannot be routed before then',
                    'checking again in ' + am4RbHuman(AM4_RB_CONFIG_POLL_MS));
                return;
            }
            // The timer has cleared. Confirm the configuration really is what we ordered
            // before spending a route fee on it.
            return am4FleetFetchModifyInfo(job.aircraftId).then(function (info) {
                var s = job.seats || {};
                var seatsOk = (s.y == null) || (info && info.curE === s.y && info.curB === s.j && info.curF === s.f);
                if (info && info.looksValid && info.mod1on && info.mod2on && info.mod3on && seatsOk) {
                    am4RbSetState(job,'routing',
                        'modification finished after ' + am4RbHuman(since) +
                        ' — seats and all three upgrades are in place',
                        'creating the route to ' + job.newDestIcao);
                    return;
                }
                am4RbSay(job, null,
                    'the aircraft is available again but its configuration does not match what was ordered yet',
                    'checking again in ' + am4RbHuman(AM4_RB_CONFIG_POLL_MS));
            });
        }).catch(function (e) { am4RbTransient(job,'could not read the modification status: ' + e); });
    }

    // ---- ⑥ create the new route ----
    //
    // Readiness is the FLEET LIST STATUS, and only Parked|Grounded counts.
    //
    // This was briefly changed to trust the modify panel instead, on the theory that the
    //"Maintenance" status was cosmetic. A live attempt on 2026-08-15 settled it the other
    // way: the game REFUSED the create while the status read"Maintenance" , so the status is
    // the real gate and the panel is not. What was genuinely wrong is what happens on a miss -
    // it used to spend one of only six retry attempts on a wait that legitimately runs for
    // hours, and would have declared the aircraft broken long before the game was finished
    // with it. A miss now simply returns the job to the unbounded ⑤ wait.
    case'routing' : {
        return am4RbFleetRow(job.aircraftId).then(function (row) {
            if (!row) { am4RbTransient(job,'the aircraft is not in the selected-type fleet list'); return; }
            if (!/Parked|Grounded/i.test(row.status)) {
                am4RbSetState(job,'awaiting_config',
                    'the game still lists ' + job.reg + ' as "' + row.status +
                    '", and it refuses to create a route in that state',
                    'waiting for the game to finish with it, then creating the route');
                return;
            }
            var seats = { y: row.y, j: row.j, f: row.f };
            if (seats.y <= 0 || seats.j <= 0 || seats.f <= 0) {
                am4RbFatal(job,'the aircraft has an empty seat class (Y' + seats.y + '/J' + seats.j + '/F' + seats.f +
                    ') and the game will not create a route without all three');
                return;
            }
            var gate = am4BuildCanSpend(1500000);
            if (gate) { am4RbGate(job, gate); return; }
            return am4FleetFetchRouteConfig(job.aircraftId, job.newDestId).then(function (rc) {
                if (!rc || !rc.hasCreate) { am4RbTransient(job,'the game did not offer a Create button for this route'); return; }
                // THE authoritative gate, and the last thing before money moves. By now the
                // aircraft must be at its own hub, so the panel finally measures hub → dest and
                // its numbers can be trusted. If the origin is anything else the aircraft is
                // sitting somewhere it should not be routed from - refuse and go back to waiting
                // rather than create a route out of the wrong city.
                if (rc.hubIcao && job.hubIcao && String(rc.hubIcao) !== String(job.hubIcao)) {
                    // A grounded aircraft still reads as"Grounded" in the fleet list even while
                    // it is airborne, so the status gate above cannot catch the race - this
                    // origin mismatch is where it surfaces instead. Sending such an aircraft
                    // back to ② would leave it grounded until it lands at the far end, which is
                    // exactly the stranding this whole module exists to avoid.
                    return am4RbCaughtByRace(job).then(function (racing) {
                        if (racing) { am4RbRaceRollback(job,'the route panel reports a foreign origin because the aircraft is in the air while grounded'); return; }
                        am4RbSetState(job,'awaiting_base',
                            'the game would create this route from ' + rc.hubIcao + ', not from ' + job.hubIcao +
                            ' — ' + job.reg + ' is not at its own base',
                            'waiting until it is back at ' + job.hubIcao);
                    });
                }
                if (rc.distKm && !am4RbInBand(rc.distKm, am4RbBand(job.toStrategy))) {
                    am4RbFatal(job,'the game reports ' + Number(rc.distKm).toLocaleString() + ' km from ' +
                        job.hubIcao + ' to ' + job.newDestIcao + ', outside the Strategy ' + job.toStrategy + ' band');
                    return;
                }
                if (rc.distKm && rc.rangeKm && rc.distKm > rc.rangeKm) { am4RbFatal(job,'destination is out of range'); return; }
                if (!job.newReg) { job.newReg = am4RbUniqueName(job.newDestIcao); }
                var prices = am4FleetPricePlan(rc, row.cargo);
                if (!prices) { am4RbFatal(job,'the game did not provide readable base ticket prices'); return; }
                job.pending = { action: 'route', at: Date.now() };
                am4RbSaveQueue();
                var url = am4FleetBuildRouteUrl(job.aircraftId, job.newDestId, job.newReg, prices, 200);
                console.log('[AM4 Bot Log] Strategy Rebuild routing with multiplied ticket prices (' +
                    prices.source + '): ' + url);
                return fetch(url, { credentials: 'include'}).then(function (r) { return r.text(); }).then(function (body) {
                    job.pending = null;
                    // The reply was previously thrown away, so a refusal looked exactly like a
                    // success. Read it: a refused create costs nothing, but silently treating it
                    // as sent is how a job reaches ⑦ with nothing to verify.
                    if (/too\s+low|not enough|insufficient|cannot afford|denied|invalid|error|failed/i.test(body || '')) {
                        am4RbTransient(job,'the game refused to create the route');
                        return;
                    }
                    am4RbSetState(job,'verifying','route request sent for ' + job.newDestIcao,
                        'confirming with the game that the aircraft is really routed');
                }).catch(function (e) { job.pending = null; am4RbTransient(job,'route creation failed: ' + e); });
            });
        }).catch(function (e) { am4RbTransient(job,'routing step failed: ' + e); });
    }

    // ---- ⑦ prove it server-side rather than assuming the request worked ----
    //
    // The proof is that the aircraft's LIVE route id changed. The old test - "it is no longer
    // in the Parked|Grounded list" - proves nothing: a rebuilt aircraft reports "Maintenance"
    // and is absent from that list whether or not a route was ever created, so any job that
    // reached this step passed instantly and reported success it had not earned. A changed
    // route id can only happen if the game really created the new route.
    case'verifying' : {
        return am4RbFetchGroundRouteId(job.aircraftId).then(function (liveRouteId) {
            if (!liveRouteId) { am4RbTransient(job,'could not read the aircraft\'s route id to confirm the new route'); return; }
            if (job.groundRouteId && String(liveRouteId) === String(job.groundRouteId)) {
                am4RbTransient(job,'the aircraft is still on its old route - the game did not accept the new one');
                return;
            }
            job.newRouteId = String(liveRouteId);
            job.grounded = false; // the new route replaced the grounded old one
            am4RbBreaker.consecutiveFatal = 0; // a success clears the systemic-failure counter
            return am4RbFleetRow(job.aircraftId).then(function (row) {
                am4RbSetState(job,'done',
                    'rebuilt: now flying ' + job.hubIcao + ' → ' + job.newDestIcao +
                    (job.newDistKm ? (' (' + Number(job.newDistKm).toLocaleString() + ' km)') : '') +
                    ' on Strategy ' + job.toStrategy + ' — ' + job.toStrategy + ' flights per 24 h' +
                    (row ? (', the game lists it as "' + row.status + '"') : ''),
                    (row && /Routed/i.test(row.status))
                        ?'Auto-Depart will fly it; nothing else to do' 
                        : 'it still has a maintenance event booked, which clears on its own — then Auto-Depart flies it');
            });
        }).catch(function (e) { am4RbTransient(job,'verification failed: ' + e); });
    }

    // ---- ↩ rollback: never leave an aircraft grounded because a later step failed ----
    case'rolling_back' : {
        if (!job.grounded) {
            am4RbSetState(job,'needs_attention', (job.lastError && job.lastError.message) || 'stopped',
                'the aircraft was never grounded, so it is untouched');
            return Promise.resolve();
        }
        return am4RbFetchGroundRouteId(job.aircraftId).then(function (routeId) {
            if (!routeId) { am4RbTransient(job,'could not read the route id to restore the aircraft'); return; }
            return am4FleetGround(routeId).then(function () {
                return am4RbListGrounded().then(function (g) {
                    var stillGrounded = g.filter(function (x) { return x.planeId === job.aircraftId; }).length > 0;
                    if (stillGrounded) { am4RbTransient(job,'the aircraft is still grounded after the restore attempt'); return; }
                    job.grounded = false;
                    // A rollback caused by the Auto-Depart race needs no human judgement: the
                    // aircraft is healthy, it simply has to finish the leg it was launched on.
                    // Sending it back to the waiting queue means it is picked up automatically
                    // on its next return instead of sitting in"needs attention" until noticed.
                    if (job.lastError && job.lastError.cls === 'race') {
                        job.attempts = 0; job.nextTryAt = 0; job.etaAt = 0;
                        am4RbSetState(job,'awaiting_base',
                            'restored: ' + job.reg + ' is back on its old route and finishes the flight it was launched on',
                            'it will be rebuilt automatically the next time it reaches ' + job.hubIcao);
                        return;
                    }
                    am4RbSetState(job,'needs_attention',
                        (job.lastError && job.lastError.message) || 'stopped',
                        'restored: the aircraft is back on its old route and earning again. Retry or Skip when you want.');
                });
            });
        }).catch(function (e) { am4RbTransient(job,'restore failed: ' + e); });
    }

    }
    return Promise.resolve();
}

// Ground, with a write-ahead record so a crash mid-call is recoverable, and a server-side
// confirmation so we never merely assume it worked.
function am4RbDoGround(job) {
    job.pending = { action: 'ground', at: Date.now(), routeId: job.groundRouteId };
    am4RbSetState(job,'grounding','confirmed at base — taking it off its old route now','grounding');
    return am4FleetGround(job.groundRouteId).then(function (body) {
        if (/too\s+low|denied|invalid|error|failed/i.test(body || '')) {
            job.pending = null;
            am4RbFatal(job,'the game refused to ground the aircraft');
            return;
        }
        return am4RbListGrounded().then(function (g) {
            job.pending = null;
            var isGrounded = g.filter(function (x) { return x.planeId === job.aircraftId; }).length > 0;
            if (!isGrounded) {
                am4RbTransient(job,'the ground request went through but the aircraft is not showing as grounded yet');
                return;
            }
            job.grounded = true;
            job.pendingSince = Date.now();
            am4RbSetState(job,'configuring','grounded at ' + job.hubIcao + ' and off its old route',
                'setting seats for Strategy ' + job.toStrategy + ' and making sure CO₂/Speed/Fuel are installed');
        });
    }).catch(function (e) { job.pending = null; am4RbTransient(job,'grounding failed: ' + e); });
}

// ── L3: startup reconciliation ──────────────────────────────────────────────────
// The dangerous window is"mutation sent, state not yet saved" . Every mutation writes a
// job.pending record first, so on load we can ask the game what actually happened instead
// of guessing - which is what makes a browser restart mid-rebuild survivable.
function am4RbReconcile() {
    var pendingJobs = am4RbQueue.filter(function (j) { return j.pending && AM4_RB_ACTIVE.indexOf(j.state) !== -1; });
    if (!pendingJobs.length) return Promise.resolve({ checked: 0, fixed: 0 });
    console.log('[AM4 Bot Log] Strategy Rebuild: reconciling ' + pendingJobs.length + ' interrupted job(s) against the game.');
    var fixed = 0;
    return pendingJobs.reduce(function (chain, job) {
        return chain.then(function () {
            var action = job.pending && job.pending.action;
            if (action === 'ground') {
                return am4RbListGrounded().then(function (g) {
                    job.pending = null;
                    if (g.filter(function (x) { return x.planeId === job.aircraftId; }).length) {
                        job.grounded = true; fixed++;
                        am4RbSetState(job,'configuring','recovered after a restart: the aircraft was already grounded',
                            'continuing with the configuration');
                    } else {
                        fixed++;
                        am4RbSetState(job,'awaiting_base','recovered after a restart: the ground never took effect',
                            'waiting for the aircraft to be at its base again');
                    }
                });
            }
            if (action === 'modify') {
                return am4FleetFetchModifyInfo(job.aircraftId).then(function (info) {
                    job.pending = null; fixed++;
                    if (info && info.looksValid && info.mod1on && info.mod2on && info.mod3on) {
                        am4RbSetState(job,'routing','recovered after a restart: the modification had completed',
                            'creating the route to ' + job.newDestIcao);
                    } else {
                        am4RbSetState(job,'awaiting_config','recovered after a restart: the modification is still running',
                            'waiting for the modification timer');
                    }
                });
            }
            if (action === 'route') {
                // Same reasoning as step ⑦: absence from the Parked|Grounded list is not
                // evidence of anything for a rebuilt aircraft. Ask for the live route id.
                return am4RbFetchGroundRouteId(job.aircraftId).then(function (liveRouteId) {
                    job.pending = null; fixed++;
                    if (liveRouteId && job.groundRouteId && String(liveRouteId) === String(job.groundRouteId)) {
                        am4RbSetState(job,'routing','recovered after a restart: the route was not created',
                            'creating the route to ' + job.newDestIcao);
                    } else {
                        am4RbSetState(job,'verifying','recovered after a restart: the route request may have gone through',
                            'confirming with the game');
                    }
                });
            }
            job.pending = null;
            return Promise.resolve();
        }).catch(function () { job.pending = null; return Promise.resolve(); });
    }, Promise.resolve()).then(function () {
        am4RbSaveQueue(); am4RbRenderQueue();
        return { checked: pendingJobs.length, fixed: fixed };
    });
}

// ── L3: enqueue ─────────────────────────────────────────────────────────────────
function am4RbEnqueuePair(pair) {
    var p = pair.plane;
    var job = {
        id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        at: Date.now(), updatedAt: Date.now(),
        aircraftId: String(p.aircraftId), reg: String(p.reg),
        hubId: String(p.hubId), hubIcao: p.hubIcao,
        oldDestIcao: p.curDestIcao, oldDistKm: p.curDist,
        fromStrategy: pair.fromStrategy, toStrategy: pair.toStrategy,
        newDestId: String(pair.dest.arrId), newDestIcao: pair.destIcao,
        newDistKm: pair.dest.km, newReg: null,
        seats: pair.seats,
        state: 'queued', what: AM4_RB_STEP_LABEL.queued,
        why: 'queued for a Strategy ' + pair.fromStrategy + ' → ' + pair.toStrategy + ' rebuild',
        next: 'pre-flight checks',
        attempts: 0, nextTryAt: 0, pending: null, grounded: false, errorHistory: []
    };
    job.newReg = am4RbUniqueName(pair.destIcao);
    am4RbQueue.push(job);
    return job;
}
function am4RbAlreadyQueued(aircraftId) {
    return am4RbQueue.some(function (j) {
        return j.aircraftId === String(aircraftId) && AM4_RB_ACTIVE.concat(['needs_attention']).indexOf(j.state) !== -1;
    });
}

// ── L4: orchestrator ────────────────────────────────────────────────────────────
function am4RbJobReady(job) {
    if (AM4_RB_ACTIVE.indexOf(job.state) === -1) return false;
    if (job.nextTryAt && Date.now() < job.nextTryAt) return false;
    if (job.state === 'awaiting_base') {
        // The game tells us exactly when the aircraft lands, so wait for that instead of asking
        // 180 times over three hours. The small margin covers clock skew on the countdown.
        if (job.etaAt && Date.now() < (job.etaAt + 20000)) return false;
        return (Date.now() - (job.updatedAt || 0)) >= AM4_RB_BASE_POLL_MS;
    }
    if (job.state === 'awaiting_config') return (Date.now() - (job.updatedAt || 0)) >= AM4_RB_CONFIG_POLL_MS;
    return true;
}
function am4RbActionable(state) { return AM4_RB_ACTIONABLE.indexOf(state) !== -1; }

// DUE = an aircraft whose arrival countdown has already run out, so it is probably standing
// at its hub right now waiting only for us to look at it.
//
// Measured live 2026-08-16, and it is why aircraft kept getting sent back out: with 52 jobs
// waiting and the scheduler taking ONE per heartbeat, a full sweep took up to an hour, so a
// landed aircraft sat unlooked-at for a median of 32 minutes (worst case 70). Auto-Depart
// runs every 15 minutes - it was not winning because it is fast, it was winning because we
// were slow. Due jobs therefore get the same priority as actionable work.
//
// This cannot hot-loop: am4RbJobReady already refuses an awaiting_base job within
// AM4_RB_BASE_POLL_MS of its last look, so each aircraft is polled at most once a minute no
// matter how often the drain comes round.
function am4RbDue(job) {
    if (job.state !== 'awaiting_base') return false;
    if (job.etaAt && Date.now() < (job.etaAt + 20000)) return false;
    return am4RbJobReady(job);
}
function am4RbUrgent(job) { return am4RbActionable(job.state) || am4RbDue(job); }

function am4RbRunStep(job, label) {
    if (am4RbBusy) return false;
    am4RbBusy = true;
    var before = job.state, released = false;
    var release = function () { if (!released) { released = true; am4RbBusy = false; } };
    var safety = setTimeout(release, 45000); // a fetch has no timeout - never freeze the queue
    Promise.resolve().then(function () { return am4RbAdvance(job); })
        .catch(function (e) { try { am4RbTransient(job, (label || 'step') + ' error: ' + e); } catch (x) { /* ignore */ } })
        .then(function () {
            clearTimeout(safety); release(); am4RbRenderQueue();
            if (!am4RbAutoRun() || am4RbBreaker.trippedAt) return;
            // v1.30 lesson: a progress-gated fast lane starves behind a run of polls that
            // legitimately make no progress, so actionable work gets its own preference.
            var progressed = (job.state !== before);
            var wasActionable = am4RbActionable(before);
            // Keep draining while ANY urgent work waits - actionable steps, or aircraft whose
            // arrival countdown has run out. Before this, a run of"still flying" polls ended
            // the cascade and the rest of the batch fell back to one look per heartbeat.
            var urgentWaiting = am4RbQueue.some(am4RbUrgent);
            var wasUrgent = wasActionable || (before === 'awaiting_base');
            var fast = (progressed && am4RbQueue.some(am4RbJobReady)) || (!progressed && !wasActionable && urgentWaiting);
            if (!fast && wasUrgent && urgentWaiting) fast = true;
            if (fast) setTimeout(function () { am4RbTick(true); }, am4Jitter(AM4_RB_DRAIN_MS));
        });
    return true;
}

function am4RbTick(preferActionable) {
    am4RbPruneDone();
    am4RbRenderQueue();
    if (am4RbBusy || !am4RbAutoRun() || am4RbBreaker.trippedAt) return;
    if (typeof am4SuiteResearchBusy === 'function' && am4SuiteResearchBusy()) return;
    var ready = am4RbQueue.filter(am4RbJobReady);
    if (!ready.length) return;
    var pool = ready;
    if (preferActionable) {
        // Urgent = a step that will do something, or an aircraft that should already be home.
        // Both are work the batch is waiting on; a"still flying" poll is not.
        var act = ready.filter(am4RbUrgent);
        if (act.length) pool = act;
    }
    // v1.29 lesson: key the round-robin cursor on the STABLE full-queue position. Keyed on
    // the ready list it degenerates to front-only, because a job that just progressed leaves
    // that list and indexOf returns -1.
    var lastIdx = -1;
    if (am4RbLastId) {
        for (var i = 0; i < am4RbQueue.length; i++) { if (am4RbQueue[i].id === am4RbLastId) { lastIdx = i; break; } }
    }
    var job = null;
    for (var k = 0; k < pool.length; k++) { if (am4RbQueue.indexOf(pool[k]) > lastIdx) { job = pool[k]; break; } }
    if (!job) job = pool[0];
    am4RbLastId = job.id;
    am4RbRunStep(job,'tick');
}

function am4RbForceStep(id) {
    var job = am4RbQueue.filter(function (j) { return j.id === id; })[0];
    if (!job || AM4_RB_ACTIVE.indexOf(job.state) === -1) return;
    job.nextTryAt = 0; // a manual push skips the backoff, not the gates
    if (!am4RbRunStep(job,'manual')) am4RbSay(job, null, null,'another step is running - try again in a moment');
}
function am4RbRetry(id) {
    var job = am4RbQueue.filter(function (j) { return j.id === id; })[0];
    if (!job || job.state !== 'needs_attention') return;
    job.attempts = 0; job.nextTryAt = 0; job.pending = null;
    am4RbBreaker.consecutiveFatal = 0;
    am4RbSetState(job,'validating','re-queued by you','re-running the pre-flight checks');
}
function am4RbSkip(id) {
    var job = am4RbQueue.filter(function (j) { return j.id === id; })[0];
    if (!job) return;
    am4RbSetState(job,'cancelled','skipped by you',
        job.grounded ?'NOTE: this aircraft is still grounded — use Recovery to put it back on its route' : '');
}
function am4RbStartScheduler() {
    if (am4RbTimer) return;
    am4RbTimer = setInterval(function () { am4RbTick(); }, AM4_RB_TICK_MS);
    // Chrome freezes a backgrounded tab's timers; these catch-ups make the queue flow again
    // the moment the tab is looked at, and the silent-audio keepalive covers the rest.
    try { document.addEventListener('visibilitychange', function () { if (!document.hidden) am4RbTick(); }); } catch (e) { /* ignore */ }
    try { window.addEventListener('focus', function () { am4RbTick(); }); } catch (e) { /* ignore */ }
    if (am4RbAutoRun() && typeof am4BuildKeepAlive === 'function') am4BuildKeepAlive(true);
    // Wired unconditionally, not only when Auto-run happens to be on at load: the heartbeat
    // is what re-arms the background clock after a reload, and it must be listening for the
    // first interaction whether or not the queue is running yet.
    am4WireHeartbeat();
    setTimeout(function () { am4RbReconcile(); }, am4Jitter(6000));
}

// ── Recovery: un-ground aircraft stranded by older versions ─────────────────────
// fleet_ground.php is a TOGGLE, so calling it on a grounded aircraft puts it back on its
// existing route, where Auto-Depart flies it and it earns again. Fail-closed: prove it on
// the FIRST aircraft before touching any of the others.
var am4RbRecoverBusy = false;
function am4RbRecoverMsg(m, c) {
    var el = document.getElementById('am4RbRecoverMsg');
    if (el) { el.innerText = m; el.style.color = c || '#22d3ee'; }
}
function am4RbRecoverGrounded() {
    if (am4RbRecoverBusy) { am4RbRecoverMsg('already running…','#f59e0b'); return; }
    var gate = am4BuildCanSpend(0);
    if (gate) { am4RbRecoverMsg('waiting: ' + gate,'#f59e0b'); return; }
    am4RbRecoverBusy = true;
    am4RbRecoverMsg('reading grounded ' + am4AircraftName() + 's…');
    var done = 0, failed = 0, total = 0, provenOnce = false;
    am4RbListGrounded().then(function (list) {
        total = list.length;
        if (!total) { am4RbRecoverBusy = false; am4RbRecoverMsg('no grounded ' + am4AircraftName() + 's ✓','#10b981'); return; }
        var i = 0;
        function finish() {
            am4RbRecoverBusy = false;
            am4RbRecoverMsg('done: ' + done + '/' + total + ' restored' + (failed ? (', ' + failed + ' failed') : '') +
                ' — make sure Auto-Depart is ON so they fly and earn', done > 0 ?'#10b981' : '#ef4444');
            if (typeof am4LogAction === 'function') am4LogAction('rebuild','🚑 Recovery: ' + done + '/' + total + ' un-grounded');
        }
        function step() {
            if (i >= list.length) { finish(); return; }
            var g = am4BuildCanSpend(0);
            if (g) { am4RbRecoverBusy = false; am4RbRecoverMsg('stopped: ' + g + ' (' + done + '/' + total + ')','#f59e0b'); return; }
            var p = list[i];
            am4RbRecoverMsg(done + '/' + total + ' — ' + (p.reg || p.planeId) + '…');
            am4RbFetchGroundRouteId(p.planeId).then(function (routeId) {
                if (!routeId) { failed++; i++; setTimeout(step, 400); return; }
                return am4FleetGround(routeId).then(function () {
                    if (!provenOnce) {
                        return am4RbListGrounded().then(function (after) {
                            var still = after.filter(function (x) { return x.planeId === p.planeId; }).length > 0;
                            if (still) {
                                am4RbRecoverBusy = false;
                                am4RbRecoverMsg('STOPPED: the first aircraft (' + (p.reg || p.planeId) +
                                    ') stayed grounded, so the toggle did not behave as expected. Nothing else was touched.','#ef4444');
                                return;
                            }
                            provenOnce = true; done++; i++; setTimeout(step, 600);
                        });
                    }
                    done++; i++; setTimeout(step, 500);
                });
            }).catch(function () { failed++; i++; setTimeout(step, 500); });
        }
        step();
    }).catch(function (e) { am4RbRecoverBusy = false; am4RbRecoverMsg('failed: ' + e,'#ef4444'); });
}

//================================================================================
// L5: USER INTERFACE
//================================================================================
var am4RbSel = { from: 2, to: 3, hubs: {}, forceHubs: {}, hubList: [], plan: null, scanning: false, userPicked: false, typeId: 0 };
var am4RbSilentSelect = false;
// Which job rows have their history expanded (view state only, not persisted).
var am4RbOpenDetails = {};

function am4RbInjectButton() {
    var bar = document.getElementById('am4ControlBar');
    if (!bar || document.getElementById('am4RbBtn')) return;
    if (typeof am4ExpInjectStyles === 'function') am4ExpInjectStyles();
    var btn = document.createElement('span');
    btn.id = 'am4RbBtn';
    btn.title = 'Strategy Rebuild — move existing aircraft between flight-frequency strategies';
    btn.style.cssText = 'cursor:pointer; color:#a78bfa; font-size:13px; line-height:1; padding:2px 6px; border-radius:4px; user-select:none; font-family:monospace; white-space:nowrap;';
    btn.innerText = '🔄 Rebuild';
    // Always left of ⚙ Settings (and therefore left of the version tag).
    var gear = document.getElementById('am4SettingsBtn');
    if (gear && gear.parentElement === bar) bar.insertBefore(btn, gear);
    else bar.appendChild(btn);
    btn.addEventListener('mouseenter', function () { btn.style.background = 'rgba(167,139,250,0.15)'; });
    btn.addEventListener('mouseleave', function () { btn.style.background = ''; });
    btn.addEventListener('click', am4RbTogglePanel);
    am4RbUpdateButtonBadge();
}
function am4RbUpdateButtonBadge() {
    var btn = document.getElementById('am4RbBtn');
    if (!btn) return;
    var active = am4RbQueue.filter(function (j) { return AM4_RB_ACTIVE.indexOf(j.state) !== -1; }).length;
    var bad = am4RbQueue.filter(function (j) { return j.state === 'needs_attention'; }).length;
    btn.innerText = '🔄 Rebuild' + (active ? (' ' + active) : '') + (bad ? (' ⚠' + bad) : '');
    btn.style.color = bad ?'#ef4444' : '#a78bfa';
}
function am4RbTogglePanel() {
    var p = document.getElementById('am4RbPanel');
    if (p && p.style.display === 'block') { p.style.display = 'none'; return; }
    am4RbBuildPanel().style.display = 'block';
    am4RbRefreshStrategyInfo();
    am4RbRenderQueue();
}

function am4RbBandText(n) {
    var b = am4RbBand(n);
    if (!b.possible) {
        return 'Strategy ' + n + ' · ' + n + ' flights/24 h · beyond range (needs ' +
            Number(b.lo).toLocaleString() + '+ km)';
    }
    return 'Strategy ' + n + ' · ' + n + ' flights/24 h · ' +
           Number(b.lo).toLocaleString() + '–' + Number(b.hi).toLocaleString() + ' km';
}

function am4RbBuildPanel() {
    var old = document.getElementById('am4RbPanel');
    if (old) return old;
    var panel = document.createElement('div');
    panel.id = 'am4RbPanel';
    panel.style.cssText = 'position:fixed; top:60px; right:20px; width:min(520px, calc(100vw - 24px)); max-height:86vh; overflow-y:auto; background:rgba(15,19,26,0.98); border:1px solid #34495e; border-radius:8px; color:#e2e8f0; font-family:monospace; font-size:12px; z-index:1041; padding:14px; box-shadow:0 6px 24px rgba(0,0,0,0.6); display:none;';
    var opts = function (sel) {
        return am4StratOptionNs().map(function (n) {
            return"<option value='" + n +"'" + (n === sel ? " selected" : "") +">Strategy " + n +" (" + n +" flights/24 h)</option>" ;
        }).join('');
    };
    panel.innerHTML =
        "<div style='display:flex; margin-bottom:6px;'><span style='flex-grow:1; font-size:13px; font-weight:bold; color:#a78bfa; letter-spacing:1px;'>🔄 STRATEGY REBUILD</span>" +
        "<span id='am4RbFleetRefresh' title='Re-read every routed aircraft of the selected type from the game. The numbers below otherwise come from the page as it was when it loaded, and a rebuild does not change them.' " +
        "style='cursor:pointer; color:#38bdf8; padding:0 6px;'>⟳</span>" +
        "<span id='am4RbClose' style='cursor:pointer; color:#ef4444; font-weight:bold; padding:0 4px;'>[X]</span></div>" +

        "<div id='am4RbBreakerBox' style='display:none; margin:6px 0; padding:6px; border-radius:5px; background:rgba(239,68,68,0.12); border:1px solid #ef4444; font-size:10px; color:#fca5a5;'></div>" +

        "<div class='am4-exp-sec' style='border-top:1px dashed #334155; padding-top:7px; font-weight:bold; color:#38bdf8; font-size:11px;'>① STRATEGY</div>" +
        "<div style='display:flex; align-items:center; gap:6px; margin:6px 0;'>" +
        "<label style='color:#94a3b8;'>From</label><select id='am4RbFrom' style='flex:1; background:#1e293b; border:1px solid #475569; color:#e2e8f0; border-radius:4px; padding:2px 5px; font-family:monospace; font-size:12px;'>" + opts(2) +"</select>" +
        "<span style='color:#a78bfa; font-weight:bold;'>→</span>" +
        "<label style='color:#94a3b8;'>To</label><select id='am4RbTo' style='flex:1; background:#1e293b; border:1px solid #475569; color:#e2e8f0; border-radius:4px; padding:2px 5px; font-family:monospace; font-size:12px;'>" + opts(3) +"</select>" +
        "<span id='am4RbSwap' title='Swap From and To' style='cursor:pointer; color:#38bdf8; padding:0 4px;'>⇄</span>" +
        "</div>" +
        "<div id='am4RbStrategyInfo' style='font-size:10px; color:#94a3b8; line-height:1.5;'>reading your fleet…</div>" +

        "<div class='am4-exp-sec' style='border-top:1px dashed #334155; margin-top:9px; padding-top:7px; font-weight:bold; color:#38bdf8; font-size:11px;'>② HUBS</div>" +
        "<div style='display:flex; gap:6px; align-items:center; margin:5px 0;'>" +
        "<input id='am4RbHubSearch' placeholder='search hub…' style='flex:1; background:#1e293b; border:1px solid #475569; color:#e2e8f0; border-radius:4px; padding:2px 5px; font-family:monospace; font-size:11px;'>" +
        "<span id='am4RbSelectAll' style='cursor:pointer; color:#38bdf8; font-size:10px;'>select all</span>" +
        "<span id='am4RbSelectNone' style='cursor:pointer; color:#38bdf8; font-size:10px;'>none</span>" +
        "<span id='am4RbHubCount' style='color:#94a3b8; font-size:10px; white-space:nowrap;'>0 of 0</span>" +
        "</div>" +
        "<div id='am4RbHubList' style='max-height:150px; overflow-y:auto; border:1px solid #1e293b; border-radius:4px; padding:4px;'>loading…</div>" +

        "<div class='am4-exp-sec' style='border-top:1px dashed #334155; margin-top:9px; padding-top:7px; font-weight:bold; color:#38bdf8; font-size:11px;'>③ ANALYSE</div>" +
        "<div style='display:flex; gap:8px; margin-top:6px; align-items:center;'>" +
        "<button id='am4RbAnalyse' style='cursor:pointer; border:none; border-radius:5px; padding:6px 12px; font-family:monospace; font-size:12px; font-weight:bold; background:#4c1d95; color:#ede9fe;'>Analyse selection</button>" +
        "<button id='am4RbCancelScan' style='display:none; cursor:pointer; border:none; border-radius:5px; padding:6px 10px; font-family:monospace; font-size:11px; background:#334155; color:#cbd5e1;'>Cancel</button>" +
        "<span id='am4RbAnalyseMsg' style='font-size:10px; color:#a78bfa; flex-grow:1; word-break:break-word;'></span></div>" +

        "<div id='am4RbReview' style='margin-top:8px;'></div>" +

        "<div class='am4-exp-sec' style='border-top:1px dashed #334155; margin-top:10px; padding-top:7px; font-weight:bold; color:#38bdf8; font-size:11px;'>⑤ QUEUE</div>" +
        "<div style='display:flex; align-items:center; gap:8px; margin:6px 0;'>" +
        "<label style='cursor:pointer; color:#e2e8f0; font-weight:bold;'><input type='checkbox' id='am4RbAutoRunBox'> ▶ Auto-run (spends money)</label>" +
        "<span style='flex-grow:1;'></span>" +
        "<span id='am4RbPulse' style='font-size:9px; margin-right:8px;'></span>" +
        "<button id='am4RbClearDone' title='Remove finished aircraft from the list now (they leave on their own after 10 minutes)' " +
        "style='cursor:pointer; border:none; border-radius:5px; padding:3px 9px; font-family:monospace; font-size:10px; background:#334155; color:#cbd5e1;'>clear finished</button></div>" +
        "<div id='am4RbTally' style='font-size:10px; color:#94a3b8; margin:2px 0 6px 0;'></div>" +
        "<div id='am4RbQueueBody'></div>" +

        "<div class='am4-exp-sec' style='border-top:1px dashed #334155; margin-top:10px; padding-top:7px; font-weight:bold; color:#22d3ee; font-size:11px;'>🚑 RECOVERY</div>" +
        "<div style='font-size:9px; color:#64748b; margin:3px 0;'>Puts grounded aircraft of the selected type back on their existing route (the ground link is a toggle), so they fly and earn again. Checks the first aircraft before touching the rest.</div>" +
        "<div style='display:flex; gap:8px; margin-top:6px; align-items:center;'>" +
        "<button id='am4RbRecoverBtn' style='cursor:pointer; border:none; border-radius:5px; padding:6px 12px; font-family:monospace; font-size:12px; font-weight:bold; background:#0e7490; color:#cffafe;'>Restore grounded aircraft</button>" +
        "<span id='am4RbRecoverMsg' style='font-size:10px; color:#22d3ee; flex-grow:1; word-break:break-word;'></span></div>";

    document.body.appendChild(panel);

    document.getElementById('am4RbClose').addEventListener('click', function () { panel.style.display = 'none'; });
    var fromSel = document.getElementById('am4RbFrom'), toSel = document.getElementById('am4RbTo');
    fromSel.value = String(am4RbSel.from); toSel.value = String(am4RbSel.to);
    fromSel.addEventListener('change', function () {
        if (am4RbSilentSelect) { am4RbSel.from = +fromSel.value; return; }
        am4RbSel.userPicked = true; am4RbSel.from = +fromSel.value; am4RbOnStrategyChange();
    });
    toSel.addEventListener('change', function () {
        if (am4RbSilentSelect) { am4RbSel.to = +toSel.value; return; }
        am4RbSel.userPicked = true; am4RbSel.to = +toSel.value; am4RbOnStrategyChange();
    });
    document.getElementById('am4RbSwap').addEventListener('click', function () {
        am4RbSel.userPicked = true;
        var f = am4RbSel.from; am4RbSel.from = am4RbSel.to; am4RbSel.to = f;
        fromSel.value = String(am4RbSel.from); toSel.value = String(am4RbSel.to);
        am4RbOnStrategyChange();
    });
    document.getElementById('am4RbHubSearch').addEventListener('input', am4RbRenderHubList);
    document.getElementById('am4RbSelectAll').addEventListener('click', function () {
        am4RbVisibleHubs().forEach(function (h) { am4RbSel.hubs[h.hubId] = true; });
        am4RbRenderHubList();
    });
    document.getElementById('am4RbSelectNone').addEventListener('click', function () {
        am4RbSel.hubs = {}; am4RbRenderHubList();
    });
    document.getElementById('am4RbAnalyse').addEventListener('click', am4RbOnAnalyse);
    document.getElementById('am4RbCancelScan').addEventListener('click', function () {
        am4RbCancelScan(); am4RbSel.scanning = false;
        am4RbAnalyseMsg('cancelled','#f59e0b');
        document.getElementById('am4RbCancelScan').style.display = 'none';
    });
    var ar = document.getElementById('am4RbAutoRunBox');
    ar.checked = am4RbAutoRun();
    ar.addEventListener('change', function () {
        if (ar.checked && am4RbBreaker.trippedAt) am4RbResetBreaker();
        am4RbSetAutoRun(ar.checked);
        if (ar.checked) am4RbTick();
    });
    document.getElementById('am4RbClearDone').addEventListener('click', function () {
        am4RbQueue = am4RbQueue.filter(function (j) {
            return AM4_RB_ACTIVE.indexOf(j.state) !== -1 || j.state === 'needs_attention';
        });
        am4RbSaveQueue(); am4RbRenderQueue();
    });
    document.getElementById('am4RbRecoverBtn').addEventListener('click', am4RbRecoverGrounded);
    document.getElementById('am4RbFleetRefresh').addEventListener('click', am4RbOnFleetRefresh);

    if (typeof am4PanelChrome === 'function') am4PanelChrome(panel,'rebuild');
    am4RbRefreshStrategyInfo();
    return panel;
}

function am4RbAnalyseMsg(m, c) {
    var el = document.getElementById('am4RbAnalyseMsg');
    if (el) { el.innerText = m; el.style.color = c || '#a78bfa'; }
}

function am4RbFillNSelects() {
    var fromSel = document.getElementById('am4RbFrom');
    var toSel = document.getElementById('am4RbTo');
    if (!fromSel || !toSel) return;
    var set = {};
    (typeof am4StratOptionNs === 'function' ? am4StratOptionNs() : [2, 3, 4]).forEach(function (n) { set[n] = true; });
    set[am4RbSel.from] = true;
    set[am4RbSel.to] = true;
    var ns = Object.keys(set).map(function (k) { return parseInt(k, 10); }).sort(function (a, b) { return a - b; });
    var html = function (sel) {
        return ns.map(function (n) {
            var band = am4RbBand(n);
            var extra = band.possible ? '' : ' — beyond range';
            return"<option value='" + n +"'" + (n === sel ? " selected" : "") +">Strategy " + n +" (" + n +" flights/24 h" + extra +")</option>" ;
        }).join('');
    };
    fromSel.innerHTML = html(am4RbSel.from);
    toSel.innerHTML = html(am4RbSel.to);
    am4RbSilentSelect = true;
    fromSel.value = String(am4RbSel.from);
    toSel.value = String(am4RbSel.to);
    am4RbSilentSelect = false;
}

function am4RbOnAircraftTypeChanged() {
    am4RbFleetCache = null;
    am4RbFleetSource = 'snapshot';
    am4RbSel.plan = null;
    am4RbSel.hubList = [];
    am4RbSel.hubs = {};
    am4RbSel.forceHubs = {};
    am4RbSel.userPicked = false;
    var rv = document.getElementById('am4RbReview');
    if (rv) rv.innerHTML = '';
    am4RbAnalyseMsg('');
    var panel = document.getElementById('am4RbPanel');
    if (panel && panel.style.display === 'block') {
        am4RbRefreshStrategyInfo();
    }
}

function am4RbAlignSelToFleet(counts) {
    if (typeof am4StratEnsurePossibleN === 'function') am4StratEnsurePossibleN();
    var tid = (typeof am4AircraftTypeId === 'function') ? am4AircraftTypeId() : 0;
    if (am4RbSel.typeId !== tid) {
        am4RbSel.typeId = tid;
        am4RbSel.userPicked = false;
        am4RbSel.plan = null;
        am4RbSel.hubList = [];
        am4RbSel.hubs = {};
        am4RbSel.forceHubs = {};
        am4RbFleetCache = null;
        am4RbFleetSource = 'snapshot';
    }
    var longest = (typeof am4StratLongestN === 'function') ? am4StratLongestN() : 2;
    var wantTo = longest;
    if (typeof am4StratLoadCfg === 'function') {
        var sn = am4StratClampN(am4StratLoadCfg().n);
        if (am4RbBand(sn).possible) wantTo = sn;
    }
    if (!am4RbSel.userPicked) {
        am4RbSel.to = wantTo;
        var fromCount = counts[am4RbSel.from] || 0;
        if (!fromCount || am4RbSel.from === am4RbSel.to) {
            var bestN = 0, bestC = 0;
            Object.keys(counts).forEach(function (k) {
                if (!/^\d+$/.test(k) || !counts[k]) return;
                var n = parseInt(k, 10);
                if (n === am4RbSel.to) return;
                if (counts[k] > bestC) { bestC = counts[k]; bestN = n; }
            });
            if (bestN) am4RbSel.from = bestN;
        }
    }
}

function am4RbRefreshStrategyInfo() {
    var el = document.getElementById('am4RbStrategyInfo');
    if (!el) return;
    am4RbStrategyCounts(false).then(function (c) {
        var prevFrom = am4RbSel.from;
        var prevType = am4RbSel.typeId;
        am4RbAlignSelToFleet(c);
        am4RbFillNSelects();
        var warn = (am4RbSel.from === am4RbSel.to)
            ? "<div style='color:#f59e0b;'>Pick two different strategies — From and To are the same.</div>" : '';
        var toBand = am4RbBand(am4RbSel.to);
        if (!toBand.possible) {
            warn +="<div style='color:#ef4444;'>Strategy " + am4RbSel.to +" is beyond this type's range. Pick the max-range N as To.</div>" ;
        }
        el.innerHTML =
            "<div style='color:#64748b; margin-bottom:4px;'>Aircraft: <b style='color:#e2e8f0;'>" +
            am4RbEsc((typeof am4AircraftName === 'function') ? am4AircraftName() : 'unknown') +
            "</b> — change in 🔎 Explorer, then ⟳ here.</div>" +
            "<div>" + am4RbEsc(am4RbBandText(am4RbSel.from)) +" — <b style='color:#e2e8f0;'>" + (c[am4RbSel.from] || 0) +" aircraft</b> on this strategy now</div>" +
            "<div>" + am4RbEsc(am4RbBandText(am4RbSel.to)) +" — target</div>" +
            "<div style='color:#64748b;'>Fleet: " + (function () {
                var ns = [];
                Object.keys(c).forEach(function (k) {
                    if (/^\d+$/.test(k) && c[k]) ns.push(parseInt(k, 10));
                });
                ns.sort(function (a, b) { return a - b; });
                return ns.length ? ns.map(function (n) { return 'S' + n + ' ' + c[n]; }).join(' · ') : 'none in band';
            })() +
            (c.other ? (" · outside the bands " + c.other) : "") + (c.unresolved ? (" · " + c.unresolved +" unresolved") : "") +
            (c.uncertain ? (" · " + c.uncertain +" with an unclear home hub (left out)") : "") +"</div>" +
            (c.bothEndsAreHubs ? ("<div style='color:#64748b;'>" + c.bothEndsAreHubs +
                " aircraft fly between two of your own hubs; home is taken from the route's own direction.</div>") : "") +
            am4RbFleetProvenance() +
            "<div style='color:#64748b;'>Rebuild fill bar: ≥" + AM4_RB_GOOD_FILL_PCT +
            "% (Explorer may be stricter). The +10% Speed modification is required for these distance bands and will be installed during the rebuild.</div>" +
            warn;
        if (prevFrom !== am4RbSel.from || prevType !== am4RbSel.typeId || !am4RbSel.hubList.length) {
            am4RbHubsForStrategy(am4RbSel.from, false).then(function (hubs) {
                am4RbSel.hubList = hubs;
                if (!am4RbSel.userPicked) { am4RbSel.hubs = {}; am4RbSel.forceHubs = {}; }
                am4RbRenderHubList();
            }).catch(function (e) {
                var list = document.getElementById('am4RbHubList');
                if (list) list.innerText = 'could not read the fleet: ' + e;
            });
        }
    }).catch(function (e) { el.innerText = 'could not read the fleet: ' + e; });
}

// Says WHERE these numbers come from. Without it the panel looks equally confident whether
// it is describing the fleet as it is now or as it was when the page loaded - and after a
// batch of rebuilds those are very different things.
function am4RbFleetProvenance() {
    if (am4RbFleetSource === 'live') {
        return"<div style='color:#10b981;'>Read from the game " +
            am4RbHuman(Date.now() - am4RbFleetReadAt) +" ago.</div>" ;
    }
    return"<div style='color:#f59e0b;'>These numbers come from the page as it was when it " +
        "loaded, so a rebuild finished since then is not in them. Press &#10227; above to read " +
        "the fleet from the game (about one request per routed aircraft, so a couple of minutes).</div>";
}

// The ⟳ in the header. Shows real progress, because it takes minutes.
function am4RbOnFleetRefresh() {
    var el = document.getElementById('am4RbStrategyInfo');
    if (am4RbFleetLiveBusy) {
        if (el) { el.innerHTML ="<div style='color:#f59e0b;'>already reading the fleet…</div>" ; }
        return;
    }
    am4RbRefreshFleetLive(function (done, total, reg) {
        if (el) {
            el.innerHTML ="<div style='color:#38bdf8;'>reading the fleet from the game: " +
            done +" / " + total +" &middot; " + am4RbEsc(reg) +"</div>" ;
        }
    }).then(function (fa) {
        if (!fa) {
            if (el) { el.innerHTML ="<div style='color:#ef4444;'>the fleet could not be read.</div>" ; }
            return;
        }
        // Everything derived from the classification has to be rebuilt from the new one.
        am4RbSel.plan = null;
        var rv = document.getElementById('am4RbReview'); if (rv) rv.innerHTML = '';
        am4RbRefreshStrategyInfo();
        am4RbHubsForStrategy(am4RbSel.from, false).then(function (hubs) {
            am4RbSel.hubList = hubs;
            am4RbRenderHubList();
        });
        if (typeof am4LogAction === 'function') {
            am4LogAction('rebuild','🔄 Fleet re-read from the game: ' + fa.planes.length +
                ' routed ' + am4AircraftName() + 's' + (fa.unresolved ? (', ' + fa.unresolved + ' unreadable') : ''));
        }
    }).catch(function (e) {
        if (el) el.innerHTML ="<div style='color:#ef4444;'>reading the fleet failed: " + am4RbEsc(String(e)) +"</div>" ;
    });
}

function am4RbOnStrategyChange() {
    am4RbSel.plan = null;
    var rv = document.getElementById('am4RbReview'); if (rv) rv.innerHTML = '';
    am4RbAnalyseMsg('');
    am4RbRefreshStrategyInfo();
    var list = document.getElementById('am4RbHubList');
    if (list) list.innerHTML = 'reading your fleet…';
    am4RbHubsForStrategy(am4RbSel.from, false).then(function (hubs) {
        am4RbSel.hubList = hubs;
        am4RbSel.hubs = {};
        am4RbSel.forceHubs = {};
        am4RbRenderHubList();
    }).catch(function (e) {
        if (list) list.innerText = 'could not read the fleet: ' + e;
    });
}

function am4RbVisibleHubs() {
    var q = (document.getElementById('am4RbHubSearch') || {}).value || '';
    q = q.trim().toLowerCase();
    return am4RbSel.hubList.filter(function (h) {
        return !q || String(h.hubIcao).toLowerCase().indexOf(q) !== -1;
    });
}

function am4RbRenderHubList() {
    var list = document.getElementById('am4RbHubList');
    if (!list) return;
    var hubs = am4RbVisibleHubs();
    if (!am4RbSel.hubList.length) {
        list.innerHTML ="<div style='color:#64748b;'>No aircraft are on Strategy " + am4RbSel.from +
            " right now. Pick the From strategy that matches the S-numbers in ① (your fleet is classified by real route distance, not the leftover 2/3/4 labels).</div>";
    } else if (!hubs.length) {
        list.innerHTML ="<div style='color:#64748b;'>No hub matches that search.</div>" ;
    } else {
        var cache = am4RbCacheStats();
        var byKey = {}; cache.forEach(function (e) { byKey[e.hubId + ':' + e.distCap] = e; });
        var distCap = am4RbBand(am4RbSel.to).hi;
        list.innerHTML = hubs.map(function (h) {
            var c = byKey[h.hubId + ':' + distCap];
            var forced = !!am4RbSel.forceHubs[h.hubId];
            // A cached hub used to be a dead end: the badge told you the result was hours old
            // and there was no way to ask for a fresh one until the 24 h expiry. This ↻ marks
            // that hub to be swept again on the next Analyse.
            var badge = c
                ? ("<span style='color:" + (forced ?'#f59e0b' : '#10b981') +"; font-size:9px;'>" +
                   (forced ? "will rescan" :"cached &#10003; " + am4RbHuman(c.ageMs) +" old") +"</span>" +
                   "<span class='am4-rb-force' data-hub='" + am4RbEsc(h.hubId) +"' title='" +
                   (forced ? "use the cached result after all" :"ignore the cached result and scan this hub again") +
                   "' style='cursor:pointer; color:#38bdf8; font-size:10px; padding:0 3px;'>&#10227;</span>")
                :"<span style='color:#64748b; font-size:9px;'>needs a scan</span>" ;
            return"<div style='display:flex; align-items:center; gap:6px; padding:2px 0;'>" +
                "<label style='display:flex; align-items:center; gap:6px; flex-grow:1; cursor:pointer;'>" +
                "<input type='checkbox' class='am4-rb-hub' data-hub='" + am4RbEsc(h.hubId) +"'" + (am4RbSel.hubs[h.hubId] ?' checked' : '') +">" +
                "<b style='color:#cbd5e1; width:52px;'>" + am4RbEsc(h.hubIcao) +"</b>" +
                "<span style='color:#94a3b8; flex-grow:1;'>" + h.planes.length +" aircraft</span></label>" +
                badge +"</div>" ;
        }).join('');
        list.querySelectorAll('.am4-rb-hub').forEach(function (cb) {
            cb.addEventListener('change', function () {
                am4RbSel.hubs[cb.getAttribute('data-hub')] = cb.checked;
                am4RbUpdateHubCount();
            });
        });
        list.querySelectorAll('.am4-rb-force').forEach(function (el) {
            el.addEventListener('click', function (ev) {
                ev.preventDefault(); ev.stopPropagation();
                var id = el.getAttribute('data-hub');
                am4RbSel.forceHubs[id] = !am4RbSel.forceHubs[id];
                am4RbRenderHubList();
            });
        });
    }
    am4RbUpdateHubCount();
}
function am4RbSelectedHubs() {
    return am4RbSel.hubList.filter(function (h) { return am4RbSel.hubs[h.hubId]; });
}
function am4RbUpdateHubCount() {
    var el = document.getElementById('am4RbHubCount');
    if (!el) return;
    var sel = am4RbSelectedHubs();
    var planes = sel.reduce(function (a, h) { return a + h.planes.length; }, 0);
    el.innerText = sel.length + ' of ' + am4RbSel.hubList.length + (planes ? (' · ' + planes + ' a/c') : '');
}

function am4RbOnAnalyse() {
    if (am4RbSel.scanning) return;
    if (am4RbSel.from === am4RbSel.to) { am4RbAnalyseMsg('From and To must be different strategies.','#ef4444'); return; }
    if (!am4RbBand(am4RbSel.to).possible) {
        am4RbAnalyseMsg('Strategy ' + am4RbSel.to + ' is beyond this type\'s range. Set To to the max-range N.','#ef4444');
        return;
    }
    var hubs = am4RbSelectedHubs();
    if (!hubs.length) { am4RbAnalyseMsg('Select at least one hub.','#ef4444'); return; }
    am4RbSel.scanning = true;
    document.getElementById('am4RbCancelScan').style.display = '';
    var toN = am4RbSel.to;
    am4RbEnsureAircraftStats().then(function () {
        var scoreCfg = am4RbBuildScoreCfg(toN);
        if (!scoreCfg || !(scoreCfg.seats > 0)) {
            am4RbSel.scanning = false;
            document.getElementById('am4RbCancelScan').style.display = 'none';
            am4RbAnalyseMsg('Could not read seat capacity for ' + am4AircraftName() +
                ' — open 🔎 Explorer, pick this type, wait for order stats, then retry.','#ef4444');
            return;
        }
        var flownMap = am4ExpBuildFlownMap();
        var results = [], idx = 0;
        var next = function () {
            if (!am4RbSel.scanning) return Promise.resolve();
            if (idx >= hubs.length) return Promise.resolve();
            var h = hubs[idx];
            am4RbAnalyseMsg('hub ' + (idx + 1) + '/' + hubs.length + ' — ' + h.hubIcao + '…');
            return am4RbScanHubRaw(h.hubId, toN, { force: !!am4RbSel.forceHubs[h.hubId] }, function (i, n, country) {
                am4RbAnalyseMsg('hub ' + (idx + 1) + '/' + hubs.length + ' — ' + h.hubIcao +
                    ': country ' + i + '/' + n + ' (' + country + ')');
            }).then(function (res) {
                if (!res) return;
                var scored = am4RbScoreDests(res.rows, h.hubId, toN, flownMap);
                var paired = am4RbPair(h.planes, scored.good, h.hubId, h.hubIcao, toN);
                results.push({
                    hub: h, fromCache: res.fromCache, capped: res.capped || [],
                    destCount: scored.goodCount, pairs: paired.pairs, unpaired: paired.unpaired,
                    stats: scored.stats, rowCount: (res.rows || []).length, scoreCfg: scored.cfg
                });
                delete am4RbSel.forceHubs[h.hubId];
                idx++;
                return next();
            });
        };
        return next().then(function () {
            am4RbSel.scanning = false;
            document.getElementById('am4RbCancelScan').style.display = 'none';
            am4RbSel.plan = { toN: toN, fromN: am4RbSel.from, hubs: results, scoreCfg: scoreCfg };
            var pairs = results.reduce(function (a, r) { return a + r.pairs.length; }, 0);
            var goodTotal = results.reduce(function (a, r) { return a + (r.destCount || 0); }, 0);
            var cached = results.filter(function (r) { return r.fromCache; }).length;
            if (!pairs && goodTotal) {
                am4RbAnalyseMsg('Found ' + goodTotal + ' Strategy ' + toN + ' route(s) but none could be paired — check the rebuild queue for conflicts.','#f59e0b');
            } else if (!pairs && !goodTotal) {
                var agg = { rows: 0, inBand: 0, fillFail: 0, rwyFail: 0, distFail: 0, zeroRev: 0 };
                results.forEach(function (r) {
                    var st = r.stats || {};
                    Object.keys(agg).forEach(function (k) { agg[k] += st[k] || 0; });
                });
                var detail = am4RbFormatScoreStats(agg);
                var hint = 'Rebuild scores at fill ≥ ' + scoreCfg.goodFillPct + '%, ' +
                    scoreCfg.seats + ' seats, rwy ≥ ' + Number(scoreCfg.minRwy).toLocaleString() + ' ft, band ' +
                    Number(scoreCfg.bandLo).toLocaleString() + '–' + Number(scoreCfg.bandHi).toLocaleString() + ' km.';
                if (!agg.rows) {
                    am4RbAnalyseMsg('No research rows returned — click ↻ on each hub to rescan (cached data may be empty).','#f59e0b');
                } else if (agg.fillFail && agg.fillFail >= agg.inBand) {
                    am4RbAnalyseMsg('Routes exist but demand at ' + toN + '×/24h is too thin for ' +
                        scoreCfg.goodFillPct + '% fill (' + detail + '). ' + hint,'#f59e0b');
                } else {
                    am4RbAnalyseMsg('No Strategy ' + toN + ' routes passed filters (' + (detail || 'no rows') + '). ' + hint,'#f59e0b');
                }
            } else {
                am4RbAnalyseMsg('✓ ' + pairs + ' aircraft can move to Strategy ' + toN +
                    ' · ' + cached + '/' + results.length + ' hubs from cache','#10b981');
            }
            am4RbRenderReview();
            am4RbRenderHubList();
        });
    }).catch(function (e) {
        am4RbSel.scanning = false;
        document.getElementById('am4RbCancelScan').style.display = 'none';
        am4RbAnalyseMsg('analysis failed: ' + e,'#ef4444');
    });
}

function am4RbRenderReview() {
    var box = document.getElementById('am4RbReview');
    if (!box || !am4RbSel.plan) return;
    var plan = am4RbSel.plan;
    var rows = [], n = 0, capped = 0, unpaired = 0;
    plan.hubs.forEach(function (r) {
        capped += (r.capped || []).length;
        unpaired += r.unpaired.length;
        r.pairs.forEach(function (p) {
            var i = n++;
            rows.push(
                "<div style='display:flex; gap:5px; align-items:baseline; padding:3px 0; border-bottom:1px solid #1e293b; font-size:11px;'>" +
                "<input type='checkbox' class='am4-rb-pair' data-hub='" + am4RbEsc(r.hub.hubId) +"' data-idx='" + i +"'" +
                ((AM4_RB_MAX_QUEUE_PER_RUN === 0 || i < AM4_RB_MAX_QUEUE_PER_RUN) ?' checked' : '') +">" +
                "<b style='color:#cbd5e1; min-width:58px;'>" + am4RbEsc(p.plane.reg) +"</b>" +
                "<span style='color:#64748b;'>" + am4RbEsc(p.plane.curDestIcao) +" " + Number(p.plane.curDist).toLocaleString() +"km</span>" +
                "<span style='color:#a78bfa;'>→ " + am4RbEsc(p.destIcao) + (p.dest.preferred ?' ★' : '') +"</span>" +
                "<span style='flex-grow:1; text-align:right; color:#64748b; font-size:9px;'>" +
                Number(p.dest.km).toLocaleString() +"km · Y" + p.seats.y +"/J" + p.seats.j +"/F" + p.seats.f +
                " · $" + (Math.round(p.dest.revPerDay / 1e5) / 10) +"M/d</span></div>");
        });
    });
    if (!n) {
        box.innerHTML ="<div style='color:#f59e0b; font-size:11px;'>No aircraft could be paired with a destination in the Strategy " +
            plan.toN +" band." +
            (plan.scoreCfg
                ? (" Scored with " + plan.scoreCfg.seats + " seats, fill ≥ " + plan.scoreCfg.goodFillPct +
                   "%, rwy ≥ " + Number(plan.scoreCfg.minRwy).toLocaleString() + " ft, band " +
                   Number(plan.scoreCfg.bandLo).toLocaleString() + "–" +
                   Number(plan.scoreCfg.bandHi).toLocaleString() + " km.")
                : "") +
            " Click ↻ on hubs to rescan if cached data is stale.</div>" ;
        return;
    }
    var overCap = (AM4_RB_MAX_QUEUE_PER_RUN > 0 && n > AM4_RB_MAX_QUEUE_PER_RUN);
    box.innerHTML =
        "<div class='am4-exp-sec' style='border-top:1px dashed #334155; margin-top:9px; padding-top:7px; font-weight:bold; color:#38bdf8; font-size:11px;'>④ REVIEW &amp; QUEUE</div>" +
        "<div style='font-size:10px; color:#94a3b8; margin:4px 0;'>" + n +" possible rebuild(s) · ★ = longest in the band · uncheck to leave an aircraft alone." +
        (overCap ? (" <b style='color:#f59e0b;'>The first " + AM4_RB_MAX_QUEUE_PER_RUN +" are pre-selected — one run queues at most that many, on purpose.</b>") : "") +
        (AM4_RB_MAX_GROUNDED_AT_ONCE === 0
            ? " <b style='color:#f59e0b;'>No concurrency limit: every aircraft is taken off its route as soon as it reaches its hub, so the whole batch stops earning while its modifications run.</b>" 
            : "") +
        (unpaired ? (" " + unpaired +" aircraft found no free destination and stay as they are.") : "") +
        (capped ? (" <span style='color:#f59e0b;'>" + capped +" country list(s) hit the game's 50-row limit, so this is a floor, not the full picture.</span>") : "") +
        "</div>" +
        rows.join('') +
        "<div style='font-size:9px; color:#64748b; margin-top:5px;'>Cost per aircraft: up to ~$43.1M if CO₂/Speed/Fuel still need installing (most of your fleet already has them, so usually far less), plus seat changes and a ~$1.5M route fee.</div>" +
        "<div style='display:flex; gap:8px; margin-top:6px; align-items:center;'>" +
        "<button id='am4RbQueueBtn' style='cursor:pointer; border:none; border-radius:5px; padding:6px 12px; font-family:monospace; font-size:12px; font-weight:bold; background:#4c1d95; color:#ede9fe;'>Queue selected</button>" +
        "<span id='am4RbQueueMsg' style='font-size:10px; color:#a78bfa; flex-grow:1;'></span></div>";
    var qb = document.getElementById('am4RbQueueBtn');
    if (qb) qb.addEventListener('click', am4RbOnQueueSelected);
}

function am4RbOnQueueSelected() {
    if (!am4RbSel.plan) return;
    var byHub = {};
    am4RbSel.plan.hubs.forEach(function (r) { byHub[r.hub.hubId] = r; });
    var boxes = document.querySelectorAll('#am4RbReview .am4-rb-pair');
    var queued = 0, skipped = 0, capped = 0;
    var flat = [];
    am4RbSel.plan.hubs.forEach(function (r) { r.pairs.forEach(function (p) { flat.push(p); }); });
    Array.prototype.forEach.call(boxes, function (cb) {
        if (!cb.checked) return;
        if (AM4_RB_MAX_QUEUE_PER_RUN > 0 && queued >= AM4_RB_MAX_QUEUE_PER_RUN) { capped++; return; }
        var p = flat[parseInt(cb.getAttribute('data-idx'), 10)];
        if (!p) return;
        if (am4RbAlreadyQueued(p.plane.aircraftId)) { skipped++; return; }
        am4RbEnqueuePair(p);
        queued++;
    });
    am4RbSaveQueue();
    am4RbRenderQueue();
    var el = document.getElementById('am4RbQueueMsg');
    if (el) {
        el.innerText = '✓ queued ' + queued +
            (skipped ? (' · ' + skipped + ' already in the queue') : '') +
            (capped ? (' · ' + capped + ' left out by the ' + AM4_RB_MAX_QUEUE_PER_RUN + '-per-run limit') : '') +
            (queued ?' — tick Auto-run to start' : '');
        el.style.color = queued ?'#10b981' : '#f59e0b';
    }
}

function am4RbEsc(s) {
    return (typeof am4FleetEsc === 'function') ? am4FleetEsc(s)
        : String(s == null ?'' : s).replace(/[&<>"']/g, function (c) {
            return {'&' : '&amp;','<' : '&lt;','>' : '&gt;','"' : '&quot;',"'" : '&#39;'}[c];
        });
}

// Shows when the queue was last looked at, and whether the background clock is running.
// Without this,"nothing is happening" and"nothing needs to happen" look identical - which
// is exactly how a frozen tab went unnoticed.
function am4RbRenderPulse() {
    var el = document.getElementById('am4RbPulse');
    if (!el) return;
    var age = am4HeartbeatAge();
    if (age == null) { el.innerHTML ="<span style='color:#f59e0b;'>starting…</span>" ; return; }
    var stale = age > (AM4_HEARTBEAT_MS * 3);
    var bg = am4KeepAliveRunning();
    el.innerHTML ="<span title='The queue is checked about once a minute. While Auto-run is on it keeps a silent " +
        "audio track playing, because media playback is the one clock the browser does not freeze in a background " +
        "window.' style='color:" + (stale ?'#ef4444' : '#64748b') +";'>" +
        (stale ?'⚠ ' : '♥ ') + 'checked ' + am4RbHuman(age) + ' ago</span>' +
        (am4RbAutoRun() && !bg
            ? " <span title='Click anywhere in this window once - the browser only allows the background clock to start after an interaction.' style='color:#f59e0b;'>· background clock off</span>" 
            : "");
}

// The running tally, kept ABOVE the list. It is what makes the auto-clean-up safe: the list
// can shed finished aircraft without the achievement disappearing with them.
function am4RbRenderTally() {
    var el = document.getElementById('am4RbTally');
    if (!el) return;
    var total = am4RbTotal();
    var active = am4RbQueue.filter(function (j) { return AM4_RB_ACTIVE.indexOf(j.state) !== -1; }).length;
    var waiting = am4RbQueue.filter(function (j) { return j.state === 'awaiting_base'; }).length;
    var bad = am4RbQueue.filter(function (j) { return j.state === 'needs_attention'; }).length;
    var justDone = am4RbQueue.filter(function (j) { return j.state === 'done'; }).length;
    el.innerHTML =
        "<b style='color:#10b981;'>✓ " + total +" rebuilt</b> in total" +
        (justDone ? (" <span style='color:#64748b;'>(" + justDone +" still shown, they clear themselves)</span>") : "") +
        " · <b style='color:#e2e8f0;'>" + Math.max(0, active - waiting) +"</b> being worked on" +
        " · <b style='color:#e2e8f0;'>" + waiting +"</b> waiting for their hub" +
        (bad ? (" · <b style='color:#ef4444;'>" + bad +" need you</b>") : "");
}

function am4RbRenderQueue() {
    am4RbUpdateButtonBadge();
    am4RbRenderPulse();
    am4RbRenderTally();
    var bb = document.getElementById('am4RbBreakerBox');
    if (bb) {
        if (am4RbBreaker.trippedAt) {
            bb.style.display = '';
            bb.innerHTML ="<b>⛔ Rebuild paused itself.</b> " + am4RbEsc(am4RbBreaker.reason) +
                ", which usually means something changed on the game side rather than a problem with one aircraft. " +
                "Nothing further was touched. Look at the aircraft below, then tick Auto-run again to resume.";
        } else bb.style.display = 'none';
    }
    var body = document.getElementById('am4RbQueueBody');
    if (!body) return;
    if (!am4RbQueue.length) {
        body.innerHTML ="<div style='color:#64748b;'>Queue is empty. Pick From/To and hubs above, analyse, then queue.</div>" ;
        return;
    }
    var attention = am4RbQueue.filter(function (j) { return j.state === 'needs_attention'; });
    var rest = am4RbQueue.filter(function (j) { return j.state !== 'needs_attention'; });
    var render = function (j) {
        var col = AM4_RB_STEP_COLOR[j.state] || '#e2e8f0';
        var active = AM4_RB_ACTIVE.indexOf(j.state) !== -1;
        var ctrl = '';
        if (active) ctrl +="<span data-rb-now='" + j.id +"' title='Advance this aircraft one step now' style='cursor:pointer; color:#10b981; font-weight:bold; margin-left:8px;'>▶</span>" ;
        if (j.state === 'needs_attention') ctrl +="<span data-rb-retry='" + j.id +"' style='cursor:pointer; color:#38bdf8; font-weight:bold; margin-left:8px;'>↻ retry</span>" ;
        if (active || j.state === 'needs_attention') ctrl +="<span data-rb-skip='" + j.id +"' title='Take this aircraft out of the queue' style='cursor:pointer; color:#ef4444; margin-left:8px;'>✕</span>" ;
        // Full per-aircraft history, on demand. It is recorded for every job anyway; hiding it
        // would leave"why did this one fail two hours ago? " unanswerable.
        var hist = (j.errorHistory || []);
        if (hist.length || j.attempts) {
            ctrl +="<span data-rb-details='" + j.id +"' title='Show this aircraft&#39;s history' style='cursor:pointer; color:#64748b; margin-left:8px; font-size:10px;'>" +
                (am4RbOpenDetails[j.id] ?'▾' : '▸') +" log</span>" ;
        }
        var detail = '';
        if (am4RbOpenDetails[j.id]) {
            detail ="<div style='margin-top:3px; padding:4px 6px; background:#0b1220; border-left:2px solid #334155; font-size:9px; color:#94a3b8; line-height:1.5;'>" +
                "<div>aircraft " + am4RbEsc(j.aircraftId) +" · route id " + am4RbEsc(j.groundRouteId || '—') +
                " · grounded by us: " + (j.grounded ?'yes' : 'no') +
                " · attempts in this step: " + (j.attempts || 0) +"</div>" +
                (j.seats ? ("<div>target seats Y" + j.seats.y +"/J" + j.seats.j +"/F" + j.seats.f +
                    " · new route name " + am4RbEsc(j.newReg || '—') +"</div>") : '') +
                (hist.length
                    ? hist.slice().reverse().map(function (h) {
                        return"<div>· " + am4RbEsc(new Date(h.at).toLocaleTimeString()) +" [" + am4RbEsc(h.cls) +
                               " in " + am4RbEsc(h.state) +"] " + am4RbEsc(h.message) +"</div>" ;
                      }).join('')
                    :"<div>no errors recorded</div>") +
                "</div>";
        }
        return"<div style='border-bottom:1px solid #1e293b; padding:5px 0;'>" +
            "<div style='display:flex; align-items:baseline; gap:6px;'>" +
            "<b style='color:#cbd5e1;'>" + am4RbEsc(j.reg) +"</b>" +
            "<span style='color:#64748b; font-size:10px;'>S" + j.fromStrategy +"→S" + j.toStrategy +" · " + am4RbEsc(j.hubIcao) +" → " + am4RbEsc(j.newDestIcao) +"</span>" +
            "<span style='flex-grow:1;'></span>" +
            "<span style='font-weight:bold; color:" + col +"; white-space:nowrap;'>" + am4RbEsc(j.what || j.state) +"</span>" + ctrl +
            "</div>" +
            (j.why ? "<div style='color:#94a3b8; font-size:10px; margin-top:1px;'>" + am4RbEsc(j.why) +"</div>" : "") +
            (j.next ? "<div style='color:#64748b; font-size:9px;'>Next: " + am4RbEsc(j.next) +"</div>" : "") +
            detail +
            "</div>";
    };
    body.innerHTML =
        (attention.length
            ? ("<div style='font-weight:bold; color:#ef4444; font-size:10px; margin:4px 0;'>⚠ NEEDS ATTENTION (" + attention.length +")</div>" +
               attention.map(render).join(''))
            : '') +
        rest.map(render).join('');
    body.querySelectorAll('[data-rb-now]').forEach(function (el) {
        el.addEventListener('click', function () { am4RbForceStep(el.getAttribute('data-rb-now')); });
    });
    body.querySelectorAll('[data-rb-retry]').forEach(function (el) {
        el.addEventListener('click', function () { am4RbRetry(el.getAttribute('data-rb-retry')); });
    });
    body.querySelectorAll('[data-rb-skip]').forEach(function (el) {
        el.addEventListener('click', function () { am4RbSkip(el.getAttribute('data-rb-skip')); });
    });
    body.querySelectorAll('[data-rb-details]').forEach(function (el) {
        el.addEventListener('click', function () {
            var id = el.getAttribute('data-rb-details');
            am4RbOpenDetails[id] = !am4RbOpenDetails[id];
            am4RbRenderQueue();
        });
    });
}

// Exposed for headless testing and console use. The read-only parts are safe to call; the
// mutating steps still run behind Auto-run plus every fail-closed gate.
window.AM4Rebuild = {
    queue: function () { return am4RbQueue; },
    breaker: function () { return am4RbBreaker; },
    autoRun: am4RbAutoRun, setAutoRun: am4RbSetAutoRun,
    tick: am4RbTick, jobReady: am4RbJobReady, due: am4RbDue, urgent: am4RbUrgent,
    forceStep: am4RbForceStep, retry: am4RbRetry, skip: am4RbSkip,
    advance: am4RbAdvance, reconcile: am4RbReconcile, resetBreaker: am4RbResetBreaker,
    classifyFleet: am4RbClassifyFleet, strategyCounts: am4RbStrategyCounts,
    hubsForStrategy: am4RbHubsForStrategy, scanHub: am4RbScanHubRaw, cancelScan: am4RbCancelScan,
    scoreDests: am4RbScoreDests, targetSeats: am4RbTargetSeats, pair: am4RbPair,
    band: am4RbBand, hubDistance: am4RbHubDistance, legsForDist: am4RbLegsForDist, strategyForDist: am4RbStrategyForDist, inBand: am4RbInBand,
    cache: { get: am4RbCacheGet, put: am4RbCachePut, stats: am4RbCacheStats, clear: am4RbCacheClear },
    readAircraftState: am4RbReadAircraftState, whereabouts: am4RbFetchWhereabouts,
    groundRouteId: am4RbFetchGroundRouteId, aircraftPage: am4RbFetchAircraftPage, ground: am4FleetGround,
    listAtBase: am4RbListAtBase, listGrounded: am4RbListGrounded, fleetRow: am4RbFleetRow,
    recoverGrounded: am4RbRecoverGrounded,
    // live fleet re-read (v1.48) - the page snapshot never updates on its own
    refreshFleetLive: am4RbRefreshFleetLive, fetchRouteEnds: am4RbFetchRouteEnds,
    fleetSource: function () { return { source: am4RbFleetSource, at: am4RbFleetReadAt, busy: am4RbFleetLiveBusy }; },
    listAllA380: am4RbListAtBaseOrRouted, sel: function () { return am4RbSel; },

    buildPanel: am4RbBuildPanel, enqueuePair: am4RbEnqueuePair, busy: function () { return am4RbBusy; },
    // Heartbeat / keepalive, exposed so a stall can be diagnosed without guessing.
    heartbeat: am4Heartbeat, heartbeatAge: am4HeartbeatAge, wireHeartbeat: am4WireHeartbeat,
    heartbeatStats: function () {
        return { last: am4HeartbeatLast, ageMs: am4HeartbeatAge(), source: am4HeartbeatSource,
                 count: am4HeartbeatCount, wired: am4HeartbeatWired,
                 backgroundClock: am4KeepAliveRunning(), wanted: am4KeepAliveWanted };
    },
    keepAliveEnsure: am4KeepAliveEnsure, keepAliveRunning: am4KeepAliveRunning,
    // Finished-job housekeeping + the Auto-Depart race guard (v1.45).
    total: am4RbTotal, pruneDone: am4RbPruneDone, renderTally: am4RbRenderTally,
    caughtByRace: am4RbCaughtByRace, raceRollback: am4RbRaceRollback,
    limits: function () {
        return { maxQueuePerRun: AM4_RB_MAX_QUEUE_PER_RUN, maxGroundedAtOnce: AM4_RB_MAX_GROUNDED_AT_ONCE,
                 breakerThreshold: AM4_RB_BREAKER_THRESHOLD, heartbeatMs: AM4_HEARTBEAT_MS };
    }
};


// MASTER CORE LAUNCHPAD SEQUENCE
(function() {
    'use strict';
    if (!window.location.href.includes('airlinemanager.com')) return;
    var am4LeafletRemoveWarned = false;
    function am4InstallLeafletGuards() {
        var Lref = window.L;
        if (!Lref) return false;
        var wrapStamp = function (holder, key) {
            if (!holder || typeof holder[key] !== 'function' || holder[key].__am4Wrapper) return;
            var origStamp = holder[key];
            holder[key] = function (obj) {
                if (obj == null) return 0;
                try { return origStamp.call(this, obj); } catch (eStamp) { return 0; }
            };
            holder[key].__am4Wrapper = true;
        };
        wrapStamp(Lref,'stamp');
        if (Lref.Util) wrapStamp(Lref.Util,'stamp');
        if (Lref.Util && Lref.Util.stamp && Lref.Util.stamp.__am4Wrapper) Lref.stamp = Lref.Util.stamp;
        else if (Lref.stamp && Lref.stamp.__am4Wrapper && Lref.Util) Lref.Util.stamp = Lref.stamp;
        var wrapRemove = function (proto) {
            if (!proto || typeof proto.removeLayer !== 'function' || proto.removeLayer.__am4Wrapper) return;
            var origRemove = proto.removeLayer;
            proto.removeLayer = function (l) {
                if (!l) {
                    if (!am4LeafletRemoveWarned) {
                        am4LeafletRemoveWarned = true;
                        console.log('[AM4 Bot Log] Guarded a removeLayer(null) call from the game map (logged once).');
                    }
                    return this;
                }
                try { return origRemove.call(this, l); } catch (eRm) {
                    if (!am4LeafletRemoveWarned) {
                        am4LeafletRemoveWarned = true;
                        console.log('[AM4 Bot Log] Guarded a removeLayer() call with non-layer value (logged once).');
                    }
                    return this;
                }
            };
            proto.removeLayer.__am4Wrapper = true;
        };
        wrapRemove(Lref.Layer && Lref.Layer.prototype);
        wrapRemove(Lref.LayerGroup && Lref.LayerGroup.prototype);
        wrapRemove(Lref.FeatureGroup && Lref.FeatureGroup.prototype);
        wrapRemove(Lref.Map && Lref.Map.prototype);
        wrapRemove(Lref.GridLayer && Lref.GridLayer.prototype);
        return !!(Lref.Map && Lref.Map.prototype.removeLayer && Lref.Map.prototype.removeLayer.__am4Wrapper);
    }
    am4InstallLeafletGuards();
    var am4LeafletGuardTries = 0;
    var am4LeafletGuardTimer = setInterval(function () {
        am4LeafletGuardTries++;
        var ok = false;
        try { ok = am4InstallLeafletGuards(); } catch (eGuard) { /* ignore */ }
        if (ok && am4LeafletGuardTries > 12) clearInterval(am4LeafletGuardTimer);
        else if (am4LeafletGuardTries > 600) clearInterval(am4LeafletGuardTimer);
    }, 1000);
    // Install the closePop override + click interceptor BEFORE anything can open a
    // popup: with restoreToggles a maintenance sequence can start at ~+2.1s, and the
    // old +5.8s timer left it unprotected until then. Single call site (a second one
    // would register a duplicate click listener).
    setupClosePopProtection();
    am4DetailsInstallListener();
    am4StartLeaseHeartbeat();
    setTimeout(injectToggleControls, am4Jitter(2000));
    am4StartUiRemountWatcher();
    setTimeout(routeDistanceWatcher, am4Jitter(4000));
    setTimeout(scanMarketplaceForBestHubs, am4Jitter(5000));
    // Stored in the managed IDs so the restore path's clearTimeout supersedes them -
    // otherwise both could fire and run maintenance twice
    autoRepairTimeoutID = setTimeout(autoRepairCheckLoop, am4Jitter(5200));
    autoCheckTimeoutID = setTimeout(autoCheckCheckLoop, am4Jitter(5500));
    setTimeout(buildFinancialOverlay, am4Jitter(6200));
    // First alliance read shortly after load, then on its own slow background cadence
    am4AllianceTimer = setTimeout(am4RefreshAllianceMetrics, am4Jitter(8000));
    // First real-net-income read shortly after, then on its own slow background cadence
    am4FinanceTimer = setTimeout(am4RefreshFinanceMetrics, am4Jitter(9000));
    // Keep the quiet-hours badge in sync as the window opens/closes (no requests)
    setInterval(am4UpdateQuietBadge, 60000);
    // Auto-build pipeline scheduler (does nothing unless a job is queued AND Auto-run is ON)
    am4BuildStartScheduler();
    // Strategy Rebuild V2 scheduler (separate module; idle unless a job is queued AND Auto-run
    // is ON). It also runs the startup reconciliation, which is what makes a rebuild survive a
    // browser restart: any job that was mid-mutation is compared against the game's real state.
    am4RbStartScheduler();
    creationPricingObserver.observe(document.body, { childList: true, subtree: true });
    console.log("[AM4 Bot Log] Master layout lifecycle extension successfully initialized.");
})();

})(); // end whole-script IIFE
