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
  'function totalSupply() view returns (uint256)',
  'function getTotalAmounts() view returns (uint256 total0, uint256 total1)',
  'function getBasePosition() view returns (uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function getLimitPosition() view returns (uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function rebalance(int24 _baseLower, int24 _baseUpper, int24 _limitLower, int24 _limitUpper, address _feeRecipient, uint256[4] inMin, uint256[4] outMin)',
  'event Rebalance(int24 tick, uint256 totalAmount0, uint256 totalAmount1, uint256 feeAmount0, uint256 feeAmount1, uint256 totalSupply)',
];

export const POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function tickSpacing() view returns (int24)',
  'function fee() view returns (uint24)',
  'function factory() view returns (address)',
  'function liquidity() view returns (uint128)',
  'function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128)',
  'function observations(uint256 index) view returns (uint32 blockTimestamp, int56 tickCumulative, uint160 secondsPerLiquidityCumulativeX128, bool initialized)',
  // Fee accounting: uncollected fees live here, not in the vault's balance.
  'function feeGrowthGlobal0X128() view returns (uint256)',
  'function feeGrowthGlobal1X128() view returns (uint256)',
  'function ticks(int24) view returns (uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128, int56 tickCumulativeOutside, uint160 secondsPerLiquidityOutsideX128, uint32 secondsOutside, bool initialized)',
  'function positions(bytes32) view returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
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

// The money market's price oracle, keyed by reserve asset (an aToken's
// UNDERLYING_ASSET_ADDRESS()), answering in BASE_CURRENCY_UNIT (USD, 1e8).
export const AAVE_ORACLE_ABI = [
  'function getAssetPrice(address asset) view returns (uint256)',
  'function getSourceOfAsset(address asset) view returns (address)',
  'function BASE_CURRENCY_UNIT() view returns (uint256)',
];

// A source behind the MM oracle: a plain feed (DOT/USD) or a USDOracleAdapter
// (GETH, GSOL) = assetToX (EMA precompile) × XToUsd (DIA feed). The adapter
// reverts on latestRoundData() and its latestTimestamp() is the current block,
// so age is read from its XToUsdOracle() leg instead.
export const MM_SOURCE_ABI = [
  ...AGGREGATOR_V3_ABI,
  'function XToUsdOracle() view returns (address)',
];

export const ATOKEN_ABI = [
  'function UNDERLYING_ASSET_ADDRESS() view returns (address)',
  'function POOL() view returns (address)',
];

export const AAVE_POOL_SUPPLY_ABI = [
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
];

export const ERC20_SPEND_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

// SwapRouter02 (IV3SwapRouter): no deadline field, unlike the v1 SwapRouter
export const SWAP_ROUTER02_ABI = [
  'function factory() view returns (address)',
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
];

export const QUOTER_V2_ABI = [
  'function factory() view returns (address)',
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
];

// NonfungiblePositionManager: the re-anchor's dust bridge across an empty gap
export const POSITION_MANAGER_ABI = [
  'function factory() view returns (address)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) payable returns (uint256 amount0, uint256 amount1)',
  'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) payable returns (uint256 amount0, uint256 amount1)',
  'function burn(uint256 tokenId) payable',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
];
