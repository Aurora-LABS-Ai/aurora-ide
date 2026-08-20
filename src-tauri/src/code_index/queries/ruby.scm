; Ruby definition + reference captures.
; See rust.scm for the @def.<kind> / @ref.<kind> capture-name contract.
;
; KNOWN LIMIT — a receiverless call reads as an identifier. Ruby lets `flush`
; mean either "call the method flush" or "read the local variable flush", and
; nothing in the syntax separates them; the upstream tags query resolves it with
; an `(#is-not? local)` predicate, which needs scope analysis this extractor
; does not do. So `obj.flush` is a call and bare `flush` is an identifier
; reference. It is still attributed to the method it appears in, so "what
; touches flush" is answered — only the call/read distinction is lost.
;
; NO IMPORT PATTERNS, deliberately. Ruby's `require` is an ordinary method call
; with a string argument, not syntax — telling it apart from any other one-string
; call needs a query predicate, and this extractor reads captures without
; evaluating predicates, so a `@import.module` here would label every string
; argument in the codebase as a module. Ruby therefore resolves by the
; same-file / same-directory / ambiguous arms of the cascade only.

; ---------------------------------------------------------------- definitions
(method           name: (identifier) @def.function)
(singleton_method name: (identifier) @def.method)
(alias            name: (identifier) @def.function)

(class  name: (constant) @def.class)
(class  name: (scope_resolution name: (constant) @def.class))
(module name: (constant) @def.module)
(module name: (scope_resolution name: (constant) @def.module))

; A constant assignment is Ruby's declaration form; a lowercase one at file
; scope is a variable. `extract.rs` cannot tell a module-level binding from a
; method-local one without scope analysis, so the noise is accepted the same
; way it is for Python and TypeScript.
(assignment left: (constant)          @def.const)
(assignment left: (identifier)        @def.variable)
(assignment left: (instance_variable) @def.field)

; ---------------------------------------------------------------- references
(call method: (identifier) @ref.call)

; Assignment targets — see typescript.scm for why a write is tracked apart
; from a read. Ruby's `assignment` also DEFINES, so extract.rs subtracts
; definition sites and only foreign writes survive.
(operator_assignment left: (identifier)        @ref.write)
(operator_assignment left: (instance_variable) @ref.write)
(assignment left: (call receiver: (_) method: (identifier) @ref.write))

; Bare value reads. Ruby has no type-identifier node — a constant is how a
; class is named at a use site, so it carries what `@ref.type` carries
; elsewhere.
(identifier) @ref.ident
(constant) @ref.ident
(instance_variable) @ref.ident
