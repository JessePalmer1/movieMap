-- US content rating (G / PG / PG-13 / R / NC-17), from Wikidata P1657.
--
-- CC0, like the rest of the catalogue spine. Coverage is about 75% of the
-- best-known films and thins out for older and non-US titles, so the column is
-- nullable and the UI simply omits it when absent rather than guessing.

ALTER TABLE movies
    ADD COLUMN content_rating text,
    ADD COLUMN content_rating_fetched_at timestamptz;

CREATE INDEX movies_content_rating_idx ON movies (content_rating)
    WHERE content_rating IS NOT NULL;
