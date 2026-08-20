; Go definition + reference captures.
; See rust.scm for the @def.<kind> / @ref.<kind> capture-name contract.

; ---------------------------------------------------------------- definitions
(function_declaration name: (identifier) @def.function)
(method_declaration   name: (field_identifier) @def.method)

; `type X struct` and `type X interface` are ranked above the bare `type_spec`
; catch-all below, so a struct reads as a struct rather than as an alias.
(type_spec name: (type_identifier) @def.struct    type: (struct_type))
(type_spec name: (type_identifier) @def.interface type: (interface_type))
(type_spec name: (type_identifier) @def.type)

(const_spec name: (identifier) @def.const)
(var_spec   name: (identifier) @def.variable)
(field_declaration name: (field_identifier) @def.field)
(method_elem name: (field_identifier) @def.method)

; ---------------------------------------------------------------- references
(call_expression function: (identifier) @ref.call)
(call_expression function: (selector_expression field: (field_identifier) @ref.call))

; An import carries its path in the same match as the local package name, the
; pairing rule from typescript.scm. The aliased form is listed first so the
; plain form does not claim it.
(import_spec
  name: (package_identifier) @import.local
  path: (interpreted_string_literal) @import.module)
(import_spec path: (interpreted_string_literal) @import.module)

; Assignment targets — see typescript.scm for why a write is tracked apart
; from a read.
(assignment_statement left: (expression_list (identifier) @ref.write))
(assignment_statement
  left: (expression_list (selector_expression field: (field_identifier) @ref.write)))
(inc_statement (identifier) @ref.write)
(dec_statement (identifier) @ref.write)

(type_identifier) @ref.type

; Bare value reads — see the matching note in rust.scm.
(identifier) @ref.ident
(field_identifier) @ref.ident
(package_identifier) @ref.ident
