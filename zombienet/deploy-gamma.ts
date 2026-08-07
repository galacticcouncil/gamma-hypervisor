/**
 * deploy-gamma.ts  —  `npx hardhat run zombienet/deploy-gamma.ts --network zombienet`
 *
 * Deploys the Gamma stack on top of the Uniswap v3 already deployed by the
 * sibling uniswap-v3-deploy repo (phase 1), over the KSM/KUSD asset precompiles:
 *
 *   HypervisorFactory(uniV3Factory)
 *     -> createHypervisor(KSM, KUSD, 3000)  (creates the pool if absent)
 *   pool.initialize(1:1)                    (factory creates but doesn't init)
 *   pool.increaseObservationCardinalityNext (TWAP history — the keeper's gate)
 *   ClearingV2() + UniProxy(clearing)       (deposit-guard layer, TWAP-checked)
 *   ClearingV2.addPosition + setPriceThreshold
 *   Admin() + RebalanceProxy()              (Model B: bounded rebalancer key)
 *   hypervisor.setWhitelist(deployer)       (BOOTSTRAP — see step 9)
 *
 * This script leaves the vault in its bootstrap posture (deployer whitelisted and
 * still the owner) because a fresh vault has no base range yet, and both the
 * UniProxy deposit path and Admin-owned rebalancing need one. Run
 * `configure-guards.ts` after the smoke to move to the production posture:
 * whitelist = UniProxy, owner = Admin, keeper bounded by RebalanceProxy.
 *
 * Set GAMMA_KEEPER to the keeper's EVM address to register it as the rebalancer.
 *
 * Writes deployments/zombienet.json (uniswap + gamma + tokens), read by smoke.ts.
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const FEE = 3000; // MEDIUM, tickSpacing 60
const SQRT_PRICE_1_1 = "79228162514264337593543950336"; // 2**96  (price 1.0)

// TWAP history. Each observation is one block in which the price moved. Slots
// are pre-paid SSTOREs (~20k gas each), so growing the ring in ONE call blows
// past Hydration's per-transaction gas cap — grow it in chunks instead. The
// function is permissionless and cumulative, so the ring can be grown further at
// any time, by anyone, after deployment.
const OBSERVATION_CARDINALITY = Number(process.env.OBSERVATION_CARDINALITY || 200);
const CARDINALITY_CHUNK = Number(process.env.CARDINALITY_CHUNK || 50);

// ClearingV2.priceThreshold is compared as price*10_000/priceBefore, so 10_000
// means "0% deviation allowed" — the shipped default rejects almost every
// deposit once a TWAP exists. 10_100 = 1%.
const PRICE_THRESHOLD = Number(process.env.PRICE_THRESHOLD || 10_100);

// ClearingV2's deposit TWAP window. 60s on a fresh local chain (observe() reverts
// 'OLD' for windows longer than the pool's history, which would block every
// deposit); production wants 3600.
const TWAP_INTERVAL = Number(process.env.TWAP_INTERVAL || 60);

// RebalanceProxy caps (ticks). At spacing 60 these bound the keeper to ~3%
// re-centering per interval; MIN_INTERVAL bounds how often it may do that.
const MAX_TRANSLATION = Number(process.env.MAX_TRANSLATION || 300);
const MAX_WIDTH = Number(process.env.MAX_WIDTH || 300);
const MIN_INTERVAL = Number(process.env.MIN_INTERVAL || 600);

const UNISWAP_DEPLOYMENTS =
  process.env.UNISWAP_DEPLOYMENTS ||
  path.join(__dirname, "../../uniswap-v3-deploy/zombienet/deployments/zombienet.json");

const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96,int24,uint16,uint16 observationCardinality,uint16 observationCardinalityNext,uint8,bool)",
  "function initialize(uint160 sqrtPriceX96)",
  "function increaseObservationCardinalityNext(uint16 observationCardinalityNext)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
];
const FACTORY_ABI = [
  "function getPool(address,address,uint24) view returns (address)",
  "function createPool(address,address,uint24) returns (address)",
];

async function main() {
  if (!fs.existsSync(UNISWAP_DEPLOYMENTS)) {
    throw new Error(
      `Uniswap deployments not found at ${UNISWAP_DEPLOYMENTS}\n` +
        `Run phase 1 (uniswap-v3-deploy/zombienet) first, or set UNISWAP_DEPLOYMENTS.`
    );
  }
  const uni = JSON.parse(fs.readFileSync(UNISWAP_DEPLOYMENTS, "utf8"));
  const [signer] = await ethers.getSigners();
  const keeper = process.env.GAMMA_KEEPER || signer.address;
  console.log(`Deployer: ${signer.address}`);
  console.log(`Keeper (rebalancer): ${keeper}${process.env.GAMMA_KEEPER ? "" : "  [defaulting to deployer — set GAMMA_KEEPER]"}`);
  console.log(`Uniswap factory: ${uni.uniswap.v3CoreFactory}`);

  // token0 < token1 by address (Uniswap ordering): KSM(0x..01) < KUSD(0x..02).
  const a = uni.tokens.ksm.address;
  const b = uni.tokens.kusd.address;
  const [token0, token1] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  console.log(`Pair: token0=${token0}  token1=${token1}  fee=${FEE}`);

  // 1) HypervisorFactory
  const HypervisorFactory = await ethers.getContractFactory("HypervisorFactory");
  const hypervisorFactory = await HypervisorFactory.deploy(uni.uniswap.v3CoreFactory);
  await hypervisorFactory.deployed();
  console.log(`HypervisorFactory: ${hypervisorFactory.address}`);

  // 2) createHypervisor — also creates the Uniswap pool if it doesn't exist yet.
  await (await hypervisorFactory.createHypervisor(token0, token1, FEE, "Gamma KSM-KUSD", "gKSM-KUSD")).wait();
  const hypervisorAddr = await hypervisorFactory.getHypervisor(token0, token1, FEE);
  console.log(`Hypervisor: ${hypervisorAddr}`);

  // 3) Initialize the pool (factory.createPool leaves slot0 unset).
  const factory = new ethers.Contract(uni.uniswap.v3CoreFactory, FACTORY_ABI, signer);
  const poolAddr = await factory.getPool(token0, token1, FEE);
  const pool = new ethers.Contract(poolAddr, POOL_ABI, signer);
  const slot0 = await pool.slot0();
  if (slot0.sqrtPriceX96.isZero()) {
    await (await pool.initialize(SQRT_PRICE_1_1)).wait();
    console.log(`Pool ${poolAddr} initialized at 1:1`);
  } else {
    console.log(`Pool ${poolAddr} already initialized`);
  }

  // 4) Grow the observation ring. A fresh pool has cardinality 1 — observe()
  //    reverts, so BOTH the keeper's TWAP gate and ClearingV2's deposit check are
  //    dead until this lands. Note the buffer still has to FILL (one slot per
  //    price-moving block) before a full-window TWAP is available.
  await growCardinality(pool, OBSERVATION_CARDINALITY, CARDINALITY_CHUNK);

  // 5) ClearingV2 + UniProxy (deposit-guard layer).
  const ClearingV2 = await ethers.getContractFactory("ClearingV2");
  const clearing = await ClearingV2.deploy();
  await clearing.deployed();
  console.log(`ClearingV2: ${clearing.address}`);

  const UniProxy = await ethers.getContractFactory("UniProxy");
  const uniProxy = await UniProxy.deploy(clearing.address);
  await uniProxy.deployed();
  console.log(`UniProxy: ${uniProxy.address}`);

  // 6) Register the hypervisor as a clearance position (version 2) and set a
  //    workable deposit price threshold (the 10_000 default means 0% tolerance).
  await (await clearing.addPosition(hypervisorAddr, 2)).wait();
  console.log(`ClearingV2.addPosition(${hypervisorAddr})`);
  await (await clearing.setTwapInterval(TWAP_INTERVAL)).wait();
  await (await clearing.setPriceThreshold(PRICE_THRESHOLD)).wait();
  console.log(`ClearingV2 twapInterval=${TWAP_INTERVAL}s priceThreshold=${PRICE_THRESHOLD} (${(PRICE_THRESHOLD - 10_000) / 100}% deviation)`);

  // 7) Model B access layer: Admin owns the vault, RebalanceProxy bounds the
  //    keeper key. Admin.rebalance is onlyRebalancer, so the proxy must be
  //    Admin's rebalancer, and the keeper must be the proxy's.
  const Admin = await ethers.getContractFactory("Admin");
  const admin = await Admin.deploy(signer.address);
  await admin.deployed();
  console.log(`Admin: ${admin.address}`);

  const RebalanceProxy = await ethers.getContractFactory("RebalanceProxy");
  const rebalanceProxy = await RebalanceProxy.deploy(signer.address);
  await rebalanceProxy.deployed();
  console.log(`RebalanceProxy: ${rebalanceProxy.address}`);

  const hypervisor = await ethers.getContractAt("Hypervisor", hypervisorAddr, signer);

  // 8) Wire the Model B rebalance path and its caps. Admin.rebalance is
  //    onlyRebalancer, so the chain of trust is:
  //      keeper key -> RebalanceProxy (caps) -> Admin -> Hypervisor (onlyOwner)
  await (await admin.setRebalancer(hypervisorAddr, rebalanceProxy.address)).wait();
  await (await rebalanceProxy.setAdmin(hypervisorAddr, admin.address)).wait();
  await (await rebalanceProxy.setRebalancer(hypervisorAddr, keeper)).wait();
  await (await rebalanceProxy.setCustomDiff(hypervisorAddr, MAX_TRANSLATION)).wait();
  await (await rebalanceProxy.setCustomDiffWidth(hypervisorAddr, MAX_WIDTH)).wait();
  await (await rebalanceProxy.setCustomInterval(hypervisorAddr, MIN_INTERVAL)).wait();
  console.log(`RebalanceProxy caps: maxTranslation=${MAX_TRANSLATION} maxWidth=${MAX_WIDTH} minInterval=${MIN_INTERVAL}s`);

  // 9) Bootstrap whitelist = deployer. A fresh vault has baseLower == baseUpper,
  //    and ClearingV2.clearDeposit requires currentTick to sit INSIDE the base
  //    range — so the very first deposit cannot go through UniProxy. Sequence is:
  //      deploy (here) -> smoke deposits directly -> configure-guards.ts flips the
  //      whitelist to UniProxy and hands ownership to Admin.
  await (await hypervisor.setWhitelist(signer.address)).wait();
  console.log(`Hypervisor.setWhitelist(${signer.address})  [BOOTSTRAP — configure-guards.ts switches this to UniProxy]`);
  console.log(`Hypervisor.owner still ${signer.address} — configure-guards.ts hands over to Admin`);

  const out = {
    ...uni,
    gamma: {
      hypervisorFactory: hypervisorFactory.address,
      hypervisor: hypervisorAddr,
      clearing: clearing.address,
      uniProxy: uniProxy.address,
      admin: admin.address,
      rebalanceProxy: rebalanceProxy.address,
      keeper,
      pool: poolAddr,
      fee: FEE,
      token0,
      token1,
      config: {
        observationCardinality: OBSERVATION_CARDINALITY,
        priceThreshold: PRICE_THRESHOLD,
        twapInterval: TWAP_INTERVAL,
        maxTranslation: MAX_TRANSLATION,
        maxWidth: MAX_WIDTH,
        minInterval: MIN_INTERVAL,
        posture: "bootstrap",
      },
    },
  };
  const dir = path.join(__dirname, "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, "zombienet.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${outPath}`);
}

/**
 * Grow the pool's observation ring to `target`, `chunk` slots at a time.
 *
 * Uniswap's `Oracle.grow(current, next)` only writes the slots between the two,
 * so repeated calls with rising targets accumulate. Each slot is a ~20k-gas
 * SSTORE, so a single call to a large target exceeds Hydration's per-transaction
 * gas cap ("exceeds transaction gas limit cap") — hence the chunking.
 */
async function growCardinality(pool: any, target: number, chunk: number) {
  let current = (await pool.slot0()).observationCardinalityNext;
  if (current >= target) {
    console.log(`Pool observation cardinalityNext already ${current}`);
    return;
  }
  console.log(`Growing pool observation ring ${current} -> ${target} in steps of ${chunk}...`);
  while (current < target) {
    const next = Math.min(current + chunk, target);
    await (await pool.increaseObservationCardinalityNext(next)).wait();
    current = next;
    console.log(`  cardinalityNext = ${current}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
