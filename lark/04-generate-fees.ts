// 04-generate-fees — swap through the pool so the vault accrues fees, then push a
// one-way swap to drift the price (so the keeper re-centers on its next run).
//   npx hardhat run lark/04-generate-fees.ts --network lark1
import { ethers } from "hardhat";
import { LARK, ERC20_ABI, ROUTER_ABI, MAX_U128, amt, fmt, send, signers } from "./_shared";

const SWAP_IN = amt("SWAP_IN", "5000");
const DRIFT_IN = amt("DRIFT_IN", "50000");
const ROUNDS = Number(process.env.ROUNDS || "4");

async function main() {
  const { deployer } = await signers();
  const router = new ethers.Contract(LARK.swapRouter02, ROUTER_ABI, deployer);
  const astr = new ethers.Contract(LARK.token0, ERC20_ABI, deployer);
  const glmr = new ethers.Contract(LARK.token1, ERC20_ABI, deployer);
  await send(astr.approve(LARK.swapRouter02, MAX_U128), "approve ASTR -> router");
  await send(glmr.approve(LARK.swapRouter02, MAX_U128), "approve GLMR -> router");

  const swap = (tokenIn: string, tokenOut: string, amountIn: any) =>
    router.exactInputSingle({
      tokenIn,
      tokenOut,
      fee: LARK.fee,
      recipient: deployer.address,
      amountIn,
      amountOutMinimum: 0,
      sqrtPriceLimitX96: 0,
    });

  for (let i = 0; i < ROUNDS; i++) {
    await send(swap(LARK.token0, LARK.token1, SWAP_IN), `round ${i + 1}: ${fmt(SWAP_IN)} ASTR->GLMR`);
    await send(swap(LARK.token1, LARK.token0, SWAP_IN), `round ${i + 1}: ${fmt(SWAP_IN)} GLMR->ASTR`);
  }
  if (!DRIFT_IN.isZero()) {
    await send(swap(LARK.token0, LARK.token1, DRIFT_IN), `drift: ${fmt(DRIFT_IN)} ASTR->GLMR (push price out of band)`);
  }
  console.log("\nFees accrued + price drifted. Re-run the keeper to compound fees and re-center BOB's position.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
