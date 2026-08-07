// 06-bob-withdraw — BOB redeems all LP shares for ASTR + GLMR (principal + fees).
//   npx hardhat run lark/06-bob-withdraw.ts --network lark1
import { ethers } from "hardhat";
import { ERC20_ABI, HYPERVISOR_ABI, fmt, loadDeployment, send, signers } from "./_shared";

async function main() {
  const D = loadDeployment();
  const { bob } = await signers();
  const { hypervisor, token0, token1 } = D.gamma;

  const hyper = new ethers.Contract(hypervisor, HYPERVISOR_ABI, bob);
  const astr = new ethers.Contract(token0, ERC20_ABI, ethers.provider);
  const glmr = new ethers.Contract(token1, ERC20_ABI, ethers.provider);

  const shares = await hyper.balanceOf(bob.address);
  if (shares.isZero()) throw new Error("BOB has no shares to withdraw.");

  const [a0, g0] = await Promise.all([astr.balanceOf(bob.address), glmr.balanceOf(bob.address)]);
  console.log(`BOB withdrawing ${fmt(shares)} shares...`);
  await send(hyper.withdraw(shares, bob.address, bob.address, [0, 0, 0, 0]), "BOB withdraw");
  const [a1, g1] = await Promise.all([astr.balanceOf(bob.address), glmr.balanceOf(bob.address)]);

  console.log(`\nBOB received ${fmt(a1.sub(a0))} ASTR + ${fmt(g1.sub(g0))} GLMR`);
  console.log(`(vs his deposit — the difference is fees earned, minus any LVR / rounding.)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
