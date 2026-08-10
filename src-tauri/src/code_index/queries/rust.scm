; Rust definition + reference captures.
;
; Capture naming contract (parsed by extract.rs):
;   @def.<kind>  the *name node* of a definition
;   @ref.<kind>  the *name node* of a usage
;
; A node captured as both a def and a ref (e.g. the `type_identifier` in
; `struct Foo` matches both `struct_item name:` and the bare `(type_identifier)`
; catch-all below) is resolved def-first in extract.rs by byte range, so the
; broad reference patterns can stay broad.

; ---------------------------------------------------------------- definitions
(function_item      name: (identifier)       @def.function)
(function_signature_item name: (identifier)  @def.function)
(struct_item        name: (type_identifier)  @def.struct)
(union_item         name: (type_identifier)  @def.struct)
(enum_item          name: (type_identifier)  @def.enum)
(trait_item         name: (type_identifier)  @def.trait)
(mod_item           name: (identifier)       @def.module)
(type_item          name: (type_identifier)  @def.type)
(const_item         name: (identifier)       @def.const)
(static_item        name: (identifier)       @def.const)
(macro_definition   name: (identifier)       @def.macro)
(enum_variant       name: (identifier)       @def.variant)
(field_declaration  name: (field_identifier) @def.field)

; ---------------------------------------------------------------- references
(call_expression function: (identifier) @ref.call)
(call_expression function: (field_expression field: (field_identifier) @ref.call))
(call_expression function: (scoped_identifier name: (identifier) @ref.call))
(macro_invocation macro: (identifier) @ref.macro)
; Imports carry their module path in the same match — see typescript.scm for
; why the pairing has to happen inside one pattern.
(use_declaration
  argument: (scoped_identifier path: (_) @import.module name: (identifier) @ref.import))
(use_declaration
  argument: (scoped_use_list path: (_) @import.module list: (use_list (identifier) @ref.import)))
(use_declaration
  argument: (use_as_clause path: (scoped_identifier name: (identifier) @ref.import) alias: (identifier) @import.local))
; Bare forms that name no module path still bind the name.
(use_declaration (scoped_identifier name: (identifier) @ref.import))
(use_list (identifier) @ref.import)

; Assignment targets — see typescript.scm for why a write is tracked apart
; from a read.
(assignment_expression left: (identifier) @ref.write)
(assignment_expression left: (field_expression field: (field_identifier) @ref.write))
(compound_assignment_expr left: (identifier) @ref.write)
(compound_assignment_expr left: (field_expression field: (field_identifier) @ref.write))

; Broad type catch-all. Covers field types, generics, bounds, return types and
; `impl` headers in one pattern; def sites are subtracted afterwards.
(type_identifier) @ref.type

; Bare value reads: `CONST` passed as an argument, a struct-literal field value,
; a match arm. Without this, anything that is never *called* looks unused, and
; the "unreferenced" answer becomes noise. It is the noisiest pattern here — it
; also matches local bindings and parameter names, which name-based resolution
; cannot distinguish from a same-named global. See `ResolutionStats`.
(identifier) @ref.ident
