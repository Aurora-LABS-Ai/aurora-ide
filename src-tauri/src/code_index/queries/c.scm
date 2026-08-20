; C definition + reference captures.
; See rust.scm for the @def.<kind> / @ref.<kind> capture-name contract.
;
; This file is also appended to the C++ query (cpp.scm carries only what C has
; no syntax for), so every pattern here must be valid against BOTH grammars.
; tree-sitter-cpp is a superset of tree-sitter-c, which is what makes that safe.

; ---------------------------------------------------------------- definitions
; C spells a function's name inside its declarator, not in a `name:` field, and
; the same node shape covers a prototype in a header and the definition in the
; .c file. Both are worth indexing: the header is what callers actually read.
(function_declarator declarator: (identifier) @def.function)

; `body:` is REQUIRED on all three. Without it a forward declaration
; (`struct Node;`) and every mention in a variable's type (`struct Node *n;`)
; is indexed as a DEFINITION, competing with the real one — see the note on
; `class_specifier` in cpp.scm, where this produced nine candidates for one
; class and credited the declarations with the callers.
(struct_specifier name: (type_identifier) @def.struct body: (field_declaration_list))
(union_specifier  name: (type_identifier) @def.struct body: (field_declaration_list))
(enum_specifier   name: (type_identifier) @def.enum   body: (enumerator_list))
(enumerator       name: (identifier)      @def.variant)
(type_definition  declarator: (type_identifier) @def.type)
(field_declaration declarator: (field_identifier) @def.field)

; `#define` is C's closest thing to a const, and a large amount of a C API is
; expressed in them — without these, every macro constant reads as undefined.
(preproc_def          name: (identifier) @def.macro)
(preproc_function_def name: (identifier) @def.macro)

(declaration declarator: (init_declarator declarator: (identifier) @def.variable))

; ---------------------------------------------------------------- references
(call_expression function: (identifier) @ref.call)
(call_expression function: (field_expression field: (field_identifier) @ref.call))

; `#include` is C's whole module system. The quoted form names a file in the
; project; the angle-bracket form names a system header and will simply fail to
; resolve, which is the correct answer for it.
(preproc_include path: (string_literal) @import.module)
(preproc_include path: (system_lib_string) @import.module)

; Assignment targets — see typescript.scm for why a write is tracked apart
; from a read.
(assignment_expression left: (identifier) @ref.write)
(assignment_expression left: (field_expression field: (field_identifier) @ref.write))
(update_expression argument: (identifier) @ref.write)

; Broad type catch-all, same role as in rust.scm: covers field types, return
; types, parameters and casts in one pattern. Definition sites are subtracted
; afterwards by byte range.
(type_identifier) @ref.type

; Bare value reads. Noisiest pattern here by design — without it a macro
; constant or a global that is never *called* looks unreferenced.
(identifier) @ref.ident
(field_identifier) @ref.ident
