// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.7.6;

// Moves the price of a v3 pool onto a target with one swap whose price limit is the target. Across empty
// ticks nothing trades, so the price moves for free; liquidity on the way is paid by the caller, up to a cap.

import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3SwapCallback.sol";

contract PoolAnchor is IUniswapV3SwapCallback {
    using SafeMath for uint256;
    using SafeERC20 for IERC20;

    // the swap in flight: only this pool may collect, and only from this caller
    address private activePool;
    address private activePayer;

    /// @notice Swap `pool` to `target`, selling up to `max0` of token0 (price falls) or `max1` of token1 (price rises),
    /// paid by the caller. Reverts if the cap runs out first, so the pool reaches the target or does not move.
    function anchor(IUniswapV3Pool pool, uint160 target, uint256 max0, uint256 max1)
        external
        returns (int256 amount0, int256 amount1)
    {
        (uint160 current, , , , , , ) = pool.slot0();
        if (current == target) return (0, 0);
        bool zeroForOne = target < current;
        uint256 cap = zeroForOne ? max0 : max1;
        require(cap > 0 && cap <= uint256(type(int256).max), "cap");

        activePool = address(pool);
        activePayer = msg.sender;
        (amount0, amount1) = pool.swap(msg.sender, zeroForOne, int256(cap), target, "");
        activePool = address(0);
        activePayer = address(0);

        (uint160 reached, , , , , , ) = pool.slot0();
        require(reached == target, "target not reached");
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external override {
        require(msg.sender == activePool && msg.sender != address(0), "not the pool");
        if (amount0Delta > 0) _pay(IUniswapV3Pool(msg.sender).token0(), uint256(amount0Delta));
        if (amount1Delta > 0) _pay(IUniswapV3Pool(msg.sender).token1(), uint256(amount1Delta));
    }

    // an aToken transfer can credit one wei short at the current index, so top up until the pool holds what it is owed
    function _pay(address token, uint256 owed) private {
        uint256 want = IERC20(token).balanceOf(msg.sender).add(owed);
        uint256 send = owed;
        for (uint256 i = 0; i < 3; i++) {
            IERC20(token).safeTransferFrom(activePayer, msg.sender, send);
            uint256 has = IERC20(token).balanceOf(msg.sender);
            if (has >= want) return;
            send = want - has;
        }
        revert("underpaid");
    }
}
