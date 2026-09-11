/** JSON columns (permissions, events, args, settings) are stored as their
 * raw text; the table module that owns each one decides whether callers
 * see the string or a parsed object. */

export type InstallationRow = {
  id: number;
  account_login: string;
  account_type: string;
  permissions: string;
  events: string;
  created_at: string;
  suspended_at: string | null;
  removed_at: string | null;
};

export type RepoRow = {
  full_name: string;
  installation_id: number | null;
  active: number;
  auto_review: number;
  review_scope: string;
  skip_drafts: number;
  skip_bots: number;
  knowledge_built_at: string | null;
  knowledge_base_sha: string | null;
  settings: string;
  created_at: string;
};

export type JobRow = {
  id: string;
  type: string;
  repo: string;
  pr_number: number | null;
  status: string;
  args: string;
  delivery_id: string | null;
  attempt: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  superseded_by: string | null;
};

export type JobLogRow = {
  job_id: string;
  seq: number;
  at: string;
  level: string;
  message: string;
};

export type ReviewRow = {
  id: string;
  repo: string;
  pr_number: number;
  job_id: string;
  head_sha: string;
  base_sha: string;
  scope: string;
  model: string;
  findings_count: number;
  tokens_in: number;
  tokens_out: number;
  cost: number | null;
  duration_ms: number | null;
  posted_review_id: string | null;
  status: string;
  created_at: string;
  round: number;
  trigger: string | null;
  check_run_id: string | null;
  posted_fallback: number;
};

export type FindingRow = {
  id: string;
  review_id: string;
  severity: string;
  path: string | null;
  line_from: number | null;
  line_to: number | null;
  title: string;
  body_md: string;
  posted_comment_id: string | null;
  thread_comment_id: string | null;
  first_seen_review_id: string | null;
};

export type DeliveryRow = {
  delivery_id: string;
  event: string;
  action: string | null;
  repo: string | null;
  pr_number: number | null;
  received_at: string;
  outcome: string;
  reason: string | null;
};

export type SessionRow = {
  token_hash: string;
  username: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
};

export type DriftRow = {
  repo: string;
  as_of: string;
  prs_since: number;
  commits_since: number;
  files_changed: number;
};
