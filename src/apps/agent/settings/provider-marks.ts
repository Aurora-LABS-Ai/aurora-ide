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
  deepseek: DeepSeekColor,
  // Drawn from `IMAGE_MARKS` instead. Present so this record stays exhaustive
  // over BrandKey — a brand cannot be added without something to draw.
  kenari: OpenAIMono,
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
};
