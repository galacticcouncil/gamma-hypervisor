/**
 * Read-only verifier for the deployed Gamma stack.
 *
 *   node 04-verify.js
 *   node 04-verify.js events <first-block> [count]
 *
 * It discriminates rather than rubber-stamps: run it before the handover and it
 * fails on the roles the deploy key still holds.
 *
 * The `events` scan exists because `dispatcher.dispatchAs*` returns {Ok} at the
 * outer level even when the inner evm.call reverted, and `utility.BatchCompleted`
 * fires regardless. A clean extrinsic result is not evidence; the event scan and
 * this state check are.
 */

const { ethers } = require("ethers");
const { ApiPromise, WsProvider } = require("@polkadot/api");
const { env, isMainnet, fmtUnits, loadDeployments, ABI } = require("./lib");

let failures = 0;
const pass = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => {
  failures += 1;
  console.log(`  ✗ ${m}`);
};
const note = (m) => console.log(`  ! ${m}`);
const head = (m) => console.log(`\n--- ${m} ---`);

const eq = (label, actual, expected) =>
  String(actual).toLowerCase() === String(expected).toLowerCase()
    ? pass(`${label} = ${actual}`)
    : fail(`${label} = ${actual}; expected ${expected}`);

async function scanEvents(api, first, count) {
  if (!Number.isInteger(first) || !Number.isInteger(count) || count < 1 || count > 100) {
    throw new Error("usage: node 04-verify.js events <first-block> [count 1..100]");
  }
  // Clamp to the chain head. `getBlockHash` past the tip returns the zero hash
  // rather than erroring, and `api.at(0x00…)` then throws "Block not found" —
  // which reads like a verification failure when it is only an over-long range.
  const head = (await api.rpc.chain.getHeader()).number.toNumber();
  const last = Math.min(first + count - 1, head);
  if (first > head) throw new Error(`start block ${first} is ahead of the chain head ${head}`);
  if (last < first + count - 1) {
    console.log(`  ! range truncated at the chain head ${head} (asked for ${count} blocks from ${first})`);
  }
  console.log(`=== Scanning blocks ${first}..${last} ===`);
  let markers = 0;
  let executed = 0;
  for (let height = first; height <= last; height += 1) {
    const hash = await api.rpc.chain.getBlockHash(height);
    const events = await (await api.at(hash)).query.system.events();
    for (const { event } of events) {
      const key = `${event.section}.${event.method}`;
      if (["evm.ExecutedFailed", "utility.BatchInterrupted", "system.ExtrinsicFailed"].includes(key)) {
        markers += 1;
        console.log(`  ✗ #${height} ${key}: ${JSON.stringify(event.data.toHuman())}`);
      } else if (key === "evm.Executed") {
        executed += 1;
      } else if (key === "scheduler.Dispatched") {
        const res = event.data.toJSON()[2];
        if (res && res.err) {
          markers += 1;
          console.log(`  ✗ #${height} scheduler.Dispatched err: ${JSON.stringify(res.err)}`);
        }
      }
    }
  }
  console.log(`  ${executed} evm.Executed event(s) in range`);
  markers ? fail(`${markers} execution failure marker(s) found`) : pass("no EVM, batch, scheduler or extrinsic failure markers found");
}

async function verify() {
  const net = env("NET", "mainnet");
  const d = loadDeployments(net);
  const g = d.gamma;
  const provider = new ethers.JsonRpcProvider(env("EVM_RPC_URL", d.network.evmRpc));
  const network = await provider.getNetwork();
  const governance = env("GOVERNANCE_ADDRESS", d.governance);
  const keeper = env("KEEPER_ADDRESS", d.keeper);
  const handedOver = env("EXPECT_POSTURE", d.config?.posture ?? "production") === "production";

  console.log(`=== Verifying Gamma: ${net} (expecting the ${handedOver ? "PRODUCTION" : "BOOTSTRAP"} posture) ===`);
  if (d.network.chainId && network.chainId.toString() !== d.network.chainId) {
    fail(`chain ID ${network.chainId}; deployment record is for ${d.network.chainId}`);
  } else {
    pass(`EVM chain ${network.chainId}, block ${await provider.getBlockNumber()}`);
  }

  head("deployed contracts");
  for (const [name, address] of Object.entries(g)) {
    const code = await provider.getCode(address);
    code !== "0x" ? pass(`${name} has code at ${address}`) : fail(`${name} has no code at ${address}`);
  }

  const vault = new ethers.Contract(g.hypervisor, ABI.hypervisor, provider);
  const clearing = new ethers.Contract(g.clearing, ABI.clearing, provider);
  const uniProxy = new ethers.Contract(g.uniProxy, ABI.uniProxy, provider);
  const admin = new ethers.Contract(g.admin, ABI.admin, provider);
  const proxy = new ethers.Contract(g.rebalanceProxy, ABI.rebalanceProxy, provider);
  const hyperFactory = new ethers.Contract(g.hypervisorFactory, ABI.hypervisorFactory, provider);
  const pool = new ethers.Contract(d.uniswap.pool, ABI.pool, provider);

  head("vault identity");
  eq("hypervisor.pool()", await vault.pool(), d.uniswap.pool);
  eq("hypervisor.token0()", await vault.token0(), d.uniswap.token0);
  eq("hypervisor.token1()", await vault.token1(), d.uniswap.token1);
  eq("factory.getHypervisor()", await hyperFactory.getHypervisor(d.uniswap.token0, d.uniswap.token1, d.uniswap.fee), g.hypervisor);
  eq("hypervisorFactory.uniswapV3Factory()", await hyperFactory.uniswapV3Factory(), d.uniswap.v3Factory);
  const [name, symbol] = await Promise.all([vault.name(), vault.symbol()]);
  pass(`LP token "${name}" (${symbol}) — constructor args, no setter`);

  head("ownership");
  const roles = [
    ["hypervisor.owner()", await vault.owner(), handedOver ? g.admin : d.deployer],
    ["admin.admin()", await admin.admin(), handedOver ? governance : d.deployer],
    ["clearing.owner()", await clearing.owner(), handedOver ? governance : d.deployer],
    ["uniProxy.owner()", await uniProxy.owner(), handedOver ? governance : d.deployer],
    ["rebalanceProxy.owner()", await proxy.owner(), handedOver ? governance : d.deployer],
    ["hypervisorFactory.owner()", await hyperFactory.owner(), handedOver ? governance : d.deployer],
  ];
  for (const [label, actual, expected] of roles) eq(label, actual, expected);
  if (handedOver) {
    // The failure this catches is a partial handover: a port of the testnet
    // script moves Admin and the vault and silently leaves the other three.
    const residue = roles.filter(([, actual]) => String(actual).toLowerCase() === String(d.deployer).toLowerCase());
    residue.length === 0
      ? pass(`deploy key ${d.deployer} holds no role`)
      : fail(`deploy key still holds ${residue.length} role(s): ${residue.map(([l]) => l).join(", ")}`);
  }

  head("Model B wiring");
  eq("admin.rebalancers[vault]", await admin.rebalancers(g.hypervisor), g.rebalanceProxy);
  eq("proxy.admins[vault]", await proxy.admins(g.hypervisor), g.admin);
  eq("proxy.rebalancers[vault]", await proxy.rebalancers(g.hypervisor), keeper);
  eq("admin.advisors[vault]", await admin.advisors(g.hypervisor), keeper);
  const [diff, width, interval, exempt] = await Promise.all([
    proxy.customDiff(g.hypervisor),
    proxy.customWidth(g.hypervisor),
    proxy.customInterval(g.hypervisor),
    proxy.exempted(g.hypervisor),
  ]);
  // A zero cap silently falls through to the proxy's shared global default.
  diff > 0n && width > 0n && interval > 0n
    ? pass(`caps maxTranslation=${diff} maxWidth=${width} minInterval=${interval}s`)
    : fail(`a cap is 0 (maxTranslation=${diff} maxWidth=${width} minInterval=${interval}) — that falls back to the shared global default`);
  exempt ? fail("vault is EXEMPTED from the proxy caps") : pass("vault is not exempted from the caps");

  head("deposit guards");
  eq("uniProxy.clearance()", await uniProxy.clearance(), g.clearing);
  const whitelisted = await vault.whitelistedAddress();
  // 02-deploy sets no whitelist at all: in the bootstrap posture nothing can
  // deposit, which is the correct state for a vault that has not been handed
  // over yet.
  handedOver
    ? eq("hypervisor.whitelistedAddress()", whitelisted, g.uniProxy)
    : note(`hypervisor.whitelistedAddress() = ${whitelisted} (deposits are closed until the handover)`);
  const [twapCheck, twapInterval, priceThreshold, position, paused, deltaScale] = await Promise.all([
    clearing.twapCheck(),
    clearing.twapInterval(),
    clearing.priceThreshold(),
    clearing.positions(g.hypervisor),
    clearing.paused(),
    clearing.deltaScale(),
  ]);
  twapCheck ? pass("clearing.twapCheck on") : fail("clearing.twapCheck is OFF — deposits skip the deviation guard");
  paused ? fail("clearing is PAUSED — no deposits can land") : pass("clearing is not paused");
  Number(position.version) > 0 ? pass(`vault added as ClearingV2 position (version ${position.version})`) : fail("vault is not an added ClearingV2 position");
  Number(twapInterval) === Number(d.config.twapInterval)
    ? pass(`clearing.twapInterval ${twapInterval}s`)
    : fail(`clearing.twapInterval ${twapInterval}s; record says ${d.config.twapInterval}s`);
  Number(priceThreshold) > 10_000
    ? pass(`clearing.priceThreshold ${priceThreshold} (${(Number(priceThreshold) - 10_000) / 100}% deviation)`)
    : fail(`clearing.priceThreshold ${priceThreshold} allows 0% deviation — every deposit reverts`);
  console.log(`  caps: supply=${position.maxTotalSupply} d0=${position.deposit0Max} d1=${position.deposit1Max} delta=${position.customDepositDelta} override=${position.depositOverride}`);
  if (position.depositOverride) {
    // applyRatio divides by customDepositDelta. A zero here passes the first
    // deposit (totalSupply()==0 takes another branch) and reverts every one after.
    position.customDepositDelta >= deltaScale
      ? pass(`customDepositDelta ${position.customDepositDelta} vs deltaScale ${deltaScale}`)
      : fail(`customDepositDelta ${position.customDepositDelta} is below deltaScale ${deltaScale} — deposits after the first revert in FullMath.mulDiv`);
  } else if (position.deposit0Max > 0n || position.deposit1Max > 0n) {
    fail("per-tx caps are stored but depositOverride is OFF — they are inert");
  }
  if (isMainnet() && position.maxTotalSupply === 0n) fail("maxTotalSupply is 0 (uncapped) on mainnet");

  head("vault posture");
  const [feeDivisor, feeRecipient, directDeposit, baseLower, baseUpper, limitLower, limitUpper, supply, totals] = await Promise.all([
    vault.fee(),
    vault.feeRecipient(),
    vault.directDeposit(),
    vault.baseLower(),
    vault.baseUpper(),
    vault.limitLower(),
    vault.limitUpper(),
    vault.totalSupply(),
    vault.getTotalAmounts(),
  ]);
  Number(feeDivisor) >= 1
    ? pass(`hypervisor.fee divisor ${feeDivisor} = ${(100 / Number(feeDivisor)).toFixed(2)}% of harvested swap fees`)
    : fail("hypervisor.fee is 0 — every harvest divides by zero and reverts");
  if (d.config?.hypervisorFee && Number(feeDivisor) !== d.config.hypervisorFee) {
    fail(`hypervisor.fee ${feeDivisor} does not match the record's ${d.config.hypervisorFee}`);
  }
  if (feeRecipient !== ethers.ZeroAddress) {
    pass(`feeRecipient ${feeRecipient}`);
    if (d.feeRecipient) eq("feeRecipient matches record", feeRecipient, d.feeRecipient);
  } else if (handedOver) {
    // rebalance() stores it and reverts on address(0), so a handed-over vault
    // that still reads zero has never had a successful rebalance.
    fail("feeRecipient is unset — no rebalance has run");
  } else {
    note("feeRecipient unset — the handover's first rebalance is what names it");
  }
  directDeposit ? fail("directDeposit is ON — deposits enter the pool atomically, which is a sandwich surface") : pass("directDeposit off");
  if (Number(baseLower) !== Number(baseUpper)) {
    pass(`base [${baseLower}, ${baseUpper}] width ${Number(baseUpper) - Number(baseLower)}, limit [${limitLower}, ${limitUpper}]`);
  } else if (handedOver) {
    fail("base range is unset — ClearingV2 rejects every deposit until it is");
  } else {
    note("base range unset — the handover sets it");
  }
  console.log(`  totalSupply ${fmtUnits(supply, 18)} shares; holdings ${totals.total0} / ${totals.total1}`);
  supply === 0n ? note("vault is unseeded") : pass("vault holds shares");

  head("pool linkage");
  const [slot0, spacing] = await Promise.all([pool.slot0(), pool.tickSpacing()]);
  const tick = Number(slot0.tick);
  const inBand = tick >= Number(baseLower) && tick < Number(baseUpper);
  if (inBand) {
    pass(`tick ${tick} sits inside the base range`);
  } else if (handedOver) {
    fail(`tick ${tick} is OUTSIDE [${baseLower}, ${baseUpper}] — ClearingV2 rejects every deposit until the keeper moves the band`);
  } else {
    note(`tick ${tick} is outside the (unset) base range`);
  }
  const window = Number(d.config.twapInterval);
  try {
    await pool.observe([window, 0]);
    pass(`pool.observe(${window}) succeeds — the deposit TWAP guard can run`);
  } catch (error) {
    fail(`pool.observe(${window}) reverts — the pool lacks ${window}s of history, so every deposit reverts`);
  }
  console.log(`  observations ${slot0.observationCardinality}/${slot0.observationCardinalityNext}, tick spacing ${spacing}`);

  if (handedOver) {
    head("live deposit path");
    // A nominal, ratio-correct probe: does a deposit clear right now? This is
    // the single check that composes all of the above.
    try {
      const probe0 = 10n ** BigInt(Number(await new ethers.Contract(d.uniswap.token0, ABI.erc20, provider).decimals()));
      // The midpoint of the ratio band, not its edge: clearDeposit checks the
      // ratio in BOTH directions, and an edge value satisfies only one of them.
      const [probeStart, probeEnd] = await clearing.getDepositAmount(g.hypervisor, d.uniswap.token0, probe0);
      const probe1 = (probeStart + probeEnd) / 2n || 1n;
      await clearing.clearDeposit(probe0, probe1, d.deployer, d.deployer, g.hypervisor, [0, 0, 0, 0]);
      pass(`clearDeposit(${probe0}, ${probe1}) passes — the deposit path is live`);
    } catch (error) {
      fail(`a nominal deposit does not clear: ${(error.shortMessage || error.message).slice(0, 120)}`);
    }
  }
}

async function main() {
  const net = env("NET", "mainnet");
  const d = loadDeployments(net);
  const api = await ApiPromise.create({ provider: new WsProvider(env("WS_URL", d.network.substrateWs)), noInitWarn: true });
  try {
    if (process.argv[2] === "events") {
      await scanEvents(api, Number(process.argv[3]), Number(process.argv[4] ?? 3));
    } else {
      await verify();
    }
  } finally {
    await api.disconnect();
  }
  console.log("");
  if (failures) throw new Error(`${failures} verification check(s) failed`);
  console.log("=== verification passed ===");
}

main().catch((error) => {
  console.error(`\nVerification failed: ${error.message}\n`);
  process.exit(1);
});
