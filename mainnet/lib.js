/**
 * lib.js — shared helpers for the Gamma mainnet launch scripts.
 *
 * Everything is env-driven (see .env.example); no chain writes happen here.
 *
 * This mirrors uniswap-v3-deploy/mainnet/lib.js deliberately. The two launches
 * run against the same chain, the same gas rules and the same asset-resolution
 * rules, and a divergence between them is a bug in one of the two.
 */

const fs = require("fs");
const path = require("path");

try {
  // Keep the selected launch configuration explicit. This lets an operator run
  // `ENV_FILE=.env.mainnet npm run all` without copying a production key into
  // the default .env (which is commonly a local-fork configuration).
  const envFile = process.env.ENV_FILE
    ? path.resolve(process.cwd(), process.env.ENV_FILE)
    : path.join(__dirname, ".env");
  require("dotenv").config({ path: envFile });
} catch {
  /* dotenv optional — plain env vars work too */
}

const REPO = path.join(__dirname, "..");

const env = (name, def) => {
  const v = process.env[name];
  return v === undefined || v === "" ? def : v;
};

const requireEnv = (name) => {
  const v = env(name);
  if (v === undefined) throw new Error(`missing env: ${name} (see mainnet/.env.example)`);
  return v;
};

const isMainnet = () => env("NET", "mainnet") === "mainnet";

// ---------------------------------------------------------------------------
// Asset resolution
// ---------------------------------------------------------------------------

// Asset ERC-20 precompile alias: 0x…01 ++ assetId (big-endian, last 4 bytes).
// Correct ONLY for `Token`-kind assets. See resolveAssetAddress.
function assetToEvmAddress(assetId) {
  return "0x" + "0".repeat(30) + "01" + Number(assetId).toString(16).padStart(8, "0");
}

/**
 * The EVM address the RUNTIME uses for an asset — which is not always the alias.
 *
 * `HydraErc20Mapping::asset_address` is:
 *
 *     pallet_asset_registry::contract_address(asset_id)          // Erc20: the real contract
 *         .unwrap_or_else(|| encode_evm_address(asset_id))       // Token: the alias
 *
 * For aDOT and HOLLAR — both `Erc20`-kind — the alias is NOT the pool token. It
 * answers `symbol()`/`decimals()`, which is what makes the mistake survive a
 * casual check, but `factory.getPool` against it returns a different (unroutable)
 * pool and aDOT's alias reverts on `transfer`. It also flips the sort order:
 * by alias HOLLAR sorts first, by contract aDOT does.
 */
async function resolveAssetAddress(api, assetId) {
  const reg = await api.query.assetRegistry.assets(assetId);
  if (reg.isNone) throw new Error(`asset ${assetId} is not registered`);
  if (reg.unwrap().toHuman().assetType !== "Erc20") return assetToEvmAddress(assetId);

  const locQ = api.query.assetRegistry.assetLocations || api.query.assetRegistry.locations;
  const loc = await locQ(assetId);
  const m = JSON.stringify(loc.toJSON()).match(/"accountKey20":\{[^}]*"key":"(0x[0-9a-fA-F]{40})"/);
  if (!m) throw new Error(`asset ${assetId} is Erc20 but has no AccountKey20 location`);
  return require("ethers").getAddress(m[1]);
}

function sortTokens(a, b) {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

// ---------------------------------------------------------------------------
// Tick math — MUST agree with the keeper (keeper/src/ticks.ts)
// ---------------------------------------------------------------------------
//
// The band this repo's 03-handover.js sets is the baseline that
// RebalanceProxy's `maxWidth` is measured against. If the keeper's first
// rebalance re-mints at a width more than `maxWidth` away from it, the proxy
// reverts with "Exceeds width delta" and the keeper skips FOREVER — a vault
// that looks healthy and is silently unmanaged. These four functions are
// transcribed from keeper/src/ticks.ts for exactly that reason; the unit test
// asserts the resulting width delta against the configured cap.

function floorToSpacing(tick, spacing) {
  let mod = tick % spacing;
  if (mod < 0) mod += spacing;
  return tick - mod;
}

function ceilToSpacing(tick, spacing) {
  const f = floorToSpacing(tick, spacing);
  return f === tick ? f : f + spacing;
}

function truncToSpacing(tick, spacing) {
  return Math.trunc(tick / spacing) * spacing;
}

/** Base position: `halfWidthMult` spacings either side of `tick`, aligned out. */
function centeredBand(tick, halfWidthMult, spacing) {
  const half = halfWidthMult * spacing;
  return [floorToSpacing(tick - half, spacing), ceilToSpacing(tick + half, spacing)];
}

/**
 * Limit position: strictly to one side of the current tick.
 *
 * `Hypervisor.rebalance` rejects a limit range identical to the base range, and
 * `ClearingV2.clearDeposit` needs the base range to straddle the tick — so the
 * limit goes just above (or below) and never overlaps the tick itself.
 */
function limitRange(tick, spacing, side, widthMult) {
  if (side === "above") {
    let lower = truncToSpacing(tick, spacing) + spacing;
    if (lower === tick) lower += spacing;
    return [lower, lower + spacing * widthMult];
  }
  let upper = truncToSpacing(tick, spacing) - spacing;
  if (upper === tick) upper -= spacing;
  return [upper - spacing * widthMult, upper];
}

/** RebalanceProxy.isWithinRange's midpoint: lower + trunc((upper - lower) / 2). */
const bandMid = (lower, upper) => lower + Math.trunc((upper - lower) / 2);

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

function isqrt(n) {
  if (n < 0n) throw new Error("isqrt of negative");
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

// "4.2" -> 4_200000000000000000n (1e18 fixed point). Rejects exponents.
function parsePriceToE18(s) {
  const m = String(s).trim().match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) throw new Error(`bad price: ${s} (use a plain decimal like 4.2)`);
  const frac = (m[2] || "").padEnd(18, "0").slice(0, 18);
  return BigInt(m[1]) * 10n ** 18n + BigInt(frac);
}

/** sqrtPriceX96 -> human token1-per-token0, 1e18, decimals-aware. */
function priceE18FromSqrtPriceX96(sqrtPriceX96, dec0, dec1) {
  const E18 = 10n ** 18n;
  const rawE18 = (sqrtPriceX96 * sqrtPriceX96 * E18) >> 192n;
  return (rawE18 * 10n ** BigInt(dec0)) / 10n ** BigInt(dec1);
}

const fmtE18 = (x) => {
  const s = (x / 10n ** 12n).toString().padStart(7, "0");
  return `${s.slice(0, -6)}.${s.slice(-6)}`;
};

const fmtUnits = (x, decimals) => require("ethers").formatUnits(x, Number(decimals));

/**
 * Shares `Hypervisor.deposit` mints for the FIRST deposit into an empty vault.
 *
 *     price  = (sqrtPriceX96^2 * 1e36) >> 192          (raw token1 per raw token0)
 *     shares = deposit1 + deposit0 * price / 1e36
 *
 * Transcribed from Hypervisor.sol so the launch can check the seed against
 * ClearingV2's `maxTotalSupply` BEFORE a referendum is submitted. Getting this
 * wrong does not fail politely: the deposit reverts inside `clearShares` after
 * enactment, and the whole referendum has to be re-run.
 */
function firstDepositShares(sqrtPriceX96, deposit0, deposit1) {
  const PRECISION = 10n ** 36n;
  const price = (sqrtPriceX96 * sqrtPriceX96 * PRECISION) >> 192n;
  return deposit1 + (deposit0 * price) / PRECISION;
}

// ---------------------------------------------------------------------------
// ABIs
// ---------------------------------------------------------------------------

const ABI = {
  erc20: [
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
    "function transfer(address,uint256) returns (bool)",
    "function totalSupply() view returns (uint256)",
  ],
  factory: [
    "function owner() view returns (address)",
    "function getPool(address,address,uint24) view returns (address)",
    "function feeAmountTickSpacing(uint24) view returns (int24)",
  ],
  pool: [
    "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
    "function observe(uint32[]) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)",
    "function observations(uint256) view returns (uint32 blockTimestamp, int56 tickCumulative, uint160 secondsPerLiquidityCumulativeX128, bool initialized)",
    "function increaseObservationCardinalityNext(uint16)",
    "function liquidity() view returns (uint128)",
    "function token0() view returns (address)",
    "function token1() view returns (address)",
    "function fee() view returns (uint24)",
    "function tickSpacing() view returns (int24)",
  ],
  hypervisorFactory: [
    "function owner() view returns (address)",
    "function uniswapV3Factory() view returns (address)",
    "function getHypervisor(address,address,uint24) view returns (address)",
    "function createHypervisor(address,address,uint24,string,string) returns (address)",
    "function transferOwnership(address)",
  ],
  hypervisor: [
    "function owner() view returns (address)",
    "function pool() view returns (address)",
    "function token0() view returns (address)",
    "function token1() view returns (address)",
    "function name() view returns (string)",
    "function symbol() view returns (string)",
    "function fee() view returns (uint8)",
    "function feeRecipient() view returns (address)",
    "function whitelistedAddress() view returns (address)",
    "function directDeposit() view returns (bool)",
    "function tickSpacing() view returns (int24)",
    "function currentTick() view returns (int24)",
    "function baseLower() view returns (int24)",
    "function baseUpper() view returns (int24)",
    "function limitLower() view returns (int24)",
    "function limitUpper() view returns (int24)",
    "function maxTotalSupply() view returns (uint256)",
    "function deposit0Max() view returns (uint256)",
    "function deposit1Max() view returns (uint256)",
    "function totalSupply() view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
    "function getTotalAmounts() view returns (uint256 total0, uint256 total1)",
    "function getBasePosition() view returns (uint128 liquidity, uint256 amount0, uint256 amount1)",
    "function getLimitPosition() view returns (uint128 liquidity, uint256 amount0, uint256 amount1)",
    "function setFee(uint8)",
    "function setWhitelist(address)",
    "function toggleDirectDeposit()",
    "function transferOwnership(address)",
    "function rebalance(int24,int24,int24,int24,address,uint256[4],uint256[4])",
    "function withdraw(uint256,address,address,uint256[4]) returns (uint256,uint256)",
  ],
  clearing: [
    "function owner() view returns (address)",
    "function paused() view returns (bool)",
    "function twapCheck() view returns (bool)",
    "function twapInterval() view returns (uint32)",
    "function priceThreshold() view returns (uint256)",
    "function depositDelta() view returns (uint256)",
    "function deltaScale() view returns (uint256)",
    "function positions(address) view returns (bool customRatio, bool customTwap, bool ratioRemoved, bool depositOverride, bool twapOverride, uint8 version, uint32 twapInterval, uint256 priceThreshold, uint256 deposit0Max, uint256 deposit1Max, uint256 maxTotalSupply, uint256 fauxTotal0, uint256 fauxTotal1, uint256 customDepositDelta)",
    "function getDepositAmount(address,address,uint256) view returns (uint256 amountStart, uint256 amountEnd)",
    "function clearDeposit(uint256,uint256,address,address,address,uint256[4]) view returns (bool)",
    "function checkPriceChange(address,uint32,uint256) view returns (uint256)",
    "function addPosition(address,uint8)",
    "function setTwapInterval(uint32)",
    "function setPriceThreshold(uint256)",
    "function customDeposit(address,uint256,uint256,uint256,uint256)",
    "function setDepositOverride(address,bool)",
    "function pause(bool)",
    "function transferOwnership(address)",
  ],
  uniProxy: [
    "function owner() view returns (address)",
    "function clearance() view returns (address)",
    "function deposit(uint256,uint256,address,address,uint256[4]) returns (uint256 shares)",
    "function transferClearance(address)",
    "function transferOwnership(address)",
  ],
  admin: [
    "function admin() view returns (address)",
    "function rebalancers(address) view returns (address)",
    "function advisors(address) view returns (address)",
    "function setRebalancer(address,address)",
    "function setAdvisor(address,address)",
    "function setFee(address,uint8)",
    "function setWhitelist(address,address)",
    "function transferAdmin(address)",
    "function transferHypervisorOwner(address,address)",
    "function rebalance(address,int24,int24,int24,int24,address,uint256[4],uint256[4])",
    "function pullLiquidity(address,uint256,uint256[4]) returns (uint256,uint256,uint256,uint256)",
    "function compound(address,uint256[4])",
  ],
  rebalanceProxy: [
    "function owner() view returns (address)",
    "function admins(address) view returns (address)",
    "function rebalancers(address) view returns (address)",
    "function exempted(address) view returns (bool)",
    "function customDiff(address) view returns (uint256)",
    "function customWidth(address) view returns (uint256)",
    "function customInterval(address) view returns (uint256)",
    "function lastRebalance(address) view returns (uint256)",
    "function setAdmin(address,address)",
    "function setRebalancer(address,address)",
    "function setCustomDiff(address,uint256)",
    "function setCustomDiffWidth(address,uint256)",
    "function setCustomInterval(address,uint256)",
    "function rebalance(address,int24,int24,int24,int24,address,uint256[4],uint256[4])",
    "function transferOwner(address)",
  ],
  // Price feeds on Hydration are Chainlink AggregatorV3, NOT DIA getValue(string).
  // DIA is the data SOURCE; the chain serves it through the AggregatorV3
  // interface (the same feeds the Aave market consumes). Every mainnet feed
  // reverts on getValue() and answers latestRoundData(), verified 2026-08-21.
  aggregatorV3: [
    "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
    "function decimals() view returns (uint8)",
    "function description() view returns (string)",
  ],
  // A PAUSED money-market reserve makes aToken transfers revert, so the pool
  // seizes and every rebalance fails on-chain. Underlying (DOT), not the aToken.
  dataProvider: ["function getPaused(address) view returns (bool)"],
};

/**
 * Read one AggregatorV3 feed as a 1e18 fixed-point USD price, plus its age.
 * Throws on a stale, zero or negative answer — callers treat any throw as fatal.
 */
async function readFeedE18(ethers, address, provider, staleSeconds) {
  const feed = new ethers.Contract(address, ABI.aggregatorV3, provider);
  const [round, decimals] = await Promise.all([feed.latestRoundData(), feed.decimals()]);
  const answer = round.answer;
  if (answer <= 0n) throw new Error(`feed ${address} returned ${answer}`);
  const age = Math.floor(Date.now() / 1000) - Number(round.updatedAt);
  if (age > staleSeconds) throw new Error(`feed ${address} is stale (${age}s old)`);
  const dec = Number(decimals);
  if (dec > 18) throw new Error(`feed ${address} has ${dec} decimals, expected <= 18`);
  return { priceE18: BigInt(answer) * 10n ** BigInt(18 - dec), age, decimals: dec };
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/**
 * Transaction overrides that survive Hydration's DynamicEvmFee.
 *
 * Setting `gasPrice` explicitly does two things at once:
 *
 *  1. **Clears the fee floor.** Hydration recomputes the EVM base fee every
 *     block, so a fee ethers resolved a moment ago can be under the floor by the
 *     time the tx is applied. It is then dropped at apply with
 *     `Invalid: { Custom: 2 }` = `GasPriceTooLow` — and a dropped extrinsic never
 *     produces a receipt, so the script hangs on `.wait()` rather than failing.
 *
 *  2. **Makes it a legacy (type-0) tx**, sidestepping ethers v6's EIP-1559
 *     estimation entirely.
 *
 * The explicit gasLimit is equally load-bearing: Hydration's `eth_estimateGas`
 * under-reports, and ethers sends the estimate verbatim. A status-0 receipt that
 * burned *exactly* the estimate is the signature of that, not a logic revert.
 * Unused gas is not charged, so overshooting is free.
 */
async function gasOverrides(provider, extra = {}) {
  const base = BigInt(await provider.send("eth_gasPrice", []));
  const mult = BigInt(env("GAS_PRICE_MULT", "4"));
  if (mult < 1n) throw new Error(`GAS_PRICE_MULT must be at least 1, got ${mult}`);
  const out = { gasPrice: base * mult };

  const limit = env("EVM_GAS_LIMIT", "15000000");
  if (limit && !("gasLimit" in extra)) {
    const n = BigInt(limit);
    if (n < 21_000n) throw new Error(`EVM_GAS_LIMIT ${n} is below the intrinsic transaction minimum`);
    // NORMAL_DISPATCH_RATIO * MAXIMUM_BLOCK_WEIGHT / WEIGHT_PER_GAS = 20,000,000.
    // Exceeding it is rejected as Custom(1) GasLimitExceedsBlockLimit.
    if (n > 20_000_000n) throw new Error(`EVM_GAS_LIMIT ${n} exceeds the 20,000,000 block gas limit`);
    out.gasLimit = n;
  }
  return { ...out, ...extra };
}

/** Await a receipt and treat anything but status 1 as fatal. */
async function waitForSuccess(tx, confirmations, label) {
  const receipt = await tx.wait(confirmations, 15 * 60_000);
  if (!receipt || receipt.status !== 1) throw new Error(`${label} reverted or timed out (${tx.hash})`);
  console.log(`  ${label}: ${receipt.hash}`);
  return receipt;
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

const ARTIFACTS = {
  HypervisorFactory: "contracts/HypervisorFactory.sol/HypervisorFactory.json",
  Hypervisor: "contracts/Hypervisor.sol/Hypervisor.json",
  ClearingV2: "contracts/ClearingV2.sol/ClearingV2.json",
  UniProxy: "contracts/UniProxy.sol/UniProxy.json",
  Admin: "contracts/proxy/admin.sol/Admin.json",
  RebalanceProxy: "contracts/RebalanceProxy.sol/RebalanceProxy.json",
};

/**
 * Load a Hardhat build artifact from the repo root.
 *
 * The launch scripts deploy from `artifacts/`, not from a Hardhat runtime, so
 * that gas policy (above) is theirs and not hardhat-ethers'. That makes
 * `npx hardhat compile` a hard prerequisite, which is why this throws loudly.
 */
function loadArtifact(name) {
  const rel = ARTIFACTS[name];
  if (!rel) throw new Error(`unknown artifact ${name}`);
  const p = path.join(REPO, "artifacts", rel);
  if (!fs.existsSync(p)) {
    throw new Error(`${p} not found — run \`npx hardhat compile\` in ${REPO} first`);
  }
  const a = JSON.parse(fs.readFileSync(p, "utf8"));
  if (!a.bytecode || a.bytecode === "0x") throw new Error(`${name} artifact has no bytecode`);
  return a;
}

/** Deploy one contract and prove it has code before reporting success. */
async function deployContract(ethers, wallet, name, args, overrides, confirmations) {
  const artifact = loadArtifact(name);
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const contract = await factory.deploy(...args, overrides);
  await waitForSuccess(contract.deploymentTransaction(), confirmations, `deploy ${name}`);
  const address = await contract.getAddress();
  const code = await wallet.provider.getCode(address);
  if (!code || code === "0x") throw new Error(`${name} deployed to ${address} but has no code`);
  console.log(`  ${name.padEnd(18)} ${address}`);
  return address;
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

function deploymentPath(net) {
  return path.join(__dirname, "deployments", `${net}.json`);
}

function loadDeployments(net) {
  const p = deploymentPath(net);
  if (!fs.existsSync(p)) throw new Error(`${p} not found — run 02-deploy.js first`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function saveJson(rel, obj) {
  const p = path.join(__dirname, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  fs.renameSync(tmp, p);
  return p;
}

module.exports = {
  REPO,
  env,
  requireEnv,
  isMainnet,
  assetToEvmAddress,
  resolveAssetAddress,
  sortTokens,
  floorToSpacing,
  ceilToSpacing,
  truncToSpacing,
  centeredBand,
  limitRange,
  bandMid,
  isqrt,
  parsePriceToE18,
  priceE18FromSqrtPriceX96,
  firstDepositShares,
  fmtE18,
  fmtUnits,
  ABI,
  readFeedE18,
  gasOverrides,
  waitForSuccess,
  loadArtifact,
  deployContract,
  deploymentPath,
  loadDeployments,
  saveJson,
};
