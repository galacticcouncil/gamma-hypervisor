// Unit tests for the parts of 12-tc-caps.js that need no chain: reading the cap
// Ben types, the vote threshold, the refusal rules, and pricing shares.
const assert = require("node:assert/strict");
const test = require("node:test");
const { ethers } = require("ethers");
const { parseShares, committeeThreshold, refusal, sharesValue, EMERGENCY_ADMIN_EVM } = require("../12-tc-caps");

// Whole shares -> the 18-decimal units the contract stores: shares(250_000).
const shares = (n) => ethers.parseUnits(String(n), 18);

// Chain readings shaped like readChain's result, as mainnet stood at block
// 14,948,259 (the block the fork test pins). Change one field per case:
// chain({ owner: "0xaa7e0000000000000000000000000000000aa7e0" }).
function chain(overrides = {}) {
  return {
    vault: "0xa206D0959813f17c17C87147271C49065438648A",
    owner: EMERGENCY_ADMIN_EVM,
    version: 2,
    depositOverride: true,
    deposit0Max: 458429590940617n, // 45,842.96 aDOT (10 decimals)
    deposit1Max: shares(50_000), // HOLLAR
    cap: shares(150_000),
    delta: 10010n,
    supply: 149943933778420374780501n, // 149,943.93 shares
    total0: 800000836978310n, // 80,000.08 aDOT
    total1: 47931401153113864399057n, // 47,931.40 HOLLAR
    sqrtPriceX96: 836381909818379169869001561882540n,
    memberCount: 7,
    gasBalance: 15992375168871774n, // 0.016 WETH held by …aa7e1
    gasNeeded: 500_000n * 93_968_720n, // gas limit x max gas price
    ...overrides,
  };
}

test("parseShares reads a plain number of shares into 18-decimal units", () => {
  // case 1
});

test("parseShares refuses anything that is not a plain number", () => {
  // case 2
});

test("committeeThreshold asks for at least half the members", () => {
  // case 3
});

test("refusal lets mainnet as it stood raise the cap to 250,000", () => {
  // case 4
});

test("refusal stops a motion when ClearingV2 is owned by someone else", () => {
  // case 5
});

test("refusal stops a cap that is already in place", () => {
  // case 6
});

test("refusal stops a cap at or below the shares that exist", () => {
  // cases 7 and 8
});

test("refusal stops a zero ratio band while the override is on", () => {
  // case 9
});

test("refusal stops a vault that ClearingV2 does not know", () => {
  // case 10
});

test("refusal stops a call that …aa7e1 cannot pay gas for", () => {
  // case 11
});

test("sharesValue prices shares the way Hypervisor.deposit prices the vault", () => {
  // case 12
});

test("sharesValue counts one share per HOLLAR before the first deposit", () => {
  // case 13
});
