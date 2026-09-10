// 02-fund-bob — deployer funds BOB with the two pool tokens (to deposit) and WETH (gas).
//   npx hardhat run lark/02-fund-bob.ts --network lark4
import { ethers } from "hardhat";
import { LARK, ERC20_ABI, amt0, amt1, fmt, fmt0, fmt1, send, signers } from "./_shared";

const FUND0 = amt0("FUND_TOKEN0", "30");
const FUND1 = amt1("FUND_TOKEN1", "60");
const GAS_WETH = ethers.utils.parseEther(process.env.FUND_WETH || "5"); // WETH is the EVM gas currency on Hydration

async function main() {
  const { deployer, bob } = await signers();
  if (bob.address === deployer.address) throw new Error("BOB_PK not set — deployer and BOB are the same account.");
  console.log(`Deployer ${deployer.address}`);
  console.log(`BOB      ${bob.address}\n`);

  const t0 = new ethers.Contract(LARK.token0, ERC20_ABI, deployer);
  const t1 = new ethers.Contract(LARK.token1, ERC20_ABI, deployer);

  await send(t0.transfer(bob.address, FUND0), `BOB +${fmt0(FUND0)} ${LARK.sym0}`);
  await send(t1.transfer(bob.address, FUND1), `BOB +${fmt1(FUND1)} ${LARK.sym1}`);
  // Gas is paid in WETH; a plain value transfer moves it to BOB's EVM balance.
  await send(deployer.sendTransaction({ to: bob.address, value: GAS_WETH, gasLimit: 100000 }), `BOB +${fmt(GAS_WETH)} WETH gas`);

  const [b0, b1, bGas] = await Promise.all([
    t0.balanceOf(bob.address),
    t1.balanceOf(bob.address),
    ethers.provider.getBalance(bob.address),
  ]);
  console.log(`\nBOB now holds: ${fmt0(b0)} ${LARK.sym0}, ${fmt1(b1)} ${LARK.sym1}, ${fmt(bGas)} WETH (gas)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
