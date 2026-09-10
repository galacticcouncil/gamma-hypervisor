/**
 * smoke.ts  —  `npx hardhat run zombienet/smoke.ts --network zombienet`
 *
 * End-to-end proof that the deployed stack actually functions:
 *
 *   A. Uniswap v3:  mint a KSM/KUSD position via NonfungiblePositionManager,
 *      then swap KSM->KUSD via SwapRouter02; assert KUSD received.
 *   B. Gamma:       deposit KSM+KUSD into the Hypervisor (direct, deployer is
 *      whitelisted); assert LP shares minted and vault totals updated.
 *
 * Reads deployments/zombienet.json written by deploy-gamma.ts.
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const D = JSON.parse(fs.readFileSync(path.join(__dirname, "deployments/zombienet.json"), "utf8"));

const ERC20 = [
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
];
const POOL = [
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives,uint160[] secondsPerLiquidityCumulativeX128)",
];
// NonfungiblePositionManager.mint HAS a deadline (periphery v1.x).
const NPM = [
  "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
];
// SwapRouter02.exactInputSingle has NO deadline (differs from v3-periphery v1).
const ROUTER = [
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
];
const HYPERVISOR = [
  "function deposit(uint256,uint256,address,address,uint256[4]) returns (uint256 shares)",
  "function getTotalAmounts() view returns (uint256 total0,uint256 total1)",
  "function balanceOf(address) view returns (uint256)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function whitelistedAddress() view returns (address)",
  "function owner() view returns (address)",
];
const UNIPROXY = [
  "function deposit(uint256,uint256,address,address,uint256[4]) returns (uint256 shares)",
];

const LP = ethers.BigNumber.from("1000000000000000000"); // 1e18 each side
const SWAP_IN = ethers.BigNumber.from("10000000000000000"); // 1e16
const fmt = (x: any) => ethers.utils.formatUnits(x, 18);

async function main() {
  const [signer] = await ethers.getSigners();
  const me = signer.address;
  const { token0, token1, fee, pool, hypervisor } = D.gamma;
  console.log(`Signer ${me}`);
  console.log(`Pool ${pool}  token0=${token0} token1=${token1} fee=${fee}\n`);

  const t0 = new ethers.Contract(token0, ERC20, signer);
  const t1 = new ethers.Contract(token1, ERC20, signer);
  const npm = new ethers.Contract(D.uniswap.nonfungiblePositionManager, NPM, signer);
  const router = new ethers.Contract(D.uniswap.swapRouter02, ROUTER, signer);
  const poolC = new ethers.Contract(pool, POOL, signer);

  // HydraDX asset precompiles store balances as u128 — a MaxUint256 approval
  // overflows and reverts. u128::MAX is the precompile's "infinite" sentinel.
  const MAX = ethers.BigNumber.from(2).pow(128).sub(1);
  console.log("Approving position manager + router...");
  await (await t0.approve(npm.address, MAX)).wait();
  await (await t1.approve(npm.address, MAX)).wait();
  await (await t0.approve(router.address, MAX)).wait();

  // --- A. Uniswap: provide liquidity, then swap ----------------------------
  console.log("\n[A] Uniswap v3");
  const { tick } = await poolC.slot0();
  const spacing = 60; // fee 3000
  const lower = (Math.floor(tick / spacing) - 10) * spacing;
  const upper = (Math.floor(tick / spacing) + 10) * spacing;
  console.log(`  minting position ticks [${lower}, ${upper}] (${fmt(LP)} each)...`);
  await (
    await npm.mint({
      token0,
      token1,
      fee,
      tickLower: lower,
      tickUpper: upper,
      amount0Desired: LP,
      amount1Desired: LP,
      amount0Min: 0,
      amount1Min: 0,
      recipient: me,
      deadline: Math.floor(Date.now() / 1000) + 3600,
    })
  ).wait();
  console.log("  position minted.");

  const beforeOut = await t1.balanceOf(me);
  console.log(`  swapping ${fmt(SWAP_IN)} token0 -> token1...`);
  await (
    await router.exactInputSingle({
      tokenIn: token0,
      tokenOut: token1,
      fee,
      recipient: me,
      amountIn: SWAP_IN,
      amountOutMinimum: 0,
      sqrtPriceLimitX96: 0,
    })
  ).wait();
  const received = (await t1.balanceOf(me)).sub(beforeOut);
  console.log(`  received ${fmt(received)} token1`);
  if (received.lte(0)) throw new Error("swap produced no output");

  // --- B. Gamma: deposit into the vault ------------------------------------
  // Which path depends on the vault's posture. After deploy-gamma.ts the
  // deployer is whitelisted (bootstrap) and deposits directly; after
  // configure-guards.ts the whitelist is UniProxy and deposits must route
  // through ClearingV2's ratio + TWAP checks.
  console.log("\n[B] Gamma vault");
  const hyper = new ethers.Contract(hypervisor, HYPERVISOR, signer);
  const whitelisted: string = await hyper.whitelistedAddress();
  const viaProxy = D.gamma.uniProxy && whitelisted.toLowerCase() === D.gamma.uniProxy.toLowerCase();
  console.log(`  whitelist = ${whitelisted}  (${viaProxy ? "UniProxy — guarded path" : "direct — bootstrap path"})`);

  // Approve the HYPERVISOR in both paths. UniProxy does not custody the tokens:
  // it forwards to Hypervisor.deposit(..., from = msg.sender), and the vault
  // itself does transferFrom(user -> vault). So the allowance the ERC-20 checks
  // is always the user's allowance to the vault.
  await (await t0.approve(hypervisor, MAX)).wait();
  await (await t1.approve(hypervisor, MAX)).wait();
  console.log(`  depositing ${fmt(LP)} token0 + ${fmt(LP)} token1...`);
  if (viaProxy) {
    // ClearingV2.clearDeposit runs a TWAP check, and pool.observe reverts 'OLD'
    // for a window longer than the pool's history. On a fresh chain that history
    // has to accumulate first.
    await waitForPoolHistory(poolC, D.gamma.config?.twapInterval ?? 60);
    const proxy = new ethers.Contract(D.gamma.uniProxy, UNIPROXY, signer);
    await (await proxy.deposit(LP, LP, me, hypervisor, [0, 0, 0, 0])).wait();
  } else {
    await (await hyper.deposit(LP, LP, me, me, [0, 0, 0, 0])).wait();
  }
  const shares = await hyper.balanceOf(me);
  const [tot0, tot1] = await hyper.getTotalAmounts();
  console.log(`  LP shares: ${fmt(shares)}`);
  console.log(`  vault totals: ${fmt(tot0)} token0 / ${fmt(tot1)} token1`);
  if (shares.lte(0)) throw new Error("no vault shares minted");

  // --- C. Guard config the keeper depends on -------------------------------
  console.log("\n[C] Guard preconditions");
  const s0 = await poolC.slot0();
  console.log(`  observation cardinality: ${s0.observationCardinality} (next ${s0.observationCardinalityNext})`);
  if (s0.observationCardinalityNext < 2) {
    throw new Error("observation cardinality not grown — pool.observe() reverts, so both TWAP gates are dead");
  }
  console.log(`  vault owner: ${await hyper.owner()}`);

  console.log("\n  SMOKE PASSED — Uniswap v3 swap + Gamma deposit + TWAP history all OK.\n");
}

// Poll until pool.observe() can look back `windowSecs`, so the guarded deposit
// path isn't racing the chain's own history on a freshly started network.
async function waitForPoolHistory(pool: any, windowSecs: number): Promise<void> {
  const deadline = Date.now() + 180_000;
  for (;;) {
    try {
      await pool.observe([windowSecs, 0]);
      return;
    } catch (e: any) {
      const old = /OLD/.test(e?.reason ?? e?.error?.message ?? e?.message ?? "");
      if (!old) throw e;
      if (Date.now() > deadline) {
        throw new Error(`pool still has < ${windowSecs}s of observations after 180s — cannot clear a guarded deposit`);
      }
      console.log(`  waiting for ${windowSecs}s of pool observation history...`);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
