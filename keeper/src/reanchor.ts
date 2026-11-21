import { ethers } from 'ethers';
import { AAVE_POOL_SUPPLY_ABI, ERC20_SPEND_ABI } from './abis';
import { DISPATCH_PRECOMPILE } from './substrate';

// ethers v5 calls every failed eth_call CALL_EXCEPTION; only the node's own error (numeric or no code) says it reverted
const fromNode = (x: any) => typeof x.code !== 'string';

export function isRevert(e: any): boolean {
  for (let x = e, i = 0; x && i < 6; x = x.error, i++) {
    if (fromNode(x) && /revert/i.test(String(x.message ?? ''))) return true;
  }
  return false;
}

export function revertReason(e: any): string {
  const raw = JSON.stringify(e?.error ?? e ?? '') + String(e?.message ?? '');
  const m = raw.match(/0x08c379a0([0-9a-fA-F]{192,})/);
  if (m) {
    try {
      return ethers.utils.defaultAbiCoder.decode(['string'], '0x' + m[1])[0];
    } catch {}
  }
  for (let x = e, i = 0; x && i < 6; x = x.error, i++) {
    const t = fromNode(x) ? String(x.message ?? '').match(/revert(?:ed)?:?\s*(.*)$/i) : null;
    if (t) return t[1] || 'reverted';
  }
  return e?.reason ?? e?.error?.message ?? e?.message ?? String(e);
}

async function ensureAllowance(
  signer: ethers.Wallet,
  token: string,
  spender: string,
  need: ethers.BigNumber,
  grant: ethers.BigNumber,
  overrides: Record<string, unknown>,
  confirmations: number,
): Promise<string | null> {
  const t = new ethers.Contract(token, ERC20_SPEND_ABI, signer);
  const allowance: ethers.BigNumber = await t.allowance(signer.address, spender);
  if (allowance.gte(need)) return null;
  const a = await t.approve(spender, grant.gt(need) ? grant : need, overrides);
  await a.wait(confirmations);
  return a.hash;
}

export interface ReanchorTx {
  signer: ethers.Wallet;
  router: ethers.Contract;
  tokenIn: string;
  tokenOut: string;
  fee: number;
  amountIn: ethers.BigNumber;
  // allowance granted when short; the router only pulls what the swap consumes
  approve: ethers.BigNumber;
  sqrtPriceLimitX96: ethers.BigNumber;
  overrides: Record<string, unknown>;
  confirmations: number;
  log: (msg: string) => void;
}

export interface ReanchorResult {
  // a swap transaction reached the chain, landed or not
  sent: boolean;
  ok: boolean;
  hash: string | null;
}

export async function reanchorOnce(i: ReanchorTx): Promise<ReanchorResult> {
  let sent = false;
  let hash: string | null = null;
  try {
    const a = await ensureAllowance(i.signer, i.tokenIn, i.router.address, i.amountIn, i.approve, i.overrides, i.confirmations);
    if (a) i.log(`re-anchor: approved ${(i.approve.gt(i.amountIn) ? i.approve : i.amountIn).toString()} for the router — ${a}`);

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
  pool: string;
  underlying: string;
  amount: ethers.BigNumber;
  overrides: Record<string, unknown>;
  confirmations: number;
  log: (msg: string) => void;
}

export async function wrapOnce(i: WrapTx): Promise<{ sent: boolean; ok: boolean }> {
  let sent = false;
  try {
    if (await ensureAllowance(i.signer, i.underlying, i.pool, i.amount, i.amount, i.overrides, i.confirmations)) sent = true;
    const pool = new ethers.Contract(i.pool, AAVE_POOL_SUPPLY_ABI, i.signer);
    await pool.callStatic.supply(i.underlying, i.amount, i.signer.address, 0, i.overrides);
    const tx = await pool.supply(i.underlying, i.amount, i.signer.address, 0, i.overrides);
    sent = true;
    await tx.wait(i.confirmations);
    i.log(`re-anchor: supplied ${i.amount.toString()} raw underlying — ${tx.hash}`);
    return { sent, ok: true };
  } catch (e: any) {
    i.log(`re-anchor: supply failed — ${revertReason(e)}`);
    return { sent, ok: false };
  }
}

export interface GasBuyTx {
  signer: ethers.Wallet;
  // scale-encoded router.sell
  call: string;
  overrides: Record<string, unknown>;
  confirmations: number;
  log: (msg: string) => void;
}

export async function buyWithGasOnce(i: GasBuyTx): Promise<{ sent: boolean; ok: boolean }> {
  let sent = false;
  try {
    const req = { to: DISPATCH_PRECOMPILE, data: i.call, ...i.overrides };
    await i.signer.call(req);
    const tx = await i.signer.sendTransaction(req);
    sent = true;
    const r = await tx.wait(i.confirmations);
    if (r.status !== 1) throw new Error(`dispatch reverted in ${tx.hash}`);
    i.log(`re-anchor: bought with gas money — ${tx.hash}`);
    return { sent, ok: true };
  } catch (e: any) {
    i.log(`re-anchor: gas buy failed — ${revertReason(e)}`);
    return { sent, ok: false };
  }
}

export interface Bridge {
  tokenId: ethers.BigNumber;
  tickLower: number;
  tickUpper: number;
  liquidity: ethers.BigNumber;
}

// a burned id reverts and drops out; an rpc failure throws, so a live bridge is never forgotten
export async function findBridges(npm: ethers.Contract, ids: string[]): Promise<Bridge[]> {
  const out: Bridge[] = [];
  for (const id of ids) {
    let p: any;
    try {
      p = await npm.positions(id);
    } catch (e: any) {
      if (isRevert(e)) continue;
      throw e;
    }
    out.push({ tokenId: ethers.BigNumber.from(id), tickLower: Number(p.tickLower), tickUpper: Number(p.tickUpper), liquidity: p.liquidity });
  }
  return out;
}

export interface MintBridgeTx {
  signer: ethers.Wallet;
  npm: ethers.Contract;
  token0: string;
  token1: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
  amount0: ethers.BigNumber;
  amount1: ethers.BigNumber;
  deadline: number;
  overrides: Record<string, unknown>;
  confirmations: number;
  log: (msg: string) => void;
}

export async function mintBridgeOnce(i: MintBridgeTx): Promise<{ sent: boolean; minted: { hash: string; tokenId: string } | null }> {
  let sent = false;
  try {
    for (const [token, amount] of [[i.token0, i.amount0], [i.token1, i.amount1]] as const) {
      if (!amount.isZero() && (await ensureAllowance(i.signer, token, i.npm.address, amount, amount, i.overrides, i.confirmations))) sent = true;
    }
    const params = {
      token0: i.token0,
      token1: i.token1,
      fee: i.fee,
      tickLower: i.tickLower,
      tickUpper: i.tickUpper,
      amount0Desired: i.amount0,
      amount1Desired: i.amount1,
      amount0Min: 0,
      amount1Min: 0,
      recipient: i.signer.address,
      deadline: i.deadline,
    };
    await i.npm.callStatic.mint(params, i.overrides);
    const tx = await i.npm.mint(params, i.overrides);
    sent = true;
    const r = await tx.wait(i.confirmations);
    let tokenId: string | null = null;
    for (const l of r.logs ?? []) {
      if (String(l.address).toLowerCase() !== i.npm.address.toLowerCase()) continue;
      try {
        const ev = i.npm.interface.parseLog(l);
        if (ev.name === 'Transfer' && String(ev.args.to).toLowerCase() === i.signer.address.toLowerCase()) tokenId = ev.args.tokenId.toString();
      } catch {}
    }
    if (!tokenId) throw new Error(`minted in ${tx.hash} but no position id in the receipt`);
    i.log(`re-anchor: laid bridge #${tokenId} [${i.tickLower}, ${i.tickUpper}] — ${tx.hash}`);
    return { sent, minted: { hash: tx.hash, tokenId } };
  } catch (e: any) {
    i.log(`re-anchor: bridge failed — ${revertReason(e)}`);
    return { sent, minted: null };
  }
}

const MAX128 = ethers.BigNumber.from(2).pow(128).sub(1);

export async function clearBridgesOnce(i: {
  signer: ethers.Wallet;
  npm: ethers.Contract;
  bridges: Bridge[];
  deadline: number;
  overrides: Record<string, unknown>;
  confirmations: number;
  log: (msg: string) => void;
}): Promise<{ sent: boolean; cleared: string[] }> {
  const cleared: string[] = [];
  let sent = false;
  for (const b of i.bridges) {
    try {
      const calls: string[] = [];
      if (b.liquidity.gt(0)) {
        calls.push(
          i.npm.interface.encodeFunctionData('decreaseLiquidity', [
            { tokenId: b.tokenId, liquidity: b.liquidity, amount0Min: 0, amount1Min: 0, deadline: i.deadline },
          ]),
        );
      }
      calls.push(
        i.npm.interface.encodeFunctionData('collect', [
          { tokenId: b.tokenId, recipient: i.signer.address, amount0Max: MAX128, amount1Max: MAX128 },
        ]),
      );
      calls.push(i.npm.interface.encodeFunctionData('burn', [b.tokenId]));
      await i.npm.callStatic.multicall(calls, i.overrides);
      const tx = await i.npm.multicall(calls, i.overrides);
      sent = true;
      await tx.wait(i.confirmations);
      i.log(`re-anchor: cleared bridge #${b.tokenId.toString()} — ${tx.hash}`);
      cleared.push(b.tokenId.toString());
    } catch (e: any) {
      i.log(`re-anchor: clearing bridge #${b.tokenId.toString()} failed — ${revertReason(e)}`);
    }
  }
  return { sent, cleared };
}
