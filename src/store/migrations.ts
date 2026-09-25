/** Numbered, forward-only migrations — PLAN.md Section 5. Each entry is a
 * list of individual statements (not one multi-statement blob) run in a
 * transaction; `PRAGMA user_version` tracks how many have applied. Never
 * edit an already-released migration — add a new one instead. */
export const migrations: string[][] = [
  // 1 — initial schema
  [
    `CREATE TABLE installations (
      id INTEGER PRIMARY KEY,
      account_login TEXT NOT NULL,
      account_type TEXT NOT NULL,
      permissions TEXT NOT NULL DEFAULT '{}',
      events TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      suspended_at TEXT,
      removed_at TEXT
    )`,
    `CREATE TABLE repos (
      full_name TEXT PRIMARY KEY,
      installation_id INTEGER,
      active INTEGER NOT NULL DEFAULT 0,
      auto_review INTEGER NOT NULL DEFAULT 0,
      review_scope TEXT NOT NULL DEFAULT 'whole-pr',
      skip_drafts INTEGER NOT NULL DEFAULT 1,
      skip_bots INTEGER NOT NULL DEFAULT 1,
      knowledge_built_at TEXT,
      knowledge_base_sha TEXT,
      settings TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      repo TEXT NOT NULL,
      pr_number INTEGER,
      status TEXT NOT NULL,
      args TEXT NOT NULL DEFAULT '{}',
      delivery_id TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      error TEXT,
      superseded_by TEXT
    )`,
    `CREATE INDEX idx_jobs_status_created ON jobs(status, created_at)`,
    `CREATE UNIQUE INDEX idx_jobs_one_queued_per_pr
      ON jobs(repo, pr_number) WHERE status = 'queued'`,
    `CREATE TABLE job_logs (
      job_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      at TEXT NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      PRIMARY KEY (job_id, seq)
    )`,
    `CREATE TABLE reviews (
      id TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      job_id TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      base_sha TEXT NOT NULL,
      scope TEXT NOT NULL,
      model TEXT NOT NULL,
      findings_count INTEGER NOT NULL DEFAULT 0,
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      cost REAL,
      duration_ms INTEGER,
      posted_review_id TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      round INTEGER NOT NULL DEFAULT 1,
      "trigger" TEXT,
      check_run_id TEXT
    )`,
    `CREATE INDEX idx_reviews_repo_pr ON reviews(repo, pr_number)`,
    `CREATE TABLE findings (
      id TEXT PRIMARY KEY,
      review_id TEXT NOT NULL,
      severity TEXT NOT NULL,
      path TEXT,
      line_from INTEGER,
      line_to INTEGER,
      title TEXT NOT NULL,
      body_md TEXT NOT NULL,
      posted_comment_id TEXT,
      thread_comment_id TEXT,
      first_seen_review_id TEXT
    )`,
    `CREATE INDEX idx_findings_review ON findings(review_id)`,
    `CREATE TABLE deliveries (
      delivery_id TEXT PRIMARY KEY,
      event TEXT NOT NULL,
      action TEXT,
      repo TEXT,
      pr_number INTEGER,
      received_at TEXT NOT NULL,
      outcome TEXT NOT NULL,
      reason TEXT
    )`,
    `CREATE INDEX idx_deliveries_repo ON deliveries(repo, received_at)`,
    `CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    )`,
    `CREATE TABLE drift (
      repo TEXT PRIMARY KEY,
      as_of TEXT NOT NULL,
      prs_since INTEGER NOT NULL,
      commits_since INTEGER NOT NULL,
      files_changed INTEGER NOT NULL
    )`,
  ],
  // 2 — P7 records when a review fell back to an issue comment
  [`ALTER TABLE reviews ADD COLUMN posted_fallback INTEGER NOT NULL DEFAULT 0`],
  // 3 — durable conversation replies and purpose-specific queued jobs
  [
    `ALTER TABLE jobs ADD COLUMN queue_key TEXT`,
    `UPDATE jobs SET queue_key = 'review:' || repo || ':' || pr_number
     WHERE type = 'review' AND status = 'queued' AND pr_number IS NOT NULL`,
    `DROP INDEX idx_jobs_one_queued_per_pr`,
    `CREATE UNIQUE INDEX idx_jobs_one_queued_key
     ON jobs(queue_key) WHERE status = 'queued' AND queue_key IS NOT NULL`,
    `CREATE UNIQUE INDEX idx_jobs_one_legacy_review_per_pr
     ON jobs(repo, pr_number)
     WHERE status = 'queued' AND type = 'review' AND queue_key IS NULL`,
    `CREATE TABLE reply_requests (
      id TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      source_kind TEXT NOT NULL,
      source_comment_id TEXT NOT NULL,
      target_comment_id TEXT,
      source_body TEXT NOT NULL,
      source_author TEXT,
      source_path TEXT,
      source_line INTEGER,
      source_commit_id TEXT,
      status TEXT NOT NULL,
      answer_md TEXT,
      posted_comment_id TEXT,
      job_id TEXT,
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(repo, source_kind, source_comment_id)
    )`,
    `CREATE INDEX idx_reply_requests_status
     ON reply_requests(status, created_at)`,
  ],
  // 4 — drift separates pull requests opened since the build from older
  // ones that were merely touched again
  [`ALTER TABLE drift ADD COLUMN prs_updated INTEGER NOT NULL DEFAULT 0`],
  // 5 — codegraph tools are an opt-in cost per repo, off until asked for
  [`ALTER TABLE repos ADD COLUMN use_codegraph INTEGER NOT NULL DEFAULT 0`],
  // 6 — why a job was canceled (dashboard, superseded, remote abort, …)
  [`ALTER TABLE jobs ADD COLUMN cancel_reason TEXT`],
  // 7 — subjects, carry-over fields, reviews table rebuild for nullable PR keys
  [
    `CREATE TABLE reviews_new (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'pr',
      subject_id TEXT,
      repo TEXT NOT NULL,
      pr_number INTEGER,
      branch TEXT,
      token_id TEXT,
      token_name TEXT,
      job_id TEXT NOT NULL,
      head_sha TEXT,
      base_sha TEXT,
      scope TEXT NOT NULL,
      model TEXT NOT NULL,
      findings_count INTEGER NOT NULL DEFAULT 0,
      open_count INTEGER NOT NULL DEFAULT 0,
      closed_count INTEGER NOT NULL DEFAULT 0,
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      cost REAL,
      duration_ms INTEGER,
      posted_review_id TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      round INTEGER NOT NULL DEFAULT 1,
      "trigger" TEXT,
      check_run_id TEXT,
      posted_fallback INTEGER NOT NULL DEFAULT 0,
      guide_built_at TEXT,
      codegraph TEXT
    )`,
    `INSERT INTO reviews_new
      (id, kind, repo, pr_number, job_id, head_sha, base_sha, scope, model,
       findings_count, tokens_in, tokens_out, cost, duration_ms, posted_review_id,
       status, created_at, round, "trigger", check_run_id, posted_fallback)
     SELECT id, 'pr', repo, pr_number, job_id, head_sha, base_sha, scope, model,
       findings_count, tokens_in, tokens_out, cost, duration_ms, posted_review_id,
       status, created_at, round, "trigger", check_run_id, posted_fallback
     FROM reviews`,
    `DROP TABLE reviews`,
    `ALTER TABLE reviews_new RENAME TO reviews`,
    `CREATE INDEX idx_reviews_repo_pr ON reviews(repo, pr_number)`,
    `CREATE INDEX idx_reviews_subject ON reviews(subject_id, created_at)`,
    `CREATE INDEX idx_reviews_token ON reviews(token_id, created_at)`,
    `ALTER TABLE findings ADD COLUMN anchor_text TEXT`,
    `ALTER TABLE findings ADD COLUMN state TEXT NOT NULL DEFAULT 'new'`,
    `ALTER TABLE findings ADD COLUMN carried_from_finding_id TEXT`,
    `ALTER TABLE findings ADD COLUMN close_reason TEXT`,
    `UPDATE findings SET state = 'open' WHERE first_seen_review_id IS NOT NULL`,
    `CREATE TABLE subjects (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      repo TEXT NOT NULL,
      pr_number INTEGER,
      branch TEXT,
      token_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE UNIQUE INDEX idx_subjects_pr ON subjects(repo, pr_number) WHERE kind = 'pr'`,
    `CREATE UNIQUE INDEX idx_subjects_remote ON subjects(repo, branch, token_id) WHERE kind = 'remote'`,
    `CREATE TABLE subject_revisions (
      subject_id TEXT PRIMARY KEY,
      review_id TEXT NOT NULL,
      files_json TEXT NOT NULL,
      visible_paths_json TEXT NOT NULL,
      guide_built_at TEXT,
      created_at TEXT NOT NULL
    )`,
  ],
  // 8 — remote review bearer tokens and large submit payloads
  [
    `CREATE TABLE remote_tokens (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      last_used_at TEXT
    )`,
    `CREATE UNIQUE INDEX idx_remote_tokens_name ON remote_tokens(name)`,
    `CREATE TABLE remote_review_inputs (
      job_id TEXT PRIMARY KEY,
      revision_json TEXT NOT NULL,
      capabilities_json TEXT NOT NULL,
      request_id TEXT NOT NULL,
      token_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE UNIQUE INDEX idx_remote_inputs_request
     ON remote_review_inputs(token_id, request_id)`,
  ],
  // 9 — a missing cost is unknown, not zero. Older rows are filled in place
  [
    `ALTER TABLE reviews ADD COLUMN cost_status TEXT`,
    `ALTER TABLE reviews ADD COLUMN cost_note TEXT`,
    `ALTER TABLE reviews ADD COLUMN billed_to TEXT`,
    `UPDATE reviews SET cost_status = 'known' WHERE cost IS NOT NULL`,
    `UPDATE reviews SET cost_status = 'unknown', cost_note = 'recorded_before_0_5_1'
     WHERE cost IS NULL`,
    `UPDATE reviews SET billed_to = 'server'`,
  ],
];
