/**
 * 06-seed-from-wallet.js — seed ONE vault from a wallet instead of a treasury
 * proposal. Same SEED0 / SEED1 / SEED_TO and the same checks as
 * `01-governance-calldata.js seed` (checkSeed), sent directly from SEEDER_PK.
 *
 *   ENV_FILE=.env.pools POOL_FILE=pools/atbtc-hollar.env SEEDER_PK=0x… node 06-seed-from-wallet.js --check  # read-only
 *   ENV_FILE=.env.pools POOL_FILE=pools/atbtc-hollar.env SEEDER_PK=0x… node 06-seed-from-wallet.js
 *
 * Run it after 05-transfer-ownership.js, with the keeper running. The deposit
 * goes through UniProxy, so ClearingV2's guards apply exactly as they will to
 * any LP. The tokens then sit idle in the vault until the keeper compounds or
 * rebalances: turn COMPOUND_ENABLED on for this pool once it is seeded.
 * SEED_TO receives the LP shares and defaults to the seeding wallet.
 */

const { ethers } = require("ethers");
const { env, requireEnv, gasOverrides, waitForSuccess, loadDeployments, fmtUnits, ABI } = require("./lib");
const { checkSeed } = require("./01-governance-calldata");

async function main() {
  const checkOnly = process.argv.includes("--check");
  const net = env("NET", "mainnet");
  const d = loadDeployments(net);
  if (d.config?.posture !== "production") {
    throw new Error(`posture is ${d.config?.posture} — seed after the ownership transfer, when deposits go through UniProxy`);
  }
  const provider = new ethers.JsonRpcProvider(env("EVM_RPC_URL", d.network.evmRpc));
  const seeder = new ethers.Wallet(requireEnv("SEEDER_PK"), provider);
  const confirmations = Number(env("CONFIRMATIONS", "2"));
  const send = async (txPromise, label) => waitForSuccess(await txPromise, confirmations, label);

  console.log(`=== Seed from a wallet: ${net}${d.pool ? ` ${d.pool}` : ""} ===`);
  console.log(`  seeder ${seeder.address}`);
  console.log(`  vault  ${d.gamma.hypervisor}\n`);
  const { seed0, seed1, to, minIn } = await checkSeed(provider, d, seeder.address, seeder.address);
  if (checkOnly) {
    console.log("\n=== --check: the seed would clear; nothing was sent ===");
    return;
  }

  // UniProxy does not custody the tokens: the vault pulls both from the seeder,
  // so the allowance that matters is the seeder's allowance to the VAULT.
  for (const [token, amount] of [[d.uniswap.token0, seed0], [d.uniswap.token1, seed1]]) {
    const erc20 = new ethers.Contract(token, ABI.erc20, seeder);
    if ((await erc20.allowance(seeder.address, d.gamma.hypervisor)) >= amount) {
      console.log(`  allowance for ${token} already covers the seed`);
    } else {
      await send(erc20.approve(d.gamma.hypervisor, amount, await gasOverrides(provider)), `approve ${token} -> vault`);
    }
  }
  const uniProxy = new ethers.Contract(d.gamma.uniProxy, ABI.uniProxy, seeder);
  await send(
    uniProxy.deposit(seed0, seed1, to, d.gamma.hypervisor, minIn, await gasOverrides(provider)),
    `UniProxy.deposit(${seed0}, ${seed1}) -> shares to ${to}`
  );

  const vault = new ethers.Contract(d.gamma.hypervisor, ABI.hypervisor, provider);
  const [shares, supply] = await Promise.all([vault.balanceOf(to), vault.totalSupply()]);
  console.log(`\n  ${to} holds ${fmtUnits(shares, 18)} shares; vault supply ${fmtUnits(supply, 18)}`);
  console.log("=== seeded — the tokens sit idle until the keeper compounds: set COMPOUND_ENABLED=true for this pool ===");
}

main().catch((e) => {
  console.error("\n  Seed FAILED:", e.message, "\n");
  process.exit(1);
});
