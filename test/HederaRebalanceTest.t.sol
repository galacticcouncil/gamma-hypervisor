// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.7.6;
pragma abicoder v2;

import { Test, console } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Hypervisor } from "../contracts/Hypervisor.sol";
import { Admin } from "../contracts/proxy/admin.sol";
import "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3SwapCallback.sol";
import "../contracts/interfaces/hedera/IHederaUniswapV3Pool.sol";
import "../contracts/interfaces/hedera/IHederaUniswapV3Factory.sol";

contract HederaRebalanceTest is Test, IUniswapV3SwapCallback {

    Hypervisor public hypervisor;
    Admin public admin;
    IHederaUniswapV3Pool public pool;

    // Hedera USDC-WHBAR pool
    address constant USDC_WHBAR_POOL = 0xC5B707348dA504E9Be1bD4E21525459830e7B11d;

    // Hedera tokens (will be fetched from pool)
    IERC20 public token0;
    IERC20 public token1;

    address owner;

    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata
    ) external override {
        if (amount0Delta > 0) {
            IERC20(IHederaUniswapV3Pool(msg.sender).token0()).transfer(msg.sender, uint256(amount0Delta));
        } else if (amount1Delta > 0) {
            IERC20(IHederaUniswapV3Pool(msg.sender).token1()).transfer(msg.sender, uint256(amount1Delta));
        }
    }

    function setUp() public {
        owner = makeAddr("owner");

        // Fork Hedera mainnet at latest block
        vm.createSelectFork("https://lb.routeme.sh/rpc/295/fa34006f-19c4-4a5d-beb1-161d64cb346a");

        pool = IHederaUniswapV3Pool(USDC_WHBAR_POOL);
        token0 = IERC20(pool.token0());
        token1 = IERC20(pool.token1());
    }

    function test_poolInfo() public view {
        console.log("=== Pool Info ===");
        console.log("Pool address:", USDC_WHBAR_POOL);
        console.log("Token0:", address(token0));
        console.log("Token1:", address(token1));
        console.log("Fee:", uint256(pool.fee()));

        (uint160 sqrtPriceX96, int24 tick, , , , , ) = pool.slot0();
        console.log("Current tick:", tick);
        console.log("sqrtPriceX96:", uint256(sqrtPriceX96));
        console.log("Liquidity:", uint256(pool.liquidity()));

        address factory = pool.factory();
        console.log("Factory:", factory);
        uint256 mintFee = IHederaUniswapV3Factory(factory).mintFee();
        console.log("Mint fee (tinycents):", mintFee);
    }

    function test_hypervisorDeployment() public {
        vm.startPrank(owner);

        // Deploy hypervisor
        hypervisor = new Hypervisor(
            USDC_WHBAR_POOL,
            owner,
            "USDC-WHBAR",
            "USDC-WHBAR"
        );

        console.log("=== Hypervisor Deployment ===");
        console.log("Hypervisor address:", address(hypervisor));
        console.log("Pool:", address(hypervisor.pool()));
        console.log("Token0:", address(hypervisor.token0()));
        console.log("Token1:", address(hypervisor.token1()));
        console.log("Tick spacing:", hypervisor.tickSpacing());
        console.log("Owner:", hypervisor.owner());

        // Verify deployment
        assertEq(address(hypervisor.pool()), USDC_WHBAR_POOL);
        assertEq(hypervisor.owner(), owner);
        assertEq(hypervisor.tickSpacing(), pool.tickSpacing());

        vm.stopPrank();
    }

    function test_hypervisorCanReceiveHBAR() public {
        vm.startPrank(owner);

        hypervisor = new Hypervisor(
            USDC_WHBAR_POOL,
            owner,
            "USDC-WHBAR",
            "USDC-WHBAR"
        );

        vm.stopPrank();

        // Fund hypervisor with HBAR
        uint256 fundAmount = 10 ether;
        vm.deal(address(hypervisor), fundAmount);

        console.log("=== HBAR Funding ===");
        console.log("Hypervisor HBAR balance:", address(hypervisor).balance);

        assertEq(address(hypervisor).balance, fundAmount);
    }

    function test_factoryMintFee() public view {
        address factory = pool.factory();
        uint256 mintFee = IHederaUniswapV3Factory(factory).mintFee();

        console.log("=== Factory Mint Fee ===");
        console.log("Factory address:", factory);
        console.log("Mint fee (tinycents):", mintFee);

        // Should be 500000000 based on user info
        assertEq(mintFee, 500000000);
    }

    function test_adminDeployment() public {
        vm.startPrank(owner);

        admin = new Admin(owner);

        console.log("=== Admin Deployment ===");
        console.log("Admin address:", address(admin));
        console.log("Admin admin:", admin.admin());

        assertEq(admin.admin(), owner);

        vm.stopPrank();
    }

    // NOTE: Tests below require HTS tokens which can't be dealt with Foundry's deal()
    // To properly test deposits and rebalances, you would need to:
    // 1. Use an account that already has the tokens on Hedera
    // 2. Or acquire tokens via swap on the pool first
    // 3. Or run these tests on a local Hedera network with test tokens

    // Skipping deposit/rebalance tests as they require HTS tokens
    // function test_deployAndDeposit() - requires tokens
    // function test_rebalance() - requires tokens
    // function test_multipleRebalances() - requires tokens
}
