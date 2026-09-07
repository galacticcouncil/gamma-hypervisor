/**
 * Read-only launch gate for the Gamma vault. It validates the target, the key,
 * the roles, the already-deployed Uniswap v3 pool, the guard configuration and
 * the seed BEFORE any transaction is sent.
 *
 * It verifies preconditions and never performs setup. Nothing here writes.
 */

const { ethers } = require("ethers");
const { ApiPromise, WsProvider } = require("@polkadot/api");
const {
  env,
  requireEnv,
  isMainnet,
  assetToEvmAddress,
  resolveAssetAddress,
  sortTokens,
  centeredBand,
  priceE18FromSqrtPriceX96,
  firstDepositShares,
  fmtE18,
  fmtUnits,
  loadArtifact,
  readFeedE18,
  ABI,
} = require("./lib");

let failures = 0;
const pass = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => {
  failures += 1;
  console.log(`  ✗ ${m}`);
};
const note = (m) => console.log(`  ! ${m}`);
const head = (m) => console.log(`\n--- ${m} ---`);

const numberIn = (name, min, max, def) => {
  const raw = env(name, def);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(`${name} must be an integer in [${min}, ${max}], got ${raw}`);
    return undefined;
  }
  pass(`${name}=${value}`);
  return value;
};

const bigOrUndef = (name) => {
  const raw = env(name);
  if (raw === undefined) return undefined;
  try {
    return BigInt(raw);
  } catch {
    fail(`${name} must be a raw integer amount, got ${raw}`);
    return undefined;
  }
};

const AAVE_MANAGER_EVM = "0xaa7e0000000000000000000000000000000aa7e0";

// ---------------------------------------------------------------------------

async function checkRoles(api, deployer) {
  head("roles");
  const gov = env("GOVERNANCE_ADDRESS");
  const keeper = env("KEEPER_ADDRESS");
  const feeRecipient = env("FEE_RECIPIENT");
  const allowDeployer = env("ALLOW_DEPLOYER_OWNER", "false") === "true";

  if (!ethers.isAddress(gov || "")) {
    fail("GOVERNANCE_ADDRESS must be a governance-controlled EVM address");
  } else if (isMainnet() && gov.toLowerCase() === deployer.toLowerCase() && !allowDeployer) {
    fail("GOVERNANCE_ADDRESS is the deployer; on mainnet every owner role must go to governance");
  } else {
    pass(`governance ${gov}`);
    if (gov.toLowerCase() === AAVE_MANAGER_EVM) {
      // The dispatcher's Aave-manager account is a storage value, not a
      // constant. If it ever moves, this address stops being reachable by
      // governance and the handover would strand every owner role.
      const onChain = await api.query.dispatcher.aaveManagerAccount();
      const evm = "0x" + Buffer.from(onChain.toU8a().slice(0, 20)).toString("hex");
      evm.toLowerCase() === AAVE_MANAGER_EVM
        ? pass("dispatcher.aaveManagerAccount still truncates to the configured governance address")
        : fail(`dispatcher.aaveManagerAccount now truncates to ${evm}; GOVERNANCE_ADDRESS is stale`);
    } else {
      note(`governance is not the dispatcher Aave-manager (${AAVE_MANAGER_EVM}) — confirm it is reachable`);
    }
  }

  if (!ethers.isAddress(keeper || "")) {
    fail("KEEPER_ADDRESS must be set — it is the bounded rebalancer AND the compound advisor");
  } else if (isMainnet() && keeper.toLowerCase() === deployer.toLowerCase()) {
    fail("KEEPER_ADDRESS is the deployer; the keeper is a hot key and must be separate");
  } else if (gov && keeper.toLowerCase() === String(gov).toLowerCase()) {
    fail("KEEPER_ADDRESS equals GOVERNANCE_ADDRESS; the whole point of Model B is that they differ");
  } else {
    pass(`keeper ${keeper} (rebalancer + advisor)`);
  }

  if (!ethers.isAddress(feeRecipient || "")) {
    fail("FEE_RECIPIENT must be set — rebalance() reverts on address(0) and it must match the keeper's");
  } else if (keeper && feeRecipient.toLowerCase() === String(keeper).toLowerCase()) {
    fail("FEE_RECIPIENT is the keeper key; the Gamma cut belongs to the treasury / buyback executor");
  } else {
    pass(`fee recipient ${feeRecipient}`);
  }
}

async function checkDeployer(api, provider, deployer) {
  head("deployer");
  const balance = await provider.getBalance(deployer);
  balance > 0n
    ? pass(`${deployer} has ${ethers.formatEther(balance)} WETH for gas`)
    : fail(`${deployer} has no WETH for gas`);

  // A bound key is resolved through bound_account_id, so funding its
  // `ETH\0`-truncated account silently does nothing. A fresh key is unbound.
  if (api.query.evmAccounts?.accountExtension) {
    const ext = await api.query.evmAccounts.accountExtension(deployer);
    ext.isNone
      ? pass("deployer is an unbound EVM address")
      : fail("deployer has an EVMAccounts::AccountExtension entry — use a freshly generated, unbound key");
  } else {
    note("runtime has no evmAccounts.accountExtension storage; skipping the unbound-key check");
  }
}

async function checkPool(api, provider) {
  head("uniswap v3 pool");
  const factoryAddress = env("V3_FACTORY");
  const poolAddress = env("V3_POOL");
  const fee = Number(env("FEE", "3000"));
  if (!ethers.isAddress(factoryAddress || "") || !ethers.isAddress(poolAddress || "")) {
    fail("V3_FACTORY and V3_POOL must both be addresses from the uniswap-v3-deploy launch record");
    return undefined;
  }
  for (const [label, address] of [["V3_FACTORY", factoryAddress], ["V3_POOL", poolAddress]]) {
    const code = await provider.getCode(address);
    if (!code || code === "0x") {
      fail(`${label} ${address} has no code on this chain`);
      return undefined;
    }
  }

  const ids = [Number(env("TOKEN_A", "1001")), Number(env("TOKEN_B", "222"))];
  if (!ids.every(Number.isInteger) || ids[0] === ids[1]) {
    fail("TOKEN_A and TOKEN_B must be two distinct integer asset IDs");
    return undefined;
  }
  const resolved = [];
  for (const [label, id] of [["TOKEN_A", ids[0]], ["TOKEN_B", ids[1]]]) {
    try {
      const address = await resolveAssetAddress(api, id);
      const token = new ethers.Contract(address, ABI.erc20, provider);
      const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()]);
      pass(`${label} asset ${id}: ${symbol} (${decimals} decimals) at ${address}`);
      const alias = assetToEvmAddress(id);
      if (address.toLowerCase() !== alias.toLowerCase()) {
        note(`${label} is Erc20-kind; its alias ${alias} is NOT the pool token`);
      }
      resolved.push({ id, address, symbol, decimals: Number(decimals) });
    } catch (error) {
      fail(`${label} asset ${id} is not usable: ${error.message}`);
    }
  }
  if (resolved.length !== 2) return undefined;

  const [addr0, addr1] = sortTokens(resolved[0].address, resolved[1].address);
  const t0 = resolved.find((t) => t.address === addr0);
  const t1 = resolved.find((t) => t.address === addr1);

  const expected = [env("EXPECT_TOKEN0"), env("EXPECT_TOKEN1")];
  if (isMainnet() && (!expected[0] || !expected[1])) {
    fail("EXPECT_TOKEN0 and EXPECT_TOKEN1 are required on mainnet");
  } else if (expected[0] && expected[1]) {
    Number(expected[0]) === t0.id && Number(expected[1]) === t1.id
      ? pass(`token order pinned: token0 = asset ${t0.id} (${t0.symbol}), token1 = asset ${t1.id} (${t1.symbol})`)
      : fail(`expected token order ${expected.join("/")} disagrees with the registry sort ${t0.id}/${t1.id}`);
  }

  // The v3 stack is deployed from the same nonce sequence on every chain, so a
  // stale factory address resolves to a DIFFERENT live contract rather than to
  // nothing. Prove the configured factory really does own the configured pool.
  const factory = new ethers.Contract(factoryAddress, ABI.factory, provider);
  const derived = await factory.getPool(addr0, addr1, fee);
  if (derived.toLowerCase() !== poolAddress.toLowerCase()) {
    fail(
      `stack mismatch: factory ${factoryAddress} maps (${addr0}, ${addr1}, ${fee}) to ${derived}, ` +
        `not the configured V3_POOL ${poolAddress}`
    );
    return undefined;
  }
  pass(`factory ${factoryAddress} -> pool ${poolAddress}`);

  const pool = new ethers.Contract(poolAddress, ABI.pool, provider);
  const [poolT0, poolT1, poolFee, spacing, slot0, liquidity] = await Promise.all([
    pool.token0(),
    pool.token1(),
    pool.fee(),
    pool.tickSpacing(),
    pool.slot0(),
    pool.liquidity(),
  ]);
  poolT0.toLowerCase() === addr0.toLowerCase() && poolT1.toLowerCase() === addr1.toLowerCase()
    ? pass("pool token0/token1 match the registry-resolved contracts")
    : fail(`pool holds ${poolT0}/${poolT1}, expected ${addr0}/${addr1}`);
  Number(poolFee) === fee ? pass(`pool fee ${poolFee}, tick spacing ${spacing}`) : fail(`pool fee ${poolFee}; expected ${fee}`);
  slot0.sqrtPriceX96 > 0n
    ? pass(`pool initialized at tick ${slot0.tick}`)
    : fail("pool is not initialized — run uniswap-v3-deploy/mainnet 03-create-pool.js first");

  const packed = Number(slot0.feeProtocol);
  const fp = [packed & 0x0f, packed >> 4];
  fp[0] === 0 && fp[1] === 0
    ? note("pool protocol fee is 0/0 — the uniswap-v3-deploy governance step has not enacted yet")
    : pass(`pool protocol fee ${fp[0]}/${fp[1]}`);
  liquidity > 0n ? note(`pool already holds ${liquidity} liquidity`) : pass("pool is unseeded, as expected");

  return { pool, poolAddress, factoryAddress, fee, spacing: Number(spacing), slot0, t0, t1 };
}

async function checkTwapReadiness(poolInfo) {
  head("TWAP readiness (the deposit gate)");
  // A zero window makes ClearingV2 compare spot against spot, so the deviation
  // guard passes unconditionally — the one value that silently disables it.
  const window = numberIn("TWAP_INTERVAL", 1, 7 * 24 * 60 * 60, "3600");
  if (window !== undefined && isMainnet() && window < 600) {
    fail(`TWAP_INTERVAL ${window}s is short enough to be walkable — mainnet launches at 3600`);
  }
  const blockSecs = numberIn("BLOCK_TIME_SECS", 1, 60, "2");
  const cardinality = Number(poolInfo.slot0.observationCardinalityNext);
  if (window && blockSecs) {
    const minimum = Math.ceil(window / blockSecs) + 1;
    cardinality >= minimum
      ? pass(`observationCardinalityNext ${cardinality} covers a ${window}s window at ${blockSecs}s blocks`)
      : fail(`observationCardinalityNext ${cardinality} is below ${minimum}, the minimum for a ${window}s window`);
  }
  if (Number(poolInfo.slot0.observationCardinality) < cardinality) {
    note(`ring is still filling: ${poolInfo.slot0.observationCardinality}/${cardinality} slots written`);
  }

  // Reserving slots is not the same as having history. ClearingV2 calls
  // observe() on EVERY deposit and it reverts with OLD for any window longer
  // than the pool has actually existed — so this static call, not the
  // cardinality number, is what says whether the seed can land.
  try {
    await poolInfo.pool.observe([window, 0]);
    pass(`pool.observe(${window}) succeeds — ClearingV2's TWAP guard can run`);
  } catch (error) {
    fail(
      `pool.observe(${window}) reverts (${(error.shortMessage || error.message).slice(0, 60)}) — ` +
        `the pool does not have ${window}s of history yet, so EVERY deposit will revert. ` +
        `Wait it out, or launch with a shorter TWAP_INTERVAL and raise it afterwards.`
    );
  }
}

function checkGuards(poolInfo) {
  head("guard configuration");
  const threshold = numberIn("PRICE_THRESHOLD", 1, 1_000_000, "10100");
  if (threshold !== undefined && threshold <= 10_000) {
    fail(`PRICE_THRESHOLD ${threshold} allows 0% deviation — every deposit reverts once a TWAP exists`);
  }

  // applyRatio divides by this. ClearingV2's deltaScale is 10_000, and a zero
  // here makes FullMath.mulDiv(deposit, PRECISION, 0) revert on every deposit
  // AFTER the first (the first takes the totalSupply()==0 branch and misses it).
  const delta = numberIn("DEPOSIT_DELTA", 1, 1_000_000, "10010");
  if (delta !== undefined && delta < 10_000) {
    fail(`DEPOSIT_DELTA ${delta} is below deltaScale 10_000 — the ratio band inverts`);
  }

  const divisor = numberIn("HYPERVISOR_FEE", 1, 255, "255");
  if (divisor !== undefined) {
    note(`Gamma fee divisor ${divisor} = ${(100 / divisor).toFixed(2)}% of harvested swap fees`);
  }

  const maxTranslation = numberIn("MAX_TRANSLATION", 1, 1_000_000, "500");
  const maxWidth = numberIn("MAX_WIDTH", 1, 1_000_000, "300");
  numberIn("MIN_INTERVAL", 0, 30 * 24 * 60 * 60, "21600");
  const mult = numberIn("BASE_HALF_WIDTH_MULT", 1, 4000, "16");
  numberIn("LIMIT_WIDTH_MULT", 1, 4000, "1");

  const spacing = poolInfo.spacing;
  if (maxTranslation !== undefined && maxTranslation <= 2 * spacing) {
    fail(
      `MAX_TRANSLATION ${maxTranslation} is not workable with tick spacing ${spacing}: the keeper walks ` +
        `by (cap - 2*spacing) ticks, which would be <= 0, so it can never converge`
    );
  }

  // The band 03-handover.js sets is the baseline maxWidth is measured against.
  // centeredBand's outward rounding can differ by up to 2*spacing between two
  // calls at different ticks, and the keeper re-mints at the same multiplier —
  // so the worst-case width delta is 2*spacing, and it must clear the cap.
  if (mult !== undefined && maxWidth !== undefined) {
    const worstCase = 2 * spacing;
    worstCase <= maxWidth
      ? pass(`band width delta at most ${worstCase} ticks vs maxWidth ${maxWidth} — the keeper's first rebalance can land`)
      : fail(
          `BASE_HALF_WIDTH_MULT ${mult} at spacing ${spacing} can differ from the keeper's own band by ` +
            `${worstCase} ticks, over maxWidth ${maxWidth} — the proxy would reject every rebalance`
        );
    const [lower, upper] = centeredBand(Number(poolInfo.slot0.tick), mult, spacing);
    pass(`launch band would be [${lower}, ${upper}] around tick ${poolInfo.slot0.tick} (width ${upper - lower})`);
  }
  return { threshold, delta, divisor, mult };
}

function checkSeedAndCaps(poolInfo) {
  head("seed and caps");
  const maxTotalSupply = bigOrUndef("MAX_TOTAL_SUPPLY");
  const d0max = bigOrUndef("DEPOSIT0_MAX");
  const d1max = bigOrUndef("DEPOSIT1_MAX");
  const seed0 = bigOrUndef("SEED0");
  const seed1 = bigOrUndef("SEED1");
  const seedTo = env("SEED_TO");

  const capsSet = [maxTotalSupply, d0max, d1max].some((v) => v !== undefined && v !== 0n);
  if (!capsSet) {
    isMainnet()
      ? fail("no caps set — a mainnet guarded launch needs MAX_TOTAL_SUPPLY and per-tx deposit maxima")
      : note("no caps set — unlimited deposits");
  } else {
    if (maxTotalSupply === undefined || maxTotalSupply === 0n) {
      fail("DEPOSIT0_MAX/DEPOSIT1_MAX are set but MAX_TOTAL_SUPPLY is not — the TVL cap is what bounds the vault");
    }
    // clearDeposit only reads the per-tx maxima when depositOverride is on, and
    // 02-deploy only turns that on when both are non-zero. A single-sided cap
    // would silently be inert.
    if ((d0max ?? 0n) === 0n || (d1max ?? 0n) === 0n) {
      fail("DEPOSIT0_MAX and DEPOSIT1_MAX must BOTH be non-zero, or depositOverride stays off and both are inert");
    } else {
      pass(
        `per-tx caps ${fmtUnits(d0max, poolInfo.t0.decimals)} ${poolInfo.t0.symbol} / ` +
          `${fmtUnits(d1max, poolInfo.t1.decimals)} ${poolInfo.t1.symbol}`
      );
    }
    if (maxTotalSupply) pass(`maxTotalSupply ${fmtUnits(maxTotalSupply, 18)} shares`);
  }

  if (seed0 === undefined || seed1 === undefined || seed0 === 0n || seed1 === 0n) {
    isMainnet()
      ? fail("SEED0 and SEED1 must both be non-zero — clearDeposit requires a deposit on both sides")
      : note("SEED0/SEED1 unset; the seed proposal cannot be generated yet");
    return;
  }
  if (!ethers.isAddress(seedTo || "")) {
    fail("SEED_TO must be the EVM address that receives the LP shares");
  }
  pass(
    `seed ${fmtUnits(seed0, poolInfo.t0.decimals)} ${poolInfo.t0.symbol} + ` +
      `${fmtUnits(seed1, poolInfo.t1.decimals)} ${poolInfo.t1.symbol} -> ${seedTo}`
  );

  if (d0max && seed0 > d0max) fail(`SEED0 ${seed0} exceeds DEPOSIT0_MAX ${d0max} — the seed would revert as "token0 exceeds"`);
  if (d1max && seed1 > d1max) fail(`SEED1 ${seed1} exceeds DEPOSIT1_MAX ${d1max} — the seed would revert as "token1 exceeds"`);

  // Shares minted for the first deposit, computed exactly as Hypervisor.deposit
  // does. ClearingV2.clearShares runs AFTER the mint, so a seed over the cap
  // reverts the whole referendum-enacted transaction.
  const shares = firstDepositShares(BigInt(poolInfo.slot0.sqrtPriceX96), seed0, seed1);
  console.log(`  seed mints ~${fmtUnits(shares, 18)} shares at the current pool price`);
  if (maxTotalSupply && maxTotalSupply !== 0n) {
    shares <= maxTotalSupply
      ? pass(`seed fits under maxTotalSupply (${((Number(shares) / Number(maxTotalSupply)) * 100).toFixed(1)}% of the cap)`)
      : fail(`seed mints ${shares} shares, over MAX_TOTAL_SUPPLY ${maxTotalSupply} — clearShares would revert it`);
  }

  // Not a hard failure: the FIRST deposit is ratio-unconstrained. But a seed far
  // from the pool ratio parks the excess in the limit position instead of the
  // base, which is not what a launch seed is for.
  const poolPrice = priceE18FromSqrtPriceX96(BigInt(poolInfo.slot0.sqrtPriceX96), poolInfo.t0.decimals, poolInfo.t1.decimals);
  const implied = (seed1 * 10n ** BigInt(poolInfo.t0.decimals) * 10n ** 18n) / (seed0 * 10n ** BigInt(poolInfo.t1.decimals));
  const spread = poolPrice > implied ? ((poolPrice - implied) * 10_000n) / implied : ((implied - poolPrice) * 10_000n) / poolPrice;
  console.log(`  pool price ${fmtE18(poolPrice)} vs seed ratio ${fmtE18(implied)} ${poolInfo.t1.symbol}/${poolInfo.t0.symbol} (${spread} bps)`);
  if (spread > 2_000n) note("seed is heavily one-sided; the excess side lands in the limit position, not the base");
}

async function checkPriceAndMarket(provider, poolInfo) {
  head("price feed and money market");
  const stale = numberIn("STALE_SECONDS", 1, 7 * 24 * 60 * 60, "28800");
  const feedA = env("PRICE_FEED_A");
  if (!feedA) {
    note("PRICE_FEED_A unset — no oracle cross-check of the pool price");
  } else if (!ethers.isAddress(feedA)) {
    fail(`PRICE_FEED_A is not an address: ${feedA}`);
  } else {
    try {
      const feed = new ethers.Contract(feedA, ABI.aggregatorV3, provider);
      const [description, reading] = await Promise.all([
        feed.description(),
        readFeedE18(ethers, feedA, provider, stale),
      ]);
      pass(`PRICE_FEED_A ${description}: ${fmtE18(reading.priceE18)} USD (age ${reading.age}s)`);
      let oracle = reading.priceE18;
      if (env("PRICE_FEED_B")) {
        const b = await readFeedE18(ethers, env("PRICE_FEED_B"), provider, stale);
        oracle = (oracle * 10n ** 18n) / b.priceE18;
      }
      const poolPrice = priceE18FromSqrtPriceX96(
        BigInt(poolInfo.slot0.sqrtPriceX96),
        poolInfo.t0.decimals,
        poolInfo.t1.decimals
      );
      const divergence =
        poolPrice > oracle ? ((poolPrice - oracle) * 10_000n) / oracle : ((oracle - poolPrice) * 10_000n) / poolPrice;
      divergence <= BigInt(env("MAX_DIVERGENCE_BPS", "200"))
        ? pass(`pool/feed divergence ${divergence} bps`)
        : note(`pool/feed divergence ${divergence} bps — investigate before seeding into it`);
    } catch (error) {
      fail(`PRICE_FEED_A cannot supply a fresh AggregatorV3 reading: ${error.message}`);
    }
  }

  const dataProvider = env("MM_DATA_PROVIDER");
  const underlying = env("MM_UNDERLYING");
  if (!ethers.isAddress(dataProvider || "") || !ethers.isAddress(underlying || "")) {
    note("MM_DATA_PROVIDER / MM_UNDERLYING unset — cannot check whether the aToken's reserve is paused");
    return;
  }
  try {
    const dp = new ethers.Contract(dataProvider, ABI.dataProvider, provider);
    const paused = await dp.getPaused(underlying);
    // A PAUSED reserve makes aToken transfers revert, so the pool seizes and
    // every deposit and rebalance fails on-chain. Unreadable counts as paused.
    paused ? fail("money-market reserve is PAUSED — aToken transfers revert and the pool is seized") : pass("money-market reserve is not paused");
  } catch (error) {
    fail(`cannot read the money-market pause flag (${error.message}) — failing closed`);
  }
}

function checkArtifacts() {
  head("build artifacts");
  for (const name of ["HypervisorFactory", "Hypervisor", "ClearingV2", "UniProxy", "Admin", "RebalanceProxy"]) {
    try {
      const a = loadArtifact(name);
      pass(`${name} compiled (${(a.bytecode.length - 2) / 2} bytes)`);
    } catch (error) {
      fail(error.message);
    }
  }
}

async function main() {
  const netName = env("NET", "mainnet");
  const evmRpc = env("EVM_RPC_URL", "https://rpc.hydradx.cloud");
  const wsUrl = env("WS_URL", "wss://rpc.hydradx.cloud");
  const provider = new ethers.JsonRpcProvider(evmRpc);
  const deployer = new ethers.Wallet(requireEnv("DEPLOYER_PK")).address;

  console.log(`=== Gamma preflight: ${netName} ===`);
  const network = await provider.getNetwork();
  const expectedChainId = env("CHAIN_ID", netName === "mainnet" ? "222222" : undefined);
  if (expectedChainId && network.chainId !== BigInt(expectedChainId)) {
    fail(`EVM chain ID is ${network.chainId}, expected ${expectedChainId}`);
  } else {
    pass(`EVM RPC ${evmRpc}, chain ${network.chainId}, block ${await provider.getBlockNumber()}`);
  }

  checkArtifacts();

  const api = await ApiPromise.create({ provider: new WsProvider(wsUrl), noInitWarn: true });
  try {
    const rt = api.runtimeVersion;
    pass(`Substrate WS ${wsUrl}: ${await api.rpc.system.chain()}, ${rt.specName} spec ${rt.specVersion}`);
    await checkDeployer(api, provider, deployer);
    await checkRoles(api, deployer);
    const poolInfo = await checkPool(api, provider);
    if (poolInfo) {
      await checkTwapReadiness(poolInfo);
      checkGuards(poolInfo);
      checkSeedAndCaps(poolInfo);
      await checkPriceAndMarket(provider, poolInfo);
    } else {
      fail("pool checks could not run — later checks skipped");
    }
  } finally {
    await api.disconnect();
  }

  console.log("");
  if (failures) throw new Error(`${failures} preflight check(s) failed`);
  console.log("=== preflight passed ===");
}

main().catch((error) => {
  console.error(`\nPreflight failed: ${error.message}\n`);
  process.exit(1);
});
