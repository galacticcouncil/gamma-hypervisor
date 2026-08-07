// 00-preflight — read-only sanity check (no transactions).
//   npx hardhat run lark/00-preflight.ts --network lark1
import { ethers } from "hardhat";
import { LARK, ERC20_ABI, POOL_ABI, fmt, signers } from "./_shared";

async function main() {
  const net = await ethers.provider.getNetwork();
  console.log(`network chainId ${net.chainId} (expect 222222)`);

  const pool = new ethers.Contract(LARK.pool, POOL_ABI, ethers.provider);
  const { tick } = await pool.slot0();
  console.log(`pool ${LARK.pool}  tick=${tick}  spacing=${await pool.tickSpacing()}`);

  const { deployer, bob } = await signers();
  const astr = new ethers.Contract(LARK.token0, ERC20_ABI, ethers.provider);
  const glmr = new ethers.Contract(LARK.token1, ERC20_ABI, ethers.provider);
  for (const [name, s] of [["deployer", deployer], ["BOB     ", bob]] as const) {
    const [gas, a, g] = await Promise.all([
      ethers.provider.getBalance(s.address),
      astr.balanceOf(s.address),
      glmr.balanceOf(s.address),
    ]);
    console.log(`${name} ${s.address}  gas(WETH)=${fmt(gas)}  ASTR=${fmt(a)}  GLMR=${fmt(g)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
