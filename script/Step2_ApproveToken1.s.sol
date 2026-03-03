// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.7.6;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { HypeRegistry } from "../contracts/HypeRegistry.sol";
import { UniProxy } from "../contracts/UniProxy.sol";
import { Hypervisor } from "../contracts/Hypervisor.sol";
import { Admin } from "../contracts/proxy/admin.sol";

interface IERC20Detailed is IERC20 {
    function name() external view returns(string memory);
    function symbol() external view returns(string memory);
    function decimals() external view returns(uint8);
}

contract Step2_ApproveToken1 is Script {
    function run(
      address _hypervisor, 
      uint256 _deposit0, 
      uint256 _deposit1, 
      address _uniproxy, 
      address _admin
      ) 
      public 
      {
      uint deployerPrivateKey = vm.envUint("MAINNET_PRIVATE_KEY");
      address account = vm.addr(deployerPrivateKey);
      console.log("Account", account);

      vm.startBroadcast(deployerPrivateKey);

      Hypervisor hypervisor = Hypervisor(payable(_hypervisor));

      // Step 2: Approve token1
      hypervisor.token1().approve(address(hypervisor), _deposit1);
      console.log("Token1 approved");

      vm.stopBroadcast();
    }
} 