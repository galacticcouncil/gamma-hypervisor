// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.7.6;
pragma abicoder v2;

import { Test, console } from "forge-std/Test.sol";
import { ClearingV3 } from "../contracts/ClearingV3.sol";
import { IHypervisor } from "../contracts/interfaces/IHypervisor.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";

interface IUniProxyETH {
    function transferClearance(address newClearance) external;
    function owner() external view returns (address);
}

contract ClearingV3DebugTest is Test {
    // Deployed contract addresses
    address constant OLD_CLEARING_V3 = 0x3fbEFE843f6bD38D4F07fDdf5be053014cB3D120;
    address constant UNIPROXY_ETH = 0x1c1Dbd8BA46A7B78AfEFA7DF37fBb8423990b0cc;
    address constant POOL_ADDRESS = 0x0085A09e68468A99c6Ec3c0C9C98e17af614C470;
    address constant HYPERVISOR = 0x11C4011772594c5F124a027Da35329559447853D;
    address constant OWNER_ADDRESS = 0x919ff7b006387dBcd3267D5ea57AC41CeE1fa949;
    
    ClearingV3 clearingV3; // This will now point to our new contract
    IHypervisor hypervisor;
    IUniswapV3Pool pool;
    
    string RPC_URL = "https://lb.routeme.sh/rpc/6900/20ce93c4-af46-4382-9cb1-9aeb8df94b0c";
    
    function setUp() public {
        // Fork the network
        vm.createSelectFork(RPC_URL);
        
        console.log("=== Deploying New ClearingV3 with SafeMath Fixes ===");
        
        // Deploy new ClearingV3 with the owner address
        clearingV3 = new ClearingV3(OWNER_ADDRESS);
        console.log("New ClearingV3 deployed at:", address(clearingV3));
        
        // Set up contract interfaces
        hypervisor = IHypervisor(HYPERVISOR);
        pool = IUniswapV3Pool(POOL_ADDRESS);
        
        // Prank as the owner to add the position
        vm.startPrank(OWNER_ADDRESS);
        
        console.log("Adding position to new ClearingV3...");
        clearingV3.addPosition(HYPERVISOR, 4); // Using version 4 as seen in the test
        console.log("Position added successfully");

        console.log("Transferring clearance in UniProxyETH...");
        IUniProxyETH(UNIPROXY_ETH).transferClearance(address(clearingV3));
        console.log("Clearance transferred successfully");

        vm.stopPrank();
        
        console.log("Setup complete! New ClearingV3 address:", address(clearingV3));
    }
    
    function test_DebugGetTotalAmountsPlusFees() public {
        console.log("=== Testing ClearingV3.getTotalAmountsPlusFees ===");
        console.log("ClearingV3 Address:", address(clearingV3));
        console.log("Hypervisor Address:", HYPERVISOR);
        console.log("Pool Address:", POOL_ADDRESS);
        
        // First, let's get the hypervisor fee
        uint8 hypervisorFee = hypervisor.fee();
        console.log("Hypervisor fee:", uint256(hypervisorFee));
        
        // Get the base and limit positions
        int24 baseLower = hypervisor.baseLower();
        int24 baseUpper = hypervisor.baseUpper();
        int24 limitLower = hypervisor.limitLower();
        int24 limitUpper = hypervisor.limitUpper();
        
        console.log("\n=== Position Ticks ===");
        console.log("Base Lower:", int256(baseLower));
        console.log("Base Upper:", int256(baseUpper));
        console.log("Limit Lower:", int256(limitLower));
        console.log("Limit Upper:", int256(limitUpper));
        
        // Get total amounts without fees
        (uint256 total0, uint256 total1) = hypervisor.getTotalAmounts();
        console.log("\n=== Total Amounts (without fees) ===");
        console.log("Total0:", total0);
        console.log("Total1:", total1);
        
        // Try to call calculatePositionFee for base position
        console.log("\n=== Testing calculatePositionFee for BASE position ===");
        try clearingV3.calculatePositionFee(pool, baseLower, baseUpper, HYPERVISOR) returns (uint256 fee0, uint256 fee1) {
            console.log("Base Fee0:", fee0);
            console.log("Base Fee1:", fee1);
            
            // Check what happens when we apply fee reduction
            if (hypervisorFee > 0) {
                uint256 reduction0 = fee0 / hypervisorFee;
                uint256 reduction1 = fee1 / hypervisorFee;
                console.log("Base Fee0 reduction (fee0/fee):", reduction0);
                console.log("Base Fee1 reduction (fee1/fee):", reduction1);
                
                // Check if subtraction would overflow
                if (reduction0 > fee0) {
                    console.log("WARNING: Base Fee0 reduction would overflow!");
                }
                if (reduction1 > fee1) {
                    console.log("WARNING: Base Fee1 reduction would overflow!");
                }
            }
        } catch Error(string memory reason) {
            console.log("calculatePositionFee (base) failed:", reason);
        } catch (bytes memory) {
            console.log("calculatePositionFee (base) failed with low-level error");
        }
        
        // Try to call calculatePositionFee for limit position
        console.log("\n=== Testing calculatePositionFee for LIMIT position ===");
        try clearingV3.calculatePositionFee(pool, limitLower, limitUpper, HYPERVISOR) returns (uint256 fee0, uint256 fee1) {
            console.log("Limit Fee0:", fee0);
            console.log("Limit Fee1:", fee1);
            
            // Check what happens when we apply fee reduction
            if (hypervisorFee > 0) {
                uint256 reduction0 = fee0 / hypervisorFee;
                uint256 reduction1 = fee1 / hypervisorFee;
                console.log("Limit Fee0 reduction (fee0/fee):", reduction0);
                console.log("Limit Fee1 reduction (fee1/fee):", reduction1);
                
                // Check if subtraction would overflow
                if (reduction0 > fee0) {
                    console.log("WARNING: Limit Fee0 reduction would overflow!");
                }
                if (reduction1 > fee1) {
                    console.log("WARNING: Limit Fee1 reduction would overflow!");
                }
            }
        } catch Error(string memory reason) {
            console.log("calculatePositionFee (limit) failed:", reason);
        } catch (bytes memory) {
            console.log("calculatePositionFee (limit) failed with low-level error");
        }
        
        // Now try the main function that's failing
        console.log("\n=== Testing getTotalAmountsPlusFees ===");
        try clearingV3.getTotalAmountsPlusFees(HYPERVISOR) returns (uint256 totalPlusFees0, uint256 totalPlusFees1) {
            console.log("SUCCESS!");
            console.log("Total Plus Fees0:", totalPlusFees0);
            console.log("Total Plus Fees1:", totalPlusFees1);
            console.log("Fees0 added:", totalPlusFees0 - total0);
            console.log("Fees1 added:", totalPlusFees1 - total1);
        } catch Error(string memory reason) {
            console.log("getTotalAmountsPlusFees failed:", reason);
            console.log("This confirms the SafeMath overflow issue");
        } catch (bytes memory) {
            console.log("getTotalAmountsPlusFees failed with low-level error");
        }
    }
    
    function test_DebugFeeCalculationLogic() public {
        console.log("\n=== Debugging Fee Calculation Logic ===");
        
        // Get hypervisor fee
        uint8 hypervisorFee = hypervisor.fee();
        console.log("Hypervisor fee value:", uint256(hypervisorFee));
        
        // Test the fee reduction logic with sample values
        uint256[] memory testValues = new uint256[](5);
        testValues[0] = 100;
        testValues[1] = 1000;
        testValues[2] = 10000;
        testValues[3] = 5;
        testValues[4] = 1;
        
        for (uint i = 0; i < testValues.length; i++) {
            uint256 testFee = testValues[i];
            console.log("\nTest with fee amount:", testFee);
            
            if (hypervisorFee > 0) {
                uint256 reduction = testFee / hypervisorFee;
                console.log("  Reduction (fee/hypervisorFee):", reduction);
                console.log("  Would result in:", testFee > reduction ? testFee - reduction : 0);
                console.log("  Would overflow?", reduction > testFee ? "YES" : "NO");
            } else {
                console.log("  Division by zero - hypervisorFee is 0!");
            }
        }
        
        // Let's also check the position info
        console.log("\n=== Position Details ===");
        
        // Check current tick
        int24 currentTick = hypervisor.currentTick();
        console.log("Current tick:", int256(currentTick));
        
        // Get position keys
        bytes32 basePositionKey = keccak256(abi.encodePacked(HYPERVISOR, hypervisor.baseLower(), hypervisor.baseUpper()));
        bytes32 limitPositionKey = keccak256(abi.encodePacked(HYPERVISOR, hypervisor.limitLower(), hypervisor.limitUpper()));
        
        console.log("Base position key:", uint256(basePositionKey));
        console.log("Limit position key:", uint256(limitPositionKey));
    }
    
    function test_CheckClearingV3Positions() public {
        console.log("\n=== Checking ClearingV3 Position Info ===");
        
        // Get position info from ClearingV3
        (uint8 version, bool twapOverride, uint32 twapInterval, uint256 priceThreshold) = clearingV3.positions(HYPERVISOR);
        
        console.log("Position version:", uint256(version));
        console.log("TWAP override:", twapOverride);
        console.log("TWAP interval:", uint256(twapInterval));
        console.log("Price threshold:", priceThreshold);
        
        if (version == 0) {
            console.log("WARNING: Position not added to ClearingV3!");
        }
    }
}