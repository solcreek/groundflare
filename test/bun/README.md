# `test/bun/`

Tests that target code shipping inside the Bun runtime on the VPS.

Run with:

```bash
npm run test:bun     # bun test test/bun
```

## Why a separate runner?

The adapter code in `src/runtime/bun/adapters/*.ts` ships as source to the VPS and executes inside `bun run`. Exercising it through vitest + Node would require a shim layer that re-implements `bun:sqlite`, `Bun.serve`, etc. — which means we'd be testing the shim, not the code we actually deploy.

`bun test` picks up these files with the real Bun runtime, the real `bun:sqlite`, the real Bun-specific APIs. That matches what runs in production. The vitest suite continues to own every test that targets the CLI, the workerd track, shared config, bootstrap, etc.

## Layout

```
test/bun/
├── README.md                # this file
└── adapters/
    ├── kv.test.ts           # bun:sqlite KV adapter
    ├── d1.test.ts           # (Phase 2c)
    └── r2.test.ts           # (Phase 2d)
```

## What should NOT live here

- Anything the CLI running on the user's laptop executes → use `test/unit` with vitest.
- Anything about the workerd track → use `test/conformance` or `test/integration` with vitest.
- Generator output assertions (string shape of generated shim) → `test/unit/runtime/bun/*.test.ts` with vitest; the generators run as Node code.

Only the code that actually *executes inside Bun on the VPS* belongs here.
