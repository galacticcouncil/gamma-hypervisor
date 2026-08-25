import { ethers } from 'ethers';
import { tickFromPrice } from './price';

export interface OracleReading {
  tick: number;
  ageSecs: number;
  /** The human price behind the tick — token1 per token0. Used by the regime checks. */
  price: number;
}

export interface OracleInput {
  /** token0's USD feed (AggregatorV3). */
  feed0: ethers.Contract;
  /** token1's USD feed; omit when token1 is the USD-pegged side (e.g. HOLLAR). */
  feed1?: ethers.Contract;
  /**
   * Which side of the pool `feed0` prices.
   *
   * In one-feed mode the other side is assumed USD-pegged, and the pool tick
   * encodes token1-per-token0 — so a feed on token0 IS that ratio, while a feed
   * on token1 is its RECIPROCAL. Getting this backwards does not fail loudly: it
   * lands the oracle tick a few thousand ticks from the pool and the deviation
   * gate then skips every rebalance, forever, while looking like a working gate.
   *
   * aDOT/HOLLAR sorts aDOT first (both are Erc20, so both sort by their
   * registered contract: 0x0263… < 0x531a…), so `token0` is right there — but it
   * is stated rather than assumed, because the answer flips with the pair.
   */
  feed0Side: 'token0' | 'token1';
  decimals0: number;
  decimals1: number;
  nowTs: number;
}

/** One AggregatorV3 read, normalised to a plain USD number plus its update time. */
async function readFeed(feed: ethers.Contract): Promise<{ usd: number; ts: number }> {
  const [round, decimals] = await Promise.all([feed.latestRoundData(), feed.decimals()]);
  const answer = ethers.BigNumber.from(round.answer);
  if (answer.lte(0)) throw new Error(`feed ${feed.address} returned ${answer.toString()}`);
  const usd = Number(ethers.utils.formatUnits(answer, decimals));
  if (!(usd > 0) || !Number.isFinite(usd)) {
    throw new Error(`feed ${feed.address} price not usable: ${usd}`);
  }
  return { usd, ts: Number(round.updatedAt.toString()) };
}

// External-truth clamp: the pool tick the outside world implies. A swap through
// our thin pool moves spot and (slowly) the pool TWAP, but cannot move the
// exchanges these feeds aggregate — so requiring the pool TWAP to agree with this
// tick makes "manipulate the pool, wait for the keeper" unprofitable.
//
// Callers must treat any throw as fail-closed (skip the rebalance). The reported
// age is that of the STALEST feed, so a fresh feed cannot mask a frozen one.
export async function readOracleTick(o: OracleInput): Promise<OracleReading> {
  const a = await readFeed(o.feed0);

  // token1 per token0, in human units.
  let priceHuman: number;
  let oldestTs = a.ts;
  if (o.feed1) {
    const b = await readFeed(o.feed1);
    // Two feeds: the ratio is oriented by which feed is which side.
    const [num, den] = o.feed0Side === 'token0' ? [a.usd, b.usd] : [b.usd, a.usd];
    priceHuman = num / den;
    oldestTs = Math.min(oldestTs, b.ts);
  } else {
    // One feed: the unpriced side is USD-pegged, so its price is 1.
    priceHuman = o.feed0Side === 'token0' ? a.usd : 1 / a.usd;
  }
  if (!(priceHuman > 0) || !Number.isFinite(priceHuman)) {
    throw new Error(`oracle price not usable: ${priceHuman}`);
  }

  // Human price (token1 per token0) -> raw pool price -> tick.
  const priceRaw = priceHuman * Math.pow(10, o.decimals1 - o.decimals0);
  return {
    tick: tickFromPrice(priceRaw),
    ageSecs: Math.max(0, o.nowTs - oldestTs),
    price: priceHuman,
  };
}
