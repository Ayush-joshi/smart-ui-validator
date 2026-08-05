# Governed memory

Phase 3 memory is advisory, local-first, and disabled by default. A current explicit instruction and
the pinned current design always outrank policy and confirmed preferences; candidates never control
important behavior. Recall first filters explicit tenant/user and repository/project/component/task
selectors, then lifecycle and expiry, then precedence and confidence. Only then does it apply record,
character, and estimated-token budgets.

## Scopes and lifecycle

Supported scopes are organization, team, user, repository, project, component, session, and task.
Every scope has an explicit identifier. The local single-user provider rejects organization
promotion because that scope must be administrator-controlled.

Records move from `candidate` to `confirmed` or `rejected`. Corrections create a new confirmed record
and mark the original `superseded`; history and evidence links remain intact. Confirmed records become
`expired` when their expiry is reached. Forgetting physically removes the selected record, while
`purge-session` deletes records selected by a run/session identifier.

Each record contains typed value, L0-L3 layer, scope and selectors, tenant/user identity, state,
confidence, evidence, source version/artifact hash references, creator and timestamps, expiry,
sensitivity, retention, consent, conflicts, and supersession links. L0 represents compact interaction
or evidence references, L1 atomic facts/preferences, L2 episodes, and L3 durable profiles. Screenshots,
traces, DOM dumps, CSS dumps, and base64 never belong in memory.

## Consent and questions

The interaction boundary supports blocking, preference, confirmation, and review questions. The
default pre-implementation budget is three. Non-interactive execution fails immediately for a
question without an explicitly configured safe default, so CI never waits forever.

End-of-run learning asks which scope to use (`task`, `repository`, `user`, or `no`), creates only a
candidate, and asks again before confirmation. Learning can be disabled independently from recall.
Remote backends and telemetry are opt-in and currently unsupported.

## Worked lifecycle

1. A run observes that accepted code reused repository spacing tokens.
2. Review asks whether to remember that choice and recommends repository scope.
3. The user chooses repository scope and confirms the exact candidate.
4. A later run in the same identity/repository recalls the compact fact and records its identifier,
   character count, estimated tokens, and exclusions.
5. A pinned Figma value conflicts; pinned design wins and the remembered value remains explainable.
6. `memory correct` creates a replacement and supersedes the original. `memory forget` removes the
   selected record; `memory export` verifies the remaining data.

## Backup, migration, and commands

The default store is `.smart-ui/memory.json`, written with owner-only permissions and an atomic rename.
Back it up only while no process is writing. `memory export` emits a versioned validated document;
`memory import <file> --dry-run` validates without mutation. Imports contain data only—unknown fields,
wrong versions, executable instructions, binary payloads, and unsafe values are rejected.

Commands: `list`, `show`, `explain`, `propose`, `confirm`, `reject`, `correct`, `forget`, `export`,
`import`, and `purge-session`. All require `--target`; use explicit `--tenant` and `--user` outside the
single-user defaults. The store path must remain inside the target repository.

## Agent Memory status and threat model

`agent-memory` is linked from the hardened sibling checkout. Version 0.3.6 now exports `TdaiCore`,
`VectorStore`, configuration, store interfaces, and standalone host adapters alongside the default
OpenClaw registration function. `AgentMemoryProvider` imports only those public exports. Compact L0
references use Agent Memory L0 storage; governed atomic and durable records use L1 storage with their
Smart UI L0-L3 classification retained in the validated payload. Startup rehydrates the governance
provider from SQLite, and integration tests verify persistence, later-run recall, and deletion.

Set `memory.backend` to `agent-memory` or pass `--backend agent-memory` to memory commands. The
supported deployment remains local and single-user. Smart UI also keeps its versioned JSON governance
record so lifecycle and consent remain deterministic and exportable; writes are mirrored to SQLite.
Node 22.16+ is required by Agent Memory, and Node currently labels its built-in SQLite API experimental.

Threats covered by tests include cross-user/repository leakage, malicious tool/permission text,
secret persistence, stale preferences, overgeneralization, binary prompt bloat, recall-budget abuse,
and deletion verification. Remaining deployment risks include dual-write interruption between the
governance JSON and SQLite stores, local plaintext, concurrent JSON writers, OS/user compromise,
incomplete personal-data detection, and unsupported multi-tenant operation.
