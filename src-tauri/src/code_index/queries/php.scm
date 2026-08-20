; PHP definition + reference captures.
; See rust.scm for the @def.<kind> / @ref.<kind> capture-name contract.
;
; Parsed with `LANGUAGE_PHP` (the whole-file grammar), so a template that is
; mostly HTML still yields its PHP symbols.

; ---------------------------------------------------------------- definitions
(namespace_definition name: (namespace_name) @def.module)

(class_declaration     name: (name) @def.class)
(interface_declaration name: (name) @def.interface)
(trait_declaration     name: (name) @def.trait)
(enum_declaration      name: (name) @def.enum)
(enum_case             name: (name) @def.variant)

(function_definition name: (name) @def.function)
(method_declaration  name: (name) @def.method)

(property_declaration (property_element (variable_name (name) @def.field)))
(const_element (name) @def.const)

; ---------------------------------------------------------------- references
(function_call_expression function: (name) @ref.call)
(function_call_expression function: (qualified_name (name) @ref.call))
(member_call_expression name: (name) @ref.call)
(scoped_call_expression name: (name) @ref.call)
(object_creation_expression (name) @ref.call)
(object_creation_expression (qualified_name (name) @ref.call))

; `use App\Thing;` binds one name from one namespace — the pair captured in a
; single match, the rule from typescript.scm. The aliased form is listed first
; so the plain form does not claim it.
(namespace_use_clause
  (qualified_name (name) @ref.import) @import.module
  alias: (name) @import.local)
(namespace_use_clause (qualified_name (name) @ref.import) @import.module)
; `use Foo;` with no namespace path still binds the name.
(namespace_use_clause (name) @ref.import)

; Assignment targets — see typescript.scm for why a write is tracked apart
; from a read.
(assignment_expression left: (variable_name (name) @ref.write))
(assignment_expression
  left: (member_access_expression name: (name) @ref.write))
(augmented_assignment_expression left: (variable_name (name) @ref.write))

; Bare value reads — PHP writes type names, constants and function names all
; as `name`, so this one pattern carries what `@ref.type` carries elsewhere.
(name) @ref.ident
