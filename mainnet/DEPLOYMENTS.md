# Deployment records

No testnet or historical addresses are committed here. Each launch writes its
own ignored records under `mainnet/deployments/`:

- `<net>-state.json` — resumable per-contract deploy state. Addresses only;
  `02-deploy.js` refuses to resume it when any recorded address has no code on
  the target chain.
- `<net>.json` — the address sheet, roles, pool linkage, guard configuration and
  the recorded posture (`bootstrap` until `03-handover.js` runs).

**Gamma addresses are not reproducible across chains.** The v3 stack is
CREATE-deterministic from a fresh key's nonce sequence, and the pool is CREATE2
over `(token0, token1, fee)` — but the Gamma contracts are deployed after those
transactions have already moved the nonce, and the Hypervisor is CREATE2 from
the HypervisorFactory's own address. Nothing downstream — keeper, SDK, UI — may
carry an address from a rehearsal or from lark.

Before handoff, archive those files with the reviewed configuration (excluding
`DEPLOYER_PK`), the seed proposal's preimage and hash, its referendum index, the
enactment block range, and the passing `04-verify.js` output.
