// 06-bob-withdraw — BOB redeems all LP shares for the two pool tokens (principal + fees).
//   npx hardhat run lark/06-bob-withdraw.ts --network lark4
import { ethers } from "hardhat";
import { LARK, ERC20_ABI, HYPERVISOR_ABI, fmt, fmt0, fmt1, loadDeployment, send, signers } from "./_shared";

async function main() {
  const D = loadDeployment();
  const { bob } = await signers();
  const { hypervisor, token0, token1 } = D.gamma;

  const hyper = new ethers.Contract(hypervisor, HYPERVISOR_ABI, bob);
  const t0 = new ethers.Contract(token0, ERC20_ABI, ethers.provider);
  const t1 = new ethers.Contract(token1, ERC20_ABI, ethers.provider);

  const shares = await hyper.balanceOf(bob.address);
  if (shares.isZero()) throw new Error("BOB has no shares to withdraw.");

  const [a0, g0] = await Promise.all([t0.balanceOf(bob.address), t1.balanceOf(bob.address)]);
  console.log(`BOB withdrawing ${fmt(shares)} shares...`);
  await send(hyper.withdraw(shares, bob.address, bob.address, [0, 0, 0, 0]), "BOB withdraw");
  const [a1, g1] = await Promise.all([t0.balanceOf(bob.address), t1.balanceOf(bob.address)]);

  console.log(`\nBOB received ${fmt0(a1.sub(a0))} ${LARK.sym0} + ${fmt1(g1.sub(g0))} ${LARK.sym1}`);
  console.log(`(vs his deposit — the difference is fees earned, minus any LVR / rounding.)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
