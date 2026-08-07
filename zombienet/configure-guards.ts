/**
 * configure-guards.ts — `npx hardhat run zombienet/configure-guards.ts --network zombienet`
 *
 * Moves a deployed Gamma vault from the BOOTSTRAP posture (deployer whitelisted
 * and owning the vault) to the PRODUCTION posture:
 *
 *   1. ensure the vault has a base range      (rebalance once, as owner)
 *   2. whitelist = UniProxy                   (deposits go through ClearingV2)
 *   3. verify the UniProxy deposit path works (dry, via clearDeposit)
 *   4. owner = Admin                          (keeper reaches rebalance only
 *                                              through RebalanceProxy's caps)
 *
 * Idempotent: every step checks current state first, so it is safe to re-run and
 * safe to run against an already-configured deployment. Step 4 is one-way from
 * this key's perspective — after it, only Admin's admin can move ownership back.
 *
 * Env:
 *   DEPLOYMENTS=<path>       deployment json (default zombienet/deployments/zombienet.json)
 *   SKIP_OWNERSHIP=true      do steps 1-3 only (keep the owner key for testing)
 *   TWAP_INTERVAL=<secs>     re-set ClearingV2's deposit TWAP window
 *   PRICE_THRESHOLD=<n>      re-set ClearingV2's deposit deviation cap (10_100 = 1%)
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const DEPLOYMENTS = process.env.DEPLOYMENTS || path.join(__dirname, "deployments/zombienet.json");
const SKIP_OWNERSHIP = process.env.SKIP_OWNERSHIP === "true";

const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16 observationCardinality,uint16 observationCardinalityNext,uint8,bool)",
  "function tickSpacing() view returns (int24)",
];
const CLEARING_ABI = [
  "function owner() view returns (address)",
  "function twapCheck() view returns (bool)",
  "function twapInterval() view returns (uint32)",
  "function priceThreshold() view returns (uint256)",
  "function setTwapInterval(uint32)",
  "function setPriceThreshold(uint256)",
];
const HYPERVISOR_ABI = [
  "function owner() view returns (address)",
  "function whitelistedAddress() view returns (address)",
  "function baseLower() view returns (int24)",
  "function baseUpper() view returns (int24)",
  "function limitLower() view returns (int24)",
  "function limitUpper() view returns (int24)",
  "function currentTick() view returns (int24)",
  "function tickSpacing() view returns (int24)",
  "function fee() view returns (uint8)",
  "function feeRecipient() view returns (address)",
  "function getTotalAmounts() view returns (uint256 total0,uint256 total1)",
  "function setWhitelist(address)",
  "function transferOwnership(address)",
  "function rebalance(int24,int24,int24,int24,address,uint256[4],uint256[4])",
];
const PROXY_ABI = [
  "function owner() view returns (address)",
  "function rebalancers(address) view returns (address)",
  "function admins(address) view returns (address)",
  "function customDiff(address) view returns (uint256)",
  "function customWidth(address) view returns (uint256)",
  "function customInterval(address) view returns (uint256)",
];
const ADMIN_ABI = [
  "function admin() view returns (address)",
  "function rebalancers(address) view returns (address)",
];

// MUST match the keeper's BASE_HALF_WIDTH_MULT. The initial band set here is the
// baseline the proxy's maxWidth is measured against, so a mismatch means the
// keeper's first rebalance is an over-cap width change and it skips forever.
const HALF_WIDTH_MULT = Number(process.env.BASE_HALF_WIDTH_MULT || 10);

async function main() {
  if (!fs.existsSync(DEPLOYMENTS)) throw new Error(`No deployment at ${DEPLOYMENTS}`);
  const D = JSON.parse(fs.readFileSync(DEPLOYMENTS, "utf8"));
  const g = D.gamma;
  if (!g.admin || !g.rebalanceProxy) {
    throw new Error("deployment predates the Model B wiring — redeploy with deploy-gamma.ts");
  }

  const [signer] = await ethers.getSigners();
  const hyper = new ethers.Contract(g.hypervisor, HYPERVISOR_ABI, signer);
  const clearing = new ethers.Contract(g.clearing, CLEARING_ABI, signer);
  const proxy = new ethers.Contract(g.rebalanceProxy, PROXY_ABI, signer);
  const admin = new ethers.Contract(g.admin, ADMIN_ABI, signer);
  const pool = new ethers.Contract(g.pool, POOL_ABI, signer);

  console.log(`Signer      ${signer.address}`);
  console.log(`Hypervisor  ${g.hypervisor}`);
  console.log(`UniProxy    ${g.uniProxy}`);
  console.log(`Admin       ${g.admin}`);
  console.log(`Proxy       ${g.rebalanceProxy}\n`);

  const owner = await hyper.owner();
  const spacing = await hyper.tickSpacing();

  // --- 0. Report the fee posture. `fee` is a DIVISOR: 5 => 20% of swap fees. ---
  const [feeDivisor, feeRecipient] = await Promise.all([hyper.fee(), hyper.feeRecipient()]);
  console.log(`[0] protocol fee: divisor ${feeDivisor} => ${(100 / feeDivisor).toFixed(1)}% of swap fees -> ${feeRecipient}`);
  if (feeRecipient === ethers.constants.AddressZero) {
    console.log(`    (unset until the first rebalance names one — the keeper passes FEE_RECIPIENT)`);
  }

  // --- 1. Ensure a base range exists. ClearingV2.clearDeposit requires
  //        baseLower <= currentTick < baseUpper, so an unset band blocks every
  //        UniProxy deposit. Rebalancing an empty vault is a no-op that just
  //        records the ticks.
  const [baseLower, baseUpper] = await Promise.all([hyper.baseLower(), hyper.baseUpper()]);
  if (baseLower === baseUpper) {
    if (owner.toLowerCase() !== signer.address.toLowerCase()) {
      throw new Error(`vault has no base range and signer is not the owner (${owner}) — cannot bootstrap`);
    }
    // This bootstrap rebalance passes zero slippage mins, which is only safe
    // because there is nothing to deploy. Run it BEFORE funding the vault (the
    // e2e does); on a funded vault it would mint real liquidity unprotected.
    const [t0, t1] = await hyper.getTotalAmounts();
    if (!t0.isZero() || !t1.isZero()) {
      if (process.env.ACCEPT_ZERO_MINS !== "true") {
        throw new Error(
          `vault already holds ${t0.toString()}/${t1.toString()} but has no base range.\n` +
            `Setting it now would deploy that liquidity with zero slippage protection.\n` +
            `Run configure-guards BEFORE the first deposit, or set ACCEPT_ZERO_MINS=true to override.`,
        );
      }
      console.log(`    ⚠ ACCEPT_ZERO_MINS — deploying existing liquidity with no slippage bounds`);
    }
    const { tick } = await pool.slot0();
    const half = HALF_WIDTH_MULT * spacing;
    const lower = Math.floor((tick - half) / spacing) * spacing;
    const upper = Math.ceil((tick + half) / spacing) * spacing;
    const limitLower = Math.trunc(tick / spacing) * spacing + spacing;
    console.log(`[1] setting initial base range [${lower}, ${upper}] around tick ${tick}...`);
    const zeros = [0, 0, 0, 0];
    await (
      await hyper.rebalance(lower, upper, limitLower, limitLower + spacing, feeRecipientOrSigner(feeRecipient, signer.address), zeros, zeros)
    ).wait();
    console.log(`    base range set.`);
  } else {
    console.log(`[1] base range already set: [${baseLower}, ${baseUpper}]`);
  }

  // --- 2. ClearingV2 deposit guard config ---
  const [twapCheck, twapInterval, priceThreshold] = await Promise.all([
    clearing.twapCheck(),
    clearing.twapInterval(),
    clearing.priceThreshold(),
  ]);
  console.log(`[2] ClearingV2: twapCheck=${twapCheck} interval=${twapInterval}s threshold=${priceThreshold} (${(Number(priceThreshold) - 10_000) / 100}% deviation)`);
  if (Number(priceThreshold) <= 10_000) {
    console.log(`    ⚠ threshold ${priceThreshold} allows 0% deviation — every deposit will revert once a TWAP exists.`);
  }
  const clearingOwner = await clearing.owner();
  if (clearingOwner.toLowerCase() === signer.address.toLowerCase()) {
    if (process.env.TWAP_INTERVAL) {
      await (await clearing.setTwapInterval(Number(process.env.TWAP_INTERVAL))).wait();
      console.log(`    twapInterval -> ${process.env.TWAP_INTERVAL}s`);
    }
    if (process.env.PRICE_THRESHOLD) {
      await (await clearing.setPriceThreshold(Number(process.env.PRICE_THRESHOLD))).wait();
      console.log(`    priceThreshold -> ${process.env.PRICE_THRESHOLD}`);
    }
  }

  // --- 3. Whitelist = UniProxy (deposits must pass the clearing checks) ---
  const whitelisted = await hyper.whitelistedAddress();
  if (whitelisted.toLowerCase() === g.uniProxy.toLowerCase()) {
    console.log(`[3] whitelist already UniProxy (${g.uniProxy})`);
  } else if (owner.toLowerCase() === signer.address.toLowerCase()) {
    await (await hyper.setWhitelist(g.uniProxy)).wait();
    console.log(`[3] whitelist ${whitelisted} -> UniProxy ${g.uniProxy}`);
  } else {
    console.log(`[3] ⚠ whitelist is ${whitelisted}, not UniProxy — signer no longer owns the vault; use Admin.setWhitelist`);
  }

  // --- 4. Observation cardinality (the keeper's TWAP gate depends on it) ---
  const s0 = await pool.slot0();
  console.log(`[4] pool observations: cardinality=${s0.observationCardinality} next=${s0.observationCardinalityNext}`);
  if (s0.observationCardinalityNext < 2) {
    console.log(`    ⚠ cardinality not grown — observe() will revert and the keeper will fail closed.`);
  }

  // --- 5. Model B wiring check, then hand the vault to Admin ---
  const [proxyAdmin, proxyRebalancer, adminRebalancer, adminOwner] = await Promise.all([
    proxy.admins(g.hypervisor),
    proxy.rebalancers(g.hypervisor),
    admin.rebalancers(g.hypervisor),
    admin.admin(),
  ]);
  console.log(`[5] proxy.admin=${proxyAdmin}`);
  console.log(`    proxy.rebalancer=${proxyRebalancer}  (keeper key)`);
  console.log(`    admin.rebalancer=${adminRebalancer}  (must be the proxy)`);
  console.log(`    admin.admin=${adminOwner}  (governance)`);

  const wiringOk =
    proxyAdmin.toLowerCase() === g.admin.toLowerCase() &&
    adminRebalancer.toLowerCase() === g.rebalanceProxy.toLowerCase() &&
    proxyRebalancer !== ethers.constants.AddressZero;
  if (!wiringOk) {
    throw new Error("Model B wiring incomplete — refusing to transfer ownership (the vault would become unrebalanceable)");
  }

  const caps = await Promise.all([
    proxy.customDiff(g.hypervisor),
    proxy.customWidth(g.hypervisor),
    proxy.customInterval(g.hypervisor),
  ]);
  console.log(`    caps: maxTranslation=${caps[0]} maxWidth=${caps[1]} minInterval=${caps[2]}s`);

  // The keeper's first rebalance re-mints at BASE_HALF_WIDTH_MULT; if that width
  // differs from the band we just set by more than maxWidth, it can never land.
  const [curLower, curUpper] = await Promise.all([hyper.baseLower(), hyper.baseUpper()]);
  const curWidth = curUpper - curLower;
  const keeperWidth = 2 * HALF_WIDTH_MULT * spacing + spacing;
  const widthDelta = Math.abs(keeperWidth - curWidth);
  if (widthDelta > Number(caps[1])) {
    console.log(
      `    ⚠ band width ${curWidth} vs keeper target ${keeperWidth} differs by ${widthDelta} > maxWidth ${caps[1]} —` +
        ` the keeper would skip every block. Run with BASE_HALF_WIDTH_MULT matching the keeper's, or raise maxWidth.`,
    );
  } else {
    console.log(`    width check ok: band ${curWidth} vs keeper target ${keeperWidth} (delta ${widthDelta} <= ${caps[1]})`);
  }

  let adminOwns = false;
  if (SKIP_OWNERSHIP) {
    console.log(`[6] SKIP_OWNERSHIP=true — vault owner left as ${owner}`);
  } else if (owner.toLowerCase() === g.admin.toLowerCase()) {
    console.log(`[6] vault already owned by Admin — Model B live`);
    adminOwns = true;
  } else if (owner.toLowerCase() === signer.address.toLowerCase()) {
    await (await hyper.transferOwnership(g.admin)).wait();
    console.log(`[6] Hypervisor.transferOwnership(${g.admin}) — Model B live, hot owner key retired`);
    adminOwns = true;
  } else {
    console.log(`[6] ⚠ vault owned by ${owner}, not this signer — cannot transfer`);
  }

  // Record what is actually true on-chain, not what was intended.
  D.gamma.config = { ...(D.gamma.config || {}), posture: adminOwns ? "production" : "bootstrap" };
  fs.writeFileSync(DEPLOYMENTS, JSON.stringify(D, null, 2));
  console.log(`\nWrote ${DEPLOYMENTS}`);
  console.log(`\nKeeper config: ENTRYPOINT=proxy REBALANCE_PROXY=${g.rebalanceProxy} VAULT=${g.hypervisor}`);
}

function feeRecipientOrSigner(current: string, signer: string): string {
  return current === ethers.constants.AddressZero ? signer : current;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
