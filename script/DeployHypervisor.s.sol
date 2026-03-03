// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.7.6;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { HypeRegistry } from "../contracts/HypeRegistry.sol";
import { Clearing as ClearingV1 } from "../contracts/Clearing.sol";
import { UniProxy } from "../contracts/UniProxy.sol";
import { Hypervisor } from "../contracts/Hypervisor.sol";
import { Admin } from "../contracts/proxy/admin.sol";

contract DeployHypervisor is Script {

    function run(address _pool, address _hypeRegistry, string memory _name, string memory _symbol) public {
        uint deployerPrivateKey = vm.envUint("MAINNET_PRIVATE_KEY");
        address account = vm.addr(deployerPrivateKey);
        console.log("Account", account);

        vm.startBroadcast(deployerPrivateKey);

        Hypervisor hypervisor = new Hypervisor(_pool, account, _name, _symbol);
        console.log("Hypervisor deployed at:", address(hypervisor));

        HypeRegistry hyperegistry = HypeRegistry(_hypeRegistry);
        hyperegistry.add(address(hypervisor));
        console.log("hypeRegistry added: ", address(hypervisor));

        vm.stopBroadcast();
    }
}
