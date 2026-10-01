# gamma ui

read-only dashboard and `/api/v1` for the gamma keeper fleet. one express
process serves the api, a sveltekit ssr page and sqlite history. it holds no
key, never writes chain, emits nothing outbound; agents pull json / sse.

a DOS text-mode application on purpose: tuicss + Perfect DOS VGA 437, 78-col
box art, f-keys, eight colour schemes (F9). the tui layer is vendored from the
uncommitted rpc-status working tree; provenance, hashes and licences are in
`static/tuicss/ORIGIN.md` (never hand-edit those files — re-vendor).

```
vaults.json ─▶ ui  ─▶ own rpc (never the keeper's)      "chain says", as of #block
               ├──▶ keeper :8787 /status /events (overlay) "keeper says"
               ├──▶ monitor :8788 /status (overlay)        findings
               └──▶ sqlite /data/gamma.db                  cycles · txs · samples · episodes
traefik ─▶ https://gamma.<host>.hydration.cloud ─▶ human (browser) · agent (curl / mcp)
```

the contract is zod, once: `server/contract/types.ts` + `enums.ts`, with the
keeper's `CycleRecord` v1 imported as `@keeper/record` (`../keeper/src`), so
`/api/v1/schema` cannot drift from the serialiser.

## env

| var | default | meaning |
|---|---|---|
| `PORT` | `3000` | http port |
| `RPC_URL` | required | the ui's own evm rpc — a different provider than the keeper's; host-only in every response, never logged |
| `HEAD_FALLBACK_URL` | — | second head source (`eth_blockNumber` every 30s) for the `stalled` rule; may be the keeper's provider |
| `VAULTS_FILE` | `/run/config/vaults.json` | the shared descriptor (`keeper/deploy/vaults.<env>.json` as docker config `gamma_vaults_v1`) |
| `KEEPER_URL` | — | `http://gamma_keeper:8787`; unset → keeper column `not configured`; never echoed |
| `MONITOR_URL` | — | `http://gamma_monitor:8788`; unset on lark; never echoed |
| `KEEPER_POLL_MS` / `MONITOR_POLL_MS` | `5000` / `60000` | |
| `SAMPLE_SECS` / `FEES_EVERY_N` | `60` / `5` | sampler cadence; fees/idle every nth sample |
| `EVENTS_SECS` / `BACKFILL_CHUNK_BLOCKS` | `60` / `2000` | indexer; chunk halves on `-32603`/timeout (floor 250) |
| `DB_PATH` / `BACKUP_DIR` | `/data/gamma.db` / `/backup` | nightly `VACUUM INTO`, keep 14 |
| `RAW_RETENTION_HOURS` / `SAMPLE_RETENTION_DAYS` | `72` / `90` | 0 disables raw retention |
| `RATE_LIMIT` / `SSE_PER_IP` | `60/10s` / `2` | per ip |
| `METRICS_TOKEN` | — | `/metrics` answers only to overlay source ips or `X-Metrics-Token` |
| `PUBLIC_URL` / `ORIGIN` | — | `servers[]` in openapi.json, title bar; `ORIGIN` = adapter-node's origin behind traefik (set equal to `PUBLIC_URL`) |
| `COMMIT` | build arg | shown in `/api/v1` and the title bar; baked into the image by `--build-arg COMMIT=` |

empty strings count as unset (swarm renders missing vars as `''`).

## layout

```
ui/
├─ Dockerfile         two-stage node:22.22-alpine; context = REPO ROOT (needs keeper/src)
├─ deploy/            mainnet.stack.yml (play) · lark4.stack.yml (lark) · README.md runbook
├─ server/            tsx at runtime
│  ├─ config.ts       zod env (table above); loadConfig / getConfig / publicConfig / hostOf
│  ├─ contract/       types.ts (every public zod type) · enums.ts (every closed vocabulary) · glyphs.ts
│  └─ db/             schema.sql (v1, frozen) · index.ts (node:sqlite, WAL, migrations, meta)
├─ src/               sveltekit page
├─ static/tuicss/     vendored font + css + ORIGIN.md + licence
└─ test/              vitest, test/**/*.spec.ts (docker.spec runs only with DOCKER_SMOKE=1)
```

## dev

```
npm install
RPC_URL=https://rpc.hydradx.cloud DB_PATH=/tmp/gamma.db npm run dev
npm run typecheck && npm test && npm run build
```

`@keeper/*` resolves to `../keeper/src` in `tsconfig.json` (tsc, tsx) and in
`vite.config.js` (vite does not read tsconfig paths). the container keeps the
same `ui/` + `keeper/src` sibling layout.

## api

`/api/v1` is the discovery document. every body carries `v: 1` and
`generatedAt`; GET only (405 otherwise); weak etags + `If-None-Match` → 304;
`since=` cursors with `{items, next, complete}`; `null` = known-unknown, absent
key = not applicable; `*Ts` unix seconds, `*At` iso, `*Wei` decimal string,
`*Bps` int, `*Frac` in [0,1]. errors are `{v, error:{code, message, hint}}` and
never echo upstream urls; `/status` never 5xx's because a source is down
(`sources.*.reachable=false`, 200). `Accept: text/plain` or `.txt` on `/status`
and `/vaults/{id}` renders the 78-col screen.

| path | purpose |
|---|---|
| `/api/v1` | discovery: endpoints, `schema`, `openapi`, `stream`, `conventions{units}`, `enums` |
| `/api/v1/status[.txt]` | the one call: `sources{keeper, monitor, chain}`, `keeper{mode, signer, gas, liveness}`, `vaults[VaultV1]`, `findings[]`; `?vault=`, `?compact=1` |
| `/api/v1/vaults` | `[{id, label, pool, token0, token1, tickSpacing, entrypoint}]` |
| `/api/v1/vaults/{id}[.txt]` | full VaultV1 + last 20 cycles + last 10 txs; `{id}` = lowercase address or label slug |
| `/api/v1/vaults/{id}/gates` | every gate as reading vs limit, as-of vs keeper-saw, `holding` |
| `/api/v1/vaults/{id}/cycles` | CycleRecords; `since, limit, order, outcome=<code[,code]>, raw=1` |
| `/api/v1/vaults/{id}/episodes` | standing runs — how long blocked; `active=1`, `code=` |
| `/api/v1/vaults/{id}/txs` | receipts with `costWei`, `kind`, compromise flags; `kind=`, `since=` |
| `/api/v1/vaults/{id}/flows` | Deposit / Withdraw + `{deposits, withdrawals, depositors, supply}` |
| `/api/v1/vaults/{id}/samples` | `from, to, step=60\|300\|3600\|86400, fields=`; max 5000 points, 90d |
| `/api/v1/vaults/{id}/economics` | `window=24h\|7d\|30d\|launch\|<from>..<to>`; both hodl benchmarks; fees/il under `experimental` |
| `/api/v1/vaults/{id}/log` | keeper log ring pass-through, redacted a second time |
| `/api/v1/vaults/{id}/events` | merged timeline: cycle regime standing finding tx deposit withdraw zero-burn config source |
| `/api/v1/findings` | monitor + ui-derived findings with onset; `active=1`, `since=`, `vault=` |
| `/api/v1/config` | keeper `/config` (redacted, `source: keeper\|cache`), descriptor, `drift[]`, monitor thresholds, ui `{keeper:{configured}, monitor:{configured}, rpcHost, chainRpcShared}` |
| `/api/v1/monitor` | monitor `/status` normalised |
| `/api/v1/queries[/{name}]` | named prepared statements, zod params (`vault, from, to ≤90d, limit ≤5000`); no free-form sql |
| `/api/v1/stream` | sse `?vault=&events=`; `Last-Event-ID` replay ≤1000; `: ping` 15s; 32 clients global, 2 per ip, 10 connects/min per ip |
| `/api/v1/schema` · `/api/v1/openapi.json` | json schema 2020-12 `$defs` and openapi 3.1 from the same zod |
| `/healthz` | 200/503: sqlite writable and at least one collector ticked in 5 min |
| `/metrics` | prom-client gauges `{vault}`; overlay source ips or `X-Metrics-Token` only — traefik gets 404 |

## deliberate gaps

what the screens leave blank on purpose, so a `-` is never read as a bug:

- `vol ratio` reading/`keeper.regime.inputs.volRatio`: the keeper publishes the
  volatility **baseline** (`state.volBaseline.median`), never the ratio it
  compares against, so the gate row shows the median and `ratio: null` until the
  keeper records it (increment 7). the `calm`/`elevated` word still comes from
  the keeper's own regime.
- liveness `alive`: the plan's "head age ≤ 3×poll" is not a state of its own. a
  frozen keeper head only renders `stalled` when the ui's own head or the
  fallback head advanced (two providers, `derive/standing.ts`) — a shared outage
  must not be reported as a keeper fault. long busy is `acting` (> 5 min) and
  then `stalled` (> 10 min).
- `costSource: estimate`: cost per tx falls back to `gas × eth_gasPrice × 1.2`
  (815k recenter / 643k compound) until a recenter receipt exists; the gas price
  is sampled once per chain pass into `meta:chain:gasPriceWei`.
- `pool`/`token.address`/`token.decimals` are `null` until the descriptor's
  identity read lands — never `0x000…0`.

## build / docker

the image is built from the **repo root**, not from `ui/`: the server imports
`../keeper/src`, and the root `.dockerignore` (a whitelist: `ui/**`,
`keeper/src/**`, `keeper/package.json`, minus `node_modules`, `.env*`, `build`,
`.svelte-kit`, `*.db*`) keeps the hardhat tree and any local `.env` out of the
context. `keeper/` and `monitor/` build from their own directories and never
read that file.

```
docker buildx build --platform linux/amd64 -f ui/Dockerfile \
  --build-arg COMMIT=$(git rev-parse --short HEAD) \
  -t galacticcouncil/gamma-ui:$(git rev-parse --short HEAD) --push .
```

two stages on `node:22.22-alpine` (node:sqlite loads unflagged there):
`npm ci` without `NODE_ENV=production` (tsx is needed at runtime, vite at build),
`npm run build`, then a runtime stage with `build/`, `server/`, `node_modules`,
`package.json`, `tsconfig.json` and `/app/keeper/{package.json,src}` beside
`/app/ui`. `/app/node_modules` is a symlink to `/app/ui/node_modules` so the
keeper modules' bare `zod`/`ethers` imports resolve. runs as user `ui`;
`/data` and `/backup` are created and chown'd **before** `VOLUME` so a fresh
named volume is writable; `NODE_OPTIONS=--disable-warning=ExperimentalWarning`;
`EXPOSE 3000`; `HEALTHCHECK` on `/healthz`; `CMD tsx server/index.ts`.
commit-pinned tags, swarmpit autoredeploy off.

## deploy

the ui is its **own swarm stack `gamma-ui`** (`deploy/mainnet.stack.yml` on
play, `deploy/lark4.stack.yml` on lark) joined to the external keeper overlay
(`gamma_default` / `gamma-keeper_default`) and to `gateway` for traefik. the
descriptor is the external docker config `gamma_vaults_v1`; the db and backups
are the stack's two volumes. the runbook — including the one host-side keeper
restart this programme allows — is `deploy/README.md`.

**the ui is the only gamma service ever on `gateway`, and no keeper or monitor
port is ever published.** the keeper and monitor stay on the stack-private
overlay with no `ports:` key; the ui reaches them by stack-qualified name
(`gamma_keeper:8787`, `gamma_monitor:8788`). a `ports:` key on either, or the
keeper on `gateway`, is a review blocker. the ui runs on a different rpc
provider than the keeper so a frozen node cannot blind both; `chainRpcShared`
in `/api/v1/config` says when that rule is broken.

verification after every deploy:

```
get_service_networks gamma_keeper      # exactly one network: gamma_default
get_service_networks gamma_monitor     # exactly one network
get_service_networks gamma-ui_ui       # gamma_default AND gateway
docker service logs traefik_proxy --since 5m | grep -i acme          # first request triggers LE
curl -s https://gamma.play.hydration.cloud/api/v1/status | jq '.sources, .vaults[0].chain.deposits'
curl -s https://gamma.play.hydration.cloud/api/v1/config | grep -cE '0x[0-9a-fA-F]{64}|gamma_keeper|gamma_monitor|/data/'   → 0
curl -s -o /dev/null -w '%{http_code}\n' https://gamma.play.hydration.cloud/metrics                                    → 404
curl -s https://gamma.play.hydration.cloud/api/v1/status.txt | awk '{ if (length($0) != 78) bad++ } END { print bad+0 }'  → 0
```

## tests

`npm test` runs every `test/**/*.spec.ts`: db, contract (sentinel-key redaction
on every route and the stream, tx hashes survive), keeper-contract, derive,
text (every rendered line 78 cols + glyph whitelist), ssr. `test/docker.spec.ts`
is skipped unless `DOCKER_SMOKE=1`: it builds the image from the repo root,
starts it on an empty anonymous volume with only `RPC_URL` set and waits for
`/healthz` 200 — the check that pins volume ownership and the non-root user.

```
DOCKER_SMOKE=1 npx vitest run test/docker.spec.ts
```

## tui assets

`static/tuicss/` is copied from the uncommitted `galacticcouncil/rpc-status`
working tree (a565558, 2026-09-18): TuiCss 2.1.2 (MIT, `LICENSE-tuicss.md`)
and Zeh Fernando's Perfect DOS VGA 437 (freeware, his readme in `fonts/`).
`ORIGIN.md` lists sha256 per file and the upstream blobs. the font has 255
code points; what it cannot draw (`► ◄ ▲ ▼ • ○ ● ↑ ↓ → ← ✓ ✗ ⚠ — … ×`) is
mapped at render time by `server/contract/glyphs.ts` and rejected by the text
test. once rpc-status commits its tree (PR-0b), `ORIGIN.md` points at that
commit instead of a working tree.
