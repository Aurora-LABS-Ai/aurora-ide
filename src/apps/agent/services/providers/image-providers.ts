/**
 * Image providers — configured by the user, not hardcoded.
 *
 * a6api was the first one probed live, and it is **not** the only one
 * supported. That probe is the whole argument for this file: a6api deviates
 * from OpenAI's own image API in three measured ways, so any second provider
 * will deviate differently, and the wire shape has to be a property OF THE
 * PROVIDER or the second one added breaks the first.
 *
 * The structure mirrors the LLM side — a provider row holding credentials and
 * a wire format, and model rows under it — for the same reason it works there:
 * one key and one address serve many models, and what differs per model is
 * what that model can DO.
 *
 * **Where these live.** In app settings, as one JSON value, rather than in two
 * SQLite tables of their own. They are settings: a handful of rows, read at
 * startup, written when someone edits them, and never joined against anything.
 * A migration, a repository and a command surface would buy nothing here that
 * the settings row does not already give.
 */

/**
 * How a provider speaks. Not a cosmetic label — it decides the request body,
 * and getting it wrong is a 400 rather than a degraded result.
 */
export type ImageApiFormat =
  /**
   * OpenAI's own shape: `POST /images/generations` with JSON, and edits as
   * **multipart/form-data** with the source image as a file part.
   */
  | "openai-images"
  /**
   * a6api. Generation is OpenAI-shaped, and then three things differ, all
   * measured against the live service on 2026-09-04:
   *   1. `/images/edits` REJECTS multipart. It wants JSON with `image` as a
   *      URL. This is the single biggest difference and is not guessable.
   *   2. Errors arrive under **HTTP 200**. The status code is not a success
   *      signal; the body has to be parsed every time.
   *   3. `/models/{id}` is unreliable — it reported a model missing while
   *      `/models` was listing it. Use the list, never the lookup.
   */
  | "a6api"
  | "minimax-native"
  /**
   * Qwen / DashScope's own shape. Generation AND editing are the same endpoint,
   * the prompt is chat-shaped (`input.messages`), and `size` is spelled with an
   * asterisk (`1024*1024`).
   *
   * Qwen also publishes an OpenAI-compatible generation endpoint at
   * `/compatible-mode/v1/images/generations`, which `openai-images` reaches
   * unchanged. It is not enough on its own: there is no compatible-mode EDIT,
   * so a row that should do both speaks this instead.
   */
  | "qwen-dashscope"
  /**
   * The user's own ChatGPT subscription, through the Codex backend.
   *
   * Unlike every other format this is not an address and a key. There is no
   * image endpoint on that backend at all: a picture is the Responses API with
   * the hosted `image_generation` tool, posted to a URL fixed in code, and the
   * credentials are the OAuth tokens Settings → Providers → Codex already
   * holds — including the several accounts it can fail over between. So the
   * row has no address field, no key field, and no paths.
   *
   * Two ways to name a model, decided by the key alone: `gpt-image-*` is a
   * TOOL model (can edit, forced), and `<chat model>-image` asks that chat
   * model to draw if it decides to (cannot edit). `tools/image/codex.rs` owns
   * the split.
   */
  | "codex-responses";

/**
 * What to ask this provider to send each image back as — the `response_format`
 * Aurora puts on the request.
 *
 * **Absent means ask for nothing** and take whatever arrives. That is the safe
 * default and the only correct setting for OpenAI's own `gpt-image-*`, which
 * answers 400 to the field rather than ignoring it.
 *
 * It exists because apikl was probed live (2026-09-04, `gpt-image-2-pro`):
 * `/images/generations` returned `b64_json` and `/images/edits` returned a
 * `url`, on one key and one model. No single statement of "what this provider
 * returns" is true of it, so asking for one shape is what makes both endpoints
 * agree — and sending `response_format: "url"` did exactly that.
 *
 * This replaces `responseShape`, which described what to EXPECT and was read by
 * nothing. A new field rather than a new meaning for the old one: every stored
 * `responseShape` is a note somebody wrote, not a request they made, and
 * reading them as requests would start sending the field to providers that
 * refuse it.
 */
export type ImageRequestFormat = "url" | "b64_json";

export interface ImageModel {
  /** Stable local id. */
  id: string;
  /** Owning provider row. */
  providerId: string;
  /** What the API is called, e.g. `gpt-image-1.5`. */
  modelKey: string;
  /** What a person calls it. Falls back to `modelKey` when empty. */
  label?: string;
  /**
   * Whether this model can EDIT an existing image, not only make a new one.
   *
   * Recorded per model because they are separate capabilities: a generator
   * that cannot edit answers an edit request with a 400, so offering the
   * action at all has to depend on this.
   */
  canEdit?: boolean;
  /** Sizes this model accepts, e.g. `["1024x1024", "1536x1024"]`. */
  sizes?: string[];
  /** Which of `sizes` to use when nobody says. */
  defaultSize?: string;
  /**
   * Price per image, if known. Unset renders as "not applicable" rather than
   * as a measured $0.00 — a zero you did not measure is a lie about cost.
   */
  pricePerImage?: number;
}

export interface ImageProvider {
  id: string;
  /** What a person calls it. */
  name: string;
  /** Root of the API, e.g. `https://api.a6api.com/v1`. */
  baseUrl: string;
  apiKey?: string;
  apiFormat: ImageApiFormat;
  /** Defaults per format when empty. */
  generationPath?: string;
  /**
   * Where an edit goes. **Empty means this provider cannot edit at all** — a
   * different statement from a model that cannot, and both have to be sayable.
   */
  editPath?: string;
  /** Omitted = send no `response_format`. See {@link ImageRequestFormat}. */
  requestFormat?: ImageRequestFormat;
  enabled: boolean;
  models: ImageModel[];
  /**
   * Ships with Aurora. Its address, key and models are the user's to change —
   * only the ROW is permanent, exactly like a built-in language provider.
   * Deleting it would be a decision nothing can undo from the interface, and
   * the row costs nothing while it sits there with no key.
   */
  builtIn?: boolean;
}

/** The image provider id Aurora ships with. Stable, because rows pin to it. */
export const A6API_IMAGE_PROVIDER_ID = "img-a6api";

/**
 * The one image provider Aurora ships.
 *
 * a6api is the service the whole image path was built and measured against —
 * its three deviations from OpenAI's shape are why `apiFormat` is per provider
 * at all (`DOCS/PLAN/chat-mode-design.md` §8). Shipping it means the common
 * case is "paste a key", not "work out the address, the wire format and the
 * two paths from scratch".
 *
 * No models are seeded: `/models` lists them with `supported_endpoint_types`,
 * so Discover fills the list from the live account rather than from a table
 * that goes stale.
 */
export const A6API_IMAGE_PRESET: Omit<ImageProvider, "apiKey"> = {
  id: A6API_IMAGE_PROVIDER_ID,
  name: "a6api",
  baseUrl: "https://api.a6api.com/v1",
  apiFormat: "a6api",
  enabled: true,
  models: [],
  builtIn: true,
};

export const MINIMAX_IMAGE_PROVIDER_ID = "img-minimax";
export const MINIMAX_IMAGE_PRESET: Omit<ImageProvider, "apiKey"> = {
  id: MINIMAX_IMAGE_PROVIDER_ID,
  name: "MiniMax",
  baseUrl: "https://api.minimax.io",
  apiFormat: "minimax-native",
  enabled: true,
  builtIn: true,
  models: [{
    id: "img-minimax:image-01", providerId: MINIMAX_IMAGE_PROVIDER_ID,
    modelKey: "image-01", canEdit: true,
    sizes: ["1024x1024", "1280x720", "1152x864", "1248x832", "832x1248", "864x1152", "720x1280", "1344x576"],
    defaultSize: "1024x1024",
  }],
};

export const QWEN_IMAGE_PROVIDER_ID = "img-qwen";
/**
 * Qwen / DashScope. Built in because it also serves Wan 3.0 video, and the
 * video tool reads its credentials from this row.
 *
 * The address is the Singapore gateway. Mainland accounts use
 * `https://dashscope.aliyuncs.com` and the row's address is the user's to
 * change, exactly like every other provider.
 *
 * Sizes are the envelope every Qwen image model accepts (512-2048 per side).
 * The fixed set the `max`/`plus`/`image` models publish all fall inside it, so
 * one list serves the whole family rather than a second roster that can
 * disagree with the first.
 */
export const QWEN_IMAGE_PRESET: Omit<ImageProvider, "apiKey"> = {
  id: QWEN_IMAGE_PROVIDER_ID,
  name: "Qwen",
  baseUrl: "https://dashscope-intl.aliyuncs.com",
  apiFormat: "qwen-dashscope",
  enabled: true,
  builtIn: true,
  models: [
    {
      id: "img-qwen:qwen-image-3.0-pro",
      providerId: QWEN_IMAGE_PROVIDER_ID,
      modelKey: "qwen-image-3.0-pro",
      label: "Qwen Image 3.0 Pro",
      canEdit: true,
      sizes: ["1328x1328", "1024x1024", "1664x928", "1472x1104", "1104x1472", "928x1664", "2048x2048"],
      defaultSize: "1328x1328",
    },
    {
      id: "img-qwen:qwen-image-3.0",
      providerId: QWEN_IMAGE_PROVIDER_ID,
      modelKey: "qwen-image-3.0",
      label: "Qwen Image 3.0",
      canEdit: true,
      sizes: ["1328x1328", "1024x1024", "1664x928", "1472x1104", "1104x1472", "928x1664", "2048x2048"],
      defaultSize: "1328x1328",
    },
  ],
};

export const CODEX_IMAGE_PROVIDER_ID = "img-codex";
/**
 * Where a Codex picture is actually made. Shown, never sent: Rust posts to its
 * own copy of this (`api/codex/mod.rs`), so a row cannot misroute the call by
 * holding a stale address.
 */
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
/**
 * ChatGPT's own picture maker, on the subscription the user already pays for.
 *
 * No address and no key: both live in code, and the sign-in is the one under
 * Providers → Codex. The row is here so the models appear in the composer and
 * in `generate_image`'s list like any other, not because there is anything to
 * configure.
 *
 * Three models rather than the full roster. `gpt-image-2.5-flare` and
 * `-sunburst` are variants of the first, and the `-image` chat models are a
 * different thing again (a chat model that may decide to draw, and cannot
 * edit) — Discover lists all of them for anyone who wants one.
 */
export const CODEX_IMAGE_PRESET: Omit<ImageProvider, "apiKey"> = {
  id: CODEX_IMAGE_PROVIDER_ID,
  name: "ChatGPT",
  baseUrl: "",
  apiFormat: "codex-responses",
  enabled: true,
  builtIn: true,
  models: [
    {
      id: "img-codex:gpt-image-2.5",
      providerId: CODEX_IMAGE_PROVIDER_ID,
      modelKey: "gpt-image-2.5",
      label: "GPT Image 2.5",
      canEdit: true,
      sizes: ["1024x1024", "1024x1536", "1536x1024"],
      defaultSize: "1024x1024",
    },
    {
      id: "img-codex:gpt-image-2",
      providerId: CODEX_IMAGE_PROVIDER_ID,
      modelKey: "gpt-image-2",
      label: "GPT Image 2",
      canEdit: true,
      sizes: ["1024x1024", "1024x1536", "1536x1024"],
      defaultSize: "1024x1024",
    },
    {
      id: "img-codex:gpt-image-1.5",
      providerId: CODEX_IMAGE_PROVIDER_ID,
      modelKey: "gpt-image-1.5",
      label: "GPT Image 1.5",
      canEdit: true,
      sizes: ["1024x1024", "1024x1536", "1536x1024"],
      defaultSize: "1024x1024",
    },
  ],
};

/**
 * Rows Aurora offers ONCE, as a starting point, and never again.
 *
 * Not built in: each is an ordinary provider that can be edited, switched off
 * and deleted, and a deleted one stays deleted — `seededImageProviderIds`
 * records that it was offered, so the next launch does not put it back. That
 * record is the whole difference between this and {@link A6API_IMAGE_PRESET},
 * which is permanent.
 *
 * Everything here was measured against the live service, so the only thing left
 * to fill in is a key.
 */
export const SEEDED_IMAGE_PROVIDERS: ReadonlyArray<Omit<ImageProvider, "apiKey">> = [
  {
    id: "img-apikl",
    name: "apikl",
    baseUrl: "https://api.apikl.ai/v1",
    // Its edit takes multipart/form-data — OpenAI's own shape, NOT a6api's
    // JSON-with-a-URL. Probed 2026-09-04: a real edit, the source picture
    // preserved pixel for pixel with only the requested change added.
    apiFormat: "openai-images",
    // Measured, and the reason this field exists: `/images/generations`
    // answered with `b64_json` while `/images/edits` answered with a `url`.
    // Asking for a URL is what makes the two endpoints agree.
    requestFormat: "url",
    enabled: true,
    models: [
      {
        id: "img-apikl:gpt-image-2-pro",
        providerId: "img-apikl",
        modelKey: "gpt-image-2-pro",
        canEdit: true,
        // The one size confirmed to work; a provider that offers more is one
        // Discover run away from listing them.
        sizes: ["1024x1024"],
        defaultSize: "1024x1024",
      },
    ],
  },
];

/**
 * Put the shipped provider back if it is missing, keeping whatever the user has
 * already put into it.
 *
 * Merge, never replace: the key, the models Discover found, the enabled switch
 * and any edited address all survive a relaunch. Only `builtIn` is forced, so a
 * row saved before this existed becomes undeletable rather than staying a
 * lookalike the user could throw away.
 */
export function withBuiltInImageProviders(rows: ImageProvider[]): ImageProvider[] {
  const existing = rows.find((row) => row.id === A6API_IMAGE_PROVIDER_ID);
  const withA6 = existing ? rows : [{ ...A6API_IMAGE_PRESET }, ...rows];
  const withMiniMax = withA6.some((row) => row.id === MINIMAX_IMAGE_PROVIDER_ID) ? withA6 :
    [...withA6, { ...MINIMAX_IMAGE_PRESET, models: MINIMAX_IMAGE_PRESET.models.map((model) => ({ ...model, sizes: [...model.sizes!] })) }];
  // Deep-copied like MiniMax's: the preset is module state, so handing its
  // arrays straight to the store lets an edit in settings mutate the constant.
  const withQwen = withMiniMax.some((row) => row.id === QWEN_IMAGE_PROVIDER_ID) ? withMiniMax :
    [...withMiniMax, { ...QWEN_IMAGE_PRESET, models: QWEN_IMAGE_PRESET.models.map((model) => ({ ...model, sizes: [...model.sizes!] })) }];
  const withCodex = withQwen.some((row) => row.id === CODEX_IMAGE_PROVIDER_ID) ? withQwen :
    [...withQwen, { ...CODEX_IMAGE_PRESET, models: CODEX_IMAGE_PRESET.models.map((model) => ({ ...model, sizes: [...model.sizes!] })) }];
  return withCodex.map((row) =>
    [A6API_IMAGE_PROVIDER_ID, MINIMAX_IMAGE_PROVIDER_ID, QWEN_IMAGE_PROVIDER_ID, CODEX_IMAGE_PROVIDER_ID].includes(row.id)
      ? { ...row, builtIn: true }
      : row,
  );
}

/**
 * Offer each seed once, and remember that it was offered.
 *
 * Returns the rows to store and the ids now accounted for. A seed already in
 * `seeded` is skipped whether or not its row is still there — that is what lets
 * a person delete one and have it stay deleted, which a preset that re-seeds on
 * every launch cannot do.
 */
export function withSeededImageProviders(
  rows: ImageProvider[],
  seeded: readonly string[],
): { providers: ImageProvider[]; seededIds: string[] } {
  const known = new Set(seeded);
  const added: ImageProvider[] = [];
  for (const seed of SEEDED_IMAGE_PROVIDERS) {
    if (known.has(seed.id)) continue;
    known.add(seed.id);
    // Not if a row already claims the id — an upgrade should not duplicate a
    // provider the user built by hand at the same address.
    if (rows.some((row) => row.id === seed.id)) continue;
    added.push({ ...seed, models: seed.models.map((model) => ({ ...model })) });
  }
  return { providers: [...rows, ...added], seededIds: [...known] };
}

/** Request paths a format uses when the provider row leaves them blank. */
export const DEFAULT_IMAGE_PATHS: Record<
  ImageApiFormat,
  { generation: string; edit: string }
> = {
  "openai-images": { generation: "/images/generations", edit: "/images/edits" },
  a6api: { generation: "/images/generations", edit: "/images/edits" },
  "minimax-native": { generation: "/v1/image_generation", edit: "/v1/image_generation" },
  // One endpoint for both. Mirrors `QWEN_IMAGE_PATH` in `tools/image/config.rs`.
  "qwen-dashscope": {
    generation: "/api/v1/services/aigc/multimodal-generation/generation",
    edit: "/api/v1/services/aigc/multimodal-generation/generation",
  },
  // Fixed in code, and the same endpoint for both — the tool's `action` is
  // what makes a call an edit. Mirrors `tools/image/codex.rs`.
  "codex-responses": {
    generation: CODEX_RESPONSES_URL,
    edit: CODEX_RESPONSES_URL,
  },
};

export const IMAGE_API_FORMAT_LABELS: Record<ImageApiFormat, string> = {
  "openai-images": "OpenAI images",
  a6api: "a6api",
  "minimax-native": "MiniMax native",
  "qwen-dashscope": "Qwen (DashScope)",
  "codex-responses": "ChatGPT (Codex)",
};

/**
 * Whether a row in this format has an address and a key of its own.
 *
 * Codex has neither: it reads the sign-in under Providers → Codex. A row that
 * asked for a key would be permanently unusable with no field that could fix
 * it, so both the readiness rule and the settings form ask this first.
 */
export const imageFormatUsesApiKey = (format: ImageApiFormat): boolean =>
  format !== "codex-responses";

/** The generation endpoint this provider actually posts to. */
export const generationUrl = (provider: ImageProvider): string =>
  imageFormatUsesApiKey(provider.apiFormat)
    ? joinUrl(
        provider.baseUrl,
        provider.generationPath?.trim() || DEFAULT_IMAGE_PATHS[provider.apiFormat].generation,
      )
    : DEFAULT_IMAGE_PATHS[provider.apiFormat].generation;

/**
 * The edit endpoint, or `null` when this provider cannot edit.
 *
 * `null` is a real answer the caller has to handle, which is why it is not a
 * string that happens to be empty: an edit posted to the provider's root is a
 * confusing 404 instead of a clear "this one only generates".
 */
export const editUrl = (provider: ImageProvider): string | null => {
  // Fixed in code, and the same endpoint as generation. Whether a given model
  // can edit is still `model.canEdit` — on Codex only the `gpt-image-*` ones do.
  if (!imageFormatUsesApiKey(provider.apiFormat)) return DEFAULT_IMAGE_PATHS[provider.apiFormat].edit;
  const configured = provider.editPath?.trim();
  // An explicit empty string means "cannot edit" and must not fall through to
  // the format's default. `undefined` — the field was never filled in — does.
  if (provider.editPath !== undefined && configured === "") return null;
  return joinUrl(
    provider.baseUrl,
    configured || DEFAULT_IMAGE_PATHS[provider.apiFormat].edit,
  );
};

/** Whether this model can be asked to edit, provider and model both willing. */
export const canEditWith = (provider: ImageProvider, model: ImageModel): boolean =>
  editUrl(provider) !== null && model.canEdit === true;

/**
 * A provider that can be used: switched on, addressed, and holding a key.
 *
 * A format that carries neither an address nor a key needs only the switch —
 * whether its sign-in is still good is a round trip away, and answered by the
 * call itself rather than guessed at here. Mirrors `ImageProviderConfig::ready`.
 */
export const imageProviderReady = (provider: ImageProvider): boolean =>
  provider.enabled &&
  (!imageFormatUsesApiKey(provider.apiFormat) ||
    (provider.baseUrl.trim().length > 0 && (provider.apiKey ?? "").trim().length > 0));

/**
 * Every image provider id carries this prefix (`useAgentSettingsStore.addImageProvider`),
 * so a conversation pin can be told apart from a language-model pin without
 * consulting either list. `"img-…:gpt-image-1.5"` is a picture-making chat.
 */
export const IMAGE_PROVIDER_ID_PREFIX = "img-";

/** Whether a `"providerId:modelKey"` pin names an image model. */
export const isImageModelSelection = (selection: string | null | undefined): boolean =>
  typeof selection === "string" && selection.startsWith(IMAGE_PROVIDER_ID_PREFIX);

/** The provider and model a pin names, or `null` when either is gone. */
export function imageModelFromSelection(
  selection: string | null | undefined,
  providers: readonly ImageProvider[],
): { provider: ImageProvider; model: ImageModel } | null {
  if (!isImageModelSelection(selection) || !selection) return null;
  // Split on the FIRST colon only — a model key may carry its own (`name:tag`).
  const cut = selection.indexOf(":");
  if (cut < 1) return null;
  const providerId = selection.slice(0, cut);
  const modelKey = selection.slice(cut + 1);
  const provider = providers.find((p) => p.id === providerId);
  const model = provider?.models.find((m) => m.modelKey === modelKey);
  return provider && model ? { provider, model } : null;
}

/** The pin for an image model — the same `"providerId:modelKey"` shape chats use. */
export const imageModelSelection = (model: ImageModel): string =>
  `${model.providerId}:${model.modelKey}`;

/**
 * A `WIDTHxHEIGHT` size as a CSS `aspect-ratio`, so the placeholder can hold
 * exactly the shape the picture will arrive in. Anything unparseable is square:
 * the shape most image models default to.
 */
export function aspectRatioOfSize(size: string | null | undefined): string {
  const match = /^\s*(\d+)\s*[x×]\s*(\d+)\s*$/i.exec(size ?? "");
  if (!match) return "1 / 1";
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return "1 / 1";
  return `${width} / ${height}`;
}

/** Join a base and a path without doubling or dropping the separator. */
function joinUrl(base: string, path: string): string {
  const left = base.trim().replace(/\/+$/, "");
  const right = path.trim().replace(/^\/+/, "");
  return right ? `${left}/${right}` : left;
}

/**
 * The stored list, made safe to render.
 *
 * It arrives from SQLite as JSON someone may have hand-edited, and from older
 * builds that did not have every field. Anything without an id, a name or a
 * recognised format is dropped rather than rendered as a row that cannot work.
 */
export function normalizeImageProviders(value: unknown): ImageProvider[] {
  // Nothing stored yet is the FIRST launch, which is exactly when the shipped
  // provider has to appear — returning an empty list here would leave a fresh
  // install with no image row at all.
  if (!Array.isArray(value)) return withBuiltInImageProviders([]);
  const out: ImageProvider[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Partial<ImageProvider>;
    if (typeof row.id !== "string" || !row.id.trim()) continue;
    if (typeof row.name !== "string" || !row.name.trim()) continue;
    // Every format has to be listed here. One that is missing does not fail
    // loudly — the row silently becomes `openai-images` on the next launch and
    // starts posting a shape its provider refuses. That is what happened to
    // `qwen-dashscope` between shipping it and this line.
    const KNOWN_FORMATS: readonly ImageApiFormat[] = [
      "openai-images",
      "a6api",
      "minimax-native",
      "qwen-dashscope",
      "codex-responses",
    ];
    const apiFormat: ImageApiFormat =
      row.apiFormat !== undefined && KNOWN_FORMATS.includes(row.apiFormat)
        ? row.apiFormat
        : "openai-images";
    out.push({
      id: row.id,
      name: row.name,
      baseUrl: typeof row.baseUrl === "string" ? row.baseUrl : "",
      apiKey: typeof row.apiKey === "string" ? row.apiKey : undefined,
      apiFormat,
      generationPath: typeof row.generationPath === "string" ? row.generationPath : undefined,
      editPath: typeof row.editPath === "string" ? row.editPath : undefined,
      requestFormat:
        row.requestFormat === "url" || row.requestFormat === "b64_json"
          ? row.requestFormat
          : undefined,
      enabled: row.enabled !== false,
      models: normalizeImageModels(row.models, row.id),
      builtIn: row.builtIn === true || undefined,
    });
  }
  return withBuiltInImageProviders(out);
}

function normalizeImageModels(value: unknown, providerId: string): ImageModel[] {
  if (!Array.isArray(value)) return [];
  const out: ImageModel[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Partial<ImageModel>;
    if (typeof row.modelKey !== "string" || !row.modelKey.trim()) continue;
    out.push({
      id: typeof row.id === "string" && row.id ? row.id : `${providerId}:${row.modelKey}`,
      providerId,
      modelKey: row.modelKey,
      label: typeof row.label === "string" ? row.label : undefined,
      canEdit: row.canEdit === true,
      sizes: Array.isArray(row.sizes) ? row.sizes.filter((s) => typeof s === "string") : undefined,
      defaultSize: typeof row.defaultSize === "string" ? row.defaultSize : undefined,
      pricePerImage:
        typeof row.pricePerImage === "number" && Number.isFinite(row.pricePerImage)
          ? row.pricePerImage
          : undefined,
    });
  }
  return out;
}
