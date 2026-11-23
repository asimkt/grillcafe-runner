# Handoff: Shawarma Thief (The Grill Cafe, Calicut)

Read this first if you are picking up the project in a new session.

## What this is
A Subway Surfers-style browser runner used as a marketing campaign for The Grill Cafe, a cafe in Calicut (Kozhikode).
An orange cat (the "poocha") steals a shawarma; the shawarma master chases it through 5 Calicut places
(Calicut Beach, Mittayi Theruvu, Mananchira Square, Sarovaram Bio Park, Kovoor Food Street), a new place every 1,000 points.
It must run smoothly on old iPhones (8 / SE), with extra effects on newer phones.

## Files
- `index.html`: the whole game, set to **server mode** (`window.GRILL_CONFIG = { backend: "server" }` near the top).
- `game-test-mode.html`: the same game in **mock mode** (all data in the browser, sample players). Open it directly to play; admin at `#admin`, PIN `2026`.
- `api/`: Vercel functions using Neon Postgres. `_lib.js` has shared helpers, the campaign rules (`cleanCampaign`) and fair-play checks (`judgeRun`).
- `schema.sql`, `vercel.json` (daily cron), `package.json`, `README.md` (deploy steps).

The game is one self-contained HTML file (inline CSS/JS, canvas 2D, Web Audio, no images or libraries). Edit it directly.
Main sections inside the script, in order: CONFIG, campaign rules, mock backend, server backend, scenes (LIGHTS, PLACES),
sprites, renderer and backgrounds, sound, game state and spawning, scene switching, run lifecycle, update and collisions,
particles, drawing, UI screens, admin, input, loop.

## Current rules (all editable in admin, stored as one JSON row `config.campaign`)
- Prize levels: 10,000 points = Free shawarma (20 winners), 20,000 = ₹200 off (10), 30,000 = ₹500 off (5). One per phone per level.
- Top score when the campaign ends = ₹2,000 off (auto-awarded by the cron after the end date, or by a button in admin).
- Daily record prize: a switch, **off** by default (₹1,000 when on).
- Points: 0.5 per metre run + 5 per coin (+20 close call, +25 per 20-coin combo, +50 heart when already holding a life).
- Super zone: the last 500 points before each prize level, the cat is invincible with coin rain; the prize is claimed on entering it.
- After each prize level: top speed 20 → 22 → 24 → 26, denser obstacles, and a breather tree at the start of every new place.
- One extra life max; power-ups: magnet, double coins, super jump, shield.
- Coupons valid 7 days. Coupon codes look like `GRILL-XXXX`.

## Status (23 Nov 2026)
- Live at https://grillcafe-runner.vercel.app. Server code is tested (80 tests, see README) and deployed with Neon.
- `index.html` is the marketing page (Calicut Shawarma Month, 1 Dec to 1 Jan, top score by 31 Dec 9 PM wins). The game is `play.html`.
- Leaderboard (today + overall, names and scores only), security hardening, audit log and admin Security panel are done.
- The production database currently holds real test plays (e.g. "Asim KT"). Clear them before launch only with the owner's say-so.

## Open items
1. OTP phone verification before issuing the device token (`api/register.js`). The takeover block is a stop-gap.
2. Terms page: the rules on the landing page are a draft, to be reviewed by the owner.
3. Launch checklist: new admin PIN, clear test data (`TRUNCATE runs, sessions, coupons, daily_awards, players, security_events CASCADE;` on the `grillcafe` main branch only), table QR codes (`/?t=<table>`), staff briefing on redeeming codes in admin.
4. Decide coupon validity: tier coupons currently last 7 days from the win (admin setting).
5. Optional: retune difficulty after more playtests (speed caps in `speedCap()`, row gaps in `spawnRow()`).

## Testing tip
In admin, set prize levels to 1,000 / 2,000 / 3,000, points per scene to 100 and super zone to 150.
That shows every place, the breather tree, all prize levels and the finish screens in a few minutes.
