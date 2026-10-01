/**
 * Verify the deployed sources on the neckwork explorer (sourcify v2 api).
 *
 *   node 12-verify-explorer.js deployments/mainnet-cl2-atbtc-hollar.json [...]
 *   node 12-verify-explorer.js --dry-run deployments/mainnet-cl2-*.json
 *
 * Reads only vault records, never ENV_FILE. Gamma contracts are submitted with
 * the hardhat build-info they were deployed from; the uniswap pool, which the
 * live factory creates, with the sources neckwork already holds for pool 1.
 * Already-verified addresses are skipped, so it is safe to re-run.
 */
const fs = require("fs");
const path = require("path");

const API = process.env.EXPLORER_VERIFY_URL || "https://hydration-explorer.neckwork.net/api/v2";
const SOURCES_API = process.env.EXPLORER_API_URL || "https://hydration-explorer.neckwork.net/api";
const CHAIN_ID = 222222;
// pool 1's UniswapV3Pool: same factory, so the same runtime code up to immutables
const REFERENCE_POOL = "0x5C6208A3c316A801f8996750aA7b6f45Fc988548";
const POOL_ID = "contracts/UniswapV3Pool.sol:UniswapV3Pool";
const POOL_COMPILER = "0.7.6+commit.7338295f";
const POOL_SETTINGS = {
  evmVersion: "istanbul",
  libraries: {},
  metadata: { bytecodeHash: "none" },
  optimizer: { enabled: true, runs: 800 },
  outputSelection: { "*": { "": ["*"], "*": ["*"] } },
};

const GAMMA = {
  hypervisorFactory: "contracts/HypervisorFactory.sol:HypervisorFactory",
  hypervisor: "contracts/Hypervisor.sol:Hypervisor",
  clearing: "contracts/ClearingV2.sol:ClearingV2",
  uniProxy: "contracts/UniProxy.sol:UniProxy",
  admin: "contracts/proxy/admin.sol:Admin",
  rebalanceProxy: "contracts/RebalanceProxy.sol:RebalanceProxy",
};

function buildInfoFor(id) {
  const [file, name] = id.split(":");
  const dir = path.join(__dirname, "..", "artifacts", "build-info");
  if (!fs.existsSync(dir)) throw new Error("no artifacts/build-info — run `npx hardhat compile` at the repo root");
  for (const f of fs.readdirSync(dir)) {
    const b = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    if (b.output?.contracts?.[file]?.[name]) return { stdJsonInput: b.input, compilerVersion: b.solcLongVersion };
  }
  throw new Error(`${id} is in no build-info`);
}

async function json(url, init) {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

let poolInput;
async function poolStdJson() {
  if (poolInput) return poolInput;
  const { status, body } = await json(`${SOURCES_API}/explorer/contract/${REFERENCE_POOL}/sources`);
  if (status !== 200 || !Array.isArray(body.files)) throw new Error(`reference pool sources: http ${status}`);
  if (body.compiler?.version?.replace(/^v/, "") !== POOL_COMPILER) {
    throw new Error(`reference pool compiled with ${body.compiler?.version}, expected ${POOL_COMPILER}`);
  }
  const sources = Object.fromEntries(body.files.map((f) => [f.path, { content: f.content }]));
  poolInput = { stdJsonInput: { language: "Solidity", sources, settings: POOL_SETTINGS }, compilerVersion: POOL_COMPILER };
  return poolInput;
}

async function isVerified(address) {
  const { status, body } = await json(`${API}/contract/${CHAIN_ID}/${address}`);
  return status === 200 && !!body.match;
}

async function verify(address, id, input) {
  const sub = await json(`${API}/verify/${CHAIN_ID}/${address}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...input, contractIdentifier: id }),
  });
  if (sub.status === 409) return "already verified";
  if (sub.status !== 202) throw new Error(`submit http ${sub.status}: ${sub.body.message ?? JSON.stringify(sub.body)}`);
  const vid = sub.body.verificationId;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const { body } = await json(`${API}/verify/${vid}`);
    if (!body.isJobCompleted) continue;
    if (body.error) throw new Error(`${body.error.customCode}: ${body.error.message}`);
    return body.contract?.match ?? "completed";
  }
  throw new Error(`job ${vid} still pending after 5 min`);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const records = args.filter((a) => !a.startsWith("--"));
  if (!records.length) throw new Error("usage: node 12-verify-explorer.js [--dry-run] deployments/<net>-<STACK>-<pool>.json ...");

  // shared contracts repeat across records; submit each address once
  const targets = new Map();
  for (const r of records) {
    if (r.endsWith("-state.json")) continue;
    const rec = JSON.parse(fs.readFileSync(r, "utf8"));
    if (rec.uniswap?.pool) targets.set(rec.uniswap.pool.toLowerCase(), { address: rec.uniswap.pool, id: POOL_ID, from: r });
    for (const [key, id] of Object.entries(GAMMA)) {
      const a = rec.gamma?.[key];
      if (a) targets.set(a.toLowerCase(), { address: a, id, from: r });
    }
  }

  let failed = 0;
  for (const t of targets.values()) {
    const label = `${t.id.split(":")[1].padEnd(18)} ${t.address}`;
    try {
      if (await isVerified(t.address)) {
        console.log(`${label}  already verified`);
        continue;
      }
      const input = t.id === POOL_ID ? await poolStdJson() : buildInfoFor(t.id);
      if (dryRun) {
        console.log(`${label}  would submit (${input.compilerVersion}, ${Object.keys(input.stdJsonInput.sources).length} sources)`);
        continue;
      }
      console.log(`${label}  ${await verify(t.address, t.id, input)}`);
    } catch (e) {
      failed++;
      console.log(`${label}  FAILED ${e.message}`);
    }
  }
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
