# Shawarma Thief: The Grill Cafe campaign game

One static page (`index.html`, the game in server mode) plus a few Vercel functions in `api/` backed by Neon Postgres. No build step.

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
