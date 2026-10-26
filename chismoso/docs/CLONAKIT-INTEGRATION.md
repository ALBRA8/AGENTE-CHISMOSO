# ClonaKit + REA Integration

CHISMOSO integrates with ClonaKit's **REA** (Reverse-engineer Anything) tool via MCP.

> **Task**: IMP-CLONA-2 · **Status**: implemented · **License**: MIT (both REA and ClonaKit)
>
> **Boundary**: CHISMOSO detects signals → REA investigates the product's tech stack → CHISMOSO persists the resulting metadata as OBSERVED evidence. NO source code, NO asset cloning, NO DRM bypass.

---

## What REA does

REA investigates how an app is built **WITHOUT accessing its source code**:

- **Mac apps** (`/Applications/Slack.app`): analyzes frameworks, permissions, plugins.
- **Electron apps** (`app.asar`): inspects the bundled `package.json` + npm libs.
- **Web apps** (`https://linear.app`): opens Chrome via CDP, analyses loaded scripts.

REA returns: framework list, permissions (TCC usage descriptions), entitlements, and **web-equivalent technologies** (so a Mac developer can see "this uses CoreData — the web equivalent is IndexedDB").

The tool is MIT-licensed at https://github.com/morluto/rea. ClonaKit is also MIT.

## What CHISMOSO does with REA

CHISMOSO V1.4 already connects to MCP servers as a client (`src/mcp/registry.ts`, `src/mcp/bridge.ts`). REA is just another MCP server in that pool — it doesn't get any special treatment.

The integration is one-way and read-only:

1. CHISMOSO detects that a **product/competitor is mentioned repeatedly** in trends (e.g. "Slack", "Notion", "Linear").
2. The ReAct EVALUATE step (`src/orchestrator/react.ts`) emits `action="product_intel"` with the product name + a depth.
3. The orchestrator invokes the `product_intel` tool (`src/orchestrator/tools.ts`), which:
   - Calls `investigateProduct(product, depth)` from `src/intelligence/product-intel.ts`.
   - That function looks up the `rea` MCP server in the registry, finds the investigate/analyze tool on it, and calls it via `mcpRegistry.callTool('rea.<tool>', { target, depth })`.
   - Parses REA's free-text report into structured framework entries.
   - Converts each framework into a CHISMOSO `Signal` + `Evidence` pair (`TruthLevel.OBSERVED` — REA observes the binary, doesn't read source code).
4. Those signals are persisted to the active investigation. The next EVALUATE iteration sees them and can reason about the product's tech stack when scoring the Opportunity (e.g. "Slack uses CoreData → web equivalent is IndexedDB → your MVP could use IndexedDB").

The boundary is explicit: REA returns **metadata**, not source code. ClonaKit's design (see `AVISO-LEGAL.md` in the ClonaKit repo) enforces this — REA outputs framework names, permissions, and web-equivalent strings. It does NOT output source code or assets.

## Boundary

**CHISMOSO does NOT**:
- Build clones of the investigated products.
- Copy code, assets, icons, or proprietary content from the original.
- Bypass any DRM, login, or payment protection.
- Reverse-engineer anything that requires authentication.

**CHISMOSO does**:
- Detect that a product is being mentioned in signals (trends) — this is just normal trend detection, no special REA logic.
- Use REA to understand the product's tech stack (legally, via clean-room analysis — REA observes the binary, doesn't read source).
- Use that intel to enrich Opportunities (e.g. "the product uses CoreData → web equivalent is IndexedDB → your MVP could use IndexedDB").

For more on the CHISMOSO-wide clean-room commitment, see [`docs/CLEAN-ROOM.md`](./CLEAN-ROOM.md).

## Setup

1. **Install REA** in the `chismoso/` workspace:

   ```bash
   cd /home/z/my-project/chismoso
   npm install rea-agents
   ```

   This adds `node_modules/rea-agents/scripts/rea.mjs` — the MCP server entry point.

2. **Enable REA in MCP config**:

   Edit `/home/z/my-project/chismoso/data/mcp-servers.json` (this file is shipped disabled by default — operators flip `enabled: true` after install):

   ```json
   {
     "servers": {
       "rea": {
         "command": "node",
         "args": ["node_modules/rea-agents/scripts/rea.mjs", "mcp"],
         "transport": "stdio",
         "enabled": true
       }
     }
   }
   ```

3. **Connect** (the CHISMOSO CLI is the MCP client here):

   ```bash
   chismoso mcp connect rea
   ```

4. **Verify** — `chismoso mcp tools` should now list REA's tools (typically `rea.investigate` and `rea.analyze`).

5. **Test** — in any ReAct investigation, the LLM can now emit `action="product_intel"` with a product name. The orchestrator will call REA, persist the signals, and the next EVALUATE iteration sees them.

Without REA configured, the `chismoso_product_intel` MCP tool + the `product_intel` orchestrator tool both return `available: false` with a clear reason — non-fatal. The investigation continues with the standard signal detection pipeline.

## Files touched (Task IMP-CLONA-2)

| File | Action | Purpose |
|---|---|---|
| `data/mcp-servers.json` | NEW | Default MCP server config with REA shipped disabled. Operators flip `enabled: true` after `npm install rea-agents`. |
| `src/mcp/tools.ts` | MODIFY | Added `chismoso_product_intel` MCP tool (9th tool). Surfaces REA investigations to MCP clients (Claude Desktop, Cursor, Continue.dev). |
| `src/mcp/resources.ts` | MODIFY | Added `chismoso://product_intel/{product}` resource template (2nd template). Side-effect-free read — returns parsed frameworks without persisting. |
| `src/intelligence/product-intel.ts` | NEW | The wrapper that calls REA via MCP and normalizes its output to CHISMOSO `Signal` + `Evidence`. Ports 12 of ClonaKit's `capacidades.mjs` framework translations. |
| `src/orchestrator/tools.ts` | MODIFY | Registered `product_intel` as a CHISMOSO internal tool the ReAct loop can invoke. `category: ['READ', 'EXTERNAL']`, `risk: medium`, `timeout_ms: 300_000`. |
| `src/orchestrator/react.ts` | MODIFY | Added `action="product_intel"` to `ReActDecision`. Updated system prompt, EXECUTE branch, and `safeParseDecision` validator. |
| `docs/MCP.md` | MODIFY | Added a section pointing to this doc. |
| `docs/CLONAKIT-INTEGRATION.md` | NEW | This document. |

## Legal

REA is MIT-licensed at https://github.com/morluto/rea. ClonaKit is also MIT. CHISMOSO uses REA as an external MCP server **without modifying it** — the legal boundary (clean-room, no code copying) is enforced by ClonaKit's own design (REA outputs metadata, not source code).

For more on REA's intended use and the clean-room boundary it enforces, see:
- ClonaKit's `AVISO-LEGAL.md` (in the ClonaKit repo)
- ClonaKit's `LICENSE` (MIT)
- REA's MIT license at https://github.com/morluto/rea

## Future extensions

- **Capabilities table expansion**: `src/intelligence/product-intel.ts` ships 12 of the 50+ framework entries from ClonaKit's `capacidades.mjs`. Operators who want the full table can extend the `CAPABILITIES` constant — it's a plain JS object, no rebuild needed.
- **Multiple REA servers**: the registry already supports multiple MCP servers. Operators who want to investigate Mac apps on a different host can add a second `rea-remote` server pointing at a remote machine that has REA + the Mac binary installed.
- **Persistent cache**: REA's investigations are not currently cached — each call re-runs the investigation. For frequently-mentioned products, a TTL cache on the `investigateProduct()` result would save CPU + REA's wall-clock cost.
