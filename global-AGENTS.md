# Global AGENTS guide — modular architecture rules

> Portable, language-agnostic rules for any agent (human or AI) working in
> **any** repository — Python, Go, TypeScript/JS, Rust, Java, a web app, a
> backend service, a library. Copy this file to a project's root (or paste its
> contents into that project's `AGENTS.md` / `CLAUDE.md` / `.cursorrules`) and
> the agent must follow it. Project-specific rules layer on top; where they
> conflict, the project's own file wins.

This encodes one idea: **every module is a small, single-purpose unit behind a
public boundary, and dependencies only ever point inward.** Folder names and
the boundary mechanism change per language; the shape does not.

---

## 0. The prime directive

**Always respect the existing structure and always keep it modular.** Before
creating or moving any file: find the module that owns the concern and put the
code there. Never drop new files into a flat root, a `utils` junk-drawer, or a
2,000-line file "because it's quick." If the right module doesn't exist, create
it with the shape below.

---

## 1. The required module shape (any language)

A "module" is a folder that owns one domain/feature. It has:

```
<module>/
├── <entry>            # the public surface — the ONLY thing other modules import
├── README.md          # for non-trivial modules: what it is + invariants (optional for small ones)
├── core/ | <domain>/  # the central logic
├── <concern>/         # one folder per concern: state, parsing, transport,
│                      #   persistence, validation, … — whatever the domain has
├── adapters/ |        # everything that talks to the outside world
│   channels/          #   (HTTP, sockets, DB, OS, third-party SDKs, IPC)
└── shared/ | common/  # leaf utilities — may import nothing else in the module
```

The **public boundary** (`<entry>`) is the heart of the rule. Outsiders import
the entry, never deep internal paths — so the internals stay free to change.
Per language:

| Language | Public boundary (`<entry>`) | Deep-import rule |
|---|---|---|
| TypeScript/JS | `index.ts` barrel (re-exports) | consumers import `module/`, not `module/internal/x` |
| Python | `__init__.py` (re-exports public names); `_private.py` for internals | import the package, not `pkg.internal.x` |
| Go | the package itself; lowercase = unexported, Uppercase = public | callers use exported identifiers only |
| Rust | `mod.rs` / `lib.rs` with `pub use`; non-`pub` items stay private | `pub` surface only |
| Java/Kotlin | the package; `public` vs package-private | depend on public types |

If your language has no enforced boundary, **document the public surface in the
entry file and treat deep imports as review-blocking violations.**

---

## 2. Non-negotiable rules

1. **Respect the structure.** New code goes in the module that owns the concern.
2. **No god-files.** One concern per file, one responsibility per function/type.
   Target **≤ ~400 lines** per file. If a change would push past that, split by
   concern *first*, then make the change. (Pure-data files — large schema/config
   tables with no logic — are the one allowed exception; say so in a comment.)
3. **Public boundary.** Consumers import the module's entry, never deep paths.
   Internal modules import each other directly but **never import their own
   entry/barrel** (that creates cycles).
4. **Dependency direction is law.** Draw the arrow; it must point from outer
   layers inward, never sideways or back out:
   `shared → adapters' helpers → concern packages → core → outward adapters/channels`.
   Outer layers call inward; **core never imports its own channels/adapters.**
   When a low layer needs something from a high layer, invert it: define a
   small interface/port in the low layer and let the high layer implement it.
5. **Name = layer.** The path must tell you which layer a file is in
   (e.g. `channels/telegram/bridge` — an outbound adapter — vs `tools/telegram`
   — a capability the core calls). No ambiguous twins.
6. **Folder-per-concern, file-per-responsibility.** A domain gets a folder; a
   responsibility gets a small named file inside it. Big families get a folder,
   never one mega-file.
7. **Tests live next to sources** (`foo.ts`+`foo.test.ts`, `foo.py`+`test_foo.py`
   / `foo_test.go` per the language's convention). A module with no tests is
   visibly naked in review.
8. **Stable public names.** When you split a file, keep the same public names
   exported from the same boundary so consumers don't change.

---

## 3. UI / frontend is NOT exempt

A `.tsx`/`.jsx`/`.vue`/Compose/SwiftUI feature is a module too. Feature folder:

```
<feature>/
├── index.ts(x)        # public entry
├── components/        # small, single-purpose view components
├── hooks/ | logic/    # state, derived data, side-effects
├── store/             # local state (only if the feature owns state)
└── types.ts
```

No 1,000-line components. No business logic, data fetching, or transport calls
inside JSX/markup files — those live in `hooks/`, `logic/`, or `store/`. The
view renders; it does not orchestrate.

---

## 4. The safe restructuring playbook

When you turn a messy folder into the shape above, do it in this exact order so
the build stays green at **every** step. Never "big-bang" a restructure.

**Phase 0 — Safety net (no moves).** Establish/confirm the green baseline
(typecheck + lint + tests). Create the module's public entry that re-exports the
*current* public surface. Switch all **external** consumers to import the entry.
Now no internal move can break the rest of the codebase.

**Phase 1 — Pure moves (zero logic edits).** Relocate files into concern
folders using the VCS move (`git mv` — preserves history). Fix only the import
paths. One logical group at a time; re-verify green after each.

**Phase 2 — God-file splits (one file per commit).** Easiest → hardest. Move
verbatim blocks into sibling files behind a facade; the facade keeps the same
public surface. For a **stateless** file (free functions): straightforward —
extract groups into modules the entry re-exports. For a **stateful class**:
keep the class shell as a facade and extract method-groups into modules it
calls; this is a real refactor (you change `this.x` → passed-in deps), so it
needs a **runtime smoke test**, not just typecheck. If that test isn't
available, leave the class intact and record it as documented debt rather than
risk a silent regression.

**Phase 3 — Lock it in.** Invert any remaining wrong-way dependencies via
ports/interfaces. Write the module `README.md` (the tree + the invariants +
known debt). Add an import-boundary lint rule if the toolchain supports one
(ESLint `import/no-restricted-paths` / `dependency-cruiser`; `import-linter` for
Python; `depguard` for Go; Rust visibility; ArchUnit for Java).

### Verification gates (run after every step, not just at the end)
- Type/compile check green.
- Lint green — and confirm your changes add **zero new** violations vs baseline.
- For behaviour-preserving splits, prove equivalence mechanically where you can:
  diff the exported public-name set before/after, diff the registered
  command/tool/route names, etc. — they must be identical.
- For stateful refactors, a runtime smoke test of the real path.

### Move-map technique (for dense, many-file folders)
When relocating many interdependent files, drive the import rewrite from a
single map (`filename → new folder`) rather than editing by hand: move the
files, then for each file recompute every relative import from its new location
using the map. The compiler is the guardrail — any wrong path fails to build.

---

## 5. What "modular" buys (why this matters)

- **Change is local.** A bug or feature touches one small file, not a 3,000-line
  god-object everyone edits and conflicts on.
- **The boundary is a contract.** Internals refactor freely behind the entry;
  consumers never notice.
- **The arrow prevents rot.** Inward-only dependencies stop the slow slide into
  a tangled cycle where everything imports everything.
- **Names are a map.** A newcomer (or an agent) navigates by path, not by
  reading files to discover what they are.

---

## 6. Anti-patterns to refuse

- A flat folder of 20+ sibling files with no grouping.
- A single file over ~400 lines mixing several concerns.
- A `utils.ts` / `helpers.py` / `misc/` junk-drawer accreting unrelated code.
- Deep imports that reach past a module's public entry into its internals.
- Business logic inside view/markup files.
- A "quick" new file dropped at the root instead of in the module that owns it.
- Big-bang restructures that leave the build red between steps.
- Splitting a stateful class with no runtime test to catch a silent regression.

---

*Adapt the folder names to the domain; keep the shape, the boundary, the inward
arrow, and the green-at-every-step discipline. That is the whole rule.*
