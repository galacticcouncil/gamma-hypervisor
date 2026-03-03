// SPDX-License-Identifier: Unlicense

pragma solidity 0.7.6;
pragma abicoder v2;

import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

import "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";

contract FeeRecipient {
    using SafeERC20 for IERC20;
    using SafeMath for uint256;

    address public owner;
    address public feeManager;
    address public recipient1;
    address public recipient2;


    event Send(address token, address recipient, uint256 amount);

    constructor(
        address _owner,
        address _feeManager,
        address _recipient1,
        address _recipient2
    ) {
        owner = _owner;
        feeManager = _feeManager;
        recipient1 = _recipient1;
        recipient2 = _recipient2;
    }

    function changeRecipient1(address _recipient) external onlyOwner {
        recipient1 = _recipient;
    }

    function changeRecipient2(address _recipient) external onlyOwner {
        recipient2 = _recipient;
    }

    function sendToken(address token, uint256 amount1, uint256 amount2) external onlyFeeManager() {
        IERC20(token).safeTransfer(recipient1, amount1);
        emit Send(token, recipient1, amount1);
        IERC20(token).safeTransfer(recipient2, amount2);
        emit Send(token, recipient2, amount2);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        owner = newOwner;
    }

    function transferFeeManager(address newFeeManager) external onlyOwner {
        feeManager = newFeeManager;
    }

    modifier onlyOwner {
        require(msg.sender == owner, "only owner");
        _;
    }
    modifier onlyFeeManager {
        require(msg.sender == feeManager, "only fee manager");
        _;
    }
}
