// ==UserScript==
// @name         AM4 MASTER SUITE MADE BY HOSS
// @namespace    http://tampermonkey.net
// @version      5.0
// @description  Comprehensive Interactive Automation Control Center Dashboard UI
// @author       HOSS
// @match        *://*://*
// @match        *://airlinemanager.com/*
// @run-at       document-end
// @icon         https://google.com
// @grant        none
// ==/UserScript==
/* global jQuery, autoPrice, closePop */

(function() {
    'use strict';

    //================================================================================
    // PARTS 1 & 2 OF 13: GLOBAL STATE VARIABLES & WALLET TELEMETRY (DASHBOARD LINKED)
    //================================================================================
    var autoDepartTimeoutID = null;
    var autoBuyerTimeoutID = null;
    var autoMarketingTimeoutID = null;
    var autoRepairTimeoutID = null;
    var autoCheckTimeoutID = null;
    var isMaintenanceRunning = false;
    var isCheckMaintenanceRunning = false;

    // DYNAMIC DASHBOARD TRACKING CORE: Reads directly from your UI input config boxes
    var maxWearThreshold = parseInt(localStorage.getItem('am4_cfg_repair_wear'), 10) || 20;
    var performAChecks = true;
    var marketingType = 1;
    var marketingDuration = 3;
    var isBotPausedDueToFunds = false;

    var fuelPriceThreshold = parseInt(localStorage.getItem('am4_cfg_fuel_max'), 10) || 1000;
    var co2PriceThreshold = parseInt(localStorage.getItem('am4_cfg_co2_max'), 10) || 200;

    var lastMonitoredBalance = 0;
    var lastMonitoredFuel = 0;
    var lastMonitoredCO2 = 0;
    var netRevenueIntervalTicks = [];
    var historicalRevenueLogs = [];
    var cachedAllianceContDay = 0;
    var cachedAllianceContFlight = 0;
    var thirtyMinCounterTicks = 0;
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
// PART 2: CONTROL NAVBAR & DRAWER PANEL STYLESHEET INJECTION
//================================================================================
var themeStyleBlock = document.createElement('style');
themeStyleBlock.innerHTML = `
    #am4MasterControlNavbarStrip {
        background: linear-gradient(135deg, #111827 0%, #1e293b 100%);
        border-bottom: 2px solid #334155;
        box-shadow: 0 4px 15px rgba(0, 0, 0, 0.4);
        padding: 8px 16px;
        font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        color: #f3f4f6;
        display: flex;
        align-items: center;
        justify-content: flex-start;
        gap: 20px;
        z-index: 999999;
        position: relative;
    }
    .am4-brand-logo-text {
        font-weight: 800;
        font-size: 13px;
        letter-spacing: 0.05em;
        color: #38bdf8;
        text-shadow: 0 0 8px rgba(56, 189, 248, 0.4);
    }
    .am4-control-slider-module-card {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 11px;
        font-weight: 600;
    }
    .am4-master-switch-gate {
        position: relative;
        display: inline-block;
        width: 34px;
        height: 20px;
    }
    .am4-master-switch-gate input { opacity: 0; width: 0; height: 0; }
    .am4-switch-slider-track {
        position: absolute;
        cursor: pointer;
        top: 0; left: 0; right: 0; bottom: 0;
        background-color: #4b5563;
        transition: .3s;
        border-radius: 20px;
    }
    .am4-switch-slider-track:before {
        position: absolute;
        content: "";
        height: 14px; width: 14px;
        left: 3px; bottom: 3px;
        background-color: white;
        transition: .3s;
        border-radius: 50%;
    }
    .am4-master-switch-gate input:checked + .am4-switch-slider-track { background-color: #10b981; }
    .am4-master-switch-gate input:checked + .am4-switch-slider-track:before { transform: translateX(14px); }

    .am4-fleet-status-text-field {
        font-size: 11px;
        font-weight: 700;
        color: #34d399;
        margin-left: auto;
        display: flex;
        align-items: center;
        gap: 6px;
    }
    .am4-navbar-gear-config-icon {
        cursor: pointer;
        font-size: 16px;
        color: #9ca3af;
        transition: color 0.2s, transform 0.2s;
    }
    .am4-navbar-gear-config-icon:hover { color: #f3f4f6; transform: rotate(45deg); }

    #am4SuiteConfigurationControlCenterWindow {
        position: fixed;
        top: 0; right: 0;
        width: 320px; height: 100vh;
        background-color: #0f172a;
        border-left: 1px solid #1e293b;
        box-shadow: -10px 0 30px rgba(0,0,0,0.5);
        z-index: 9999999;
        font-family: 'Segoe UI', Arial, sans-serif;
        color: #cbd5e1;
        display: none;
        flex-direction: column;
    }
    .am4-panel-header-toolbar {
        background-color: #1e293b;
        padding: 12px 16px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        border-bottom: 1px solid #334155;
    }
    .am4-panel-header-toolbar h3 {
        margin: 0; font-size: 12px; font-weight: 700; color: #38bdf8; letter-spacing: 0.05em;
    }
    .am4-panel-close-x-btn {
        color: #ef4444; font-weight: bold; cursor: pointer; font-size: 14px;
    }
    .am4-panel-scrollable-workspace-body {
        padding: 16px; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 16px;
    }
    .am4-panel-config-section-card {
        border-bottom: 1px dashed #334155; padding-bottom: 14px; display: flex; flex-direction: column; gap: 8px;
    }
    .am4-panel-section-title-label {
        font-size: 10px; font-weight: 800; color: #f97316; letter-spacing: 0.05em; text-transform: uppercase;
    }
    .am4-panel-input-group-row {
        display: flex; align-items: center; justify-content: space-between; gap: 12px;
    }
    .am4-panel-input-group-row label { font-family: sans-serif; font-size: 11px; color: #94a3b8; }
    .am4-panel-input-group-row input[type="text"], .am4-panel-input-group-row input[type="number"], .am4-panel-input-group-row select {
        background-color: #1e293b; border: 1px solid #475569; border-radius: 4px; color: #f8fafc;
        padding: 4px 8px; font-size: 11px; width: 75px; text-align: right;
    }
    .am4-panel-input-group-row select { width: 93px; text-align: left; }
    .am4-panel-input-group-row input[type="checkbox"] { cursor: pointer; }
    .am4-panel-textarea-wrapper { display: flex; flex-direction: column; gap: 4px; }
    .am4-panel-textarea-wrapper label { font-family: sans-serif; font-size: 11px; color: #94a3b8; }
    .am4-panel-textarea-wrapper textarea {
        background-color: #1e293b; border: 1px solid #475569; border-radius: 4px; color: #f8fafc;
        padding: 6px; font-size: 11px; min-height: 80px; resize: vertical; font-family: monospace;
    }
    .am4-panel-action-footer-container {
        background-color: #1e293b; padding: 12px 16px; border-top: 1px solid #334155; display: flex; gap: 10px;
    }
    .am4-btn-panel-action {
        flex: 1; padding: 6px 12px; font-size: 11px; font-weight: 700; text-align: center; border-radius: 4px; cursor: pointer; border: none; transition: background 0.2s;
    }
    .am4-btn-action-reset { background-color: #3b4252; color: #d8dee9; }
    .am4-btn-action-reset:hover { background-color: #4c566a; }
    .am4-btn-action-save { background-color: #10b981; color: #ffffff; }
    .am4-btn-action-save:hover { background-color: #059669; }

    #am4FinancialMetricsDashboard {
        position: fixed;
        bottom: 20px; left: 20px;
        background-color: rgba(15, 23, 42, 0.95);
        border: 1px solid #334155; border-radius: 6px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.4);
        padding: 12px; width: 200px;
        font-family: Arial, sans-serif; font-size: 11px; color: #cbd5e1;
        z-index: 999999; display: block;
    }
    .am4-overlay-data-row {
        display: flex; justify-content: space-between; margin-bottom: 4px;
    }
    .am4-overlay-label { color: #94a3b8; }
    .am4-overlay-value { font-weight: bold; color: #f8fafc; }
`;
document.head.appendChild(themeStyleBlock);

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
// PART 3: TOP BAR CONTROL STRIP NAVIGATION SYSTEM INTERFACE
//================================================================================
function injectToggleControls() {
    if (document.getElementById('am4MasterControlNavbarStrip')) return;

    var navBarStripElement = document.createElement('div');
    navBarStripElement.id = 'am4MasterControlNavbarStrip';

    navBarStripElement.innerHTML = `
        <div class="am4-brand-logo-text">AM4 SUITE</div>

        <div class="am4-control-slider-module-card">
            <span>Auto-Depart</span>
            <label class="am4-master-switch-gate">
                <input type="checkbox" id="am4_tgl_btn_depart" ${localStorage.getItem('am4_tgl_depart') === 'true' ? 'checked' : ''}>
                <span class="am4-switch-slider-track"></span>
            </label>
        </div>
        <div class="am4-control-slider-module-card">
            <span>Auto-Buy Specs</span>
            <label class="am4-master-switch-gate">
                <input type="checkbox" id="am4_tgl_btn_specs" ${localStorage.getItem('am4_tgl_specs') === 'true' ? 'checked' : ''}>
                <span class="am4-switch-slider-track"></span>
            </label>
        </div>
        <div class="am4-control-slider-module-card">
            <span>Auto-Buy Mktg</span>
            <label class="am4-master-switch-gate">
                <input type="checkbox" id="am4_tgl_btn_mktg" ${localStorage.getItem('am4_tgl_mktg') === 'true' ? 'checked' : ''}>
                <span class="am4-switch-slider-track"></span>
            </label>
        </div>
        <div class="am4-control-slider-module-card">
            <span>Auto-Repair</span>
            <label class="am4-master-switch-gate">
                <input type="checkbox" id="am4_tgl_btn_repair" ${localStorage.getItem('am4_tgl_repair') === 'true' ? 'checked' : ''}>
                <span class="am4-switch-slider-track"></span>
            </label>
        </div>
        <div class="am4-control-slider-module-card">
            <span>Auto-Check</span>
            <label class="am4-master-switch-gate">
                <input type="checkbox" id="am4_tgl_btn_check" ${localStorage.getItem('am4_tgl_check') === 'true' ? 'checked' : ''}>
                <span class="am4-switch-slider-track"></span>
            </label>
        </div>
        <div class="am4-fleet-status-text-field" id="am4_txt_fleet_status">
            Fleet Status: Fleet Healthy
        </div>

        <div class="am4-navbar-gear-config-icon" id="am4_btn_trigger_suite_config">⚙</div>
    `;

    var topRootBodyNode = document.body;
    if (topRootBodyNode) {
        topRootBodyNode.insertBefore(navBarStripElement, topRootBodyNode.firstChild);
    }

    document.getElementById('am4_tgl_btn_depart').addEventListener('change', function(e) {
        localStorage.setItem('am4_tgl_depart', e.target.checked);
        var originalCb = document.getElementById("autoDepartCheckbox");
        if (originalCb) { originalCb.checked = e.target.checked; originalCb.dispatchEvent(new Event("change", { bubbles: true })); }
    });
    document.getElementById('am4_tgl_btn_specs').addEventListener('change', function(e) {
        localStorage.setItem('am4_tgl_specs', e.target.checked);
        var originalCb = document.getElementById("autoBuyerCheckbox");
        if (originalCb) { originalCb.checked = e.target.checked; originalCb.dispatchEvent(new Event("change", { bubbles: true })); }
    });
    document.getElementById('am4_tgl_btn_mktg').addEventListener('change', function(e) {
        localStorage.setItem('am4_tgl_mktg', e.target.checked);
        var originalCb = document.getElementById("autoMarketingCheckbox");
        if (originalCb) { originalCb.checked = e.target.checked; originalCb.dispatchEvent(new Event("change", { bubbles: true })); }
    });
    document.getElementById('am4_tgl_btn_repair').addEventListener('change', function(e) {
        localStorage.setItem('am4_tgl_repair', e.target.checked);
        var originalCb = document.getElementById("autoRepairCheckbox");
        if (originalCb) { originalCb.checked = e.target.checked; originalCb.dispatchEvent(new Event("change", { bubbles: true })); }
    });
    document.getElementById('am4_tgl_btn_check').addEventListener('change', function(e) {
        localStorage.setItem('am4_tgl_check', e.target.checked);
        var originalCb = document.getElementById("autoCheckCheckbox");
        if (originalCb) { originalCb.checked = e.target.checked; originalCb.dispatchEvent(new Event("change", { bubbles: true })); }
    });

    document.getElementById('am4_btn_trigger_suite_config').addEventListener('click', toggleConfigurationDrawerWindow);
    console.log("[AM4 Bot Log] Navbar control center interface mounted successfully.");
}

function toggleConfigurationDrawerWindow() {
    var configWindow = document.getElementById('am4SuiteConfigurationControlCenterWindow');
    if (!configWindow) {
        buildConfigurationCenterWindow();
        configWindow = document.getElementById('am4SuiteConfigurationControlCenterWindow');
    }
    configWindow.style.display = (configWindow.style.display === 'none' || configWindow.style.display === '') ? 'flex' : 'none';
}
//================================================================================
// PART 4: SLIDE-OUT CONFIGURATION SETTINGS PANEL WORKSPACE
//================================================================================
function buildConfigurationCenterWindow() {
    if (document.getElementById('am4SuiteConfigurationControlCenterWindow')) return;

    var panelWindowElement = document.createElement('div');
    panelWindowElement.id = 'am4SuiteConfigurationControlCenterWindow';

    var currentSide = localStorage.getItem('am4_cfg_screen_side') || 'Bottom';
    var savedCountries = localStorage.getItem('am4_cfg_elite_countries') || "South Korea\nSingapore\nHong Kong\nIndia\nUAE\nBahrain";
    var savedAirports = localStorage.getItem('am4_cfg_high_yield_airports') || "Seoul Incheon\nSingapore Changi\nHong Kong\nNew Delhi\nDubai International\nManama";

    panelWindowElement.innerHTML = `
        <div class="am4-panel-header-toolbar">
            <h3>AM4 SUITE SETTINGS</h3>
            <span class="am4-panel-close-x-btn" id="am4_btn_close_panel_x">[x]</span>
        </div>
        <div class="am4-panel-scrollable-workspace-body">
            <div class="am4-panel-config-section-card">
                <div class="am4-panel-section-title-label">Purchase Limits</div>
                <div class="am4-panel-input-group-row">
                    <label>Fuel max price ($)</label>
                    <input type="number" id="am4_in_fuel_max" value="${localStorage.getItem('am4_cfg_fuel_max') || '1000'}">
                </div>
                <div class="am4-panel-input-group-row">
                    <label>CO2 max price ($)</label>
                    <input type="number" id="am4_in_co2_max" value="${localStorage.getItem('am4_cfg_co2_max') || '200'}">
                </div>
                <div class="am4-panel-input-group-row">
                    <label>Scan every (min)</label>
                    <input type="number" id="am4_in_scan_mins" value="${localStorage.getItem('am4_cfg_scan_mins') || '15'}">
                </div>
            </div>

            <div class="am4-panel-config-section-card">
                <div class="am4-panel-section-title-label">Maintenance</div>
                <div class="am4-panel-input-group-row">
                    <label>Repair at wear (%)</label>
                    <input type="number" id="am4_in_repair_wear" value="${localStorage.getItem('am4_cfg_repair_wear') || '20'}">
                </div>
                <div class="am4-panel-input-group-row">
                    <label>A-Check below (hours)</label>
                    <input type="number" id="am4_in_acheck_hours" value="${localStorage.getItem('am4_cfg_acheck_hours') || '30'}">
                </div>
                <div class="am4-panel-input-group-row">
                    <label>Re-run every (hrs)</label>
                    <input type="number" id="am4_in_rerun_hours" value="${localStorage.getItem('am4_cfg_rerun_hours') || '8'}">
                </div>
            </div>

            <div class="am4-panel-config-section-card">
                <div class="am4-panel-section-title-label">Ticket Price Multipliers</div>
                <div class="am4-panel-input-group-row">
                    <label>Economy ×</label>
                    <input type="text" id="am4_in_mult_eco" value="${localStorage.getItem('am4_cfg_mult_eco') || '1.1'}">
                </div>
                <div class="am4-panel-input-group-row">
                    <label>Business ×</label>
                    <input type="text" id="am4_in_mult_biz" value="${localStorage.getItem('am4_cfg_mult_biz') || '1.08'}">
                </div>
                <div class="am4-panel-input-group-row">
                    <label>First ×</label>
                    <input type="text" id="am4_in_mult_first" value="${localStorage.getItem('am4_cfg_mult_first') || '1.06'}">
                </div>
                <div class="am4-panel-input-group-row">
                    <label>Cargo Large ×</label>
                    <input type="text" id="am4_in_mult_cargo_l" value="${localStorage.getItem('am4_cfg_mult_cargo_l') || '1.1'}">
                </div>
                <div class="am4-panel-input-group-row">
                    <label>Cargo Heavy ×</label>
                    <input type="text" id="am4_in_mult_cargo_h" value="${localStorage.getItem('am4_cfg_mult_cargo_h') || '1.08'}">
                </div>
            </div>

            <div class="am4-panel-config-section-card">
                <div class="am4-panel-section-title-label">Depart</div>
                <div class="am4-panel-input-group-row">
                    <label>Auto-Depart every (min)</label>
                    <input type="number" id="am4_in_depart_mins" value="${localStorage.getItem('am4_cfg_depart_mins') || '15'}">
                </div>
                <div class="am4-panel-input-group-row">
                    <label>Max depart clicks per run</label>
                    <input type="number" id="am4_in_max_clicks" value="${localStorage.getItem('am4_cfg_max_clicks') || '15'}">
                </div>
                <div class="am4-panel-input-group-row">
                    <label>Pause between clicks (sec)</label>
                    <input type="number" id="am4_in_pause_secs" value="${localStorage.getItem('am4_cfg_pause_secs') || '8'}">
                </div>
            </div>

            <div class="am4-panel-config-section-card">
                <div class="am4-panel-section-title-label">Auto-Buy Marketing</div>
                <div class="am4-panel-input-group-row">
                    <label>Check for expiry every (min)</label>
                    <input type="number" id="am4_in_mktg_expiry" value="${localStorage.getItem('am4_cfg_mktg_expiry') || '10'}">
                </div>
            </div>

            <div class="am4-panel-config-section-card">
                <div class="am4-panel-section-title-label">Financial Overlay</div>
                <div class="am4-panel-input-group-row">
                    <label>Show overlay</label>
                    <input type="checkbox" id="am4_in_show_overlay" ${localStorage.getItem('am4_cfg_show_overlay') !== 'false' ? 'checked' : ''}>
                </div>
                <div class="am4-panel-input-group-row">
                    <label>Screen side</label>
                    <select id="am4_in_screen_side">
                        <option value="Bottom" ${currentSide === 'Bottom' ? 'selected' : ''}>Bottom</option>
                        <option value="Top" ${currentSide === 'Top' ? 'selected' : ''}>Top</option>
                    </select>
                </div>
            </div>

            <div class="am4-panel-config-section-card">
                <div class="am4-panel-section-title-label">Timers & Behavior</div>
                <div class="am4-panel-input-group-row">
                    <label>Timing randomness (± %)</label>
                    <input type="number" id="am4_in_time_rand" value="${localStorage.getItem('am4_cfg_time_rand') || '25'}">
                </div>
                <div class="am4-panel-input-group-row">
                    <label>Restore toggles after reload</label>
                    <input type="checkbox" id="am4_in_restore_toggles" ${localStorage.getItem('am4_cfg_restore_toggles') !== 'false' ? 'checked' : ''}>
                </div>
            </div>

            <div class="am4-panel-config-section-card">
                <div class="am4-panel-section-title-label">Campaigns</div>
                <div class="am4-panel-input-group-row">
                    <label>Eco-friendly (pax + cargo) (type=5)</label>
                    <input type="checkbox" id="am4_in_camp_eco" ${localStorage.getItem('am4_cfg_camp_eco') !== 'false' ? 'checked' : ''}>
                </div>
                <div class="am4-panel-input-group-row">
                    <label>Airline reputation (pax) (type=1)</label>
                    <input type="checkbox" id="am4_in_camp_rep_pax" ${localStorage.getItem('am4_cfg_camp_rep_pax') !== 'false' ? 'checked' : ''}>
                </div>
                <div class="am4-panel-input-group-row">
                    <label>Cargo reputation (type=2)</label>
                    <input type="checkbox" id="am4_in_camp_rep_cargo" ${localStorage.getItem('am4_cfg_camp_rep_cargo') === 'true' ? 'checked' : ''}>
                </div>
            </div>

            <div class="am4-panel-config-section-card">
                <div class="am4-panel-section-title-label">Best Hub Lists</div>
                <div class="am4-panel-textarea-wrapper">
                    <label>Elite Countries</label>
                    <textarea id="am4_tx_elite_countries">${savedCountries}</textarea>
                </div>
                <div class="am4-panel-textarea-wrapper">
                    <label>High-Yield Airports</label>
                    <textarea id="am4_tx_high_yield_airports">${savedAirports}</textarea>
                </div>
            </div>
        </div>
        <div class="am4-panel-action-footer-container">
            <button class="am4-btn-panel-action am4-btn-action-reset" id="am4_btn_panel_reset">Reset All</button>
            <button class="am4-btn-panel-action am4-btn-action-save" id="am4_btn_panel_save">Save & Apply</button>
        </div>
    `;

    document.body.appendChild(panelWindowElement);

    document.getElementById('am4_btn_close_panel_x').addEventListener('click', function() { panelWindowElement.style.display = 'none'; });
    document.getElementById('am4_btn_panel_reset').addEventListener('click', resetDefaultsWorkspaceData);
    document.getElementById('am4_btn_panel_save').addEventListener('click', savePanelConfigurationInputs);
}
function savePanelConfigurationInputs() {
    localStorage.setItem('am4_cfg_fuel_max', document.getElementById('am4_in_fuel_max').value);
    localStorage.setItem('am4_cfg_co2_max', document.getElementById('am4_in_co2_max').value);
    localStorage.setItem('am4_cfg_scan_mins', document.getElementById('am4_in_scan_mins').value);
    localStorage.setItem('am4_cfg_repair_wear', document.getElementById('am4_in_repair_wear').value);
    localStorage.setItem('am4_cfg_acheck_hours', document.getElementById('am4_in_acheck_hours').value);
    localStorage.setItem('am4_cfg_rerun_hours', document.getElementById('am4_in_rerun_hours').value);
    localStorage.setItem('am4_cfg_mult_eco', document.getElementById('am4_in_mult_eco').value);
    localStorage.setItem('am4_cfg_mult_biz', document.getElementById('am4_in_mult_biz').value);
    localStorage.setItem('am4_cfg_mult_first', document.getElementById('am4_in_mult_first').value);
    localStorage.setItem('am4_cfg_mult_cargo_l', document.getElementById('am4_in_mult_cargo_l').value);
    localStorage.setItem('am4_cfg_mult_cargo_h', document.getElementById('am4_in_mult_cargo_h').value);
    localStorage.setItem('am4_cfg_depart_mins', document.getElementById('am4_in_depart_mins').value);
    localStorage.setItem('am4_cfg_max_clicks', document.getElementById('am4_in_max_clicks').value);
    localStorage.setItem('am4_cfg_pause_secs', document.getElementById('am4_in_pause_secs').value);
    localStorage.setItem('am4_cfg_mktg_expiry', document.getElementById('am4_in_mktg_expiry').value);
    localStorage.setItem('am4_cfg_show_overlay', document.getElementById('am4_in_show_overlay').checked.toString());
    localStorage.setItem('am4_cfg_screen_side', document.getElementById('am4_in_screen_side').value);
    localStorage.setItem('am4_cfg_time_rand', document.getElementById('am4_in_time_rand').value);
    localStorage.setItem('am4_cfg_restore_toggles', document.getElementById('am4_in_restore_toggles').checked.toString());
    localStorage.setItem('am4_cfg_camp_eco', document.getElementById('am4_in_camp_eco').checked.toString());
    localStorage.setItem('am4_cfg_camp_rep_pax', document.getElementById('am4_in_camp_rep_pax').checked.toString());
    localStorage.setItem('am4_cfg_camp_rep_cargo', document.getElementById('am4_in_camp_rep_cargo').checked.toString());
    localStorage.setItem('am4_cfg_elite_countries', document.getElementById('am4_tx_elite_countries').value);
    localStorage.setItem('am4_cfg_high_yield_airports', document.getElementById('am4_tx_high_yield_airports').value);

    // Sync thresholds instantly to legacy variables to avoid breakage
    window.fuelPriceThreshold = parseInt(document.getElementById('am4_in_fuel_max').value, 10) || 1000;
    window.co2PriceThreshold = parseInt(document.getElementById('am4_in_co2_max').value, 10) || 200;
    window.maxWearThreshold = parseInt(document.getElementById('am4_in_repair_wear').value, 10) || 20;

    var overlay = document.getElementById('am4FinancialMetricsDashboard');
    if (overlay) {
        overlay.style.display = localStorage.getItem('am4_cfg_show_overlay') === 'true' ? 'block' : 'none';
        if (localStorage.getItem('am4_cfg_screen_side') === 'Top') {
            overlay.style.bottom = 'auto'; overlay.style.top = '70px';
        } else {
            overlay.style.top = 'auto'; overlay.style.bottom = '20px';
        }
    }
    console.log("[AM4 Bot Log] Configuration dashboard parameters successfully compiled.");
    document.getElementById('am4SuiteConfigurationControlCenterWindow').style.display = 'none';
}

function resetDefaultsWorkspaceData() {
    if (!confirm("Are you sure you want to reset all variables to basic system defaults?")) return;
    localStorage.clear();
    window.location.reload();
}

//================================================================================
// Part 4 of 13: Independent Viewport Un-Latch & Click-Safe Interception Core
//================================================================================
// Creates and appends the full visual theme CSS styles for the navbar and panel settings drawer
themeStyleBlock = document.createElement('style');
themeStyleBlock.innerHTML = '' +
    '#am4MasterControlNavbarStrip {' +
        'background: linear-gradient(135deg, #111827 0%, #1e293b 100%);' +
        'border-bottom: 2px solid #334155;' +
        'box-shadow: 0 4px 15px rgba(0, 0, 0, 0.4);' +
        'padding: 8px 16px;' +
        'font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;' +
        'color: #f3f4f6;' +
        'display: flex;' +
        'align-items: center;' +
        'justify-content: flex-start;' +
        'gap: 20px;' +
        'z-index: 999999;' +
        'position: relative;' +
    '}' +
    '.am4-brand-logo-text {' +
        'font-weight: 800;' +
        'font-size: 13px;' +
        'letter-spacing: 0.05em;' +
        'color: #38bdf8;' +
        'text-shadow: 0 0 8px rgba(56, 189, 248, 0.4);' +
    '}' +
    '.am4-control-slider-module-card {' +
        'display: flex;' +
        'align-items: center;' +
        'gap: 8px;' +
        'font-size: 11px;' +
        'font-weight: 600;' +
    '}' +
    '.am4-master-switch-gate {' +
        'position: relative;' +
        'display: inline-block;' +
        'width: 34px;' +
        'height: 20px;' +
    '}' +
    '.am4-master-switch-gate input { opacity: 0; width: 0; height: 0; }' +
    '.am4-switch-slider-track {' +
        'position: absolute;' +
        'cursor: pointer;' +
        'top: 0; left: 0; right: 0; bottom: 0;' +
        'background-color: #4b5563;' +
        'transition: .3s;' +
        'border-radius: 20px;' +
    '}' +
    '.am4-switch-slider-track:before {' +
        'position: absolute;' +
        'content: "";' +
        'height: 14px; width: 14px;' +
        'left: 3px; bottom: 3px;' +
        'background-color: white;' +
        'transition: .3s;' +
        'border-radius: 50%;' +
    '}' +
    '.am4-master-switch-gate input:checked + .am4-switch-slider-track { background-color: #10b981; }' +
    '.am4-master-switch-gate input:checked + .am4-switch-slider-track:before { transform: translateX(14px); }' +
    '.am4-fleet-status-text-field {' +
        'font-size: 11px;' +
        'font-weight: 700;' +
        'color: #34d399;' +
        'margin-left: auto;' +
        'display: flex;' +
        'align-items: center;' +
        'gap: 6px;' +
    '}' +
    '.am4-navbar-gear-config-icon {' +
        'cursor: pointer;' +
        'font-size: 16px;' +
        'color: #9ca3af;' +
        'transition: color 0.2s, transform 0.2s;' +
    '}' +
    '.am4-navbar-gear-config-icon:hover { color: #f3f4f6; transform: rotate(45deg); }';

themeStyleBlock.innerHTML += '' +
    '#am4SuiteConfigurationControlCenterWindow {' +
        'position: fixed;' +
        'top: 0; right: 0;' +
        'width: 320px; height: 100vh;' +
        'background-color: #0f172a;' +
        'border-left: 1px solid #1e293b;' +
        'box-shadow: -10px 0 30px rgba(0,0,0,0.5);' +
        'z-index: 9999999;' +
        'font-family: "Segoe UI", Arial, sans-serif;' +
        'color: #cbd5e1;' +
        'display: none;' +
        'flex-direction: column;' +
    '}' +
    '.am4-panel-header-toolbar {' +
        'background-color: #1e293b;' +
        'padding: 12px 16px;' +
        'display: flex;' +
        'align-items: center;' +
        'justify-content: space-between;' +
        'border-bottom: 1px solid #334155;' +
    '}' +
    '.am4-panel-header-toolbar h3 {' +
        'margin: 0; font-size: 12px; font-weight: 700; color: #38bdf8; letter-spacing: 0.05em;' +
    '}' +
    '.am4-panel-close-x-btn {' +
        'color: #ef4444; font-weight: bold; cursor: pointer; font-size: 14px;' +
    '}' +
    '.am4-panel-scrollable-workspace-body {' +
        'padding: 16px; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 16px;' +
    '}' +
    '.am4-panel-config-section-card {' +
        'border-bottom: 1px dashed #334155; padding-bottom: 14px; display: flex; flex-direction: column; gap: 8px;' +
    '}' +
    '.am4-panel-section-title-label {' +
        'font-size: 10px; font-weight: 800; color: #f97316; letter-spacing: 0.05em; text-transform: uppercase;' +
    '}' +
    '.am4-panel-input-group-row {' +
        'display: flex; align-items: center; justify-content: space-between; gap: 12px;' +
    '}' +
    '.am4-panel-input-group-row label {' +
        'font-family: sans-serif; font-size: 11px; color: #94a3b8;' +
    '}' +
    '.am4-panel-input-group-row input[type="text"], .am4-panel-input-group-row input[type="number"], .am4-panel-input-group-row select {' +
        'background-color: #1e293b; border: 1px solid #475569; border-radius: 4px; color: #f8fafc;' +
        'padding: 4px 8px; font-size: 11px; width: 75px; text-align: right;' +
    '}' +
    '.am4-panel-input-group-row select {' +
        'width: 93px; text-align: left;' +
    '}' +
    '.am4-panel-input-group-row input[type="checkbox"] { cursor: pointer; }' +
    '.am4-panel-textarea-wrapper {' +
        'display: flex; flex-direction: column; gap: 4px;' +
    '}' +
    '.am4-panel-textarea-wrapper label {' +
        'font-family: sans-serif; font-size: 11px; color: #94a3b8;' +
    '}' +
    '.am4-panel-textarea-wrapper textarea {' +
        'background-color: #1e293b; border: 1px solid #475569; border-radius: 4px; color: #f8fafc;' +
        'padding: 6px; font-size: 11px; min-height: 80px; resize: vertical; font-family: monospace;' +
    '}' +
    '.am4-panel-action-footer-container {' +
        'background-color: #1e293b; padding: 12px 16px; border-top: 1px solid #334155; display: flex; gap: 10px;' +
    '}' +
    '.am4-btn-panel-action {' +
        'flex: 1; padding: 6px 12px; font-size: 11px; font-weight: 700; text-align: center; border-radius: 4px; cursor: pointer; border: none; transition: background 0.2s;' +
    '}' +
    '.am4-btn-action-reset { background-color: #3b4252; color: #d8dee9; }' +
    '.am4-btn-action-reset:hover { background-color: #4c566a; }' +
    '.am4-btn-action-save { background-color: #10b981; color: #ffffff; }' +
    '.am4-btn-action-save:hover { background-color: #059669; }' +
    '#am4FinancialMetricsDashboard {' +
        'position: fixed; bottom: 20px; left: 20px;' +
        'background-color: rgba(15, 23, 42, 0.95);' +
        'border: 1px solid #334155; border-radius: 6px;' +
        'box-shadow: 0 4px 20px rgba(0,0,0,0.4);' +
        'padding: 12px; width: 200px;' +
        'font-family: Arial, sans-serif; font-size: 11px; color: #cbd5e1;' +
        'z-index: 999999; display: block;' +
    '}' +
    '.am4-overlay-data-row {' +
        'display: flex; justify-content: space-between; margin-bottom: 4px;' +
    '}' +
    '.am4-overlay-label { color: #94a3b8; }' +
    '.am4-overlay-value { font-weight: bold; color: #f8fafc; }';

document.head.appendChild(themeStyleBlock);

function injectDashboardToggleControls() {
    if (document.getElementById('am4MasterControlNavbarStrip')) return;

    var navBarStripElement = document.createElement('div');
    navBarStripElement.id = 'am4MasterControlNavbarStrip';

    var toolbarHTMLCode = '' +
        '<div class="am4-brand-logo-text">AM4 SUITE</div>' +
        '<div class="am4-control-slider-module-card">' +
            '<span>Auto-Depart</span>' +
            '<label class="am4-master-switch-gate">' +
                '<input type="checkbox" id="am4_tgl_btn_depart" ' + (localStorage.getItem('am4_tgl_depart') === 'true' ? 'checked' : '') + '>' +
                '<span class="am4-switch-slider-track"></span>' +
            '</label>' +
        '</div>' +
        '<div class="am4-control-slider-module-card">' +
            '<span>Auto-Buy Specs</span>' +
            '<label class="am4-master-switch-gate">' +
                '<input type="checkbox" id="am4_tgl_btn_specs" ' + (localStorage.getItem('am4_tgl_specs') === 'true' ? 'checked' : '') + '>' +
                '<span class="am4-switch-slider-track"></span>' +
            '</label>' +
        '</div>' +
        '<div class="am4-control-slider-module-card">' +
            '<span>Auto-Buy Mktg</span>' +
            '<label class="am4-master-switch-gate">' +
                '<input type="checkbox" id="am4_tgl_btn_mktg" ' + (localStorage.getItem('am4_tgl_mktg') === 'true' ? 'checked' : '') + '>' +
                '<span class="am4-switch-slider-track"></span>' +
            '</label>' +
        '</div>' +
        '<div class="am4-control-slider-module-card">' +
            '<span>Auto-Repair</span>' +
            '<label class="am4-master-switch-gate">' +
                '<input type="checkbox" id="am4_tgl_btn_repair" ' + (localStorage.getItem('am4_tgl_repair') === 'true' ? 'checked' : '') + '>' +
                '<span class="am4-switch-slider-track"></span>' +
            '</label>' +
        '</div>' +
        '<div class="am4-control-slider-module-card">' +
            '<span>Auto-Check</span>' +
            '<label class="am4-master-switch-gate">' +
                '<input type="checkbox" id="am4_tgl_btn_check" ' + (localStorage.getItem('am4_tgl_check') === 'true' ? 'checked' : '') + '>' +
                '<span class="am4-switch-slider-track"></span>' +
            '</label>' +
        '</div>' +
        '<div class="am4-fleet-status-text-field" id="am4_txt_fleet_status">' +
            'Fleet Status: Fleet Healthy' +
        '</div>' +
        '<div class="am4-navbar-gear-config-icon" id="am4_btn_trigger_suite_config">⚙</div>';

    navBarStripElement.innerHTML = toolbarHTMLCode;

    var topRootBodyNode = document.body;
    if (topRootBodyNode) {
        topRootBodyNode.insertBefore(navBarStripElement, topRootBodyNode.firstChild);
    }

    // UPDATED INSTANT-ACTIVATION HANDSHAKE LISTENERS
    document.getElementById('am4_tgl_btn_depart').addEventListener('change', function(e) {
        localStorage.setItem('am4_tgl_depart', e.target.checked);
        if (e.target.checked && typeof autoDepartRoutine === 'function') {
            autoDepartRoutine();
        }
    });

    document.getElementById('am4_tgl_btn_specs').addEventListener('change', function(e) {
        localStorage.setItem('am4_tgl_specs', e.target.checked);
        if (e.target.checked && typeof scanConsumable === 'function') {
            scanConsumable();
        }
    });

    document.getElementById('am4_tgl_btn_mktg').addEventListener('change', function(e) {
        localStorage.setItem('am4_tgl_mktg', e.target.checked);
        if (e.target.checked && typeof run24hMarketingRoutine === 'function') {
            run24hMarketingRoutine();
        }
    });

    document.getElementById('am4_tgl_btn_repair').addEventListener('change', function(e) {
        localStorage.setItem('am4_tgl_repair', e.target.checked);
        if (e.target.checked && typeof autoRepairCheckLoop === 'function') {
            autoRepairCheckLoop();
        }
    });

    document.getElementById('am4_tgl_btn_check').addEventListener('change', function(e) {
        localStorage.setItem('am4_tgl_check', e.target.checked);
        if (e.target.checked && typeof autoCheckCheckLoop === 'function') {
            autoCheckCheckLoop();
        }
    });

    document.getElementById('am4_btn_trigger_suite_config').addEventListener('click', toggleDashboardConfigurationDrawerWindow);
    console.log("[AM4 Bot Log] Navbar control center interface mounted successfully with instant re-toggle triggers.");
}

function toggleDashboardConfigurationDrawerWindow() {
    var configWindow = document.getElementById('am4SuiteConfigurationControlCenterWindow');
    if (!configWindow) {
        buildDashboardConfigurationCenterWindow();
        configWindow = document.getElementById('am4SuiteConfigurationControlCenterWindow');
    }
    configWindow.style.display = (configWindow.style.display === 'none' || configWindow.style.display === '') ? 'flex' : 'none';
}

function buildDashboardConfigurationCenterWindow() {
    if (document.getElementById('am4SuiteConfigurationControlCenterWindow')) return;

    var panelWindowElement = document.createElement('div');
    panelWindowElement.id = 'am4SuiteConfigurationControlCenterWindow';

    var currentSide = localStorage.getItem('am4_cfg_screen_side') || 'Bottom';
    var savedCountries = localStorage.getItem('am4_cfg_elite_countries') || "South Korea\nSingapore\nHong Kong\nIndia\nUAE\nBahrain";
    var savedAirports = localStorage.getItem('am4_cfg_high_yield_airports') || "Seoul Incheon\nSingapore Changi\nHong Kong\nNew Delhi\nDubai International\nManama";

    panelWindowElement.innerHTML = '' +
        '<div class="am4-panel-header-toolbar">' +
            '<h3>AM4 SUITE SETTINGS</h3>' +
            '<span class="am4-panel-close-x-btn" id="am4_btn_close_panel_x">[x]</span>' +
        '</div>' +
        '<div class="am4-panel-scrollable-workspace-body">' +
            '<div class="am4-panel-config-section-card">' +
                '<div class="am4-panel-section-title-label">Purchase Limits</div>' +
                '<div class="am4-panel-input-group-row">' +
                    '<label>Fuel max price ($)</label>' +
                    '<input type="number" id="am4_in_fuel_max" value="' + (localStorage.getItem('am4_cfg_fuel_max') || '1000') + '">' +
                '</div>' +
                '<div class="am4-panel-input-group-row">' +
                    '<label>CO2 max price ($)</label>' +
                    '<input type="number" id="am4_in_co2_max" value="' + (localStorage.getItem('am4_cfg_co2_max') || '200') + '">' +
                '</div>' +
                '<div class="am4-panel-input-group-row">' +
                    '<label>Scan every (min)</label>' +
                    '<input type="number" id="am4_in_scan_mins" value="' + (localStorage.getItem('am4_cfg_scan_mins') || '15') + '">' +
                '</div>' +
            '</div>' +
            '<div class="am4-panel-config-section-card">' +
                '<div class="am4-panel-section-title-label">Maintenance</div>' +
                '<div class="am4-panel-input-group-row">' +
                    '<label>Repair at wear (%)</label>' +
                    '<input type="number" id="am4_in_repair_wear" value="' + (localStorage.getItem('am4_cfg_repair_wear') || '20') + '">' +
                '</div>' +
                '<div class="am4-panel-input-group-row">' +
                    '<label>A-Check below (hours)</label>' +
                    '<input type="number" id="am4_in_acheck_hours" value="' + (localStorage.getItem('am4_cfg_acheck_hours') || '30') + '">' +
                '</div>' +
                '<div class="am4-panel-input-group-row">' +
                    '<label>Re-run every (hrs)</label>' +
                    '<input type="number" id="am4_in_rerun_hours" value="' + (localStorage.getItem('am4_cfg_rerun_hours') || '8') + '">' +
                '</div>' +
            '</div>' +
            '<div class="am4-panel-config-section-card">' +
                '<div class="am4-panel-section-title-label">Ticket Price Multipliers</div>' +
                '<div class="am4-panel-input-group-row">' +
                    '<label>Economy ×</label>' +
                    '<input type="text" id="am4_in_mult_eco" value="' + (localStorage.getItem('am4_cfg_mult_eco') || '1.1') + '">' +
                '</div>' +
                '<div class="am4-panel-input-group-row">' +
                    '<label>Business ×</label>' +
                    '<input type="text" id="am4_in_mult_biz" value="' + (localStorage.getItem('am4_cfg_mult_biz') || '1.08') + '">' +
                '</div>' +
                '<div class="am4-panel-input-group-row">' +
                    '<label>First ×</label>' +
                    '<input type="text" id="am4_in_mult_first" value="' + (localStorage.getItem('am4_cfg_mult_first') || '1.06') + '">' +
                '</div>' +
                '<div class="am4-panel-input-group-row">' +
                    '<label>Cargo Large ×</label>' +
                    '<input type="text" id="am4_in_mult_cargo_l" value="' + (localStorage.getItem('am4_cfg_mult_cargo_l') || '1.1') + '">' +
                '</div>' +
                '<div class="am4-panel-input-group-row">' +
                    '<label>Cargo Heavy ×</label>' +
                    '<input type="text" id="am4_in_mult_cargo_h" value="' + (localStorage.getItem('am4_cfg_mult_cargo_h') || '1.08') + '">' +
                '</div>' +
            '</div>' +
            '<div class="am4-panel-config-section-card">' +
                '<div class="am4-panel-section-title-label">Depart</div>' +
                '<div class="am4-panel-input-group-row">' +
                    '<label>Auto-Depart every (min)</label>' +
                    '<input type="number" id="am4_in_depart_mins" value="' + (localStorage.getItem('am4_cfg_depart_mins') || '15') + '">' +
                '</div>' +
                '<div class="am4-panel-input-group-row">' +
                    '<label>Max depart clicks per run</label>' +
                    '<input type="number" id="am4_in_max_clicks" value="' + (localStorage.getItem('am4_cfg_max_clicks') || '15') + '">' +
                '</div>' +
                '<div class="am4-panel-input-group-row">' +
                    '<label>Pause between clicks (sec)</label>' +
                    '<input type="number" id="am4_in_pause_secs" value="' + (localStorage.getItem('am4_cfg_pause_secs') || '8') + '">' +
                '</div>' +
            '</div>' +
            '<div class="am4-panel-config-section-card">' +
                '<div class="am4-panel-section-title-label">Auto-Buy Marketing</div>' +
                '<div class="am4-panel-input-group-row">' +
                    '<label>Check for expiry every (min)</label>' +
                    '<input type="number" id="am4_in_mktg_expiry" value="' + (localStorage.getItem('am4_cfg_mktg_expiry') || '10') + '">' +
                '</div>' +
            '</div>' +
            '<div class="am4-panel-config-section-card">' +
                '<div class="am4-panel-section-title-label">Financial Overlay</div>' +
                '<div class="am4-panel-input-group-row">' +
                    '<label>Show overlay</label>' +
                    '<input type="checkbox" id="am4_in_show_overlay" ' + (localStorage.getItem('am4_cfg_show_overlay') !== 'false' ? 'checked' : '') + '>' +
                '</div>' +
                '<div class="am4-panel-input-group-row">' +
                    '<label>Screen side</label>' +
                    '<select id="am4_in_screen_side">' +
                        '<option value="Bottom" ' + (currentSide === 'Bottom' ? 'selected' : '') + '>Bottom</option>' +
                        '<option value="Top" ' + (currentSide === 'Top' ? 'selected' : '') + '>Top</option>' +
                    '</select>' +
                '</div>' +
            '</div>' +
                '<div class="am4-panel-config-section-card">' +
        '<div class="am4-panel-section-title-label">Campaigns</div>' +
        '<div class="am4-panel-input-group-row">' +
            '<label>Eco-friendly (pax + cargo) (type=5)</label>' +
            '<input type="checkbox" id="am4_in_camp_eco" ' + (localStorage.getItem('am4_cfg_camp_eco') !== 'false' ? 'checked' : '') + '>' +
        '</div>' +
        '<div class="am4-panel-input-group-row">' +
            '<label>Airline reputation (pax) (type=1)</label>' +
            '<input type="checkbox" id="am4_in_camp_rep_pax" ' + (localStorage.getItem('am4_cfg_camp_rep_pax') !== 'false' ? 'checked' : '') + '>' +
        '</div>' +
        '<div class="am4-panel-input-group-row">' +
            '<label>Cargo reputation (type=2)</label>' +
            '<input type="checkbox" id="am4_in_camp_rep_cargo" ' + (localStorage.getItem('am4_cfg_camp_rep_cargo') === 'true' ? 'checked' : '') + '>' +
        '</div>' +
        '<div class="am4-panel-input-group-row">' +
            '<label>Charter reputation (type=10)</label>' +
            '<input type="checkbox" id="am4_in_camp_charter" ' + (localStorage.getItem('am4_cfg_camp_charter') === 'true' ? 'checked' : '') + '>' +
        '</div>' +
    '</div>' +
            '<div class="am4-panel-config-section-card">' +
                '<div class="am4-panel-section-title-label">Best Hub Lists</div>' +
                '<div class="am4-panel-textarea-wrapper">' +
                    '<label>Elite Countries</label>' +
                    '<textarea id="am4_tx_elite_countries">' + savedCountries + '</textarea>' +
                '</div>' +
                '<div class="am4-panel-textarea-wrapper">' +
                    '<label>High-Yield Airports</label>' +
                    '<textarea id="am4_tx_high_yield_airports">' + savedAirports + '</textarea>' +
                '</div>' +
            '</div>' +
        '</div>' +
        '<div class="am4-panel-action-footer-container">' +
            '<button class="am4-btn-panel-action am4-btn-action-reset" id="am4_btn_panel_reset">Reset All</button>' +
            '<button class="am4-btn-panel-action am4-btn-action-save" id="am4_btn_panel_save">Save & Apply</button>' +
        '</div>';

    document.body.appendChild(panelWindowElement);

        document.getElementById('am4_btn_close_panel_x').addEventListener('click', function() { panelWindowElement.style.display = 'none'; });
document.getElementById('am4_btn_panel_reset').addEventListener('click', resetDashboardDefaultsWorkspaceData);
document.getElementById('am4_btn_panel_save').addEventListener('click', saveDashboardPanelConfigurationInputs);

}

function saveDashboardPanelConfigurationInputs() {
    localStorage.setItem('am4_cfg_fuel_max', document.getElementById('am4_in_fuel_max').value);
    localStorage.setItem('am4_cfg_co2_max', document.getElementById('am4_in_co2_max').value);
    localStorage.setItem('am4_cfg_scan_mins', document.getElementById('am4_in_scan_mins').value);
    localStorage.setItem('am4_cfg_repair_wear', document.getElementById('am4_in_repair_wear').value);
    localStorage.setItem('am4_cfg_acheck_hours', document.getElementById('am4_in_acheck_hours').value);
    localStorage.setItem('am4_cfg_rerun_hours', document.getElementById('am4_in_rerun_hours').value);
    localStorage.setItem('am4_cfg_mult_eco', document.getElementById('am4_in_mult_eco').value);
    localStorage.setItem('am4_cfg_mult_biz', document.getElementById('am4_in_mult_biz').value);
    localStorage.setItem('am4_cfg_mult_first', document.getElementById('am4_in_mult_first').value);
    localStorage.setItem('am4_cfg_mult_cargo_l', document.getElementById('am4_in_mult_cargo_l').value);
    localStorage.setItem('am4_cfg_mult_cargo_h', document.getElementById('am4_in_mult_cargo_h').value);
    localStorage.setItem('am4_cfg_depart_mins', document.getElementById('am4_in_depart_mins').value);
    localStorage.setItem('am4_cfg_max_clicks', document.getElementById('am4_in_max_clicks').value);
    localStorage.setItem('am4_cfg_pause_secs', document.getElementById('am4_in_pause_secs').value);
    localStorage.setItem('am4_cfg_mktg_expiry', document.getElementById('am4_in_mktg_expiry').value);
    localStorage.setItem('am4_cfg_show_overlay', document.getElementById('am4_in_show_overlay').checked.toString());
    localStorage.setItem('am4_cfg_screen_side', document.getElementById('am4_in_screen_side').value);
    localStorage.setItem('am4_cfg_time_rand', document.getElementById('am4_in_time_rand').value);
    localStorage.setItem('am4_cfg_restore_toggles', document.getElementById('am4_in_restore_toggles').checked.toString());
    localStorage.setItem('am4_cfg_camp_eco', document.getElementById('am4_in_camp_eco').checked.toString());
    localStorage.setItem('am4_cfg_camp_rep_pax', document.getElementById('am4_in_camp_rep_pax').checked.toString());
    localStorage.setItem('am4_cfg_camp_rep_cargo', document.getElementById('am4_in_camp_rep_cargo').checked.toString());
    localStorage.setItem('am4_cfg_camp_charter', document.getElementById('am4_in_camp_charter').checked.toString());
    localStorage.setItem('am4_cfg_elite_countries', document.getElementById('am4_tx_elite_countries').value);
    localStorage.setItem('am4_cfg_high_yield_airports', document.getElementById('am4_tx_high_yield_airports').value);

    window.fuelPriceThreshold = parseInt(document.getElementById('am4_in_fuel_max').value, 10) || 1000;
    window.co2PriceThreshold = parseInt(document.getElementById('am4_in_co2_max').value, 10) || 200;
    window.maxWearThreshold = parseInt(document.getElementById('am4_in_repair_wear').value, 10) || 20;

    var overlay = document.getElementById('am4FinancialMetricsDashboard');
    if (overlay) {
        overlay.style.display = localStorage.getItem('am4_cfg_show_overlay') === 'true' ? 'block' : 'none';
        if (localStorage.getItem('am4_cfg_screen_side') === 'Top') {
            overlay.style.bottom = 'auto'; overlay.style.top = '70px';
        } else {
            overlay.style.top = 'auto'; overlay.style.bottom = '20px';
        }
    }
    console.log("[AM4 Bot Log] Configuration dashboard parameters successfully compiled.");
    document.getElementById('am4SuiteConfigurationControlCenterWindow').style.display = 'none';
}

function resetDashboardDefaultsWorkspaceData() {
    if (!confirm("Are you sure you want to reset all variables to basic system defaults?")) return;
    localStorage.clear();
    window.location.reload();
}

function buildDashboardFinancialOverlay() {
    if (document.getElementById('am4FinancialMetricsDashboard')) return;
    var overlayContainer = document.createElement('div');
    overlayContainer.id = 'am4FinancialMetricsDashboard';

    if (localStorage.getItem('am4_cfg_screen_side') === 'Top') {
        overlayContainer.style.bottom = 'auto'; overlayContainer.style.top = '70px';
    }
    overlayContainer.style.display = localStorage.getItem('am4_cfg_show_overlay') === 'false' ? 'block' : 'none';

    // Converted to classic string format to remove parsing error
    overlayContainer.innerHTML = '' +
        '<div class="am4-overlay-data-row"><span class="am4-overlay-label">Net Flow:</span><span class="am4-overlay-value" id="metricOverlayFlow">+0 /d</span></div>' +
        '<div class="am4-overlay-data-row"><span class="am4-overlay-label">Est. ROI:</span><span class="am4-overlay-value" id="metricOverlayROI">Infinite</span></div>' +
        '<div class="am4-overlay-data-row"><span class="am4-overlay-label">Fuel Spend:</span><span class="am4-overlay-value" id="metricOverlayFuelSpend">$0 /d</span></div>' +
        '<div class="am4-overlay-data-row"><span class="am4-overlay-label">CO2 Spend:</span><span class="am4-overlay-value" id="metricOverlayCo2Spend">$0 /d</span></div>' +
        '<div class="am4-overlay-data-row"><span class="am4-overlay-label">Cont/Flt:</span><span class="am4-overlay-value" id="metricOverlayAllianceFlight">---</span></div>' +
        '<div class="am4-overlay-data-row"><span class="am4-overlay-label">Cont/Day:</span><span class="am4-overlay-value" id="metricOverlayAllianceDay">---</span></div>';

    document.body.appendChild(overlayContainer);
}

//================================================================================
// PART 6: LIVE PARAMETER SYNCHRONIZATION BRIDGE LOOP (PARSING FIXED)
//================================================================================
setInterval(function() {
    // FIXED: Added strict base-10 numerical parsing to avoid background memory text string stalls
    window.fuelPriceThreshold = parseInt(localStorage.getItem('am4_cfg_fuel_max'), 10) || 1000;
    window.co2PriceThreshold = parseInt(localStorage.getItem('am4_cfg_co2_max'), 10) || 200;
    window.maxWearThreshold = parseInt(localStorage.getItem('am4_cfg_repair_wear'), 10) || 20;

    // 2. Synchronize navigation bar toggles to legacy checkboxes automatically
    var tglDepart = localStorage.getItem('am4_tgl_depart') === 'true';
    var tglSpecs = localStorage.getItem('am4_tgl_specs') === 'true';
    var tglMktg = localStorage.getItem('am4_tgl_mktg') === 'true';
    var tglRepair = localStorage.getItem('am4_tgl_repair') === 'true';
    var tglCheck = localStorage.getItem('am4_tgl_check') === 'true';

    var cbDepart = document.getElementById("autoDepartCheckbox");
    var cbSpecs = document.getElementById("autoBuyerCheckbox");
    var cbMktg = document.getElementById("autoMarketingCheckbox");
    var cbRepair = document.getElementById("autoRepairCheckbox");
    var cbCheck = document.getElementById("autoCheckCheckbox");

    if (cbDepart && cbDepart.checked !== tglDepart) { cbDepart.checked = tglDepart; cbDepart.dispatchEvent(new Event("change", { bubbles: true })); }
    if (cbSpecs && cbSpecs.checked !== tglSpecs) { cbSpecs.checked = tglSpecs; cbSpecs.dispatchEvent(new Event("change", { bubbles: true })); }
    if (cbMktg && cbMktg.checked !== tglMktg) { cbMktg.checked = tglMktg; cbMktg.dispatchEvent(new Event("change", { bubbles: true })); }
    if (cbRepair && cbRepair.checked !== tglRepair) { cbRepair.checked = tglRepair; cbRepair.dispatchEvent(new Event("change", { bubbles: true })); }
    if (cbCheck && cbCheck.checked !== tglCheck) { cbCheck.checked = tglCheck; cbCheck.dispatchEvent(new Event("change", { bubbles: true })); }
}, 1000);



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
// Parts 5 & 6 of 13: Core Control Background Timers & Background Evaluators (DASHBOARD LINKED)
//================================================================================
function autoDepartRoutine() {
    clearTimeout(autoDepartTimeoutID);

    // DIRECT MEMORY MAPPING LAYER: Connects directly to the new navbar toggle button state memory
    var isDepartToggledOn = (localStorage.getItem('am4_tgl_depart') === 'true');
    var userDepartMins = parseInt(localStorage.getItem('am4_cfg_depart_mins'), 10) || 15;

    if (isDepartToggledOn) {
        console.log("[AM4 Bot Log] Initializing background departure sequence evaluation...");
        executeDepartAllAction();
    }

    autoDepartTimeoutID = setTimeout(autoDepartRoutine, userDepartMins * 60 * 1000);
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

        var x = new XMLHttpRequest();
        x.open("GET", "marketing_new.php?type=" + marketingType + "&mode=do&c=" + marketingDuration, true);
        x.send();

        setTimeout(function () {
            if (span.parentElement) {
                if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
                span.parentElement.click();

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
    var isMktgToggledOn = (localStorage.getItem('am4_tgl_mktg') === 'true');
    var userMktgMins = parseInt(localStorage.getItem('am4_cfg_mktg_expiry'), 10) || 10;

    if (!isMktgToggledOn) {
        clearTimeout(autoMarketingTimeoutID);
        autoMarketingTimeoutID = setTimeout(run24hMarketingRoutine, userMktgMins * 60 * 1000);
        return;
    }

    // Extracted dashboard tracking flags for your marketing campaigns
    var useEco = localStorage.getItem('am4_cfg_camp_eco') !== 'false';
    var useRepPax = localStorage.getItem('am4_cfg_camp_rep_pax') !== 'false';
    var useRepCargo = localStorage.getItem('am4_cfg_camp_rep_cargo') === 'true';
    var useRepCharter = localStorage.getItem('am4_cfg_camp_charter') === 'true';

    var x = new XMLHttpRequest();
    x.onreadystatechange = function () {
        if (x.readyState === 4 && x.status === 200 && (x.responseText.includes('marketing_new.php') || x.responseText.includes('Campaign'))) {
            if (useRepPax) call('marketing_new.php?type=1&mode=do&c=3'); // Pax Reputation Campaign
            if (useRepCargo) call('marketing_new.php?type=2&mode=do&c=3');// Cargo Reputation Campaign
            if (useEco) call('marketing_new.php?type=5&mode=do&c=3'); // Eco-Friendly Campaign
            if (useRepCharter) call('marketing_new.php?type=10&mode=do&c=3'); // Charter Reputation Campaign
        }
    };
    x.open("GET", "marketing.php", true);
    x.send();

    clearTimeout(autoMarketingTimeoutID);
    autoMarketingTimeoutID = setTimeout(run24hMarketingRoutine, userMktgMins * 60 * 1000);
}

function autoRepairCheckLoop() {
    if (checkAccountBalanceToastSafety() || isBotPausedDueToFunds) return;

    // DIRECT MEMORY MAPPING LAYER: Connects directly to the new navbar toggle button state memory
    var isRepairToggledOn = (localStorage.getItem('am4_tgl_repair') === 'true');
    var userRerunHours = parseInt(localStorage.getItem('am4_cfg_rerun_hours'), 10) || 8;

    if (!isRepairToggledOn) {
        clearTimeout(autoRepairTimeoutID);
        autoRepairTimeoutID = setTimeout(autoRepairCheckLoop, userRerunHours * 60 * 60 * 1000);
        return;
    }

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

    // DIRECT MEMORY MAPPING LAYER: Connects directly to the new navbar toggle button state memory
    var isCheckToggledOn = (localStorage.getItem('am4_tgl_check') === 'true');
    var userRerunHours = parseInt(localStorage.getItem('am4_cfg_rerun_hours'), 10) || 8;

    if (!isCheckToggledOn) {
        clearTimeout(autoCheckTimeoutID);
        autoCheckTimeoutID = setTimeout(autoCheckCheckLoop, userRerunHours * 60 * 60 * 1000);
        return;
    }

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

function clickPlanesLowerThan275Hours() {
    var wrapper = document.getElementById("maintPlanAction");
    if (!wrapper) return 0;
    var hoursElements = wrapper.querySelectorAll("div.col-sm-6 b.text-success, div[data-id] b.text-success");
    var totalSelected = 0;
    hoursElements.forEach(function(el) {
        var hoursValue = parseInt(el.innerText.replace(/[^0-9]/g, ""), 10) || 999;
        if (hoursValue < 275) {
            var planeCard = el.closest(".col-sm-6") || el.closest("[data-id]");
            if (planeCard && !planeCard.classList.contains("selected")) {
                humanClick(planeCard);
                totalSelected++;
            }
        }
    });
    console.log("[AM4 Bot Log] Filter macro complete. Selected " + totalSelected + " aircraft variants with remaining hours under 275.");
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
                var planesSelected = clickPlanesLowerThan275Hours();

                if (planesSelected === 0) {
                    console.log("[AM4 Bot Log] Check scan complete: 0 planes under 275 hours. Displaying visually for 3 seconds.");
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

//================================================================================
// PART 9 OF 13: CUSTOM MULTIPLIER PRICING INTERCEPTOR (FIXED CLOSURES)
//================================================================================
document.addEventListener('click', function (e) {
    var btn = e.target.closest('#introAuto') || e.target.closest('[onclick*="ticketPriceSuggest"]') || (e.target.tagName === 'BUTTON' && e.target.innerText.toLowerCase().includes('auto'));
    if (!btn) return;

    var originalOnclick = btn.getAttribute('onclick') || "";
    if (!originalOnclick.includes('ticketPriceSuggest')) return;

    var matchPatterns = originalOnclick.match(/ticketPriceSuggest\s*\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)/);
    var explicitBaseY = matchPatterns ? parseFloat(matchPatterns[1]) : 0;
    var explicitBaseJ = matchPatterns ? parseFloat(matchPatterns[2]) : 0;
    var explicitBaseF = matchPatterns ? parseFloat(matchPatterns[3]) : 0;

    setTimeout(function() {
        var targetY = document.getElementById('eTicket') || document.getElementById('eSeat') || document.getElementById('price_y');
        var targetJ = document.getElementById('bTicket') || document.getElementById('bSeat') || document.getElementById('price_j');
        var targetF = document.getElementById('fTicket') || document.getElementById('fSeat') || document.getElementById('price_f');
        var targetL = document.getElementById('price_l');
        var targetH = document.getElementById('price_h');

        var isCargoRoute = !targetF;
        var truncateToTwoDecimals = function(num) { return Math.floor(num * 100) / 100; };

        var mY = parseFloat(localStorage.getItem('am4_cfg_mult_eco')) || 1.10;
        var mJ = parseFloat(localStorage.getItem('am4_cfg_mult_biz')) || 1.08;
        var mF = parseFloat(localStorage.getItem('am4_cfg_mult_first')) || 1.06;
        var mCargoL = parseFloat(localStorage.getItem('am4_cfg_mult_cargo_l')) || 1.10;
        var mCargoH = parseFloat(localStorage.getItem('am4_cfg_mult_cargo_h')) || 1.08;

        if (isCargoRoute) {
            var baseLarge = explicitBaseY || parseFloat(targetL ? targetL.value : (targetY ? targetY.value : 0)) || 0;
            var baseHeavy = explicitBaseJ || parseFloat(targetH ? targetH.value : (targetJ ? targetJ.value : 0)) || 0;
            if (baseLarge > 0 && baseHeavy > 0) {
                var calcLarge = truncateToTwoDecimals(baseLarge * mCargoL);
                var calcHeavy = truncateToTwoDecimals(baseHeavy * mCargoH);
                var inputL = targetL || targetY;
                var inputH = targetH || targetJ;
                if (inputL) {
                    inputL.value = calcLarge.toFixed(2);
                    inputL.dispatchEvent(new Event('input', { bubbles: true }));
                    inputL.dispatchEvent(new Event('change', { bubbles: true }));
                }
                if (inputH) {
                    inputH.value = calcHeavy.toFixed(2);
                    inputH.dispatchEvent(new Event('input', { bubbles: true }));
                    inputH.dispatchEvent(new Event('change', { bubbles: true }));
                }
                if (typeof window.autoPrice === 'function') {
                    window.autoPrice(calcLarge, calcHeavy, baseLarge, baseHeavy);
                } else if (typeof autoPrice === 'function') {
                    autoPrice(calcLarge, calcHeavy, baseLarge, baseHeavy);
                }
                console.log("[AM4 Bot Log] Cargo Pricing Modified ➔ Large: $" + calcLarge.toFixed(2) + " | Heavy: $" + calcHeavy.toFixed(2));
            }
        } else {
            var baseY = explicitBaseY || parseFloat(targetY ? targetY.value : 0) || 0;
            var baseJ = explicitBaseJ || parseFloat(targetJ ? targetJ.value : 0) || 0;
            var baseF = explicitBaseF || parseFloat(targetF ? targetF.value : 0) || 0;
            if (baseY > 0 && baseJ > 0 && baseF > 0) {
                var calcY = Math.floor(baseY * mY);
                var calcJ = Math.floor(baseJ * mJ);
                var calcF = Math.floor(baseF * mF);
                if (targetY) {
                    targetY.value = calcY.toString();
                    targetY.dispatchEvent(new Event('input', { bubbles: true }));
                    targetY.dispatchEvent(new Event('change', { bubbles: true }));
                }
                if (targetJ) {
                    targetJ.value = calcJ.toString();
                    targetJ.dispatchEvent(new Event('input', { bubbles: true }));
                    targetJ.dispatchEvent(new Event('change', { bubbles: true }));
                }
                if (targetF) {
                    targetF.value = calcF.toString();
                    targetF.setAttribute('value', calcF.toString());
                    if (typeof jQuery !== 'undefined') {
                        jQuery(targetF).val(calcF).trigger('input').trigger('change');
                    } else {
                        targetF.dispatchEvent(new Event('input', { bubbles: true }));
                        targetF.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }
                if (typeof window.autoPrice === 'function') {
                    window.autoPrice(calcY, calcJ, calcF, Math.floor(baseY), 0);
                } else if (typeof autoPrice === 'function') {
                    autoPrice(calcY, calcJ, calcF, Math.floor(baseY), 0);
                }

                setTimeout(function() {
                    var verifyF = document.getElementById('fTicket') || document.getElementById('fSeat') || document.getElementById('price_f');
                    if (verifyF && verifyF.value !== calcF.toString()) {
                        verifyF.value = calcF.toString();
                        if (typeof jQuery !== 'undefined') {
                            jQuery(verifyF).val(calcF).trigger('input').trigger('change');
                        } else {
                            verifyF.dispatchEvent(new Event('input', { bubbles: true }));
                            verifyF.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                    }
                }, 50);
                console.log("[AM4 Bot Log] Passenger Pricing Modified ➔ Eco: $" + calcY + " | Biz: $" + calcJ + " | First: $" + calcF);
            }
        }
    }, 1000);
}, false);

// PART 10 OF 13: SANDBOXED DOM-TREE BACKGROUND BUYER (ZERO GRAPHICAL LOADING)
function scanConsumable() {
    // FIXED: Reads your top bar toggle button state memory instantly instead of checking a missing checkbox node element
    var isSpecsToggledOn = (localStorage.getItem('am4_tgl_specs') === 'true');
    var userScanMins = parseInt(localStorage.getItem('am4_cfg_scan_mins'), 10) || 15;

    if (!isSpecsToggledOn) {
        autoBuyerTimeoutID = setTimeout(scanConsumable, userScanMins * 60 * 1000);
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
                    // FIXED: Replaced backticks with clean quotes and string plus markers
                    console.log("[AM4 Bot Log] Background Fuel Match -> Found: $" + intPrice + " | Limit: $" + fuelPriceThreshold);
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
            } catch(err) {
                console.log("Fuel background sandbox delayed: " + err.message);
            }
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
                        // FIXED: Replaced backticks with clean quotes and string plus markers
                        console.log("[AM4 Bot Log] Background CO2 Match -> Found: $" + intPrice + " | Limit: $" + co2PriceThreshold);
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
                } catch(err) {
                    console.log("CO2 background sandbox delayed: " + err.message);
                }
            }
        };
        xhrCo2.open("GET", "co2.php?_=" + Date.now(), true);
        xhrCo2.send();
    }, 3000);
    setTimeout(function () {
        if (typeof closePop === 'function') closePop();
        console.log("[AM4 Bot Log] Consumable scan loop complete.");
    }, 5000);
    autoBuyerTimeoutID = setTimeout(scanConsumable, 15 * 60 * 1000);
}
// PART 11 OF 13: ROUTE CREATION VIEW DYNAMIC PRICE OVERRIDER
const creationPricingObserver = new MutationObserver(function() {
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

        // FIXED: Replaced backticks with clean quotes and classic variable concatenation
        console.log("[AM4 Bot Log] Base ticket costs captured -> Eco: " + Math.floor(rawY) + " | Biz: " + Math.floor(rawJ) + " | First: " + Math.floor(rawF));

        var finalPriceY = Math.floor(rawY * 1.10);
        var finalPriceJ = Math.floor(rawJ * 1.08);
        var finalPriceF = Math.floor(rawF * 1.06);
        priceY.value = finalPriceY.toString();
        priceJ.value = finalPriceJ.toString();
        priceF.value = finalPriceF.toString();
        priceY.dispatchEvent(new Event('input', { bubbles: true }));
        priceJ.dispatchEvent(new Event('input', { bubbles: true }));
        priceF.dispatchEvent(new Event('input', { bubbles: true }));

        // FIXED: Replaced backticks with clean quotes and classic variable concatenation
        console.log("[AM4 Bot Log] Modified pricing applied -> Eco: $" + finalPriceY + " | Biz: $" + finalPriceJ + " | First: $" + finalPriceF);
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

//================================================================================
// ADD-ON FEATURE: AUTO-RESEARCH HIGH-YIELD ROUTE AUTOMATED ELIMINATION & POST-PRICING
//================================================================================
var hasAutoSelectedRouteThisOpen = false;
var isPricingWorkflowActive = false;
var rejectedRouteIds = [];

const clearResearchLockObserver = new MutationObserver(function() {
    var researchTable = document.getElementById("list") || document.querySelector("#research_results_container");
    if (!researchTable) {
        hasAutoSelectedRouteThisOpen = false;
        isPricingWorkflowActive = false;
        rejectedRouteIds = [];
    }
});
clearResearchLockObserver.observe(document.body, { childList: true, subtree: true });

setInterval(function() {
    var rDetailsPane = document.getElementById("rDetails") || document.querySelector(".route-details-pop");

    if (rDetailsPane && rDetailsPane.innerText && rDetailsPane.innerText.trim().length > 10) {
        var activeAcCount = -1;
        var foundAcRow = false;

        var detailRows = rDetailsPane.querySelectorAll("table.table-sm.m-text > tbody > tr");

        detailRows.forEach(function(row) {
            var labelCell = row.querySelector("td:nth-child(1)");
            var valueCell = row.querySelector("td.text-right");
            if (labelCell && valueCell) {
                var labelText = (labelCell.innerText || "").toLowerCase();
                if (labelText.includes("a/c on route")) {
                    foundAcRow = true;
                    activeAcCount = parseInt(valueCell.innerText.replace(/[^0-9]/g, ""), 10) || 0;
                }
            }
        });

        if (!foundAcRow || activeAcCount === -1) return;

        if (activeAcCount >= 2) {
            console.log("[AM4 Bot Log] Route Rejected: Found " + activeAcCount + " A/C on route. Backstepping...");
            var openRouteRow = document.querySelector(".row.border.sorter.bot-clicking-active") || document.querySelector(".bot-clicking-active");
            if (openRouteRow) {
                var labelEl = openRouteRow.querySelector(".exo") || openRouteRow.querySelector("b") || openRouteRow;
                var cleanRouteString = labelEl.innerText.replace("[⭐ HIGH YIELD]", "").trim();
                rejectedRouteIds.push(cleanRouteString);
                openRouteRow.classList.remove("bot-clicking-active");
                openRouteRow.style.backgroundColor = "rgba(239, 68, 68, 0.15)";
                openRouteRow.style.border = "1px solid #ef4444";
            }
            var backBtn = document.querySelector("#rDetails > button");
            if (backBtn) {
                hasAutoSelectedRouteThisOpen = false;
                rDetailsPane.innerHTML = "";
                backBtn.click();
            }
            return;
        } else {
            isPricingWorkflowActive = true;

            var createBtn = document.querySelector("#sugNewRoute");
            if (createBtn && !createBtn.classList.contains("bot-creation-fired")) {
                createBtn.classList.add("bot-creation-fired");
                console.log("[AM4 Bot Log] MATCH CONFIRMED: Found " + activeAcCount + " A/C. Launching automatic route creation panel...");
                createBtn.click();
            }
            return;
        }
    }

    var finalRouteConfirmBtn = document.querySelector("#btnCreateNewRoute");
    if (finalRouteConfirmBtn && !finalRouteConfirmBtn.classList.contains("bot-route-creation-submitted")) {
        finalRouteConfirmBtn.classList.add("bot-route-creation-submitted");
        console.log("[AM4 Bot Log] Step 2: Securing route purchase first...");
        finalRouteConfirmBtn.click();
        return;
    }

    var autoPriceBtn = document.querySelector("#introAuto");
    if (autoPriceBtn && !autoPriceBtn.classList.contains("bot-post-autoprice-fired")) {
        autoPriceBtn.classList.add("bot-post-autoprice-fired");
        console.log("[AM4 Bot Log] Step 3: Route created! Triggering post-creation Autoprice...");
        autoPriceBtn.click();

        setTimeout(function() {
            var targetY = document.getElementById('eTicket') || document.getElementById('eSeat') || document.getElementById('price_y');
            var targetJ = document.getElementById('bTicket') || document.getElementById('bSeat') || document.getElementById('price_j');
            var targetF = document.getElementById('fTicket') || document.getElementById('fSeat') || document.getElementById('price_f');

            var targetL = document.getElementById('price_l');
            var targetH = document.getElementById('price_h');

            var isCargoRoute = !targetF && (targetL || targetH);
            var truncateToTwoDecimals = function(num) { return Math.floor(num * 100) / 100; };

            var mY = parseFloat(localStorage.getItem('am4_cfg_mult_eco')) || 1.10;
            var mJ = parseFloat(localStorage.getItem('am4_cfg_mult_biz')) || 1.08;
            var mF = parseFloat(localStorage.getItem('am4_cfg_mult_first')) || 1.06;
            var mCargoL = parseFloat(localStorage.getItem('am4_cfg_mult_cargo_l')) || 1.10;
            var mCargoH = parseFloat(localStorage.getItem('am4_cfg_mult_cargo_h')) || 1.08;

            if (isCargoRoute) {
                var baseLarge = parseFloat(targetL ? targetL.value : (targetY ? targetY.value : 0)) || 0;
                var baseHeavy = parseFloat(targetH ? targetH.value : (targetJ ? targetJ.value : 0)) || 0;

                if (baseLarge > 0 && baseHeavy > 0) {
                    var calcLarge = truncateToTwoDecimals(baseLarge * mCargoL);
                    var calcHeavy = truncateToTwoDecimals(baseHeavy * mCargoH);

                    var inputL = targetL || targetY;
                    var inputH = targetH || targetJ;

                    if (inputL) {
                        inputL.value = calcLarge.toFixed(2);
                        inputL.dispatchEvent(new Event('input', { bubbles: true }));
                        inputL.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                    if (inputH) {
                        inputH.value = calcHeavy.toFixed(2);
                        inputH.dispatchEvent(new Event('input', { bubbles: true }));
                        inputH.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                    console.log("[AM4 Bot Log] Step 4: Post-Creation Cargo Multipliers Applied -> Large: $" + calcLarge.toFixed(2) + " | Heavy: $" + calcHeavy.toFixed(2));
                }
            } else {
                var baseY = parseFloat(targetY ? targetY.value : 0) || 0;
                var baseJ = parseFloat(targetJ ? targetJ.value : 0) || 0;
                var baseF = parseFloat(targetF ? targetF.value : 0) || 0;

                if (baseY > 0 && baseJ > 0 && baseF > 0) {
                    var calcY = Math.floor(baseY * mY);
                    var calcJ = Math.floor(baseJ * mJ);
                    var calcF = Math.floor(baseF * mF);

                    if (targetY) {
                        targetY.value = calcY.toString();
                        targetY.dispatchEvent(new Event('input', { bubbles: true }));
                        targetY.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                    if (targetJ) {
                        targetJ.value = calcJ.toString();
                        targetJ.dispatchEvent(new Event('input', { bubbles: true }));
                        targetJ.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                    if (targetF) {
                        targetF.value = calcF.toString();
                        targetF.dispatchEvent(new Event('input', { bubbles: true }));
                        targetF.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                    console.log("[AM4 Bot Log] Step 4: Post-Creation Passenger Multipliers Applied -> Eco: $" + calcY + " | Biz: $" + calcJ + " | First: $" + calcF);
                }
            }
        }, 300);

        setTimeout(function() {
            console.log("[AM4 Bot Log] Step 5: Post-creation pricing updates successfully finalized!");
        }, 2500);
        return;
    }

    if (isPricingWorkflowActive) return;

    var researchTable = document.getElementById("list") || document.querySelector("#research_results_container") || document.querySelector(".research-results");
    if (!researchTable || (rDetailsPane && rDetailsPane.innerText && rDetailsPane.innerText.trim().length > 10) || finalRouteConfirmBtn || autoPriceBtn) return;

    var rows = researchTable.querySelectorAll(".row.border.sorter") || researchTable.querySelectorAll("tr") || researchTable.querySelectorAll(".modal-body .row");
    var bestRowToClick = null;
    var highestDemandFound = 0;

    rows.forEach(function(row) {
        var rowLabelEl = row.querySelector(".exo") || row.querySelector("b") || row;
        var rowRouteString = rowLabelEl.innerText.replace("[⭐ HIGH YIELD]", "").trim();
        if (rejectedRouteIds.includes(rowRouteString)) return;

        var ecoDemand = parseInt(row.getAttribute("data-yclass"), 10) || 0;
        var largeCargo = parseInt(row.getAttribute("data-large"), 10) || 0;

        var isHighYieldPassenger = (ecoDemand > 1200);
        var isHighYieldCargo = (largeCargo > 50000);

        if (isHighYieldPassenger || isHighYieldCargo) {
            if (!row.classList.contains("bot-perfect-route-tagged")) {
                row.classList.add("bot-perfect-route-tagged");
                row.style.backgroundColor = "rgba(16, 185, 129, 0.22)";
                row.style.border = "2px solid #10b981";
                var label = row.querySelector(".exo") || row.querySelector("b") || row.querySelector("td");
if (label && !label.innerHTML.includes("[⭐ HIGH YIELD]")) {
    label.innerHTML = "[⭐ HIGH YIELD] " + label.innerHTML;
}
}
var comparativeMetric = Math.max(ecoDemand, largeCargo);
if (comparativeMetric > highestDemandFound) {
    highestDemandFound = comparativeMetric;
    bestRowToClick = row;
}
}
});
if (bestRowToClick && !hasAutoSelectedRouteThisOpen) {
    hasAutoSelectedRouteThisOpen = true;
    bestRowToClick.classList.add("bot-clicking-active");
    console.log("[AM4 Bot Log] Testing best highlighted option path strategy variables...");
    setTimeout(function() {
        if (typeof humanClick === 'function') { humanClick(bestRowToClick); } else { bestRowToClick.click(); }
    }, 400);
}
}, 1500);


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

//================================================================================
// PART 12 OF 13: LIVE FINANCIAL OVERLAY INTERFACE CARRIER (ALLIANCE UPDATE)
//================================================================================
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
        '<tr><td style="color:#aaa; padding:2px 0;">Net Flow/Day:</td><td id="metricOverlayFlow" style="text-align:right; font-weight:bold; color:#38bdf8;">---</td></tr>',
        '<tr><td style="color:#aaa; padding:2px 0;">Avg Fuel Spend:</td><td id="metricOverlayFuelSpend" style="text-align:right; color:#f59e0b;">---</td></tr>',
        '<tr><td style="color:#aaa; padding:2px 0;">Avg CO2 Spend:</td><td id="metricOverlayCo2Spend" style="text-align:right; color:#f59e0b;">---</td></tr>',
        '<tr><td style="color:#aaa; padding:2px 0; border-top:1px dashed #334155;">Alliance Cont/Flt:</td><td id="metricOverlayAllianceFlight" style="text-align:right; color:#c084fc; font-weight:bold;">---</td></tr>',
        '<tr><td style="color:#aaa; padding:2px 0;">Alliance Cont/Day:</td><td id="metricOverlayAllianceDay" style="text-align:right; color:#c084fc; font-weight:bold;">---</td></tr>',
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
//================================================================================
// PART 6: LIVE PARAMETER SYNCHRONIZATION BRIDGE LOOP
//================================================================================
setInterval(function() {
    // 1. Pull fresh threshold parameters typed into your configuration panel drawer
    window.fuelPriceThreshold = parseInt(localStorage.getItem('am4_cfg_fuel_max'), 10) || 1000;
    window.co2PriceThreshold = parseInt(localStorage.getItem('am4_cfg_co2_max'), 10) || 200;
    window.maxWearThreshold = parseInt(localStorage.getItem('am4_cfg_repair_wear'), 10) || 20;

    // 2. Synchronize navigation bar toggles to legacy checkboxes automatically
    var tglDepart = localStorage.getItem('am4_tgl_depart') === 'true';
    var tglSpecs = localStorage.getItem('am4_tgl_specs') === 'true';
    var tglMktg = localStorage.getItem('am4_tgl_mktg') === 'true';
    var tglRepair = localStorage.getItem('am4_tgl_repair') === 'true';
    var tglCheck = localStorage.getItem('am4_tgl_check') === 'true';

    var cbDepart = document.getElementById("autoDepartCheckbox");
    var cbSpecs = document.getElementById("autoBuyerCheckbox");
    var cbMktg = document.getElementById("autoMarketingCheckbox");
    var cbRepair = document.getElementById("autoRepairCheckbox");
    var cbCheck = document.getElementById("autoCheckCheckbox");

    if (cbDepart && cbDepart.checked !== tglDepart) { cbDepart.checked = tglDepart; cbDepart.dispatchEvent(new Event("change", { bubbles: true })); }
    if (cbSpecs && cbSpecs.checked !== tglSpecs) { cbSpecs.checked = tglSpecs; cbSpecs.dispatchEvent(new Event("change", { bubbles: true })); }
    if (cbMktg && cbMktg.checked !== tglMktg) { cbMktg.checked = tglMktg; cbMktg.dispatchEvent(new Event("change", { bubbles: true })); }
    if (cbRepair && cbRepair.checked !== tglRepair) { cbRepair.checked = tglRepair; cbRepair.dispatchEvent(new Event("change", { bubbles: true })); }
    if (cbCheck && cbCheck.checked !== tglCheck) { cbCheck.checked = tglCheck; cbCheck.dispatchEvent(new Event("change", { bubbles: true })); }
}, 1000);

    //================================================================================
    // PART 13 OF 13: FINANCIAL ROLLING SCRAPER MASTER CALCULATIONS (TRUE SEASONAL SYNC)
    //================================================================================
    setInterval(function() {
        var overlayBox = document.getElementById('am4FinancialMetricsDashboard');
        if (!overlayBox || overlayBox.style.display === 'none') return;
        var headerElement = document.getElementById('headerAccount');
        if (!headerElement) return;

        var currentCash = parseInt(headerElement.innerText.replace(/[^0-9]/g, ''), 10) || 0;

        if (typeof lastMonitoredBalance === 'undefined' || lastMonitoredBalance === 0) {
            lastMonitoredBalance = currentCash;
        }
        if (typeof netRevenueIntervalTicks === 'undefined') {
    netRevenueIntervalTicks = [];
}

// --- ALLIANCE CORE LOG ENGINE: VERIFIED XML LEADER SHEET SYNC ---
var targetRow = document.getElementById("al-list-8409987") ||
                document.querySelector("tr[id*='8409987']") ||
                document.querySelector("#al-list-8409987");

if (targetRow) {
    var totalContributedCell = targetRow.querySelector("td:nth-child(3)");
    var liveAllianceDayCell = targetRow.querySelector("td:nth-child(4)");
    var totalFlightsCell = targetRow.querySelector("td:nth-child(6)");

    if (liveAllianceDayCell && totalContributedCell && totalFlightsCell) {
        var rawContDay = (liveAllianceDayCell.innerText || "").trim();
        var rawLifetimeCont = (totalContributedCell.innerText || "").trim();
        var rawLifetimeFlt = (totalFlightsCell.innerText || "").trim();

        var parsedContDay = parseFloat(rawContDay.replace(/[^0-9.]/g, '').replace(/\./g, '')) || parseInt(rawContDay.replace(/[^0-9]/g, ''), 10) || 0;
        var parsedLifetimeCont = parseFloat(rawLifetimeCont.replace(/[^0-9.]/g, '').replace(/\./g, '')) || parseInt(rawLifetimeCont.replace(/[^0-9]/g, ''), 10) || 0;
        var parsedLifetimeFlts = parseFloat(rawLifetimeFlt.replace(/[^0-9.]/g, '').replace(/\./g, '')) || parseInt(rawLifetimeFlt.replace(/[^0-9]/g, ''), 10) || 1;

        if (parsedContDay < 1000 && rawContDay.includes('.')) { parsedContDay = parseInt(rawContDay.replace(/[^0-9]/g, ''), 10); }
        if (parsedLifetimeCont < 1000 && rawLifetimeCont.includes('.') && !rawLifetimeCont.includes(',')) { parsedLifetimeCont = parseInt(rawLifetimeCont.replace(/[^0-9]/g, ''), 10); }
        if (parsedLifetimeFlts < 1000 && rawLifetimeFlt.includes('.') && !rawLifetimeFlt.includes(',')) { parsedLifetimeFlts = parseInt(rawLifetimeFlt.replace(/[^0-9]/g, ''), 10); }

        if (parsedContDay > 0) {
            cachedAllianceContDay = Math.floor(parsedContDay);
            localStorage.setItem('am4_xml_sheet_day_sync', cachedAllianceContDay);

            if (parsedLifetimeCont > 0 && parsedLifetimeFlts > 0) {
                cachedAllianceContFlight = Math.floor((parsedLifetimeCont * 1000) / parsedLifetimeFlts);
                localStorage.setItem('am4_xml_sheet_flight_sync', cachedAllianceContFlight);
            }
        }
    }
} else {
    cachedAllianceContDay = parseInt(localStorage.getItem('am4_xml_sheet_day_sync'), 10) || 0;
    cachedAllianceContFlight = parseInt(localStorage.getItem('am4_xml_sheet_flight_sync'), 10) || 0;
}

// --- CORE FLEET BANK PERFORMANCE CALCULATION WINDOWS ---
thirtyMinCounterTicks++;
if (thirtyMinCounterTicks === 1 || thirtyMinCounterTicks >= 180) {
    thirtyMinCounterTicks = 2;
    var netDifference = currentCash - lastMonitoredBalance;
    lastMonitoredBalance = currentCash;

    if (netRevenueIntervalTicks.length === 0 && netDifference === 0) { netDifference = 150000; }
    if (Math.abs(netDifference) < 500000000 && netDifference !== 0) {
        netRevenueIntervalTicks.push(netDifference);
        if (netRevenueIntervalTicks.length > 10) { netRevenueIntervalTicks.shift(); }
    }
}

var combinedSum = 0;
netRevenueIntervalTicks.forEach(function(val) { combinedSum += val; });
var averageThirtyMinRevenue = netRevenueIntervalTicks.length > 0 ? Math.floor(combinedSum / netRevenueIntervalTicks.length) : 150000;
var flowPerDay = averageThirtyMinRevenue * 48;

var displayRoi = "Infinite";
if (flowPerDay > 0 && currentCash > 0) {
    var daysToPayback = currentCash / flowPerDay;
    displayRoi = daysToPayback.toFixed(1) + " Days";
}

var fField = document.getElementById('metricOverlayFlow');
var rField = document.getElementById('metricOverlayROI');
var fuelField = document.getElementById('metricOverlayFuelSpend');
var co2Field = document.getElementById('metricOverlayCo2Spend');
var allianceFlightField = document.getElementById('metricOverlayAllianceFlight');
var allianceDayField = document.getElementById('metricOverlayAllianceDay');

if (fField) {
    fField.innerText = (flowPerDay >= 0 ? "+" : "") + flowPerDay.toLocaleString('en-US') + " /d";
    fField.style.color = flowPerDay >= 0 ? '#10b981' : '#ef4444';
}
if (rField) { rField.innerText = displayRoi; }
if (fuelField) {
    var fuelThreshold = parseInt(localStorage.getItem('am4_cfg_fuel_max'), 10) || 800;
    fuelField.innerText = "$" + Math.floor(fuelThreshold * 0.12 * 60 * 24).toLocaleString('en-US') + " /d";
}
if (co2Field) {
    var co2Threshold = parseInt(localStorage.getItem('am4_cfg_co2_max'), 10) || 130;
    co2Field.innerText = "$" + Math.floor(co2Threshold * 0.18 * 60 * 24).toLocaleString('en-US') + " /d";
}
if (allianceFlightField) {
    allianceFlightField.innerText = cachedAllianceContFlight > 0 ? "$" + cachedAllianceContFlight.toLocaleString('en-US') : "---";
}
if (allianceDayField) {
    allianceDayField.innerText = cachedAllianceContDay > 0 ? "$" + cachedAllianceContDay.toLocaleString('en-US') + " /d" : "---";
}
}, 10000);

//================================================================================
// MASTER CORE LAUNCHPAD INITIALIZATION HANDSHAKE SEQUENCE
//================================================================================
// Mount the UI Overlays onto the screen layout
setTimeout(injectDashboardToggleControls, 2000);
setTimeout(buildDashboardFinancialOverlay, 3000);
setTimeout(setupClosePopProtection, 3500);

// CRUCIAL ENGAGEMENT HOOKS: Wake up the automation background timers instantly
setTimeout(autoDepartRoutine, 4500);
setTimeout(scanConsumable, 5000);
setTimeout(run24hMarketingRoutine, 5500);
setTimeout(autoRepairCheckLoop, 6000);
setTimeout(autoCheckCheckLoop, 6500);

// Start the real-time layout visual watchers
setTimeout(routeDistanceWatcher, 7000);
setTimeout(cargoDemandWatcher, 7500);
setTimeout(paxDemandWatcher, 8000);
})();
