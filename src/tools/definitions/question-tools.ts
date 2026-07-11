/**
 * Interactive question tool.
 *
 * `ask_question` lets the model pause and ask the user a structured,
 * multiple-choice question when it is genuinely blocked on a decision only the
 * user can make (one it cannot resolve from the request, the code, or sensible
 * defaults). It renders as an inline card above the composer and BLOCKS the turn
 * until the user submits or skips; the chosen answers come back as the tool
 * result. Frontend-native (executed via `aurora-tools.ts` → `question-bridge`),
 * so there is no Rust executor for it.
 */
import type { ToolDefinition } from "../types";

export const askQuestionTool: ToolDefinition = {
  type: "function",
  function: {
    name: "ask_question",
    description: `Ask the user one or more multiple-choice questions and wait for their answer.

Use this ONLY when you are blocked on a decision that is genuinely the user's to make — one you cannot resolve from the request, the code, or sensible defaults (e.g. a product/scope choice, or a destructive-action confirmation). For most choices (naming, formatting, equivalent approaches) pick a reasonable option and proceed instead of asking.

Behavior:
- Renders an interactive prompt; the turn pauses until the user answers or skips.
- Each question shows lettered options; the user can also pick "Other" and type a custom answer.
- Set \`allow_multiple: true\` on a question to let the user choose several options.
- The result is a JSON object: \`{ skipped, responses: [{ id, prompt, answer }] }\`. If \`skipped\` is true the user declined — continue with your best judgment.
- Prefer ONE call with all the questions you need over several sequential calls. Keep it to a small number of focused questions.`,
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Optional heading for the prompt card. Defaults to \"Questions\".",
        },
        questions: {
          type: "array",
          description: "The questions to ask (1 or more).",
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description: "Stable identifier for this question (echoed back in the result).",
              },
              prompt: {
                type: "string",
                description: "The question text shown to the user.",
              },
              allow_multiple: {
                type: "boolean",
                description: "Allow selecting more than one option. Default false (single choice).",
              },
              options: {
                type: "array",
                description: "The selectable options. An 'Other' free-text entry is always added automatically.",
                items: {
                  type: "object",
                  properties: {
                    id: {
                      type: "string",
                      description: "Stable identifier for this option.",
                    },
                    label: {
                      type: "string",
                      description: "Display text for this option.",
                    },
                  },
                  required: ["id", "label"],
                },
              },
            },
            required: ["id", "prompt", "options"],
          },
        },
      },
      required: ["questions"],
    },
  },
};

export const questionTools: ToolDefinition[] = [askQuestionTool];
