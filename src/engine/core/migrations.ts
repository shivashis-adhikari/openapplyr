/**
 * Schema migrations. Each entry runs once, in order, inside a transaction; PRAGMA user_version
 * records how many have been applied. Never edit a shipped migration: append a new one.
 * Timestamps are epoch milliseconds. JSON columns are validated with zod where they are read.
 */
export const MIGRATIONS: string[] = [
  /* 1: initial schema */ `
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE secrets (
  id INTEGER PRIMARY KEY,
  ciphertext BLOB NOT NULL,
  iv BLOB NOT NULL,
  tag BLOB NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE providers (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  base_url TEXT,
  config TEXT NOT NULL DEFAULT '{}',
  secret_id INTEGER REFERENCES secrets(id) ON DELETE SET NULL,
  models TEXT NOT NULL DEFAULT '[]',
  capabilities TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE model_roles (
  role TEXT PRIMARY KEY,
  provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL
);

CREATE TABLE model_prices (
  provider_kind TEXT NOT NULL,
  model_id TEXT NOT NULL,
  input_per_m REAL NOT NULL,
  output_per_m REAL NOT NULL,
  PRIMARY KEY (provider_kind, model_id)
);

CREATE TABLE ai_ledger (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  provider_id INTEGER,
  provider_kind TEXT,
  model_id TEXT,
  role TEXT,
  task TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cached_tokens INTEGER,
  cost REAL,
  ok INTEGER NOT NULL,
  error TEXT
);
CREATE INDEX ai_ledger_at ON ai_ledger(at);

CREATE TABLE ai_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, created_at INTEGER NOT NULL);

CREATE TABLE integrations (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL UNIQUE,
  config TEXT NOT NULL DEFAULT '{}',
  secret_id INTEGER REFERENCES secrets(id) ON DELETE SET NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE profile (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL, source_text TEXT, updated_at INTEGER NOT NULL);
CREATE TABLE voice (id INTEGER PRIMARY KEY CHECK (id = 1), description TEXT NOT NULL DEFAULT '', samples TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL);

CREATE TABLE companies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  name_norm TEXT NOT NULL,
  domain TEXT,
  ats TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  h1b TEXT,
  watched INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0,
  staffing INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX companies_name_norm ON companies(name_norm);

CREATE TABLE sources (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  config TEXT NOT NULL DEFAULT '{}',
  cursor TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  origin TEXT NOT NULL DEFAULT 'registry',
  last_polled_at INTEGER,
  next_poll_at INTEGER NOT NULL DEFAULT 0,
  last_ok_at INTEGER,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  job_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX sources_kind_key ON sources(kind, key);
CREATE INDEX sources_due ON sources(enabled, next_poll_at);

CREATE TABLE jobs (
  id INTEGER PRIMARY KEY,
  group_id INTEGER,
  source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
  source_kind TEXT NOT NULL,
  external_id TEXT NOT NULL,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  company_name TEXT NOT NULL,
  title TEXT NOT NULL,
  title_norm TEXT NOT NULL,
  seniority TEXT,
  employment_type TEXT,
  contract_type TEXT,
  remote TEXT NOT NULL DEFAULT 'unknown',
  locations TEXT NOT NULL DEFAULT '[]',
  location_text TEXT,
  salary TEXT,
  salary_annual_min REAL,
  salary_annual_max REAL,
  salary_currency TEXT,
  url TEXT NOT NULL,
  apply_url TEXT,
  apply_ats TEXT,
  description_md TEXT NOT NULL DEFAULT '',
  description_html TEXT,
  posted_at INTEGER,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  closed_at INTEGER,
  repost_count INTEGER NOT NULL DEFAULT 0,
  signals TEXT NOT NULL DEFAULT '[]',
  meta TEXT NOT NULL DEFAULT '{}',
  hash TEXT NOT NULL,
  user_state TEXT,
  skip_reason TEXT,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX jobs_source_ext ON jobs(source_kind, external_id);
CREATE INDEX jobs_group ON jobs(group_id);
CREATE INDEX jobs_company ON jobs(company_id);
CREATE INDEX jobs_first_seen ON jobs(first_seen_at);
CREATE INDEX jobs_closed ON jobs(closed_at);

CREATE VIRTUAL TABLE jobs_fts USING fts5(
  title, company_name, description_md,
  content='jobs', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER jobs_fts_ai AFTER INSERT ON jobs BEGIN
  INSERT INTO jobs_fts(rowid, title, company_name, description_md) VALUES (new.id, new.title, new.company_name, new.description_md);
END;
CREATE TRIGGER jobs_fts_ad AFTER DELETE ON jobs BEGIN
  INSERT INTO jobs_fts(jobs_fts, rowid, title, company_name, description_md) VALUES ('delete', old.id, old.title, old.company_name, old.description_md);
END;
CREATE TRIGGER jobs_fts_au AFTER UPDATE OF title, company_name, description_md ON jobs BEGIN
  INSERT INTO jobs_fts(jobs_fts, rowid, title, company_name, description_md) VALUES ('delete', old.id, old.title, old.company_name, old.description_md);
  INSERT INTO jobs_fts(rowid, title, company_name, description_md) VALUES (new.id, new.title, new.company_name, new.description_md);
END;

CREATE TABLE hunts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'review',
  config TEXT NOT NULL,
  base_resume_id INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE job_scores (
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  hunt_id INTEGER NOT NULL REFERENCES hunts(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  passed INTEGER NOT NULL,
  reasons TEXT NOT NULL DEFAULT '[]',
  prefilter REAL,
  score REAL,
  breakdown TEXT,
  judgment TEXT,
  prompt_version TEXT,
  model TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (job_id, hunt_id)
);
CREATE INDEX job_scores_hunt ON job_scores(hunt_id, stage, score);

CREATE TABLE feedback (
  id INTEGER PRIMARY KEY,
  job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
  hunt_id INTEGER REFERENCES hunts(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE resumes (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  base_id INTEGER REFERENCES resumes(id) ON DELETE SET NULL,
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  template_id TEXT NOT NULL,
  page_size TEXT NOT NULL DEFAULT 'Letter',
  pdf_path TEXT,
  docx_path TEXT,
  factlock TEXT,
  review TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE cover_letters (
  id INTEGER PRIMARY KEY,
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  plan TEXT,
  style TEXT,
  pdf_path TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE answers (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  kind TEXT NOT NULL,
  scope_company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  used_count INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX answers_key_scope ON answers(key, IFNULL(scope_company_id, 0));

CREATE TABLE form_specs (
  board_key TEXT PRIMARY KEY,
  spec TEXT NOT NULL,
  captured_at INTEGER NOT NULL
);

CREATE TABLE packages (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  hunt_id INTEGER REFERENCES hunts(id) ON DELETE SET NULL,
  resume_id INTEGER REFERENCES resumes(id) ON DELETE SET NULL,
  cover_letter_id INTEGER REFERENCES cover_letters(id) ON DELETE SET NULL,
  answers TEXT NOT NULL DEFAULT '[]',
  questions TEXT NOT NULL DEFAULT '[]',
  outreach TEXT,
  gates TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  error TEXT,
  cost REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE UNIQUE INDEX packages_job_live ON packages(job_id) WHERE status IN ('preparing', 'ready', 'approved');

CREATE TABLE applications (
  id INTEGER PRIMARY KEY,
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  group_key TEXT NOT NULL,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  company_name TEXT NOT NULL,
  title TEXT NOT NULL,
  hunt_id INTEGER REFERENCES hunts(id) ON DELETE SET NULL,
  package_id INTEGER REFERENCES packages(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'ats',
  method TEXT,
  url TEXT,
  applied_at INTEGER,
  confirmation TEXT,
  evidence_dir TEXT,
  notes TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0,
  last_activity_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX applications_group_live ON applications(group_key) WHERE archived = 0;
CREATE INDEX applications_status ON applications(status, archived);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  at INTEGER NOT NULL,
  source TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX events_app ON events(application_id, at);
CREATE INDEX events_type ON events(type, at);

CREATE TABLE runs (
  id INTEGER PRIMARY KEY,
  application_id INTEGER REFERENCES applications(id) ON DELETE CASCADE,
  package_id INTEGER REFERENCES packages(id) ON DELETE SET NULL,
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  adapter TEXT,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  question TEXT,
  steps TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX runs_status ON runs(status);

CREATE TABLE ats_accounts (
  id INTEGER PRIMARY KEY,
  host TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL,
  secret_id INTEGER NOT NULL REFERENCES secrets(id),
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE contacts (
  id INTEGER PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  company_name TEXT,
  name TEXT NOT NULL,
  title TEXT,
  relation TEXT NOT NULL DEFAULT 'other',
  email TEXT,
  email_status TEXT NOT NULL DEFAULT 'unknown',
  linkedin_url TEXT,
  source TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  do_not_contact INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_contacted_at INTEGER
);
CREATE UNIQUE INDEX contacts_email ON contacts(lower(email)) WHERE email IS NOT NULL;

CREATE TABLE outreach (
  id INTEGER PRIMARY KEY,
  application_id INTEGER REFERENCES applications(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  step INTEGER NOT NULL DEFAULT 0,
  purpose TEXT NOT NULL,
  subject TEXT,
  body TEXT NOT NULL,
  attach_resume INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  scheduled_at INTEGER,
  sent_at INTEGER,
  message_id TEXT,
  thread_key TEXT,
  account_id INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX outreach_due ON outreach(status, scheduled_at);
CREATE INDEX outreach_contact ON outreach(contact_id);

CREATE TABLE mail_accounts (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  address TEXT NOT NULL UNIQUE,
  display_name TEXT,
  config TEXT NOT NULL,
  secret_id INTEGER REFERENCES secrets(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'ok',
  status_detail TEXT,
  daily_cap INTEGER NOT NULL DEFAULT 20,
  last_sync_at INTEGER,
  cursor TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE mail_messages (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  folder TEXT,
  uid INTEGER,
  message_id TEXT NOT NULL,
  in_reply_to TEXT,
  refs TEXT NOT NULL DEFAULT '[]',
  from_addr TEXT,
  from_name TEXT,
  to_addrs TEXT NOT NULL DEFAULT '[]',
  subject TEXT,
  date INTEGER,
  snippet TEXT,
  direction TEXT NOT NULL,
  classification TEXT,
  application_id INTEGER REFERENCES applications(id) ON DELETE SET NULL,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  needs_review INTEGER NOT NULL DEFAULT 0,
  handled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX mail_messages_mid ON mail_messages(account_id, message_id);
CREATE INDEX mail_messages_app ON mail_messages(application_id);

CREATE TABLE interviews (
  id INTEGER PRIMARY KEY,
  application_id INTEGER REFERENCES applications(id) ON DELETE CASCADE,
  starts_at INTEGER,
  ends_at INTEGER,
  kind TEXT NOT NULL DEFAULT 'other',
  location TEXT,
  link TEXT,
  interviewers TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE prep_items (
  id INTEGER PRIMARY KEY,
  application_id INTEGER REFERENCES applications(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE stories (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  situation TEXT NOT NULL DEFAULT '',
  task TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL DEFAULT '',
  fact_ids TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE chats (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  ref_id INTEGER,
  title TEXT NOT NULL DEFAULT '',
  messages TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE offers (
  id INTEGER PRIMARY KEY,
  application_id INTEGER REFERENCES applications(id) ON DELETE SET NULL,
  company TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  dedupe_key TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  run_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  last_error TEXT,
  locked_at INTEGER,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX tasks_due ON tasks(status, run_at, priority);
CREATE UNIQUE INDEX tasks_dedupe ON tasks(dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('pending', 'running');

CREATE TABLE notifications (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  route TEXT,
  created_at INTEGER NOT NULL
);
`,
  /* 2: document checks */ `
ALTER TABLE resumes ADD COLUMN keywords TEXT;
ALTER TABLE resumes ADD COLUMN ats TEXT;
ALTER TABLE cover_letters ADD COLUMN template_id TEXT;
`,
]
