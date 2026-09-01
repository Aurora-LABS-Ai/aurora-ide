; Dart / Flutter definition + reference captures.
; See rust.scm for the @def.<kind> / @ref.<kind> capture-name contract.
;
; The definition set is derived from the grammar's own `queries/tags.scm`
; (tree-sitter-dart 0.2.0) rather than invented, so every node name here is one
; the grammar actually produces. Kinds are then mapped onto Aurora's shared
; vocabulary, which has no "mixin" or "extension":
;
;   mixin      -> trait      reusable behaviour grafted onto a class, which is
;                            what `trait` already means for Rust here
;   extension  -> trait      same shape: a named bag of methods added to a type
;   typedef    -> type
;   enum value -> variant    matches Rust's enum variants
;
; Dart declares a member's SIGNATURE and its body as siblings, so the captures
; below land on signature nodes. That is also why `is_callable_node` in lang.rs
; names `function_body` — the body is the node a reference actually sits inside.

; --------------------------------------------------------------- definitions
(class_declaration name: (identifier) @def.class)
(mixin_declaration (identifier) @def.trait)
(extension_declaration name: (identifier) @def.trait)
(extension_type_declaration
  name: (extension_type_name (identifier) @def.type))
(enum_declaration name: (identifier) @def.enum)
(enum_constant name: (identifier) @def.variant)
(type_alias (type_identifier) @def.type)

; Top-level functions, and the getter/setter forms Dart treats as their own
; declarations rather than as methods.
(function_declaration
  signature: (function_signature name: (identifier) @def.function))
(getter_declaration
  signature: (getter_signature name: (identifier) @def.function))
(setter_declaration
  signature: (setter_signature name: (identifier) @def.function))
(external_function_declaration
  signature: (function_signature name: (identifier) @def.function))
(external_getter_declaration
  signature: (getter_signature name: (identifier) @def.function))
(external_setter_declaration
  signature: (setter_signature name: (identifier) @def.function))

; Members. `method_signature` is the class-scoped counterpart of the three
; above; the constructor forms are all methods to a reader looking for "how do
; I make one of these".
(method_signature
  (function_signature name: (identifier) @def.method))
(method_signature
  (getter_signature name: (identifier) @def.method))
(method_signature
  (setter_signature name: (identifier) @def.method))
(constructor_signature name: (identifier) @def.method)
(constant_constructor_signature (identifier) @def.method)
(factory_constructor_signature (identifier) @def.method)
(redirecting_factory_constructor_signature (identifier) @def.method)

; Top-level variables, in the two shapes the grammar splits them into.
(top_level_variable_declaration
  (static_final_declaration_list
    (static_final_declaration name: (identifier) @def.variable)))
(top_level_variable_declaration
  (initialized_identifier_list
    (initialized_identifier name: (identifier) @def.variable)))
(external_variable_declaration
  (identifier_list (identifier) @def.variable))

; Fields. `declaration` is the class-member wrapper, so the same three shapes
; that make a top-level variable make a field one level in — and `field` is the
; kind that keeps them out of the outline's binding noise.
(declaration
  (initialized_identifier_list
    (initialized_identifier name: (identifier) @def.field)))
(declaration
  (static_final_declaration_list
    (static_final_declaration name: (identifier) @def.field)))
(declaration (identifier_list (identifier) @def.field))

; ---------------------------------------------------------------- references
(call_expression function: (identifier) @ref.call)
(call_expression
  function: (member_expression property: (identifier) @ref.call))
(call_expression
  function: (null_aware_member_expression property: (identifier) @ref.call))

; A constructor call in Dart is a plain call — `MediaItem(...)` — and is caught
; by the first pattern above. What that misses is a type NAMED without being
; called: an annotation, a field's declared type, an `extends` clause. Those are
; the edges that answer "who depends on this model", so the bare type reference
; is captured the way rust.scm captures `type_identifier`.
(type_identifier) @ref.type

; The bare-identifier catch-all, ranked below everything above, so a name that
; is only mentioned still ties the file to it. `extract.rs` subtracts a
; definition's own name node, so a declaration never reads as a use of itself.
(identifier) @ref.ident

; ------------------------------------------------------------------- imports
; Captured WITH the module specifier, in one pattern each, because resolution
; needs the pairing: knowing this file imports `Post` is worthless, knowing it
; imports `Post` from `../domain/models/post.dart` names the definition.
;
; `import 'x.dart' as p` binds a namespace, so the alias is the imported name —
; the same treatment typescript.scm gives `import * as p`.
(import_specification
  uri: (uri) @import.module
  alias: (identifier) @ref.import)
(import_specification
  uri: (configurable_uri (uri) @import.module)
  alias: (identifier) @ref.import)

; Every other import, and the export barrels this ecosystem is built on. Both
; bind no local name here but still make the file depend on that module. Keep
; exports distinct: a re-export extends this library's public namespace but
; does not import the name into the exporting file's own scope.
;
; Combinators are captured whole because Dart applies every `show` / `hide`
; clause from left to right. `show A, B hide B` cannot be represented by one
; unordered allow/deny set.
(import_specification
  uri: (uri) @import.module
  (combinator)* @import.combinator)
(import_specification
  uri: (configurable_uri (uri) @import.module)
  (combinator)* @import.combinator)
(library_export
  uri: (configurable_uri (uri) @reexport.module)
  (combinator)* @reexport.combinator)

; Combinator identifiers describe namespace filters, not code references. The
; extractor derives final `show` bindings from the complete ordered chain and
; suppresses every identifier here from the broad reference catch-all.
(import_specification
  uri: (uri) @import.module
  (combinator (identifier) @import.excluded))
(import_specification
  uri: (configurable_uri (uri) @import.module)
  (combinator (identifier) @import.excluded))

; A primary file and its parts are one library, not modules importing each
; other. Keep these out of the dependency graph and let the store build one
; library membership group from the paired directives.
(library_name (dotted_identifier_list) @library.name)
(part_directive uri: (uri) @part.uri)
(part_of_directive (uri) @part.of_uri)
(part_of_directive (dotted_identifier_list) @part.of_name)
