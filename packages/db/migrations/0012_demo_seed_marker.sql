-- 0012 Demo seed completion marker.
--
-- The demo seed spans many transactions, uploads and media jobs. A run that is interrupted must
-- not pass as "already seeded" on the next start, so the seed records its completion here as
-- its very last step and the presence check reads this table (packages/services/src/seed.ts).
-- Not tenant data: one row, no RLS.

CREATE TABLE relay_demo_seed (
  only_row     boolean PRIMARY KEY DEFAULT true CHECK (only_row),
  seed_version text NOT NULL CHECK (length(seed_version) BETWEEN 1 AND 40),
  completed_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON relay_demo_seed TO relay_app;

-- Databases seeded before this migration were complete under the old presence check (which
-- looked at the first demo owner's membership); carry that over so they do not read as
-- interrupted. Fresh databases get the row from the seed itself.
INSERT INTO relay_demo_seed (seed_version)
SELECT 'pre-0012'
WHERE EXISTS (SELECT 1 FROM users WHERE is_demo);
