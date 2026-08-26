import '@nomiclabs/hardhat-ethers'
import '@nomiclabs/hardhat-etherscan'
import '@nomiclabs/hardhat-waffle'
import '@typechain/hardhat'
import "hardhat-watcher"
import './scripts/copy-uniswap-v3-artifacts.ts'
import './tasks/hypervisor'
import './tasks/swap'
import { parseUnits } from 'ethers/lib/utils'
import { HardhatUserConfig } from 'hardhat/types'
require('dotenv').config()
const mnemonic = process.env.DEV_MNEMONIC || ''
// Only attach an account when its key is set, so unused remote networks don't
// fail hardhat's config-load validation ("Expected string, received undefined").
const pk = (k?: string): string[] => (k ? [k] : [])

const config: HardhatUserConfig = {
  networks: {
      hardhat: {
        allowUnlimitedContractSize: false,
      },
      // Local HydraDX zombienet (Frontier EVM). Deployer = Charlie's EVM key,
      // funded with WETH (gas) + KSM/KUSD and whitelisted as ContractDeployer by
      // the uniswap-v3-deploy phase. Local dev key only.
      zombienet: {
        url: process.env.EVM_RPC_URL || "http://127.0.0.1:9999",
        chainId: 2222222,
        accounts: [
          process.env.DEPLOYER_PK ||
            "0x653a29ac0c93de0e9f7d7ea2d60338e68f407b18d16d6ff84db996076424f8fa",
        ],
        timeout: 120000,
      },
      // lark4 testnet (mainnet fork, chainId 222222). Deployer = Anvil#0
      // (CREATE-whitelisted + funded); second account = BOB (Anvil#1).
      lark4: {
        url: process.env.LARK_RPC_URL || "https://node4.lark.hydration.cloud",
        chainId: 222222,
        accounts: [
          process.env.DEPLOYER_PK ||
            "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
          process.env.BOB_PK ||
            "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
        ],
        timeout: 300000,
      },
      celo: {
        url: "https://forno.celo.org",
        accounts: pk(process.env.MAINNET_PRIVATE_KEY),
        chainId: 42220
      },    
    polygon: {
        url: 'https://polygon-mainnet.g.alchemy.com/v2/' + process.env.ALCHEMY_POLYGON,
        accounts: pk(process.env.MAINNET_PRIVATE_KEY),
        gasPrice: parseUnits('300', 'gwei').toNumber(),
    },
    mainnet: {
        url: 'https://eth-mainnet.alchemyapi.io/v2/' + process.env.ALCHEMY_MAINNET,
        accounts: pk(process.env.MAINNET_PRIVATE_KEY),
        gasPrice: parseUnits('40', 'gwei').toNumber(),
      },
    optimism: {
        url: 'https://opt-mainnet.g.alchemy.com/v2/' + process.env.ALCHEMY_OPTIMISM,
        accounts: pk(process.env.MAINNET_PRIVATE_KEY),
        gasPrice: parseUnits('100', 'gwei').toNumber(),
      },
    arbitrum: {
        url: 'https://arb-mainnet.g.alchemy.com/v2/' + process.env.ALCHEMY_ARBITRUM,
        accounts: pk(process.env.MAINNET_PRIVATE_KEY),
        gasPrice: parseUnits('10', 'gwei').toNumber(),
      },

  },
  watcher: {
      compilation: {
          tasks: ["compile"],
      }
  },
  solidity: {
      compilers: [
        {
            version: '0.7.6',
            settings: {
                optimizer: {
                    enabled: true,
                    runs: 800,
                },
                metadata: {
                    bytecodeHash: 'none',
                },
            },
        },
        { version: '0.6.11' },
        { version: '0.6.0' },
        { version: '0.6.2' },
        { version: '0.6.12' },
      ],
  },
  etherscan: {
    apiKey: process.env.CELO_APIKEY,
    // apiKey: process.env.ETHERSCAN_APIKEY,
    // apiKey: process.env.OPTIMISM_APIKEY,
    // apiKey: process.env.ARBISCAN_APIKEY,
    // apiKey: process.env.POLYGONSCAN_APIKEY,
  },
  mocha: {
    timeout: 2000000
  }
}
export default config;
