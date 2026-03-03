import { expect } from 'chai'
import { constants, Wallet } from 'ethers'
import { formatEther, parseEther, formatUnits, parseUnits } from 'ethers/lib/utils'
import { task } from 'hardhat/config'
import { deployContract, signPermission } from './utils'
import {
    FeeAmount,
    TICK_SPACINGS,
    encodePriceSqrt,
    getPositionKey,
    getMinTick,
    getMaxTick,
    MaxUint256
} from './shared/utilities'
import {
  baseTicksFromCurrentTick,
  limitTicksFromCurrentTick
} from './shared/tick'


task('deploy-masterchef', 'Deploy admin contract')
  .addParam('sushi', 'reward rate')
  .setAction(async (args, { ethers, run, network }) => {
    console.log('Network')
    console.log('  ', network.name)
    console.log('Task Args')
    console.log(args)

    // compile

    await run('compile')

    // get signer

    const signer = (await ethers.getSigners())[0]
    console.log('Signer')
    console.log('  at', signer.address)
    console.log('  ETH', formatEther(await signer.getBalance()))

    // deploy contracts


    const chef = await deployContract(
      'MasterChef',
      await ethers.getContractFactory('MasterChef'),
      signer,
      [args.sushi]
    )

    await chef.deployTransaction.wait(15)
    await run('verify:verify', {
      address: chef.address,
      constructorArguments: [args.sushi]
    })

})

task('initialize-masterchef', 'Deploy admin contract')
  .addParam('masterchef', 'masterchef address')
  .addParam('owner', 'owner address')
  .setAction(async (cliArgs, { ethers, run, network }) => {

    console.log('Network')
    console.log('  ', network.name)

    await run('compile')

    // get signer

    const signer = (await ethers.getSigners())[0]
    console.log('Signer')
    console.log('  at', signer.address)
    console.log('  ETH', formatEther(await signer.getBalance()))

    // deploy contracts

    const chef = await ethers.getContractAt(
      'MasterChef',
      cliArgs.masterchef,
      signer
    )
    let txResponse = await chef.transferOwnership(cliArgs.owner, true, false);
    let receipt = await txResponse.wait();
    console.log('Success')

})


task('deploy-rewarder', 'Deploy admin contract')
  .addParam('rewardToken', 'reward rate')
  .addParam('rate', 'reward rate')
  .addParam('chef', 'chef address')
  .addParam('owner', 'owner')
  .setAction(async (args, { ethers, run, network }) => {
    console.log('Network')
    console.log('  ', network.name)
    console.log('Task Args')
    console.log(args)

    // compile

    await run('compile')

    // get signer

    const signer = (await ethers.getSigners())[0]
    console.log('Signer')
    console.log('  at', signer.address)
    console.log('  ETH', formatEther(await signer.getBalance()))

    // deploy contracts


    const chef = await deployContract(
      'Rewarder',
      await ethers.getContractFactory('Rewarder'),
      signer,
      [args.rewardToken, args.rate, args.chef]
    )

    await chef.deployTransaction.wait(30)
    console.log('Success')
    await run('verify:verify', {
      address: chef.address,
      constructorArguments: [args.rewardToken, args.rate, args.chef]
    })

});
task('initialize-rewarder', 'Deploy admin contract')
  .addParam('rewarder', 'rewarder address')
  .addParam('owner', 'owner address')
  .setAction(async (cliArgs, { ethers, run, network }) => {

    console.log('Network')
    console.log('  ', network.name)

    await run('compile')

    // get signer

    const signer = (await ethers.getSigners())[0]
    console.log('Signer')
    console.log('  at', signer.address)
    console.log('  ETH', formatEther(await signer.getBalance()))

    // deploy contracts

    const chef = await ethers.getContractAt(
      'Rewarder',
      cliArgs.rewarder,
      signer
    )
    console.log('Transferring Ownership')
    let txResponse = await chef.transferOwnership(cliArgs.owner, true, false);
    let receipt = await txResponse.wait();
    console.log('Success')

})

task('deploy-router', 'Deploy Hypervisor contract')
  .addParam('token0', 'token address')
  .addParam('token1', 'token address')
  .addParam('pos', 'token address')
  .setAction(async (cliArgs, { ethers, run, network }) => {

    const args = {
      token0: cliArgs.token0,
      token1: cliArgs.token1, 
      pos: cliArgs.pos 
    };
    console.log('Network')
    console.log('  ', network.name)
    console.log('Task Args')
    console.log(args)

    // compile

    await run('compile')

    // get signer

    const signer = (await ethers.getSigners())[0]
    console.log('Signer')
    console.log('  at', signer.address)
    console.log('  ETH', formatEther(await signer.getBalance()))

    // deploy contracts
    const router = await deployContract(
      'Router',
      await ethers.getContractFactory('Router'),
      signer,
      [args.token0, args.token1, args.pos]
    )

    await router.deployTransaction.wait(5)
    await run('verify:verify', {
      address: router.address,
      constructorArguments: [args.token0, args.token1, args.pos]
    })
})

task('deploy-timelock', 'Deploy timelock contract')
  .addParam('chef', 'chef')
  .addParam('mindelay', 'min delay')
  .addParam('proposer', 'proposer address')
  .addParam('executor', 'exec address')
  .setAction(async (args, { ethers, run, network }) => {

    console.log('Network')
    console.log('  ', network.name)
    console.log('Task Args')
    console.log(args)

    // compile

    await run('compile')

    // get signer

    const signer = (await ethers.getSigners())[0]
    console.log('Signer')
    console.log('  at', signer.address)
    console.log('  ETH', formatEther(await signer.getBalance()))

    // deploy contracts
    const timelock = await deployContract(
      'TimeLock',
      await ethers.getContractFactory('Timelock'),
      signer,
      [args.chef, args.mindelay, [args.proposer], [args.executor]]
    )
    await timelock.deployTransaction.wait(5)
    await run('verify:verify', {
      address: timelock.address,
      constructorArguments: [args.chef, args.mindelay, [args.proposer], [args.executor]]
    })
})


task('add-chef-pool', 'Deploy admin contract')
  .addParam('chef', 'token address')
  .addParam('rewardPerBlock', 'token address')
  .addParam('lpToken', 'token address')
  .addParam('withUpdate', 'token address')
  .setAction(async (args, { ethers, run, network }) => {

    console.log('Network')
    console.log('  ', network.name)
    console.log('Task Args')
    console.log(args)

    // compile

    await run('compile')

    // get signer

    const signer = (await ethers.getSigners())[0]
    console.log('Signer')
    console.log('  at', signer.address)
    console.log('  ETH', formatEther(await signer.getBalance()))


    const chef = await ethers.getContractAt(
      'MasterChef',
      args.chef,
      signer,
    )

    await chef.add(args.rewardPerBlock, args.lpToken, args.withUpdate);
});

task('deploy-token', 'Deploy admin contract')
  // .addParam('name', 'admin account')
  // .addParam('symbol', 'advisor account')
  // .addParam('decimals', 'advisor account')
  .setAction(async (args, { ethers, run, network }) => {
    console.log('Network')
    console.log('  ', network.name)
    console.log('Task Args')
    console.log(args)

    // compile

    await run('compile')

    // get signer

    const signer = (await ethers.getSigners())[0]
    console.log('Signer')
    console.log('  at', signer.address)
    console.log('  ETH', formatEther(await signer.getBalance()))

    // deploy contracts

    const adminFactory = await ethers.getContractFactory('MintableToken')

    const admin = await deployContract(
      'MintableToken',
      await ethers.getContractFactory('MintableToken'),
      signer,
      // [args.name, args.symbol, args.decimals]
      []
    )

    await admin.deployTransaction.wait(5)
    await run('verify:verify', {
      address: admin.address,
      // constructorArguments: [args.name, args.symbol, args.decimals]
      constructorArguments: []
    })

});

task('deploy-admin', 'Deploy admin contract')
  .addParam('admin', 'admin account')
  .setAction(async (args, { ethers, run, network }) => {
    console.log('Network')
    console.log('  ', network.name)
    console.log('Task Args')
    console.log(args)

    // compile

    await run('compile')

    // get signer

    const signer = (await ethers.getSigners())[0]
    console.log('Signer')
    console.log('  at', signer.address)
    console.log('  ETH', formatEther(await signer.getBalance()))

    // deploy contracts

    const adminFactory = await ethers.getContractFactory('Admin')

    const admin = await deployContract(
      'Admin',
      await ethers.getContractFactory('Admin'),
      signer,
      [args.admin]
    )

    await admin.deployTransaction.wait(5)
    await run('verify:verify', {
      address: admin.address,
      constructorArguments: [args.admin]
    })

});

task('deploy-hypervisor-factory', 'Deploy Hypervisor contract')
  .setAction(async (cliArgs, { ethers, run, network }) => {

    const args = {
      uniswapFactory: "0x1f98431c8ad98523631ae4a59f267346ea31f984",
    };

    console.log('Network')
    console.log('  ', network.name)
    console.log('Task Args')
    console.log(args)

    // compile

    await run('compile')

    // get signer

    const signer = (await ethers.getSigners())[0]
    console.log('Signer')
    console.log('  at', signer.address)
    console.log('  ETH', formatEther(await signer.getBalance()))

    // deploy contracts

    const hypervisorFactoryFactory = await ethers.getContractFactory('HypervisorFactory')

    const hypervisorFactory = await deployContract(
      'HypervisorFactory',
      await ethers.getContractFactory('HypervisorFactory'),
      signer,
      [args.uniswapFactory]
    )

    await hypervisorFactory.deployTransaction.wait(5)
    await run('verify:verify', {
      address: hypervisorFactory.address,
      constructorArguments: [args.uniswapFactory],
    })
})
task('deploy-hyperegistry', 'Deploy registry contract')
  // .addParam('name', 'admin account')
  // .addParam('symbol', 'advisor account')
  // .addParam('decimals', 'advisor account')
  .setAction(async (args, { ethers, run, network }) => {
    console.log('Network')
    console.log('  ', network.name)
    console.log('Task Args')
    console.log(args)

    // compile

    await run('compile')

    // get signer

    const signer = (await ethers.getSigners())[0]
    console.log('Signer')
    console.log('  at', signer.address)
    console.log('  ETH', formatEther(await signer.getBalance()))

    // deploy contracts

    const adminFactory = await ethers.getContractFactory('HypeRegistry')

    const admin = await deployContract(
      'HypeRegistry',
      await ethers.getContractFactory('HypeRegistry'),
      signer,
      // [args.name, args.symbol, args.decimals]
      []
    )

    await admin.deployTransaction.wait(5)
    await run('verify:verify', {
      address: admin.address,
      // constructorArguments: [args.name, args.symbol, args.decimals]
      constructorArguments: []
    })

});
task('deploy-hypervisor-orphan', 'Deploy Hypervisor contract without factory')
  .addParam('pool', 'the uniswap pool address')
  .addParam('name', 'erc20 name')
  .addParam('symbol', 'erc2 symbol')
  .setAction(async (cliArgs, { ethers, run, network }) => {

    // compile

    await run('compile')

    // get signer

    const signer = (await ethers.getSigners())[0]
    console.log('Signer')
    console.log('  at', signer.address)
    console.log('  ETH', formatEther(await signer.getBalance()))

    const args = {
      pool: cliArgs.pool,
      owner: signer.address,
      name: cliArgs.name,
      symbol: cliArgs.symbol 
    }

    console.log('Network')
    console.log('  ', network.name)
    console.log('Task Args')
    console.log(args)

    const hypervisor = await deployContract(
      'Hypervisor',
      await ethers.getContractFactory('Hypervisor'),
      signer,
      [args.pool, args.owner, args.name, args.symbol]
    )

    await hypervisor.deployTransaction.wait(5)
    await run('verify:verify', {
      address: hypervisor.address,
      constructorArguments: [args.pool, args.owner, args.name, args.symbol],
    })

  }); 

task('deploy-hypervisor', 'Deploy Hypervisor contract via the factory')
  .addParam('factory', 'address of hypervisor factory')
  .addParam('token0', 'token0 of pair')
  .addParam('token1', 'token1 of pair')
  .addParam('fee', 'LOW, MEDIUM, or HIGH')
  .addParam('name', 'erc20 name')
  .addParam('symbol', 'erc2 symbol')
  .setAction(async (cliArgs, { ethers, run, network }) => {

    await run('compile')

    // get signer

    const signer = (await ethers.getSigners())[0]
    console.log('Signer')
    console.log('  at', signer.address)
    console.log('  ETH', formatEther(await signer.getBalance()))
    
    const args = {
      factory: cliArgs.factory,  
      token0: cliArgs.token0,
      token1: cliArgs.token1,
      fee: FeeAmount[cliArgs.fee],
      name: cliArgs.name,
      symbol: cliArgs.symbol 
    };

    console.log('Network')
    console.log('  ', network.name)
    console.log('Task Args')
    console.log(args)


    const hypervisorFactory = await ethers.getContractAt(
      'HypervisorFactory',
      args.factory,
      signer,
    )

    const hypervisor = await hypervisorFactory.createHypervisor(
      args.token0, args.token1, args.fee, args.name, args.symbol) 

  })

task('verify-hypervisor', 'Verify Hypervisor contract')
  .addParam('hypervisor', 'the hypervisor to verify')
  .addParam('pool', 'the uniswap pool address')
  .addParam('name', 'erc20 name')
  .addParam('symbol', 'erc2 symbol')
  .setAction(async (cliArgs, { ethers, run, network }) => {

    console.log('Network')
    console.log('  ', network.name)

    await run('compile')

    // get signer

    const signer = (await ethers.getSigners())[0]
    console.log('Signer')
    console.log('  at', signer.address)
    console.log('  ETH', formatEther(await signer.getBalance()))

    const args = {
      pool: cliArgs.pool,
      owner: signer.address,
      name: cliArgs.name,
      symbol: cliArgs.symbol 
    }

    console.log('Task Args')
    console.log(args)

    const hypervisor = await ethers.getContractAt(
      'Hypervisor',
      cliArgs.hypervisor,
      signer,
    )
    await run('verify:verify', {
      address: hypervisor.address,
      constructorArguments: Object.values(args),
    })

  });

  task('deploy-clearing', 'Deploy UniProxy contract')
  .setAction(async (cliArgs, { ethers, run, network }) => {

    await run('compile')

    // get signer

    const signer = (await ethers.getSigners())[0]
    console.log('Signer')
    console.log('  at', signer.address)
    console.log('  ETH', formatEther(await signer.getBalance()))

    console.log('Network')
    console.log('  ', network.name)

    const uniProxyFactory = await ethers.getContractFactory('Clearing')

    const uniProxy = await deployContract(
      'Clearing',
      uniProxyFactory,
      signer
    )

    await uniProxy.deployTransaction.wait(5)
    await run('verify:verify', {
      address: uniProxy.address
    })
  })
  task('deploy-clearingv2', 'Deploy ClearingV2 contract')
  .addParam('owner', 'the owner address')
  .setAction(async (cliArgs, { ethers, run, network }) => {

    await run('compile')

    // get signer

    const signer = (await ethers.getSigners())[0]
    console.log('Signer')
    console.log('  at', signer.address)
    console.log('  ETH', formatEther(await signer.getBalance()))

    console.log('Network')
    console.log('  ', network.name)

    const uniProxyFactory = await ethers.getContractFactory('ClearingV2')

    const uniProxy = await deployContract(
      'ClearingV2',
      uniProxyFactory,
      signer
    )

    await uniProxy.deployTransaction.wait(5)
    await uniProxy.transferOwnership(cliArgs.owner);
    await run('verify:verify', {
      address: uniProxy.address
    })
  })
  task('deploy-clearingv3', 'Deploy ClearingV3 contract')
  .addParam('owner', 'the owner address')
  .setAction(async (cliArgs, { ethers, run, network }) => {

    await run('compile')

    // get signer

    const signer = (await ethers.getSigners())[0]
    console.log('Signer')
    console.log('  at', signer.address)
    console.log('  ETH', formatEther(await signer.getBalance()))

    console.log('Network')
    console.log('  ', network.name)

    const uniProxyFactory = await ethers.getContractFactory('ClearingV3')

    const uniProxy = await deployContract(
      'ClearingV2',
      uniProxyFactory,
      signer
    )

    await uniProxy.deployTransaction.wait(5)
    await uniProxy.transferOwnership(cliArgs.owner);
    await run('verify:verify', {
      address: uniProxy.address
    })
  })

  task('transfer-ownership', 'Transfer ownership for any contract')
  .addParam('owner', 'the owner address')
  .addParam('contract', 'the contract address')
  .setAction(async ({ owner, contract }, { ethers, run, network }) => {

    await run('compile')

    // Log the network
    console.log('Network')
    console.log('  ', network.name)

    // Get the signer
    const signer = (await ethers.getSigners())[0];
    console.log('Signer');
    console.log('  at', signer.address);
    console.log('  ETH', ethers.utils.formatEther(await signer.getBalance()));

    // ABI for interacting with any contract that has a `transferOwnership` function
    const abi = [
      "function transferOwnership(address newOwner) external"
    ];

    // Connect to the contract using the ABI and the address of the contract
    const contractInstance = new ethers.Contract(contract, abi, signer);

    // Execute the transferOwnership function to transfer ownership to the new owner
    await contractInstance.transferOwnership(owner);

    console.log(`Ownership of contract at ${contract} transferred to ${owner}`);
  });

  task('transfer-clearance', 'Transfer clearance from the UniProxy contract')
  .addParam('uniproxy', 'the uniproxy address')
  .addParam('clearing', 'the clearing address')
  .setAction(async ({ uniproxy, clearing }, { ethers, run, network }) => {

    await run('compile')

    // Log the network
    console.log('Network')
    console.log('  ', network.name)

    // Get the signer
    const signer = (await ethers.getSigners())[0];
    console.log('Signer');
    console.log('  at', signer.address);
    console.log('  ETH', ethers.utils.formatEther(await signer.getBalance()));

    // ABI for interacting with any contract that has a `transferOwnership` function
    const abi = [
      "function transferClearance(address newClearance) external"
    ];

    // Connect to the contract using the ABI and the address of the contract
    const contractInstance = new ethers.Contract(uniproxy, abi, signer);

    // Execute the transferOwnership function to transfer ownership to the new owner
    await contractInstance.transferClearance(clearing);

    console.log(`Clearance of UniProxy at ${uniproxy} transferred to ${clearing}`);
  });

  task('deploy-clearingtest', 'Deploy UniProxy contract')
  .setAction(async (cliArgs, { ethers, run, network }) => {

    await run('compile')

    // get signer

    const signer = (await ethers.getSigners())[0]
    console.log('Signer')
    console.log('  at', signer.address)
    console.log('  ETH', formatEther(await signer.getBalance()))

    console.log('Network')
    console.log('  ', network.name)

    const uniProxyFactory = await ethers.getContractFactory('ClearingTest')

    const uniProxy = await deployContract(
      'Clearing',
      uniProxyFactory,
      signer
    )

    await uniProxy.deployTransaction.wait(5)
    await run('verify:verify', {
      address: uniProxy.address
    })
  })

  task('deploy-uniproxy', 'Deploy UniProxy contract')
  .addParam('clearing', 'the UniProxy to verify')
  .addParam('owner', 'the owner')
  .setAction(async (args, { ethers, run, network }) => {

    await run('compile')

    // get signer

    const signer = (await ethers.getSigners())[0]
    console.log('Signer')
    console.log('  at', signer.address)
    console.log('  ETH', formatEther(await signer.getBalance()))

    console.log('Network')
    console.log('  ', network.name)

    const uniProxyFactory = await ethers.getContractFactory('UniProxy')

    const uniProxy = await deployContract(
      'UniProxy',
      uniProxyFactory,
      signer,
			[args.clearing]
    )

    await uniProxy.deployTransaction.wait(5)
    await uniProxy.transferOwnership(args.owner);
    await run('verify:verify', {
      address: uniProxy.address,
			constructorArguments: [args.clearing]
    })
  })

  // task('deploy-uniproxyv2', 'Deploy UniProxy contract')
  // .addParam('clearing', 'the UniProxy to verify')
  // .addParam('owner', 'the owner')
  // .setAction(async (args, { ethers, run, network }) => {

  //   await run('compile')

  //   // get signer

  //   const signer = (await ethers.getSigners())[0]
  //   console.log('Signer')
  //   console.log('  at', signer.address)
  //   console.log('  ETH', formatEther(await signer.getBalance()))

  //   console.log('Network')
  //   console.log('  ', network.name)

  //   const uniProxyFactory = await ethers.getContractFactory('UniProxyV2')

  //   const uniProxy = await deployContract(
  //     'UniProxy',
  //     uniProxyFactory,
  //     signer,
	// 		[args.clearing]
  //   )

  //   await uniProxy.deployTransaction.wait(5)
  //   await uniProxy.transferOwnership(args.owner);
  //   await run('verify:verify', {
  //     address: uniProxy.address,
	// 		constructorArguments: [args.clearing]
  //   })
  // })


  task('deploy-rebalanceproxy', 'Deploy RebalanceProxy contract')
  .addParam('owner', 'the owner')
  .setAction(async (args, { ethers, run, network }) => {

    await run('compile')

    // get signer

    const signer = (await ethers.getSigners())[0]
    console.log('Signer')
    console.log('  at', signer.address)
    console.log('  ETH', formatEther(await signer.getBalance()))

    console.log('Network')
    console.log('  ', network.name)

    const rebalanceProxyContract = await ethers.getContractFactory('RebalanceProxy')

    const rebalanceProxy = await deployContract(
      'RebalanceProxy',
      rebalanceProxyContract,
      signer,
			[args.owner]
    )

    await rebalanceProxy.deployTransaction.wait(5)
    await run('verify:verify', {
      address: rebalanceProxy.address,
			constructorArguments: [args.owner]
    })
  })



  task('deploy-uniproxyv2', 'Deploy UniProxyV2 contract')
  .addParam('keeper', 'the keeper address')
  .addParam('clearing', 'the ClearingV2 to verify')
  .setAction(async (args, { ethers, run, network }) => {

    await run('compile')

    // get signer

    const signer = (await ethers.getSigners())[0]
    console.log('Signer')
    console.log('  at', signer.address)
    console.log('  ETH', formatEther(await signer.getBalance()))

    console.log('Network')
    console.log('  ', network.name)

    const uniProxyFactory = await ethers.getContractFactory('UniProxyV2')

    const uniProxy = await deployContract(
      'UniProxyV2',
      uniProxyFactory,
      signer,
			[args.clearing,args.keeper]
    )

    await uniProxy.deployTransaction.wait(5)
    await run('verify:verify', {
      address: uniProxy.address,
			constructorArguments: [args.clearing,args.keeper]
    })
  })

  task('deploy-uniproxytest', 'Deploy UniProxy contract')
  .addParam('clearing', 'the UniProxy to verify')
  .setAction(async (args, { ethers, run, network }) => {

    await run('compile')

    // get signer

    const signer = (await ethers.getSigners())[0]
    console.log('Signer')
    console.log('  at', signer.address)
    console.log('  ETH', formatEther(await signer.getBalance()))

    console.log('Network')
    console.log('  ', network.name)

    const uniProxyFactory = await ethers.getContractFactory('UniProxyTest')

    const uniProxy = await deployContract(
      'UniProxy',
      uniProxyFactory,
      signer,
			[args.clearing]
    )

    await uniProxy.deployTransaction.wait(5)
    await run('verify:verify', {
      address: uniProxy.address,
			constructorArguments: [args.clearing]
    })
  })

task('verify-uniproxy', 'Verify UniProxy contract')
  .addParam('uniproxy', 'the UniProxy to verify')
  .setAction(async (cliArgs, { ethers, run, network }) => {

    await run('compile')

    // get signer

    const signer = (await ethers.getSigners())[0]
    console.log('Signer')
    console.log('  at', signer.address)
    console.log('  ETH', formatEther(await signer.getBalance()))

    console.log('Network')
    console.log('  ', network.name)

    const uniProxy = await ethers.getContractAt(
      'UniProxy',
      cliArgs.uniproxy,
      signer,
    )

    await run('verify:verify', {
      address: uniProxy.address
    })
  })

  task('initialize-hypervisor', 'Initialize Hypervisor contract')
  .addParam('hypervisor', 'the hypervisor')
  .addParam('amount0', 'the amount of token0')
  .addParam('amount1', 'the amount of token1')
  .addParam('uniproxy', 'the uniproxy')
  .addParam('admin', 'the admin address')
  // .addParam('hyperegistry', 'the hyperegistry')
  .setAction(async (cliArgs, { ethers, run, network }) => {

    console.log('Network')
    console.log('  ', network.name)

    await run('compile')

    // get signer

    const signer = (await ethers.getSigners())[0]
    console.log('Signer')
    console.log('  at', signer.address)
    console.log('  ETH', formatEther(await signer.getBalance()))

    const args = {
      hypervisor: cliArgs.hypervisor,
      owner: signer.address,
      amount0: cliArgs.amount0,
      amount1: cliArgs.amount1,
      uniproxy: cliArgs.uniproxy,
      admin: cliArgs.admin,
      hyperegistry: cliArgs.hyperegistry
    }

    console.log('Task Args')
    console.log(args)

    const hypervisor = await ethers.getContractAt(
      'Hypervisor',
      cliArgs.hypervisor,
      signer,
    )

    const uniproxy = await ethers.getContractAt(
      'UniProxy',
      cliArgs.uniproxy,
      signer,
    )

    const token0 = await ethers.getContractAt(
      'ERC20',
      await hypervisor.token0(),
      signer
    )


    const token1 = await ethers.getContractAt(
      'ERC20',
      await hypervisor.token1(),
      signer
    )

    // const hyperegistry = await ethers.getContractAt(
    //   'HypeRegistry',
    //   cliArgs.hyperegistry,
    //   signer,
    // )
    console.log('Signer')
    console.log('  at', signer.address)



    // Set Whitelist
    // console.log('Adding to HypeRegistry ...')
    // //await hypervisor.setWhitelist(signer.address)
    // let txResponseFirst = await hyperegistry.add(cliArgs.hypervisor);
    // let receiptFirst = await txResponseFirst.wait();

    console.log('Success')
    console.log('Signer')
    console.log('  at', signer.address)
    console.log(' ', (await token0.symbol()), ' ', formatUnits(await token0.balanceOf(signer.address), await token0.decimals()))
    console.log(' ', (await token1.symbol()), ' ', formatUnits(await token1.balanceOf(signer.address), await token1.decimals()))

    // // Token Approval
    // console.log('Token Approving...')
    // let txResponse0 = await token0.approve(hypervisor.address, parseUnits(cliArgs.amount0, (await token0.decimals())));
    // let receipt0 = await txResponse0.wait();
    // let txResponse1 = await token1.approve(hypervisor.address, ethers.utils.parseUnits(cliArgs.amount1, (await token1.decimals())));
    // let receipt1 = await txResponse1.wait();
    // //await token0.approve(hypervisor.address, parseUnits(cliArgs.amount0, (await token0.decimals())))
    // //await token1.approve(hypervisor.address, parseUnits(cliArgs.amount1, (await token1.decimals())))
    // console.log('Approval Success')

    // // Set Whitelist
    // console.log('Whitelist Signer...')
    // //await hypervisor.setWhitelist(signer.address)
    // let txResponse2 = await hypervisor.setWhitelist(signer.address);
    // let receipt2 = await txResponse2.wait();
    // console.log('Success')

    // // Make First Deposit
    // console.log('First Depositing...')

    // let txResponse3 = await hypervisor.deposit(
    //   ethers.utils.parseUnits(cliArgs.amount0, (await token0.decimals())),
    //   ethers.utils.parseUnits(cliArgs.amount1, (await token1.decimals())),
    //   signer.address,
    //   signer.address,
    //   [0, 0, 0, 0]
    // );
    
    // let receipt3 = await txResponse3.wait();
    // console.log('Success')

    // Rebalance
    console.log('Rebalancing')


   let txResponse4 = await hypervisor.rebalance(
    -887220,
    887220,
    -6000,
    6000,
    signer.address,
    [0, 0, 0, 0],
    [0, 0, 0, 0]
  );
  
  let receipt4 = await txResponse4.wait();
  
    console.log('Success')

    // Whitelist uniproxy
    console.log('Whitelist uniproxy')
   // await hypervisor.setWhitelist(cliArgs.uniproxy)
    let txResponse5 = await hypervisor.setWhitelist(cliArgs.uniproxy);
    let receipt5 = await txResponse5.wait();

   console.log('Success')

  //  console.log('Add to uniproxy');
  //  await uniproxy.addPosition(hypervisor.address,4);
  //  console.log('Success')

    // TransferOnwership
    console.log('Transferring Ownership')
    //await hypervisor.transferOwnership(cliArgs.admin)
    let txResponse6 = await hypervisor.transferOwnership(cliArgs.admin);
    let receipt6 = await txResponse6.wait();

    console.log('Success')

  });

  task('add-hypereg', 'Add to HypeRegistry')
  .addParam('hype', 'the hypervisor')
  .addParam('hypereg', 'the hyperegistry contract')
  .setAction(async (cliArgs, { ethers, run, network }) => {

    console.log('Network')
    console.log('  ', network.name)

    await run('compile')

    // get signer

    const signer = (await ethers.getSigners())[0]
    console.log('Signer')
    console.log('  at', signer.address)
    console.log('  ETH', formatEther(await signer.getBalance()))

    const args = {
      hype: cliArgs.hype,
      owner: signer.address,
      hypereg: cliArgs.hypereg,
    }

    console.log('Task Args')
    console.log(args)


    const hyperegistry = await ethers.getContractAt(
      'HypeRegistry',
      cliArgs.hypereg,
      signer,
    )
    console.log('Signer')
    console.log('  at', signer.address)



    // Set Whitelist
    console.log('Adding to HypeRegistry ...')
    //await hypervisor.setWhitelist(signer.address)
    let txResponse2 = await hyperegistry.add(cliArgs.hype);
    let receipt2 = await txResponse2.wait();
    console.log('Success')


  });

  task('add-clearing', 'Initialize Hypervisor contract')
  .addParam('hypervisor', 'the hypervisor')
  .addParam('clearing', 'the clearing')
  .setAction(async (cliArgs, { ethers, run, network }) => {

    console.log('Network')
    console.log('  ', network.name)

    await run('compile')

    // get signer

    const signer = (await ethers.getSigners())[0]
    console.log('Signer')
    console.log('  at', signer.address)
    console.log('  ETH', formatEther(await signer.getBalance()))

    const args = {
      hypervisor: cliArgs.hypervisor,
      owner: signer.address,
      clearing: cliArgs.clearing,
    }

    console.log('Task Args')
    console.log(args)

    const hypervisor = await ethers.getContractAt(
      'Hypervisor',
      cliArgs.hypervisor,
      signer,
    )

    const clearing = await ethers.getContractAt(
      'ClearingV2',
      cliArgs.clearing,
      signer,
    )


    console.log('Signer')
    console.log('  at', signer.address)


  //  console.log('Add to clearing');
  //  let txResponse = await clearing.addPosition(hypervisor.address,4);
  //  let response1 = txResponse.wait();
  //  console.log('Success')
   
   console.log('set deposit override');
   let txResponse2 = await clearing.setDepositOverride(hypervisor.address, "false");
   let response2=txResponse2.wait();
   console.log('Success')

  //  console.log('set twap override');
  //  let txResponse3 = await clearing.setTwapOverride(hypervisor.address, "true", 3600, 10100);
  //  let response3 = txResponse3.wait();
  //  console.log('Success')


  });
  task('set-whitelist', 'Initialize Hypervisor contract')
  .addParam('hypervisor', 'the hypervisor')
  // .addParam('admin', 'the clearing')
  .setAction(async (cliArgs, { ethers, run, network }) => {

    console.log('Network')
    console.log('  ', network.name)

    await run('compile')

    // get signer

    const signer = (await ethers.getSigners())[0]
    console.log('Signer')
    console.log('  at', signer.address)
    console.log('  ETH', formatEther(await signer.getBalance()))

    const args = {
      hypervisor: cliArgs.hypervisor,
      owner: signer.address
      // admin: cliArgs.admin,
    }

    console.log('Task Args')
    console.log(args)

    const hypervisor = await ethers.getContractAt(
      'Hypervisor',
      cliArgs.hypervisor,
      signer,
    )

    // const admin = await ethers.getContractAt(
    //   'Admin',
    //   cliArgs.admin,
    //   signer,
    // )


    console.log('Signer')
    console.log('  at', signer.address)

    console.log('Whitelist Signer...')
    //await hypervisor.setWhitelist(signer.address)
    let txResponse1 = await hypervisor.removeWhitelisted();
    let receipt2 = await txResponse1.wait();
    console.log('Success')
  //  console.log('Add to clearing');
  //  let txResponse = await clearing.addPosition(hypervisor.address,4);
  //  let response1 = txResponse.wait();
  //  console.log('Success')
   
  //  console.log('set deposit override');
  //  let txResponse2 = await clearing.setDepositOverride(hypervisor.address, "true");
  //  let response2=txResponse2.wait();
  //  console.log('Success')

  //  console.log('set twap override');
  //  let txResponse3 = await clearing.setTwapOverride(hypervisor.address, "true", 3600, 10100);
  //  let response3 = txResponse3.wait();
  //  console.log('Success')


  });
