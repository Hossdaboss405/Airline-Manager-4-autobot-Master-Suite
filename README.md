# Airline Manager 4 Bot
This bot is designed for the airline management simulation game, Airline Manager 4. 
It is intended to automate certain tasks in the game and make gameplay easier and more enjoyable.

Please note that this bot is against the Terms of Service of the game and its use may result in your account being banned. Use at your own risk.

## Usage
This bot is currently DONE with development and its functionality is PERFECT. It can currently automate the following tasks:
- [x] Toggles for all auto functions
- [x] Sidebar / ⚙ settings panel to change thresholds, timings, multipliers, campaigns, and more
- [x] Depart all ready planes (full gate queue, multi-batch)
- [x] Better autoprice when setting up new routes (pax Y/J/F and cargo Large/Heavy)
- [x] Auto-start marketing campaigns (per-type strength/duration; never auto-buys points campaigns)
- [x] Buy fuel at low price
- [x] Buy CO₂ quotas at low price
- [x] Launch A-checks for all planes below your hour threshold (default-style: below 250h configurable)
- [x] Auto-repair planes above your wear threshold (configurable, e.g. 20%)
- [x] Best hub purchase suggestions (highlighted country + airport)
- [x] Financial metrics overlay (net income, avg fuel/CO₂ spend; starts with the script)
- [x] Alliance contribution/day in the overlay + C/F (contribution per flight)
- [x] Research Explorer to find best routes for all hubs
- [x] One-click Auto-Build from Explorer (order → configure → modify → route)
- [x] Cargo-aware Auto-Build / Modify / Build Route (correct Large/Heavy loads & tickets)
- [x] Rebuild routes to your liking (strategy From→To, optional auto-queue / overnight Auto-run)
- [x] Fleet Assistant (fleet state + manual capped buyer + manual route builder)
- [x] Separate 🔧 Modify panel (seats + speed/fuel/CO₂; parked & routed; cargo reconfigure)
- [x] Status tab with live module state + persisted action log
- [x] Price audit (fix under- and overpriced tickets → Auto × your multipliers; before depart + optional background)
- [x] Auto staff morale (min-salary dance for Pilots, Crew, Engineers, Technicians)
- [x] Auto hub lounge repair (wear threshold configurable)
- [x] Auto hub catering purchase when missing (duration/amount configurable)
- [x] Seat rebalance for at-base planes (no reroute)
- [x] Explorer hub capacity planner (suggest buys from remaining ★ routes)
- [x] Alliance high-cash remind and optional auto-donate
- [x] Delivery watch: after delivery mods, auto-route from Explorer remaining
- [x] Route health check (band/stack report in the log)
- [x] Quiet hours (idle overnight)
- [x] Hard spend guards (never-spend-points, daily/per-cycle caps, cash reserve, aircraft order caps)
- [x] Acting-tab lock so only one browser tab mutates the game
- [x] All suite windows draggable + collapsible (positions remembered)
- [x] Collapsible overlay + randomized timing jitter



## Installation
How to install (beginner guide)
This script runs on Airline Manager 4 in a desktop browser. The easiest method is Tampermonkey.

1. Install Tampermonkey
Open your browser (Chrome, Edge, Firefox, Brave, Opera, etc.).
Install Tampermonkey:
Chrome / Edge / Brave
Firefox
Pin the Tampermonkey icon to your toolbar so it’s easy to find.
2. Enable “Allow User Scripts” (required on Chrome / Chromium)
On newer Chrome-based browsers, Tampermonkey will not run scripts until this is on:

Click the puzzle piece (Extensions) in the toolbar → find Tampermonkey → click the 3 dots → Manage extension
(or go to chrome://extensions and click Details under Tampermonkey)
Turn ON:
Allow user scripts
Allow access to file URLs (optional, not required for the live game)
If Tampermonkey asks for permissions for airlinemanager.com, click Allow.
Without Allow user scripts, the suite will not load even if the script is installed.

3. Install this suite into Tampermonkey
Option A — Copy & paste (easiest)
Open the script file in this repo and click Raw.
Press Ctrl+A, then Ctrl+C (Mac: Cmd+A, Cmd+C).
Click the Tampermonkey icon → Create a new script…
Delete everything in the editor.
Paste the script (Ctrl+V / Cmd+V).
Click File → Save (or Ctrl+S / Cmd+S).
Option B — Import from URL
Copy this raw URL:

https://raw.githubusercontent.com/Hossdaboss405/Airline-Manager-4-autobot-Master-Suite/refs/heads/main/AM4%20PERFECT%20MASTER%20SUITE%20FOR%20TAMPERMONKEY.js

Click the Tampermonkey icon → Dashboard.

Open the Utilities tab.

Under Import from URL, paste the URL → Install.

Confirm install when prompted.

4. Run it on Airline Manager 4
Go to https://www.airlinemanager.com/ and log in.
Hard-refresh the page (Ctrl+Shift+R / Cmd+Shift+R).
You should see the suite UI (control bar, toggles, ⚙ settings, etc.).
Turn on only the features you want.
Open 📊 Status for the action log of what the bot is doing.
If nothing appears:

Confirm Allow user scripts is enabled (step 2)
Confirm the script is Enabled in the Tampermonkey dashboard
Refresh Airline Manager again
Make sure only one copy of the suite is installed (duplicates can block each other)
Option C — Chrome DevTools snippet (no Tampermonkey)
Use this only if you cannot use Tampermonkey. It does not auto-run after refresh; you must run the snippet each session.

On your phone, enable Airplane mode, open the AM4 app, and wait for the network error that shows a link.
On desktop Chrome, open that same link and log into the game.
Press F12 → open Sources → Snippets.
Click + New snippet, paste the full script, press Ctrl+S to save.
Right-click the snippet → Run.
Use the suite toggles as normal. To watch logs, open the Console tab.
Quick checklist
Tampermonkey installed
Allow user scripts enabled
Script installed and Enabled
Airline Manager page refreshed
Suite UI visible
Desired toggles turned on

## Notes
ive had it running for months with no bans or anything..
ive been working on it for weeks and finally got it perfect.

## Disclaimer
The use of this bot is against the Terms of Service of Airline Manager 4. 
While efforts have been made to ensure the safety and reliability of this bot, the creator of this bot cannot be held responsible for any damages or [consequences] that may arise from its use.

Use this bot at your own risk and for educational purposes.
