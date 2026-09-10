export const HYPERVISOR_ABI = [
  'function owner() view returns (address)',
  'function pool() view returns (address)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function tickSpacing() view returns (int24)',
  'function baseLower() view returns (int24)',
  'function baseUpper() view returns (int24)',
  'function limitLower() view returns (int24)',
  'function limitUpper() view returns (int24)',
  'function currentTick() view returns (int24)',
  'function getTotalAmounts() view returns (uint256 total0, uint256 total1)',
  'function getBasePosition() view returns (uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function getLimitPosition() view returns (uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function rebalance(int24 _baseLower, int24 _baseUpper, int24 _limitLower, int24 _limitUpper, address _feeRecipient, uint256[4] inMin, uint256[4] outMin)',
  'event Rebalance(int24 tick, uint256 totalAmount0, uint256 totalAmount1, uint256 feeAmount0, uint256 feeAmount1, uint256 totalSupply)',
];

export const POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function tickSpacing() view returns (int24)',
  'function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128)',
  'function observations(uint256 index) view returns (uint32 blockTimestamp, int56 tickCumulative, uint160 secondsPerLiquidityCumulativeX128, bool initialized)',
];

export const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function balanceOf(address) view returns (uint256)',
];

// Model B entrypoint: RebalanceProxy -> Admin -> Hypervisor, with on-chain
// minInterval / maxTranslation / maxWidth caps bounding the keeper key.
export const REBALANCE_PROXY_ABI = [
  'function rebalance(address hypervisor, int24 _baseLower, int24 _baseUpper, int24 _limitLower, int24 _limitUpper, address _feeRecipient, uint256[4] inMin, uint256[4] outMin)',
  'function rebalancers(address) view returns (address)',
  'function admins(address) view returns (address)',
  'function lastRebalance(address) view returns (uint256)',
  'function maxTranslation() view returns (uint256)',
  'function maxWidth() view returns (uint256)',
  'function minInterval() view returns (uint256)',
  'function customDiff(address) view returns (uint256)',
  'function customWidth(address) view returns (uint256)',
  'function customInterval(address) view returns (uint256)',
  'function exempted(address) view returns (bool)',
];

// Hydration price feeds are Chainlink AggregatorV3, NOT DIA getValue(string).
// DIA supplies the data; the chain serves it through this interface — the same
// feeds the Aave market reads. Every mainnet feed reverts on getValue() and
// answers latestRoundData() (verified 2026-08-21), and there is ONE CONTRACT PER
// PAIR, so a feed is selected by address rather than by a key string.
export const AGGREGATOR_V3_ABI = [
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
  'function description() view returns (string)',
];
