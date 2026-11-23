-- Shawarma Thief campaign schema for Neon (Postgres 15+). Safe to run more than once.
CREATE TABLE IF NOT EXISTS players (
  phone       text PRIMARY KEY,
  name        text NOT NULL,
  token       text NOT NULL,                 -- per-device secret; replace with OTP later
  created_at  timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz
);
CREATE TABLE IF NOT EXISTS sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       text NOT NULL REFERENCES players(phone),
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE TABLE IF NOT EXISTS runs (
  id          bigserial PRIMARY KEY,
  session_id  uuid UNIQUE REFERENCES sessions(id),
  phone       text NOT NULL REFERENCES players(phone),
  points      int NOT NULL,
  coins       int NOT NULL,
  metres      int NOT NULL,
  secs        int NOT NULL,
  lives_used  int NOT NULL DEFAULT 0,
  powerups    int NOT NULL DEFAULT 0,
  events      jsonb,
  flagged     boolean NOT NULL DEFAULT false,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS runs_created_idx ON runs (created_at);
CREATE INDEX IF NOT EXISTS runs_points_idx ON runs (points DESC) WHERE NOT flagged;
CREATE TABLE IF NOT EXISTS coupons (
  code        text PRIMARY KEY,
  type        text NOT NULL CHECK (type IN ('tier', 'record', 'grand')),
  tier        int,                           -- index into the prize levels, for type 'tier'
  phone       text NOT NULL REFERENCES players(phone),
  value       text NOT NULL DEFAULT '₹1,000 off',
  session_id  uuid,
  points      int,
  issued_at   timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  redeemed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS one_prize_per_level_per_phone ON coupons (phone, tier) WHERE type = 'tier';
CREATE UNIQUE INDEX IF NOT EXISTS one_grand_prize ON coupons (type) WHERE type = 'grand';
CREATE TABLE IF NOT EXISTS daily_awards (
  day         date PRIMARY KEY,              -- India date (Asia/Kolkata)
  phone       text,
  run_id      bigint,
  points      int,
  coupon_code text,
  settled_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS config (key text PRIMARY KEY, value text NOT NULL);
-- The whole campaign lives in one JSON row, edited from the admin page.
INSERT INTO config (key, value) VALUES ('campaign', '{
  "tiers": [{"points":10000,"slots":20,"prize":"Free shawarma"},{"points":20000,"slots":10,"prize":"₹200 off"},{"points":30000,"slots":5,"prize":"₹500 off"}],
  "grand": {"prize":"₹2,000 off","endsAt":"2026-12-31","endsHour":21},
  "daily": {"on":false,"prize":"₹1,000 off"},
  "sceneLen": 1000, "safeZone": 500, "validDays": 7
}') ON CONFLICT (key) DO NOTHING;

-- ---- Security (added after the first deploy). Safe to run more than once. ----
ALTER TABLE players ADD COLUMN IF NOT EXISTS banned_at     timestamptz;   -- set by admin: blocks play, hides runs, voids prizes
ALTER TABLE players ADD COLUMN IF NOT EXISTS reclaim_until timestamptz;   -- set by admin: lets the owner sign in again from a new phone
ALTER TABLE players ADD COLUMN IF NOT EXISTS ip            text;
ALTER TABLE runs    ADD COLUMN IF NOT EXISTS ip            text;
-- Audit trail: wrong admin PINs, lockouts, blocked sign-ins, flagged runs, prizes, admin actions.
CREATE TABLE IF NOT EXISTS security_events (
  id     bigserial PRIMARY KEY,
  at     timestamptz NOT NULL DEFAULT now(),
  kind   text NOT NULL,
  ip     text,
  phone  text,
  detail jsonb
);
CREATE INDEX IF NOT EXISTS security_events_kind_at ON security_events (kind, at DESC);
CREATE INDEX IF NOT EXISTS security_events_ip_at   ON security_events (ip, at DESC);
CREATE INDEX IF NOT EXISTS runs_phone_idx          ON runs (phone);

-- ---- Named admin accounts (replaces the single shared ADMIN_PIN). Create them with scripts/admin-user.mjs. ----
CREATE TABLE IF NOT EXISTS admin_users (
  username       text PRIMARY KEY CHECK (username = lower(username) AND username ~ '^[a-z0-9._-]{2,30}$'),
  display_name   text NOT NULL,
  role           text NOT NULL CHECK (role IN ('owner', 'manager')),   -- owner: everything. manager: no prize settings, top-score award or user management.
  pin_hash       text NOT NULL,                                         -- scrypt, never the PIN itself
  created_at     timestamptz NOT NULL DEFAULT now(),
  pin_changed_at timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz,
  disabled_at    timestamptz
);

-- Where a player came from (table QR such as ?t=12, or a campaign source). Admin shows players per table.
ALTER TABLE players ADD COLUMN IF NOT EXISTS ref text;
