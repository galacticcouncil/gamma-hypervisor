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
