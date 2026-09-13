-- One page background per device bucket.
--
-- A heatmap is points drawn over a picture of the page, and the two must share a
-- layout. Storing a single snapshot per path meant a desktop capture was rendered
-- underneath mobile clicks (and the reverse): the same nx/ny fall on different
-- elements once a responsive layout reflows, so the overlay was wrong for every
-- visitor whose viewport did not match whoever happened to be captured last.
--
-- Points have carried `device_type` since the table was created; this brings the
-- backgrounds to the same grain. Existing rows are desktop by default — that is
-- what a Playwright capture produces, and tracker captures skewed desktop too.
ALTER TABLE heatmap_page_snapshots
  ADD COLUMN IF NOT EXISTS device_type TEXT NOT NULL DEFAULT 'desktop';

DROP INDEX IF EXISTS heatmap_page_snapshots_website_page_uq;

CREATE UNIQUE INDEX IF NOT EXISTS heatmap_page_snapshots_website_page_device_uq
  ON heatmap_page_snapshots (website_id, page_path, device_type);
