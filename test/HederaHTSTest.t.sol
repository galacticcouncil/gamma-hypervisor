// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.7.6;
pragma abicoder v2;

import { Test, console } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../contracts/interfaces/hedera/IHederaUniswapV3Pool.sol";

contract HederaHTSTest is Test {

    IHederaUniswapV3Pool public pool;
    IERC20 public token0;
    IERC20 public token1;

    address constant USDC_WHBAR_POOL = 0xC5B707348dA504E9Be1bD4E21525459830e7B11d;
    address constant USDC_HOLDER = 0x0000000000000000000000000000000000000476;
    address constant WHBAR_HOLDER = 0x0000000000000000000000000000000000058937;

    function setUp() public {
        vm.createSelectFork("https://lb.routeme.sh/rpc/295/fa34006f-19c4-4a5d-beb1-161d64cb346a");

        pool = IHederaUniswapV3Pool(USDC_WHBAR_POOL);
        token0 = IERC20(pool.token0());
        token1 = IERC20(pool.token1());

        console.log("Token0:", address(token0));
        console.log("Token1:", address(token1));
    }

    function test_balanceOfPool() public view {
        console.log("\n=== Test: balanceOf on Pool ===");
        uint256 bal0 = token0.balanceOf(USDC_WHBAR_POOL);
        uint256 bal1 = token1.balanceOf(USDC_WHBAR_POOL);
        console.log("Pool token0 balance:", bal0);
        console.log("Pool token1 balance:", bal1);
    }

    function test_balanceOfHolders() public view {
        console.log("\n=== Test: balanceOf on Holders ===");
        uint256 usdcBal = token0.balanceOf(USDC_HOLDER);
        console.log("USDC holder balance:", usdcBal);
        uint256 whbarBal = token1.balanceOf(WHBAR_HOLDER);
        console.log("WHBAR holder balance:", whbarBal);
    }

    function test_transferFromHolder() public {
        console.log("\n=== Test: Transfer from Holder ===");

        address recipient = makeAddr("recipient");

        // Try to transfer USDC
        uint256 balBefore = token0.balanceOf(USDC_HOLDER);
        console.log("USDC holder balance before:", balBefore);

        vm.prank(USDC_HOLDER);
        token0.transfer(recipient, 100e6); // 100 USDC

        uint256 balAfter = token0.balanceOf(USDC_HOLDER);
        uint256 recipientBal = token0.balanceOf(recipient);
        console.log("USDC holder balance after:", balAfter);
        console.log("Recipient balance:", recipientBal);
    }

    function test_approve() public {
        console.log("\n=== Test: Approve ===");

        address spender = makeAddr("spender");

        vm.prank(USDC_HOLDER);
        token0.approve(spender, 1000e6);

        uint256 allowance = token0.allowance(USDC_HOLDER, spender);
        console.log("Allowance:", allowance);
    }
}
