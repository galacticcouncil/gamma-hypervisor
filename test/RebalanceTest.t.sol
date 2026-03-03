// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.7.6;
pragma abicoder v2;

import { Test, console } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { FullMath } from "@uniswap/v3-core/contracts/libraries/FullMath.sol";
import { ClearingV3 } from "../contracts/ClearingV3.sol";
import { UniProxyETH } from "../contracts/UniProxyETH.sol";
import { Hypervisor } from "../contracts/Hypervisor.sol";
import { Admin } from "../contracts/proxy/admin.sol";
import "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3SwapCallback.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";

contract RebalanceTest is Test, IUniswapV3SwapCallback {

    ClearingV3 public clearingV3;
    UniProxyETH public uniproxyETH;
    Hypervisor public hypervisor;
    Admin public admin;
    IUniswapV3Pool public pool;
    uint256 constant FORK_BLOCK = 362117588;
    
    uint256 public constant PRECISION = 1e36;
    int256 initialSwap = 10 ether;
    address uniswapPoolAddress = 0xC6962004f452bE9203591991D15f6b388e09E8D0; // WETH-USDC
    uint256 _deposit0 = 1 ether;     // WETH amount
    uint256 _deposit1 = 2000e6;     // USDC amount (6 decimals)

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
        address owner = makeAddr("user");
        vm.createSelectFork("arbitrum", FORK_BLOCK);
        vm.startPrank(owner);
        
        clearingV3 = new ClearingV3(owner);
        uniproxyETH = new UniProxyETH(address(clearingV3), owner);

        // Deploy hypervisor directly
        hypervisor = new Hypervisor(
            uniswapPoolAddress,
            owner, // initial receiver
            "WETH-USDC",
            "WETH-USDC"
        );
        pool = IUniswapV3Pool(uniswapPoolAddress);

        console.log("current tick of the hypervisor", hypervisor.currentTick());

        admin = new Admin(owner);
        
        // Deal tokens to owner
        deal(address(hypervisor.token0()), owner, 10 ether);      // WETH
        deal(address(hypervisor.token1()), owner, 20000e6);      // USDC

        console.log("Pre-initialMint Total Supply:", hypervisor.totalSupply());

        hypervisor.token0().approve(address(hypervisor), _deposit0);
        hypervisor.token1().approve(address(hypervisor), _deposit1);
        hypervisor.setWhitelist(owner);

        hypervisor.deposit(
            _deposit0,
            _deposit1,
            owner,
            owner,
            [uint256(0), uint256(0), uint256(0), uint256(0)]
        );

        console.log("Post-initialMint Total Supply:", hypervisor.totalSupply());
        console.log("Post-initialMint Owner Balance:", hypervisor.balanceOf(owner));
        
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
        deal(address(pool.token0()), address(this), 1000 ether);
        deal(address(pool.token1()), address(this), 1000000e6);

        IERC20(pool.token0()).approve(address(pool), type(uint256).max);
        IERC20(pool.token1()).approve(address(pool), type(uint256).max);

        vm.stopPrank();
    }

    function test_initialDeposit() public {
        address user = makeAddr("user2");
        uint256 deposit0 = 0.1 ether; // WETH

        // Get token1 deposit range
        (uint256 amount1Start, uint256 amount1End) = uniproxyETH.getDepositAmount(
            address(hypervisor),
            address(hypervisor.token0()),
            deposit0
        );
        uint256 deposit1 = (amount1Start + amount1End) / 2;

        // Check initial state
        console.log("Initial Total Supply:", hypervisor.totalSupply());
    
        IERC20 token0 = hypervisor.token0();
        IERC20 token1 = hypervisor.token1();

        deal(address(token0), user, deposit0);
        deal(address(token1), user, deposit1);

        vm.startPrank(user);

        uint256 token0Before = token0.balanceOf(user);
        uint256 token1Before = token1.balanceOf(user);

        token0.approve(address(hypervisor), deposit0);
        token1.approve(address(hypervisor), deposit1);

        console.log("Pool State Before Deposit");
        logPoolState();

        uint256 shares = executeDeposit(user, token0, token1, deposit0, deposit1);

        console.log("Pool State After Deposit");
        logPoolState();

        uint256 actualDeposit0 = token0Before - token0.balanceOf(user);
        uint256 actualDeposit1 = token1Before - token1.balanceOf(user);

        console.log("Actual deposit0:", actualDeposit0);
        console.log("Actual deposit1:", actualDeposit1);
        console.log("Actual ratio (token0/token1):", (actualDeposit0 * 1e18) / actualDeposit1);
        console.log("Shares received:", shares);
        console.log("Share of total received:", (shares * 1e18) / hypervisor.totalSupply());

        token0Before = token0.balanceOf(user);
        token1Before = token1.balanceOf(user);

        console.log("Pool State Before Withdraw");
        logPoolState();

        executeWithdraw(user, shares);

        vm.stopPrank();
    }

    function test_Rebalance() public {
        (uint160 currentSqrtPrice, int24 currentTick, , , , , ) = pool.slot0();
        console.log("Starting tick:", currentTick);
        
        // Deal tokens to test contract for swaps
        deal(address(hypervisor.token0()), address(this), 10000 ether);
        deal(address(hypervisor.token1()), address(this), 10000000e6);

        uint160 sqrtPriceLimitX96Down = currentSqrtPrice * 80 / 100; // 20% lower
        (int256 swapAmount0, int256 swapAmount1) = pool.swap(
            address(this),
            true,
            -1e17, // Smaller swap amount
            sqrtPriceLimitX96Down,
            ""
        );
        console.log("First swap");
        console.log("token0:", swapAmount0);
        console.log("token1:", swapAmount1);

        (uint256 total0, uint256 total1) = hypervisor.getTotalAmounts();
        console.log("Total0", total0);
        console.log("Total1", total1);

        (uint256 totalPlusFees0, uint256 totalPlusFees1) = clearingV3.getTotalAmountsPlusFees(address(hypervisor));
        console.log("Fees0", totalPlusFees0 - total0);   
        console.log("Fees1", totalPlusFees1 - total1);  

        // Perform swap back
        uint160 sqrtPriceLimitX96Up = currentSqrtPrice * 110 / 100; // 10% higher
        (swapAmount0, swapAmount1) = pool.swap(
            address(this),
            false,
            swapAmount0,
            sqrtPriceLimitX96Up,
            ""
        );

        console.log("Second swap");
        console.log("token0:", swapAmount0);
        console.log("token1:", swapAmount1);

        (total0, total1) = hypervisor.getTotalAmounts();
        console.log("Total0", total0);
        console.log("Total1", total1);

        (totalPlusFees0, totalPlusFees1) = clearingV3.getTotalAmountsPlusFees(address(hypervisor));
        console.log("Fees0", totalPlusFees0 - total0);   
        console.log("Fees1", totalPlusFees1 - total1);   

        console.log("Before rebalance:");
        console.log("baseLower:", hypervisor.baseLower());
        console.log("baseUpper:", hypervisor.baseUpper());
        console.log("limitLower:", hypervisor.limitLower());
        console.log("limitUpper:", hypervisor.limitUpper());

        // Warp forward 24 hours
        vm.warp(block.timestamp + 24 hours);

        // Measure gas for rebalance
        uint256 gasBefore = gasleft();
        console.log("currentTick", hypervisor.currentTick());
        vm.startPrank(address(admin));
        hypervisor.rebalance(
            int24(-887220),
            int24(887220),
            int24(-6000),
            int24(6000),
            address(admin),
            [uint256(0), uint256(0), uint256(0), uint256(0)],
            [uint256(0), uint256(0), uint256(0), uint256(0)]
        );
        vm.stopPrank();

        // Log positions after rebalance
        console.log("After rebalance:");
        console.log("baseLower:", hypervisor.baseLower());
        console.log("baseUpper:", hypervisor.baseUpper());
        console.log("limitLower:", hypervisor.limitLower());
        console.log("limitUpper:", hypervisor.limitUpper());

        uint256 gasUsed = gasBefore - gasleft();
        console.log("Gas used for rebalance:", gasUsed);
    }

    function test_TwapCheckPriceChangeOverflow() public {
        executeRebalance();
        vm.warp(block.timestamp + 3600); // Warp 1 hour
        
        // Deal tokens for swap
        deal(address(hypervisor.token0()), address(this), 1000 ether);
        deal(address(hypervisor.token1()), address(this), 1000000e6);

        // Approve tokens for pool
        IERC20(hypervisor.token0()).approve(address(pool), type(uint256).max);
        IERC20(hypervisor.token1()).approve(address(pool), type(uint256).max);

        // Get initial state
        (uint160 sqrtPriceBefore, , , , , , ) = pool.slot0();
        console.log("Initial sqrtPrice:", uint256(sqrtPriceBefore));

        // Execute large swap to cause significant price movement
        uint160 sqrtPriceLimitX96Down = sqrtPriceBefore * 70 / 100; // 30% price drop
        (int256 swapAmount0, int256 swapAmount1) = pool.swap(
            address(this),
            true,
            -10e18, // Large swap
            sqrtPriceLimitX96Down,
            ""
        );

        // Get price after swap
        (uint160 sqrtPriceAfter, , , , , , ) = pool.slot0();
        console.log("Final sqrtPrice:", uint256(sqrtPriceAfter));

        // Try to deposit - should revert due to price change
        uint256 deposit0 = 0.1 ether;
        (uint256 deposit1, ) = uniproxyETH.getDepositAmount(
            address(hypervisor),
            address(hypervisor.token0()),
            deposit0
        );

        // Deal tokens for deposit attempt
        deal(address(hypervisor.token0()), address(this), deposit0);
        deal(address(hypervisor.token1()), address(this), deposit1);

        // Approve tokens
        IERC20(hypervisor.token0()).approve(address(uniproxyETH), type(uint256).max);
        IERC20(hypervisor.token1()).approve(address(uniproxyETH), type(uint256).max);

        console.log("Price threshold:", clearingV3.priceThreshold());
        
        vm.expectRevert("Price change overflow");
        uniproxyETH.deposit(
            deposit0,
            deposit1,
            address(this),
            address(hypervisor),
            [uint256(0), uint256(0), uint256(0), uint256(0)],
            uint256(100)
        );
    }

    function test_depositWithNativeETH() public {
        address user = makeAddr("user2");
        uint256 depositUSDC = 1000e6;  // USDC amount (6 decimals)
        uint256 depositETH = 0.5 ether;    // ETH amount in wei

        // Get token addresses
        IERC20 weth = IERC20(address(hypervisor.token0()));  // WETH
        IERC20 usdc = IERC20(address(hypervisor.token1()));  // USDC

        // Deal USDC to user
        deal(address(usdc), user, depositUSDC);
        vm.deal(user, depositETH);  // Deal native ETH to user

        console.log("\n=== Initial State ===");
        console.log("User USDC balance:", usdc.balanceOf(user));
        console.log("User ETH balance:", user.balance);
        console.log("User WETH balance:", weth.balanceOf(user));

        vm.startPrank(user);
        
        // Approve USDC spending
        usdc.approve(address(uniproxyETH), depositUSDC);

        // Get pre-deposit state
        uint256 userUSDCBefore = usdc.balanceOf(user);
        uint256 userETHBefore = user.balance;
        uint256 hypervisorWETHBefore = weth.balanceOf(address(hypervisor));
        uint256 hypervisorUSDCBefore = usdc.balanceOf(address(hypervisor));

        console.log("\n=== Depositing with Native ETH ===");
        uint256 shares = uniproxyETH.depositETH{value: depositETH}(
            depositETH,      // deposit0 (WETH)
            depositUSDC,     // deposit1 (USDC)
            user,
            address(hypervisor),
            [uint256(0), uint256(0), uint256(0), uint256(0)],
            uint256(100)
        );

        // Get post-deposit state
        uint256 userUSDCAfter = usdc.balanceOf(user);
        uint256 userETHAfter = user.balance;
        uint256 hypervisorWETHAfter = weth.balanceOf(address(hypervisor));
        uint256 hypervisorUSDCAfter = usdc.balanceOf(address(hypervisor));

        console.log("Shares received:", shares);
        console.log("USDC spent:", userUSDCBefore - userUSDCAfter);
        console.log("ETH spent:", userETHBefore - userETHAfter);
        console.log("Hypervisor WETH change:", hypervisorWETHAfter - hypervisorWETHBefore);
        console.log("Hypervisor USDC change:", hypervisorUSDCAfter - hypervisorUSDCBefore);

        vm.stopPrank();
    }

    function executeRebalance() private {
        address owner = hypervisor.owner();
        int24 currentTick = hypervisor.currentTick();
        int24 tickSpacing = hypervisor.tickSpacing();
        
        vm.prank(owner);
        hypervisor.rebalance(
            int24(-887220),
            int24(887220),  
            int24(-6000),
            int24(6000),
            address(admin),
            [uint256(0), uint256(0), uint256(0), uint256(0)],
            [uint256(0), uint256(0), uint256(0), uint256(0)]
        );
    }

    function logPoolState() private {
        (uint256 pool0, uint256 pool1) = hypervisor.getTotalAmounts();
        console.log("Pool token0:", pool0);
        console.log("Pool token1:", pool1);
    }

    function executeDeposit(
        address user, 
        IERC20 token0, 
        IERC20 token1,
        uint256 deposit0,
        uint256 deposit1
    ) private returns (uint256 shares) {
        token0.approve(address(uniproxyETH), deposit0);
        token1.approve(address(uniproxyETH), deposit1);
        token0.approve(address(hypervisor), deposit0);
        token1.approve(address(hypervisor), deposit1);

        shares = uniproxyETH.deposit(
            deposit0,
            deposit1,
            user,
            address(hypervisor),
            [uint256(0), uint256(0), uint256(0), uint256(0)],
            uint256(100)
        );
    }

    function executeWithdraw(
        address user,
        uint256 shares
    ) private {
        hypervisor.withdraw(
            shares,
            user,
            user,
            [uint256(0), uint256(0), uint256(0), uint256(0)]
        );
    }

    function test_getTotalAmountsPlusFees() public {
        // Get initial amounts before swap
        (uint256 baseTotalA0, uint256 baseTotalA1) = hypervisor.getTotalAmounts();
        (uint256 totalPlusFees0, uint256 totalPlusFees1) = clearingV3.getTotalAmountsPlusFees(address(hypervisor));
        
        console.log("=== Before Swap ===");
        console.log("Base Total0:", baseTotalA0);
        console.log("Base Total1:", baseTotalA1);
        console.log("Plus Fees0:", totalPlusFees0);
        console.log("Plus Fees1:", totalPlusFees1);
        
        // Do a small swap to generate fees
        deal(address(hypervisor.token0()), address(this), 1 ether);
        IERC20(hypervisor.token0()).approve(address(pool), 1 ether);
        
        (uint160 currentSqrtPrice, , , , , , ) = pool.slot0();
        uint160 sqrtPriceLimitX96 = currentSqrtPrice * 99 / 100; // 1% price movement
        
        pool.swap(
            address(this),
            true, // zeroForOne
            1e17, // 0.1 ETH swap
            sqrtPriceLimitX96,
            ""
        );
        
        // Get amounts after swap (should include fees now)
        (uint256 baseTotalB0, uint256 baseTotalB1) = hypervisor.getTotalAmounts();
        (uint256 totalPlusFeesAfter0, uint256 totalPlusFeesAfter1) = clearingV3.getTotalAmountsPlusFees(address(hypervisor));
        
        console.log("=== After Swap ===");
        console.log("Base Total0:", baseTotalB0);
        console.log("Base Total1:", baseTotalB1);
        console.log("Plus Fees0:", totalPlusFeesAfter0);
        console.log("Plus Fees1:", totalPlusFeesAfter1);
        console.log("Fee0 difference:", totalPlusFeesAfter0 - baseTotalB0);
        console.log("Fee1 difference:", totalPlusFeesAfter1 - baseTotalB1);
        
        // Verify that plus fees amounts are >= base amounts
        assertGe(totalPlusFeesAfter0, baseTotalB0, "PlusFees0 should be >= base total0");
        assertGe(totalPlusFeesAfter1, baseTotalB1, "PlusFees1 should be >= base total1");
        
        // Verify fees were actually generated (at least some fee should exist)
        assertTrue(
            totalPlusFeesAfter0 > baseTotalB0 || totalPlusFeesAfter1 > baseTotalB1,
            "Some fees should have been generated from the swap"
        );
    }

    function dealTokensToUser(address user, uint256 amount0, uint256 amount1) internal {
        deal(address(hypervisor.token0()), user, amount0);
        deal(address(hypervisor.token1()), user, amount1);
    }
} 