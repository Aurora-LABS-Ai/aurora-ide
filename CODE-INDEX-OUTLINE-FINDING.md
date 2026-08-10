# Finding: `code` outline reports phantom class members

**Component:** Aurora Agent IDE — code index / symbol extractor
**Repo:** `E:\VOID-EDITOR\Aurora-Agent-IDE`
**Tool affected:** `code` (`op: "outline"`)
**Severity:** Medium — wrong data, not a crash. `outline` is trustworthy for classes/methods/functions/types; its `field` and `variable` rows are noise.
**Status:** Diagnosed, not yet fixed. Root cause located and verified against source.

---

## 1. Summary

`code` with `op: "outline"` emits symbols that are not class members. Two separate
patterns produce them, and one missing scope check amplifies both by attaching a
bogus `Class::` prefix:

1. **Method-local `const`s** are reported as `Class::localName` with `kind: "variable"`.
2. **Members of anonymous inline object types** (parameter annotations, return types)
   are reported as `Class::propName` with `kind: "field"`.

Both inflate the symbol count and misrepresent a class's real surface. Everything
else `outline` reports (classes, methods, functions, types, interfaces) is accurate.

---

## 2. Reproduction (verified against real source)

### Case A — method-local `const` shown as a field/variable

File: `alvanworld-engine/src/modules/media/providers/datacrunch-image.provider.ts`

Real source (line 43-51):

```ts
validateConfig(config: ImageProviderConfig) {
  const errors: string[] = [];          // line 44
  if (!config.api_key) { errors.push('DataCrunch API key is required'); }
  if (!config.model_id) { errors.push('Model ID is required'); }
  return { valid: errors.length === 0, errors };
}
```

`outline` output for that file included:

```json
{ "line": 44, "kind": "variable", "symbol": "DataCrunchImageProvider::errors" }
{ "line": 58, "kind": "variable", "symbol": "DataCrunchImageProvider::startTime" }
{ "line": 61, "kind": "variable", "symbol": "DataCrunchImageProvider::endpoint" }
{ "line": 62, "kind": "variable", "symbol": "DataCrunchImageProvider::payload" }
{ "line": 63, "kind": "variable", "symbol": "DataCrunchImageProvider::response" }
{ "line": 64, "kind": "variable", "symbol": "DataCrunchImageProvider::images" }
```

None of these are class members. They are function-scoped `const` bindings inside
method bodies. The class reported 63 symbols; only ~8 are real members.

### Case B — anonymous inline object-type members shown as fields

File: `alvanworld-engine/src/modules/chats/chats.service.ts`

Real source:

```ts
listChats(
  userId: string,
  filters?: { archived?: boolean; pinned?: boolean },   // line 30
): Promise<ChatRecord[]> { ... }

renameChat(
  ...
): Promise<{ id: string; title: string }> { ... }        // line 72
```

`outline` output included:

```json
{ "line": 30, "kind": "field", "symbol": "ChatsService::archived" }
{ "line": 30, "kind": "field", "symbol": "ChatsService::pinned" }
{ "line": 72, "kind": "field", "symbol": "ChatsService::id" }
{ "line": 72, "kind": "field", "symbol": "ChatsService::title" }
```

`archived`, `pinned`, `id`, `title` are members of **anonymous inline object types**
(a parameter annotation and a return type), not fields of `ChatsService`.

---

## 3. Root cause

### 3a. Two query patterns over-fire

`src-tauri/src/code_index/queries/typescript.scm`:

```scheme
(public_field_definition  name: (property_identifier) @def.field)
(property_signature       name: (property_identifier) @def.field)   ; over-fires (Case B)
...
(variable_declarator      name: (identifier)          @def.variable) ; method-locals (Case A)
```

- `@def.variable` on `variable_declarator` is **correct** for reference-graph
  purposes (it lets `usages` see reads/writes of a binding). The problem is only
  that these locals then surface in `outline` and get a class prefix.
- `property_signature @def.field` was intended for interface members, but the same
  node type also appears inside anonymous inline object types (`{ id: string }`),
  so it captures those too.

### 3b. `enclosing_container` has no scope barrier (the amplifier)

`src-tauri/src/code_index/extract.rs`:

```rust
fn enclosing_container(node, src, lang) -> Option<String> {
    let mut cur = node.parent();
    while let Some(n) = cur {
        if lang.is_container_node(n.kind()) { /* returns class/interface name */ }
        cur = n.parent();
    }
    None
}
```

It walks parents up to the nearest class/interface and **never stops at a function
body or an anonymous object type**. So a method-local `const` and an inline
object-type prop both inherit the enclosing class name, producing `Class::errors`,
`ChatsService::id`, etc.

The fix pattern already exists in the sibling function `is_exported` in the same
file — it stops its ancestor walk at `statement_block` precisely because "a `const`
inside an exported function's body is a local, not an export." `enclosing_container`
was never given the equivalent barrier.

Subtlety for Case B: in tree-sitter-typescript an **interface body is also an
`object_type` node**, so `object_type` cannot be a blanket barrier or real interface
members would lose their container. The distinguishing fact is the `object_type`'s
parent: `interface_declaration` (real member) vs. a type annotation / type argument
(anonymous inline type).

---

## 4. Proposed fix (for when reopened in the IDE workspace)

Minimal, mirrors the existing `is_exported` barrier logic.

### Step 1 — add a scope barrier to `enclosing_container` (`extract.rs`)

```rust
fn enclosing_container(node: Node<'_>, src: &[u8], lang: Lang) -> Option<String> {
    let mut cur = node.parent();
    while let Some(n) = cur {
        match n.kind() {
            "statement_block" => return None,               // TS/JS function body
            "block" if lang == Lang::Rust => return None,   // Rust fn body
            "object_type" => {
                let parent_is_interface = n.parent()
                    .map(|p| p.kind() == "interface_declaration")
                    .unwrap_or(false);
                if !parent_is_interface { return None; }     // anonymous inline type
            }
            _ => {}
        }
        if lang.is_container_node(n.kind()) {
            if let Some(t) = named_child_text(n, "type", src) { return Some(t); }
            if let Some(t) = named_child_text(n, "name", src) { return Some(t); }
        }
        cur = n.parent();
    }
    None
}
```

This removes the bogus `Class::` prefix from both cases.

### Step 2 — stop the bare props/locals appearing as outline rows

After Step 1 the inline-type props and method-locals still exist as bare symbols.
Lowest-risk option (zero blast radius on `definition`/`usages`/`modules`): filter in
`src-tauri/src/code_index/store.rs::outline` —

- exclude `kind == "variable"` (a method-local is never a useful outline entry), and
- exclude `kind == "field"` whose `container` is `None` after Step 1 (anonymous
  inline-type prop).

Keep the underlying extraction unchanged so the reference graph is unaffected.

### Step 3 — regression tests (`extract.rs`, mirror existing fixture style)

- Assert a method-local `const` has `container == None` and does not surface as a
  class member.
- Assert an inline `{ id: string }` return type produces no `field` symbol.
- Keep `plain_consts_stay_variables` and
  `a_local_inside_an_exported_function_is_not_itself_exported` passing.

Verify with `cargo test` scoped to the `code_index` module.

---

## 5. What is NOT broken (verified)

- `op: "definition"` — bare/ambiguous/qualified/`in_file` all correct.
- `op: "usages"` — real import-graph resolution; coupling breakdown accurate.
- `op: "modules"` — fan-in/out and cycle detection accurate at area/dir/file.
- `op: "refresh"` — full rebuild; live create/delete reflected correctly.
- `outline` line numbers and `class`/`method`/`function`/`type`/`interface` rows —
  all accurate. Only `variable` and container-less `field` rows are noise.

---

## 6. Files to touch

| File | Change |
|---|---|
| `src-tauri/src/code_index/extract.rs` | Add scope barrier to `enclosing_container`; add regression tests |
| `src-tauri/src/code_index/store.rs` | Filter `variable` / container-less `field` from `outline` |
| `src-tauri/src/code_index/queries/typescript.scm` | (Optional) comment noting `property_signature` also matches inline object types |
