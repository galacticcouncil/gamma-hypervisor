/**
 * e2e.js  —  phase 2 orchestrator. Deploys the Gamma stack onto the Uniswap v3
 * from phase 1, then runs the LP + swap smoke. Requires the phase-1 zombienet to
 * be running and uniswap-v3-deploy/zombienet/deployments/zombienet.json to exist.
 *
 *   node zombienet/e2e.js   (from the gamma repo root, or anywhere)
 *
 * The deploy/smoke steps are hardhat .ts scripts run via `npx hardhat run`.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO = path.join(__dirname, "..");
const UNI = process.env.UNISWAP_DEPLOYMENTS || path.join(__dirname, "../../uniswap-v3-deploy/zombienet/deployments/zombienet.json");
const RPC = process.env.EVM_RPC_URL || "http://127.0.0.1:9999";

async function rpcUp() {
  try {
    const r = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
    });
    return !!(await r.json()).result;
  } catch {
    return false;
  }
}

async function main() {
  console.log("=== Gamma on local zombienet — phase 2 ===");
  if (!fs.existsSync(path.join(REPO, "node_modules"))) {
    throw new Error(`run 'npm install --legacy-peer-deps' in ${REPO}`);
  }
  if (!fs.existsSync(UNI)) throw new Error(`uniswap deployments not found: ${UNI} (run phase 1 first)`);
  if (!(await rpcUp())) throw new Error(`no EVM RPC at ${RPC} — is the phase-1 zombienet running?`);

  const run = (args) =>
    execFileSync("npx", args, { cwd: REPO, stdio: "inherit", env: { ...process.env, UNISWAP_DEPLOYMENTS: UNI } });

  console.log("[1/4] Compiling Gamma contracts (solc 0.7.6)...");
  run(["hardhat", "compile"]);

  console.log("[2/4] Deploying Gamma stack (bootstrap posture)...");
  run(["hardhat", "run", "zombienet/deploy-gamma.ts", "--network", "zombienet"]);

  // Guards go up BEFORE any money is in the vault: the initial base range is set
  // while the vault is empty, so that rebalance deploys no liquidity and its
  // zero slippage mins are genuinely inert. Then deposits route through
  // UniProxy/ClearingV2 and the vault is owned by Admin, so the keeper is
  // bounded by RebalanceProxy's caps.
  // SKIP_OWNERSHIP=true keeps the local owner key usable for Model A experiments.
  console.log("[3/4] Configuring guards (production posture)...");
  run(["hardhat", "run", "zombienet/configure-guards.ts", "--network", "zombienet"]);

  console.log("[4/4] Smoke test (Uniswap swap + guarded Gamma deposit)...");
  run(["hardhat", "run", "zombienet/smoke.ts", "--network", "zombienet"]);

  console.log("\n=== Phase 2 complete. Addresses: zombienet/deployments/zombienet.json ===");
}

main().catch((e) => {
  console.error("\n  Phase 2 FAILED:", e.message, "\n");
  process.exit(1);
});
