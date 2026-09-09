/**
 * 11-anchor-price.js — move an EMPTY Uniswap v3 pool's spot price onto the
 * oracle price, using nothing but the already-deployed Uniswap contracts.
 *
 * ---------------------------------------------------------------------------
 * Why this is needed
 * ---------------------------------------------------------------------------
 * A pool is initialized at whatever the feed said at `initialize()` and then
 * FREEZES: with no liquidity there is nothing to trade against, so no
 * arbitrageur can drag it back to the market. The gap only widens.
 *
 * That matters because the Gamma handover centres the launch band on the pool's
 * CURRENT tick, and `RebalanceProxy.customDiff` caps how far the keeper may
 * later move that band. A band placed on a stale price cannot be walked back
 * without a referendum. And the first real liquidity into a mispriced pool is
 * arbitraged for the full gap — at a 10% gap that is ~320 bps of the seed.
 *
 * So the price is corrected BEFORE any liquidity or any band exists.
 *
 * ---------------------------------------------------------------------------
 * Why it works this way and not the obvious way
 * ---------------------------------------------------------------------------
 * "Just do a tiny swap through SwapRouter02" DOES NOT WORK on an empty pool.
 * Uniswap's router callback opens with
 *
 *     require(amount0Delta > 0 || amount1Delta > 0);
 *     // swaps entirely within 0-liquidity regions are not supported
 *
 * and on an empty pool both deltas are exactly zero, so it reverts with no
 * reason string. `pool.swap()` straight from an EOA fails too — the pool calls
 * `uniswapV3SwapCallback` on `msg.sender`, and an EOA has no code.
 *
 * The way through, with no new contract deployed:
 *
 *     1. mint a TINY position straddling the current tick   (NonfungiblePositionManager)
 *     2. one swap with sqrtPriceLimitX96 = the oracle price (SwapRouter02)
 *        - the swap eats that tiny position, which makes the deltas non-zero
 *          and satisfies the router, then rides FREE through the empty ticks
 *          until it reaches the limit
 *     3. withdraw and burn the position                     (NonfungiblePositionManager)
 *
 * You are both the liquidity and the taker, so what you lose on one side you
 * gain on the other, and the 0.3% fee is paid to the only LP — you. Net cost is
 * gas plus dust rounding.
 *
 * ---------------------------------------------------------------------------
 * Running it
 * ---------------------------------------------------------------------------
 *     ENV_FILE=.env.anchor node 11-anchor-price.js            # do it
 *     ENV_FILE=.env.anchor node 11-anchor-price.js --dry-run  # report only
 *     ENV_FILE=.env.anchor node 11-anchor-price.js --cleanup  # burn a stranded position
 *
 * Everything is read from env — no deployments file needed, so whoever holds
 * the tokens can run it without the launch operator's records.
 *
 * AFTERWARDS: spot has jumped away from the pool's own hourly average, and
 * ClearingV2 rejects deposits until they reconverge (~50-60 min for a 1000-tick
 * move). The handover can run immediately; the first DEPOSIT has to wait.
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const {
  env,
  requireEnv,
  readFeedE18,
  resolveOraclePriceE18,
  priceE18FromSqrtPriceX96,
  sqrtPriceX96FromPriceE18,
  tickDeltaBetweenSqrt,
  MIN_SQRT_RATIO,
  MAX_SQRT_RATIO,
  fmtE18,
  fmtUnits,
  gasOverrides,
  waitForSuccess,
  ABI,
} = require("./lib");

// Mainnet defaults so the script is runnable standalone. Override for a fork.
const D = {
  POOL: "0x5C6208A3c316A801f8996750aA7b6f45Fc988548",
  POSITION_MANAGER: "0xd5029E471eE3F6F51feFb63Fed0482A74Bb310B3",
  SWAP_ROUTER: "0x5a79dE848626994c4099640EF5c48Fd65DAe4159",
  PRICE_FEED_A: "0xFBCa0A6dC5B74C042DF23025D99ef0F1fcAC6702",
};

const NPM_ABI = [
  "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
  "function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline)) payable returns (uint256 amount0,uint256 amount1)",
  "function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max)) payable returns (uint256 amount0,uint256 amount1)",
  "function burn(uint256 tokenId) payable",
  "function positions(uint256) view returns (uint96 nonce,address operator,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256 fg0,uint256 fg1,uint128 owed0,uint128 owed1)",
  "function ownerOf(uint256) view returns (address)",
];
const ROUTER_ABI = [
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
];

const statePath = (net) => path.join(__dirname, "deployments", `${net}-anchor.json`);

function loadState(net) {
  const p = statePath(net);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
}
function saveState(net, obj) {
  const p = statePath(net);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
  return p;
}

/**
 * Second opinion on the feed, from the Omnipool's own price for the same pair.
 *
 * The entire operation moves a real pool onto whatever this feed says, so a
 * wrong or spoofed reading is the one input that could do damage. Both assets
 * trade on the Omnipool, which is an entirely separate price source — if the
 * two disagree materially, something is wrong and we stop rather than anchor.
 */
async function omnipoolCrossCheck(oracleE18) {
  const wsUrl = env("WS_URL", "");
  if (!wsUrl) {
    console.log("  ! WS_URL unset — skipping the Omnipool cross-check of the feed");
    return;
  }
  const { ApiPromise, WsProvider } = require("@polkadot/api");
  const id0 = Number(env("CROSSCHECK_ASSET0", "1001"));
  const id1 = Number(env("CROSSCHECK_ASSET1", "222"));
  const maxBps = BigInt(env("CROSSCHECK_MAX_BPS", "500"));
  const api = await ApiPromise.create({ provider: new WsProvider(wsUrl, 3000), noInitWarn: true });
  try {
    const [a0, a1] = await Promise.all([api.query.omnipool.assets(id0), api.query.omnipool.assets(id1)]);
    if (a0.isNone || a1.isNone) {
      console.log(`  ! asset ${id0} or ${id1} is not in the Omnipool — skipping cross-check`);
      return;
    }
    // The Omnipool account holds both reserves; price = (hub/reserve) ratio.
    const omni = "0x6d6f646c6f6d6e69706f6f6c0000000000000000";
    const provider = new ethers.JsonRpcProvider(env("EVM_RPC_URL", D.EVM_RPC_URL));
    const bal = async (token, dec) =>
      Number(await new ethers.Contract(token, ABI.erc20, provider).balanceOf(omni)) / 10 ** Number(dec);
    const t0 = requireEnv("CROSSCHECK_TOKEN0");
    const t1 = requireEnv("CROSSCHECK_TOKEN1");
    const [d0, d1] = [Number(env("CROSSCHECK_DEC0", "10")), Number(env("CROSSCHECK_DEC1", "18"))];
    const [r0, r1] = await Promise.all([bal(t0, d0), bal(t1, d1)]);
    const h0 = Number(a0.unwrap().hubReserve.toString());
    const h1 = Number(a1.unwrap().hubReserve.toString());
    if (!(r0 > 0 && r1 > 0)) {
      console.log("  ! Omnipool reserves read as zero — skipping cross-check");
      return;
    }
    const omniPrice = (h0 / r0) / (h1 / r1);
    const feed = Number(oracleE18) / 1e18;
    const diffBps = BigInt(Math.round(Math.abs(omniPrice / feed - 1) * 10_000));
    console.log(`  cross-check: Omnipool ${omniPrice.toFixed(6)} vs feed ${feed.toFixed(6)} (${diffBps} bps)`);
    if (diffBps > maxBps) {
      throw new Error(
        `the feed (${feed.toFixed(6)}) and the Omnipool (${omniPrice.toFixed(6)}) disagree by ${diffBps} bps, ` +
          `over the ${maxBps} bps limit. Refusing to anchor a pool to a price two sources cannot agree on.`
      );
    }
  } finally {
    await api.disconnect();
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const cleanupOnly = argv.includes("--cleanup");
  const net = env("NET", "mainnet");

  const provider = new ethers.JsonRpcProvider(requireEnv("EVM_RPC_URL"));
  const wallet = new ethers.Wallet(requireEnv("ANCHOR_PK"), provider);
  const confirmations = Number(env("CONFIRMATIONS", "2"));
  const poolAddress = env("POOL", D.POOL);
  const npmAddress = env("POSITION_MANAGER", D.POSITION_MANAGER);
  const routerAddress = env("SWAP_ROUTER", D.SWAP_ROUTER);
  const maxDevTicks = Number(env("ANCHOR_MAX_DEV_TICKS", "200"));

  const overrides = (extra) => gasOverrides(provider, extra);
  const send = async (txPromise, label) => waitForSuccess(await txPromise, confirmations, label);

  const pool = new ethers.Contract(poolAddress, ABI.pool, provider);
  const npm = new ethers.Contract(npmAddress, NPM_ABI, wallet);
  const router = new ethers.Contract(routerAddress, ROUTER_ABI, wallet);

  console.log(`=== anchor pool price: ${net} ===`);
  console.log(`  signer ${wallet.address}`);
  console.log(`  pool   ${poolAddress}\n`);

  for (const [label, address] of [["pool", poolAddress], ["positionManager", npmAddress], ["swapRouter", routerAddress]]) {
    if ((await provider.getCode(address)) === "0x") throw new Error(`${label} ${address} has no code on this chain`);
  }

  const [slot0, liquidity, token0, token1, fee, spacing] = await Promise.all([
    pool.slot0(),
    pool.liquidity(),
    pool.token0(),
    pool.token1(),
    pool.fee(),
    pool.tickSpacing(),
  ]);
  const erc0 = new ethers.Contract(token0, ABI.erc20, wallet);
  const erc1 = new ethers.Contract(token1, ABI.erc20, wallet);
  // ethers v6 hands back `uint8` as a bigint. Normalise once, here: everything
  // downstream mixes these with plain numbers, and BigInt/Number arithmetic throws.
  const [rawDec0, rawDec1, sym0, sym1] = await Promise.all([erc0.decimals(), erc1.decimals(), erc0.symbol(), erc1.symbol()]);
  const dec0 = Number(rawDec0);
  const dec1 = Number(rawDec1);

  const state = loadState(net);

  // --- stranded position from an interrupted run --------------------------
  if (state.tokenId !== undefined) {
    console.log(`[!] a previous run left position ${state.tokenId} — clearing it first`);
    await burnPosition(BigInt(state.tokenId));
    delete state.tokenId;
    saveState(net, state);
    if (cleanupOnly) {
      console.log("\n  cleanup done");
      return;
    }
  } else if (cleanupOnly) {
    console.log("  no recorded position to clean up");
    return;
  }

  // --- where are we, where should we be -----------------------------------
  const oracle = await resolveOraclePriceE18(ethers, provider, Number(env("STALE_SECONDS", "28800")));
  const poolE18 = priceE18FromSqrtPriceX96(slot0.sqrtPriceX96, dec0, dec1);
  const targetSqrt = sqrtPriceX96FromPriceE18(oracle.priceE18, dec0, dec1);
  const devTicks = tickDeltaBetweenSqrt(slot0.sqrtPriceX96, targetSqrt);

  console.log(`  pool   ${fmtE18(poolE18)} ${sym1}/${sym0}  tick ${slot0.tick}  liquidity ${liquidity}`);
  console.log(`  feed   ${fmtE18(oracle.priceE18)}  (age ${oracle.age}s)`);
  console.log(`  off by ${devTicks} ticks (tolerance ${maxDevTicks})`);
  await omnipoolCrossCheck(oracle.priceE18);

  if (Math.abs(devTicks) <= maxDevTicks) {
    console.log(`\n=== nothing to do — the pool is already within ${maxDevTicks} ticks of the feed ===`);
    return;
  }
  if (liquidity !== 0n) {
    throw new Error(
      `the pool holds liquidity (${liquidity}) and is ${devTicks} ticks from the feed.\n` +
        `    A pool with depth must be corrected by arbitrage, not by moving its price directly —\n` +
        `    doing it here would hand the difference to whoever is watching. Let it be arbed instead.`
    );
  }
  if (targetSqrt <= MIN_SQRT_RATIO || targetSqrt >= MAX_SQRT_RATIO) {
    throw new Error(`target sqrtPriceX96 ${targetSqrt} is outside Uniswap's representable range`);
  }

  // Price up  => buy token0 with token1. Price down => the reverse.
  const priceRises = targetSqrt > slot0.sqrtPriceX96;
  const tokenIn = priceRises ? token1 : token0;
  const tokenOut = priceRises ? token0 : token1;

  // A narrow band straddling spot: the smallest thing that makes the router's
  // deltas non-zero. The swap eats it and then rides free to the limit, so a
  // wider band would only cost more to consume.
  const mid = Math.floor(Number(slot0.tick) / Number(spacing)) * Number(spacing);
  const tickLower = mid - Number(spacing);
  const tickUpper = mid + Number(spacing);

  const amount0 = BigInt(env("MINT_AMOUNT0", (2n * 10n ** BigInt(dec0 - 1)).toString())); // 0.2 token0
  const amount1 = BigInt(env("MINT_AMOUNT1", (3n * 10n ** BigInt(dec1 - 1)).toString())); // 0.3 token1

  const [bal0, bal1, gasBal] = await Promise.all([
    erc0.balanceOf(wallet.address),
    erc1.balanceOf(wallet.address),
    provider.getBalance(wallet.address),
  ]);
  console.log(`\n  you hold ${fmtUnits(bal0, dec0)} ${sym0}, ${fmtUnits(bal1, dec1)} ${sym1}, ${ethers.formatEther(gasBal)} gas`);
  console.log(`  plan: mint [${tickLower}, ${tickUpper}] with ${fmtUnits(amount0, dec0)} ${sym0} + ${fmtUnits(amount1, dec1)} ${sym1},`);
  console.log(`        swap ${sym1 === (priceRises ? sym1 : sym0) ? "" : ""}${priceRises ? sym1 : sym0} -> ${priceRises ? sym0 : sym1} up to the feed price, then burn`);

  const missing = [];
  if (bal0 < amount0) missing.push(`${fmtUnits(amount0 - bal0, dec0)} more ${sym0}`);
  if (bal1 < amount1) missing.push(`${fmtUnits(amount1 - bal1, dec1)} more ${sym1}`);
  if (gasBal === 0n) missing.push("gas (the EVM native/WETH balance is zero)");
  if (missing.length) throw new Error(`this key cannot run the anchor — it needs ${missing.join(", ")}`);

  if (dryRun) {
    console.log("\n=== --dry-run: nothing was sent ===");
    return;
  }

  // --- 1. approvals -------------------------------------------------------
  console.log("\n[1] approvals");
  for (const [erc, sym, amount, spender, label] of [
    [erc0, sym0, amount0, npmAddress, "positionManager"],
    [erc1, sym1, amount1, npmAddress, "positionManager"],
    [priceRises ? erc1 : erc0, priceRises ? sym1 : sym0, ethers.MaxUint256, routerAddress, "swapRouter"],
  ]) {
    const current = await erc.allowance(wallet.address, spender);
    if (current >= amount) {
      console.log(`    ${sym} -> ${label}: already approved`);
      continue;
    }
    await send(
      erc.approve(spender, ethers.MaxUint256, await overrides({ gasLimit: 2_000_000n })),
      `approve ${sym} -> ${label}`
    );
  }

  // --- 2. mint the sacrificial position -----------------------------------
  console.log("\n[2] mint");
  const deadline = Number((await provider.getBlock("latest")).timestamp) + 1800;
  const mintReceipt = await send(
    npm.mint(
      {
        token0, token1, fee,
        tickLower, tickUpper,
        amount0Desired: amount0, amount1Desired: amount1,
        amount0Min: 0, amount1Min: 0,
        recipient: wallet.address,
        deadline,
      },
      // aDOT is an aToken: one transferFrom alone measures ~1.23M gas.
      await overrides({ gasLimit: BigInt(env("MINT_GAS", "6000000")) })
    ),
    "positionManager.mint"
  );
  const tokenId = tokenIdFrom(mintReceipt);
  state.tokenId = tokenId.toString();
  saveState(net, state);
  console.log(`    tokenId ${tokenId}, pool liquidity now ${await pool.liquidity()}`);

  // --- 3. one swap, stopped by the price limit ----------------------------
  console.log("\n[3] swap to the feed price");
  const amountIn = priceRises ? bal1 : bal0; // a ceiling; only what the swap consumes is ever pulled
  await send(
    router.exactInputSingle(
      {
        tokenIn, tokenOut, fee,
        recipient: wallet.address,
        amountIn,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: targetSqrt,
      },
      await overrides({ gasLimit: BigInt(env("SWAP_GAS", "6000000")) })
    ),
    "swapRouter.exactInputSingle"
  );
  const after = await pool.slot0();
  console.log(`    pool now ${fmtE18(priceE18FromSqrtPriceX96(after.sqrtPriceX96, dec0, dec1))} at tick ${after.tick}`);
  if (after.sqrtPriceX96 !== targetSqrt) {
    console.log(
      `    ! landed ${tickDeltaBetweenSqrt(after.sqrtPriceX96, targetSqrt)} ticks short of the target — ` +
        `the swap ran out of input before reaching the limit. The position is still yours; ` +
        `re-run with a larger balance to finish the move.`
    );
  }

  // --- 4. take the position back out --------------------------------------
  console.log("\n[4] burn the position");
  await burnPosition(tokenId);
  delete state.tokenId;
  saveState(net, state);

  // --- 5. prove the end state ---------------------------------------------
  const [finalSlot0, finalLiquidity, end0, end1] = await Promise.all([
    pool.slot0(),
    pool.liquidity(),
    erc0.balanceOf(wallet.address),
    erc1.balanceOf(wallet.address),
  ]);
  const finalDev = tickDeltaBetweenSqrt(finalSlot0.sqrtPriceX96, targetSqrt);
  console.log("\n=== ANCHORED ===");
  console.log(`  pool price     ${fmtE18(priceE18FromSqrtPriceX96(finalSlot0.sqrtPriceX96, dec0, dec1))} at tick ${finalSlot0.tick}`);
  console.log(`  vs the feed    ${finalDev} ticks`);
  console.log(`  pool liquidity ${finalLiquidity}${finalLiquidity === 0n ? " (empty again, as it started)" : " — NOT EMPTY, investigate"}`);
  console.log(`  your ${sym0.padEnd(6)}    ${fmtUnits(bal0, dec0)} -> ${fmtUnits(end0, dec0)}`);
  console.log(`  your ${sym1.padEnd(6)}    ${fmtUnits(bal1, dec1)} -> ${fmtUnits(end1, dec1)}`);
  console.log("\n  NEXT:");
  console.log("   - the handover can run now; it will place the band on this corrected price");
  console.log(`   - the first DEPOSIT must wait ~50-60 min: spot has jumped ${Math.abs(devTicks)} ticks away from`);
  console.log("     the pool's hourly average, and ClearingV2 rejects deposits until they reconverge");

  // -------------------------------------------------------------------------
  function tokenIdFrom(receipt) {
    // The NPM mints an ERC-721 to `recipient`: Transfer(address,address,uint256)
    // with the id in the fourth topic. Reading the log beats a second RPC call.
    const log = receipt.logs.find(
      (l) => l.address.toLowerCase() === npmAddress.toLowerCase() && l.topics.length === 4
    );
    if (!log) throw new Error("mint succeeded but no ERC-721 Transfer log was found — cannot identify the position");
    return BigInt(log.topics[3]);
  }

  async function burnPosition(id) {
    const owner = await npm.ownerOf(id).catch(() => null);
    if (!owner) {
      console.log(`    position ${id} no longer exists`);
      return;
    }
    const position = await npm.positions(id);
    const dl = Number((await provider.getBlock("latest")).timestamp) + 1800;
    if (position.liquidity > 0n) {
      await send(
        npm.decreaseLiquidity(
          { tokenId: id, liquidity: position.liquidity, amount0Min: 0, amount1Min: 0, deadline: dl },
          await overrides({ gasLimit: 4_000_000n })
        ),
        "positionManager.decreaseLiquidity"
      );
    }
    const MAX128 = (1n << 128n) - 1n;
    await send(
      npm.collect(
        { tokenId: id, recipient: wallet.address, amount0Max: MAX128, amount1Max: MAX128 },
        await overrides({ gasLimit: 4_000_000n })
      ),
      "positionManager.collect"
    );
    await send(npm.burn(id, await overrides({ gasLimit: 1_000_000n })), "positionManager.burn");
  }
}

main().catch((e) => {
  console.error("\n  Anchor FAILED:", e.message, "\n");
  console.error("  If a position was minted before the failure, re-run with --cleanup to burn it.\n");
  process.exit(1);
});
