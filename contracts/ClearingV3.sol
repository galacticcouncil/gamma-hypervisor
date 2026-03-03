/// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.7.6;
pragma abicoder v2;

import "./interfaces/IHypervisor.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@uniswap/v3-core/contracts/libraries/FullMath.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/math/SignedSafeMath.sol";

/// @title Clearing v3
/// @notice Proxy contract for hypervisor positions management
contract ClearingV3 is ReentrancyGuard {
  using SafeERC20 for IERC20;
  using SafeMath for uint256;
  using SignedSafeMath for int256;
  using SignedSafeMath for int56;

  string constant VERSION = '3.0.0';
  address public owner;
  bool public paused;
  mapping(address => Position) public positions;
  bool public twapCheck = true;
  uint32 public twapInterval = 3600;
  uint256 public priceThreshold = 10_100;
  uint256 constant MAX_UINT = type(uint256).max;
  uint256 public constant PRECISION = 1e36;
  uint256 internal constant Q128 = 1 << 128;
  mapping (address => mapping (address => bool)) public freeDepositList;

  struct Position {
      uint8 version;
      bool twapOverride; 
      uint32 twapInterval; // override global twap
      uint256 priceThreshold; // custom price threshold
  }



  event PositionAdded(address, uint8);
  event ListAppended(address pos, address[] listed);
  event ListRemoved(address pos, address listed);
  event PriceThresholdSet(uint256 _priceThreshold);
  event TwapIntervalSet(uint32 _twapInterval);
  event TwapOverrideSet(address pos, bool twapOverride, uint32 _twapInterval, uint256 _priceThreshold);
  event TwapCheckSet(bool twapCheck);


    constructor(address _owner) {
    owner = _owner;
    }

  modifier onlyAddedPosition(address pos) {
    Position storage p = positions[pos];
    require(p.version != 0, "not added");
    _;
  }

  /// @notice Add the hypervisor position
  /// @param pos Address of the hypervisor
  /// @param version Type of hypervisor
  function addPosition(address pos, uint8 version) external onlyOwner {
    Position storage p = positions[pos];
    require(p.version == 0, 'already added');
    require(version > 0, 'version < 1');
    p.version = version;
    IHypervisor(pos).token0().safeApprove(pos, MAX_UINT);
    IHypervisor(pos).token1().safeApprove(pos, MAX_UINT);
    emit PositionAdded(pos, version);
  }

  /// @notice Validates and adjusts deposit amounts for two tokens to maintain the desired ratio
  /// @param deposit0 The amount of token0 to deposit
  /// @param deposit1 The amount of token1 to deposit
  /// @param from The address initiating the deposit
  /// @param to The address receiving the deposit
  /// @param pos The hypervisor position address
  /// @return cleared Boolean indicating if the deposit validation was successful
  /// @return actualDeposit0 The adjusted amount of token0 to deposit
  /// @return actualDeposit1 The adjusted amount of token1 to deposit
  function clearDeposit(
      uint256 deposit0,
      uint256 deposit1,
      address from,
      address to,
      address pos
  ) public view onlyAddedPosition(pos) returns (bool cleared, uint256 actualDeposit0, uint256 actualDeposit1) {
      require(!paused, "paused");
      require(to != address(0), "to should be non-zero");
      require(
        IHypervisor(pos).currentTick() >= IHypervisor(pos).baseLower() &&
        IHypervisor(pos).currentTick() < IHypervisor(pos).baseUpper(),
        "price out of base range"
      );
      Position storage p = positions[pos];
      if (twapCheck || p.twapOverride) {
        /// check twap
        checkPriceChange(
          pos,
          (p.twapOverride ? p.twapInterval : twapInterval),
          (p.twapOverride ? p.priceThreshold : priceThreshold)
        );
      }
      // If address is in freeDepositList, allow any ratio deposit
      if (freeDepositList[pos][from]) {
          cleared = true;
          actualDeposit0 = deposit0;
          actualDeposit1 = deposit1;
          return (cleared, actualDeposit0, actualDeposit1);
      }

      (uint256 total0, uint256 total1) = getTotalAmountsPlusFees(pos);
      
      // Require both tokens to have value to determine ratio
      require(total0 > 0 && total1 > 0, "cannot determine ratio");

      // Calculate ratios 
      uint256 expectedToken1 = FullMath.mulDiv(deposit0, total1, total0);
      uint256 expectedToken0 = FullMath.mulDiv(deposit1, total0, total1);
      
      // Use the smaller of the two ratios
      if (expectedToken1 <= deposit1) {
          // token0 is the limiting factor
          actualDeposit0 = deposit0;
          actualDeposit1 = expectedToken1;
      } else {
          // token1 is the limiting factor
          actualDeposit0 = expectedToken0;
          actualDeposit1 = deposit1;
      }

      cleared = true;
      return (cleared, actualDeposit0, actualDeposit1);
  }


  function getTotalAmountsPlusFees(address pos) public view returns (uint256 total0, uint256 total1) {
      (total0, total1) = IHypervisor(pos).getTotalAmounts();
      (uint256 baseFee0, uint256 baseFee1) = calculatePositionFee(IHypervisor(pos).pool(), IHypervisor(pos).baseLower(), IHypervisor(pos).baseUpper(), pos);
      (uint256 limitFee0, uint256 limitFee1) = calculatePositionFee(IHypervisor(pos).pool(), IHypervisor(pos).limitLower(), IHypervisor(pos).limitUpper(), pos);

      uint256 fees0 = baseFee0.add(limitFee0);
      uint256 fees1 = baseFee1.add(limitFee1);
      
      // Add fees to total amounts
      total0 = total0.add(fees0);
      total1 = total1.add(fees1);
  }


  function calculatePositionFee(
      IUniswapV3Pool pool,
      int24 bottomTick,
      int24 topTick,
      address pos
  ) public view returns (uint256 fee0, uint256 fee1) {
      bytes32 positionKey = keccak256(abi.encodePacked(pos, bottomTick, topTick));
      (uint256 liquidityBefore, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1) = pool.positions(positionKey);

      (uint256 feeGrowthInside0X128, uint256 feeGrowthInside1X128) = getFeeGrowthInside(pool, bottomTick, topTick);

      fee0 = uint256(tokensOwed0);
      fee1 = uint256(tokensOwed1);

      uint256 feeGrowthDelta0 = 0;
      uint256 feeGrowthDelta1 = 0;

      if (feeGrowthInside0X128 != feeGrowthInside0LastX128) {
          feeGrowthDelta0 = feeGrowthInside0X128 - feeGrowthInside0LastX128;
      }
      if (feeGrowthInside1X128 != feeGrowthInside1LastX128) {
          feeGrowthDelta1 = feeGrowthInside1X128 - feeGrowthInside1LastX128;
      }
      fee0 = fee0 + FullMath.mulDiv(feeGrowthDelta0, liquidityBefore, Q128);
      fee1 = fee1 + FullMath.mulDiv(feeGrowthDelta1, liquidityBefore, Q128);

      // Get the fee percentage from the hypervisor and reduce fees accordingly
      uint8 feePercentage = IHypervisor(pos).fee();
      fee0 = fee0 - fee0 / feePercentage;
      fee1 = fee1 - fee1 / feePercentage;

      return (fee0, fee1);
  }

  function getFeeGrowthInside(
      IUniswapV3Pool pool,
      int24 bottomTick,
      int24 topTick
  ) internal view returns (uint256 feeGrowthInside0X128, uint256 feeGrowthInside1X128) {
      (, int24 currentTick, , , , ,) = pool.slot0(); 
      
        (, , uint256 lowerFeeGrowthOutside0X128, uint256 lowerFeeGrowthOutside1X128, , , , ) = pool.ticks(bottomTick);
        (, , uint256 upperFeeGrowthOutside0X128, uint256 upperFeeGrowthOutside1X128, , , , ) = pool.ticks(topTick);
      
        if (currentTick < bottomTick) {
            feeGrowthInside0X128 = lowerFeeGrowthOutside0X128 - upperFeeGrowthOutside0X128;
            feeGrowthInside1X128 = lowerFeeGrowthOutside1X128 - upperFeeGrowthOutside1X128;
        } else if (currentTick < topTick) {
            uint256 feeGrowthGlobal0X128 = pool.feeGrowthGlobal0X128();
            uint256 feeGrowthGlobal1X128 = pool.feeGrowthGlobal1X128();
            feeGrowthInside0X128 = feeGrowthGlobal0X128 - lowerFeeGrowthOutside0X128 - upperFeeGrowthOutside0X128;
            feeGrowthInside1X128 = feeGrowthGlobal1X128 - lowerFeeGrowthOutside1X128 - upperFeeGrowthOutside1X128;
        } else {
            feeGrowthInside0X128 = upperFeeGrowthOutside0X128 - lowerFeeGrowthOutside0X128;
            feeGrowthInside1X128 = upperFeeGrowthOutside1X128 - lowerFeeGrowthOutside1X128;
        }
  }

  // Removed maxTotalSupply check from clearShares
  function clearShares(
      address pos
  ) public view onlyAddedPosition(pos) returns (bool cleared) {
      return true;
  }
  
  /// @notice Gets deposit amount ranges for frontend deposit calculations to minimize dust. amountStart and amountEnd should be equal. Kept the same interface to remain consistent with prior version of Clearing.
  /// @dev Calculates the corresponding token amount needed to maintain pool ratio based on initial deposit.
  /// @param pos The hypervisor position address
  /// @param token The token address being deposited
  /// @param _deposit The initial deposit amount
  /// @return amountStart The minimum amount of the other token needed
  /// @return amountEnd The maximum amount of the other token needed
  function getDepositAmount(
      address pos,
      address token,
      uint256 _deposit
  ) public view returns (uint256 amountStart, uint256 amountEnd) {
      require(token == address(IHypervisor(pos).token0()) || token == address(IHypervisor(pos).token1()), "token mismatch");
      require(_deposit > 0, "deposits can't be zero");
      
      (uint256 total0, uint256 total1) = getTotalAmountsPlusFees(pos);
      
      if (total0 == 0 || total1 == 0) {
          amountStart = 0;
          amountEnd = 0;
      } else {
          if (token == address(IHypervisor(pos).token0())) {
              // If depositing token0, calculate required token1 to maintain ratio
              amountStart = FullMath.mulDiv(_deposit, total1, total0);
              amountEnd = amountStart;
          } else {
              // If depositing token1, calculate required token0 to maintain ratio
              amountStart = FullMath.mulDiv(_deposit, total0, total1);
              amountEnd = amountStart;
          }
      }
  }

  /// @notice Check if the price change overflows or not based on given twap and threshold in the hypervisor
  /// @param pos Hypervisor Address
  /// @param _twapInterval Time intervals
  /// @param _priceThreshold Price Threshold
  /// @return price Current price
  function checkPriceChange(
    address pos,
    uint32 _twapInterval,
    uint256 _priceThreshold
  ) public view returns (uint256 price) {

    (uint160 sqrtPrice, , , , , , ) = IHypervisor(pos).pool().slot0();
    price = FullMath.mulDiv(uint256(sqrtPrice).mul(uint256(sqrtPrice)), PRECISION, 2**(96 * 2));

    uint160 sqrtPriceBefore = getSqrtTwapX96(pos, _twapInterval);
    uint256 priceBefore = FullMath.mulDiv(uint256(sqrtPriceBefore).mul(uint256(sqrtPriceBefore)), PRECISION, 2**(96 * 2));
    if (price.mul(10_000).div(priceBefore) > _priceThreshold || priceBefore.mul(10_000).div(price) > _priceThreshold)
      revert("Price change overflow");
  }

  /// @notice Get the sqrt price before the given interval
  /// @param pos Hypervisor Address
  /// @param _twapInterval Time intervals
  /// @return sqrtPriceX96 Sqrt price before interval
  function getSqrtTwapX96(address pos, uint32 _twapInterval) public view returns (uint160 sqrtPriceX96) {
    if (_twapInterval == 0) {
      /// return the current price if _twapInterval == 0
    (sqrtPriceX96, , , , , , ) = IHypervisor(pos).pool().slot0();
    } 
    else {
      uint32[] memory secondsAgos = new uint32[](2);
      secondsAgos[0] = _twapInterval; /// from (before)
      secondsAgos[1] = 0; /// to (now)

      (int56[] memory tickCumulatives, ) = IHypervisor(pos).pool().observe(secondsAgos);

      /// tick(imprecise as it's an integer) to price
      sqrtPriceX96 = TickMath.getSqrtRatioAtTick(
        int24((tickCumulatives[1] - tickCumulatives[0]) / _twapInterval)
      );
    }
  }

  /// @param _priceThreshold Price Threshold
  function setPriceThreshold(uint256 _priceThreshold) external onlyOwner {
    priceThreshold = _priceThreshold;
    emit PriceThresholdSet(_priceThreshold);
  }

  /// @param _twapInterval Time intervals
  function setTwapInterval(uint32 _twapInterval) external onlyOwner {
    twapInterval = _twapInterval;
    emit TwapIntervalSet(_twapInterval);
  }

  /// @param pos Hypervisor Address
  /// @param twapOverride Twap Override
  /// @param _twapInterval Time Intervals
  /// @param _priceThreshold Price Threshold
  function setTwapOverride(address pos, bool twapOverride, uint32 _twapInterval, uint256 _priceThreshold) external onlyOwner onlyAddedPosition(pos) {
    Position storage p = positions[pos];
    p.twapOverride = twapOverride;
    p.twapInterval = _twapInterval;
    p.priceThreshold = _priceThreshold;
    emit TwapOverrideSet(pos, twapOverride, _twapInterval, _priceThreshold);
  }

  /// @notice Set Twap
  function setTwapCheck(bool _twapCheck) external onlyOwner {
    twapCheck = _twapCheck;
    emit TwapCheckSet(_twapCheck);
  }
  

  // @notice check if an address is whitelisted for hype
  function getListed(address pos, address i) public view returns(bool) {
    return freeDepositList[pos][i];
  }

  function getPositionInfo(address pos) public view returns (Position memory) {
    return positions[pos];
  }

  /// @notice Append whitelist to hypervisor
  /// @param pos Hypervisor Address
  /// @param listed Address array to add in whitelist
  function appendList(address pos, address[] memory listed) external onlyOwner onlyAddedPosition(pos) {
    require(listed.length <= type(uint8).max, "List too long");
    for (uint8 i; i < listed.length; i++) {
        freeDepositList[pos][listed[i]] = true;
    }
    emit ListAppended(pos, listed);
  }
  /// @notice Remove address from whitelist
  /// @param pos Hypervisor Address
  /// @param listed Address to remove from whitelist
  function removeListed(address pos, address listed) external onlyOwner onlyAddedPosition(pos) {
    freeDepositList[pos][listed] = false;
    emit ListRemoved(pos, listed);
  }

  function pause(bool _paused) external onlyOwner {
    paused = _paused;
  }

  function transferOwnership(address newOwner) external onlyOwner {
    require(newOwner != address(0), "newOwner should be non-zero");
    owner = newOwner;
  }

  modifier onlyOwner {
    require(msg.sender == owner, "only owner");
    _;
  }
}