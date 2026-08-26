// 01-deploy — deploy the Gamma stack over an existing Uniswap v3 pool
// (lark4's aDOT/HOLLAR 0.3% pool by default).
//   npx hardhat run lark/01-deploy.ts --network lark4
import { ethers } from "hardhat";
import { LARK, GAS, DEPLOY_NAME, send, signers, saveDeployment, deploymentExists } from "./_shared";

// Guard config. See zombienet/deploy-gamma.ts for the rationale on each.
const OBSERVATION_CARDINALITY = Number(process.env.OBSERVATION_CARDINALITY || 200);
const CARDINALITY_CHUNK = Number(process.env.CARDINALITY_CHUNK || 50);
const PRICE_THRESHOLD = Number(process.env.PRICE_THRESHOLD || 10_100); // 1% deposit deviation
const CLEARING_TWAP_INTERVAL = Number(process.env.TWAP_INTERVAL || 600);
const MAX_TRANSLATION = Number(process.env.MAX_TRANSLATION || 300); // ticks per rebalance
const MAX_WIDTH = Number(process.env.MAX_WIDTH || 300);
const MIN_INTERVAL = Number(process.env.MIN_INTERVAL || 600); // seconds

// Guarded-launch caps. Hypervisor.sol fixes maxTotalSupply/deposit maxima at
// construction (0 = no cap, uint256(-1) = unlimited) with no setters, so they are
// applied on ClearingV2 — the layer every deposit passes through. 0 = no cap.
const MAX_TOTAL_SUPPLY = process.env.MAX_TOTAL_SUPPLY || "0";
const DEPOSIT0_MAX = process.env.DEPOSIT0_MAX || "0";
const DEPOSIT1_MAX = process.env.DEPOSIT1_MAX || "0";
// Gamma fee DIVISOR: 5 = 20% (contract default), 255 = ~0.4%. Never 0 — that
// bricks harvesting. 0 here means "leave at the contract default".
const HYPERVISOR_FEE = Number(process.env.HYPERVISOR_FEE || 0);

// Admin is the role that can move vault ownership, reassign the rebalancer and
// advisor, set the fee and rescue tokens — a hot key here is the whole vault. On
// Hydration that goes to GOVERNANCE, not a Safe: an OpenGov referendum is the
// multi-party approval, and governance can act as the EVM address whose first 20
// bytes match a dispatch account it controls (0xaa7e…aa7e0 via
// dispatcher.dispatchAsAaveManager). Blank = keep the deployer (testnets only).
const GOVERNANCE_ADDRESS = process.env.GOVERNANCE_ADDRESS || "";
// Becomes Admin's advisor so `compound` is reachable. Compound re-mints the SAME
// ticks, so it cannot move the band — safe for a hot key.
const KEEPER_ADDRESS = process.env.KEEPER_ADDRESS || "";

const POOL_ORACLE_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function increaseObservationCardinalityNext(uint16)",
];

async function main() {
  if (deploymentExists()) {
    console.log(`lark/deployments/${DEPLOY_NAME}.json exists — delete it to redeploy. Skipping.`);
    return;
  }
  const { deployer } = await signers();
  console.log(`Deployer   ${deployer.address}`);
  console.log(`v3 factory ${LARK.v3Factory}`);
  console.log(`pool       ${LARK.pool}  (${LARK.sym0}/${LARK.sym1}, fee ${LARK.fee})`);

  const HypervisorFactory = await ethers.getContractFactory("HypervisorFactory", deployer);
  const hf = await HypervisorFactory.deploy(LARK.v3Factory, { gasLimit: GAS.factory });
  await hf.deployTransaction.wait(3);
  console.log(`HypervisorFactory ${hf.address}`);

  // name/symbol are ERC20 constructor args with NO setter — whatever is passed
  // here is the LP token label a front end renders forever. Read the symbols off
  // chain rather than hardcoding them; a stale literal once shipped a vault
  // whose label named a different pair than the one it actually held.
  const SYMBOL_ABI = ["function symbol() view returns (string)"];
  const [sym0, sym1] = await Promise.all([
    new ethers.Contract(LARK.token0, SYMBOL_ABI, ethers.provider).symbol(),
    new ethers.Contract(LARK.token1, SYMBOL_ABI, ethers.provider).symbol(),
  ]);
  const vaultName = process.env.VAULT_NAME || `Gamma ${sym0}-${sym1}`;
  const vaultSymbol = process.env.VAULT_SYMBOL || `g${sym0}-${sym1}`;
  console.log(`LP token   ${vaultName} (${vaultSymbol})`);

  await send(
    hf.createHypervisor(LARK.token0, LARK.token1, LARK.fee, vaultName, vaultSymbol, {
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

  // Deposit caps. `customDeposit` stores the per-tx maxima but `clearDeposit`
  // only enforces them when `depositOverride` is set — without that second call
  // they are inert and the unlimited Hypervisor values are used instead.
  if (MAX_TOTAL_SUPPLY !== "0" || DEPOSIT0_MAX !== "0" || DEPOSIT1_MAX !== "0") {
    await send(
      clearing.customDeposit(hypervisor, DEPOSIT0_MAX, DEPOSIT1_MAX, MAX_TOTAL_SUPPLY, 0, { gasLimit: GAS.call }),
      `clearing.customDeposit(maxSupply=${MAX_TOTAL_SUPPLY} d0=${DEPOSIT0_MAX} d1=${DEPOSIT1_MAX})`
    );
    if (DEPOSIT0_MAX !== "0" || DEPOSIT1_MAX !== "0") {
      await send(
        clearing.setDepositOverride(hypervisor, true, { gasLimit: GAS.call }),
        "clearing.setDepositOverride(true)"
      );
    }
  } else {
    console.log("clearing caps: NONE — unlimited deposits (set MAX_TOTAL_SUPPLY / DEPOSIT0_MAX / DEPOSIT1_MAX)");
  }

  // Gamma fee divisor, while the deployer still owns the vault.
  if (HYPERVISOR_FEE) {
    if (HYPERVISOR_FEE < 1 || HYPERVISOR_FEE > 255) throw new Error("HYPERVISOR_FEE must be 1..255");
    const hyper = await ethers.getContractAt(["function setFee(uint8) external"], hypervisor);
    await send(hyper.setFee(HYPERVISOR_FEE, { gasLimit: GAS.call }), `hypervisor.setFee(${HYPERVISOR_FEE})`);
  } else {
    console.log("hypervisor fee: contract default (5 = 20% of swap fees)");
  }

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

  // LAST. setAdvisor is onlyAdmin, so it must run before the hand-off; the
  // hand-off must be last because it retires the deployer's admin rights.
  if (KEEPER_ADDRESS) {
    await send(
      admin.setAdvisor(hypervisor, KEEPER_ADDRESS, { gasLimit: GAS.call }),
      `admin.setAdvisor(${KEEPER_ADDRESS}) — compound reachable`
    );
  } else {
    console.log("admin advisor: UNSET — compound unreachable (set KEEPER_ADDRESS)");
  }
  if (GOVERNANCE_ADDRESS) {
    await send(
      admin.transferAdmin(GOVERNANCE_ADDRESS, { gasLimit: GAS.call }),
      `admin.transferAdmin(${GOVERNANCE_ADDRESS}) — hot admin key retired`
    );
  } else {
    console.log(`admin.admin: left as deployer ${deployer.address} — set GOVERNANCE_ADDRESS for anything real`);
  }

  saveDeployment({
    network: { name: DEPLOY_NAME, evmRpc: LARK.rpc, chainId: LARK.chainId },
    deployer: deployer.address,
    uniswap: { v3Factory: LARK.v3Factory, swapRouter02: LARK.swapRouter02, quoterV2: LARK.quoterV2, npm: LARK.npm },
    gamma: {
      hypervisorFactory: hf.address,
      hypervisor,
      clearing: clearing.address,
      uniProxy: uniProxy.address,
      admin: admin.address,
      adminOwner: GOVERNANCE_ADDRESS || deployer.address,
      advisor: KEEPER_ADDRESS || null,
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
  console.log(`  DEPLOYMENTS=lark/deployments/${DEPLOY_NAME}.json npx hardhat run zombienet/configure-guards.ts --network ${DEPLOY_NAME}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
