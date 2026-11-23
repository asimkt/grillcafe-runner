# Shawarma Thief: The Grill Cafe campaign game

Two static pages plus a few Vercel functions. `index.html` is the marketing page (Calicut Shawarma Month) and `play.html` is the game in server mode (served at `/play`; `/admin` redirects to `/play#admin`).

Originally: one static page (the game in server mode) plus a few Vercel functions in `api/` backed by Neon Postgres. No build step.

## Test mode vs server mode
The game reads `window.GRILL_CONFIG` before it starts:
- `{ backend: "mock" }` (default): everything runs in the browser with sample data. This is what the claude.ai test link uses.
- `{ backend: "server", apiBase: "/api" }`: the game talks to the API below. `index.html` in this folder is already set to server mode (see the script tag near the top).

## Set up (about 15 minutes)
1. **Neon:** create a project at neon.tech, open the SQL editor, paste `schema.sql` and run it.
2. **GitHub:** create a repo and push this folder.
3. **Vercel:** import the repo (framework preset "Other", no build command). Add environment variables:
   - `DATABASE_URL`: the Neon connection string (pooled)
   - `ADMIN_PIN`: the admin PIN, at least 6 digits
   - `CRON_SECRET`: any long random string (Vercel sends it to the daily job)
4. Deploy. Open `https://<your-app>.vercel.app` to play and `https://<your-app>.vercel.app/#admin` for admin.
5. Optional: point a subdomain such as `play.thegrillcafe.in` at the project.

## API
| Endpoint | Does |
| --- | --- |
| `POST /api/register` | Saves name and mobile, returns a device token |
| `GET /api/stats` | Goal, prizes left, record to beat, today's leader |
| `POST /api/run-start` | Starts a server-timed run session (max 6 a minute per phone) |
| `POST /api/tier-claim` | On entering the super zone before a prize level: issues that level's coupon if winners remain; one per phone per level, locked so an extra winner can't slip through |
| `POST /api/run-finish` | Saves the run, flags impossible ones, says whether the player leads today |
| `POST /api/me-coupons` | The player's own coupons (needs the device token) |
| `GET/POST /api/admin` | Admin overview and actions; needs the `x-admin-pin` header |
| `GET /api/cron-settle` | Daily at 00:05 India time: daily record prize (if switched on) and, after the end date, the top score prize |

## Fair-play checks (in `api/_lib.js`)
- Every run is timed by the server from `run-start`.
- More than 45 points a second, a run longer than its session, or more coins than points: the run is flagged, never wins, and shows in admin for review.
- Prize levels: one per phone per level, never more than that level's winners.
- Prize levels, the top score prize and end date, the daily record switch, points per scene and the super zone are all edited in admin and stored as one JSON row in `config`.

## Before launch
- **OTP:** `register` hands out a device token without checking the number. Add an OTP step (MSG91 or Firebase phone auth) so one person can't use many numbers.
- Clear test rows: `TRUNCATE runs, sessions, coupons, daily_awards, players CASCADE;`
- Check the prize levels and end date in admin, and set points per scene back to 1,000.
- Add a terms page: one prize per person, 7-day validity, the cafe may void suspicious wins, campaign end date.

## Live site
- Production: https://grillcafe-runner.vercel.app (landing), `/play` (game), `/admin` (admin).
- Neon project `grillcafe` (Singapore). Branch `test` is a throwaway copy used only by the tests. Compute scales to zero after 5 idle minutes.
- Vercel env vars (Production): `DATABASE_URL`, `CRON_SECRET`. Optional: `ALERT_WEBHOOK_URL` (a Slack incoming webhook) to be told about attacks as they happen. There is no shared admin PIN any more.

## Keeping Neon asleep
- Marketing page: leaderboard and prize counts come from the Vercel edge cache (30 minutes) and refresh every 30 minutes (`/api/leaderboard`, `/api/stats?public=1`).
- Game: the leaderboard loads once when a player opens it (`?live=1`, cached 60 seconds). Nothing polls in the background. A test checks that no page polls faster than every 30 minutes.

## Top-score race
Closes on `grand.endsAt` at `grand.endsHour` India time (default 9 PM). Runs after that still earn level prizes but not the top-score prize, and the overall leaderboard freezes. The daily job issues the prize after that moment (00:05 on the next day), so the winner collects from 1 January.

## Security
- Admin accounts: each person has a username and their own PIN (stored as a salted scrypt hash). Roles: `owner` does everything; `manager` can redeem coupons, approve runs, ban/unban, unlock customers and read the security report, but cannot change prize settings, award the top-score prize or manage accounts. 5 wrong tries from one address, 5 against one username, or 50 from anywhere in 15 minutes lock that door for 15 minutes (even the right PIN). Every admin action is audited under the person's username. Manage accounts from the admin page (owner) or `DATABASE_URL=... node scripts/admin-user.mjs add|reset|disable|enable|list`.
- Quiet by design: the game and API never say why a run or claim was held back, and error messages for blocked numbers are vague. Details are only in the admin audit log.
- Sign-in: a number that already has runs or coupons can't be re-registered by another phone (the real owner's phone sends its old token; otherwise the cafe team unlocks the number in admin for 24 hours). This is a stop-gap until OTP.
- Fair play: server-timed runs, impossible runs flagged and logged, one coupon per phone per level, advisory lock against over-claiming.
- Audit log (`security_events`): wrong PINs, lockouts, blocked sign-ins, wrong tokens, flagged runs, prizes, admin actions, with the address each came from. Admin > Security shows suspects (2+ flagged runs or over 30 points/second), networks with 5+ numbers, banned players and the latest 100 events. Ban hides a player's runs, blocks play, voids prizes.
- Headers: CSP, HSTS, no framing, nosniff, no-referrer. `schema.sql`, `HANDOFF.md`, `README.md`, `test/` and `game-test-mode.html` are not published (`.vercelignore`).
- Known limit: scores come from the player's phone, so a determined cheater who stays under 48 points a second can't be proven wrong by the server. Staff should glance at the run (pts/sec in admin) before honouring a top prize. OTP and the audit log raise the cost of cheating; they don't make it impossible.

## Tests
`npm test` runs 104 tests: the real API handlers against a throwaway Neon branch (fair play, prizes incl. 10 simultaneous claims, admin lockout, takeover, ban, leaderboard, cron, injection) plus checks on headers, secrets and public files.
The tests wipe their database, so they refuse to run unless you name it:
```
TEST_DATABASE_URL='postgresql://...test-branch...' CONFIRM_TEST_DB_HOST='<that url host>' npm test
```
Never point `TEST_DATABASE_URL` at the production branch.

## Coupons and tracking
- Coupon expiry: set "Coupons valid until (date)" in admin settings (currently 31 Jan 2027, end of day India time). If empty, `validDays` from the win is used.
- Table QR codes: print `https://grillcafe-runner.vercel.app/t/<table number>`. The landing page passes the table to the game and the player's first sign-in is tagged `table-<n>`. Admin > "Where players come from" counts players, runs and prizes per table or source (`/play?src=instagram` works too).
- Visits: Vercel Web Analytics is switched on (cookie-less, no database), so `/t/12` page views show per table in the Vercel dashboard without waking Neon.
