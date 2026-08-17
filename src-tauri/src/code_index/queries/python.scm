; Python definition + reference captures.
; See rust.scm for the @def.<kind> / @ref.<kind> capture-name contract.

; ---------------------------------------------------------------- definitions
(function_definition name: (identifier) @def.function)
(class_definition    name: (identifier) @def.class)

; Module- and class-level bindings. `extract.rs` cannot tell these from a local
; assignment inside a function body without scope analysis, so the noise is
; accepted the same way it is for TS `variable`.
(assignment left: (identifier) @def.variable)
(assignment left: (attribute attribute: (identifier) @def.field))

; ---------------------------------------------------------------- references
(call function: (identifier) @ref.call)
(call function: (attribute attribute: (identifier) @ref.call))
(decorator (identifier) @ref.call)
; Imports carry their module in the same match — see typescript.scm for why.
(import_from_statement
  module_name: (dotted_name) @import.module
  name: (aliased_import
    name: (dotted_name (identifier) @ref.import)
    alias: (identifier) @import.local))
(import_from_statement
  module_name: (relative_import) @import.module
  name: (aliased_import
    name: (dotted_name (identifier) @ref.import)
    alias: (identifier) @import.local))
(import_from_statement
  module_name: (dotted_name) @import.module
  name: (dotted_name (identifier) @ref.import))
(import_from_statement
  module_name: (relative_import) @import.module
  name: (dotted_name (identifier) @ref.import))
; `import a.b` / `from x import *` bind without a paired specifier.
(aliased_import (dotted_name (identifier) @ref.import))
(import_statement name: (dotted_name (identifier) @ref.import))
; Module-only imports still create dependency edges.
(import_statement name: (dotted_name) @import.module)

; Assignment targets — see typescript.scm for why a write is tracked apart
; from a read. Python's `assignment` also DEFINES, so extract.rs subtracts
; definition sites from references and only foreign writes survive.
(assignment left: (attribute attribute: (identifier) @ref.write))
(augmented_assignment left: (identifier) @ref.write)
(augmented_assignment left: (attribute attribute: (identifier) @ref.write))

; Base classes, type annotations and bare value reads all arrive as plain
; identifiers in Python — there is no separate type-identifier node the way
; there is in Rust and TypeScript.
(identifier) @ref.ident
