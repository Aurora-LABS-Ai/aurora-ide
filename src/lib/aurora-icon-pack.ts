import type { ExplorerIconPack, ExplorerIconRequest, ResolvedExplorerIcon } from "./icon-types";

export interface AuroraIconPackMappings {
  defaultFile?: string;
  defaultFolder?: string;
  defaultFolderExpanded?: string;
  fileExtensions?: Record<string, string>;
  fileNames?: Record<string, string>;
  folderNames?: Record<string, string>;
  folderNamesExpanded?: Record<string, string>;
  languageIds?: Record<string, string>;
}

export interface AuroraIconPackBundle {
  format: "aurora-pack";
  schemaVersion: 1;
  packageType: "icon-pack";
  manifest: {
    id: string;
    name: string;
    version: string;
    author?: string;
    description?: string;
  };
  icons: Record<string, string>;
  mappings: AuroraIconPackMappings;
}

const MIME_PREFIX = "data:image/";

const normalizeIconData = (source: string): string => {
  const trimmed = source.trim();
  if (trimmed.startsWith("data:")) {
    return trimmed;
  }

  if (trimmed.startsWith("<svg")) {
    return `data:image/svg+xml;utf8,${encodeURIComponent(trimmed)}`;
  }

  return trimmed;
};

const isObjectRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const asStringMap = (value: unknown, field: string): Record<string, string> | undefined => {
  if (value === undefined) return undefined;
  if (!isObjectRecord(value)) {
    throw new Error(`${field} must be an object of string mappings.`);
  }

  const entries = Object.entries(value).map(([key, entryValue]) => {
    if (typeof entryValue !== "string" || entryValue.trim().length === 0) {
      throw new Error(`${field}.${key} must be a non-empty string.`);
    }

    return [key, entryValue.trim()] as const;
  });

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

const getIconNameFromMappings = (
  request: ExplorerIconRequest,
  mappings: AuroraIconPackMappings,
): string | null => {
  const lowerName = request.name.toLowerCase();

  if (request.isFolder) {
    const exactFolderMatch = request.isOpen
      ? mappings.folderNamesExpanded?.[lowerName]
      : mappings.folderNames?.[lowerName];

    if (exactFolderMatch) return exactFolderMatch;

    return request.isOpen
      ? mappings.defaultFolderExpanded || mappings.defaultFolder || null
      : mappings.defaultFolder || null;
  }

  const exactFileMatch =
    mappings.fileNames?.[request.name] || mappings.fileNames?.[lowerName];
  if (exactFileMatch) return exactFileMatch;

  const parts = request.name.split(".");
  if (parts.length > 2) {
    const compoundExtension = parts.slice(-2).join(".").toLowerCase();
    const compoundMatch = mappings.fileExtensions?.[compoundExtension];
    if (compoundMatch) return compoundMatch;
  }

  const extension = parts.pop()?.toLowerCase();
  if (extension) {
    const extensionMatch = mappings.fileExtensions?.[extension];
    if (extensionMatch) return extensionMatch;

    const extToLanguage: Record<string, string> = {
      ts: "typescript",
      tsx: "typescriptreact",
      js: "javascript",
      jsx: "javascriptreact",
      py: "python",
      rs: "rust",
      go: "go",
      rb: "ruby",
      java: "java",
      c: "c",
      cpp: "cpp",
      h: "c",
      hpp: "cpp",
      cs: "csharp",
      php: "php",
      swift: "swift",
      kt: "kotlin",
      scala: "scala",
      lua: "lua",
      pl: "perl",
      sh: "shell",
      bash: "shell",
      zsh: "shell",
      ps1: "powershell",
      sql: "database",
      graphql: "graphql",
      gql: "graphql",
      md: "markdown",
      json: "json",
      html: "html",
      css: "css",
      scss: "scss",
    };

    const languageId = extToLanguage[extension];
    if (languageId && mappings.languageIds?.[languageId]) {
      return mappings.languageIds[languageId];
    }
  }

  return mappings.defaultFile || null;
};

const validateBundleShape = (value: unknown): AuroraIconPackBundle => {
  if (!isObjectRecord(value)) {
    throw new Error("Aurora icon pack must be a JSON object.");
  }

  if (value.format !== "aurora-pack") {
    throw new Error("Unsupported Aurora pack format.");
  }

  if (value.packageType !== "icon-pack") {
    throw new Error("This Aurora package is not an icon pack.");
  }

  if (value.schemaVersion !== 1) {
    throw new Error("Unsupported Aurora icon pack schema version.");
  }

  if (!isObjectRecord(value.manifest)) {
    throw new Error("Aurora icon pack is missing a valid manifest.");
  }

  const manifestId = value.manifest.id;
  const manifestName = value.manifest.name;
  const manifestVersion = value.manifest.version;

  if (typeof manifestId !== "string" || manifestId.trim().length === 0) {
    throw new Error("Aurora icon pack manifest.id must be a non-empty string.");
  }

  if (typeof manifestName !== "string" || manifestName.trim().length === 0) {
    throw new Error("Aurora icon pack manifest.name must be a non-empty string.");
  }

  if (typeof manifestVersion !== "string" || manifestVersion.trim().length === 0) {
    throw new Error("Aurora icon pack manifest.version must be a non-empty string.");
  }

  if (!isObjectRecord(value.icons)) {
    throw new Error("Aurora icon pack icons must be a string map.");
  }

  const icons = Object.fromEntries(
    Object.entries(value.icons).map(([iconName, source]) => {
      if (typeof source !== "string" || source.trim().length === 0) {
        throw new Error(`Icon asset "${iconName}" must be a non-empty string.`);
      }

      const normalized = normalizeIconData(source);
      if (!normalized.startsWith("data:") && !normalized.startsWith(MIME_PREFIX)) {
        throw new Error(
          `Icon asset "${iconName}" must be a data URI or inline SVG payload.`,
        );
      }

      return [iconName, normalized];
    }),
  );

  const mappingsSource = value.mappings;
  if (!isObjectRecord(mappingsSource)) {
    throw new Error("Aurora icon pack mappings must be an object.");
  }

  const mappings: AuroraIconPackMappings = {
    defaultFile:
      typeof mappingsSource.defaultFile === "string"
        ? mappingsSource.defaultFile.trim()
        : undefined,
    defaultFolder:
      typeof mappingsSource.defaultFolder === "string"
        ? mappingsSource.defaultFolder.trim()
        : undefined,
    defaultFolderExpanded:
      typeof mappingsSource.defaultFolderExpanded === "string"
        ? mappingsSource.defaultFolderExpanded.trim()
        : undefined,
    fileNames: asStringMap(mappingsSource.fileNames, "mappings.fileNames"),
    fileExtensions: asStringMap(
      mappingsSource.fileExtensions,
      "mappings.fileExtensions",
    ),
    folderNames: asStringMap(mappingsSource.folderNames, "mappings.folderNames"),
    folderNamesExpanded: asStringMap(
      mappingsSource.folderNamesExpanded,
      "mappings.folderNamesExpanded",
    ),
    languageIds: asStringMap(mappingsSource.languageIds, "mappings.languageIds"),
  };

  const referencedIcons = new Set<string>();
  [
    mappings.defaultFile,
    mappings.defaultFolder,
    mappings.defaultFolderExpanded,
  ]
    .filter((iconName): iconName is string => Boolean(iconName))
    .forEach((iconName) => referencedIcons.add(iconName));

  for (const map of [
    mappings.fileNames,
    mappings.fileExtensions,
    mappings.folderNames,
    mappings.folderNamesExpanded,
    mappings.languageIds,
  ]) {
    Object.values(map || {}).forEach((iconName) => referencedIcons.add(iconName));
  }

  referencedIcons.forEach((iconName) => {
    if (!icons[iconName]) {
      throw new Error(
        `Aurora icon pack references missing icon asset "${iconName}".`,
      );
    }
  });

  return {
    format: "aurora-pack",
    schemaVersion: 1,
    packageType: "icon-pack",
    manifest: {
      id: manifestId.trim(),
      name: manifestName.trim(),
      version: manifestVersion.trim(),
      author:
        typeof value.manifest.author === "string" && value.manifest.author.trim().length > 0
          ? value.manifest.author.trim()
          : undefined,
      description:
        typeof value.manifest.description === "string" &&
        value.manifest.description.trim().length > 0
          ? value.manifest.description.trim()
          : undefined,
    },
    icons,
    mappings,
  };
};

export const parseAuroraIconPackBundle = (content: string): AuroraIconPackBundle => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Aurora icon pack is not valid JSON: ${(error as Error).message}`);
  }

  return validateBundleShape(parsed);
};

export const createExplorerIconPackFromAuroraBundle = (
  bundle: AuroraIconPackBundle,
): ExplorerIconPack => {
  const resolveIcon = (request: ExplorerIconRequest): ResolvedExplorerIcon => {
    const iconName = getIconNameFromMappings(request, bundle.mappings);
    const source = iconName ? bundle.icons[iconName] : undefined;

    return {
      kind: "asset",
      alt: request.name,
      src: source,
    };
  };

  return {
    manifest: {
      id: bundle.manifest.id,
      name: bundle.manifest.name,
      version: bundle.manifest.version,
      author: bundle.manifest.author,
      description:
        bundle.manifest.description || "Aurora icon pack bundle.",
      source: "custom",
    },
    resolveIcon,
  };
};
