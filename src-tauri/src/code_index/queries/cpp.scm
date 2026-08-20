; C++ definition + reference captures.
;
; APPENDED TO c.scm at load time (see `Lang::query_source`). C++ is a superset
; of C at the grammar level as well as the language level, so every C pattern
; already compiles here — this file adds only what C has no syntax for.
; Do not repeat a pattern from c.scm; it would double every match.

; ---------------------------------------------------------------- definitions
; `body:` is REQUIRED, and dropping it is the bug this line was reported for.
; `class LicenseManager;` — a forward declaration written to break a header
; cycle — is also a `class_specifier`, just without a body. Indexed as a
; definition it competes with the real one: a codebase with 15 forward
; declarations produced 9 candidates for one class, credited the declarations
; with 12 and 4 callers, and left the actual definition reporting 0. Forward
; declaration is idiomatic C++, so this affects every C++ project.
(class_specifier name: (type_identifier) @def.class body: (field_declaration_list))
(namespace_definition name: (namespace_identifier) @def.module)
(alias_declaration name: (type_identifier) @def.type)
(concept_definition name: (identifier) @def.type)

; A method is a `function_declarator` whose declarator is a field name (inside
; the class body) or a qualified name (the out-of-line definition in the .cpp).
; Both spellings must land on the same symbol or every class reads as having
; declarations with no implementations.
(function_declarator declarator: (field_identifier) @def.method)
(function_declarator
  declarator: (qualified_identifier name: (identifier) @def.method))
; The WHOLE `destructor_name` node, never the identifier inside it. That inner
; identifier is the bare class name, so `~PianoRollGrid()` was indexed as
; `PianoRollGrid` — byte-identical to the constructor, and every caller of one
; was attributed to both. The `~` is the only thing separating two different
; functions.
(function_declarator
  declarator: (qualified_identifier name: (destructor_name) @def.method))
(function_declarator declarator: (destructor_name) @def.method)

; ---------------------------------------------------------------- references
(call_expression function: (qualified_identifier name: (identifier) @ref.call))
(call_expression function: (template_function name: (identifier) @ref.call))

; `using ns::thing;` binds a name into this scope — the nearest C++ has to an
; import of a single symbol.
(using_declaration (qualified_identifier name: (identifier) @ref.import))

(namespace_identifier) @ref.ident
