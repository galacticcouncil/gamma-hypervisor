/**
 * Build governance proposals for the Gamma vault without submitting them.
 *
 *   node 01-governance-calldata.js seed                 # treasury approves + deposits the launch seed
 *   node 01-governance-calldata.js caps [d0 d1 supply]  # raise/lower the ClearingV2 caps
 *   node 01-governance-calldata.js fee <divisor>        # Admin.setFee on the vault
 *   node 01-governance-calldata.js pause <true|false>   # ClearingV2.pause — stops deposits, not withdrawals
 *   node 01-governance-calldata.js recenter             # emergency re-centre, bypassing the keeper
 *   node 01-governance-calldata.js pull [shares]        # extreme-regime liquidity pull
 *
 * Everything is printed, nothing is submitted.
 *
 * Two dispatch identities are in play and they are not interchangeable:
 *
 *   0xaa7e…aa7e0  dispatcher.dispatchAsAaveManager  (Root | EconomicParameters)
 *                 owns Admin, ClearingV2, UniProxy, RebalanceProxy, HypervisorFactory
 *   0x6d6f646c…   dispatcher.dispatchAsTreasury     (Root | Treasurer)
 *                 holds the assets, so it is the only identity that can seed
 *
 * ---------------------------------------------------------------------------
 * Each call is submitted on the NARROWEST track that satisfies its origin
 * ---------------------------------------------------------------------------
 * Both dispatcher origins are `EitherOf<EnsureRoot<_>, <narrower>>`, so Root
 * would also dispatch every one of these — but nothing here needs it, so
 * nothing here asks for it:
 *
 *   seed, pull        → track 5, treasurer            (dispatchAsTreasury)
 *   caps, fee, pause,
 *   recenter          → track 9, economic_parameters  (dispatchAsAaveManager)
 *
 * What Root would have cost, measured against
 * runtime/hydradx/src/governance/tracks.rs: prepare (1h), decision (7d),
 * confirm (12h) and min_approval (APP_RECIP) are IDENTICAL across tracks 0, 5
 * and 9 — so Root is not slower. It is dearer and needs more turnout: a
 * 1,000,000 HDX decision deposit rather than 750,000, and min_support
 * SUP_LINEAR (rising to 36%) rather than SUP_FAST_LINEAR (18%). No reason to
 * pay that for a vault seed.
 *
 * `GOVERNANCE_TRACK=root` escalates the whole set onto track 0 if the team
 * would rather run one referendum than two; an explicit track name pins one.
 *
 * `dispatcher` returns {Ok} even when the inner evm.call REVERTED, and
 * `utility.BatchCompleted` fires regardless — that combination bricked
 * money-market referendum 322. Judge an enactment by 04-verify.js and by the
 * event scan, never by the extrinsic result.
 */

const { ethers } = require("ethers");
const { ApiPromise, WsProvider } = require("@polkadot/api");
const { blake2AsHex } = require("@polkadot/util-crypto");
const {
  env,
  isMainnet,
  centeredBand,
  limitRange,
  firstDepositShares,
  fmtUnits,
  gasOverrides,
  loadDeployments,
  ABI,
} = require("./lib");

const TRACK = {
  root: { id: 0, name: "root", origin: { system: "Root" } },
  treasurer: { id: 5, name: "treasurer", origin: { Origins: "Treasurer" } },
  economicParameters: { id: 9, name: "economic_parameters", origin: { Origins: "EconomicParameters" } },
};

/**
 * Where to actually submit. Default is the narrowest origin the call needs;
 * `GOVERNANCE_TRACK=root` escalates everything onto track 0, and an explicit
 * track name pins one.
 */
function submissionTrack(minimum) {
  const choice = env("GOVERNANCE_TRACK", "minimum");
  if (choice === "minimum") return minimum;
  const track = Object.values(TRACK).find((t) => t.name === choice || String(t.id) === choice);
  if (!track) throw new Error(`GOVERNANCE_TRACK must be root, minimum, or a known track name/id — got ${choice}`);
  if (track.id !== TRACK.root.id && track.id !== minimum.id) {
    throw new Error(`track ${track.name} does not satisfy this call's origin; it needs ${minimum.name} or root`);
  }
  return track;
}

const AAVE_MANAGER_EVM = "0xaa7e0000000000000000000000000000000aa7e0";
// PalletId("py/trsry").into_account_truncating(), first 20 bytes — the EVM
// identity `dispatch_as_treasury` acts as under EnsureAddressTruncated.
const TREASURY_EVM = "0x6d6f646c70792f74727372790000000000000000";

function printProposal(title, call, minimum, notes = []) {
  const track = submissionTrack(minimum);
  const encoded = call.method.toHex();
  console.log(`\n=== ${title} ===`);
  console.log(`  call:          ${call.method.section}.${call.method.method}`);
  console.log(`  encoded:       ${encoded}`);
  console.log(`  preimage hash: ${blake2AsHex(encoded)}`);
  console.log(`  length:        ${(encoded.length - 2) / 2}`);
  console.log(`  track:         ${track.id} (${track.name})`);
  console.log(`  origin:        ${JSON.stringify(track.origin)}`);
  if (track.id !== minimum.id) {
    console.log(`  minimum:       ${minimum.name} (track ${minimum.id}) is all this call needs — escalated to ${track.name} by GOVERNANCE_TRACK`);
  }
  for (const n of notes) console.log(`  note:          ${n}`);
  console.log("  submit:        note this preimage, submit it on the track above, and place its decision deposit.");
}

/** An `evm.call` from one of the dispatch identities, with an explicit gas budget. */
async function evmCall(api, provider, source, target, data, gasLimit) {
  const gas = await gasOverrides(provider, { gasLimit: BigInt(gasLimit) });
  return api.tx.evm.call(source, target, data, 0, gas.gasLimit, gas.gasPrice, null, null, [], []);
}

async function assertAaveManagerUnchanged(api) {
  const onChain = await api.query.dispatcher.aaveManagerAccount();
  const evm = "0x" + Buffer.from(onChain.toU8a().slice(0, 20)).toString("hex");
  if (evm.toLowerCase() !== AAVE_MANAGER_EVM) {
    throw new Error(`dispatcher Aave-manager account now truncates to ${evm}; refusing to encode against a stale identity`);
  }
}

/**
 * The treasury seed: two approvals and one UniProxy deposit, as one batch.
 *
 * The approval target is the HYPERVISOR, not UniProxy. `UniProxy.deposit` calls
 * `Hypervisor.deposit(..., from = msg.sender)` and the Hypervisor then does
 * `safeTransferFrom(from, address(this))` — so the allowance the runtime needs
 * is treasury -> Hypervisor. Approving UniProxy instead compiles, submits,
 * enacts, and reverts.
 */
async function seedCall(api, provider, d) {
  const g = d.gamma;
  const seed0 = BigInt(env("SEED0", "0"));
  const seed1 = BigInt(env("SEED1", "0"));
  const to = env("SEED_TO", TREASURY_EVM);
  if (seed0 <= 0n || seed1 <= 0n) {
    throw new Error("SEED0 and SEED1 must both be > 0 — clearDeposit requires a deposit on both sides");
  }
  if (!ethers.isAddress(to)) throw new Error(`SEED_TO is not an address: ${to}`);

  const token0 = new ethers.Contract(d.uniswap.token0, ABI.erc20, provider);
  const token1 = new ethers.Contract(d.uniswap.token1, ABI.erc20, provider);
  const [dec0, dec1, sym0, sym1, bal0, bal1] = await Promise.all([
    token0.decimals(),
    token1.decimals(),
    token0.symbol(),
    token1.symbol(),
    token0.balanceOf(TREASURY_EVM),
    token1.balanceOf(TREASURY_EVM),
  ]);
  console.log(`  treasury holds ${fmtUnits(bal0, dec0)} ${sym0} / ${fmtUnits(bal1, dec1)} ${sym1}`);
  // The treasury's aDOT balance is the usual shortfall: it is minted by
  // supplying DOT to the Aave market, not held by default.
  if (bal0 < seed0) {
    throw new Error(`treasury holds ${fmtUnits(bal0, dec0)} ${sym0}, seed needs ${fmtUnits(seed0, dec0)}`);
  }
  if (bal1 < seed1) {
    throw new Error(`treasury holds ${fmtUnits(bal1, dec1)} ${sym1}, seed needs ${fmtUnits(seed1, dec1)}`);
  }

  // Prove the deposit clears BEFORE the referendum, not after enactment.
  // clearDeposit is a view, so this is a plain eth_call against live state.
  const clearing = new ethers.Contract(g.clearing, ABI.clearing, provider);
  const vault = new ethers.Contract(g.hypervisor, ABI.hypervisor, provider);
  const [baseLower, baseUpper, tick, whitelisted, supply] = await Promise.all([
    vault.baseLower(),
    vault.baseUpper(),
    vault.currentTick(),
    vault.whitelistedAddress(),
    vault.totalSupply(),
  ]);
  if (String(whitelisted).toLowerCase() !== g.uniProxy.toLowerCase()) {
    throw new Error(`vault whitelist is ${whitelisted}, not UniProxy ${g.uniProxy} — run the handover first`);
  }
  if (!(Number(tick) >= Number(baseLower) && Number(tick) < Number(baseUpper))) {
    throw new Error(
      `tick ${tick} is outside the base range [${baseLower}, ${baseUpper}] — ClearingV2 rejects every deposit ` +
        `while that is true. Let the keeper re-centre the (empty) vault, or use \`recenter\` first.`
    );
  }
  // `minIn` only binds when `directDeposit` is on, which the launch posture
  // forbids: deposits sit in the vault's idle balance until the keeper's next
  // rebalance or compound mints them, and those calls carry their own bounds.
  const minIn = [0, 0, 0, 0];
  try {
    await clearing.clearDeposit(seed0, seed1, TREASURY_EVM, to, g.hypervisor, minIn);
    console.log("  clearDeposit dry-run passes against current state");
  } catch (error) {
    throw new Error(`clearDeposit would revert: ${error.shortMessage || error.message}`);
  }

  if (supply === 0n) {
    const pool = new ethers.Contract(d.uniswap.pool, ABI.pool, provider);
    const slot0 = await pool.slot0();
    const shares = firstDepositShares(BigInt(slot0.sqrtPriceX96), seed0, seed1);
    const cap = (await clearing.positions(g.hypervisor)).maxTotalSupply;
    console.log(`  seed mints ~${fmtUnits(shares, 18)} shares (cap ${cap === 0n ? "none" : fmtUnits(cap, 18)})`);
    if (cap !== 0n && shares > cap) {
      throw new Error(`seed would mint ${shares} shares over maxTotalSupply ${cap} — clearShares reverts the whole call`);
    }
  }

  const approveGas = env("SEED_APPROVE_GAS", "800000");
  // aDOT is an Aave aToken: its transferFrom runs finalizeTransfer and measured
  // 1,232,829 gas on its own. The deposit does two transfers plus a mint, so the
  // budget here is deliberately far above a plain-ERC20 intuition.
  const depositGas = env("SEED_DEPOSIT_GAS", "6000000");
  const erc20 = new ethers.Interface(ABI.erc20);
  const proxyIface = new ethers.Interface(ABI.uniProxy);

  const calls = [
    await evmCall(api, provider, TREASURY_EVM, d.uniswap.token0, erc20.encodeFunctionData("approve", [g.hypervisor, seed0]), approveGas),
    await evmCall(api, provider, TREASURY_EVM, d.uniswap.token1, erc20.encodeFunctionData("approve", [g.hypervisor, seed1]), approveGas),
    await evmCall(
      api,
      provider,
      TREASURY_EVM,
      g.uniProxy,
      proxyIface.encodeFunctionData("deposit", [seed0, seed1, to, g.hypervisor, minIn]),
      depositGas
    ),
  ].map((c) => api.tx.dispatcher.dispatchAsTreasury(c));

  return {
    call: api.tx.utility.batchAll(calls),
    track: TRACK.treasurer,
    notes: [
      `approvals target the Hypervisor ${g.hypervisor}, not UniProxy`,
      `LP shares go to ${to}`,
      "after enactment run: npm run verify && npm run verify -- events <block> <count>",
    ],
  };
}

async function capsCall(api, provider, d, args) {
  await assertAaveManagerUnchanged(api);
  const g = d.gamma;
  const d0 = BigInt(args[0] ?? env("DEPOSIT0_MAX", "0"));
  const d1 = BigInt(args[1] ?? env("DEPOSIT1_MAX", "0"));
  const supply = BigInt(args[2] ?? env("MAX_TOTAL_SUPPLY", "0"));
  const delta = BigInt(env("DEPOSIT_DELTA", "10010"));
  if (d0 > 0n && d1 > 0n && delta === 0n) {
    throw new Error("DEPOSIT_DELTA must be non-zero while depositOverride is on — applyRatio divides by it");
  }
  const iface = new ethers.Interface(ABI.clearing);
  const call = api.tx.dispatcher.dispatchAsAaveManager(
    await evmCall(
      api,
      provider,
      AAVE_MANAGER_EVM,
      g.clearing,
      iface.encodeFunctionData("customDeposit", [g.hypervisor, d0, d1, supply, delta]),
      env("ADMIN_CALL_GAS", "500000")
    )
  );
  return {
    call,
    track: TRACK.economicParameters,
    notes: [`d0=${d0} d1=${d1} maxTotalSupply=${supply} customDepositDelta=${delta}`],
  };
}

async function feeCall(api, provider, d, args) {
  await assertAaveManagerUnchanged(api);
  const divisor = Number(args[0] ?? env("HYPERVISOR_FEE", "255"));
  if (!Number.isInteger(divisor) || divisor < 1 || divisor > 255) {
    throw new Error("fee divisor must be 1..255 — 0 divides by zero and bricks every harvest");
  }
  const iface = new ethers.Interface(ABI.admin);
  const call = api.tx.dispatcher.dispatchAsAaveManager(
    await evmCall(
      api,
      provider,
      AAVE_MANAGER_EVM,
      d.gamma.admin,
      iface.encodeFunctionData("setFee", [d.gamma.hypervisor, divisor]),
      env("ADMIN_CALL_GAS", "500000")
    )
  );
  return { call, track: TRACK.economicParameters, notes: [`divisor ${divisor} = ${(100 / divisor).toFixed(2)}% of harvested swap fees`] };
}

async function pauseCall(api, provider, d, args) {
  await assertAaveManagerUnchanged(api);
  const paused = String(args[0] ?? "true") === "true";
  const iface = new ethers.Interface(ABI.clearing);
  const call = api.tx.dispatcher.dispatchAsAaveManager(
    await evmCall(api, provider, AAVE_MANAGER_EVM, d.gamma.clearing, iface.encodeFunctionData("pause", [paused]), env("ADMIN_CALL_GAS", "500000"))
  );
  return {
    call,
    track: TRACK.economicParameters,
    notes: [`ClearingV2.paused = ${paused}`, "this stops DEPOSITS only; withdrawals bypass ClearingV2 entirely"],
  };
}

/**
 * The three-call pattern for anything the keeper cannot do.
 *
 * `Admin.rebalance` and `Admin.pullLiquidity` are `onlyRebalancer`, and the
 * rebalancer is the RebalanceProxy — which only forwards `rebalance`, under its
 * caps. So governance temporarily takes the rebalancer role, acts, and hands it
 * back. Doing it as one batchAll matters: an interrupted batch that leaves
 * governance as the rebalancer would take the keeper offline.
 */
async function adminAsRebalancer(api, provider, d, innerData, gas) {
  await assertAaveManagerUnchanged(api);
  const g = d.gamma;
  const iface = new ethers.Interface(ABI.admin);
  const wrap = async (data, gasLimit) =>
    api.tx.dispatcher.dispatchAsAaveManager(await evmCall(api, provider, AAVE_MANAGER_EVM, g.admin, data, gasLimit));
  return api.tx.utility.batchAll([
    await wrap(iface.encodeFunctionData("setRebalancer", [g.hypervisor, AAVE_MANAGER_EVM]), env("ADMIN_CALL_GAS", "500000")),
    await wrap(innerData, gas),
    await wrap(iface.encodeFunctionData("setRebalancer", [g.hypervisor, g.rebalanceProxy]), env("ADMIN_CALL_GAS", "500000")),
  ]);
}

async function recenterCall(api, provider, d) {
  const g = d.gamma;
  const vault = new ethers.Contract(g.hypervisor, ABI.hypervisor, provider);
  const pool = new ethers.Contract(d.uniswap.pool, ABI.pool, provider);
  const [spacing, slot0, total, feeRecipientOnChain] = await Promise.all([
    vault.tickSpacing(),
    pool.slot0(),
    vault.getTotalAmounts(),
    vault.feeRecipient(),
  ]);
  const feeRecipient = env("FEE_RECIPIENT", feeRecipientOnChain);
  if (!ethers.isAddress(feeRecipient) || feeRecipient === ethers.ZeroAddress) {
    throw new Error("FEE_RECIPIENT is required — rebalance() reverts on address(0)");
  }
  const mult = Number(env("BASE_HALF_WIDTH_MULT", String(d.config.baseHalfWidthMult)));
  const [lower, upper] = centeredBand(Number(slot0.tick), mult, Number(spacing));
  const [limitLower, limitUpper] = limitRange(Number(slot0.tick), Number(spacing), env("LIMIT_SIDE", "above"), Number(env("LIMIT_WIDTH_MULT", "1")));
  const zeros = [0, 0, 0, 0];
  if (total.total0 !== 0n || total.total1 !== 0n) {
    // Zero mins on a FUNDED vault is a real exposure: the band is re-minted at
    // whatever price the pool quotes at enactment, which is a block nobody picks.
    console.log("  ! vault holds liquidity — this proposal re-mints it with ZERO slippage bounds");
    console.log("    Prefer letting the keeper re-centre. Use this only when the keeper cannot.");
  }
  const iface = new ethers.Interface(ABI.admin);
  const data = iface.encodeFunctionData("rebalance", [g.hypervisor, lower, upper, limitLower, limitUpper, feeRecipient, zeros, zeros]);
  return {
    call: await adminAsRebalancer(api, provider, d, data, env("REBALANCE_GAS", "6000000")),
    track: TRACK.economicParameters,
    notes: [
      `band [${lower}, ${upper}] computed from tick ${slot0.tick} AT ENCODING TIME — it will have moved by enactment`,
      "the batch restores RebalanceProxy as the rebalancer in its third call",
    ],
  };
}

async function pullCall(api, provider, d, args) {
  const g = d.gamma;
  const vault = new ethers.Contract(g.hypervisor, ABI.hypervisor, provider);
  const supply = await vault.totalSupply();
  const shares = BigInt(args[0] ?? supply);
  if (shares === 0n) throw new Error("nothing to pull — the vault has no shares");
  const iface = new ethers.Interface(ABI.admin);
  const data = iface.encodeFunctionData("pullLiquidity", [g.hypervisor, shares, [0, 0, 0, 0]]);
  return {
    call: await adminAsRebalancer(api, provider, d, data, env("REBALANCE_GAS", "6000000")),
    track: TRACK.economicParameters,
    notes: [
      `pulling ${shares} of ${supply} shares' worth of liquidity into the vault's idle balance`,
      "shareholders keep their shares; the pool just loses the vault's depth",
      "zero minAmounts — a pull is an emergency exit, so it must not be blocked by its own bounds",
    ],
  };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const commands = { seed: seedCall, caps: capsCall, fee: feeCall, pause: pauseCall, recenter: recenterCall, pull: pullCall };
  if (!command || !commands[command]) {
    throw new Error(`usage: node 01-governance-calldata.js <${Object.keys(commands).join("|")}> [arguments]`);
  }

  const net = env("NET", "mainnet");
  const d = loadDeployments(net);
  const api = await ApiPromise.create({ provider: new WsProvider(env("WS_URL", d.network.substrateWs)), noInitWarn: true });
  const provider = new ethers.JsonRpcProvider(env("EVM_RPC_URL", d.network.evmRpc));
  try {
    const rt = api.runtimeVersion;
    console.log(`chain: ${rt.specName} spec ${rt.specVersion}`);
    if (isMainnet() && d.config?.posture !== "production") {
      console.log(`  ! deployment record posture is "${d.config?.posture}" — run 03-handover.js before governing this vault`);
    }
    const result = await commands[command](api, provider, d, args);
    printProposal(`gamma ${command}`, result.call, result.track, result.notes);
  } finally {
    await api.disconnect();
  }
}

// The chopsticks rehearsal imports these so it injects the SAME encoding the
// referendum will carry. A rehearsal of a different encoder proves nothing.
module.exports = { seedCall, capsCall, feeCall, pauseCall, recenterCall, pullCall, TRACK, AAVE_MANAGER_EVM, TREASURY_EVM };

if (require.main === module) {
  main().catch((error) => {
    console.error(`\nGovernance calldata failed: ${error.message}\n`);
    process.exit(1);
  });
}
