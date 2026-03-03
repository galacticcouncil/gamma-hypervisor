// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.7.6;
pragma abicoder v2;

import { Test, console } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Hypervisor } from "../contracts/Hypervisor.sol";
import { Admin } from "../contracts/proxy/admin.sol";
import { ClearingV3 } from "../contracts/ClearingV3.sol";
import { UniProxyETH } from "../contracts/UniProxyETH.sol";
import { HypeRegistry } from "../contracts/HypeRegistry.sol";
import { RebalanceProxy } from "../contracts/RebalanceProxy.sol";
import "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3SwapCallback.sol";
import "../contracts/interfaces/hedera/IHederaUniswapV3Pool.sol";
import "../contracts/interfaces/hedera/IHederaUniswapV3Factory.sol";

contract HederaFullFlowTest is Test, IUniswapV3SwapCallback {

    // Infrastructure
    ClearingV3 public clearingV3;
    UniProxyETH public uniProxyETH;
    Admin public admin;
    HypeRegistry public hypeRegistry;
    RebalanceProxy public rebalanceProxy;
    Hypervisor public hypervisor;
    IHederaUniswapV3Pool public pool;

    // Hedera USDC-WHBAR pool
    address constant USDC_WHBAR_POOL = 0xC5B707348dA504E9Be1bD4E21525459830e7B11d;

    // Addresses with tokens on Hedera mainnet
    address constant USDC_HOLDER = 0x0000000000000000000000000000000000000476;  // Has 9000 USDC (6 decimals)
    address constant WHBAR_HOLDER = 0x0000000000000000000000000000000000058937; // Has 10000 WHBAR (8 decimals)

    // Tokens
    IERC20 public token0; // USDC
    IERC20 public token1; // WHBAR

    // Actors
    address owner;
    address rebalancer;
    address user;

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
        rebalancer = makeAddr("rebalancer");
        user = makeAddr("user");

        // Fork Hedera mainnet at latest block
        vm.createSelectFork("https://lb.routeme.sh/rpc/295/fa34006f-19c4-4a5d-beb1-161d64cb346a");

        pool = IHederaUniswapV3Pool(USDC_WHBAR_POOL);
        token0 = IERC20(pool.token0());
        token1 = IERC20(pool.token1());

        console.log("=== Pool Info ===");
        console.log("Token0 (USDC):", address(token0));
        console.log("Token1 (WHBAR):", address(token1));

        vm.startPrank(owner);

        // ========== DEPLOY INFRASTRUCTURE ==========
        console.log("\n=== Deploying Infrastructure ===");

        // Deploy ClearingV3
        clearingV3 = new ClearingV3(owner);
        console.log("ClearingV3:", address(clearingV3));

        // Deploy UniProxyETH
        uniProxyETH = new UniProxyETH(address(clearingV3), owner);
        console.log("UniProxyETH:", address(uniProxyETH));

        // Deploy Admin
        admin = new Admin(owner);
        console.log("Admin:", address(admin));

        // Deploy HypeRegistry
        hypeRegistry = new HypeRegistry();
        console.log("HypeRegistry:", address(hypeRegistry));

        // Deploy RebalanceProxy
        rebalanceProxy = new RebalanceProxy(owner);
        console.log("RebalanceProxy:", address(rebalanceProxy));

        // ========== DEPLOY HYPERVISOR ==========
        console.log("\n=== Deploying Hypervisor ===");

        hypervisor = new Hypervisor(
            USDC_WHBAR_POOL,
            owner,
            "USDC-WHBAR Hypervisor",
            "ssUSDC-WHBAR"
        );
        console.log("Hypervisor:", address(hypervisor));

        // Add to registry
        console.log("Adding to registry...");
        hypeRegistry.add(address(hypervisor));
        console.log("Added to registry");

        // Fund hypervisor with HBAR for mint fees
        vm.deal(owner, 100 ether);
        (bool sent,) = payable(address(hypervisor)).call{value: 10 ether}("");
        require(sent, "Failed to fund hypervisor");
        console.log("Hypervisor HBAR balance:", address(hypervisor).balance);

        // NOTE: addPosition calls safeApprove on HTS tokens which doesn't work via fork
        // clearingV3.addPosition(address(hypervisor), uint8(3));
        console.log("Skipping ClearingV3.addPosition (requires HTS token ops)");

        // Setup Admin rebalancer
        console.log("Setting up Admin rebalancer...");
        admin.setRebalancer(address(hypervisor), address(rebalanceProxy));
        console.log("Admin rebalancer set");

        // Setup RebalanceProxy
        console.log("Setting up RebalanceProxy...");
        rebalanceProxy.setAdmin(address(hypervisor), address(admin));
        rebalanceProxy.setRebalancer(address(hypervisor), rebalancer);
        console.log("RebalanceProxy configured");

        vm.stopPrank();

        // Fund rebalancer with HBAR for rebalance calls
        vm.deal(rebalancer, 10 ether);

        console.log("\n=== Setup Complete ===");
        console.log("NOTE: HTS token operations (deposit/withdraw) cannot be tested via fork");
        console.log("Full testing requires deployment to Hedera testnet/mainnet");
    }

    function test_infrastructureDeployed() public view {
        console.log("\n=== Test: Infrastructure Deployed ===");

        // Verify all contracts deployed
        assertTrue(address(clearingV3) != address(0), "ClearingV3 deployed");
        assertTrue(address(uniProxyETH) != address(0), "UniProxyETH deployed");
        assertTrue(address(admin) != address(0), "Admin deployed");
        assertTrue(address(hypeRegistry) != address(0), "HypeRegistry deployed");
        assertTrue(address(rebalanceProxy) != address(0), "RebalanceProxy deployed");
        assertTrue(address(hypervisor) != address(0), "Hypervisor deployed");

        console.log("All infrastructure deployed successfully");
    }

    function test_hypervisorConfiguration() public view {
        console.log("\n=== Test: Hypervisor Configuration ===");

        // Verify hypervisor configured correctly
        assertEq(address(hypervisor.pool()), USDC_WHBAR_POOL, "Pool set correctly");
        assertEq(hypervisor.tickSpacing(), pool.tickSpacing(), "Tick spacing matches pool");

        console.log("Hypervisor pool:", address(hypervisor.pool()));
        console.log("Hypervisor tick spacing:", hypervisor.tickSpacing());
        console.log("Hypervisor HBAR balance:", address(hypervisor).balance);

        assertTrue(address(hypervisor).balance > 0, "Hypervisor funded with HBAR");
    }

    function test_rebalanceProxyConfiguration() public view {
        console.log("\n=== Test: RebalanceProxy Configuration ===");

        // Verify RebalanceProxy configured correctly
        assertEq(rebalanceProxy.admins(address(hypervisor)), address(admin), "Admin set for hypervisor");
        assertEq(rebalanceProxy.rebalancers(address(hypervisor)), rebalancer, "Rebalancer set for hypervisor");

        console.log("RebalanceProxy admin:", rebalanceProxy.admins(address(hypervisor)));
        console.log("RebalanceProxy rebalancer:", rebalanceProxy.rebalancers(address(hypervisor)));
    }

    function test_adminConfiguration() public view {
        console.log("\n=== Test: Admin Configuration ===");

        // Verify Admin configured correctly
        assertEq(admin.rebalancers(address(hypervisor)), address(rebalanceProxy), "RebalanceProxy is rebalancer");

        console.log("Admin rebalancer for hypervisor:", admin.rebalancers(address(hypervisor)));
    }

    function test_clearingV3Deployed() public view {
        console.log("\n=== Test: ClearingV3 Deployed ===");

        // Verify ClearingV3 deployed (addPosition can't be tested due to HTS)
        assertTrue(address(clearingV3) != address(0), "ClearingV3 deployed");
        assertEq(clearingV3.owner(), owner, "ClearingV3 owner set correctly");

        console.log("ClearingV3 owner:", clearingV3.owner());
    }

    // NOTE: The following tests require HTS token operations which cannot be performed via fork
    // These would need to be run on Hedera testnet/mainnet with real tokens:
    //
    // - test_deposit: Deposit tokens via UniProxyETH
    // - test_rebalance: Rebalance via RebalanceProxy (requires tokens in position)
    // - test_withdraw: Withdraw tokens from hypervisor
    //
    // The HBAR forwarding for mint fees has been verified to compile and the call chain is:
    // RebalanceProxy.rebalance{value: HBAR}() -> Admin.rebalance{value: msg.value}() -> Hypervisor.rebalance{value: msg.value}() -> pool.mint{value: mintFee}()
}
