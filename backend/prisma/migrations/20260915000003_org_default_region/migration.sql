-- Default region for parsing bare national phone numbers into E.164.
-- Per-organization rather than global: a brokerage in Austin and one in Toronto
-- both submit "512 555 0123"-shaped numbers that resolve differently.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS default_region VARCHAR(2) NOT NULL DEFAULT 'US';
