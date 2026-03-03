// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.7.6;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import { RebalanceProxy } from "../contracts/RebalanceProxy.sol";

contract DeployRebalanceProxy is Script {


    function run(address _address) public {
        uint deployerPrivateKey = vm.envUint("MAINNET_PRIVATE_KEY");
        address account = vm.addr(deployerPrivateKey);
        console.log("Account", account);

        vm.startBroadcast(deployerPrivateKey);


        // Deploy the RebalanceProxy contract
        RebalanceProxy rebalanceProxy = new RebalanceProxy(_address);
        console.log("RebalanceProxy deployed at:", address(rebalanceProxy));

        vm.stopBroadcast();
    }
}
