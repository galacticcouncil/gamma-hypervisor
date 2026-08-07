// 01-deploy — deploy the Gamma stack over lark1's live GLMR/ASTR pool.
//   npx hardhat run lark/01-deploy.ts --network lark1
import { ethers } from "hardhat";
import { LARK, GAS, send, signers, saveDeployment, deploymentExists } from "./_shared";

// Guard config. See zombienet/deploy-gamma.ts for the rationale on each.
const OBSERVATION_CARDINALITY = Number(process.env.OBSERVATION_CARDINALITY || 200);
const CARDINALITY_CHUNK = Number(process.env.CARDINALITY_CHUNK || 50);
const PRICE_THRESHOLD = Number(process.env.PRICE_THRESHOLD || 10_100); // 1% deposit deviation
const CLEARING_TWAP_INTERVAL = Number(process.env.TWAP_INTERVAL || 600);
const MAX_TRANSLATION = Number(process.env.MAX_TRANSLATION || 300); // ticks per rebalance
const MAX_WIDTH = Number(process.env.MAX_WIDTH || 300);
const MIN_INTERVAL = Number(process.env.MIN_INTERVAL || 600); // seconds

const POOL_ORACLE_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function increaseObservationCardinalityNext(uint16)",
];

async function main() {
  if (deploymentExists()) {
    console.log("lark/deployments/lark1.json exists — delete it to redeploy. Skipping.");
    return;
  }
  const { deployer } = await signers();
  console.log(`Deployer   ${deployer.address}`);
  console.log(`v3 factory ${LARK.v3Factory}`);
  console.log(`pool       ${LARK.pool}  (ASTR/GLMR, fee ${LARK.fee})`);

  const HypervisorFactory = await ethers.getContractFactory("HypervisorFactory", deployer);
  const hf = await HypervisorFactory.deploy(LARK.v3Factory, { gasLimit: GAS.factory });
  await hf.deployTransaction.wait(3);
  console.log(`HypervisorFactory ${hf.address}`);

  await send(
    hf.createHypervisor(LARK.token0, LARK.token1, LARK.fee, "Gamma ASTR-GLMR", "gASTR-GLMR", {
      gasLimit: GAS.createHypervisor,
    }),
    "createHypervisor (binds to existing pool)",
  );
  const hypervisor = await hf.getHypervisor(LARK.token0, LARK.token1, LARK.fee);
  console.log(`Hypervisor ${hypervisor}  (owner = deployer)`);

  const ClearingV2 = await ethers.getContractFactory("ClearingV2", deployer);
  const clearing = await ClearingV2.deploy({ gasLimit: GAS.deploy });
  await clearing.deployTransaction.wait(3);
  console.log(`ClearingV2 ${clearing.address}`);

  const UniProxy = await ethers.getContractFactory("UniProxy", deployer);
  const uniProxy = await UniProxy.deploy(clearing.address, { gasLimit: GAS.deploy });
  await uniProxy.deployTransaction.wait(3);
  console.log(`UniProxy   ${uniProxy.address}`);

  await send(clearing.addPosition(hypervisor, 2, { gasLimit: GAS.call }), "clearing.addPosition");

  // ClearingV2 ships priceThreshold = 10_000, which compares as
  // price*10_000/priceBefore and therefore allows 0% deviation — every deposit
  // reverts once a TWAP exists. 10_100 = 1%.
  await send(clearing.setTwapInterval(CLEARING_TWAP_INTERVAL, { gasLimit: GAS.call }), `clearing.setTwapInterval(${CLEARING_TWAP_INTERVAL})`);
  await send(clearing.setPriceThreshold(PRICE_THRESHOLD, { gasLimit: GAS.call }), `clearing.setPriceThreshold(${PRICE_THRESHOLD})`);

  // Grow the pool's observation ring. A cardinality-1 pool makes observe()
  // revert, which disables BOTH the keeper's TWAP gate and ClearingV2's deposit
  // check. The ring still has to fill before a full window is readable.
  // Grown in chunks: each slot is a ~20k-gas SSTORE, so one call to a large
  // target exceeds the chain's per-transaction gas cap. The function is
  // permissionless and cumulative, so it can be grown further later.
  const pool = new ethers.Contract(LARK.pool, POOL_ORACLE_ABI, deployer);
  let cardinality = (await pool.slot0()).observationCardinalityNext;
  if (cardinality >= OBSERVATION_CARDINALITY) {
    console.log(`pool observationCardinalityNext already ${cardinality}`);
  } else {
    while (cardinality < OBSERVATION_CARDINALITY) {
      const next = Math.min(cardinality + CARDINALITY_CHUNK, OBSERVATION_CARDINALITY);
      await send(
        pool.increaseObservationCardinalityNext(next, { gasLimit: GAS.call }),
        `pool.increaseObservationCardinalityNext(${next})`,
      );
      cardinality = next;
    }
  }

  // Model B access layer: keeper key -> RebalanceProxy (caps) -> Admin -> vault.
  const Admin = await ethers.getContractFactory("Admin", deployer);
  const admin = await Admin.deploy(deployer.address, { gasLimit: GAS.deploy });
  await admin.deployTransaction.wait(3);
  console.log(`Admin      ${admin.address}`);

  const RebalanceProxy = await ethers.getContractFactory("RebalanceProxy", deployer);
  const rebalanceProxy = await RebalanceProxy.deploy(deployer.address, { gasLimit: GAS.deploy });
  await rebalanceProxy.deployTransaction.wait(3);
  console.log(`RebalanceProxy ${rebalanceProxy.address}`);

  const keeper = process.env.GAMMA_KEEPER || deployer.address;
  await send(admin.setRebalancer(hypervisor, rebalanceProxy.address, { gasLimit: GAS.call }), "admin.setRebalancer(proxy)");
  await send(rebalanceProxy.setAdmin(hypervisor, admin.address, { gasLimit: GAS.call }), "proxy.setAdmin");
  await send(rebalanceProxy.setRebalancer(hypervisor, keeper, { gasLimit: GAS.call }), `proxy.setRebalancer(${keeper})`);
  await send(rebalanceProxy.setCustomDiff(hypervisor, MAX_TRANSLATION, { gasLimit: GAS.call }), `proxy maxTranslation=${MAX_TRANSLATION}`);
  await send(rebalanceProxy.setCustomDiffWidth(hypervisor, MAX_WIDTH, { gasLimit: GAS.call }), `proxy maxWidth=${MAX_WIDTH}`);
  await send(rebalanceProxy.setCustomInterval(hypervisor, MIN_INTERVAL, { gasLimit: GAS.call }), `proxy minInterval=${MIN_INTERVAL}s`);

  saveDeployment({
    network: { name: "lark1", evmRpc: LARK.rpc, chainId: LARK.chainId },
    deployer: deployer.address,
    uniswap: { v3Factory: LARK.v3Factory, swapRouter02: LARK.swapRouter02, quoterV2: LARK.quoterV2, npm: LARK.npm },
    gamma: {
      hypervisorFactory: hf.address,
      hypervisor,
      clearing: clearing.address,
      uniProxy: uniProxy.address,
      admin: admin.address,
      rebalanceProxy: rebalanceProxy.address,
      keeper,
      pool: LARK.pool,
      fee: LARK.fee,
      token0: LARK.token0,
      token1: LARK.token1,
      config: {
        observationCardinality: OBSERVATION_CARDINALITY,
        priceThreshold: PRICE_THRESHOLD,
        twapInterval: CLEARING_TWAP_INTERVAL,
        maxTranslation: MAX_TRANSLATION,
        maxWidth: MAX_WIDTH,
        minInterval: MIN_INTERVAL,
        posture: "bootstrap",
      },
    },
  });
  console.log(`\nNext: point the keeper at VAULT=${hypervisor} and run 02-fund-bob.`);
  console.log(`Then run configure-guards to route deposits through UniProxy and hand the vault to Admin:`);
  console.log(`  DEPLOYMENTS=lark/deployments/lark1.json npx hardhat run zombienet/configure-guards.ts --network lark1`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
