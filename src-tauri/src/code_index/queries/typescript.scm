; TypeScript definition + reference captures. Shared by the `ts` and `tsx`
; grammars — anything JSX-specific lives in `jsx.scm`, which is appended to
; this file at load time (the plain-TS grammar has no JSX node types and would
; reject those patterns outright).
;
; See rust.scm for the @def.<kind> / @ref.<kind> capture-name contract.

; ---------------------------------------------------------------- definitions
(function_declaration           name: (identifier)      @def.function)
(generator_function_declaration name: (identifier)      @def.function)
(class_declaration              name: (type_identifier) @def.class)
(abstract_class_declaration     name: (type_identifier) @def.class)
(interface_declaration          name: (type_identifier) @def.interface)
(type_alias_declaration         name: (type_identifier) @def.type)
(enum_declaration               name: (identifier)      @def.enum)
(module                         name: (identifier)      @def.module)

(method_definition        name: (property_identifier) @def.method)
(abstract_method_signature name: (property_identifier) @def.method)
(public_field_definition  name: (property_identifier) @def.field)
(property_signature       name: (property_identifier) @def.field)

; A `const x = () => {}` is a function to every reader, so rank it as one.
; The bare `@def.variable` pattern below also matches it; extract.rs keeps the
; higher-ranked kind when two defs land on the same byte range.
(variable_declarator name: (identifier) @def.function value: (arrow_function))
(variable_declarator name: (identifier) @def.function value: (function_expression))
(variable_declarator name: (identifier) @def.variable)

; ---------------------------------------------------------------- references
(call_expression function: (identifier) @ref.call)
(call_expression function: (member_expression property: (property_identifier) @ref.call))
(new_expression  constructor: (identifier) @ref.call)
; Imports are captured WITH their module specifier, in one pattern each, so a
; single query match carries both. That pairing is what makes resolution
; possible: knowing that this file imports `Session` is worthless, knowing it
; imports `Session` from `./session` names the exact definition among thirty
; that share the name. A separate `@ref.import` pattern could never express it,
; because captures are only grouped by match.
(import_statement
  (import_clause
    (named_imports
      (import_specifier
        name: (identifier) @ref.import
        alias: (identifier) @import.local)))
  source: (string) @import.module)
(import_statement
  (import_clause
    (named_imports
      (import_specifier
        name: (identifier) @ref.import
        !alias)))
  source: (string) @import.module)
(import_statement
  (import_clause (namespace_import (identifier) @ref.import))
  source: (string) @import.module)
(import_statement
  (import_clause (identifier) @ref.import)
  source: (string) @import.module)
; `import "./side-effect"` and re-exports bind no local name but still tell us
; the file depends on that module. The import pattern also matches binding
; imports; the graph de-duplicates file pairs and the empty binding is ignored
; by name resolution.
(import_statement source: (string) @import.module)
(export_statement source: (string) @import.module)

; CommonJS. `require()` is a call, not syntax, so these need `#eq?` to tell it
; from any other one-string call — without that, every `console.log("./x")` in
; the project would be read as a module edge.
;
; Not optional for JavaScript the way it is for Ruby (see ruby.scm): Node and
; Electron projects are wired almost entirely this way, and a graph that only
; reads ESM answers "how is this project wired" with zero edges for all of
; them. Reported from a real Electron workspace on 2026-08-31, where `modules`
; returned `dependencies: 0` across eight directories that plainly require each
; other, and `usages` reported `importedByFiles: 0` for a class it had just
; found the callers of.
;
; The four shapes, in the same order as the ESM patterns above.
; `const { Session: S } = require('./session')`
(variable_declarator
  name: (object_pattern
    (pair_pattern
      key: (property_identifier) @ref.import
      value: (identifier) @import.local))
  value: (call_expression
    function: (identifier) @_req
    arguments: (arguments (string) @import.module))
  (#eq? @_req "require"))
; `const { Session } = require('./session')`
(variable_declarator
  name: (object_pattern (shorthand_property_identifier_pattern) @ref.import)
  value: (call_expression
    function: (identifier) @_req
    arguments: (arguments (string) @import.module))
  (#eq? @_req "require"))
; `const engine = require('./engine')`
(variable_declarator
  name: (identifier) @ref.import
  value: (call_expression
    function: (identifier) @_req
    arguments: (arguments (string) @import.module))
  (#eq? @_req "require"))
; `require('./side-effect')`, and the module edge behind every shape above —
; the graph de-duplicates file pairs, and an empty binding is ignored by name
; resolution, exactly as for `import "./side-effect"`.
(call_expression
  function: (identifier) @_req
  arguments: (arguments (string) @import.module)
  (#eq? @_req "require"))

; Assignment TARGETS. A write from outside is a different — and much more
; dangerous — kind of dependency than a read: it reaches past whatever the
; owner intended as its interface. Ranked above `ident` in extract.rs so the
; same node captured by the bare-identifier catch-all reads as a write.
(assignment_expression left: (identifier) @ref.write)
(assignment_expression left: (member_expression property: (property_identifier) @ref.write))
(augmented_assignment_expression left: (identifier) @ref.write)
(augmented_assignment_expression
  left: (member_expression property: (property_identifier) @ref.write))
(update_expression argument: (identifier) @ref.write)
(update_expression argument: (member_expression property: (property_identifier) @ref.write))

(type_identifier) @ref.type

; Bare value reads — see the matching note in rust.scm. `shorthand_property_
; identifier` is the `{ foo }` form, which is a distinct node type from a plain
; identifier and is otherwise missed entirely.
(identifier) @ref.ident
(shorthand_property_identifier) @ref.ident

; A file's export list can arrive at the BOTTOM, detached from the
; declarations: `export default App` and `export { a, b }` — the standard
; React shape. The declaration then sits under no export_statement, so the
; ancestor walk in `is_exported` cannot see it; these carry the late-exported
; NAMES and extract.rs marks the matching top-level symbols. `!source` keeps
; re-exports (`export { x } from "./y"`) out — those export another module's
; symbol, not one defined here. Measured live: an app's root component read
; as exported=false, so the edit-impact note said nothing about the one file
; every other file renders.
(export_statement !source value: (identifier) @export.name)
(export_statement !source
  (export_clause (export_specifier name: (identifier) @export.name)))
