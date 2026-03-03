// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.7.6;
pragma abicoder v2;

import { Test, console } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { ClearingV3 } from "../contracts/ClearingV3.sol";
import { UniProxyETH } from "../contracts/UniProxyETH.sol";
import { Hypervisor } from "../contracts/Hypervisor.sol";
import { Admin } from "../contracts/proxy/admin.sol";
import "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3SwapCallback.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import "@uniswap/v3-core/contracts/UniswapV3Factory.sol";
import "@uniswap/v3-core/contracts/UniswapV3Pool.sol";

// Mock ERC20 token for testing
contract MockToken is ERC20 {
    constructor(string memory name, string memory symbol, uint8 decimals_) ERC20(name, symbol) {
        _setupDecimals(decimals_);
        _mint(msg.sender, 1000000 * 10**decimals_);
    }
}

contract SepoliaTwapTest is Test, IUniswapV3SwapCallback {
    
    ClearingV3 public clearingV3;
    UniProxyETH public uniproxyETH;
    Hypervisor public hypervisor;
    Admin public admin;
    IUniswapV3Pool public pool;
    IUniswapV3Factory public factory;
    
    MockToken public token0;
    MockToken public token1;
    
    address public owner;
    uint24 constant POOL_FEE = 3000; // 0.3%
    uint160 constant SQRT_PRICE_1_1 = 79228162514264337593543950336; // sqrt(1) * 2^96
    
    uint256 _deposit0 = 1000e18;     // Token0 amount
    uint256 _deposit1 = 1000e18;     // Token1 amount

    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata
    ) external override {
        if (amount0Delta > 0) {
            IERC20(IUniswapV3Pool(msg.sender).token0()).transfer(msg.sender, uint256(amount0Delta));
        } else if (amount1Delta > 0) {
            IERC20(IUniswapV3Pool(msg.sender).token1()).transfer(msg.sender, uint256(amount1Delta));
        }
    }

    function setUp() public {
        // Use Sepolia testnet
        vm.createSelectFork("sepolia");
        
        owner = makeAddr("owner");
        vm.startPrank(owner);
        
        // Deploy mock tokens
        token0 = new MockToken("Token A", "TKNA", 18);
        token1 = new MockToken("Token B", "TKNB", 18);
        
        // Ensure token0 < token1 for Uniswap V3
        if (address(token0) > address(token1)) {
            (token0, token1) = (token1, token0);
        }
        
        console.log("Token0 address:", address(token0));
        console.log("Token1 address:", address(token1));
        
        // Deploy Uniswap V3 Factory
        factory = new UniswapV3Factory();
        
        // Create pool
        address poolAddress = factory.createPool(address(token0), address(token1), POOL_FEE);
        pool = IUniswapV3Pool(poolAddress);
        
        console.log("Pool address:", poolAddress);
        
        // Initialize pool at 1:1 price
        pool.initialize(SQRT_PRICE_1_1);
        
        // Increase observation cardinality to 10000 (much higher for better TWAP)
        pool.increaseObservationCardinalityNext(1000);
        console.log("Set cardinality target to: 1000");
        
        pool.increaseObservationCardinalityNext(1000);
        console.log("Set cardinality target to: 1000");

        pool.increaseObservationCardinalityNext(1000);
        console.log("Set cardinality target to: 1000");

        pool.increaseObservationCardinalityNext(1000);
        console.log("Set cardinality target to: 1000");

        
        // Make small swaps to populate observations and reach target cardinality
        token0.approve(address(pool), type(uint256).max);
        token1.approve(address(pool), type(uint256).max);
        
        console.log("Populating observations with small swaps...");
        for (uint i = 0; i < 500; i++) {
            // Small alternating swaps to create price history
            bool zeroForOne = (i % 2 == 0);
            int256 amountSpecified = zeroForOne ? int256(1e15) : -int256(1e15); // 0.001 token (smaller)
            
            // Use more reasonable price limits based on current price
            (uint160 currentSqrtPrice, , , , , , ) = pool.slot0();
            uint160 sqrtPriceLimitX96 = zeroForOne ? 
                currentSqrtPrice * 99 / 100 : // 1% lower for selling token0
                currentSqrtPrice * 101 / 100; // 1% higher for selling token1
                
            try pool.swap(
                address(this),
                zeroForOne,
                amountSpecified,
                sqrtPriceLimitX96,
                ""
            ) {
                // Swap successful
            } catch {
                // Skip failed swaps
                break;
            }
            
            // Wait a bit between swaps to create time-based observations
            vm.warp(block.timestamp + 60); // 60 seconds between swaps for longer history
        }



        
        // Deploy clearing and proxy contracts
        clearingV3 = new ClearingV3(owner);
        uniproxyETH = new UniProxyETH(address(clearingV3), owner);
        
        // Deploy hypervisor
        hypervisor = new Hypervisor(
            poolAddress,
            owner,
            "Test-Pool",
            "TEST-POOL"
        );
        
        admin = new Admin(owner);
        
        console.log("Current tick:", hypervisor.currentTick());
        
        // Transfer tokens to owner and approve
        token0.transfer(owner, 10000e18);
        token1.transfer(owner, 10000e18);
        
        token0.approve(address(hypervisor), _deposit0);
        token1.approve(address(hypervisor), _deposit1);
        hypervisor.setWhitelist(owner);
        
        // Initial deposit
        hypervisor.deposit(
            _deposit0,
            _deposit1,
            owner,
            owner,
            [uint256(0), uint256(0), uint256(0), uint256(0)]
        );
        
        console.log("Initial deposit completed");
        console.log("Hypervisor total supply:", hypervisor.totalSupply());
        
        // Initial rebalance to set up positions
        hypervisor.rebalance(
            int24(-887220),
            int24(887220),
            int24(-6000),
            int24(6000),
            address(admin),
            [uint256(0), uint256(0), uint256(0), uint256(0)],
            [uint256(0), uint256(0), uint256(0), uint256(0)]
        );
        
        clearingV3.addPosition(address(hypervisor), uint8(3));
        hypervisor.setWhitelist(address(uniproxyETH));
        hypervisor.transferOwnership(address(admin));
        
        // Deal extra tokens for swaps
        token0.transfer(address(this), 50000e18);
        token1.transfer(address(this), 50000e18);
        
        vm.stopPrank();
        
        // Warp forward one hour to ensure TWAP has sufficient history
        vm.warp(block.timestamp + 3600); // 1 hour = 3600 seconds
        console.log("Warped forward 1 hour for TWAP history");
        
        console.log("Setup completed successfully");
    }

    function test_TwapCheckPriceChangeOverflow() public {
        // Wait for TWAP data to accumulate (we already have 8+ hours of history from setup)
        vm.warp(block.timestamp + 900); // 15 minutes additional
        
        console.log("=== Starting TWAP Overflow Test ===");
        
        // Get initial state
        (uint160 sqrtPriceBefore, , , , , , ) = pool.slot0();
        console.log("Initial sqrtPrice:", uint256(sqrtPriceBefore));
        
        // Execute large swap to cause significant price movement (25% drop)
        uint160 sqrtPriceLimitX96Down = sqrtPriceBefore * 75 / 100;
        
        (int256 swapAmount0, int256 swapAmount1) = pool.swap(
            address(this),
            true, // zeroForOne
            -5000e18, // Large swap amount
            sqrtPriceLimitX96Down,
            ""
        );
        
        console.log("Swap completed:");
        console.log("Amount0:", swapAmount0);
        console.log("Amount1:", swapAmount1);
        
        // Get price after swap
        (uint160 sqrtPriceAfter, , , , , , ) = pool.slot0();
        console.log("Final sqrtPrice:", uint256(sqrtPriceAfter));
        
        uint256 priceChange = uint256(sqrtPriceBefore) * 10000 / uint256(sqrtPriceAfter);
        console.log("Price change ratio (basis points):", priceChange);
        console.log("Price threshold:", clearingV3.priceThreshold());
        
        // Try to deposit - should revert due to price change
        uint256 deposit0 = 100e18;
        (uint256 deposit1, ) = uniproxyETH.getDepositAmount(
            address(hypervisor),
            address(token0),
            deposit0
        );
        
        // Deal tokens for deposit attempt
        deal(address(token0), address(this), deposit0);
        deal(address(token1), address(this), deposit1);
        
        // Approve tokens
        token0.approve(address(uniproxyETH), deposit0);
        token1.approve(address(uniproxyETH), deposit1);
        
        console.log("Attempting deposit - expecting revert...");
        
        vm.expectRevert("Price change overflow");
        uniproxyETH.deposit(
            deposit0,
            deposit1,
            address(this),
            address(hypervisor),
            [uint256(0), uint256(0), uint256(0), uint256(0)],
            uint256(100)
        );
        
        console.log("TWAP protection worked - deposit was blocked!");
    }
    
    function test_DepositWithdrawRatioAdjustment() public {
        console.log("=== Testing Deposit/Withdraw with Ratio Adjustment ===");
        
        // Get initial hypervisor amounts before any user interaction
        (uint256 hypervisorBefore0, uint256 hypervisorBefore1) = hypervisor.getTotalAmounts();
        console.log("=== HYPERVISOR BEFORE USER INTERACTION ===");
        console.log("Hypervisor total0 before:", hypervisorBefore0);
        console.log("Hypervisor total1 before:", hypervisorBefore1);
        
        // Get current pool state for reference
        (uint256 poolTotal0, uint256 poolTotal1) = clearingV3.getTotalAmountsPlusFees(address(hypervisor));
        console.log("=== POOL STATE ===");
        console.log("Pool Total0:", poolTotal0);
        console.log("Pool Total1:", poolTotal1);
        console.log("Pool ratio (token0/token1):", (poolTotal0 * 1e18) / poolTotal1);
        
        address user = makeAddr("testUser");
        
        // Intentionally use an INCORRECT ratio - much more token1 than needed
        uint256 intendedDeposit0 = 10e18;   // 10 tokens
        uint256 intendedDeposit1 = 100e18;  // 100 tokens (10:1 ratio, way off from pool)
        
        console.log("=== INTENDED DEPOSITS ===");
        console.log("Intended deposit0:", intendedDeposit0);
        console.log("Intended deposit1:", intendedDeposit1);
        console.log("Intended ratio (token0/token1):", (intendedDeposit0 * 1e18) / intendedDeposit1);
        
        // Deal more tokens to user to ensure sufficient balance
        deal(address(token0), user, intendedDeposit0 * 2);
        deal(address(token1), user, intendedDeposit1 * 2);
        
        vm.startPrank(user);
        
        // Check what clearDeposit will actually allow
        (bool cleared, uint256 actualDeposit0, uint256 actualDeposit1) = clearingV3.clearDeposit(
            intendedDeposit0,
            intendedDeposit1,
            user,
            user,
            address(hypervisor)
        );
        
        console.log("=== CLEARING RESULT ===");
        console.log("Cleared:", cleared);
        console.log("Actual deposit0:", actualDeposit0);
        console.log("Actual deposit1:", actualDeposit1);
        console.log("Actual ratio (token0/token1):", (actualDeposit0 * 1e18) / actualDeposit1);
        console.log("Adjustment - deposit0 change:", int256(actualDeposit0) - int256(intendedDeposit0));
        console.log("Adjustment - deposit1 change:", int256(actualDeposit1) - int256(intendedDeposit1));
        
        // Execute deposit and track spending
        uint256 shares = _executeDepositAndLogSpending(user, actualDeposit0, actualDeposit1);
        
        // Execute withdrawal and log results
        _executeWithdrawAndLogResults(user, shares);
        
        vm.stopPrank();
        
        // Check hypervisor amounts after user interaction
        (uint256 hypervisorAfter0, uint256 hypervisorAfter1) = hypervisor.getTotalAmounts();
        console.log("=== HYPERVISOR AFTER USER INTERACTION ===");
        console.log("Hypervisor total0 after:", hypervisorAfter0);
        console.log("Hypervisor total1 after:", hypervisorAfter1);
        
        // Calculate and log the difference
        console.log("=== POOL BALANCE VERIFICATION ===");
        console.log("Total0 difference:", int256(hypervisorAfter0) - int256(hypervisorBefore0));
        console.log("Total1 difference:", int256(hypervisorAfter1) - int256(hypervisorBefore1));
        
        // Verify the deposit was adjusted to proper ratio
        assertTrue(cleared, "Deposit should be cleared");
        assertApproxEqRel(
            (actualDeposit0 * 1e18) / actualDeposit1,
            (poolTotal0 * 1e18) / poolTotal1,
            1e16, // 1% tolerance
            "Actual deposit ratio should match pool ratio"
        );
        
        // Verify pool amounts are essentially unchanged (allowing for minor rounding)
        assertApproxEqAbs(
            hypervisorAfter0,
            hypervisorBefore0,
            10, // Allow up to 10 wei difference for rounding
            "Hypervisor total0 should be unchanged after deposit/withdraw cycle"
        );
        assertApproxEqAbs(
            hypervisorAfter1,
            hypervisorBefore1,
            10, // Allow up to 10 wei difference for rounding
            "Hypervisor total1 should be unchanged after deposit/withdraw cycle"
        );
    }
    
    function _executeDepositAndLogSpending(address user, uint256 actualDeposit0, uint256 actualDeposit1) private returns (uint256 shares) {
        uint256 balanceBefore0 = token0.balanceOf(user);
        uint256 balanceBefore1 = token1.balanceOf(user);
        
        token0.approve(address(uniproxyETH), type(uint256).max);
        token1.approve(address(uniproxyETH), type(uint256).max);
        token0.approve(address(hypervisor), type(uint256).max);
        token1.approve(address(hypervisor), type(uint256).max);
        
        shares = uniproxyETH.deposit(
            actualDeposit0,
            actualDeposit1,
            user,
            address(hypervisor),
            [uint256(0), uint256(0), uint256(0), uint256(0)],
            uint256(100)
        );
        
        uint256 balanceAfter0 = token0.balanceOf(user);
        uint256 balanceAfter1 = token1.balanceOf(user);
        
        console.log("=== ACTUAL SPENDING ===");
        console.log("Actually spent token0:", balanceBefore0 - balanceAfter0);
        console.log("Actually spent token1:", balanceBefore1 - balanceAfter1);
        console.log("Shares received:", shares);
        console.log("Leftover token0:", balanceAfter0);
        console.log("Leftover token1:", balanceAfter1);
    }
    
    function _executeWithdrawAndLogResults(address user, uint256 shares) private {
        console.log("=== WITHDRAWING ALL SHARES ===");
        
        uint256 balanceBefore0 = token0.balanceOf(user);
        uint256 balanceBefore1 = token1.balanceOf(user);
        
        hypervisor.withdraw(
            shares,
            user,
            user,
            [uint256(0), uint256(0), uint256(0), uint256(0)]
        );
        
        uint256 balanceAfter0 = token0.balanceOf(user);
        uint256 balanceAfter1 = token1.balanceOf(user);
        
        uint256 withdrawn0 = balanceAfter0 - balanceBefore0;
        uint256 withdrawn1 = balanceAfter1 - balanceBefore1;
        
        console.log("=== WITHDRAWAL RESULTS ===");
        console.log("Withdrawn token0:", withdrawn0);
        console.log("Withdrawn token1:", withdrawn1);
        console.log("Withdrawn ratio (token0/token1):", (withdrawn0 * 1e18) / withdrawn1);
        console.log("Final user token0 balance:", balanceAfter0);
        console.log("Final user token1 balance:", balanceAfter1);
    }

} 
