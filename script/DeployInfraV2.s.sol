// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.7.6;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ClearingV3 } from "../contracts/ClearingV3.sol";
import { UniProxyETH } from "../contracts/UniProxyETH.sol";
import { Hypervisor } from "../contracts/Hypervisor.sol";
import { Admin } from "../contracts/proxy/admin.sol";
import { HypeRegistry } from "../contracts/HypeRegistry.sol";

contract DeployInfraV2 is Script {
    function run(address owner) public {
        uint deployerPrivateKey = vm.envUint("MAINNET_PRIVATE_KEY");
        address account = vm.addr(deployerPrivateKey);
        console.log("Deployer Account:", account);
        console.log("Owner Address:", owner);

        vm.startBroadcast(deployerPrivateKey);

        // Deploy the ClearingV3 contract
        ClearingV3 clearingV3 = new ClearingV3(owner);
        console.log("ClearingV3 deployed at:", address(clearingV3));
        // vm.sleep(60000); // Wait 30 seconds for confirmation

        // // Deploy the UniProxyV2 contract with ClearingV3 as the target
        UniProxyETH uniProxyETH = new UniProxyETH(address(clearingV3), owner);
        console.log("UniProxyETH deployed at:", address(uniProxyETH));



        // // // Deploy the admin contract
        Admin admin = new Admin(owner);
        console.log("Admin deployed at:", address(admin));
        // // vm.sleep(60000); // Wait 30 seconds for confirmation

        HypeRegistry hypeRegistry = new HypeRegistry();
        console.log("HypeRegistry deployed at:", address(hypeRegistry));

        vm.stopBroadcast();
    }
}