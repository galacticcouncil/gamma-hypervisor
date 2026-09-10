// 05-report — BOB's liquid LP tokens, his share of the vault, and redeemable value.
//   npx hardhat run lark/05-report.ts --network lark4
import { ethers } from "hardhat";
import { LARK, HYPERVISOR_ABI, POOL_ABI, fmt, fmt0, fmt1, loadDeployment, signers } from "./_shared";

async function main() {
  const D = loadDeployment();
  const { bob } = await signers();
  const hyper = new ethers.Contract(D.gamma.hypervisor, HYPERVISOR_ABI, ethers.provider);
  const pool = new ethers.Contract(D.gamma.pool, POOL_ABI, ethers.provider);

  const [shares, supply, totals, base, limit, bl, bu, ll, lu, feeRecipient] = await Promise.all([
    hyper.balanceOf(bob.address),
    hyper.totalSupply(),
    hyper.getTotalAmounts(),
    hyper.getBasePosition(),
    hyper.getLimitPosition(),
    hyper.baseLower(),
    hyper.baseUpper(),
    hyper.limitLower(),
    hyper.limitUpper(),
    hyper.feeRecipient(),
  ]);
  const { tick } = await pool.slot0();

  const share0 = supply.isZero() ? ethers.constants.Zero : totals.total0.mul(shares).div(supply);
  const share1 = supply.isZero() ? ethers.constants.Zero : totals.total1.mul(shares).div(supply);
  const pct = supply.isZero() ? 0 : shares.mul(10000).div(supply).toNumber() / 100;

  console.log(`pool tick          ${tick}`);
  console.log(`vault base range   [${bl}, ${bu}]   liquidity ${base.liquidity.toString()}`);
  console.log(`vault limit range  [${ll}, ${lu}]   liquidity ${limit.liquidity.toString()}`);
  console.log(`vault totals       ${fmt0(totals.total0)} ${LARK.sym0} / ${fmt1(totals.total1)} ${LARK.sym1}`);
  console.log(`feeRecipient       ${feeRecipient}`);
  console.log(`\nBOB ${bob.address}`);
  console.log(`  LP shares (liquid tokens)  ${fmt(shares)}`);
  console.log(`  share of vault             ${pct}%`);
  console.log(`  redeemable underlying      ${fmt0(share0)} ${LARK.sym0} / ${fmt1(share1)} ${LARK.sym1}`);
  console.log(`\n  Redeemable value above BOB's deposit = his share of collected swap fees.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
