import { formatEther} from 'ethers/lib/utils'
import { task } from 'hardhat/config'
import { deployContract } from './utils'

task('deploy-feerecip', 'Deploy FeeRecipient contract')
  .addParam('owner', "your multisig address")
  .addParam('feemanager', "OZ account")
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
    const _feeManager = ethers.utils.getAddress(cliArgs.feemanager);
    const _recipient1 = ethers.utils.getAddress(cliArgs.recipient1);
    const _recipient2 = ethers.utils.getAddress(cliArgs.recipient2);


    // TODO cli args
    // goerli
    const args = {
      _owner,
      _feeManager,
      _recipient1,
      _recipient2,
    };

    console.log('Network')
    console.log('  ', network.name)
    console.log('Task Args')
    console.log(args)

    const send = await deployContract(
      'FeeRecipient',
      await ethers.getContractFactory('FeeRecipient'),
      signer,
      Object.values(args)
    );

    await send.deployTransaction.wait(5)
    await run('verify:verify', {
      address: send.address,
      constructorArguments: Object.values(args),
    })

  }); 

  task('deploy-feerecip2', 'Deploy FeeRecipientV2 contract')
  .addParam('owner', "Your multisig address")
  .addParam('feemanager', "OZ account")
  .addParam('recipients', "List of recipient addresses in JSON array format")
  .addParam('recipientshares', "List of recipient shares in JSON array format")
  .setAction(async (cliArgs, { ethers, run, network }) => {
    // compile
    await run('compile');

    // get signer
    const signer = (await ethers.getSigners())[0];
    console.log('Signer');
    console.log('  at', signer.address);
    console.log('  ETH', ethers.utils.formatEther(await signer.getBalance()));

    // Deploy the contract with the signer as the initial owner
    const FeeRecipient = await ethers.getContractFactory('FeeRecipientV2');
    const feeRecipient = await FeeRecipient.deploy(signer.address, cliArgs.feemanager);

    console.log('Deploying contract, please wait...');
    await feeRecipient.deployed();
    console.log('Contract deployed to:', feeRecipient.address);

    // Add each recipient and their share
    for (let i = 0; i < JSON.parse(cliArgs.recipients).length; i++) {
      await feeRecipient.addRecipient(JSON.parse(cliArgs.recipients)[i], JSON.parse(cliArgs.recipientshares)[i]);
      console.log(`Recipient ${JSON.parse(cliArgs.recipients)[i]} with share ${JSON.parse(cliArgs.recipientshares)[i]} added`);
    }

    // Transfer ownership to the specified owner
    const _owner = ethers.utils.getAddress(cliArgs.owner);
    await feeRecipient.transferOwnership(_owner);
    console.log(`Ownership transferred to: ${_owner}`);

    // Verify the contract
    await run('verify:verify', {
      address: feeRecipient.address,
      constructorArguments: [signer.address, cliArgs.feemanager],
    });
  });

