import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

// lark1 Uniswap v3 stack + the live GLMR/ASTR 0.3% pool (verified on-chain).
// token0/token1 are address-sorted: ASTR(9) < GLMR(16).
export const LARK = {
  rpc: "https://1.lark.hydration.cloud",
  chainId: 222222,
  v3Factory: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
  swapRouter02: "0x9A676e781A523b5d0C0e43731313A708CB607508",
  quoterV2: "0x0DCd1Bf9A1b36cE34237eEaFef220932846BCD82",
  npm: "0x610178dA211FEF7D417bC0e6FeD39F05609AD788",
  pool: "0x8f86fDedd41169b6CAD841535E02487d91409CF1",
  fee: 3000,
  token0: "0x0000000000000000000000000000000100000009", // ASTR
  token1: "0x0000000000000000000000000000000100000010", // GLMR
  weth: "0x0000000000000000000000000000000100000014", // gas
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

const DEPLOY_PATH = path.join(__dirname, "deployments", "lark1.json");

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

export const fmt = (x: any, d = 18) => ethers.utils.formatUnits(x, d);
export const amt = (env: string, def: string) => ethers.utils.parseUnits(process.env[env] || def, 18);

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
