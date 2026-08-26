// 04-generate-fees — swap through the pool so the vault accrues fees, then push a
// one-way swap to drift the price (so the keeper re-centers on its next run).
//   npx hardhat run lark/04-generate-fees.ts --network lark4
import { ethers } from "hardhat";
import { LARK, ERC20_ABI, ROUTER_ABI, MAX_U128, amt0, amt1, fmt0, fmt1, send, signers } from "./_shared";

// Sized for the aDOT/HOLLAR pool, which is thin: inside the vault band ~2 aDOT
// moves ~25 ticks, but once price leaves the band a few hundred HOLLAR can move
// it thousands. Raise deliberately.
const SWAP_IN = amt0("SWAP_IN", "2");
const DRIFT_IN = amt1("DRIFT_IN", "20");
const ROUNDS = Number(process.env.ROUNDS || "4");

async function main() {
  const { deployer } = await signers();
  const router = new ethers.Contract(LARK.swapRouter02, ROUTER_ABI, deployer);
  const t0 = new ethers.Contract(LARK.token0, ERC20_ABI, deployer);
  const t1 = new ethers.Contract(LARK.token1, ERC20_ABI, deployer);
  await send(t0.approve(LARK.swapRouter02, MAX_U128), `approve ${LARK.sym0} -> router`);
  await send(t1.approve(LARK.swapRouter02, MAX_U128), `approve ${LARK.sym1} -> router`);

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

  const erc0 = new ethers.Contract(LARK.token0, ERC20_ABI, ethers.provider);
  const erc1 = new ethers.Contract(LARK.token1, ERC20_ABI, ethers.provider);
  for (let i = 0; i < ROUNDS; i++) {
    // The return leg must send back exactly what the forward leg produced.
    // Sizing it off the signer's whole balance turns a round trip into a large
    // one-way push — that mistake once ran the tick +20,287.
    const before = await erc1.balanceOf(deployer.address);
    await send(swap(LARK.token0, LARK.token1, SWAP_IN), `round ${i + 1}: ${fmt0(SWAP_IN)} ${LARK.sym0}->${LARK.sym1}`);
    const got = (await erc1.balanceOf(deployer.address)).sub(before);
    await send(swap(LARK.token1, LARK.token0, got), `round ${i + 1}: ${fmt1(got)} ${LARK.sym1}->${LARK.sym0}`);
  }
  if (!DRIFT_IN.isZero()) {
    await send(swap(LARK.token1, LARK.token0, DRIFT_IN), `drift: ${fmt1(DRIFT_IN)} ${LARK.sym1}->${LARK.sym0} (push price out of band)`);
  }
  console.log("\nFees accrued + price drifted. Re-run the keeper to compound fees and re-center BOB's position.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
