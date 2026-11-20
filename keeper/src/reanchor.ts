import { ethers } from 'ethers';
import { ERC20_SPEND_ABI } from './abis';

// a dust swap with its price limit at the oracle: every unit fills between spot
// and the oracle. SwapRouter02 and QuoterV2 revert on a swap that crosses no
// liquidity at all, so a completely empty gap can't be walked this way.
export interface ReanchorTx {
  signer: ethers.Wallet;
  router: ethers.Contract;
  tokenIn: string;
  tokenOut: string;
  fee: number;
  amountIn: ethers.BigNumber;
  sqrtPriceLimitX96: ethers.BigNumber;
  overrides: Record<string, unknown>;
  confirmations: number;
  log: (msg: string) => void;
}

export async function reanchorOnce(i: ReanchorTx): Promise<string | null> {
  try {
    const token = new ethers.Contract(i.tokenIn, ERC20_SPEND_ABI, i.signer);
    const allowance: ethers.BigNumber = await token.allowance(i.signer.address, i.router.address);
    if (allowance.lt(i.amountIn)) {
      const a = await token.approve(i.router.address, i.amountIn, i.overrides);
      await a.wait(i.confirmations);
      i.log(`re-anchor: approved ${i.amountIn.toString()} for the router — ${a.hash}`);
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
    i.log(`re-anchor: submitted ${tx.hash}`);
    await tx.wait(i.confirmations);
    return tx.hash;
  } catch (e: any) {
    i.log(`re-anchor: failed — ${e?.reason ?? e?.error?.message ?? e?.message ?? e}`);
    return null;
  }
}
