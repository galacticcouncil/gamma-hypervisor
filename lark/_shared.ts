import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

// Target chain + Uniswap v3 stack. Defaults are lark4's aDOT/HOLLAR pool; every
// field is overridable so the same scripts drive a different fork or pair.
//
// Do NOT re-point these at another fork's stack and leave them as defaults. The
// v3 contracts are deployed from the same nonce sequence on every fork, so the
// addresses COLLIDE across chains while holding different contracts — lark1's
// factory address is lark4's Multicall2, and lark1's NPM address is lark4's
// V3Staker. A wrong default therefore calls the wrong contract instead of
// failing with "no code". 00-preflight asserts the stack actually matches.
//
// TOKEN0/TOKEN1 must be the addresses the RUNTIME resolves for these assets. For
// an `Erc20`-kind asset (aDOT, HOLLAR) that is the registered contract, NOT the
// 0x…01++id precompile alias — see uniswap-v3-deploy/mainnet/lib.js
// resolveAssetAddress. Getting this wrong builds a pool the router cannot find,
// and aDOT's alias reverts on transfer besides.
export const LARK = {
  rpc: process.env.LARK_RPC_URL || "https://node4.lark.hydration.cloud",
  chainId: Number(process.env.LARK_CHAIN_ID || 222222),
  v3Factory: process.env.V3_FACTORY || "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  swapRouter02: process.env.V3_SWAP_ROUTER || "0xA51c1fc2f0D1a1b8494Ed1FE312d7C3a78Ed91C0",
  quoterV2: process.env.V3_QUOTER || "0xB7f8BC63BbcaD18155201308C8f3540b07f84F5e",
  npm: process.env.V3_NPM || "0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6",
  pool: process.env.V3_POOL || "0xc3139a43E80c1b5C0f31CFF9A60531B7cA3898ef",
  fee: Number(process.env.V3_FEE || 3000),
  token0: process.env.TOKEN0 || "0x02639ec01313c8775Fae74F2dad1118c8A8a86dA", // aDOT (asset 1001)
  token1: process.env.TOKEN1 || "0x531a654d1696ED52e7275A8cede955E82620f99a", // HOLLAR
  // Decimals are per-token and NOT both 18 the way ASTR/GLMR were: aDOT is 10.
  // Formatting or parsing either side at the wrong scale is off by 1e8.
  dec0: Number(process.env.TOKEN0_DECIMALS || 10),
  dec1: Number(process.env.TOKEN1_DECIMALS || 18),
  sym0: process.env.TOKEN0_SYMBOL || "aDOT",
  sym1: process.env.TOKEN1_SYMBOL || "HOLLAR",
  weth: process.env.GAS_TOKEN || "0x0000000000000000000000000000000100000014", // gas
};

export const CONFIRMATIONS = 3; // lark holds pending nonces oddly; wait a few confs
export const MAX_U128 = ethers.BigNumber.from(2).pow(128).sub(1); // precompile "infinite" approval sentinel (MaxUint256 overflows u128)

// lark gas estimation under-shoots CREATE; pin generous explicit limits (you only pay used gas on success).
export const GAS = { factory: 15_000_000, createHypervisor: 15_000_000, deploy: 12_000_000, call: 5_000_000 };

export const ERC20_ABI = [
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
];
export const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)",
  "function tickSpacing() view returns (int24)",
];
export const ROUTER_ABI = [
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
];
export const HYPERVISOR_ABI = [
  "function owner() view returns (address)",
  "function deposit(uint256,uint256,address,address,uint256[4]) returns (uint256 shares)",
  "function withdraw(uint256,address,address,uint256[4]) returns (uint256 amount0,uint256 amount1)",
  "function getTotalAmounts() view returns (uint256 total0,uint256 total1)",
  "function getBasePosition() view returns (uint128 liquidity,uint256 amount0,uint256 amount1)",
  "function getLimitPosition() view returns (uint128 liquidity,uint256 amount0,uint256 amount1)",
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function baseLower() view returns (int24)",
  "function baseUpper() view returns (int24)",
  "function limitLower() view returns (int24)",
  "function limitUpper() view returns (int24)",
  "function currentTick() view returns (int24)",
  "function feeRecipient() view returns (address)",
  "function setWhitelist(address)",
];

// One record per target chain. Was hardcoded to lark1.json, which made a deploy
// against any other fork either refuse to run or overwrite lark1's addresses.
export const DEPLOY_NAME = process.env.DEPLOY_NAME || "lark4";
const DEPLOY_PATH = path.join(__dirname, "deployments", `${DEPLOY_NAME}.json`);

export function deploymentExists(): boolean {
  return fs.existsSync(DEPLOY_PATH);
}
export function loadDeployment(): any {
  if (!deploymentExists()) throw new Error(`No deployment at ${DEPLOY_PATH} — run 01-deploy first.`);
  return JSON.parse(fs.readFileSync(DEPLOY_PATH, "utf8"));
}
export function saveDeployment(obj: any): void {
  fs.mkdirSync(path.dirname(DEPLOY_PATH), { recursive: true });
  fs.writeFileSync(DEPLOY_PATH, JSON.stringify(obj, null, 2));
  console.log(`wrote ${DEPLOY_PATH}`);
}

// 18-decimal helpers — correct for gas (WETH) and for vault LP shares, which are
// always 18. Use fmt0/fmt1/amt0/amt1 for the pool tokens; aDOT is 10 decimals.
export const fmt = (x: any, d = 18) => ethers.utils.formatUnits(x, d);
export const amt = (env: string, def: string) => ethers.utils.parseUnits(process.env[env] || def, 18);

export const fmt0 = (x: any) => ethers.utils.formatUnits(x, LARK.dec0);
export const fmt1 = (x: any) => ethers.utils.formatUnits(x, LARK.dec1);
export const amt0 = (env: string, def: string) => ethers.utils.parseUnits(process.env[env] || def, LARK.dec0);
export const amt1 = (env: string, def: string) => ethers.utils.parseUnits(process.env[env] || def, LARK.dec1);

export async function send(txPromise: Promise<any>, label?: string): Promise<any> {
  const tx = await txPromise;
  const r = await tx.wait(CONFIRMATIONS);
  if (label) console.log(`  ${label} — ${r.transactionHash}`);
  return r;
}

export async function signers() {
  const s = await ethers.getSigners();
  return { deployer: s[0], bob: s[1] ?? s[0] };
}
