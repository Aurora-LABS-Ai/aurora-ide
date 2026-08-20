; Kotlin definition + reference captures.
; See rust.scm for the @def.<kind> / @ref.<kind> capture-name contract.

; ---------------------------------------------------------------- definitions
(class_declaration  name: (identifier) @def.class)
(object_declaration name: (identifier) @def.class)
(function_declaration name: (identifier) @def.function)

; `val`/`var` at any scope. Kotlin puts the name inside a `variable_declaration`
; rather than on a field of the property, so the property node is only the
; anchor.
(property_declaration (variable_declaration (identifier) @def.variable))
(class_parameter (identifier) @def.field)

; ---------------------------------------------------------------- references
; The callee is the FIRST child of a call — anchored with `.` so the pattern
; cannot also match an identifier passed as an argument. The second form is
; `receiver.method()`: the method name is the LAST identifier of the navigation,
; anchored so a plain property read (which has no call around it) stays an
; ordinary identifier reference instead of being counted as a call.
(call_expression . (identifier) @ref.call)
(call_expression . (navigation_expression (identifier) @ref.call .))

; `import a.b.C` names the module and the bound symbol in one qualified path.
(import (qualified_identifier) @import.module)
(import (identifier) @import.module)

; Type positions are spelled `user_type`, which is the one place Kotlin
; distinguishes a type name from a value name.
(user_type (identifier) @ref.type)

; Bare value reads — see the matching note in rust.scm.
(identifier) @ref.ident
