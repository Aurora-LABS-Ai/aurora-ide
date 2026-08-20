; Java definition + reference captures.
; See rust.scm for the @def.<kind> / @ref.<kind> capture-name contract.

; ---------------------------------------------------------------- definitions
(class_declaration      name: (identifier) @def.class)
(record_declaration     name: (identifier) @def.class)
(interface_declaration  name: (identifier) @def.interface)
(annotation_type_declaration name: (identifier) @def.interface)
(enum_declaration       name: (identifier) @def.enum)
(enum_constant          name: (identifier) @def.variant)

(method_declaration      name: (identifier) @def.method)
(constructor_declaration name: (identifier) @def.method)

(field_declaration declarator: (variable_declarator name: (identifier) @def.field))
(local_variable_declaration
  declarator: (variable_declarator name: (identifier) @def.variable))

; ---------------------------------------------------------------- references
(method_invocation name: (identifier) @ref.call)
(object_creation_expression type: (type_identifier) @ref.call)
(explicit_constructor_invocation constructor: (this) @ref.call)

; An import names both the package path and the type it binds, in one node —
; capturing the node twice keeps the pair inside a single match, which is what
; makes resolution possible (see typescript.scm).
(import_declaration
  (scoped_identifier name: (identifier) @ref.import) @import.module)

; Assignment targets — see typescript.scm for why a write is tracked apart
; from a read.
(assignment_expression left: (identifier) @ref.write)
(assignment_expression left: (field_access field: (identifier) @ref.write))
(update_expression (identifier) @ref.write)

(type_identifier) @ref.type

; Bare value reads — see the matching note in rust.scm.
(identifier) @ref.ident
