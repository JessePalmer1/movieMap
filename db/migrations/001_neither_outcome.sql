-- Records a third answer to a comparison: "neither of these appeals right now".
--
-- Replaces the boolean `skipped` with an explicit outcome, because a
-- comparison now has three meaningful end states rather than two, and a
-- boolean cannot tell "not answered yet" from "actively rejected both".
--
--   pending  shown, awaiting an answer
--   chose    the user picked one; winner_id is set
--   neither  the user has seen both and wants neither tonight
--
-- A `neither` is not an absence of signal. Mood vectors are z-scored, so the
-- origin is literally the average film, and "neither appeals" reads as "both
-- of these score below average for me right now" — two extra constraints, and
-- crucially the only ones that say anything about absolute magnitude.
-- Bradley-Terry on pairs alone is scale-free.

ALTER TABLE comparisons
    ADD COLUMN outcome text NOT NULL DEFAULT 'pending';

-- Existing rows: a winner means 'chose', a skip meant the pair was voided
-- (those rows were deleted), so everything else is still pending.
UPDATE comparisons SET outcome = 'chose' WHERE winner_id IS NOT NULL;

ALTER TABLE comparisons DROP CONSTRAINT IF EXISTS comparisons_skip_has_no_winner;
ALTER TABLE comparisons DROP COLUMN IF EXISTS skipped;

ALTER TABLE comparisons
    ADD CONSTRAINT comparisons_outcome_valid
        CHECK (outcome IN ('pending', 'chose', 'neither')),
    ADD CONSTRAINT comparisons_chose_has_winner
        CHECK (outcome <> 'chose' OR winner_id IS NOT NULL),
    ADD CONSTRAINT comparisons_unchosen_has_no_winner
        CHECK (outcome = 'chose' OR winner_id IS NULL);

CREATE INDEX comparisons_outcome_idx ON comparisons (session_id, outcome);
