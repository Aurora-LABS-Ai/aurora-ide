; C# definition + reference captures.
; See rust.scm for the @def.<kind> / @ref.<kind> capture-name contract.
;
; C# has no distinct type-identifier node — a type name and a value name are
; both `identifier` — so there is no `@ref.type` pattern here and the bare
; identifier catch-all carries type references too.

; ---------------------------------------------------------------- definitions
(class_declaration     name: (identifier) @def.class)
(record_declaration    name: (identifier) @def.class)
(struct_declaration    name: (identifier) @def.struct)
(interface_declaration name: (identifier) @def.interface)
(enum_declaration      name: (identifier) @def.enum)
(enum_member_declaration name: (identifier) @def.variant)
(delegate_declaration  name: (identifier) @def.type)

(method_declaration       name: (identifier) @def.method)
(constructor_declaration  name: (identifier) @def.method)
(local_function_statement name: (identifier) @def.function)

(property_declaration name: (identifier) @def.field)
(event_declaration    name: (identifier) @def.field)
(field_declaration (variable_declaration (variable_declarator (identifier) @def.field)))

(namespace_declaration name: (identifier)     @def.module)
(namespace_declaration name: (qualified_name) @def.module)

; ---------------------------------------------------------------- references
(invocation_expression function: (identifier) @ref.call)
(invocation_expression
  function: (member_access_expression name: (identifier) @ref.call))
(object_creation_expression type: (identifier) @ref.call)

; `using` is C#'s import. It binds a whole namespace rather than one name, so
; it produces a module edge with no paired local — the same shape as Python's
; `import a.b`.
(using_directive (qualified_name) @import.module)
(using_directive (identifier) @import.module)

; Assignment targets — see typescript.scm for why a write is tracked apart
; from a read.
(assignment_expression left: (identifier) @ref.write)
(assignment_expression
  left: (member_access_expression name: (identifier) @ref.write))

; Bare value reads — see the matching note in rust.scm.
(identifier) @ref.ident
