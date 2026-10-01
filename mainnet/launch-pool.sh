#!/usr/bin/env bash
#
# Add ONE pool's vault to the shared multi-pool stack and configure it:
# preflight, deploy + wire, launch band + deposit path. Every owner role stays
# with the deploy key — ownership moves once, last, for all pools together:
#
#   ENV_FILE=.env.pools ./launch-pool.sh pools/atbtc-hollar.env    # repeat per pool
#   ENV_FILE=.env.pools npm run transfer-ownership                  # then once

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

export ENV_FILE="${ENV_FILE:-.env.pools}"
export POOL_FILE="${1:?usage: ./launch-pool.sh pools/<name>.env}"
[ -f "$ENV_FILE" ] || { echo "ERROR: shared configuration not found: $ENV_FILE" >&2; exit 1; }
[ -f "$POOL_FILE" ] || { echo "ERROR: pool configuration not found: $POOL_FILE" >&2; exit 1; }

step() { printf '\n========== %s ==========\n' "$*"; }

step "0/3 compile the contracts"
( cd .. && npx hardhat compile )

step "1/3 preflight ($POOL_FILE)"
node 00-preflight.js

step "2/3 deploy this pool's vault into the shared stack"
node 02-deploy.js

step "3/3 configure it: launch band and deposit path (no ownership moves)"
node 03-handover.js

cat <<'MSG'

This pool is configured; the deploy key still owns every contract.

Next:
  1. Repeat for every pool in STACK_POOLS.
  2. ENV_FILE=<shared> npm run transfer-ownership -- --check
  3. ENV_FILE=<shared> npm run transfer-ownership        (the single last step)
  4. Per pool: ENV_FILE=<shared> POOL_FILE=<pool> npm run verify
  5. Keeper: add keeper/vaults/<net>-<STACK>/<pool>.json to keeper/deploy/vaults.mainnet.json
     (pool 1 first; a list replaces the flat VAULT) and ship it as a new swarm config version
MSG
