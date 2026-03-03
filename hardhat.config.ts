import '@nomiclabs/hardhat-ethers'
import '@nomiclabs/hardhat-etherscan'
import '@nomiclabs/hardhat-waffle'
import '@typechain/hardhat'
import "hardhat-watcher"
import './scripts/copy-uniswap-v3-artifacts.ts'
import './tasks/hypervisor'
import './tasks/swap'
import './tasks/send'
import './tasks/feerecipient'
import { parseUnits } from 'ethers/lib/utils'
import { HardhatUserConfig } from 'hardhat/types'
require('dotenv').config()
const mnemonic = process.env.DEV_MNEMONIC || ''

const config: HardhatUserConfig = {
  networks: {
      hardhat: {
        allowUnlimitedContractSize: false,
      },
      polygon: {
        url: 'https://polygon-mainnet.g.alchemy.com/v2/VU6_Meq6eWSZ8lyqtxBI3WYsqNVwPXUM',
        accounts: [process.env.MAINNET_PRIVATE_KEY as string],
        gasPrice: parseUnits('500', 'gwei').toNumber(),
      },
      mainnet: {
        url: 'https://eth-mainnet.g.alchemy.com/v2/4-9c9H-ltSW8qTuPTvSIU9YIin9D_pDd',
        accounts: [process.env.MAINNET_PRIVATE_KEY as string],
        gasPrice: parseUnits('6', 'gwei').toNumber(),
      },
      optimism: {
        url: 'https://1rpc.io/op',
        accounts: [process.env.MAINNET_PRIVATE_KEY as string],
      },
      arbitrum: {
        url: 'https://arb-mainnet.g.alchemy.com/v2/TPKGEg2bTW6KUSA0eygLN4JNeebYiyLe',
        accounts: [process.env.MAINNET_PRIVATE_KEY as string],
        gasPrice: parseUnits('1', 'gwei').toNumber(),
      },
      celo: {
        url: "https://forno.celo.org",
        accounts: [process.env.MAINNET_PRIVATE_KEY as string],
        chainId: 42220
      },
	    bsc: {
      url: 'https://bsc-mainnet.nodereal.io/v1/c90506ed63514e5e8f9fcd7e7ea2aacd',
      accounts: [process.env.MAINNET_PRIVATE_KEY as string], 
      gasPrice: parseUnits('3', 'gwei').toNumber(),
      },
      zkevm: {
        url: 'https://polygonzkevm-mainnet.g.alchemy.com/v2/6MaZoczRQ_jD1PEuDHSv818Yc7LUpUWM',
        accounts: [process.env.MAINNET_PRIVATE_KEY as string],
      },
      moonbeam: {
        url: 'https://moonbeam.api.onfinality.io/public',
        accounts: [process.env.MAINNET_PRIVATE_KEY as string],
        gasPrice: parseUnits('300', 'gwei').toNumber(),
      },
      kava: {
        url: 'https://kava-evm.publicnode.com',
        accounts: [process.env.MAINNET_PRIVATE_KEY as string],
        gasPrice: parseUnits('10', 'gwei').toNumber(),
      },
      manta: {
        url: 'https://pacific-rpc.manta.network/http',
        accounts: [process.env.MAINNET_PRIVATE_KEY as string],
        gasPrice: parseUnits('1', 'gwei').toNumber(),
      },
      base: {
        url: 'https://base-mainnet.g.alchemy.com/v2/XzGrCLsKf3U4sVEH1sVrkNINWYfvBvE0',
        accounts: [process.env.MAINNET_PRIVATE_KEY as string],
      },
      opbnb: {
        url: 'https://opbnb-mainnet.nodereal.io/v1/35532b74bba644158b8515755bfa49e2',
        accounts: [process.env.MAINNET_PRIVATE_KEY as string],
        gasPrice: parseUnits('0.00005', 'gwei').toNumber(),
      },
      linea: {
        url: 'https://linea-mainnet.infura.io/v3/4eecb9679beb476e92d378a4c8cfeeb7',
        accounts: [process.env.MAINNET_PRIVATE_KEY as string],
      },
      astar: {
        url: 'https://rpc.startale.com/astar-zkevm',
        accounts: [process.env.MAINNET_PRIVATE_KEY as string],
        gasPrice: parseUnits('2', 'gwei').toNumber(),
      },
      immutable: {
        url: 'https://rpc.immutable.com',
        accounts: [process.env.MAINNET_PRIVATE_KEY as string],
        gasPrice: parseUnits('10', 'gwei').toNumber(),
      },
      zkevm: {
        url: 'https://polygonzkevm-mainnet.g.alchemy.com/v2/6MaZoczRQ_jD1PEuDHSv818Yc7LUpUWM',
        accounts: [process.env.MAINNET_PRIVATE_KEY as string],
        gasPrice: parseUnits('10', 'gwei').toNumber(),
        timeout: 60000
      },
      avalanche: {
        url: 'https://open-platform.nodereal.io/e28f5a1ed30a49209126892ced24d74b/avalanche-c/ext/bc/C/rpc',
        accounts: [process.env.MAINNET_PRIVATE_KEY as string],
        gasPrice: parseUnits('28', 'gwei').toNumber(),
      },
      blast: {
        url: 'https://rpc.blast.io',
        accounts: [process.env.MAINNET_PRIVATE_KEY as string],
        gasPrice: parseUnits('0.00000039', 'gwei').toNumber(),
      },
      scroll: {
        url: 'https://rpc.scroll.io',
        accounts: [process.env.MAINNET_PRIVATE_KEY as string],
        gasPrice: parseUnits('0.60', 'gwei').toNumber(),
      },
      linea: {
        url: 'https://linea.decubate.com',
        accounts: [process.env.MAINNET_PRIVATE_KEY as string],
      },
      mantle: {
        url: 'https://rpc.mantle.xyz',
        chainId: 5000,
        accounts: [process.env.MAINNET_PRIVATE_KEY as string],
        gasPrice: parseUnits('0.07', 'gwei').toNumber(),
     },
     rootstock: {
      url: 'https://public-node.rsk.co',
      accounts: [process.env.MAINNET_PRIVATE_KEY as string],
    },
    taiko: {
      url: 'https://rpc.mainnet.taiko.xyz',
      accounts: [process.env.MAINNET_PRIVATE_KEY as string],
    },
    zklink: {
      url: 'https://rpc.zklink.io',
      accounts: [process.env.MAINNET_PRIVATE_KEY as string],
    },
    sei: {
      url: 'https://evm-rpc.sei-apis.com',
      accounts: [process.env.MAINNET_PRIVATE_KEY as string],
    },
    seitestnet: {
      url: 'https://evm-rpc-testnet.sei-apis.com',
      accounts: [process.env.MAINNET_PRIVATE_KEY as string],
    },
    iota: {
      url: 'https://iota-mainnet-evm.public.blastapi.io',
      accounts: [process.env.MAINNET_PRIVATE_KEY as string],
    },
    xlayer: {
      url: 'https://xlayerrpc.okx.com',
      accounts: [process.env.MAINNET_PRIVATE_KEY as string],
    },
    zircuit: {
      url: 'https://zircuit1-mainnet.p2pify.com',
      accounts: [process.env.MAINNET_PRIVATE_KEY as string],
    },
    core: {
      url: 'https://core.public.infstones.com',
      accounts: [process.env.MAINNET_PRIVATE_KEY as string],
    },
    gnosis: {
      url: 'https://gnosis-mainnet.public.blastapi.io',
      accounts: [process.env.MAINNET_PRIVATE_KEY as string],
    },
    berachain: {
      url: 'https://bartio.rpc.berachain.com',
      accounts: [process.env.MAINNET_PRIVATE_KEY as string],
    },
    worldchain: {
      url: 'https://worldchain-mainnet.g.alchemy.com/public',
      accounts: [process.env.MAINNET_PRIVATE_KEY as string],
    },
    sonic: {
      url: 'https://sonic.drpc.org',
      accounts: [process.env.MAINNET_PRIVATE_KEY as string],
    }, 
    bob: {
      url: 'https://rpc.gobob.xyz',
      accounts: [process.env.MAINNET_PRIVATE_KEY as string],
      gasPrice: 1000000000,  // 1 gwei minimum
      // Optional but recommended gas settings
      gas: "auto",
      gasMultiplier: 1.2
    }, 
    unichain: {
      url: 'https://unichain-rpc.publicnode.com',
      accounts: [process.env.MAINNET_PRIVATE_KEY as string],
    }, 
    nibiru: {
      url: 'https://evm-rpc.nibiru.fi',
      accounts: [process.env.MAINNET_PRIVATE_KEY as string],
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
    // apiKey: process.env.ETHERSCAN_APIKEY,
        apiKey: process.env.UNISCAN_APIKEY,
    // apiKey: process.env.OPTIMISM_APIKEY,
  //  apiKey: process.env.ARBISCAN_APIKEY,
  //   // apiKey: process.env.POLYGONSCAN_APIKEY,
    // apiKey: process.env.MOONSCAN_APIKEY,
    // apiKey: process.env.CELO_APIKEY,
    // apiKey: process.env.LINEASCAN_APIKEY,
 	// apiKey: process.env.BSCSCAN_APIKEY,
  //    apiKey: process.env.ZKEVM_APIKEY,
      //  apiKey: process.env.SCROLLSCAN_APIKEY,
  //  apiKey: {
  //   avalanche:  process.env.AVAX_APIKEY,
  //  }
  // apiKey: process.env.BLASTSCAN_APIKEY,
  // apiKey: process.env.BASESCAN_APIKEY,
      customChains: [
        {
          network: "unichain",
          chainId:  130,
          urls: {
            apiURL: "https://uniscan.xyz/api",
            browserURL: "https://uniscan.xyz/" 
          }
        }
      ]
  },
  mocha: {
    timeout: 2000000
  }
}
export default config;
