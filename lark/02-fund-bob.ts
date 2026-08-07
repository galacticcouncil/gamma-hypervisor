// 02-fund-bob — deployer funds BOB with ASTR + GLMR (to deposit) and WETH (gas).
//   npx hardhat run lark/02-fund-bob.ts --network lark1
import { ethers } from "hardhat";
import { LARK, ERC20_ABI, amt, fmt, send, signers } from "./_shared";

const ASTR = amt("FUND_ASTR", "200000");
const GLMR = amt("FUND_GLMR", "200000");
const GAS_WETH = ethers.utils.parseEther(process.env.FUND_WETH || "5"); // WETH is the EVM gas currency on Hydration

async function main() {
  const { deployer, bob } = await signers();
  if (bob.address === deployer.address) throw new Error("BOB_PK not set — deployer and BOB are the same account.");
  console.log(`Deployer ${deployer.address}`);
  console.log(`BOB      ${bob.address}\n`);

  const astr = new ethers.Contract(LARK.token0, ERC20_ABI, deployer);
  const glmr = new ethers.Contract(LARK.token1, ERC20_ABI, deployer);

  await send(astr.transfer(bob.address, ASTR), `BOB +${fmt(ASTR)} ASTR`);
  await send(glmr.transfer(bob.address, GLMR), `BOB +${fmt(GLMR)} GLMR`);
  // Gas is paid in WETH; a plain value transfer moves it to BOB's EVM balance.
  await send(deployer.sendTransaction({ to: bob.address, value: GAS_WETH, gasLimit: 100000 }), `BOB +${fmt(GAS_WETH)} WETH gas`);

  const [bAstr, bGlmr, bGas] = await Promise.all([
    astr.balanceOf(bob.address),
    glmr.balanceOf(bob.address),
    ethers.provider.getBalance(bob.address),
  ]);
  console.log(`\nBOB now holds: ${fmt(bAstr)} ASTR, ${fmt(bGlmr)} GLMR, ${fmt(bGas)} WETH (gas)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
