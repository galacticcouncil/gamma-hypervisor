/**
 * 10-chopsticks-rehearsal.js — drive the whole Gamma launch against a chopsticks
 * fork of mainnet. Refuses to run against anything that is not a local fork.
 *
 *   node 10-chopsticks-rehearsal.js govern              # Root: WETH gas for the deploy + keeper keys
 *   node 10-chopsticks-rehearsal.js warm-twap [secs]    # jump the fork clock so observe(window) stops reverting
 *   node 10-chopsticks-rehearsal.js seed                # inject 01's seed bundle with Root, then check state
 *   node 10-chopsticks-rehearsal.js fund <evm> [a0 a1]  # treasury -> address, both pool tokens
 *   node 10-chopsticks-rehearsal.js deposit2 [a0]       # a SECOND, non-treasury deposit, then withdraw
 *   node 10-chopsticks-rehearsal.js rebalance           # keeper -> RebalanceProxy -> Admin -> vault
 *
 * ---------------------------------------------------------------------------
 * Why rehearse at all
 * ---------------------------------------------------------------------------
 * The Gamma stack is not upgradeable and the launch's failure modes are quiet:
 * a partial handover looks like a working vault, and a bad `customDepositDelta`
 * passes the first deposit and fails every one after. Both are invisible to a
 * smoke test that deposits once.
 *
 * ---------------------------------------------------------------------------
 * How a governance origin is obtained on the fork
 * ---------------------------------------------------------------------------
 * Hydration has no sudo. The call is injected straight into `Scheduler::Agenda`
 * for the next block with the origin it should carry, via `dev_setStorage`. That
 * runs it through the SAME runtime dispatch path a referendum would — including
 * dispatcher -> evm.call, which is where money-market ref 322 silently died.
 *
 * Fixture calls that only exist to set the fork up (gas, balances, the contract
 * deployer whitelist) go on `{ system: Root }`, because on mainnet they are not
 * calls at all. The seed goes on `{ Origins: Treasurer }` — the same origin
 * 01-governance-calldata.js names — so the fork proves the NARROW origin
 * satisfies the dispatcher, which a Root dispatch would not.
 *
 * What this does NOT rehearse: the referendum machinery itself (deposits,
 * tracks, conviction). 01-governance-calldata.js validates the encoding against
 * live mainnet metadata separately.
 */

const { ethers } = require("ethers");
const { ApiPromise, WsProvider } = require("@polkadot/api");
const { blake2AsHex } = require("@polkadot/util-crypto");
const { u8aToHex } = require("@polkadot/util");
const {
  env,
  requireEnv,
  centeredBand,
  limitRange,
  fmtUnits,
  gasOverrides,
  waitForSuccess,
  loadDeployments,
  ABI,
} = require("./lib");
const { seedCall, TREASURY_EVM } = require("./01-governance-calldata");

// "ETH\0" ++ evm address ++ 8 zero bytes = the AccountId32 the runtime maps an
// UNBOUND EVM address to. A bound key resolves through bound_account_id instead,
// and funding this account would then do nothing at all.
const truncatedAccountId = (evm) =>
  "0x45544800" + evm.toLowerCase().replace(/^0x/, "").padStart(40, "0") + "0000000000000000";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assertLocalFork(wsUrl) {
  if (!/(^|\/\/)(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(wsUrl)) {
    throw new Error(
      `REFUSING TO RUN: WS_URL is ${wsUrl}. This script injects Root calls and is for a local ` +
        `chopsticks fork ONLY. Set WS_URL=ws://localhost:<port>.`
    );
  }
}

async function setBuildMode(api, mode) {
  await api.rpc("dev_setBlockBuildMode", mode);
}

/**
 * The two origins this script injects. TREASURER is the origin the real seed
 * referendum carries (`Origins::Treasurer`, track 5); ROOT is only used for
 * fixture setup that has no mainnet counterpart.
 */
const ROOT = { system: "Root" };
const TREASURER = { Origins: "Treasurer" };

/**
 * Schedule `call` with `origin` for the next block, build that block, and
 * report every failure marker in it.
 *
 * `evm.ExecutedFailed` is checked explicitly because the dispatcher returns
 * {Ok} over a reverted inner EVM call.
 */
async function dispatchAs(api, call, origin, label) {
  // Drive blocks explicitly. In Instant mode a stray pending extrinsic can seal
  // a block between reading the head and writing the agenda, which would file
  // the entry one block in the past — where it is never serviced.
  await setBuildMode(api, "Manual");
  const at = (await api.rpc.chain.getHeader()).number.toNumber() + 1;
  const encoded = call.method.toHex();
  const len = (encoded.length - 2) / 2;
  const hash = blake2AsHex(encoded);
  console.log(`\n--- ${label} ---`);
  console.log(`  scheduling as ${JSON.stringify(origin)} at block ${at} (${len} bytes, preimage ${hash})`);

  // Note the preimage first and schedule a Lookup-bounded call.
  //
  // The obvious `{ Inline: <encoded> }` shorthand only works below 128 bytes —
  // `BoundedInline` is a BoundedVec<u8, ConstU32<128>> — and every call worth
  // rehearsing here is larger, because an `evm.call` alone carries two
  // addresses, a U256 value and the calldata. Over the limit the agenda entry
  // is written and silently skipped: the block builds, NO failure marker is
  // emitted, and the call simply never ran. A referendum bounds its call the
  // same way, so Lookup is also the more faithful path.
  //
  // The raw key/value form of dev_setStorage is used deliberately: the JSON
  // form encodes `Bytes` without its length prefix and produces an entry that
  // fails to decode.
  await api.rpc("dev_setStorage", [
    [api.query.preimage.preimageFor.key([hash, len]), u8aToHex(api.createType("Bytes", encoded).toU8a())],
  ]);
  const entry = {
    maybeId: null,
    priority: 0,
    call: { Lookup: { hash, len } },
    maybePeriodic: null,
    origin,
  };
  await api.rpc("dev_setStorage", { Scheduler: { Agenda: [[[at], [entry]]] } });
  await api.rpc("dev_newBlock", {});
  await sleep(500);

  // Prove the agenda actually fired, rather than trusting the absence of
  // failure markers — a skipped entry produces neither.

  const blockHash = await api.rpc.chain.getBlockHash(at);
  const events = await (await api.at(blockHash)).query.system.events();
  let failed = 0;
  let executed = 0;
  let dispatched = false;
  for (const { event } of events) {
    const key = `${event.section}.${event.method}`;
    if (key === "scheduler.CallUnavailable") {
      failed++;
      console.log(`  ✗ scheduler.CallUnavailable — the preimage was not found for the scheduled call`);
    } else if (key === "evm.ExecutedFailed") {
      failed++;
      console.log(`  ✗ evm.ExecutedFailed ${JSON.stringify(event.data.toHuman())}`);
    } else if (key === "system.ExtrinsicFailed" || key === "utility.BatchInterrupted") {
      failed++;
      console.log(`  ✗ ${key} ${JSON.stringify(event.data.toHuman())}`);
    } else if (key === "scheduler.Dispatched") {
      dispatched = true;
      const res = event.data.toJSON()[2];
      if (res && res.err) {
        failed++;
        console.log(`  ✗ scheduler.Dispatched err: ${JSON.stringify(res.err)}`);
      } else {
        console.log("  ✓ scheduler.Dispatched Ok");
      }
    } else if (key === "evm.Executed") {
      executed++;
    }
  }
  if (!dispatched) {
    console.log(`  ✗ no scheduler.Dispatched in block ${at} — the agenda entry was skipped, not executed`);
    failed += 1;
  }
  console.log(`  ${executed} evm.Executed`);
  failed === 0 ? console.log(`  ✓ no failure markers in block ${at}`) : console.log(`  ✗ ${failed} failure marker(s)`);
  return failed === 0;
}

/**
 * Send an EVM transaction, retrying past a chopsticks RLP-decoding bug.
 *
 * RLP encodes a signature's `r`/`s` minimally, so roughly one signature in 256
 * has a leading zero byte and serialises to 31. chopsticks then decodes it as
 * `H256` and rejects the whole transaction with "Expected input with 32 bytes
 * (256 bits), found 31 bytes". A real Frontier node decodes it correctly — this
 * is a fork-harness defect, not a launch problem, and the fix is simply to sign
 * something slightly different. Nudging the gas price by a wei does that.
 */
async function sendEvm(provider, build, label, confirmations) {
  const base = await gasOverrides(provider);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const tx = await build({ ...base, gasPrice: base.gasPrice + BigInt(attempt) });
      return await waitForSuccess(tx, confirmations, label);
    } catch (error) {
      const message = String(error?.error?.message ?? error?.message ?? error);
      if (!/found 31 bytes|found 30 bytes/.test(message)) throw error;
      console.log(`  ! ${label}: chopsticks rejected a short-RLP signature, re-signing (attempt ${attempt + 2})`);
    }
  }
  throw new Error(`${label}: chopsticks kept rejecting the signature encoding`);
}

/** A treasury-sourced ERC-20 transfer, as a Root-dispatchable call. */
async function treasuryTransfer(api, provider, token, to, amount) {
  const gas = await gasOverrides(provider, { gasLimit: BigInt(env("ERC20_TRANSFER_GAS", "2000000")) });
  const data = new ethers.Interface(ABI.erc20).encodeFunctionData("transfer", [to, amount]);
  return api.tx.dispatcher.dispatchAsTreasury(
    api.tx.evm.call(TREASURY_EVM, token, data, 0, gas.gasLimit, gas.gasPrice, null, null, [], [])
  );
}

// ---------------------------------------------------------------------------

async function cmdGovern(api, provider) {
  const deployer = new ethers.Wallet(requireEnv("DEPLOYER_PK")).address;
  const addresses = [...new Set(
    [deployer, env("KEEPER_ADDRESS"), env("REHEARSAL_EOA")]
      .filter((a) => a && ethers.isAddress(a))
      .map((a) => ethers.getAddress(a))
  )];
  const gasId = Number(env("GAS_ASSET_ID", "20"));
  const amount = BigInt(env("FUND_GAS", "10000000000000000000")); // 10 WETH

  // Gas is written straight into storage rather than minted with
  // `currencies.updateBalance` under Root.
  //
  // Minting WETH to an account trips pallet-circuit-breaker's deposit lockdown:
  // the balance arrives and is immediately RESERVED (measured on a mainnet fork
  // — `circuitBreaker.AssetLockdown` for asset 20, then `tokens.Reserved` for
  // the whole deposit), so the key ends up with a visible balance it cannot
  // spend and every transaction then fails for want of gas.
  //
  // This is fixture setup, not part of what is being rehearsed: on mainnet the
  // deployer is funded by an ordinary transfer from a human. Everything the
  // launch actually depends on still goes through the real dispatch path below.
  const writes = [];
  for (const address of addresses) {
    const who = truncatedAccountId(address);
    const existing = await api.query.system.account(who);
    writes.push([
      api.query.tokens.accounts.key(who, gasId),
      u8aToHex(api.createType("OrmlTokensAccountData", { free: amount, reserved: 0, frozen: 0 }).toU8a()),
    ]);
    // A provider, so the account is not reaped and can carry an EVM nonce.
    writes.push([
      api.query.system.account.key(who),
      u8aToHex(
        api.createType("FrameSystemAccountInfo", {
          nonce: existing.nonce,
          consumers: existing.consumers,
          providers: existing.providers.toNumber() > 0 ? existing.providers : 1,
          sufficients: existing.sufficients,
          data: existing.data,
        }).toU8a()
      ),
    ]);
    console.log(`  + ${amount} of asset ${gasId} -> ${address}`);
  }
  await api.rpc("dev_setStorage", writes);

  // Contract creation IS a runtime concern, so it goes through Root exactly as
  // a referendum would. It gates the RPC simulation route rather than a signed
  // CREATE, but the fork should mirror mainnet on the day.
  let ok = true;
  if (api.query.evmAccounts?.contractDeployer && (await api.query.evmAccounts.contractDeployer(deployer)).isNone) {
    ok = await dispatchAs(api, api.tx.evmAccounts.addContractDeployer(deployer), ROOT, `whitelist ${deployer} as a contract deployer`);
  } else {
    console.log(`  = ${deployer} is already a contract deployer`);
  }

  for (const address of addresses) {
    const balance = await provider.getBalance(address);
    console.log(`  post-state: ${address} spendable gas = ${ethers.formatEther(balance)} WETH`);
    if (balance === 0n) ok = false;
  }
  return ok;
}

/**
 * Give the pool enough apparent history that `observe(twapInterval)` stops
 * reverting, which is what ClearingV2 calls on EVERY deposit.
 *
 * This backdates the pool's first oracle observation instead of moving the
 * chain's clock. `dev_timeTravel` looks like the obvious tool and does make
 * `observe` succeed — but it also breaks Cumulus's inherents, and every block
 * built afterwards fails with `Failed to apply inherents`. Exactly one block
 * survives the jump, which is enough to be fooled by and not enough to rehearse
 * with. Measured on a mainnet fork, 2026-09-03.
 *
 * `observations[0]` is the pool's only written slot until something trades, and
 * `Oracle.observeSingle` extrapolates forward from it whenever the requested
 * target is at or after its timestamp. Move that timestamp into the past and the
 * revert goes away, with the TWAP equal to spot — which is the honest answer for
 * a pool that has not traded.
 *
 * This is a fixture. On mainnet the equivalent is waiting for real trading.
 */
async function cmdWarmTwap(api, provider, args) {
  let poolAddress = env("V3_POOL");
  let window = Number(env("TWAP_INTERVAL", "3600"));
  try {
    const d = loadDeployments(env("NET", "chopsticks"));
    poolAddress = d.uniswap.pool;
    window = Number(d.config.twapInterval);
  } catch {
    /* no Gamma deployment record yet */
  }
  if (!ethers.isAddress(poolAddress || "")) throw new Error("set V3_POOL (or deploy Gamma first)");
  const pool = new ethers.Contract(poolAddress, ABI.pool, provider);
  const backdate = Number(args[0] ?? window + 600);

  // `observe` not reverting is NOT the same as the TWAP being usable. A
  // half-applied backdate answers the call and reports an average tick far from
  // spot, and ClearingV2 then rejects every deposit with "Price change
  // Overflow" — a failure that looks nothing like a TWAP problem. Judge on the
  // tick the oracle actually returns.
  const twapTick = async () => {
    const o = await pool.observe([window, 0]);
    return Number((o.tickCumulatives[1] - o.tickCumulatives[0]) / BigInt(window));
  };
  const spotTick = Number((await pool.slot0()).tick);
  const before = await twapTick().catch(() => undefined);
  const tolerance = Number(env("TWAP_TICK_TOLERANCE", "60"));
  if (before === undefined) {
    console.log(`  observe(${window}) before: reverts`);
  } else {
    console.log(`  observe(${window}) before: OK, TWAP tick ${before} vs spot ${spotTick}`);
    if (Math.abs(before - spotTick) <= tolerance) {
      console.log("  nothing to do");
      return true;
    }
    console.log(`  ! TWAP is ${Math.abs(before - spotTick)} ticks off spot — rewriting the anchor`);
  }

  // UniswapV3Pool storage layout: slot0(0) feeGrowthGlobal0X128(1)
  // feeGrowthGlobal1X128(2) protocolFees(3) liquidity(4) ticks(5) tickBitmap(6)
  // positions(7) observations(8). Observation packs into one word with
  // blockTimestamp in the low 32 bits.
  //
  // Read it through `EVM::AccountStorages`, not `eth_getStorageAt`: chopsticks'
  // Ethereum read returned 0x0 for this slot while the substrate map returned
  // the real word, so the eth path would silently look like an uninitialized
  // pool. Writing goes to the same map, which keeps read and write symmetric.
  const SLOT = ethers.toBeHex(8, 32);
  const word = BigInt((await api.query.evm.accountStorages(poolAddress, SLOT)).toHex());
  if (((word >> 248n) & 1n) !== 1n) throw new Error(`pool ${poolAddress} has no written observation — is it initialized?`);

  const slot0 = await pool.slot0();
  const oldest = await pool.observations(0);
  const now = Math.floor(Number(await api.query.timestamp.now()) / 1000);
  const blockTimestamp = BigInt(now - backdate);
  if (blockTimestamp <= 0n) throw new Error(`backdating by ${backdate}s would take the timestamp below zero`);

  // Move `tickCumulative` with the timestamp.
  //
  // Backdating the timestamp alone is only correct while slot 0 is the ONLY
  // written observation — then `observeSingle` extrapolates forward at the
  // current tick and the TWAP equals spot. As soon as something trades or mints,
  // a second observation exists and the oracle INTERPOLATES between the two: it
  // divides the accumulated tick by the widened gap, so a 200-second
  // accumulation spread over 4,200 seconds reports an average tick ~20x too
  // small. ClearingV2 then reverts every deposit with "Price change Overflow".
  //
  // Back-solve the accumulator so the implied average over the gap is exactly
  // the current tick, which is the honest answer for a pool that has not traded.
  let tickCumulative = oldest.tickCumulative;
  const newestIndex = Number(slot0.observationIndex);
  if (newestIndex !== 0) {
    const newest = await pool.observations(newestIndex);
    tickCumulative = newest.tickCumulative - BigInt(slot0.tick) * (BigInt(newest.blockTimestamp) - blockTimestamp);
    console.log(`  interpolating against observation[${newestIndex}] — tickCumulative ${oldest.tickCumulative} -> ${tickCumulative}`);
  }

  // Observation packs into one word: blockTimestamp uint32 | tickCumulative
  // int56 | secondsPerLiquidityCumulativeX128 uint160 | initialized bool.
  const updated =
    (1n << 248n) |
    ((BigInt(oldest.secondsPerLiquidityCumulativeX128) & ((1n << 160n) - 1n)) << 88n) |
    (BigInt.asUintN(56, tickCumulative) << 32n) |
    (blockTimestamp & 0xffffffffn);

  console.log(`  observations[0].blockTimestamp ${oldest.blockTimestamp} -> ${blockTimestamp} (chain now ${now}, backdated ${backdate}s)`);
  await api.rpc("dev_setStorage", [
    [api.query.evm.accountStorages.key(poolAddress, SLOT), ethers.toBeHex(updated, 32)],
  ]);

  try {
    const after = await twapTick();
    const drift = Math.abs(after - spotTick);
    if (drift > tolerance) {
      console.log(`  ✗ TWAP tick ${after} is still ${drift} ticks from spot ${spotTick}`);
      return false;
    }
    console.log(`  ✓ observe(${window}) succeeds, TWAP tick ${after} vs spot ${spotTick} — the deposit guard can run`);
    return true;
  } catch (error) {
    console.log(`  ✗ observe(${window}) still reverts: ${(error.shortMessage || error.message).slice(0, 90)}`);
    return false;
  }
}


async function cmdFund(api, provider, args) {
  const d = loadDeployments(env("NET", "chopsticks"));
  const to = args[0];
  if (!ethers.isAddress(to || "")) throw new Error("usage: fund <evm-address> [amount0 amount1]");
  // Defaults are rehearsal-sized on purpose. The mainnet treasury's aDOT
  // balance is small (359 aDOT on 2026-09-03), so anything bigger fails here
  // for the same reason the real seed would — which is worth seeing, but not
  // worth hitting by accident on every run.
  const amount0 = BigInt(args[1] ?? env("FUND_A", "500000000000")); // 50 aDOT at 10dp
  const amount1 = BigInt(args[2] ?? env("FUND_B", "100000000000000000000")); // 100 HOLLAR at 18dp

  const calls = await Promise.all([
    treasuryTransfer(api, provider, d.uniswap.token0, to, amount0),
    treasuryTransfer(api, provider, d.uniswap.token1, to, amount1),
  ]);
  const ok = await dispatchAs(api, api.tx.utility.batchAll(calls), ROOT, `treasury funds ${to}`);

  let allOk = ok;
  for (const [label, token] of [["token0", d.uniswap.token0], ["token1", d.uniswap.token1]]) {
    const erc20 = new ethers.Contract(token, ABI.erc20, provider);
    const [balance, decimals, symbol] = await Promise.all([erc20.balanceOf(to), erc20.decimals(), erc20.symbol()]);
    console.log(`  post-state: ${label} ${symbol} = ${fmtUnits(balance, decimals)}`);
    if (balance === 0n) allOk = false;
  }
  return allOk;
}

async function cmdSeed(api, provider) {
  const d = loadDeployments(env("NET", "chopsticks"));
  const g = d.gamma;
  const vault = new ethers.Contract(g.hypervisor, ABI.hypervisor, provider);
  const to = env("SEED_TO", TREASURY_EVM);
  const before = await vault.balanceOf(to);

  // Built by the SAME function 01 prints for the referendum.
  const { call } = await seedCall(api, provider, d);
  const ok = await dispatchAs(api, call, TREASURER, "treasury seed (01's exact encoding, on track 5)");

  const [after, supply, totals] = await Promise.all([vault.balanceOf(to), vault.totalSupply(), vault.getTotalAmounts()]);
  console.log(`  post-state: ${to} shares ${fmtUnits(before, 18)} -> ${fmtUnits(after, 18)}`);
  console.log(`  post-state: totalSupply ${fmtUnits(supply, 18)}, vault holds ${totals.total0} / ${totals.total1}`);
  return ok && after > before;
}

/**
 * The check a one-shot smoke test cannot make.
 *
 * The first deposit into an empty vault takes ClearingV2's `totalSupply() == 0`
 * branch and never calls `applyRatio`. Every deposit after it does — and
 * `applyRatio` divides by `customDepositDelta`, so a zero there passes the seed
 * and reverts everything afterwards. This deposits second, then withdraws.
 */
async function cmdDeposit2(api, provider, args) {
  const d = loadDeployments(env("NET", "chopsticks"));
  const g = d.gamma;
  const wallet = new ethers.Wallet(env("REHEARSAL_PK", requireEnv("DEPLOYER_PK")), provider);
  const confirmations = Number(env("CONFIRMATIONS", "1"));
  await setBuildMode(api, "Instant");

  const clearing = new ethers.Contract(g.clearing, ABI.clearing, provider);
  const uniProxy = new ethers.Contract(g.uniProxy, ABI.uniProxy, wallet);
  const vault = new ethers.Contract(g.hypervisor, ABI.hypervisor, wallet);
  const token0 = new ethers.Contract(d.uniswap.token0, ABI.erc20, wallet);
  const token1 = new ethers.Contract(d.uniswap.token1, ABI.erc20, wallet);
  const [dec0, dec1, sym0, sym1] = await Promise.all([token0.decimals(), token1.decimals(), token0.symbol(), token1.symbol()]);

  if ((await vault.totalSupply()) === 0n) throw new Error("vault is empty — run `seed` first, or this is not a SECOND deposit");

  const amount0 = BigInt(args[0] ?? env("DEPOSIT2_AMOUNT0", (10n ** BigInt(dec0)).toString()));
  // The ratio band is what applyRatio computes; take its midpoint so the deposit
  // is inside it by construction. Reading it at all is the point: this call is
  // what a zero customDepositDelta makes revert.
  const [start, end] = await clearing.getDepositAmount(g.hypervisor, d.uniswap.token0, amount0);
  console.log(`  ratio band for ${fmtUnits(amount0, dec0)} ${sym0}: [${fmtUnits(start, dec1)}, ${fmtUnits(end, dec1)}] ${sym1}`);
  const amount1 = (start + end) / 2n;
  if (amount1 === 0n) throw new Error("computed a zero pair amount — the vault holds only one side");

  const [bal0, bal1] = await Promise.all([token0.balanceOf(wallet.address), token1.balanceOf(wallet.address)]);
  if (bal0 < amount0 || bal1 < amount1) {
    throw new Error(
      `depositor ${wallet.address} holds ${fmtUnits(bal0, dec0)} ${sym0} / ${fmtUnits(bal1, dec1)} ${sym1}, ` +
        `needs ${fmtUnits(amount0, dec0)} / ${fmtUnits(amount1, dec1)} — run \`fund ${wallet.address}\` first`
    );
  }

  // The allowance goes to the HYPERVISOR, not UniProxy: UniProxy forwards
  // `from = msg.sender` and the Hypervisor is what calls transferFrom.
  await sendEvm(provider, (o) => token0.approve(g.hypervisor, amount0, o), `approve ${sym0}`, confirmations);
  await sendEvm(provider, (o) => token1.approve(g.hypervisor, amount1, o), `approve ${sym1}`, confirmations);

  const sharesBefore = await vault.balanceOf(wallet.address);
  await sendEvm(
    provider,
    (o) => uniProxy.deposit(amount0, amount1, wallet.address, g.hypervisor, [0, 0, 0, 0], o),
    "uniProxy.deposit (SECOND deposit — exercises applyRatio)",
    confirmations
  );
  const shares = (await vault.balanceOf(wallet.address)) - sharesBefore;
  console.log(`  minted ${fmtUnits(shares, 18)} shares`);
  if (shares === 0n) return false;

  // In-kind redemption is the anchor of the whole product: no price involved.
  const out0Before = await token0.balanceOf(wallet.address);
  const out1Before = await token1.balanceOf(wallet.address);
  await sendEvm(
    provider,
    (o) => vault.withdraw(shares, wallet.address, wallet.address, [0, 0, 0, 0], o),
    "hypervisor.withdraw (redeem the same shares)",
    confirmations
  );
  const out0 = (await token0.balanceOf(wallet.address)) - out0Before;
  const out1 = (await token1.balanceOf(wallet.address)) - out1Before;
  console.log(`  redeemed ${fmtUnits(out0, dec0)} ${sym0} + ${fmtUnits(out1, dec1)} ${sym1}`);
  return out0 > 0n || out1 > 0n;
}

/**
 * Prove the post-handover rebalance path end to end:
 * keeper key -> RebalanceProxy (caps) -> Admin (roles) -> Hypervisor (owner).
 *
 * If any link is mis-wired the vault is unrebalanceable forever, and nothing
 * about a freshly deployed, freshly seeded vault looks wrong until the day the
 * band needs to move.
 */
async function cmdRebalance(api, provider) {
  const d = loadDeployments(env("NET", "chopsticks"));
  const g = d.gamma;
  const keeper = new ethers.Wallet(env("KEEPER_PK", requireEnv("DEPLOYER_PK")), provider);
  const confirmations = Number(env("CONFIRMATIONS", "1"));
  await setBuildMode(api, "Instant");

  const proxy = new ethers.Contract(g.rebalanceProxy, ABI.rebalanceProxy, keeper);
  const vault = new ethers.Contract(g.hypervisor, ABI.hypervisor, provider);
  const pool = new ethers.Contract(d.uniswap.pool, ABI.pool, provider);

  const registered = await proxy.rebalancers(g.hypervisor);
  if (String(registered).toLowerCase() !== keeper.address.toLowerCase()) {
    throw new Error(`proxy.rebalancers[vault] is ${registered}, not the signer ${keeper.address} — set KEEPER_PK`);
  }
  const [spacing, slot0, before0, before1, feeRecipient] = await Promise.all([
    vault.tickSpacing(),
    pool.slot0(),
    vault.baseLower(),
    vault.baseUpper(),
    vault.feeRecipient(),
  ]);
  const mult = Number(env("BASE_HALF_WIDTH_MULT", String(d.config.baseHalfWidthMult)));
  const [lower, upper] = centeredBand(Number(slot0.tick), mult, Number(spacing));
  const [limitLower, limitUpper] = limitRange(Number(slot0.tick), Number(spacing), env("LIMIT_SIDE", "above"), Number(env("LIMIT_WIDTH_MULT", "1")));
  console.log(`  band [${before0}, ${before1}] -> [${lower}, ${upper}] at tick ${slot0.tick}`);

  await sendEvm(
    provider,
    (o) =>
      proxy.rebalance(
        g.hypervisor,
        lower,
        upper,
        limitLower,
        limitUpper,
        env("FEE_RECIPIENT", feeRecipient),
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        o
      ),
    "proxy.rebalance -> admin -> hypervisor",
    confirmations
  );
  const [after0, after1] = await Promise.all([vault.baseLower(), vault.baseUpper()]);
  console.log(`  post-state: base [${after0}, ${after1}]`);
  return Number(after0) === lower && Number(after1) === upper;
}

// ---------------------------------------------------------------------------

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const commands = {
    govern: cmdGovern,
    "warm-twap": cmdWarmTwap,
    seed: cmdSeed,
    fund: cmdFund,
    deposit2: cmdDeposit2,
    rebalance: cmdRebalance,
  };
  if (!command || !commands[command]) {
    throw new Error(`usage: node 10-chopsticks-rehearsal.js <${Object.keys(commands).join("|")}> [arguments]`);
  }

  const wsUrl = env("WS_URL", "ws://localhost:8001");
  assertLocalFork(wsUrl);
  const api = await ApiPromise.create({ provider: new WsProvider(wsUrl), noInitWarn: true });
  const provider = new ethers.JsonRpcProvider(env("EVM_RPC_URL", "http://localhost:8001"));
  let ok = false;
  try {
    const rt = api.runtimeVersion;
    console.log(`fork: ${rt.specName} spec ${rt.specVersion}, head #${(await api.rpc.chain.getHeader()).number}`);
    ok = await commands[command](api, provider, args);
  } finally {
    // Root steps drive blocks by hand and leave the fork in Manual mode. Leaving
    // it there makes the NEXT plain EVM transaction sit in the pool forever with
    // no block to land in, which looks exactly like a hung script. Always hand
    // the fork back in Instant.
    await setBuildMode(api, "Instant").catch(() => {});
    await api.disconnect();
  }

  console.log("");
  if (!ok) {
    console.log("=== REHEARSAL STEP FAILED ===");
    process.exit(1);
  }
  console.log("=== step OK ===");
}

main().catch((e) => {
  console.error("\n  rehearsal FAILED:", e.message, "\n");
  process.exit(1);
});
