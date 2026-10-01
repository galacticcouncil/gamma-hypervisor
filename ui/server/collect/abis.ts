// abis the keeper does not carry. field order verified against
// contracts/Hypervisor.sol:50-76 (events, :30/:41/:42/:44 getters) and
// contracts/ClearingV2.sol:23-49 (state + Position struct) / :245 (getSqrtTwapX96)
// on 2026-09-18.

// keeper abis.ts:16 has Rebalance only; the indexer needs all four and decodes
// with this list alone, so nothing is duplicated against HYPERVISOR_ABI
export const HYPERVISOR_EVENTS_ABI = [
  'event Rebalance(int24 tick, uint256 totalAmount0, uint256 totalAmount1, uint256 feeAmount0, uint256 feeAmount1, uint256 totalSupply)',
  'event ZeroBurn(uint8 fee, uint256 fees0, uint256 fees1)',
  'event Deposit(address indexed sender, address indexed to, uint256 shares, uint256 amount0, uint256 amount1)',
  'event Withdraw(address indexed sender, address indexed to, uint256 shares, uint256 amount0, uint256 amount1)',
];

// getters the sampler reads beside HYPERVISOR_ABI (no overlap with it)
export const HYPERVISOR_EXTRA_ABI = [
  'function fee() view returns (uint8)',
  'function whitelistedAddress() view returns (address)',
  'function directDeposit() view returns (bool)',
  'function totalSupply() view returns (uint256)',
  'function maxTotalSupply() view returns (uint256)',
];

export const POOL_EXTRA_ABI = ['function liquidity() view returns (uint128)'];

export const CLEARING_ABI = [
  'function paused() view returns (bool)',
  'function twapCheck() view returns (bool)',
  'function twapInterval() view returns (uint32)',
  'function priceThreshold() view returns (uint256)',
  'function positions(address) view returns (bool customRatio, bool customTwap, bool ratioRemoved, bool depositOverride, bool twapOverride, uint8 version, uint32 twapInterval, uint256 priceThreshold, uint256 deposit0Max, uint256 deposit1Max, uint256 maxTotalSupply, uint256 fauxTotal0, uint256 fauxTotal1, uint256 customDepositDelta)',
  'function getSqrtTwapX96(address pos, uint32 _twapInterval) view returns (uint160 sqrtPriceX96)',
];

// UniProxy.sol:36 — the hypervisor whitelists the UniProxy, not the clearing it
// consults (:59), so a deposit gate has to follow one hop
export const UNIPROXY_ABI = ['function clearance() view returns (address)'];

// RebalanceProxy.sol:106 — the proxy's own full-range test (both bounds)
export const FULL_RANGE_LOWER = -886800;
export const FULL_RANGE_UPPER = 886800;
