// 03-bob-deposit — BOB deposits into the Gamma vault and receives liquid LP shares.
//
// Two paths, picked from the vault's current whitelist:
//   bootstrap  — deployer whitelists BOB, who deposits straight into the vault.
//                Needed for the FIRST deposit: ClearingV2 requires the vault to
//                already have a base range bracketing the current tick.
//   guarded    — whitelist is UniProxy (after configure-guards.ts), so the
//                deposit routes through ClearingV2's ratio + TWAP checks.
//
//   npx hardhat run lark/03-bob-deposit.ts --network lark1
import { ethers } from "hardhat";
import { ERC20_ABI, HYPERVISOR_ABI, MAX_U128, amt, fmt, loadDeployment, send, signers } from "./_shared";

const DEPOSIT0 = amt("BOB_DEPOSIT0", "100000"); // ASTR
const DEPOSIT1 = amt("BOB_DEPOSIT1", "100000"); // GLMR

const UNIPROXY_ABI = [
  "function deposit(uint256,uint256,address,address,uint256[4]) returns (uint256 shares)",
];
const WHITELIST_ABI = ["function whitelistedAddress() view returns (address)"];

async function main() {
  const D = loadDeployment();
  const { deployer, bob } = await signers();
  const { hypervisor, uniProxy, token0, token1 } = D.gamma;
  console.log(`BOB ${bob.address} depositing into vault ${hypervisor}\n`);

  const whitelisted: string = await new ethers.Contract(hypervisor, WHITELIST_ABI, bob).whitelistedAddress();
  const guarded = !!uniProxy && whitelisted.toLowerCase() === uniProxy.toLowerCase();
  console.log(`  whitelist = ${whitelisted} (${guarded ? "UniProxy — guarded path" : "bootstrap path"})`);

  if (!guarded) {
    // Only the whitelisted address may call Hypervisor.deposit directly.
    const hyperOwner = new ethers.Contract(hypervisor, HYPERVISOR_ABI, deployer);
    await send(hyperOwner.setWhitelist(bob.address), "owner setWhitelist(BOB)");
  }

  // Approve the HYPERVISOR in both paths. UniProxy never custodies the tokens —
  // it forwards to Hypervisor.deposit(..., from = msg.sender) and the vault does
  // transferFrom(BOB -> vault), so the allowance checked is BOB's to the vault.
  const astr = new ethers.Contract(token0, ERC20_ABI, bob);
  const glmr = new ethers.Contract(token1, ERC20_ABI, bob);
  await send(astr.approve(hypervisor, MAX_U128), "BOB approve ASTR");
  await send(glmr.approve(hypervisor, MAX_U128), "BOB approve GLMR");

  console.log(`  depositing ${fmt(DEPOSIT0)} ASTR + ${fmt(DEPOSIT1)} GLMR...`);
  if (guarded) {
    // UniProxy pulls from msg.sender and mints to `to`; `pos` is the vault.
    const proxy = new ethers.Contract(uniProxy, UNIPROXY_ABI, bob);
    await send(proxy.deposit(DEPOSIT0, DEPOSIT1, bob.address, hypervisor, [0, 0, 0, 0]), "BOB deposit (via UniProxy)");
  } else {
    const hyperBob = new ethers.Contract(hypervisor, HYPERVISOR_ABI, bob);
    await send(hyperBob.deposit(DEPOSIT0, DEPOSIT1, bob.address, bob.address, [0, 0, 0, 0]), "BOB deposit");
  }

  const hyperRead = new ethers.Contract(hypervisor, HYPERVISOR_ABI, bob);
  const [shares, supply, totals] = await Promise.all([
    hyperRead.balanceOf(bob.address),
    hyperRead.totalSupply(),
    hyperRead.getTotalAmounts(),
  ]);
  console.log(`\n  BOB LP shares (liquid tokens): ${fmt(shares)}`);
  console.log(`  vault totalSupply:             ${fmt(supply)}`);
  console.log(`  vault totals:                  ${fmt(totals.total0)} ASTR / ${fmt(totals.total1)} GLMR`);
  console.log(`\nNext: run the keeper (it deploys this escrowed liquidity into ranges on the first rebalance).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
