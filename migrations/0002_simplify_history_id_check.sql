DROP TABLE IF EXISTS history_next;

CREATE TABLE history_next (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 16)
    CHECK (id = upper(id))
    CHECK (id NOT GLOB '*[^0-9A-F]*'),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO history_next (id, content, created_at, updated_at)
SELECT id, content, created_at, updated_at
FROM history;

DROP TABLE history;

ALTER TABLE history_next RENAME TO history;

CREATE INDEX IF NOT EXISTS idx_history_content ON history(content);
