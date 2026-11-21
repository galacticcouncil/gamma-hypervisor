import { ethers } from 'ethers';
import { AAVE_POOL_SUPPLY_ABI, ERC20_SPEND_ABI } from './abis';
import { DISPATCH_PRECOMPILE } from './substrate';

// a dust swap with its price limit at the oracle: every unit fills between spot
// and the oracle. SwapRouter02 and QuoterV2 revert on a swap that crosses no
// liquidity at all, so a completely empty gap can't be walked this way.
// frontier returns Error(string) inside the rpc error message, which ethers v5 does not decode
export function revertReason(e: any): string {
  const raw = JSON.stringify(e?.error ?? e ?? '') + String(e?.message ?? '');
  const m = raw.match(/0x08c379a0([0-9a-fA-F]{192,})/);
  if (m) {
    try {
      return ethers.utils.defaultAbiCoder.decode(['string'], '0x' + m[1])[0];
    } catch {}
  }
  return e?.reason ?? e?.error?.message ?? e?.message ?? String(e);
}

export interface ReanchorTx {
  signer: ethers.Wallet;
  router: ethers.Contract;
  tokenIn: string;
  tokenOut: string;
  fee: number;
  amountIn: ethers.BigNumber;
  /** allowance to grant when short; the router only pulls what the swap consumes */
  approve: ethers.BigNumber;
  sqrtPriceLimitX96: ethers.BigNumber;
  overrides: Record<string, unknown>;
  confirmations: number;
  log: (msg: string) => void;
}

export interface ReanchorResult {
  /** a swap transaction reached the chain, landed or not */
  sent: boolean;
  ok: boolean;
  hash: string | null;
}

export async function reanchorOnce(i: ReanchorTx): Promise<ReanchorResult> {
  let sent = false;
  let hash: string | null = null;
  try {
    const token = new ethers.Contract(i.tokenIn, ERC20_SPEND_ABI, i.signer);
    const allowance: ethers.BigNumber = await token.allowance(i.signer.address, i.router.address);
    if (allowance.lt(i.amountIn)) {
      const approve = i.approve.gt(i.amountIn) ? i.approve : i.amountIn;
      const a = await token.approve(i.router.address, approve, i.overrides);
      await a.wait(i.confirmations);
      i.log(`re-anchor: approved ${approve.toString()} for the router — ${a.hash}`);
    }

    const params = {
      tokenIn: i.tokenIn,
      tokenOut: i.tokenOut,
      fee: i.fee,
      recipient: i.signer.address,
      amountIn: i.amountIn,
      amountOutMinimum: 0,
      sqrtPriceLimitX96: i.sqrtPriceLimitX96,
    };
    await i.router.callStatic.exactInputSingle(params, i.overrides);
    const tx = await i.router.exactInputSingle(params, i.overrides);
    sent = true;
    hash = tx.hash;
    i.log(`re-anchor: submitted ${tx.hash}`);
    await tx.wait(i.confirmations);
    return { sent, ok: true, hash };
  } catch (e: any) {
    // IIA: an aToken transfer can credit the pool one wei short at this block's index; retried next block
    i.log(`re-anchor: ${sent ? 'swap failed' : 'preflight failed'} — ${revertReason(e)}`);
    return { sent, ok: false, hash };
  }
}

export interface WrapTx {
  signer: ethers.Wallet;
  /** the money market pool behind the aToken */
  pool: string;
  underlying: string;
  amount: ethers.BigNumber;
  overrides: Record<string, unknown>;
  confirmations: number;
  log: (msg: string) => void;
}

// supply the underlying the keeper already holds, minting the aToken it sells
export async function wrapOnce(i: WrapTx): Promise<string | null> {
  try {
    const token = new ethers.Contract(i.underlying, ERC20_SPEND_ABI, i.signer);
    const allowance: ethers.BigNumber = await token.allowance(i.signer.address, i.pool);
    if (allowance.lt(i.amount)) {
      const a = await token.approve(i.pool, i.amount, i.overrides);
      await a.wait(i.confirmations);
    }
    const pool = new ethers.Contract(i.pool, AAVE_POOL_SUPPLY_ABI, i.signer);
    await pool.callStatic.supply(i.underlying, i.amount, i.signer.address, 0, i.overrides);
    const tx = await pool.supply(i.underlying, i.amount, i.signer.address, 0, i.overrides);
    await tx.wait(i.confirmations);
    i.log(`re-anchor: supplied ${i.amount.toString()} raw underlying — ${tx.hash}`);
    return tx.hash;
  } catch (e: any) {
    i.log(`re-anchor: supply failed — ${revertReason(e)}`);
    return null;
  }
}

export interface GasBuyTx {
  signer: ethers.Wallet;
  /** SCALE-encoded router.sell, see substrate.ts */
  call: string;
  overrides: Record<string, unknown>;
  confirmations: number;
  log: (msg: string) => void;
}

// buy with the signer's own gas money through the runtime router, via the dispatch precompile
export async function buyWithGasOnce(i: GasBuyTx): Promise<string | null> {
  try {
    const req = { to: DISPATCH_PRECOMPILE, data: i.call, ...i.overrides };
    await i.signer.call(req);
    const tx = await i.signer.sendTransaction(req);
    const r = await tx.wait(i.confirmations);
    if (r.status !== 1) throw new Error(`dispatch reverted in ${tx.hash}`);
    i.log(`re-anchor: bought with gas money — ${tx.hash}`);
    return tx.hash;
  } catch (e: any) {
    i.log(`re-anchor: gas buy failed — ${revertReason(e)}`);
    return null;
  }
}
