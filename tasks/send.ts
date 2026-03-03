import { formatEther} from 'ethers/lib/utils'
import { task } from 'hardhat/config'
import { deployContract } from './utils'

task('deploy-send', 'Deploy Send contract')
  .addParam('owner', "your multisig address")
  .addParam('recipient1', "Gamma Address")
  .addParam('recipient2', "Thena address")
  .setAction(async (cliArgs, { ethers, run, network }) => {
    // compile

    await run('compile')

    // get signer

    const signer = (await ethers.getSigners())[0]
    console.log('Signer')
    console.log('  at', signer.address)
    console.log('  ETH', formatEther(await signer.getBalance()))

    const _owner = ethers.utils.getAddress(cliArgs.owner);
    const _recipient1 = ethers.utils.getAddress(cliArgs.recipient1);
    const _recipient2 = ethers.utils.getAddress(cliArgs.recipient2);


    // TODO cli args
    // goerli
    const args = {
      _owner,
      _recipient1,
      _recipient2,
    };

    console.log('Network')
    console.log('  ', network.name)
    console.log('Task Args')
    console.log(args)

    const send = await deployContract(
      'Send',
      await ethers.getContractFactory('Send'),
      signer,
      Object.values(args)
    );

    await send.deployTransaction.wait(5)
    await run('verify:verify', {
      address: send.address,
      constructorArguments: Object.values(args),
    })

  }); 

