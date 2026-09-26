# ADR-0001: Repository layout and packages

**Status:** accepted (S0) · **Date:** 2026-09-26

## Context

The EFS v2 SDK must serve static browsers and Workers, Node servers and scripts, Solidity
contracts, and later CLI/MCP and native consumers. Each should install only what it needs. The
earlier (v1) SDK showed that empty package stubs, workspace-only testing and a large root
barrel cause drift.

## Decision

- **One repository** with independently buildable, testable and packable parts.
- **One portable TypeScript package, `@efs/sdk`,** ESM-only, with subpath entry points rather
  than several packages. `src/web` is browser/Worker code and `src/node` is Node-only
  (exported under the `node` condition only). The core has no Node or DOM dependencies.
  Further packages (`@efs/cli`, `@efs/mcp`) are added only with working content, never as
  empty stubs.
- **A separate Solidity package,** `@efs/solidity` (ADR-0003).
- **`examples/` are the packed-consumer tests.** They sit outside the pnpm workspace and
  install the exact tarballs, so workspace linking cannot hide packaging mistakes.
- **`tools/` are dependency-free Node scripts,** not a build framework.

## Consequences

Portable-core purity is enforced mechanically (Biome restricted imports and globals, plus
`types: []` in the portable tsconfig), with negative fixtures proving the enforcement fires.
Splitting a subpath into its own package later changes import paths, so it needs its own
decision record.
