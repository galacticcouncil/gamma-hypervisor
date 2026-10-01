/**
 * Print the Technical Committee motion that raises the Gamma vault's share cap
 * (ClearingV2.maxTotalSupply), after checking it against the live chain.
 *
 *   ENV_FILE=.env.tc-caps node 12-tc-caps.js <new cap, in shares>
 *
 * Since the handover ClearingV2 is owned by 0xaa7e…aa7e1, which the runtime lets
 * Root or a committee majority act as through dispatcher.dispatchAsEmergencyAdmin.
 * Only maxTotalSupply changes: the per-deposit limits and the ratio band are read
 * from the chain and passed back as they are. Nothing is signed or submitted.
 */

const { ethers } = require("ethers");
const { ApiPromise, WsProvider } = require("@polkadot/api");
const { env, gasOverrides, ABI } = require("./lib");

// EmergencyAdminAccount in hydration-node runtime/hydradx/src/governance/mod.rs,
// and the EVM address it acts as (its first 20 bytes).
const EMERGENCY_ADMIN_ACCOUNT = "0xaa7e0000000000000000000000000000000aa7e1000000000000000000000000";
const EMERGENCY_ADMIN_EVM = "0xaa7e0000000000000000000000000000000aa7e1";

const fmtShares = (x) => Number(ethers.formatUnits(x, 18)).toLocaleString("en-US", { maximumFractionDigits: 2 });

// "250000" or "250000.5" shares -> the 18-decimal units the contract stores.
function parseShares(text) {
  const s = String(text ?? "").trim();
  if (!/^\d+(\.\d{1,18})?$/.test(s)) {
    throw new Error(`the new cap must be a plain number of shares, like 250000 (got "${text ?? ""}")`);
  }
  return ethers.parseUnits(s, 18);
}

// TechCommitteeMajority is EnsureProportionAtLeast<1, 2>: ayes from at least half the members.
function committeeThreshold(memberCount) {
  if (!Number.isInteger(memberCount) || memberCount < 1) {
    throw new Error(`cannot build a motion for a committee of ${memberCount} members`);
  }
  return Math.ceil(memberCount / 2);
}

// Every reason to refuse, decided from the chain readings alone. Null when none applies.
function refusal(chain, newCap) {
  if (chain.owner.toLowerCase() !== EMERGENCY_ADMIN_EVM) {
    return `ClearingV2 is owned by ${chain.owner}, not ${EMERGENCY_ADMIN_EVM}: this motion would enact and change nothing`;
  }
  if (chain.version === 0) return `ClearingV2 does not know vault ${chain.vault}`;
  if (chain.depositOverride && chain.delta === 0n) {
    return "customDepositDelta is 0 on chain: every deposit after the first reverts, fix that first";
  }
  if (newCap === chain.cap) return `the cap is already ${fmtShares(newCap)} shares`;
  if (newCap <= chain.supply) {
    return `a cap of ${fmtShares(newCap)} is at or below the ${fmtShares(chain.supply)} shares that exist, which blocks every deposit (use pause for that)`;
  }
  if (chain.gasBalance < chain.gasNeeded) {
    return `${EMERGENCY_ADMIN_EVM} holds ${ethers.formatEther(chain.gasBalance)} for gas, the call may need ${ethers.formatEther(chain.gasNeeded)}`;
  }
  return null;
}

// What `shares` are worth in token1 (HOLLAR) now, priced the way Hypervisor.deposit
// prices the vault. Before the first deposit a share is minted per unit of token1.
function sharesValue(shares, { supply, total0, total1, sqrtPriceX96 }) {
  if (supply === 0n) return shares;
  const PRECISION = 10n ** 36n;
  const price = (sqrtPriceX96 * sqrtPriceX96 * PRECISION) >> 192n;
  return (shares * ((total0 * price) / PRECISION + total1)) / supply;
}

// Everything the checks, the proposal and the summary need, read at the latest block.
async function readChain(api, provider, addresses, gasLimit) {
  const clearing = new ethers.Contract(addresses.clearing, ABI.clearing, provider);
  const vault = new ethers.Contract(addresses.vault, ABI.hypervisor, provider);
  const [owner, position, supply, totals, poolAddress, members, gas, gasBalance] = await Promise.all([
    clearing.owner(),
    clearing.positions(addresses.vault),
    vault.totalSupply(),
    vault.getTotalAmounts(),
    vault.pool(),
    api.query.technicalCommittee.members(),
    gasOverrides(provider, { gasLimit }),
    provider.getBalance(EMERGENCY_ADMIN_EVM),
  ]);
  const { sqrtPriceX96 } = await new ethers.Contract(poolAddress, ABI.pool, provider).slot0();
  return {
    vault: addresses.vault,
    owner,
    version: Number(position.version),
    depositOverride: position.depositOverride,
    deposit0Max: position.deposit0Max,
    deposit1Max: position.deposit1Max,
    cap: position.maxTotalSupply,
    delta: position.customDepositDelta,
    supply,
    total0: totals.total0,
    total1: totals.total1,
    sqrtPriceX96,
    memberCount: members.length,
    gas,
    gasBalance,
    gasNeeded: gas.gasLimit * gas.gasPrice,
  };
}

// The call the committee votes on: act as ClearingV2's owner and run customDeposit
// with the new cap and every other value exactly as it is on chain.
function buildProposal(api, addresses, chain, newCap) {
  const data = new ethers.Interface(ABI.clearing).encodeFunctionData("customDeposit", [
    addresses.vault,
    chain.deposit0Max,
    chain.deposit1Max,
    newCap,
    chain.delta,
  ]);
  // Same shape as 01-governance-calldata.js's evmCall: no tip, nonce, access or authorization list.
  const evmCall = api.tx.evm.call(EMERGENCY_ADMIN_EVM, addresses.clearing, data, 0, chain.gas.gasLimit, chain.gas.gasPrice, null, null, [], []);
  return { data, proposal: api.tx.dispatcher.dispatchAsEmergencyAdmin(evmCall) };
}

// Run the inner call as a read-only eth_call from the owner's address: it must not revert.
async function dryRun(provider, clearing, data, gasLimit) {
  try {
    await provider.call({ from: EMERGENCY_ADMIN_EVM, to: clearing, data, gasLimit });
  } catch (error) {
    throw new Error(`customDeposit reverts when run as ${EMERGENCY_ADMIN_EVM}: ${error.shortMessage || error.message}`);
  }
}

// The committee motion around the proposal, plus what vote and close will need.
async function buildMotion(api, proposal, memberCount) {
  const threshold = committeeThreshold(memberCount);
  const lengthBound = proposal.method.encodedLength;
  // The proposal's weight, which close must be given as an upper bound.
  const { weight } = await proposal.paymentInfo(EMERGENCY_ADMIN_ACCOUNT);
  return {
    motion: api.tx.technicalCommittee.propose(threshold, proposal, lengthBound),
    threshold,
    memberCount,
    lengthBound,
    weightBound: weight,
    hash: proposal.method.hash.toHex(),
    index: (await api.query.technicalCommittee.proposalCount()).toNumber(),
  };
}

// What changes and what stays, so the numbers can be checked before anything else.
function printSummary(chain, newCap) {
  const perShare = Number(ethers.formatUnits(sharesValue(10n ** 18n, chain), 18)).toFixed(4);
  console.log(`\nvault ${chain.vault}`);
  console.log(`  shares now:     ${fmtShares(chain.supply)}`);
  console.log(`  cap:            ${fmtShares(chain.cap)} -> ${fmtShares(newCap)} shares`);
  console.log(`  worth today:    ~${fmtShares(sharesValue(newCap, chain))} HOLLAR at ${perShare} per share (a share count, not USD: this drifts)`);
  console.log(`  kept as is:     deposit0Max ${chain.deposit0Max}, deposit1Max ${chain.deposit1Max}, customDepositDelta ${chain.delta}`);
  console.log(`  gas:            limit ${chain.gas.gasLimit}, max price ${chain.gas.gasPrice} wei; pays the base fee, fails if it rises above this before close`);
  console.log(`  checks passed:  owner is ${EMERGENCY_ADMIN_EVM}, vault known, cap above supply, gas covered, dry run as the owner`);
}

// The two things to hand over: the proposal (what runs) and the motion (what a member submits).
function printMotion(proposal, m, wsUrl, newCap) {
  const motionHex = m.motion.method.toHex();
  console.log("\n=== proposal: what the committee votes on ===");
  console.log(`  call:           dispatcher.dispatchAsEmergencyAdmin(evm.call as ${EMERGENCY_ADMIN_EVM} -> ClearingV2.customDeposit)`);
  console.log(`  encoded:        ${proposal.method.toHex()}`);
  console.log(`  hash:           ${m.hash}`);
  console.log(`  length bound:   ${m.lengthBound}`);
  console.log(`  weight bound:   refTime ${m.weightBound.refTime}, proofSize ${m.weightBound.proofSize}`);
  console.log("\n=== motion: what one committee member submits ===");
  console.log(`  call:           technicalCommittee.propose(${m.threshold}, <proposal>, ${m.lengthBound})`);
  console.log(`  encoded:        ${motionHex}`);
  console.log(`  polkadot.js:    https://polkadot.js.org/apps/?rpc=${encodeURIComponent(wsUrl)}#/extrinsics/decode/${motionHex}`);
  console.log(`  threshold:      ${m.threshold} of ${m.memberCount} members (at least half)`);
  console.log("  then:");
  console.log(`    1. one member submits the motion; it should get index ${m.index}`);
  console.log(`    2. ${m.threshold} members vote aye, the proposer too: technicalCommittee.vote(<hash>, ${m.index}, true)`);
  console.log(`    3. anyone closes it: technicalCommittee.close(<hash>, ${m.index}, <weight bound>, ${m.lengthBound})`);
  console.log(`    4. read ClearingV2.positions(vault).maxTotalSupply: it must be ${newCap}`);
  console.log("  note:           the dispatcher reports Ok even when the inner evm.call reverts, so step 4 is the only proof");
}

async function main() {
  const newCap = parseShares(process.argv[2]);
  const addresses = { vault: env("VAULT"), clearing: env("CLEARING") };
  if (!addresses.vault || !addresses.clearing) {
    throw new Error("VAULT and CLEARING are not set: copy .env.tc-caps.example to .env.tc-caps and run with ENV_FILE=.env.tc-caps");
  }
  const wsUrl = env("WS_URL", "wss://rpc.hydradx.cloud");
  const api = await ApiPromise.create({ provider: new WsProvider(wsUrl), noInitWarn: true });
  const provider = new ethers.JsonRpcProvider(env("EVM_RPC_URL", "https://rpc.hydradx.cloud"));
  try {
    console.log(`chain: ${api.runtimeVersion.specName} spec ${api.runtimeVersion.specVersion}`);
    const chain = await readChain(api, provider, addresses, BigInt(env("TC_CALL_GAS", "500000")));
    const reason = refusal(chain, newCap);
    if (reason) throw new Error(reason);
    const { data, proposal } = buildProposal(api, addresses, chain, newCap);
    await dryRun(provider, addresses.clearing, data, chain.gas.gasLimit);
    const motion = await buildMotion(api, proposal, chain.memberCount);
    printSummary(chain, newCap);
    printMotion(proposal, motion, wsUrl, newCap);
  } finally {
    await api.disconnect();
  }
}

// The unit tests and the fork test import these, so they check the same encoder Ben runs.
module.exports = { parseShares, committeeThreshold, refusal, sharesValue, readChain, buildProposal, buildMotion, EMERGENCY_ADMIN_EVM };

if (require.main === module) {
  main().catch((error) => {
    console.error(`\nTC caps failed: ${error.message}\n`);
    process.exit(1);
  });
}
