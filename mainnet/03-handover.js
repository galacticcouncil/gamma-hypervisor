/**
 * 03-handover.js — move the deployed vault from the BOOTSTRAP posture to the
 * PRODUCTION posture, in one deliberate, ordered, one-way pass:
 *
 *   1. verify the Model B wiring is complete   (else the vault becomes unrebalanceable)
 *   2. verify the ClearingV2 guards match the config (last chance without a referendum)
 *   3. set the launch band                     (owner action, vault must still be empty)
 *   4. whitelist = UniProxy                    (every deposit now passes ClearingV2)
 *   5. vault owner = Admin                     (keeper reaches rebalance only through the proxy caps)
 *   6. ClearingV2, UniProxy, RebalanceProxy, HypervisorFactory owner = governance
 *   7. Admin.admin = governance                LAST — it retires this key entirely
 *
 * Step 6 is the one a port of the testnet script forgets. Leaving those four
 * with the deploy key keeps the entire Model B story theoretical: that key could
 * `UniProxy.transferClearance` to a clearing contract with no TWAP or ratio
 * guard at all, or `RebalanceProxy.exemptHypervisor` to drop every cap.
 *
 * Idempotent: every step reads current state first, so it is safe to re-run.
 * SKIP_OWNERSHIP=true stops after step 4 (testnets only).
 */

const path = require("path");
const { ethers } = require("ethers");
const {
  env,
  requireEnv,
  isMainnet,
  centeredBand,
  limitRange,
  gasOverrides,
  waitForSuccess,
  loadDeployments,
  saveJson,
  ABI,
} = require("./lib");

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

async function main() {
  const net = env("NET", "mainnet");
  const d = loadDeployments(net);
  const provider = new ethers.JsonRpcProvider(env("EVM_RPC_URL", d.network.evmRpc));
  const wallet = new ethers.Wallet(requireEnv("DEPLOYER_PK"), provider);
  const confirmations = Number(env("CONFIRMATIONS", "2"));
  const skipOwnership = env("SKIP_OWNERSHIP", "false") === "true";
  const governance = env("GOVERNANCE_ADDRESS", d.governance);
  const keeper = env("KEEPER_ADDRESS", d.keeper);
  const feeRecipient = env("FEE_RECIPIENT", d.feeRecipient || "");
  if (!ethers.isAddress(governance || "")) throw new Error("GOVERNANCE_ADDRESS is required");
  if (!ethers.isAddress(feeRecipient || "")) {
    throw new Error("FEE_RECIPIENT is required — rebalance() reverts on address(0) and it is stored by that call");
  }
  if (isMainnet() && skipOwnership) throw new Error("SKIP_OWNERSHIP is a testnet-only escape hatch");

  const g = d.gamma;
  const vault = new ethers.Contract(g.hypervisor, ABI.hypervisor, wallet);
  const clearing = new ethers.Contract(g.clearing, ABI.clearing, wallet);
  const uniProxy = new ethers.Contract(g.uniProxy, ABI.uniProxy, wallet);
  const admin = new ethers.Contract(g.admin, ABI.admin, wallet);
  const proxy = new ethers.Contract(g.rebalanceProxy, ABI.rebalanceProxy, wallet);
  const hyperFactory = new ethers.Contract(g.hypervisorFactory, ABI.hypervisorFactory, wallet);
  const pool = new ethers.Contract(d.uniswap.pool, ABI.pool, provider);

  const overrides = () => gasOverrides(provider);
  const send = async (txPromise, label) => waitForSuccess(await txPromise, confirmations, label);

  console.log(`=== Gamma handover: ${net} ===`);
  console.log(`  signer     ${wallet.address}`);
  console.log(`  governance ${governance}`);
  console.log(`  vault      ${g.hypervisor}\n`);

  // --- 1. Model B wiring --------------------------------------------------
  console.log("[1] Model B wiring");
  const [proxyAdmin, proxyRebalancer, adminRebalancer, adminAdvisor, adminOwner] = await Promise.all([
    proxy.admins(g.hypervisor),
    proxy.rebalancers(g.hypervisor),
    admin.rebalancers(g.hypervisor),
    admin.advisors(g.hypervisor),
    admin.admin(),
  ]);
  console.log(`    proxy.admin       ${proxyAdmin}`);
  console.log(`    proxy.rebalancer  ${proxyRebalancer}`);
  console.log(`    admin.rebalancer  ${adminRebalancer}`);
  console.log(`    admin.advisor     ${adminAdvisor}`);
  console.log(`    admin.admin       ${adminOwner}`);
  const wiringProblems = [];
  if (!same(proxyAdmin, g.admin)) wiringProblems.push(`proxy.admins[vault] is ${proxyAdmin}, expected ${g.admin}`);
  if (!same(adminRebalancer, g.rebalanceProxy)) wiringProblems.push(`admin.rebalancers[vault] is ${adminRebalancer}, expected ${g.rebalanceProxy}`);
  if (proxyRebalancer === ethers.ZeroAddress) wiringProblems.push("proxy.rebalancers[vault] is unset — nothing could ever rebalance");
  if (!same(proxyRebalancer, keeper)) wiringProblems.push(`proxy.rebalancers[vault] is ${proxyRebalancer}, expected keeper ${keeper}`);
  if (adminAdvisor === ethers.ZeroAddress) wiringProblems.push("admin.advisors[vault] is unset — compound would be unreachable forever");
  if (wiringProblems.length) {
    throw new Error(
      "refusing to hand over an incompletely wired vault — it would be unrebalanceable:\n    " + wiringProblems.join("\n    ")
    );
  }
  const caps = await Promise.all([proxy.customDiff(g.hypervisor), proxy.customWidth(g.hypervisor), proxy.customInterval(g.hypervisor)]);
  console.log(`    caps: maxTranslation=${caps[0]} maxWidth=${caps[1]} minInterval=${caps[2]}s`);
  if (caps.some((c) => c === 0n)) throw new Error("a proxy cap is 0, which falls back to the shared global default — set all three");
  console.log("    wiring complete");

  // --- 2. ClearingV2 guards ----------------------------------------------
  // After step 6 only a referendum can change these, so this is the last cheap
  // chance to notice a mismatch with the reviewed configuration.
  console.log("\n[2] ClearingV2 guards");
  const [twapCheck, twapInterval, priceThreshold, position, clearingOwner] = await Promise.all([
    clearing.twapCheck(),
    clearing.twapInterval(),
    clearing.priceThreshold(),
    clearing.positions(g.hypervisor),
    clearing.owner(),
  ]);
  console.log(`    twapCheck=${twapCheck} interval=${twapInterval}s threshold=${priceThreshold}`);
  console.log(`    caps: supply=${position.maxTotalSupply} d0=${position.deposit0Max} d1=${position.deposit1Max} delta=${position.customDepositDelta} override=${position.depositOverride}`);
  const guardProblems = [];
  if (!twapCheck) guardProblems.push("twapCheck is off — deposits would skip the deviation guard entirely");
  if (Number(position.version) === 0) guardProblems.push("the vault is not an added ClearingV2 position — every deposit reverts with 'not added'");
  if (Number(priceThreshold) <= 10_000) guardProblems.push(`priceThreshold ${priceThreshold} allows 0% deviation — every deposit reverts`);
  if (Number(twapInterval) !== Number(env("TWAP_INTERVAL", String(d.config.twapInterval)))) {
    guardProblems.push(`twapInterval ${twapInterval} does not match the configured ${env("TWAP_INTERVAL", String(d.config.twapInterval))}`);
  }
  // applyRatio divides by customDepositDelta whenever depositOverride is on.
  if (position.depositOverride && position.customDepositDelta === 0n) {
    guardProblems.push("depositOverride is on with customDepositDelta = 0 — every deposit AFTER the first reverts in FullMath.mulDiv");
  }
  if (isMainnet() && position.maxTotalSupply === 0n) guardProblems.push("maxTotalSupply is 0 (uncapped) — a mainnet guarded launch needs a cap");
  if (guardProblems.length) {
    throw new Error("ClearingV2 is not launch-ready:\n    " + guardProblems.join("\n    "));
  }
  if (!same(clearingOwner, wallet.address) && !same(clearingOwner, governance)) {
    throw new Error(`ClearingV2 owner is ${clearingOwner} — neither this key nor governance`);
  }
  console.log("    guards are launch-ready");

  // --- 3. launch band -----------------------------------------------------
  console.log("\n[3] launch band");
  const spacing = Number(await vault.tickSpacing());
  const [baseLower, baseUpper, total] = await Promise.all([vault.baseLower(), vault.baseUpper(), vault.getTotalAmounts()]);
  const owner = await vault.owner();
  if (Number(baseLower) === Number(baseUpper)) {
    if (!same(owner, wallet.address)) throw new Error(`vault has no band and this key is not the owner (${owner})`);
    // The bootstrap rebalance passes zero slippage mins. That is only safe
    // because there is nothing to deploy: with liquidity present it would mint
    // real positions completely unprotected.
    if (total.total0 !== 0n || total.total1 !== 0n) {
      if (env("ACCEPT_ZERO_MINS", "false") !== "true") {
        throw new Error(
          `vault already holds ${total.total0}/${total.total1} but has no band. Setting one now would deploy ` +
            `that liquidity with zero slippage protection. Run the handover BEFORE the seed, or set ACCEPT_ZERO_MINS=true.`
        );
      }
      console.log("    ⚠ ACCEPT_ZERO_MINS — deploying existing liquidity with no slippage bounds");
    }
    const { tick } = await pool.slot0();
    const mult = Number(env("BASE_HALF_WIDTH_MULT", String(d.config.baseHalfWidthMult)));
    const limitMult = Number(env("LIMIT_WIDTH_MULT", String(d.config.limitWidthMult)));
    const side = env("LIMIT_SIDE", "above");
    const [lower, upper] = centeredBand(Number(tick), mult, spacing);
    const [limitLower, limitUpper] = limitRange(Number(tick), spacing, side, limitMult);
    console.log(`    tick ${tick}: base [${lower}, ${upper}] width ${upper - lower}, limit [${limitLower}, ${limitUpper}] (${side})`);
    const zeros = [0, 0, 0, 0];
    await send(
      vault.rebalance(lower, upper, limitLower, limitUpper, feeRecipient, zeros, zeros, await overrides()),
      `hypervisor.rebalance -> launch band, feeRecipient ${feeRecipient}`
    );
  } else {
    console.log(`    band already set: [${baseLower}, ${baseUpper}]`);
  }

  // --- 4. whitelist = UniProxy -------------------------------------------
  console.log("\n[4] deposit path");
  const whitelisted = await vault.whitelistedAddress();
  if (same(whitelisted, g.uniProxy)) {
    console.log(`    whitelist already UniProxy ${g.uniProxy}`);
  } else if (same(await vault.owner(), wallet.address)) {
    await send(vault.setWhitelist(g.uniProxy, await overrides()), `hypervisor.setWhitelist(${g.uniProxy})`);
  } else {
    throw new Error(`whitelist is ${whitelisted}, not UniProxy, and this key no longer owns the vault`);
  }

  if (skipOwnership) {
    console.log("\n[5-7] SKIP_OWNERSHIP=true — every owner role left with the deploy key");
    return;
  }

  // --- 5. vault owner = Admin --------------------------------------------
  console.log("\n[5] vault ownership");
  const currentOwner = await vault.owner();
  if (same(currentOwner, g.admin)) {
    console.log("    vault already owned by Admin");
  } else if (same(currentOwner, wallet.address)) {
    await send(vault.transferOwnership(g.admin, await overrides()), `hypervisor.transferOwnership(${g.admin})`);
  } else {
    throw new Error(`vault owned by ${currentOwner}, not this key — cannot transfer`);
  }

  // --- 6. peripheral owners = governance ---------------------------------
  console.log("\n[6] peripheral ownership -> governance");
  const transfers = [
    ["ClearingV2", () => clearing.owner(), async () => clearing.transferOwnership(governance, await overrides())],
    ["UniProxy", () => uniProxy.owner(), async () => uniProxy.transferOwnership(governance, await overrides())],
    ["RebalanceProxy", () => proxy.owner(), async () => proxy.transferOwner(governance, await overrides())],
    ["HypervisorFactory", () => hyperFactory.owner(), async () => hyperFactory.transferOwnership(governance, await overrides())],
  ];
  for (const [label, read, write] of transfers) {
    const current = await read();
    if (same(current, governance)) {
      console.log(`    ${label} already owned by governance`);
    } else if (same(current, wallet.address)) {
      await send(write(), `${label}.transferOwnership(${governance})`);
    } else {
      throw new Error(`${label} owner is ${current} — neither this key nor governance`);
    }
  }

  // --- 7. Admin.admin = governance (LAST) --------------------------------
  console.log("\n[7] Admin");
  const finalAdmin = await admin.admin();
  if (same(finalAdmin, governance)) {
    console.log("    Admin already held by governance");
  } else if (same(finalAdmin, wallet.address)) {
    await send(admin.transferAdmin(governance, await overrides()), `admin.transferAdmin(${governance}) — this key is now retired`);
  } else {
    throw new Error(`Admin.admin is ${finalAdmin}, not this key — cannot transfer`);
  }

  d.config = { ...(d.config || {}), posture: "production" };
  const p = saveJson(path.join("deployments", `${net}.json`), d);
  console.log(`\n  Wrote ${p}`);
  console.log("\n=== PRODUCTION posture ===");
  console.log(`  Keeper config: ENTRYPOINT=proxy REBALANCE_PROXY=${g.rebalanceProxy} VAULT=${g.hypervisor} ADMIN_ADDRESS=${g.admin}`);
  console.log("  The vault is live, empty and capped. Seed it with:");
  console.log(`    ENV_FILE=<file> npm run governance -- seed`);
  console.log("  Start the keeper BEFORE the seed: it keeps the band centred on the tick, and");
  console.log("  ClearingV2 rejects any deposit taken while the tick sits outside that band.");
}

main().catch((e) => {
  console.error("\n  Handover FAILED:", e.message, "\n");
  process.exit(1);
});
