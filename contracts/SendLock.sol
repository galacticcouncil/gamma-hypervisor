// SPDX-License-Identifier: Unlicense

pragma solidity 0.7.6;
pragma abicoder v2;

import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

import "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";

contract SendLock {
    using SafeERC20 for IERC20;
    using SafeMath for uint256;

    address public owner;
    address public recipient;

    event Send(address token, address recipient, uint256 amount);

    constructor(
        address _owner,
        address _recipient
    ) {
        owner = _owner;
        recipient = _recipient;
    }

    function changeRecipient(address _recipient) external onlyOwner {
        recipient = _recipient;
    }

    function sendToken(address token, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(recipient, amount);
        emit Send(token, recipient, amount);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        owner = newOwner;
    }

    modifier onlyOwner {
        require(msg.sender == owner, "only owner");
        _;
    }
}
