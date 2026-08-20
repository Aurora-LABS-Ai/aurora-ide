; Swift definition + reference captures.
; See rust.scm for the @def.<kind> / @ref.<kind> capture-name contract.
;
; tree-sitter-swift spells `struct`, `enum`, `actor` and `extension` as
; `class_declaration` too — one node kind covers all of them, which is why
; there is a single @def.class pattern rather than one per keyword.

; ---------------------------------------------------------------- definitions
(class_declaration    name: (type_identifier) @def.class)
(protocol_declaration name: (type_identifier) @def.interface)
(typealias_declaration name: (type_identifier) @def.type)

(function_declaration name: (simple_identifier) @def.function)
(protocol_function_declaration name: (simple_identifier) @def.function)

(property_declaration (pattern (simple_identifier) @def.field))
(enum_entry name: (simple_identifier) @def.variant)

; ---------------------------------------------------------------- references
; The callee is the first child of a call, anchored so an argument cannot
; match it.
(call_expression . (simple_identifier) @ref.call)
(navigation_suffix (simple_identifier) @ref.call)

; `import Foundation` binds a whole module and no single name — the same shape
; as C#'s `using`.
(import_declaration (identifier) @import.module)

; Assignment targets — see typescript.scm for why a write is tracked apart
; from a read.
(assignment target: (directly_assignable_expression (simple_identifier) @ref.write))

(type_identifier) @ref.type

; Bare value reads — see the matching note in rust.scm.
(simple_identifier) @ref.ident
