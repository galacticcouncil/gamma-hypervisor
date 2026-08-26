// 00-preflight — read-only sanity check (no transactions).
//   npx hardhat run lark/00-preflight.ts --network lark4
import { ethers } from "hardhat";
import { LARK, ERC20_ABI, POOL_ABI, fmt, fmt0, fmt1, signers } from "./_shared";

const FACTORY_ABI = ["function getPool(address,address,uint24) view returns (address)"];
const META_ABI = ["function symbol() view returns (string)", "function decimals() view returns (uint8)"];

async function main() {
  const net = await ethers.provider.getNetwork();
  console.log(`network chainId ${net.chainId} (expect ${LARK.chainId})`);

  // The v3 stack is deployed from the same nonce sequence on every fork, so a
  // stale address resolves to a *different* live contract rather than to nothing.
  // Assert the factory really does own the configured pool before trusting any
  // of it.
  const factory = new ethers.Contract(LARK.v3Factory, FACTORY_ABI, ethers.provider);
  const derived = await factory.getPool(LARK.token0, LARK.token1, LARK.fee);
  if (derived.toLowerCase() !== LARK.pool.toLowerCase()) {
    throw new Error(
      `stack mismatch: factory ${LARK.v3Factory} maps (${LARK.token0}, ${LARK.token1}, ${LARK.fee}) ` +
        `to ${derived}, not the configured pool ${LARK.pool}. Check V3_FACTORY / TOKEN0 / TOKEN1 / V3_POOL.`,
    );
  }
  console.log(`factory ${LARK.v3Factory} -> pool ${derived}  OK`);

  const pool = new ethers.Contract(LARK.pool, POOL_ABI, ethers.provider);
  const { tick } = await pool.slot0();
  console.log(`pool ${LARK.pool}  tick=${tick}  spacing=${await pool.tickSpacing()}`);

  // Decimals are configured, not assumed — confirm they match the chain.
  for (const [label, addr, want] of [
    ["token0", LARK.token0, LARK.dec0],
    ["token1", LARK.token1, LARK.dec1],
  ] as const) {
    const meta = new ethers.Contract(addr, META_ABI, ethers.provider);
    const [sym, dec] = await Promise.all([meta.symbol(), meta.decimals()]);
    const flag = Number(dec) === want ? "OK" : `MISMATCH — configured ${want}`;
    console.log(`${label}  ${addr}  ${sym} / ${dec}dp  ${flag}`);
  }

  const { deployer, bob } = await signers();
  const t0 = new ethers.Contract(LARK.token0, ERC20_ABI, ethers.provider);
  const t1 = new ethers.Contract(LARK.token1, ERC20_ABI, ethers.provider);
  for (const [name, s] of [["deployer", deployer], ["BOB     ", bob]] as const) {
    const [gas, b0, b1] = await Promise.all([
      ethers.provider.getBalance(s.address),
      t0.balanceOf(s.address),
      t1.balanceOf(s.address),
    ]);
    console.log(`${name} ${s.address}  gas(WETH)=${fmt(gas)}  ${LARK.sym0}=${fmt0(b0)}  ${LARK.sym1}=${fmt1(b1)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
