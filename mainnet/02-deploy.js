/**
 * 02-deploy.js — deploy and wire the Gamma stack over the existing Uniswap v3
 * pool. It deliberately stops in the BOOTSTRAP posture: the deploy key still
 * owns everything, so 03-handover.js can set the launch band and only then
 * retire the key. Nothing here is irreversible except the CREATEs themselves.
 *
 * Resumable and idempotent. Every configuration step reads current chain state
 * first, so a re-run after a dropped transaction repeats only what is missing.
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { ApiPromise, WsProvider } = require("@polkadot/api");
const {
  env,
  requireEnv,
  isMainnet,
  resolveAssetAddress,
  sortTokens,
  deployContract,
  gasOverrides,
  waitForSuccess,
  loadDeployments,
  saveJson,
  ABI,
} = require("./lib");

const PRODUCTION_NETS = ["mainnet"];

function resolveGovernance(net, deployer) {
  const configured = env("GOVERNANCE_ADDRESS");
  const allowDeployer = env("ALLOW_DEPLOYER_OWNER", "false") === "true";
  if (configured) {
    if (!ethers.isAddress(configured)) throw new Error(`GOVERNANCE_ADDRESS is not an address: ${configured}`);
    if (configured.toLowerCase() !== deployer.toLowerCase()) return ethers.getAddress(configured);
  }
  const why = configured ? "GOVERNANCE_ADDRESS equals the deployer" : "GOVERNANCE_ADDRESS is unset";
  if (PRODUCTION_NETS.includes(net) && !allowDeployer) {
    throw new Error(
      `${why} — the deploy key would keep Admin, ClearingV2, UniProxy, RebalanceProxy and the ` +
        `HypervisorFactory on ${net}. That key could then repoint UniProxy at a guardless clearing ` +
        `contract or exempt the vault from every RebalanceProxy cap. Set GOVERNANCE_ADDRESS to ` +
        `0xaa7e0000000000000000000000000000000aa7e0 (dispatchAsAaveManager), or set ` +
        `ALLOW_DEPLOYER_OWNER=true if this really is a throwaway network.`
    );
  }
  console.log(`  ! ${why} — deploy key keeps every owner role (${net} is not a production net)`);
  return deployer;
}

/** Load resume state, refusing anything whose recorded contracts are not on this chain. */
async function loadState(statePath, provider, rpc) {
  if (!fs.existsSync(statePath)) return {};
  const recorded = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const addresses = Object.entries(recorded).filter(([, v]) => typeof v === "string" && ethers.isAddress(v));
  if (!addresses.length) return recorded;
  console.log(`  resume state found (${addresses.length} addresses) — validating against ${rpc}`);
  const missing = [];
  for (const [key, addr] of addresses) {
    const code = await provider.getCode(addr);
    if (!code || code === "0x") missing.push(`${key} ${addr}`);
  }
  if (missing.length) {
    throw new Error(
      `resume state ${statePath} does not match this chain — no code at:\n    ` +
        missing.join("\n    ") +
        `\n  Refusing to resume a state file from another chain. Remove it only after ` +
        `confirming this is a fresh deployment.`
    );
  }
  console.log("  resume state validated — all recorded contracts exist on chain");
  return recorded;
}

async function main() {
  const net = env("NET", "mainnet");
  const rpc = env("EVM_RPC_URL", "https://rpc.hydradx.cloud");
  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(requireEnv("DEPLOYER_PK"), provider);
  const deployer = wallet.address;
  const governance = resolveGovernance(net, deployer);
  const confirmations = Number(env("CONFIRMATIONS", "2"));
  if (!Number.isInteger(confirmations) || confirmations < 1) throw new Error("CONFIRMATIONS must be a positive integer");

  const keeper = env("KEEPER_ADDRESS");
  if (!ethers.isAddress(keeper || "")) throw new Error("KEEPER_ADDRESS must be set before deploying");

  const v3Factory = env("V3_FACTORY");
  const poolAddress = env("V3_POOL");
  const fee = Number(env("FEE", "3000"));
  if (!ethers.isAddress(v3Factory || "") || !ethers.isAddress(poolAddress || "")) {
    throw new Error("V3_FACTORY and V3_POOL are required — take them from the uniswap-v3-deploy launch record");
  }

  // Resolve the way the RUNTIME does: an Erc20-kind asset lives at its
  // registered contract, not at the 0x…01++id alias. A vault built on the alias
  // would bind to a different (unroutable) pool.
  const sub = await ApiPromise.create({ provider: new WsProvider(env("WS_URL", "wss://rpc.hydradx.cloud"), 3000), noInitWarn: true });
  let addrA, addrB;
  try {
    [addrA, addrB] = await Promise.all([
      resolveAssetAddress(sub, Number(env("TOKEN_A", "1001"))),
      resolveAssetAddress(sub, Number(env("TOKEN_B", "222"))),
    ]);
  } finally {
    await sub.disconnect();
  }
  const [token0, token1] = sortTokens(addrA, addrB);

  const factory = new ethers.Contract(v3Factory, ABI.factory, provider);
  const derived = await factory.getPool(token0, token1, fee);
  if (derived.toLowerCase() !== poolAddress.toLowerCase()) {
    throw new Error(`factory ${v3Factory} maps the pair to ${derived}, not V3_POOL ${poolAddress} — refusing to deploy`);
  }

  const statePath = path.join(__dirname, "deployments", `${net}-state.json`);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const state = await loadState(statePath, provider, rpc);
  const persist = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");

  console.log(`\n=== Deploying Gamma -> ${rpc} (${net}) ===`);
  console.log(`  deployer   ${deployer}`);
  console.log(`  governance ${governance}${governance === deployer ? "  (DEPLOY KEY — testnet only)" : "  (03-handover.js transfers to it)"}`);
  console.log(`  keeper     ${keeper}`);
  console.log(`  pool       ${poolAddress} (fee ${fee})`);
  console.log(`  token0     ${token0}`);
  console.log(`  token1     ${token1}\n`);

  const overrides = () => gasOverrides(provider);
  const send = async (txPromise, label) => waitForSuccess(await txPromise, confirmations, label);

  // --- contracts ----------------------------------------------------------
  if (!state.hypervisorFactory) {
    state.hypervisorFactory = await deployContract(ethers, wallet, "HypervisorFactory", [v3Factory], await overrides(), confirmations);
    persist();
  } else {
    console.log(`  HypervisorFactory  ${state.hypervisorFactory}  (resumed)`);
  }

  const hyperFactory = new ethers.Contract(state.hypervisorFactory, ABI.hypervisorFactory, wallet);
  let hypervisor = await hyperFactory.getHypervisor(token0, token1, fee);
  if (hypervisor === ethers.ZeroAddress) {
    // name/symbol are ERC-20 constructor args with NO setter — whatever ships
    // here is the LP label a front end renders forever. Read the symbols off
    // chain rather than hardcoding a literal that can name the wrong pair.
    const [sym0, sym1] = await Promise.all([
      new ethers.Contract(token0, ABI.erc20, provider).symbol(),
      new ethers.Contract(token1, ABI.erc20, provider).symbol(),
    ]);
    const name = env("VAULT_NAME", `Gamma ${sym0}-${sym1}`);
    const symbol = env("VAULT_SYMBOL", `g${sym0}-${sym1}`);
    console.log(`  LP token   ${name} (${symbol})`);
    await send(hyperFactory.createHypervisor(token0, token1, fee, name, symbol, await overrides()), "createHypervisor");
    hypervisor = await hyperFactory.getHypervisor(token0, token1, fee);
    if (hypervisor === ethers.ZeroAddress) throw new Error("createHypervisor did not register a vault");
  }
  state.hypervisor = hypervisor;
  persist();
  console.log(`  Hypervisor         ${hypervisor}`);

  const vault = new ethers.Contract(hypervisor, ABI.hypervisor, wallet);
  const boundPool = await vault.pool();
  if (boundPool.toLowerCase() !== poolAddress.toLowerCase()) {
    throw new Error(`vault ${hypervisor} is bound to pool ${boundPool}, not ${poolAddress}`);
  }

  if (!state.clearing) {
    state.clearing = await deployContract(ethers, wallet, "ClearingV2", [], await overrides(), confirmations);
    persist();
  } else {
    console.log(`  ClearingV2         ${state.clearing}  (resumed)`);
  }
  if (!state.uniProxy) {
    state.uniProxy = await deployContract(ethers, wallet, "UniProxy", [state.clearing], await overrides(), confirmations);
    persist();
  } else {
    console.log(`  UniProxy           ${state.uniProxy}  (resumed)`);
  }
  if (!state.admin) {
    state.admin = await deployContract(ethers, wallet, "Admin", [deployer], await overrides(), confirmations);
    persist();
  } else {
    console.log(`  Admin              ${state.admin}  (resumed)`);
  }
  if (!state.rebalanceProxy) {
    state.rebalanceProxy = await deployContract(ethers, wallet, "RebalanceProxy", [deployer], await overrides(), confirmations);
    persist();
  } else {
    console.log(`  RebalanceProxy     ${state.rebalanceProxy}  (resumed)`);
  }

  const clearing = new ethers.Contract(state.clearing, ABI.clearing, wallet);
  const admin = new ethers.Contract(state.admin, ABI.admin, wallet);
  const proxy = new ethers.Contract(state.rebalanceProxy, ABI.rebalanceProxy, wallet);

  // --- ClearingV2 ---------------------------------------------------------
  console.log("\n  ClearingV2 configuration");
  const position = await clearing.positions(hypervisor);
  if (Number(position.version) === 0) {
    await send(clearing.addPosition(hypervisor, 2, await overrides()), "clearing.addPosition(vault, 2)");
  } else {
    console.log(`    position already added (version ${position.version})`);
  }

  const twapInterval = Number(env("TWAP_INTERVAL", "3600"));
  if (Number(await clearing.twapInterval()) !== twapInterval) {
    await send(clearing.setTwapInterval(twapInterval, await overrides()), `clearing.setTwapInterval(${twapInterval})`);
  } else {
    console.log(`    twapInterval already ${twapInterval}s`);
  }

  // The shipped default is 10_000, which compares as price*10_000/priceBefore
  // and therefore allows 0% deviation — every deposit reverts once a TWAP
  // exists. 10_100 = 1%.
  const priceThreshold = Number(env("PRICE_THRESHOLD", "10100"));
  if (priceThreshold <= 10_000) throw new Error(`PRICE_THRESHOLD ${priceThreshold} allows 0% deviation`);
  if (Number(await clearing.priceThreshold()) !== priceThreshold) {
    await send(clearing.setPriceThreshold(priceThreshold, await overrides()), `clearing.setPriceThreshold(${priceThreshold})`);
  } else {
    console.log(`    priceThreshold already ${priceThreshold}`);
  }

  // Deposit caps. `customDeposit` stores the per-tx maxima and the supply cap;
  // `setDepositOverride` is what makes clearDeposit actually read the maxima.
  // Without the second call they are inert and the Hypervisor's own unlimited
  // constructor values apply instead.
  //
  // customDepositDelta is NOT optional when the override is on: applyRatio
  // divides by it, so a 0 makes every deposit after the first revert inside
  // FullMath.mulDiv. The first deposit takes the totalSupply()==0 branch and
  // never touches applyRatio, which is exactly why the bug survives a smoke test.
  const maxTotalSupply = BigInt(env("MAX_TOTAL_SUPPLY", "0"));
  const deposit0Max = BigInt(env("DEPOSIT0_MAX", "0"));
  const deposit1Max = BigInt(env("DEPOSIT1_MAX", "0"));
  const depositDelta = BigInt(env("DEPOSIT_DELTA", "10010"));
  if (maxTotalSupply || deposit0Max || deposit1Max) {
    const wantOverride = deposit0Max > 0n && deposit1Max > 0n;
    if (wantOverride && depositDelta === 0n) {
      throw new Error("DEPOSIT_DELTA must be non-zero when per-tx caps are set — applyRatio divides by it");
    }
    const current = await clearing.positions(hypervisor);
    const matches =
      current.deposit0Max === deposit0Max &&
      current.deposit1Max === deposit1Max &&
      current.maxTotalSupply === maxTotalSupply &&
      current.customDepositDelta === depositDelta;
    if (!matches) {
      await send(
        clearing.customDeposit(hypervisor, deposit0Max, deposit1Max, maxTotalSupply, depositDelta, await overrides()),
        `clearing.customDeposit(d0=${deposit0Max} d1=${deposit1Max} supply=${maxTotalSupply} delta=${depositDelta})`
      );
    } else {
      console.log("    caps already match");
    }
    if (wantOverride && !(await clearing.positions(hypervisor)).depositOverride) {
      await send(clearing.setDepositOverride(hypervisor, true, await overrides()), "clearing.setDepositOverride(true)");
    } else if (wantOverride) {
      console.log("    depositOverride already on");
    }
  } else if (isMainnet()) {
    throw new Error("mainnet requires MAX_TOTAL_SUPPLY and per-tx deposit caps — this is a guarded launch");
  } else {
    console.log("    caps: NONE — unlimited deposits");
  }

  // --- Hypervisor ---------------------------------------------------------
  console.log("\n  Hypervisor configuration");
  const feeDivisor = Number(env("HYPERVISOR_FEE", "255"));
  if (!Number.isInteger(feeDivisor) || feeDivisor < 1 || feeDivisor > 255) {
    throw new Error("HYPERVISOR_FEE must be 1..255 — 0 divides by zero and bricks every harvest");
  }
  if (Number(await vault.fee()) !== feeDivisor) {
    await send(vault.setFee(feeDivisor, await overrides()), `hypervisor.setFee(${feeDivisor})`);
  } else {
    console.log(`    fee divisor already ${feeDivisor} (${(100 / feeDivisor).toFixed(2)}% of harvested swap fees)`);
  }
  if (await vault.directDeposit()) {
    // Deposits entering the pool atomically is a sandwich surface; the launch
    // posture is off, and the constructor default is off, so this only fires if
    // something toggled it.
    throw new Error("hypervisor.directDeposit is ON — the launch posture requires it off");
  }
  console.log("    directDeposit off");

  // --- Model B wiring -----------------------------------------------------
  // keeper key -> RebalanceProxy (caps) -> Admin (roles) -> Hypervisor (owner)
  console.log("\n  Model B wiring");
  const wire = async (read, write, label) => {
    const current = await read();
    if (String(current).toLowerCase() === String(write.want).toLowerCase()) {
      console.log(`    ${label} already set`);
      return;
    }
    await send(write.tx(), label);
  };
  await wire(() => admin.rebalancers(hypervisor), {
    want: state.rebalanceProxy,
    tx: async () => admin.setRebalancer(hypervisor, state.rebalanceProxy, await overrides()),
  }, "admin.setRebalancer(vault, proxy)");
  await wire(() => proxy.admins(hypervisor), {
    want: state.admin,
    tx: async () => proxy.setAdmin(hypervisor, state.admin, await overrides()),
  }, "proxy.setAdmin(vault, admin)");
  await wire(() => proxy.rebalancers(hypervisor), {
    want: keeper,
    tx: async () => proxy.setRebalancer(hypervisor, keeper, await overrides()),
  }, `proxy.setRebalancer(vault, ${keeper})`);
  // setAdvisor is what makes `compound` reachable at all — it defaults to the
  // zero address, so without this nothing can ever harvest fees.
  await wire(() => admin.advisors(hypervisor), {
    want: keeper,
    tx: async () => admin.setAdvisor(hypervisor, keeper, await overrides()),
  }, `admin.setAdvisor(vault, ${keeper})`);

  const caps = [
    ["customDiff", "MAX_TRANSLATION", "500", async (v) => proxy.setCustomDiff(hypervisor, v, await overrides())],
    ["customWidth", "MAX_WIDTH", "300", async (v) => proxy.setCustomDiffWidth(hypervisor, v, await overrides())],
    ["customInterval", "MIN_INTERVAL", "21600", async (v) => proxy.setCustomInterval(hypervisor, v, await overrides())],
  ];
  for (const [getter, key, def, setter] of caps) {
    const want = BigInt(env(key, def));
    // 0 means "fall back to the proxy's global default" — never what a launch
    // wants, because the global is shared with every other vault on the proxy.
    if (want === 0n) throw new Error(`${key} must be non-zero: 0 makes RebalanceProxy fall back to its global default`);
    const current = await proxy[getter](hypervisor);
    if (current === want) {
      console.log(`    proxy.${getter} already ${want}`);
    } else {
      await send(setter(want), `proxy.${getter} = ${want}`);
    }
  }

  // --- record -------------------------------------------------------------
  // Never downgrade a posture the handover already recorded: re-running the
  // deploy against a handed-over stack is a no-op on chain, and rewriting
  // "bootstrap" over "production" would make 04-verify.js check the wrong
  // ownership everywhere and report a healthy vault as broken.
  let posture = "bootstrap";
  try {
    posture = loadDeployments(net).config?.posture ?? "bootstrap";
  } catch {
    /* first run */
  }
  const record = {
    network: { name: net, chainId: (await provider.getNetwork()).chainId.toString(), evmRpc: rpc, substrateWs: env("WS_URL", "wss://rpc.hydradx.cloud") },
    deployer,
    governance,
    keeper,
    feeRecipient: env("FEE_RECIPIENT") || null,
    uniswap: { v3Factory, pool: poolAddress, fee, token0, token1 },
    gamma: {
      hypervisorFactory: state.hypervisorFactory,
      hypervisor,
      clearing: state.clearing,
      uniProxy: state.uniProxy,
      admin: state.admin,
      rebalanceProxy: state.rebalanceProxy,
    },
    config: {
      twapInterval,
      priceThreshold,
      depositDelta: depositDelta.toString(),
      maxTotalSupply: maxTotalSupply.toString(),
      deposit0Max: deposit0Max.toString(),
      deposit1Max: deposit1Max.toString(),
      hypervisorFee: feeDivisor,
      maxTranslation: Number(env("MAX_TRANSLATION", "500")),
      maxWidth: Number(env("MAX_WIDTH", "300")),
      minInterval: Number(env("MIN_INTERVAL", "21600")),
      baseHalfWidthMult: Number(env("BASE_HALF_WIDTH_MULT", "16")),
      limitWidthMult: Number(env("LIMIT_WIDTH_MULT", "1")),
      posture,
    },
  };
  const p = saveJson(path.join("deployments", `${net}.json`), record);
  console.log(`\n  Wrote ${p}`);
  console.log("\n=== Gamma stack deployed in the BOOTSTRAP posture ===");
  console.log("  The deploy key still owns every contract and the vault has no band.");
  console.log("  Next: ENV_FILE=<file> npm run handover");
}

main().catch((e) => {
  console.error("\n  Deploy FAILED:", e.message, "\n");
  process.exit(1);
});
