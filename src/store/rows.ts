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
  use_codegraph: number;
};

export type JobRow = {
  id: string;
  type: string;
  repo: string;
  pr_number: number | null;
  status: string;
  args: string;
  delivery_id: string | null;
  queue_key: string | null;
  attempt: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  superseded_by: string | null;
  cancel_reason: string | null;
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
  kind: string;
  subject_id: string | null;
  repo: string;
  pr_number: number | null;
  branch: string | null;
  token_id: string | null;
  token_name: string | null;
  job_id: string;
  head_sha: string | null;
  base_sha: string | null;
  scope: string;
  model: string;
  findings_count: number;
  open_count: number;
  closed_count: number;
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
  guide_built_at: string | null;
  codegraph: string | null;
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
  anchor_text: string | null;
  state: string;
  carried_from_finding_id: string | null;
  close_reason: string | null;
};

export type SubjectRow = {
  id: string;
  kind: string;
  repo: string;
  pr_number: number | null;
  branch: string | null;
  token_id: string | null;
  created_at: string;
  updated_at: string;
};

export type SubjectRevisionRow = {
  subject_id: string;
  review_id: string;
  files_json: string;
  visible_paths_json: string;
  guide_built_at: string | null;
  created_at: string;
};

export type ReplyRequestRow = {
  id: string;
  repo: string;
  pr_number: number;
  source_kind: string;
  source_comment_id: string;
  target_comment_id: string | null;
  source_body: string;
  source_author: string | null;
  source_path: string | null;
  source_line: number | null;
  source_commit_id: string | null;
  status: string;
  answer_md: string | null;
  posted_comment_id: string | null;
  job_id: string | null;
  error: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
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
  prs_updated: number;
  commits_since: number;
  files_changed: number;
};
