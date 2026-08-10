; TSX-only patterns, appended to typescript.scm for the `tsx` grammar.
;
; `<Foo />` is a real usage of the component `Foo` and is often the ONLY usage —
; a React component that is never called as a function still has callers. Without
; this, every component in the codebase reads as dead code.

(jsx_opening_element      name: (identifier) @ref.jsx)
(jsx_self_closing_element name: (identifier) @ref.jsx)
