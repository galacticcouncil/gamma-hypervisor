/// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.7.6;
pragma abicoder v2;

import "./interfaces/IHypervisor.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";

interface IWETH {
  function deposit() external payable;
  function transfer(address to, uint value) external returns (bool);
  function withdraw(uint) external;
}

interface IClearing {

  function clearDeposit(
      uint256 deposit0,
      uint256 deposit1,
      address from,
      address to,
      address pos
  ) external view returns (bool cleared, uint256 actualDeposit0, uint256 actualDeposit1);

	function clearShares(
    address pos
  ) external view returns (bool cleared);

  function getDepositAmount(
    address pos,
    address token,
    uint256 _deposit
  ) external view returns (uint256 amountStart, uint256 amountEnd);
}


/// @title UniProxy v2.1
/// @notice Proxy contract for hypervisor positions management with ETH support
contract UniProxyETH is ReentrancyGuard {
  using SafeERC20 for IERC20;
  using SafeMath for uint256;
	IClearing public clearance;
  address public owner;
  address public constant WETH = 0x4200000000000000000000000000000000000006;
  bool public paused;

  receive() external payable {
    assert(msg.sender == WETH);
  }


  constructor(address _clearance, address _owner) {
    owner = _owner;
		clearance = IClearing(_clearance);	
  }

  /// @notice Deposit into the given position
  /// @param deposit0 Amount of token0 to deposit
  /// @param deposit1 Amount of token1 to deposit
  /// @param to Address to receive liquidity tokens
  /// @param pos Hypervisor Address
  /// @param minIn min assets to expect in position during a direct deposit 
  /// @param maxSlippage Maximum allowed slippage as percentage with 2 decimals (e.g. 100 = 1%)
  /// @return shares Amount of liquidity tokens received
  function deposit(
    uint256 deposit0,
    uint256 deposit1,
    address to,
    address pos,
    uint256[4] memory minIn,
    uint256 maxSlippage
  ) nonReentrant notPaused external returns (uint256 shares) {
    require(to != address(0), "to should be non-zero");
    require(maxSlippage <= 10000, "slippage too high"); // Max 100%

    IHypervisor(pos).zeroBurn();
		(bool cleared, uint256 actualDeposit0, uint256 actualDeposit1) = clearance.clearDeposit(deposit0, deposit1, msg.sender, to, pos);
    require(cleared, "deposit not cleared");

    // Check slippage for deposit0
    if (deposit0 > 0) {
        uint256 minDeposit0 = deposit0.mul(uint256(10000).sub(maxSlippage)).div(10000);
        uint256 maxDeposit0 = deposit0.mul(uint256(10000).add(maxSlippage)).div(10000);
        require(actualDeposit0 >= minDeposit0, "deposit0 below max slippage");
        require(actualDeposit0 <= maxDeposit0, "deposit0 above max slippage");
    }

    // Check slippage for deposit1
    if (deposit1 > 0) {
        uint256 minDeposit1 = deposit1.mul(uint256(10000).sub(maxSlippage)).div(10000);
        uint256 maxDeposit1 = deposit1.mul(uint256(10000).add(maxSlippage)).div(10000);
        require(actualDeposit1 >= minDeposit1, "deposit1 below max slippage");
        require(actualDeposit1 <= maxDeposit1, "deposit1 above max slippage");
    }

		/// transfer assets from msg.sender and mint lp tokens to provided address 
		shares = IHypervisor(pos).deposit(actualDeposit0, actualDeposit1, to, msg.sender, minIn);
		require(clearance.clearShares(pos), "shares not cleared");
  }


  /// @notice Deposit into the given position
  /// @param deposit0 Amount of token0 to deposit
  /// @param deposit1 Amount of token1 to deposit
  /// @param to Address to receive liquidity tokens
  /// @param pos Hypervisor Address
  /// @param minIn min assets to expect in position during a direct deposit 
  /// @param maxSlippage Maximum allowed slippage as percentage with 2 decimals (e.g. 100 = 1%)
  /// @return shares Amount of liquidity tokens received
  function depositETH(
      uint256 deposit0,
      uint256 deposit1,
      address to,
      address pos,
      uint256[4] memory minIn,
      uint256 maxSlippage
  ) external payable nonReentrant notPaused returns (uint256 shares) {
      require(to != address(0), "to should be non-zero");
      require(maxSlippage <= 10000, "slippage too high"); // Max 100%

      IHypervisor(pos).zeroBurn();
      (bool cleared, uint256 actualDeposit0, uint256 actualDeposit1) = clearance.clearDeposit(deposit0, deposit1, msg.sender, to, pos);
      require(cleared, "deposit not cleared");

      // Check slippage for deposit0
      if (deposit0 > 0) {
          uint256 minDeposit0 = deposit0.mul(uint256(10000).sub(maxSlippage)).div(10000);
          uint256 maxDeposit0 = deposit0.mul(uint256(10000).add(maxSlippage)).div(10000);
          require(actualDeposit0 >= minDeposit0, "deposit0 below max slippage");
          require(actualDeposit0 <= maxDeposit0, "deposit0 above max slippage");
      }

      // Check slippage for deposit1
      if (deposit1 > 0) {
          uint256 minDeposit1 = deposit1.mul(uint256(10000).sub(maxSlippage)).div(10000);
          uint256 maxDeposit1 = deposit1.mul(uint256(10000).add(maxSlippage)).div(10000);
          require(actualDeposit1 >= minDeposit1, "deposit1 below max slippage");
          require(actualDeposit1 <= maxDeposit1, "deposit1 above max slippage");
      }

      IERC20 token0 = IHypervisor(pos).token0();
      IERC20 token1 = IHypervisor(pos).token1();
      
      if (msg.value > 0) {
          require(address(token0) == WETH || address(token1) == WETH, "non ETH deposit");
          uint256 ethAmount = address(token0) == WETH ? actualDeposit0 : actualDeposit1;
          
          // Wrap ETH
          IWETH(WETH).deposit{value: ethAmount}();
          
          // Transfer the non-WETH token directly to UniProxy
          if (address(token0) == WETH) {
              if (actualDeposit1 > 0) IERC20(token1).safeTransferFrom(msg.sender, address(this), actualDeposit1);
          } else {
              if (actualDeposit0 > 0) IERC20(token0).safeTransferFrom(msg.sender, address(this), actualDeposit0);
          }
          token0.safeApprove(pos, 0);
          token0.safeApprove(pos, actualDeposit0);
          token1.safeApprove(pos, 0);
          token1.safeApprove(pos, actualDeposit1);
          shares = IHypervisor(pos).deposit(actualDeposit0, actualDeposit1, to, address(this), minIn);
      } else {
          shares = IHypervisor(pos).deposit(actualDeposit0, actualDeposit1, to, msg.sender, minIn);
      }
      require(clearance.clearShares(pos), "shares not cleared");

      // refund unused token
      uint256 token0Balance = token0.balanceOf(address(this));
      if (token0Balance > 0) address(token0) == WETH ? IWETH(WETH).withdraw(token0Balance) : token0.safeTransfer(msg.sender, token0Balance);

      uint256 token1Balance = token1.balanceOf(address(this));
      if (token1Balance > 0) address(token1) == WETH ? IWETH(WETH).withdraw(token1Balance) : token1.safeTransfer(msg.sender, token1Balance);

      // Refund any remaining ETH
      if (address(this).balance > 0) safeTransferETH(msg.sender, address(this).balance);
  }


  /// @notice Gets deposit amount ranges for frontend deposit calculations to minimize dust. amountStart and amountEnd should be equal. Kept the same interface to remain consistent with prior version of UniProxy.
  /// @param pos Hypervisor Address
  /// @param token Address of token to deposit
  /// @param _deposit Amount of token to deposit
  /// @return amountStart Minimum amounts of the pair token to deposit
  /// @return amountEnd Maximum amounts of the pair token to deposit
  function getDepositAmount(
    address pos,
    address token,
    uint256 _deposit
  ) public view returns (uint256 amountStart, uint256 amountEnd) {
		return clearance.getDepositAmount(pos, token, _deposit);
	}

	function transferClearance(address newClearance) external onlyOwner {
    require(newClearance != address(0), "newClearance should be non-zero");
		clearance = IClearing(newClearance);
	}

  function transferOwnership(address newOwner) external onlyOwner {
    require(newOwner != address(0), "newOwner should be non-zero");
    owner = newOwner;
  }

  function pause(bool _paused) external onlyOwner {
    require(_paused != paused, "already in paused/unpaused condition");
    paused = _paused;
  }

  modifier onlyOwner {
    require(msg.sender == owner, "only owner");
    _;
  }

  modifier notPaused() {
    require(!paused, "paused");
    _;
  }

  function rescueERC20(address token, uint256 amount) external onlyOwner {
    IERC20(token).safeTransfer(owner, amount);
  }

  function safeTransferETH(address to, uint256 value) internal {
      (bool success,) = to.call{value: value}("");
      require(success, "ETH transfer failed");
  }
}