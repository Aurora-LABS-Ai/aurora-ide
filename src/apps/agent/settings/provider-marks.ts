/**
 * Which picture stands for which brand.
 *
 * Brand marks are the one place the agent window uses artwork it did not draw.
 * `AgentIcon` is hand-authored on Aurora's own grid so the window has a single
 * visual language — but a company's logo is not an icon in that sense. It has
 * to be reproduced exactly, and redrawing it to our conventions would make it
 * wrong. So these come from `@lobehub/icons` (MIT), which packages the marks as
 * React components.
 *
 * **Imports reach the leaf component on purpose.** Three paths into that
 * package cost wildly different amounts:
 *
 * - `{ OpenAI } from "@lobehub/icons"` — the barrel re-exports a `features`
 *   entry that imports ALL 332 icons to build its lookup tables.
 * - `from "@lobehub/icons/es/OpenAI"` — better, but that index wires up an
 *   `.Avatar` variant, which pulls in `@lobehub/ui`, which pulls in an entire
 *   component library and a full emoji dataset. For a 26px logo.
 * - `from "@lobehub/icons/es/OpenAI/components/Mono"` — imports `../style` and
 *   `react/jsx-runtime`, and nothing else at all.
 *
 * The third is what this file uses. It is also what lets the test runner, which
 * does not tree-shake, load this module at all.
 *
 * kenari is the exception to everything here: it is not in that set, so its own
 * published mark ships in `public/brand/`.
 */


// Colour marks — brands that publish one.
import React from "react";

import BedrockColor from "@lobehub/icons/es/Bedrock/components/Color";
import CerebrasColor from "@lobehub/icons/es/Cerebras/components/Color";
import ClaudeColor from "@lobehub/icons/es/Claude/components/Color";
import CodexColor from "@lobehub/icons/es/Codex/components/Color";
import CohereColor from "@lobehub/icons/es/Cohere/components/Color";
import DeepInfraColor from "@lobehub/icons/es/DeepInfra/components/Color";
import DeepSeekColor from "@lobehub/icons/es/DeepSeek/components/Color";
import DoubaoColor from "@lobehub/icons/es/Doubao/components/Color";
import FireworksColor from "@lobehub/icons/es/Fireworks/components/Color";
import GoogleColor from "@lobehub/icons/es/Google/components/Color";
import HuggingFaceColor from "@lobehub/icons/es/HuggingFace/components/Color";
import HyperbolicColor from "@lobehub/icons/es/Hyperbolic/components/Color";
import MetaColor from "@lobehub/icons/es/Meta/components/Color";
import MinimaxColor from "@lobehub/icons/es/Minimax/components/Color";
import MistralColor from "@lobehub/icons/es/Mistral/components/Color";
import NovitaColor from "@lobehub/icons/es/Novita/components/Color";
import NvidiaColor from "@lobehub/icons/es/Nvidia/components/Color";
import OpenRouterColor from "@lobehub/icons/es/OpenRouter/components/Color";
import PerplexityColor from "@lobehub/icons/es/Perplexity/components/Color";
import QwenColor from "@lobehub/icons/es/Qwen/components/Color";
import SambaNovaColor from "@lobehub/icons/es/SambaNova/components/Color";
import SiliconCloudColor from "@lobehub/icons/es/SiliconCloud/components/Color";
import TogetherColor from "@lobehub/icons/es/Together/components/Color";
import ZhipuColor from "@lobehub/icons/es/Zhipu/components/Color";

// Mono marks — brands whose identity IS monochrome. Not a shortfall: OpenAI,
// Anthropic and Ollama have no colour mark to use.
import AtlasCloudMono from "@lobehub/icons/es/AtlasCloud/components/Mono";
// Cursor publishes no colour mark — the wordmark's glyph is monochrome by
// design, so Mono is the real logo here rather than a fallback.
import CursorMono from "@lobehub/icons/es/Cursor/components/Mono";
import OpenCodeMono from "@lobehub/icons/es/OpenCode/components/Mono";
import AzureMono from "@lobehub/icons/es/AzureAI/components/Mono";
import GroqMono from "@lobehub/icons/es/Groq/components/Mono";
import KimiMono from "@lobehub/icons/es/Kimi/components/Mono";
import LmStudioMono from "@lobehub/icons/es/LmStudio/components/Mono";
import NebiusMono from "@lobehub/icons/es/Nebius/components/Mono";
import OllamaMono from "@lobehub/icons/es/Ollama/components/Mono";
import OpenAIMono from "@lobehub/icons/es/OpenAI/components/Mono";
import ReplicateMono from "@lobehub/icons/es/Replicate/components/Mono";
import StepfunMono from "@lobehub/icons/es/Stepfun/components/Mono";
import VertexAIMono from "@lobehub/icons/es/VertexAI/components/Mono";
import VllmMono from "@lobehub/icons/es/Vllm/components/Mono";
import XAIMono from "@lobehub/icons/es/XAI/components/Mono";
import XinferenceMono from "@lobehub/icons/es/Xinference/components/Mono";
import ZAIMono from "@lobehub/icons/es/ZAI/components/Mono";

import type { BrandKey } from "@/apps/agent/services/providers/provider-brands";

type MarkComponent = React.ComponentType<{ size?: number | string }>;

/**
 * Command Code's ⌘ mark, drawn here because the icon set does not carry it
 * (checked against 5.16.0). Their own `cmdsymbol` SVG, geometry unmodified.
 *
 * A component rather than an entry in {@link IMAGE_MARKS}, unlike kenari's and
 * Modal's: the brand ships the mark only in solid black and solid white, so a
 * single image file would be invisible on one of the two themes. Painted in
 * `currentColor` it inherits Aurora's text colour and reads on both, which is
 * exactly how the other monochrome marks in this file behave.
 */
const CommandCodeMono: MarkComponent = ({ size = 18 }) =>
  React.createElement(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 446 446",
      fill: "none",
      xmlns: "http://www.w3.org/2000/svg",
    },
    React.createElement("path", {
      fillRule: "evenodd",
      clipRule: "evenodd",
      fill: "currentColor",
      d: "M226.665 18.1979H218.375C166.389 18.1979 129.23 18.2366 100.991 22.0332C73.2761 25.7594 56.8935 32.8027 44.8481 44.8481C32.8027 56.8935 25.7594 73.2761 22.0332 100.991C18.2365 129.23 18.1979 166.389 18.1979 218.375V226.665C18.1979 278.651 18.2365 315.809 22.0332 344.048C25.7594 371.764 32.8027 388.146 44.8481 400.192C56.8935 412.237 73.276 419.28 100.991 423.007C129.23 426.803 166.389 426.842 218.375 426.842H226.665C278.651 426.842 315.809 426.803 344.048 423.007C371.764 419.28 388.146 412.237 400.191 400.192C412.237 388.146 419.28 371.764 423.006 344.048C426.803 315.809 426.842 278.651 426.842 226.665V218.375C426.842 166.389 426.803 129.23 423.006 100.991C419.28 73.2761 412.237 56.8935 400.191 44.8481C388.146 32.8027 371.764 25.7594 344.048 22.0332C315.809 18.2366 278.651 18.1979 226.665 18.1979ZM31.9803 31.9803C0 63.9605 0 115.432 0 218.375V226.665C0 329.608 0 381.079 31.9803 413.059C63.9605 445.04 115.432 445.04 218.375 445.04H226.665C329.608 445.04 381.079 445.04 413.059 413.059C445.04 381.079 445.04 329.608 445.04 226.665V218.375C445.04 115.432 445.04 63.9605 413.059 31.9803C381.079 0 329.608 0 226.665 0H218.375C115.432 0 63.9605 0 31.9803 31.9803Z",
    }),
    React.createElement("path", {
      fill: "currentColor",
      d: "M306.202 85.5845C276.837 85.5845 252.95 109.472 252.95 138.837V161.66H192.09V138.837C192.09 109.472 168.202 85.5845 138.837 85.5845C109.472 85.5845 85.5845 109.472 85.5845 138.837C85.5845 168.202 109.472 192.09 138.837 192.09H161.66V252.95H138.837C109.472 252.95 85.5845 276.837 85.5845 306.202C85.5845 335.568 109.472 359.455 138.837 359.455C168.202 359.455 192.09 335.568 192.09 306.202V283.38H252.95V306.202C252.95 335.568 276.837 359.455 306.202 359.455C335.567 359.455 359.455 335.568 359.455 306.202C359.455 276.837 335.567 252.95 306.202 252.95H283.38V192.09H306.202C335.567 192.09 359.455 168.202 359.455 138.837C359.455 109.472 335.567 85.5845 306.202 85.5845ZM283.38 161.66V138.837C283.38 126.209 293.574 116.015 306.202 116.015C318.831 116.015 329.025 126.209 329.025 138.837C329.025 151.466 318.831 161.66 306.202 161.66H283.38ZM138.837 161.66C126.209 161.66 116.015 151.466 116.015 138.837C116.015 126.209 126.209 116.015 138.837 116.015C151.466 116.015 161.66 126.209 161.66 138.837V161.66H138.837ZM192.09 252.95V192.09H252.95V252.95H192.09ZM306.202 329.025C293.574 329.025 283.38 318.831 283.38 306.202V283.38H306.202C318.831 283.38 329.025 293.574 329.025 306.202C329.025 318.831 318.831 329.025 306.202 329.025ZM138.837 329.025C126.209 329.025 116.015 318.831 116.015 306.202C116.015 293.574 126.209 283.38 138.837 283.38H161.66V306.202C161.66 318.831 151.466 329.025 138.837 329.025Z",
    }),
  );

/**
 * Brand → the component that draws it.
 *
 * Colour wherever the set publishes it: these sit in a settings list where the
 * logo IS how you find the row you want, and a column of identical grey glyphs
 * would defeat the point.
 */
export const PROVIDER_MARKS: Readonly<Record<BrandKey, MarkComponent>> = {
  // Claude's mark, not the Anthropic wordmark: this row is a model provider,
  // and the orange one is what reads at 26px.
  anthropic: ClaudeColor,
  openai: OpenAIMono,
  codex: CodexColor,
  cursor: CursorMono,
  opencode: OpenCodeMono,
  commandcode: CommandCodeMono,
  deepseek: DeepSeekColor,
  // Drawn from `IMAGE_MARKS` instead. Present so this record stays exhaustive
  // over BrandKey — a brand cannot be added without something to draw.
  kenari: OpenAIMono,
  // Drawn from `IMAGE_MARKS`, same as kenari; present for exhaustiveness.
  modal: OpenAIMono,
  zai: ZAIMono,
  zhipu: ZhipuColor,
  minimax: MinimaxColor,
  fireworks: FireworksColor,
  lmstudio: LmStudioMono,
  ollama: OllamaMono,
  atlascloud: AtlasCloudMono,
  openrouter: OpenRouterColor,
  groq: GroqMono,
  together: TogetherColor,
  mistral: MistralColor,
  cohere: CohereColor,
  perplexity: PerplexityColor,
  xai: XAIMono,
  google: GoogleColor,
  qwen: QwenColor,
  moonshot: KimiMono,
  siliconcloud: SiliconCloudColor,
  novita: NovitaColor,
  deepinfra: DeepInfraColor,
  hyperbolic: HyperbolicColor,
  cerebras: CerebrasColor,
  sambanova: SambaNovaColor,
  nvidia: NvidiaColor,
  azure: AzureMono,
  bedrock: BedrockColor,
  vertex: VertexAIMono,
  huggingface: HuggingFaceColor,
  replicate: ReplicateMono,
  meta: MetaColor,
  doubao: DoubaoColor,
  stepfun: StepfunMono,
  nebius: NebiusMono,
  vllm: VllmMono,
  xinference: XinferenceMono,
};

/** Brands whose mark ships as an image rather than a component. */
export const IMAGE_MARKS: Partial<Record<BrandKey, string>> = {
  // kenari's own square avatar mark, from https://kenari.id/brand/mark.png.
  // Their PNG rather than their SVG: the SVG sets the letter as live text in
  // Archivo and silently renders in a fallback face when Archivo is absent,
  // which is the one thing a logo must never do.
  kenari: "/brand/kenari.png",
  // Modal is not in the icon set either (checked against 5.16.0, the latest).
  // This is their own favicon SVG from modal.com/assets, unmodified.
  modal: "/brand/modal.svg",
};
