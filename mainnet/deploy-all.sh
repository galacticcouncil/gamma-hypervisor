#!/usr/bin/env bash
#
# Deploy the EVM portion of the Gamma launch. Governance is intentionally not
# submitted here: the seed is a separate, later referendum, and this script
# stops once the vault is live, empty and handed to governance.
#
# Lark and chopsticks forks are treated EXACTLY the same as mainnet — only the
# RPC env differs. Every step is idempotent and safe to re-run.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

export ENV_FILE="${ENV_FILE:-.env.mainnet}"
[ -f "$ENV_FILE" ] || { echo "ERROR: configuration file not found: $ENV_FILE" >&2; exit 1; }

step() { printf '\n========== %s ==========\n' "$*"; }

step "0/4 compile the contracts"
( cd .. && npx hardhat compile )

step "1/4 preflight"
node 00-preflight.js

step "2/4 deploy and wire the Gamma stack"
node 02-deploy.js

step "3/4 hand every owner role to governance"
node 03-handover.js

step "4/4 verify"
node 04-verify.js

cat <<'MSG'

The vault is live, empty and capped. No governance transaction was submitted.

Next:
  1. Start the keeper. It keeps the band centred on the tick, and ClearingV2
     rejects any deposit taken while the tick sits outside that band.
  2. Print the seed proposal:  ENV_FILE=<this file> npm run governance -- seed
  3. Submit that exact preimage on the track it prints (track 5, treasurer).
  4. After enactment:          ENV_FILE=<this file> npm run verify
                               ENV_FILE=<this file> npm run verify -- events <block> <count>
MSG
