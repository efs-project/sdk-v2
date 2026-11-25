# Examples = packed-consumer tests

Every directory here is an ordinary project **outside** the pnpm workspace.
`node tools/consumers.mjs` copies each one to a temporary directory and installs the exact
tarballs produced by `node tools/pack.mjs`, so workspace linking can never hide a missing
file, export or dependency. Then it runs the example.

At S0 all four are `smoke` placeholders (see `LIMITATIONS.md`):

| Example | Proves |
| --- | --- |
| `smoke-node` | The Node ESM import of `.`, `./web` and `./node` from the tarball works |
| `smoke-ts-strict` | A strict TypeScript consumer typechecks against the published declarations (TS 5.9, 6.0 and 7.0 in `compat.yml`) |
| `smoke-browser` | A browser bundle of the root entry contains no `node:` module, and `@efs/sdk/node` does not resolve under browser conditions |
| `smoke-foundry` | A Foundry project compiles against the Solidity release archive using the documented remapping |
| `smoke-fixture` | The two tarballs start a fixture chain, pin it, edit the seeded `readme.txt` and read it back (`--only fixture`, needs `anvil`) |
| `getting-started` | The getting-started guide, every step asserted: pin, read, a declined then completed edit, a lost wallet answer recovered after a reload, and the copy rule for each outcome (`--only fixture`) |

Real examples replace these as SDK features land.
