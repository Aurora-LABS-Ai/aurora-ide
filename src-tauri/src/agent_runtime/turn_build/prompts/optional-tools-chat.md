## Optional tools
- Call the core tools in your tool list directly, including research, memory, canvas, images, and skills.
- Connected MCP apps are available through `tool_search`. Search by task keywords, or `select:exact_name` when you know the name. Results contain descriptions and complete argument schemas for tools available in this turn.
- Invoke an optional tool with `call_tool({"name":"exact_name","arguments":{...}})`, following its returned schema. Discovery does not add direct tools. Use {} for a tool with no arguments. Existing permission checks still apply.
- Search results can be partial. If a needed name is absent, use `select:exact_name` before concluding it is unavailable. Reuse a schema while it remains in context; search again after compaction removes it.