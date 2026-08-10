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
(import_specifier name: (identifier) @ref.import)
(namespace_import (identifier) @ref.import)

(type_identifier) @ref.type

; Bare value reads — see the matching note in rust.scm. `shorthand_property_
; identifier` is the `{ foo }` form, which is a distinct node type from a plain
; identifier and is otherwise missed entirely.
(identifier) @ref.ident
(shorthand_property_identifier) @ref.ident
