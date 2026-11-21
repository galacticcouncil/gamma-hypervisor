import { ApiPromise, HttpProvider, WsProvider } from '@polkadot/api';
import { ethers } from 'ethers';

export const DISPATCH_PRECOMPILE = '0x0000000000000000000000000000000000000401';
const ASSET_PREFIX = '0x0000000000000000000000000000000100000000';

export async function connectSubstrate(rpcUrl: string): Promise<ApiPromise> {
  const provider = rpcUrl.startsWith('ws') ? new WsProvider(rpcUrl) : new HttpProvider(rpcUrl);
  return ApiPromise.create({ provider, noInitWarn: true, throwOnConnect: true });
}

// http has no runtime-upgrade subscription, so metadata is checked against the chain before encoding
export async function freshSubstrate(api: ApiPromise, reconnect: () => Promise<ApiPromise>): Promise<ApiPromise> {
  const live = await api.rpc.state.getRuntimeVersion();
  if (live.specVersion.eq(api.runtimeVersion.specVersion)) return api;
  const next = await reconnect();
  await api.disconnect().catch(() => {});
  return next;
}

export function assetPrecompile(id: number): string {
  return ASSET_PREFIX.slice(0, 34) + id.toString(16).padStart(8, '0');
}

export function precompileAssetId(address: string): number | null {
  const a = address.toLowerCase();
  if (!a.startsWith(ASSET_PREFIX.slice(0, 34))) return null;
  return parseInt(a.slice(34), 16);
}

export async function assetIdOf(api: ApiPromise, address: string): Promise<number | null> {
  const direct = precompileAssetId(address);
  if (direct !== null) return direct;
  const id = await api.query.assetRegistry.locationAssets({
    parents: 0,
    interior: { X1: [{ AccountKey20: { network: null, key: address } }] },
  });
  const v = id.toJSON() as number | null;
  return typeof v === 'number' ? v : null;
}

export async function existentialDeposit(api: ApiPromise, id: number): Promise<ethers.BigNumber> {
  const a = (await api.query.assetRegistry.assets(id)).toJSON() as { existentialDeposit?: string | number } | null;
  if (!a || a.existentialDeposit === undefined) throw new Error(`asset ${id} is not registered`);
  return ethers.BigNumber.from(BigInt(a.existentialDeposit).toString());
}

export async function hasStoredRoute(api: ApiPromise, assetIn: number, assetOut: number): Promise<boolean> {
  const [f, r] = await Promise.all([
    api.query.router.routes({ assetIn, assetOut }),
    api.query.router.routes({ assetIn: assetOut, assetOut: assetIn }),
  ]);
  return !(f as any).isNone || !(r as any).isNone;
}

// an empty route makes the router use its stored route for the pair
export function routerSellCall(
  api: ApiPromise,
  assetIn: number,
  assetOut: number,
  amountIn: ethers.BigNumber,
  minOut: ethers.BigNumber,
): string {
  return api.tx.router.sell(assetIn, assetOut, amountIn.toString(), minOut.toString(), []).method.toHex();
}
