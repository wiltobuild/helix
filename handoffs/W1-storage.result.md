**Summary**  
Implemented the SQLite `HelixStore` against frozen contracts. Changes are uncommitted and limited to `packages/storage/**` plus the [result report](C:/Users/Wil/Documents/Projects/helix-wt/w1-storage/handoffs/W1-storage.result.md).

**Public API**

```ts
openStore(options?: OpenStoreOptions): StorageStore;
createEventStore(options?: OpenStoreOptions): StorageStore;
```

`StorageStore` implements `HelixStore` and adds:

```ts
listRecordings(): Promise<RecordingInfo[]>;
readRecording(id: string): Promise<Helixlog | undefined>;
```

Exports options/recording types and five `HelixError` subclasses: `EventValidationError`, `RecordingValidationError`, `IdempotencyConflictError`, `ProjectConflictError`, and `StorageError`. Full signatures are in the report.

**Files**  
Added store, migrations, errors, and 29 tests; updated exports, README, and package-local formatting script.

**New dependencies**  
None; uses Node 24’s built-in SQLite.

**Decisions**  
Transactional appends, per-subscriber cursors, first-response idempotency, and isolated replay storage with content-hash recording IDs.

**CONTRACT-REQUESTs**  
Add recording IDs and lookup methods to the shared recording contracts. The current workaround is documented; frozen contracts remain unchanged.

**Verification**

- Root `pnpm.cmd check`: **exit 0**.
- **29 storage tests**, **208 workspace tests**, and **20 tooling tests** passed.
- Boundaries passed across **84 modules**.
- Append 10,000 events: **724.17 ms**.
- Read 1,000 events: **40.34 ms**.
- Formatting and `git diff --check` passed.

**Known gaps / follow-ups**  
Subscriptions require one in-process store instance. Shared recording lookup contracts, redaction, and retention policy remain follow-ups.