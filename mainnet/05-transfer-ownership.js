/**
 * 05-transfer-ownership.js — the single, LAST step of a multi-pool launch: move
 * every owner role of the shared Gamma stack from the deploy key to governance.
 *
 *   ENV_FILE=.env.pools node 05-transfer-ownership.js --check   # read-only readiness report
 *   ENV_FILE=.env.pools node 05-transfer-ownership.js           # do it
 *
 * Run it once per STACK, after 03-handover.js has configured EVERY pool named in
 * STACK_POOLS. Until then the deploy key owns everything, so any setting can
 * still be fixed with a plain transaction; afterwards only a referendum can.
 *
 * Order — 03-handover.js steps 6-8, reusing its code:
 *   1. every vault owner       -> Admin       (the keeper reaches rebalance only through the proxy caps)
 *   2. ClearingV2, UniProxy, RebalanceProxy, HypervisorFactory -> governance
 *   3. Admin.admin             -> governance  LAST — it retires the deploy key
 *
 * It refuses to start unless the stack's factory holds exactly the vaults in
 * STACK_POOLS, each recorded `configured` and still fully wired. After step 2 no
 * vault can be added or re-wired without a referendum, and a vault missed here
 * would stay owned by a key that is about to have no other role.
 */

const fs = require("fs");
const { ethers } = require("ethers");
const { env, requireEnv, stackName, stackFile, gasOverrides, waitForSuccess, ABI } = require("./lib");
const {
  contractsFor,
  roleTargetFor,
  roleRecord,
  checkWiring,
  checkGuards,
  transferVault,
  transferPeripherals,
  transferAdmin,
} = require("./03-handover");

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const SHARED = ["hypervisorFactory", "clearing", "uniProxy", "admin", "rebalanceProxy"];

/** Every pool record named in STACK_POOLS, each checked to belong to this stack. */
function loadStack(net, stack) {
  const pools = (env("STACK_POOLS") || "").split(",").map((p) => p.trim()).filter(Boolean);
  if (!pools.length) throw new Error("STACK_POOLS must list every pool of the stack, e.g. atbtc-hollar,apaxg-hollar,…");
  const statePath = stackFile(net, stack, "state");
  if (!fs.existsSync(statePath)) throw new Error(`${statePath} not found — run 02-deploy.js first`);
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const records = pools.map((pool) => {
    const file = stackFile(net, stack, pool);
    if (!fs.existsSync(file)) throw new Error(`${file} not found — run 02-deploy.js and 03-handover.js for ${pool}`);
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    if (d.pool !== pool || d.stack !== stack) throw new Error(`${file} records pool ${d.pool} of stack ${d.stack}`);
    for (const key of SHARED) {
      if (!same(d.gamma[key], state[key])) throw new Error(`${pool}: gamma.${key} ${d.gamma[key]} is not the stack's ${state[key]}`);
    }
    return { pool, file, d };
  });
  return { state, records };
}

/** The factory must hold exactly the recorded vaults — none missing, none extra. */
async function checkVaultSet(state, records, provider) {
  const factory = new ethers.Contract(state.hypervisorFactory, ABI.hypervisorFactory, provider);
  const count = Number(await factory.allHypervisorsLength());
  const onChain = await Promise.all(Array.from({ length: count }, (_, i) => factory.allHypervisors(i)));
  const recorded = records.map((r) => r.d.gamma.hypervisor);
  const extra = onChain.filter((v) => !recorded.some((r) => same(r, v)));
  const missing = recorded.filter((r) => !onChain.some((v) => same(r, v)));
  if (extra.length || missing.length) {
    throw new Error(
      `factory ${state.hypervisorFactory} holds ${count} vault(s), STACK_POOLS records ${recorded.length}` +
        (extra.length ? `\n    not in STACK_POOLS: ${extra.join(", ")}` : "") +
        (missing.length ? `\n    not made by this factory: ${missing.join(", ")}` : "")
    );
  }
  console.log(`  factory holds exactly the ${count} vault(s) in STACK_POOLS`);
}

/** Steps 1-5 of 03-handover.js must still hold for this vault, right now. */
async function checkConfigured(c, d, wallet, keeper, roleTarget) {
  if (!["configured", "production"].includes(d.config?.posture)) {
    throw new Error(`posture is ${d.config?.posture} — run 03-handover.js for this pool first`);
  }
  await checkWiring(c, keeper);
  await checkGuards(c, d, wallet.address, roleTarget);
  const [baseLower, baseUpper, whitelisted] = await Promise.all([c.vault.baseLower(), c.vault.baseUpper(), c.vault.whitelistedAddress()]);
  if (Number(baseLower) === Number(baseUpper)) throw new Error("the vault has no launch band");
  if (!same(whitelisted, c.g.uniProxy)) throw new Error(`whitelist is ${whitelisted}, not UniProxy ${c.g.uniProxy}`);
  console.log(`    band [${baseLower}, ${baseUpper}], deposits only through UniProxy`);
}

/** After the transfer, the deploy key must hold no role on any contract of the stack. */
async function keyRolesLeft(records, contracts, wallet) {
  const left = [];
  const c0 = contracts[0];
  const owners = [
    ["ClearingV2", c0.clearing.owner()],
    ["UniProxy", c0.uniProxy.owner()],
    ["RebalanceProxy", c0.proxy.owner()],
    ["HypervisorFactory", c0.hyperFactory.owner()],
    ["Admin.admin", c0.admin.admin()],
  ];
  for (const [label, read] of owners) if (same(await read, wallet.address)) left.push(label);
  for (const [i, { pool }] of records.entries()) {
    const { g, vault, proxy, admin } = contracts[i];
    const roles = [
      ["owner", vault.owner()],
      ["proxy.rebalancer", proxy.rebalancers(g.hypervisor)],
      ["admin.rebalancer", admin.rebalancers(g.hypervisor)],
      ["admin.advisor", admin.advisors(g.hypervisor)],
    ];
    for (const [label, read] of roles) if (same(await read, wallet.address)) left.push(`${pool} ${label}`);
    if (!same(await vault.owner(), g.admin)) left.push(`${pool} vault is not owned by Admin`);
  }
  return left;
}

async function main() {
  const checkOnly = process.argv.includes("--check");
  if (env("POOL_NAME")) throw new Error("run this with the shared ENV_FILE only — it covers every pool in STACK_POOLS at once");
  const net = env("NET", "mainnet");
  const stack = stackName();
  const { state, records } = loadStack(net, stack);
  const first = records[0].d;

  const provider = new ethers.JsonRpcProvider(env("EVM_RPC_URL", first.network.evmRpc));
  const wallet = new ethers.Wallet(requireEnv("DEPLOYER_PK"), provider);
  const confirmations = Number(env("CONFIRMATIONS", "2"));
  const governance = env("GOVERNANCE_ADDRESS", first.governance);
  if (!ethers.isAddress(governance || "")) throw new Error("GOVERNANCE_ADDRESS is required");
  const roleTarget = roleTargetFor(governance, wallet);
  const keeper = env("KEEPER_ADDRESS", first.keeper);
  const tx = {
    overrides: () => gasOverrides(provider),
    send: async (txPromise, label) => waitForSuccess(await txPromise, confirmations, label),
  };
  const contracts = records.map((r) => contractsFor(r.d, wallet));

  console.log(`=== Transfer ownership: ${net} stack ${stack} ===`);
  console.log(`  signer     ${wallet.address}`);
  console.log(`  governance ${governance}`);
  console.log(`  pools      ${records.map((r) => r.pool).join(", ")}\n`);

  console.log("[1] every vault configured");
  await checkVaultSet(state, records, provider);
  for (const [i, { pool, d }] of records.entries()) {
    console.log(`  ${pool} ${d.gamma.hypervisor}`);
    await checkConfigured(contracts[i], d, wallet, keeper, roleTarget);
  }
  if (checkOnly) {
    console.log("\n=== --check: every pool is configured; nothing was sent ===");
    return;
  }

  console.log("\n[2] every vault -> Admin");
  for (const [i, { pool }] of records.entries()) {
    console.log(`  ${pool}`);
    await transferVault(contracts[i], wallet, tx);
  }

  console.log("\n[3] shared contracts -> governance");
  await transferPeripherals(contracts[0], wallet, tx, roleTarget, governance);

  console.log("\n[4] Admin -> governance (last)");
  await transferAdmin(contracts[0], wallet, tx, roleTarget, governance);

  console.log("\n[5] the deploy key holds nothing");
  const left = await keyRolesLeft(records, contracts, wallet);
  if (left.length) throw new Error(`the deploy key still holds: ${left.join(", ")}`);
  console.log(`    ${wallet.address} has no role on any contract of stack ${stack}`);

  for (const { file, d } of records) {
    d.config = { ...(d.config || {}), posture: "production" };
    d.roles = roleRecord(roleTarget);
    fs.writeFileSync(file, JSON.stringify(d, null, 2) + "\n");
  }
  console.log("\n=== PRODUCTION posture for every pool — ownership moved, last step done ===");
  console.log("  Next, per pool: ENV_FILE=<shared> POOL_FILE=pools/<pool>.env npm run verify");
  console.log("  Then seed it: npm run governance -- seed (treasury), or SEEDER_PK=0x… npm run seed-wallet");
}

main().catch((e) => {
  console.error("\n  Transfer FAILED:", e.message, "\n");
  process.exit(1);
});
