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
(import_from_statement name: (dotted_name (identifier) @ref.import))
(aliased_import (dotted_name (identifier) @ref.import))
(import_statement name: (dotted_name (identifier) @ref.import))

; Base classes, type annotations and bare value reads all arrive as plain
; identifiers in Python — there is no separate type-identifier node the way
; there is in Rust and TypeScript.
(identifier) @ref.ident
