const assert = require("node:assert/strict");
const test = require("node:test");
const {
  assetToEvmAddress,
  centeredBand,
  limitRange,
  bandMid,
  parsePriceToE18,
  priceE18FromSqrtPriceX96,
  firstDepositShares,
} = require("../lib");

test("asset aliases use the Hydration asset-ID encoding", () => {
  assert.equal(assetToEvmAddress(20), "0x0000000000000000000000000000000100000014");
  assert.equal(assetToEvmAddress(1001), "0x00000000000000000000000000000001000003e9");
});

test("price parser accepts fixed decimals and rejects ambiguous input", () => {
  assert.equal(parsePriceToE18("0.9"), 900000000000000000n);
  for (const input of ["", "1e3", "-1", ".5", "1."]) assert.throws(() => parsePriceToE18(input));
});

test("centeredBand aligns outward and stays spacing-aligned on both signs", () => {
  for (const tick of [183150, -183150, 0, 59, -59, 60, -60]) {
    const [lower, upper] = centeredBand(tick, 16, 60);
    // `%` yields -0 for aligned negatives, so compare the quotient instead.
    assert.ok(Number.isInteger(lower / 60), `lower ${lower} is not spacing-aligned`);
    assert.ok(Number.isInteger(upper / 60), `upper ${upper} is not spacing-aligned`);
    assert.ok(lower <= tick && tick < upper, `tick ${tick} outside [${lower}, ${upper}]`);
  }
});

// The band 03-handover.js sets is the baseline RebalanceProxy's maxWidth is
// measured against. If the keeper's own band can differ by more than the cap,
// the proxy reverts with "Exceeds width delta" and the keeper skips forever.
test("the launch band's width can never exceed the keeper's by more than MAX_WIDTH", () => {
  const spacing = 60;
  const mult = 16;
  const maxWidth = 300;
  let min = Infinity;
  let max = -Infinity;
  for (let tick = -600; tick <= 600; tick += 1) {
    const [lower, upper] = centeredBand(tick, mult, spacing);
    min = Math.min(min, upper - lower);
    max = Math.max(max, upper - lower);
  }
  assert.ok(max - min <= maxWidth, `width varies by ${max - min}, over maxWidth ${maxWidth}`);
  assert.equal(max - min, spacing, "outward rounding should vary the width by exactly one spacing");
});

test("the limit range never straddles the tick and never equals the base", () => {
  const spacing = 60;
  for (const tick of [183150, 183120, -100, 0, 60]) {
    const [lower, upper] = limitRange(tick, spacing, "above", 1);
    assert.ok(lower > tick, `limit lower ${lower} must sit strictly above tick ${tick}`);
    assert.ok(Number.isInteger(lower / spacing));
    assert.ok(Number.isInteger(upper / spacing));
    const [bLower, bUpper] = centeredBand(tick, 16, spacing);
    assert.ok(lower !== bLower || upper !== bUpper, "Hypervisor.rebalance rejects a limit range equal to the base");
  }
});

test("bandMid matches RebalanceProxy.isWithinRange's integer midpoint", () => {
  assert.equal(bandMid(-120, 120), 0);
  assert.equal(bandMid(100, 161), 130);
  assert.equal(bandMid(-161, -100), -131);
});

test("firstDepositShares reproduces Hypervisor.deposit's mint for an empty vault", () => {
  // 1:1 raw price => sqrtPriceX96 = 2^96, so shares = deposit1 + deposit0.
  const q96 = 2n ** 96n;
  assert.equal(firstDepositShares(q96, 5n * 10n ** 18n, 7n * 10n ** 18n), 12n * 10n ** 18n);
  // A 4x raw price weights token0 four times: shares = deposit1 + 4 * deposit0.
  assert.equal(firstDepositShares(2n * q96, 3n, 1n), 13n);
});

test("priceE18FromSqrtPriceX96 is decimals-aware for a 10dp/18dp pair", () => {
  // aDOT (10dp) / HOLLAR (18dp) at ~0.9 HOLLAR per aDOT: raw token1/token0 is
  // 0.9 * 1e8, so a naive decimals-blind read would be off by 1e8.
  const raw = 9n * 10n ** 7n; // 0.9e8
  const sqrtPriceX96 = BigInt(Math.floor(Math.sqrt(Number(raw)) * 2 ** 96));
  const human = priceE18FromSqrtPriceX96(sqrtPriceX96, 10, 18);
  const diff = human > 9n * 10n ** 17n ? human - 9n * 10n ** 17n : 9n * 10n ** 17n - human;
  assert.ok(diff * 1_000_000n <= 9n * 10n ** 17n, `${human} is outside 1 ppm of 0.9e18`);
});

const fs = require("node:fs");
const path = require("node:path");
const dotenv = require("dotenv");
const { poolSplitProblems, feedAIsToken0, resolveOraclePriceE18, stackFile, statePath, usdOfRaw, fmtUsd } = require("../lib");

const E18 = 10n ** 18n;
const withEnv = (vars, fn) => {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    });
};

// A stand-in for `ethers`: each address answers the calls a price read makes.
function fakeEthers(contracts) {
  return {
    ZeroAddress: "0x0000000000000000000000000000000000000000",
    Contract: class {
      constructor(address) {
        const c = contracts[address];
        if (!c) throw new Error(`no fake at ${address}`);
        Object.assign(this, c);
      }
    },
  };
}
const now = () => Math.floor(Date.now() / 1000);
const noAave = () => Promise.reject(new Error("not an AaveOracle"));
const feed = (answer8dp) => ({
  BASE_CURRENCY_UNIT: noAave,
  latestRoundData: async () => ({ answer: answer8dp, updatedAt: BigInt(now() - 60) }),
  decimals: async () => 8n,
});

test("a pool file may carry only per-pool keys, and the shared file none of them", () => {
  const pool = { POOL_NAME: "geth-hollar", V3_POOL: "0x9E" };
  assert.deepEqual(poolSplitProblems(pool, { STACK: "cl2" }, {}), []);
  assert.match(poolSplitProblems({ ...pool, KEEPER_ADDRESS: "0x1" }, {}, {})[0], /KEEPER_ADDRESS, which is shared/);
  assert.match(poolSplitProblems(pool, { PRICE_FEED_A: "0xFB" }, {})[0], /ENV_FILE sets PRICE_FEED_A/);
  assert.match(poolSplitProblems({ ...pool, POOL_NAME: "state" }, {}, {})[0], /not 'state'/);
});

test("every committed pool file splits cleanly and keeps customDiff above the keeper trigger", () => {
  const shared = dotenv.parse(fs.readFileSync(path.join(__dirname, "..", ".env.pools.example")));
  const dir = path.join(__dirname, "..", "pools");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".env"));
  assert.deepEqual(files.map((f) => f.replace(".env", "")).sort(), shared.STACK_POOLS.split(",").sort());
  for (const file of files) {
    const pool = dotenv.parse(fs.readFileSync(path.join(dir, file)));
    assert.deepEqual(poolSplitProblems(pool, shared, {}), [], file);
    // runbook §1c rule 1: customDiff > trigger, always (the aDOT launch broke on 500 vs 660)
    const trigger = Number(pool.REBALANCE_THRESHOLD_MULT) * 60;
    assert.ok(Number(pool.MAX_TRANSLATION) > trigger, `${file}: ${pool.MAX_TRANSLATION} <= trigger ${trigger}`);
    assert.equal(pool.LIMIT_WIDTH_MULT, pool.BASE_HALF_WIDTH_MULT, `${file}: limit spans spot to band edge`);
    assert.ok([pool.EXPECT_TOKEN0, pool.EXPECT_TOKEN1].includes(pool.TOKEN_A), `${file}: TOKEN_A is not pinned`);
    // the keeper's slippage bound keeps aDOT's headroom: ~1000 bps at mult 16, so ~16000/mult
    const want = 16000 / Number(pool.BASE_HALF_WIDTH_MULT);
    assert.ok(Math.abs(Number(pool.MINS_TOLERANCE_BPS) - want) / want < 0.05, `${file}: MINS_TOLERANCE_BPS vs ${want}`);
  }
});

test("the feed side is read off the pinned order, never guessed", async () => {
  const cases = [
    [{ TOKEN_A: "1001", EXPECT_TOKEN0: "1001", EXPECT_TOKEN1: "222" }, true],
    [{ TOKEN_A: "1006", EXPECT_TOKEN0: "222", EXPECT_TOKEN1: "1006" }, false],
    [{ TOKEN_A: undefined, EXPECT_TOKEN0: undefined, EXPECT_TOKEN1: undefined }, true],
  ];
  // one at a time: they share process.env
  for (const [vars, want] of cases) await withEnv(vars, () => assert.equal(feedAIsToken0(), want));
  await withEnv({ TOKEN_A: "5", EXPECT_TOKEN0: "222", EXPECT_TOKEN1: "1006" }, () => assert.throws(feedAIsToken0, /neither/));
});

test("a HOLLAR-first pool gets the reciprocal of the asset's USD price", async () => {
  // tBTC/USD at 83,260.1, 8 decimals
  await withEnv({ PRICE_FEED_A: "0x000000000000000000000000000000000000FEED", TOKEN_A: "1006", EXPECT_TOKEN0: "222", EXPECT_TOKEN1: "1006", PRICE_FEED_B: undefined }, async () => {
    const fakes = fakeEthers({ "0x000000000000000000000000000000000000FEED": feed(8_326_010_079_960n) });
    const { priceE18 } = await resolveOraclePriceE18(fakes, {}, 43200, "0xHOLLAR", "0xATBTC");
    // token1-per-token0 = atBTC per HOLLAR = 1 / 83,260.1
    assert.equal(priceE18, (E18 * E18) / (83_260_100_799_600_000_000_000n));
  });
});

test("an AaveOracle source prices the aToken's reserve and ages it by the DIA leg", async () => {
  const ORACLE = "0x00000000000000000000000000000000000A0A0E";
  const fakes = fakeEthers({
    [ORACLE]: {
      BASE_CURRENCY_UNIT: async () => 100_000_000n,
      getAssetPrice: async (asset) => (asset === "0xRESERVE" ? 273_728_665_302n : 0n), // $2,737.28665302
      getSourceOfAsset: async () => "0xADAPTER",
    },
    "0xGETH": { UNDERLYING_ASSET_ADDRESS: async () => "0xRESERVE" },
    "0xADAPTER": { XToUsdOracle: async () => "0xETHUSD" },
    "0xETHUSD": { latestRoundData: async () => ({ answer: 1n, updatedAt: BigInt(now() - 2374) }) },
  });
  await withEnv({ PRICE_FEED_A: ORACLE, TOKEN_A: "420", EXPECT_TOKEN0: "222", EXPECT_TOKEN1: "420", PRICE_FEED_B: undefined }, async () => {
    const r = await resolveOraclePriceE18(fakes, {}, 57600, "0xHOLLAR", "0xGETH");
    assert.equal(r.source.kind, "aave");
    assert.equal(r.source.priceE18, 2_737_286_653_020_000_000_000n);
    assert.ok(r.age >= 2374 && r.age < 2400, `age ${r.age}`);
    assert.equal(r.priceE18, (E18 * E18) / 2_737_286_653_020_000_000_000n);
    await assert.rejects(resolveOraclePriceE18(fakes, {}, 600, "0xHOLLAR", "0xGETH"), /stale/);
  });
});

test("a pool file's records live beside, never on top of, pool 1's", async () => {
  await withEnv({ POOL_NAME: undefined, STACK: undefined }, () => {
    assert.equal(path.basename(statePath("mainnet")), "mainnet-state.json");
  });
  await withEnv({ POOL_NAME: "gsol-hollar", STACK: "cl2" }, () => {
    assert.equal(path.basename(statePath("mainnet")), "mainnet-cl2-state.json");
    assert.equal(path.basename(stackFile("mainnet", "cl2", "gsol-hollar")), "mainnet-cl2-gsol-hollar.json");
  });
  await withEnv({ POOL_NAME: "gsol-hollar", STACK: undefined }, () => assert.throws(() => statePath("mainnet"), /STACK must name/));
});

test("a share cap reads in dollars of token1, which is the asset when HOLLAR sorts first", () => {
  const cap = 150_000n * E18; // 150,000 shares
  // atBTC/HOLLAR: token1 is atBTC at $83,512.26 — the same number is ~$12.5B, not $150k
  assert.equal(fmtUsd(usdOfRaw(cap, 83_512_255_695_000_000_000_000n, 18)), "$12,526,838,354.25");
  // aPAXG/HOLLAR: token1 is HOLLAR at $1 — 150,000 shares is $150k
  assert.equal(fmtUsd(usdOfRaw(cap, E18, 18)), "$150,000.00");
});
