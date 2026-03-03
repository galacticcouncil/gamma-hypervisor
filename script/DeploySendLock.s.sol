// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.7.6;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import { SendLock } from "../contracts/SendLock.sol";

contract DeploySendLock is Script {

    function run(address _owner, address _recipient) public {
        uint deployerPrivateKey = vm.envUint("MAINNET_PRIVATE_KEY");
        address account = vm.addr(deployerPrivateKey);
        console.log("Account", account);

        vm.startBroadcast(deployerPrivateKey);

        SendLock sendLock = new SendLock(_owner, _recipient);
        console.log("SendLock deployed at:", address(sendLock));
        console.log("Owner:", _owner);
        console.log("Recipient:", _recipient);

        vm.stopBroadcast();
    }
}