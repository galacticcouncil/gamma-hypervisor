// PoolAnchor on a fork of Hydration mainnet, at blocks where the atBTC/HOLLAR pool really sat stuck off the oracle.
// Skipped unless FORK_RPC_URL is an archive node: FORK_RPC_URL=https://rpc.hydradx.cloud npx hardhat test test/PoolAnchor.fork.test.ts

import { ethers, network } from 'hardhat'
import { BigNumber, Contract, Signer } from 'ethers'
import chai, { expect } from 'chai'
import { solidity } from 'ethereum-waffle'
import { PoolAnchor } from '../typechain'

chai.use(solidity)

const RPC = process.env.FORK_RPC_URL
const POOL = '0xDD7E022582D055E35455952F86f76924884A9d1a' // atBTC/HOLLAR 0.3%, token0 HOLLAR, token1 atBTC
const HOLLAR = '0x531a654d1696ED52e7275A8cede955E82620f99a'
const ATBTC = '0x69003a65189f6Ed993D3bD3E2B74f1Db39F405ce'
const FEED = '0xe5AcDfB0d5EC5cE34F7448B41ef4a97c4e83D9c1' // DIA tBTC/USD, 8 decimals; HOLLAR is the USD side
const ROUTER = '0x5a79dE848626994c4099640EF5c48Fd65DAe4159' // SwapRouter02

const BLOCK = {
    short: 16956819, // 13 Nov 09:15, 216 ticks off, about 0.7 HOLLAR in the gap
    gap: 17009982, // 14 Nov 18:38, 302 ticks off, about 0.4 HOLLAR in the gap
    empty: 17256465, // 21 Nov 03:39, 219 ticks off, no liquidity at all
    edge: 17262909, // 21 Nov 07:35, spot just above -109800, the upper tick of the vault limit, nothing above it
}

const POOL_ABI = [
    'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
    'function liquidity() view returns (uint128)',
]
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)']
const ATOKEN_ABI = [
    'function POOL() view returns (address)',
    'function UNDERLYING_ASSET_ADDRESS() view returns (address)',
    'function mint(address caller, address onBehalfOf, uint256 amount, uint256 index) returns (bool)',
]
const MM_POOL_ABI = ['function getReserveNormalizedIncome(address) view returns (uint256)']
const FEED_ABI = ['function latestRoundData() view returns (uint80, int256 answer, uint256, uint256, uint80)']
const ROUTER_ABI = [
    'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)',
]

// TickMath.getSqrtRatioAtTick from v3-core
const RATIOS = [
    '0xfffcb933bd6fad37aa2d162d1a594001', '0xfff97272373d413259a46990580e213a', '0xfff2e50f5f656932ef12357cf3c7fdcc',
    '0xffe5caca7e10e4e61c3624eaa0941cd0', '0xffcb9843d60f6159c9db58835c926644', '0xff973b41fa98c081472e6896dfb254c0',
    '0xff2ea16466c96a3843ec78b326b52861', '0xfe5dee046a99a2a811c461f1969c3053', '0xfcbe86c7900a88aedcffc83b479aa3a4',
    '0xf987a7253ac413176f2b074cf7815e54', '0xf3392b0822b70005940c7a398e4b70f3', '0xe7159475a2c29b7443b29c7fa6e889d9',
    '0xd097f3bdfd2022b8845ad8f792aa5825', '0xa9f746462d870fdf8a65dc1f90e061e5', '0x70d869a156d2a1b890bb3df62baf32f7',
    '0x31be135f97d08fd981231505542fcfa6', '0x9aa508b5b7a84e1c677de54f3e99bc9', '0x5d6af8dedb81196699c329225ee604',
    '0x2216e584f5fa1ea926041bedfe98', '0x48a170391f7dc42444e8fa2',
]
function sqrtAtTick(tick: number): BigNumber {
    const abs = Math.abs(tick)
    const Q128 = BigNumber.from(2).pow(128)
    const Q32 = BigNumber.from(2).pow(32)
    let r = abs & 1 ? BigNumber.from(RATIOS[0]) : Q128
    for (let i = 1; i < RATIOS.length; i++) if (abs & (1 << i)) r = r.mul(RATIOS[i]).div(Q128)
    if (tick > 0) r = ethers.constants.MaxUint256.div(r)
    return r.div(Q32).add(r.mod(Q32).isZero() ? 0 : 1)
}

async function fork(block: number) {
    await network.provider.request({ method: 'hardhat_reset', params: [{ forking: { jsonRpcUrl: RPC, blockNumber: block } }] })
}

async function impersonate(address: string): Promise<Signer> {
    await network.provider.request({ method: 'hardhat_impersonateAccount', params: [address] })
    await network.provider.request({ method: 'hardhat_setBalance', params: [address, '0x56BC75E2D63100000'] })
    return ethers.getSigner(address)
}

// atBTC minted the way a money-market supply mints it, to a wallet with no debt: real holders here all borrow,
// and an aToken transfer from a borrower runs a health check through an oracle precompile a hardhat fork does not have
async function mintAtbtc(to: string, amount: BigNumber) {
    const atoken = new Contract(ATBTC, ATOKEN_ABI, ethers.provider)
    const mmPool = await atoken.POOL()
    const index = await new Contract(mmPool, MM_POOL_ABI, ethers.provider).getReserveNormalizedIncome(await atoken.UNDERLYING_ASSET_ADDRESS())
    await atoken.connect(await impersonate(mmPool)).mint(to, to, amount, index)
}

// the feed price as the sqrtPriceX96 of the pool (atBTC per HOLLAR, both 18 decimals)
async function oracleSqrt(): Promise<BigNumber> {
    const feed = new Contract(FEED, FEED_ABI, ethers.provider)
    const usd = Number((await feed.latestRoundData()).answer) / 1e8
    return BigNumber.from(Math.floor(Math.sqrt(1 / usd) * 2 ** 48)).mul(BigNumber.from(2).pow(48))
}

describe('PoolAnchor', () => {
    it('only the pool it is swapping can call back', async () => {
        const anchor = (await (await ethers.getContractFactory('PoolAnchor')).deploy()) as PoolAnchor
        await expect(anchor.uniswapV3SwapCallback(1, 0, '0x')).to.be.revertedWith('not the pool')
    })
})

;(RPC ? describe : describe.skip)('PoolAnchor on a Hydration fork', function () {
    this.timeout(600_000)

    let anchor: PoolAnchor
    let pool: Contract
    let fresh: Signer

    async function setup(block: number) {
        await fork(block)
        anchor = (await (await ethers.getContractFactory('PoolAnchor')).deploy()) as PoolAnchor
        pool = new Contract(POOL, POOL_ABI, ethers.provider)
        fresh = ethers.Wallet.createRandom().connect(ethers.provider)
        await network.provider.request({ method: 'hardhat_setBalance', params: [await fresh.getAddress(), '0x56BC75E2D63100000'] })
    }

    after(async () => {
        await network.provider.request({ method: 'hardhat_reset', params: [] })
    })

    it('moves an empty gap onto the oracle for free, from a caller holding no tokens', async () => {
        await setup(BLOCK.empty)
        expect(await pool.liquidity()).to.eq(0)
        const target = await oracleSqrt()
        await anchor.connect(fresh).anchor(POOL, target, 1, 1)
        expect((await pool.slot0()).sqrtPriceX96).to.eq(target)
    })

    it('pays only the liquidity in the gap, at the oracle price or better less the fee', async () => {
        await setup(BLOCK.gap)
        const target = await oracleSqrt()
        const me = await fresh.getAddress()
        await mintAtbtc(me, ethers.utils.parseEther('0.01'))
        const atbtc = new Contract(ATBTC, ERC20_ABI, fresh)
        const hollar = new Contract(HOLLAR, ERC20_ABI, fresh)
        await atbtc.approve(anchor.address, ethers.constants.MaxUint256)
        const a0 = await atbtc.balanceOf(me)

        await anchor.connect(fresh).anchor(POOL, target, 0, ethers.utils.parseEther('0.001'))

        expect((await pool.slot0()).sqrtPriceX96).to.eq(target)
        const spent = a0.sub(await atbtc.balanceOf(me))
        const got = await hollar.balanceOf(me)
        expect(spent).to.be.gt(0)
        expect(spent).to.be.lt(BigNumber.from(10).pow(13)) // under $1 at $66k
        // HOLLAR per atBTC received vs the feed: every fill sits between spot and the oracle
        const usd = 1 / (Number(target.toString()) / 2 ** 96) ** 2
        expect(Number(got.toString()) / Number(spent.toString())).to.be.gte(usd * 0.997)
    })

    it('reverts and leaves the pool alone when the cap runs short of the oracle', async () => {
        await setup(BLOCK.short)
        const target = await oracleSqrt()
        await mintAtbtc(await fresh.getAddress(), ethers.utils.parseEther('0.01'))
        await new Contract(ATBTC, ERC20_ABI, fresh).approve(anchor.address, ethers.constants.MaxUint256)
        const before = (await pool.slot0()).sqrtPriceX96

        await expect(anchor.connect(fresh).anchor(POOL, target, 0, 1e9)).to.be.revertedWith('target not reached')
        expect((await pool.slot0()).sqrtPriceX96).to.eq(before)
    })

    it('does nothing when the pool is already on the target', async () => {
        await setup(BLOCK.gap)
        const current = (await pool.slot0()).sqrtPriceX96
        await anchor.connect(fresh).anchor(POOL, current, 0, 0)
        expect((await pool.slot0()).sqrtPriceX96).to.eq(current)
    })

    it('moves a price sitting exactly on a range edge, where the router refuses', async () => {
        await setup(BLOCK.edge)
        // a free move down onto the upper tick of the vault limit leaves the price exactly on the edge, liquidity above 0
        await anchor.connect(fresh).anchor(POOL, sqrtAtTick(-109800), 1, 1)
        expect((await pool.slot0()).tick).to.eq(-109801)
        expect(await pool.liquidity()).to.be.gt(0)

        const target = await oracleSqrt()
        const router = new Contract(ROUTER, ROUTER_ABI, fresh)
        const params = { tokenIn: ATBTC, tokenOut: HOLLAR, fee: 3000, recipient: await fresh.getAddress(), amountIn: 1e9, amountOutMinimum: 0, sqrtPriceLimitX96: target }
        await expect(router.callStatic.exactInputSingle(params)).to.be.reverted

        await anchor.connect(fresh).anchor(POOL, target, 1, 1)
        expect((await pool.slot0()).sqrtPriceX96).to.eq(target)
    })
})
