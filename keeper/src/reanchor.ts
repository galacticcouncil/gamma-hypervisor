import { ethers } from 'ethers';
import type { ApiPromise } from '@polkadot/api';
import { ATOKEN_ABI, ERC20_SPEND_ABI } from './abis';
import { assetIdOf, inOmnipool, omnipoolLrnaPrice } from './substrate';

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

export interface AnchorTx {
  signer: ethers.Wallet;
  anchor: ethers.Contract;
  pool: string;
  // the token sold and its cap; the other side has a cap of 0
  tokenIn: string;
  max0: ethers.BigNumber;
  max1: ethers.BigNumber;
  target: ethers.BigNumber;
  overrides: Record<string, unknown>;
  confirmations: number;
  log: (msg: string) => void;
}

export interface AnchorResult {
  // an approve or the anchor reached the chain
  sent: boolean;
  // the anchor transaction reached the chain, landed or not
  anchored: boolean;
  ok: boolean;
  // the preflight said the cap runs out before the target
  short: boolean;
  hash: string | null;
}

export async function anchorOnce(i: AnchorTx): Promise<AnchorResult> {
  let sent = false;
  let anchored = false;
  let hash: string | null = null;
  try {
    const cap = i.max0.gt(0) ? i.max0 : i.max1;
    const token = new ethers.Contract(i.tokenIn, ERC20_SPEND_ABI, i.signer);
    if ((await token.allowance(i.signer.address, i.anchor.address)).lt(cap)) {
      const a = await token.approve(i.anchor.address, cap, i.overrides);
      sent = true;
      await a.wait(i.confirmations);
      i.log(`re-anchor: approved ${cap.toString()} of ${i.tokenIn} for the anchor, ${a.hash}`);
    }
    await i.anchor.callStatic.anchor(i.pool, i.target, i.max0, i.max1, i.overrides);
    const tx = await i.anchor.anchor(i.pool, i.target, i.max0, i.max1, i.overrides);
    sent = anchored = true;
    hash = tx.hash;
    i.log(`re-anchor: submitted ${tx.hash}`);
    await tx.wait(i.confirmations);
    return { sent, anchored, ok: true, short: false, hash };
  } catch (e: any) {
    const reason = revertReason(e);
    const short = !anchored && /target not reached/.test(reason);
    i.log(`re-anchor: ${anchored ? 'anchor failed' : 'preflight failed'}: ${reason}`);
    return { sent, anchored, ok: false, short, hash };
  }
}

// the Omnipool asset that prices `token`: the token itself, or the underlying of an aToken that is not listed
export async function xcheckAsset(api: ApiPromise, token: string, provider: ethers.providers.Provider): Promise<number | null> {
  const id = await assetIdOf(api, token);
  if (id !== null && (await inOmnipool(api, id))) return id;
  let underlying: string;
  try {
    underlying = await new ethers.Contract(token, ATOKEN_ABI, provider).UNDERLYING_ASSET_ADDRESS();
  } catch (e: any) {
    if (isRevert(e)) return null;
    throw e;
  }
  const uid = await assetIdOf(api, underlying);
  return uid !== null && (await inOmnipool(api, uid)) ? uid : null;
}

// token1 per token0 on the Omnipool, human units
export async function omnipoolPrice(api: ApiPromise, ids: [number, number]): Promise<number> {
  const [p0, p1] = await Promise.all([omnipoolLrnaPrice(api, ids[0]), omnipoolLrnaPrice(api, ids[1])]);
  return p0 / p1;
}
