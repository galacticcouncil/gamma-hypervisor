# gamma-ui deploy runbook

the ui is its own swarm stack, `gamma-ui`, beside the existing `gamma` stack
(play) or `gamma-keeper` stack (lark). it joins the keeper's overlay as an
external network to pull `/status` from the keeper and monitor listeners, and
`gateway` for traefik. nothing here changes the keeper's spec — the one keeper
restart in this programme is a host-side `docker service update`, by hand, in
section 4.

```
stack gamma      keeper  ─▶ status.ts :8787  (gamma_default only, no ports:, no gateway, no healthcheck)
                 monitor ─▶ status.ts :8788  (gamma_default only, guarded stack-level healthcheck from 0.4.0)
stack gamma-ui   ui :3000 ─▶ networks [gamma_default (external), gateway (external)]
                          ─▶ configs  gamma_vaults_v1 ─▶ /run/config/vaults.json
                          ─▶ volumes  db:/data  backup:/backup
traefik (gateway) ─▶ https://gamma.play.hydration.cloud
```

rules that hold for every step:

- never `update_stack gamma` from the committed `keeper/deploy/mainnet.stack.yml`
  until PR-0 lands: it carries a placeholder `PRIVATE_KEY` (fatal → restart
  loop), `DRY_RUN: 'true'`, `COMPOUND_ENABLED: 'false'` and an old image —
  none of which is what runs. per-service updates only.
- no agent calls `get_service_env`, `get_service_compose`, `get_stack_compose`,
  `list_stacks`, `update_service`, `update_service_env` or `create_secret`
  against `gamma_keeper` / stack `gamma`: they render the plaintext key (and the
  monitor's webhook) into transcripts, which are kept forever.
  `get_service_networks`, `list_service_tasks`, `service_logs` are fine.
- a `ports:` key on the keeper or monitor is a review blocker; so is any
  `HEALTHCHECK` in the keeper image or an unguarded one in the monitor image.
- the ui runs on a different rpc **provider** than the keeper (`rpc.hydradx.cloud`
  vs `hdx.tarn`), with the keeper's as `HEAD_FALLBACK_URL` for `eth_blockNumber`
  only. on lark (one node) `chainRpcShared` reads true by design.
- images are commit-pinned, built `--platform linux/amd64` from a laptop, swarmpit
  autoredeploy OFF on all three. `--prune` semantics do not apply (separate stacks).

## 1. build + push

```
# from the repo root — the ui imports keeper/src leaf modules; the root .dockerignore keeps everything else out
docker buildx build --platform linux/amd64 -f ui/Dockerfile \
  --build-arg COMMIT=$(git rev-parse --short HEAD) \
  -t galacticcouncil/gamma-ui:$(git rev-parse --short HEAD) --push .
```

keeper (`gamma-keeper:<sha>`) builds from `keeper/`, monitor
(`gamma-monitor:0.4.0`) from `monitor/`, exactly as their readmes say.

## 2. descriptor (out of band, once per change)

`keeper/deploy/vaults.mainnet.json` is checked in and carries no secret: every
`VAULT_KEY` written out, plus `LABEL`, `MONITOR_CLEARING`, `MONITOR_GRACE_SECS`,
`MONITOR_DIVERGENCE_BPS`, `UI_START_BLOCK`. every gate key is present per vault
(`ORACLE_ENABLED`, `TWAP_ENABLED`, `REGIME_ENABLED`, `LIMIT_REFRESH_ENABLED`,
`FOLD_ENABLED`) so the per-vault optional panels have a source.
`vaults.lark4.json` is the lark vault `0xFa45…62ae` with `ORACLE_ENABLED: false`.

`UI_START_BLOCK` is already derived and committed: `14363890`, the first block
the mainnet vault has code (binary search on `eth_getCode`, 2026-09-08) — create
the config as it stands, and re-derive only for a new vault. the `_note` key is
ignored by every loader.

```
docker config create gamma_vaults_v1 keeper/deploy/vaults.mainnet.json     # play
docker config create gamma_vaults_v1 keeper/deploy/vaults.lark4.json       # lark
```

`create_config gamma_vaults_v1` via the swarmpit tool is fine here — configs
carry no secret. swarm configs are immutable: on change create
`gamma_vaults_v2`, repoint `ui/deploy/*.stack.yml` (and later the monitor and
keeper services), redeploy.

the ui reads it from day one; the monitor from 0.5.0 (increment 6); the keeper
adopts `VAULTS_FILE` only when vault #2 ships. the current keeper's
`mergeVault` throws on `LABEL` / `MONITOR_*` / `UI_*`, so the keeper must not
mount the descriptor before increment 6 is in its image.

## 3. stack `gamma-ui`

play: `create_stack` via swarmpit-play with `ui/deploy/mainnet.stack.yml`,
`<sha>` replaced. lark: the same with `ui/deploy/lark4.stack.yml` on swarmpit-lark
(network `gamma-keeper_default`, `KEEPER_URL: http://gamma-keeper_keeper:8787`,
no `MONITOR_URL`).

- `KEEPER_URL` is set only once the keeper runs an image with the status listener
  and `STATUS_PORT=8787` (increment 3b); `MONITOR_URL` only once monitor 0.4.0
  is deployed (increment 2). unset, the columns read `not configured` (magenta)
  and the chain column works alone — that is the day-1 state.
- `deploy.labels`, not container labels (runbook-server-bootstrap.md:151-165).
  the reserves-gateway precedent (play.md:172: labels without the network = 504)
  is the check: the service must be on `gateway` as well as `gamma_default`.
- `replicas: 1`, `stop-first`: one sqlite writer.
- `METRICS_TOKEN` stays unset (overlay-only `/metrics`) or is set out of band.
- the basicauth labels are the one line away from gating the host; deliberately
  commented out (operator decision: public read-only).

cross-stack dns: `gamma_default` is `attachable: false`, so `docker run
--network` cannot debug it; verify with a one-off *service* on that network
before pointing the ui at the keeper:

```
docker service create --rm --network gamma_default --name probe alpine \
  sh -c 'wget -qO- http://gamma_keeper:8787/config | grep -cE "0x[0-9a-fA-F]{64}"; wget -qO- http://gamma_keeper:8787/status | head -c 300'
```

## 4. stack `gamma` — per-service updates only

### 4a. PR-0a — pin the live values, key-free (host, by hand, before PR-0)

on play over ssh:

```
docker service inspect gamma_keeper --format '{{json .Spec.TaskTemplate.ContainerSpec.Env}}' | tr ',' '\n' | grep -v -E 'PRIVATE_KEY|DISCORD_WEBHOOK'
docker service logs gamma_keeper --since 48h 2>&1 | grep -E '  gates|  oracle ' | head -2
```

write both outputs, dated, into the PR-0 header. the dev-cap question to close
here: wiki §7.3, the spec, the committed file, the monitor mirror and the
mockups all say `MAX_DEV_TICKS` / `ORACLE_MAX_DEV_TICKS` = 50; an earlier draft
claimed 100/200. commit exactly what the inspect says; if it really is 100/200,
PR-0 must also set the monitor's `ORACLE_MAX_DEV_TICKS` to match, and wiki §7.3
+ the mockups are corrected in the same change.

### 4b. PR-0 — mirror the running stack (non-secret keys only)

`keeper/deploy/mainnet.stack.yml`: image `2023ff3`, `RPC_URL:
https://hdx.tarn.hydration.cloud`, `MAX_DEV_TICKS` / `ORACLE_MAX_DEV_TICKS` as
pinned, `COMPOUND_ENABLED 'true'`, `DRY_RUN 'false'`; the monitor's
`DISCORD_WEBHOOK: ''` becomes a documented placeholder (`# set out of band; never
commit`). `PRIVATE_KEY` stays a placeholder until the cutover. header comment:
`mirror of the running spec, verified <date> on the host with: docker service
inspect gamma_keeper --format '{{json .Spec.TaskTemplate.ContainerSpec.Env}}' |
tr ',' '\n' | grep -v -E 'PRIVATE_KEY|DISCORD_WEBHOOK'` — not `get_service_env`.
then update `keeper/deploy/vaults.mainnet.json` to the same values (the ui's
`config-drift` finding shows any remaining gap against keeper `/config`).

### 4c. the single keeper restart (increment 3b) — host-side, by hand over ssh, never via mcp

preconditions, read from the docker log (the ui cannot see dwell before this
deploy):

```
docker service logs gamma_keeper --since 30m 2>&1 | grep -E 'arming|\+compound-due|submitting|skip: min interval|✓' | tail -20
```

must show **no `arming` line in the last 30 min** (nothing dwelling — as of
2026-09-18 05:45Z a limit refresh *was* dwelling, `arming refresh: 82/900
consecutive blocks`, spot 459 ticks past the limit: wait for its `✓ limit
refreshed` or for it to disarm) and cooldown remaining > 0 (a `skip: min
interval (Xs < Ys)` line, or the last `✓` less than `MIN_INTERVAL_SECS` ago; the
proxy's `lastRebalanceTs` survives the restart via `readProxyCaps`, in-memory
dwell does not). `lastCompoundTs` resets to 0 on boot, so the first block after
the restart may run a compound sweep — expected. then:

```
# play, ssh, human at the keyboard. the key file is written by hand, read once, shredded.
docker secret create gamma_keeper_key ./gamma_keeper_key.txt && shred -u ./gamma_keeper_key.txt
docker service update \
  --image galacticcouncil/gamma-keeper:<sha of master after PR #8 + status> \
  --secret-add gamma_keeper_key \
  --env-rm PRIVATE_KEY \
  --env-add PRIVATE_KEY_FILE=/run/secrets/gamma_keeper_key \
  --env-add STATUS_PORT=8787 \
  --env-add DWELL_SECS=2025 \
  gamma_keeper            # one update = one restart; PRIVATE_KEY + PRIVATE_KEY_FILE both set is a fatal boot (config.ts:385-389)
docker service logs gamma_keeper --since 2m 2>&1 | grep -E 'Gamma keeper|status|dwell|error'
# once healthy: a benign spec change so PreviousSpec no longer holds the inline key (service labels do not restart tasks)
docker service update --label-add com.hydration.cutover=<date> gamma_keeper
docker service inspect gamma_keeper --format '{{json .PreviousSpec.TaskTemplate.ContainerSpec.Env}}' | grep -c PRIVATE_KEY=0x   # → 0
```

`DWELL_BLOCKS` is left in place so a rollback to 2023ff3 keeps its semantics;
networks stay `[default]` only; **no `ports:`, no healthcheck**. afterwards
re-save the `gamma` stack file in the swarmpit ui from the committed PR-0 yml
(placeholder key), so swarmpit's stored stackfile no longer carries the inline
key either. lark rehearses the same commands with the anvil key first.

**what this is and is not.** moving the key to a secret is hygiene — it stops
the key rendering in swarmpit stack/env views and mcp dumps — not remediation:
the key has been readable to anyone with swarmpit access for weeks and is **not
rotated** (rotation = new signer via `RebalanceProxy.setRebalancer` + Admin
advisor, a ~7-day referendum); until the benign update runs, `PreviousSpec`
still holds it, and a `rollback_service gamma_keeper` to 2023ff3 re-exposes it
in the rendered env.

after the cutover, `KEEPER_URL` goes into the `gamma-ui` stack (section 3).

### 4d. monitor 0.4.0 (increment 2)

per-service update of `gamma_monitor` — prefer the host cli, since its env holds
the webhook (a `{$env}` reference keeps it out of a transcript if the tool is
used): image `gamma-monitor:0.4.0`, `STATUS_PORT: '8788'`, `FAIL_ALERT_CYCLES:
'3'`, `RPC_URL: https://rpc.hydradx.cloud` (off the keeper's provider), and the
stack-level healthcheck, guarded so a missing `STATUS_PORT` can never
restart-loop it:

```
test: ['CMD-SHELL', '[ "$${STATUS_PORT:-0}" = 0 ] || wget -q -O /dev/null http://127.0.0.1:$${STATUS_PORT}/healthz']
interval: 60s, timeout: 5s, retries: 3
```

expect currently-firing alerts to re-fire once (`firing` is in memory,
index.ts:39-43). then `MONITOR_URL` goes into the `gamma-ui` stack.
increment 6: `0.5.0`, `VAULTS_FILE: /run/config/vaults.json`, `configs:
[gamma_vaults_v1]`, per-vault env lines deleted; `KEEPER` / `GAS_*` /
`CHECK_INTERVAL_SECS` / `REALERT_SECS` / `RPC_URL` kept.

### 4e. top level, when the keeper adopts the descriptor (vault #2)

`configs: {gamma_vaults_v1: {external: true}}`, `secrets: {gamma_keeper_key:
{external: true}}`; `update_stack gamma` becomes safe only after PR-0, the
secret cutover and the swarmpit stackfile re-save.

## 5. verification (every deploy)

```
get_service_networks gamma_keeper      # exactly one network: gamma_default
get_service_networks gamma_monitor     # exactly one network
get_service_networks gamma-ui_ui       # gamma_default AND gateway (reserves-gateway precedent, play.md:172)
docker service logs traefik_proxy --since 5m | grep -i acme          # first request triggers LE
curl -s https://gamma.play.hydration.cloud/api/v1/status | jq '.sources, .vaults[0].chain.deposits'
curl -s https://gamma.play.hydration.cloud/api/v1/config | grep -cE '0x[0-9a-fA-F]{64}|gamma_keeper|gamma_monitor|/data/'   → 0
curl -s -o /dev/null -w '%{http_code}\n' https://gamma.play.hydration.cloud/metrics                                    → 404
# from a one-off *service* on gamma_default (the network is not attachable):
#   wget -qO- http://gamma_keeper:8787/config | grep -cE '0x[0-9a-fA-F]{64}'  → 0
#   wget -qO- http://gamma_keeper:8787/status | jq '.keeper.hookErrors, .keeper.listener'   → 0, small numbers
# on the host after the cutover:
docker service inspect gamma_keeper --format '{{json .Spec.TaskTemplate.ContainerSpec.Env}}' | grep -c 'PRIVATE_KEY=0x'   → 0
```

lark smoke = the same plus `curl gamma.lark.hydration.cloud/api/v1/status.txt`
rendering the fleet screen at 78 cols. mainnet smoke for 3b = `docker service
logs` byte-identical to the previous image apart from the `status :8787` banner
line, `hookErrors: 0` after one hour.

## 6. rollback

| what | how | cost |
|---|---|---|
| ui | redeploy the previous image tag; or `delete_stack gamma-ui` (volumes kept) | none |
| keeper 3b | `STATUS_PORT` unset (one restart) or `rollback_service gamma_keeper` → 2023ff3 (flat env compatible, `DWELL_BLOCKS` still present) | re-exposes the inline key in the rendered env until the benign update has run; no rotation either way; dwell/regime lost as on any restart |
| monitor | `rollback_service gamma_monitor` → 0.3.0; the ui tolerates unreachable | one re-alert window |

## 7. backups

nightly 03:30 utc `VACUUM INTO '/backup/gamma-<yyyymmdd>.db'` (plain sql, safe
under WAL, no sqlite3 binary needed) onto the `backup` volume, 14 kept.
restore = stop the ui, copy the file over `/data/gamma.db`, start. drill the
restore on lark once the first backup exists. resources: sqlite ≈ 1 GB/yr at 3
vaults with the stated retention; backups 14 × db size.

both volumes are `driver: local`, i.e. **node-local**: a reschedule onto another
swarm node starts on an empty db and leaves every backup on the old node. the
stack files carry a commented `placement.constraints` — uncomment it with the
node that holds the volumes on any swarm with more than one node, and treat the
backup volume as node-local storage, not as durable off-host backup.
