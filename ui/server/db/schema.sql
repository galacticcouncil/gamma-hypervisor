-- gamma-ui sqlite schema, v1. frozen: every later change is a forward-only
-- migration in db/index.ts MIGRATIONS (nullable columns only, so a rolled-back
-- image still opens the file). everything IF NOT EXISTS so boot is idempotent.

CREATE TABLE IF NOT EXISTS vaults (
  id TEXT PRIMARY KEY,               -- lowercase address
  label TEXT UNIQUE,
  pool TEXT,
  token0 TEXT,
  token1 TEXT,
  dec0 INT,
  dec1 INT,
  sym0 TEXT,
  sym1 TEXT,
  tick_spacing INT,
  entrypoint TEXT,
  start_block INT,
  first_seen_at INT,
  descriptor_json TEXT
);

-- restart / state-lost
CREATE TABLE IF NOT EXISTS keeper_runs (
  boot_at TEXT PRIMARY KEY,
  version TEXT,
  signer TEXT,
  dry_run INT,
  config_fingerprint TEXT,
  public_config_json TEXT,
  last_seen_at INT
);

-- every 5s poll, 30d
CREATE TABLE IF NOT EXISTS keeper_status (
  ts INT PRIMARY KEY,
  reachable INT,
  busy INT,
  busy_since INT,
  head INT,
  head_at INT,
  skipped INT,
  mode TEXT,
  hook_errors INT,
  slow_responses INT
);

-- every record, 72h
CREATE TABLE IF NOT EXISTS cycles_raw (
  id INTEGER PRIMARY KEY,
  vault_id TEXT,
  boot_at TEXT,
  seq INT,
  block INT,
  block_ts INT,
  received_at INT,
  record_json TEXT,
  UNIQUE (vault_id, boot_at, seq)
);
CREATE INDEX IF NOT EXISTS cycles_raw_vault_id ON cycles_raw (vault_id, id);
CREATE INDEX IF NOT EXISTS cycles_raw_vault_block_ts ON cycles_raw (vault_id, block_ts);

-- stored when any of (outcome_code, winner, armed_mask, gate_ok, gate_failed_at, regime,
-- compound_result, tx_hash, error) changed vs the previous record, plus a heartbeat every 300s. forever
CREATE TABLE IF NOT EXISTS cycles (
  id INTEGER PRIMARY KEY,
  vault_id TEXT,
  boot_at TEXT,
  seq INT,
  block INT,
  block_ts INT,
  evaluated_at INT,
  outcome_code TEXT,
  stage TEXT,
  winner TEXT,
  spot_tick INT,
  base_lower INT,
  base_upper INT,
  limit_lower INT,
  limit_upper INT,
  drift_ticks INT,
  armed_mask INT,                    -- 1 reb, 2 refresh, 4 fold
  dwell_reb_secs INT,
  dwell_ref_secs INT,
  dwell_fold_secs INT,
  cooldown_remaining_secs INT,
  gate_ok INT,
  gate_failed_at TEXT,
  gate_via TEXT,
  twap_tick INT,
  twap_dev INT,
  oracle_tick INT,
  oracle_dev INT,
  oracle_age INT,
  regime TEXT,
  compound_result TEXT,
  tx_hash TEXT,
  error TEXT,
  source TEXT,
  is_transition INT,
  record_json TEXT
);
CREATE INDEX IF NOT EXISTS cycles_vault_id ON cycles (vault_id, id);
CREATE INDEX IF NOT EXISTS cycles_vault_block_ts ON cycles (vault_id, block_ts);
CREATE INDEX IF NOT EXISTS cycles_vault_outcome_block_ts ON cycles (vault_id, outcome_code, block_ts);

-- standing runs; "how long"
CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY,
  vault_id TEXT,
  code TEXT,
  subcode TEXT,
  since_ts INT,
  until_ts INT,                      -- null = open
  first_seq INT,
  last_seq INT,
  cycles INT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS episodes_vault_since ON episodes (vault_id, since_ts);
CREATE INDEX IF NOT EXISTS episodes_vault_code_since ON episodes (vault_id, code, since_ts);
-- one open episode per vault. indexed on vault_id alone: sqlite treats NULLs as
-- distinct, so (vault_id, until_ts) would enforce nothing on open rows
CREATE UNIQUE INDEX IF NOT EXISTS episodes_open ON episodes (vault_id) WHERE until_ts IS NULL;

-- 7d, prefix-free
CREATE TABLE IF NOT EXISTS keeper_lines (
  id INTEGER PRIMARY KEY,
  vault_id TEXT,
  ts INT,
  line TEXT
);
CREATE INDEX IF NOT EXISTS keeper_lines_vault_ts ON keeper_lines (vault_id, ts);

CREATE TABLE IF NOT EXISTS regimes (
  id INTEGER PRIMARY KEY,
  vault_id TEXT,
  ts INT,
  block INT,
  from_regime TEXT,
  to_regime TEXT,
  reason TEXT
);

CREATE TABLE IF NOT EXISTS txs (
  hash TEXT PRIMARY KEY,
  vault_id TEXT,
  kind TEXT,                         -- recenter refresh fold compound unknown
  block INT,
  ts INT,
  from_addr TEXT,
  gas_used INT,
  gas_price_wei TEXT,
  cost_wei TEXT,
  status INT,
  tick INT,
  total0 TEXT,
  total1 TEXT,
  supply TEXT,
  base_lower INT,
  base_upper INT,
  limit_lower INT,
  limit_upper INT,
  fee_recipient TEXT,
  full_range INT,
  foreign_recipient INT,
  plan_json TEXT,                    -- after landing
  receipt_json TEXT
);
CREATE INDEX IF NOT EXISTS txs_vault_ts ON txs (vault_id, ts);

CREATE TABLE IF NOT EXISTS chain_events (
  tx_hash TEXT,
  log_index INT,
  vault_id TEXT,
  block INT,
  ts INT,
  kind TEXT,                         -- Rebalance ZeroBurn Deposit Withdraw
  args_json TEXT,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS chain_events_vault_kind_ts ON chain_events (vault_id, kind, ts);

-- 60s, 90d
CREATE TABLE IF NOT EXISTS samples (
  vault_id TEXT,
  ts INT,
  block INT,
  spot_tick INT,
  sqrt_price_x96 TEXT,
  price_human REAL,
  total0 TEXT,
  total1 TEXT,
  supply TEXT,
  max_total_supply TEXT,
  nav1 REAL,
  share_price REAL,
  x REAL,
  base_lower INT,
  base_upper INT,
  limit_lower INT,
  limit_upper INT,
  in_base INT,
  in_limit INT,
  base_liq TEXT,
  base_amt0 TEXT,
  base_amt1 TEXT,
  limit_liq TEXT,
  limit_amt0 TEXT,
  limit_amt1 TEXT,
  fees0 TEXT,                        -- every 5th sample, with fees1/fees1_value/idle0/idle1
  fees1 TEXT,
  fees1_value REAL,
  idle0 TEXT,
  idle1 TEXT,
  oracle_tick INT,
  oracle_price REAL,
  oracle_age INT,
  twap_tick INT,
  twap_window INT,
  gate_ok INT,
  gate_failed_at TEXT,
  proxy_last_rebalance_ts INT,
  gas_wei TEXT,
  pool_liq TEXT,
  fee_divisor INT,
  fee_protocol INT,
  reserve_paused INT,
  clearing_twap_check INT,
  clearing_threshold INT,
  clearing_dev_bps INT,
  deposits_open INT,
  PRIMARY KEY (vault_id, ts)
);

-- forever
CREATE TABLE IF NOT EXISTS samples_1h (
  vault_id TEXT,
  ts INT,
  n INT,
  price_last REAL,
  nav1_last REAL,
  share_price_last REAL,
  share_price_min REAL,
  share_price_max REAL,
  x_avg REAL,
  in_base_frac REAL,
  in_limit_frac REAL,
  fees1_value_last REAL,
  gas_wei_last TEXT,
  PRIMARY KEY (vault_id, ts)
);

CREATE TABLE IF NOT EXISTS findings (
  id INTEGER PRIMARY KEY,
  vault_id TEXT,                     -- null = global
  source TEXT,                       -- monitor | ui
  key TEXT,
  severity TEXT,
  title TEXT,
  detail TEXT,
  onset_ts INT,
  last_seen_ts INT,
  cleared_ts INT
);
CREATE INDEX IF NOT EXISTS findings_vault_onset ON findings (vault_id, onset_ts);
CREATE INDEX IF NOT EXISTS findings_cleared ON findings (cleared_ts);

CREATE TABLE IF NOT EXISTS source_health (
  id INTEGER PRIMARY KEY,
  source TEXT,                       -- keeper monitor rpc rpc-fallback
  since_ts INT,
  until_ts INT,
  reachable INT,
  detail TEXT
);

-- sse replay, 30d
CREATE TABLE IF NOT EXISTS events_log (
  id INTEGER PRIMARY KEY,
  ts INT,
  vault_id TEXT,
  kind TEXT,
  ref_id TEXT,
  payload_json TEXT
);

-- schema_version, backfill cursor per vault (from,to,done), descriptor_sha256,
-- last keeper /config, keeper cursor per vault (boot_at, seq), last_backup_at
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);
