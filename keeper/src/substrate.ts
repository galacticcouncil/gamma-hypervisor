import { ApiPromise, HttpProvider, WsProvider } from '@polkadot/api';

const ASSET_PREFIX = '0x0000000000000000000000000000000100000000';
// "modlomnipool" padded to 32 bytes: the account that holds every Omnipool reserve
const OMNIPOOL_ACCOUNT = '0x6d6f646c6f6d6e69706f6f6c0000000000000000000000000000000000000000';

export async function connectSubstrate(rpcUrl: string): Promise<ApiPromise> {
  const provider = rpcUrl.startsWith('ws') ? new WsProvider(rpcUrl) : new HttpProvider(rpcUrl);
  return ApiPromise.create({ provider, noInitWarn: true, throwOnConnect: true });
}

// http has no runtime-upgrade subscription, so metadata is checked against the chain before use
export async function freshSubstrate(api: ApiPromise, reconnect: () => Promise<ApiPromise>): Promise<ApiPromise> {
  const live = await api.rpc.state.getRuntimeVersion();
  if (live.specVersion.eq(api.runtimeVersion.specVersion)) return api;
  const next = await reconnect();
  await api.disconnect().catch(() => {});
  return next;
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

export async function inOmnipool(api: ApiPromise, id: number): Promise<boolean> {
  return !((await api.query.omnipool.assets(id)) as any).isNone;
}

// the Omnipool spot price of the asset in LRNA, human units; throws when it is not in the Omnipool
export async function omnipoolLrnaPrice(api: ApiPromise, id: number): Promise<number> {
  const [state, account, meta] = await Promise.all([
    api.query.omnipool.assets(id),
    (api.call as any).currenciesApi.account(id, OMNIPOOL_ACCOUNT),
    api.query.assetRegistry.assets(id),
  ]);
  if ((state as any).isNone) throw new Error(`asset ${id} is not in the Omnipool`);
  const hub = Number((state as any).unwrap().hubReserve.toString()) / 1e12;
  const decimals = Number((meta.toJSON() as { decimals?: number } | null)?.decimals);
  if (!Number.isInteger(decimals)) throw new Error(`asset ${id} has no decimals in the registry`);
  const reserve = Number(account.free.toString()) / Math.pow(10, decimals);
  if (!(hub > 0 && reserve > 0)) throw new Error(`asset ${id} has an empty Omnipool reserve`);
  return hub / reserve;
}
