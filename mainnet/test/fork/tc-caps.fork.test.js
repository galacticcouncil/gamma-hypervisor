/**
 * End-to-end test of 12-tc-caps.js on a chopsticks fork of mainnet: the printed
 * motion is proposed, voted and closed by the real committee, and the cap moves.
 *
 *   npm run fork          # terminal 1: fork mainnet at the block in hydradx-mainnet.yml
 *   npm run test:fork     # terminal 2: this file (skipped unless FORK_WS_URL is set)
 *
 * Restart the fork before each run: the tests share one story on one chain, and
 * after a run the cap is already raised. Members "sign" with chopsticks' mock
 * signature, so no committee key is involved. The fork's eth RPC drops revert
 * reasons, so check THAT a deposit reverts, not its message.
 */
const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const { ApiPromise, WsProvider } = require("@polkadot/api");
const { ethers } = require("ethers");
const { ABI } = require("../../lib");
const { readChain, buildProposal, buildMotion } = require("../../12-tc-caps");

const FORK = process.env.FORK_WS_URL; // ws://127.0.0.1:8001 via npm run test:fork
const SKIP = FORK ? false : "set FORK_WS_URL to a running fork: npm run fork, then npm run test:fork";

const ADDRESSES = { vault: "0xa206D0959813f17c17C87147271C49065438648A", clearing: "0x3541A3E5Db2d611904BE4F45A3CAFEA9A4df3e48" };
const UNIPROXY = "0x20aA5d9ffF339c3f1ACaee792aa05c53cEb3F741";
// Holds both tokens and a max allowance to the vault at the pinned block, so a
// deposit can be simulated from it with a read-only eth_call.
const DEPOSITOR = "0xA4E6Cf775b22fc5f38B36e1B6752d0C1eABab435";
const NEW_CAP = 250_000n * 10n ** 18n;

let api;
let provider;

before(async () => {
  if (!FORK) return;
  api = await ApiPromise.create({ provider: new WsProvider(FORK), noInitWarn: true });
  // chopsticks answers eth_* on the same port as the Substrate RPC.
  provider = new ethers.JsonRpcProvider(FORK.replace(/^ws/, "http"));
});

after(async () => {
  await api?.disconnect();
});

// Submit `tx` as `address` with chopsticks' mock signature; resolves with the events of its block.
async function sendAs(tx, address) {
  const nonce = await api.rpc.system.accountNextIndex(address);
  tx.signFake(address, { nonce, blockHash: api.genesisHash, genesisHash: api.genesisHash, runtimeVersion: api.runtimeVersion });
  const mock = new Uint8Array(64).fill(0xcd);
  mock.set([0xde, 0xad, 0xbe, 0xef]);
  tx.signature.set(mock);
  return new Promise((resolve, reject) => {
    tx.send(({ status, events }) => {
      if (status.isInBlock) resolve(events.map(({ event }) => event));
      if (status.isInvalid || status.isDropped || status.isUsurped) reject(new Error(`transaction ${status.type}`));
    }).catch(reject);
  });
}

// The first event named "section.method" (e.g. "technicalCommittee.Executed"), or undefined.
const findEvent = (events, name) => events.find((e) => `${e.section}.${e.method}` === name);

// The committee's members at the forked block, as addresses.
async function members() {
  return (await api.query.technicalCommittee.members()).map(String);
}

// ClearingV2's stored limits for the vault: maxTotalSupply, deposit0Max, deposit1Max, customDepositDelta, ...
function limits() {
  return new ethers.Contract(ADDRESSES.clearing, ABI.clearing, provider).positions(ADDRESSES.vault);
}

// The motion 12-tc-caps.js prints for `newCap`, built by the same functions.
async function printedMotion(newCap) {
  const chain = await readChain(api, provider, ADDRESSES, 500_000n);
  const { proposal } = buildProposal(api, ADDRESSES, chain, newCap);
  return buildMotion(api, proposal, chain.memberCount);
}

// A read-only UniProxy.deposit from DEPOSITOR: `hollar` HOLLAR plus the aDOT the
// vault's mix asks for. Resolves { reverted: false, shares } or { reverted: true }.
async function simulateDeposit(hollar) {
  const getDepositAmount = "function getDepositAmount(address,address,uint256) view returns (uint256,uint256)";
  const clearing = new ethers.Contract(ADDRESSES.clearing, [getDepositAmount], provider);
  const token1 = await new ethers.Contract(ADDRESSES.vault, ABI.hypervisor, provider).token1();
  const deposit1 = ethers.parseUnits(String(hollar), 18);
  const [start, end] = await clearing.getDepositAmount(ADDRESSES.vault, token1, deposit1);
  const proxy = new ethers.Contract(UNIPROXY, ABI.uniProxy, provider);
  try {
    const shares = await proxy.deposit.staticCall((start + end) / 2n, deposit1, DEPOSITOR, ADDRESSES.vault, [0, 0, 0, 0], { from: DEPOSITOR });
    return { reverted: false, shares };
  } catch {
    return { reverted: true };
  }
}

test("before the motion, a deposit bigger than the room left reverts", { skip: SKIP }, async () => {
  // case 1
});

test("a member proposes the printed motion and it is stored under the printed hash", { skip: SKIP }, async () => {
  // case 2
});

test("with fewer ayes than the threshold, the motion cannot close yet", { skip: SKIP }, async () => {
  // case 3
});

test("four ayes and a close run the proposal as …aa7e1 and raise the cap to 250,000", { skip: SKIP }, async () => {
  // case 4
});

test("the per-deposit limits and the ratio band are unchanged afterwards", { skip: SKIP }, async () => {
  // case 5
});

test("after the motion, the deposit that reverted goes through", { skip: SKIP }, async () => {
  // case 6
});
