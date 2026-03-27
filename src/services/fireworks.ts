import { executeCommand } from "../lib/tauri";

const FIREWORKS_API_ROOT = "https://api.fireworks.ai";
const DEFAULT_USAGE_WINDOW_DAYS = 30;

export interface FireworksAccountRecord {
  accountId: string;
  displayName: string;
  raw: Record<string, unknown>;
  state?: string;
}

export interface FireworksOverview {
  account: FireworksAccountRecord | null;
  accounts: FireworksAccountRecord[];
  resolvedAccountId: string | null;
}

export interface FireworksCliStatus {
  available: boolean;
  message: string;
  version: string | null;
}

export interface FireworksUsageSummary {
  completionTokens: number | null;
  cost: number | null;
  latestActivityAt: string | null;
  promptTokens: number | null;
  records: number;
  topModel: { count: number; model: string } | null;
  totalTokens: number | null;
}

type JsonRecord = Record<string, unknown>;

const stripAnsi = (value: string): string =>
  value.replace(/\u001b\[[0-9;]*m/g, "").replace(/\x1b\[[0-9;]*m/g, "");

const normalizeCliMessage = (value: string): string => {
  const cleaned = stripAnsi(value).replace(/\r/g, "").trim();
  const flattened = cleaned.replace(/\s+/g, " ");

  if (!flattened) {
    return "Fireworks CLI is not installed or not available on PATH.";
  }

  const lower = flattened.toLowerCase();
  if (
    lower.includes("not recognized as a name of a cmdlet") ||
    lower.includes("command not found") ||
    lower.includes("not found") ||
    lower.includes("no such file")
  ) {
    return "Fireworks CLI is not installed or not available on PATH.";
  }

  return flattened;
};

const readJsonResponse = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const getAuthHeaders = (apiKey: string) => ({
  Authorization: `Bearer ${apiKey.trim()}`,
  "Content-Type": "application/json",
});

const extractRecordArray = (payload: unknown): JsonRecord[] => {
  if (Array.isArray(payload)) {
    return payload.filter((entry): entry is JsonRecord => typeof entry === "object" && entry !== null);
  }

  if (!payload || typeof payload !== "object") {
    return [];
  }

  const record = payload as JsonRecord;
  const candidates = ["accounts", "items", "results", "data"];

  for (const key of candidates) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value.filter((entry): entry is JsonRecord => typeof entry === "object" && entry !== null);
    }
  }

  return [];
};

const readString = (record: JsonRecord, keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
};

const normalizeAccountRecord = (record: JsonRecord): FireworksAccountRecord | null => {
  const explicitId = readString(record, ["account_id", "accountId", "id"]);
  const resourceName = readString(record, ["name", "resource_name", "resourceName"]);
  const accountId = explicitId || resourceName?.split("/").filter(Boolean).pop();

  if (!accountId) {
    return null;
  }

  const displayName = readString(record, ["display_name", "displayName", "title"]) || accountId;
  const state = readString(record, ["state", "status", "lifecycle_state", "lifecycleState"]);

  return {
    accountId,
    displayName,
    raw: record,
    state,
  };
};

const chooseAccount = (
  accounts: FireworksAccountRecord[],
  preferredAccountId?: string,
): FireworksAccountRecord | null => {
  const trimmedPreferredId = preferredAccountId?.trim();
  if (trimmedPreferredId) {
    const exactMatch = accounts.find(
      (entry) =>
        entry.accountId === trimmedPreferredId ||
        entry.raw.name === trimmedPreferredId ||
        entry.displayName === trimmedPreferredId,
    );

    if (exactMatch) {
      return exactMatch;
    }
  }

  return accounts[0] || null;
};

const parseApiError = (payload: unknown, fallback: string): string => {
  if (typeof payload === "string" && payload.trim()) {
    return payload.trim();
  }

  if (payload && typeof payload === "object") {
    const record = payload as JsonRecord;
    const candidate =
      readString(record, ["message", "error", "detail", "description"]) ||
      readString(record, ["status", "title"]);

    if (candidate) {
      return candidate;
    }
  }

  return fallback;
};

const toPowerShellLiteral = (value: string): string => `'${value.replace(/'/g, "''")}'`;

const buildBillingExportCommand = (apiKey: string, accountId?: string): string => {
  const now = new Date();
  const start = new Date(now.getTime() - DEFAULT_USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const accountFlag = accountId?.trim() ? ` --account-id ${toPowerShellLiteral(accountId.trim())}` : "";

  return [
    "$ErrorActionPreference = 'Stop'",
    "$tempFile = Join-Path $env:TEMP ('aurora-fireworks-' + [guid]::NewGuid().ToString() + '.csv')",
    `& firectl billing export-metrics --filename $tempFile --start-time ${toPowerShellLiteral(start.toISOString())} --end-time ${toPowerShellLiteral(now.toISOString())}${accountFlag} --api-key ${toPowerShellLiteral(apiKey.trim())} | Out-Null`,
    "if (-not (Test-Path $tempFile)) { throw 'Fireworks metrics export did not produce a CSV file.' }",
    "Get-Content -Path $tempFile -Raw",
    "Remove-Item -Path $tempFile -Force -ErrorAction SilentlyContinue",
  ].join("\n");
};

const parseCsv = (csv: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    const next = csv[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows.filter((entry) => entry.some((value) => value.trim().length > 0));
};

const normalizeHeader = (header: string) => header.trim().toLowerCase().replace(/\s+/g, "_");

const findHeaderIndex = (headers: string[], candidates: string[]): number => {
  const normalizedHeaders = headers.map(normalizeHeader);
  return normalizedHeaders.findIndex((header) =>
    candidates.some((candidate) => header.includes(candidate)),
  );
};

const readNumericCell = (value: string | undefined): number | null => {
  if (!value) return null;

  const sanitized = value.replace(/[$,\s]/g, "");
  if (!sanitized) return null;

  const parsed = Number(sanitized);
  return Number.isFinite(parsed) ? parsed : null;
};

const readTimestampCell = (value: string | undefined): string | null => {
  if (!value?.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const parseUsageSummary = (csv: string): FireworksUsageSummary => {
  const rows = parseCsv(csv);
  if (rows.length <= 1) {
    return {
      completionTokens: null,
      cost: null,
      latestActivityAt: null,
      promptTokens: null,
      records: 0,
      topModel: null,
      totalTokens: null,
    };
  }

  const [headers, ...records] = rows;
  const promptIndex = findHeaderIndex(headers, ["prompt_tokens", "input_tokens", "prompttoken"]);
  const completionIndex = findHeaderIndex(headers, ["completion_tokens", "output_tokens", "completiontoken", "generated_tokens"]);
  const totalIndex = findHeaderIndex(headers, ["total_tokens", "token_total"]);
  const costIndex = findHeaderIndex(headers, ["cost", "spend", "amount"]);
  const modelIndex = findHeaderIndex(headers, ["model"]);
  const timestampIndex = findHeaderIndex(headers, ["timestamp", "time", "date", "created_at"]);

  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let hasPromptTokens = false;
  let hasCompletionTokens = false;
  let hasTotalTokens = false;
  let cost = 0;
  let hasCost = false;
  let latestActivityAt: string | null = null;
  const modelCounts = new Map<string, number>();

  for (const row of records) {
    const promptValue = readNumericCell(row[promptIndex]);
    const completionValue = readNumericCell(row[completionIndex]);
    const totalValue = readNumericCell(row[totalIndex]);
    const costValue = readNumericCell(row[costIndex]);
    const timestampValue = readTimestampCell(row[timestampIndex]);
    const modelValue = row[modelIndex]?.trim();

    if (promptValue !== null) {
      promptTokens += promptValue;
      hasPromptTokens = true;
    }

    if (completionValue !== null) {
      completionTokens += completionValue;
      hasCompletionTokens = true;
    }

    if (totalValue !== null) {
      totalTokens += totalValue;
      hasTotalTokens = true;
    }

    if (costValue !== null) {
      cost += costValue;
      hasCost = true;
    }

    if (timestampValue && (!latestActivityAt || timestampValue > latestActivityAt)) {
      latestActivityAt = timestampValue;
    }

    if (modelValue) {
      modelCounts.set(modelValue, (modelCounts.get(modelValue) || 0) + 1);
    }
  }

  const topModelEntry = Array.from(modelCounts.entries()).sort((left, right) => right[1] - left[1])[0];
  const derivedTotalTokens =
    hasTotalTokens ? totalTokens : hasPromptTokens || hasCompletionTokens ? promptTokens + completionTokens : null;

  return {
    completionTokens: hasCompletionTokens ? completionTokens : null,
    cost: hasCost ? cost : null,
    latestActivityAt,
    promptTokens: hasPromptTokens ? promptTokens : null,
    records: records.length,
    topModel: topModelEntry ? { model: topModelEntry[0], count: topModelEntry[1] } : null,
    totalTokens: derivedTotalTokens,
  };
};

export const fetchFireworksOverview = async (
  apiKey: string,
  preferredAccountId?: string,
): Promise<FireworksOverview> => {
  const trimmedApiKey = apiKey.trim();
  if (!trimmedApiKey) {
    throw new Error("Add a Fireworks API key before refreshing account data.");
  }

  const listResponse = await fetch(`${FIREWORKS_API_ROOT}/v1/accounts`, {
    headers: getAuthHeaders(trimmedApiKey),
  });
  const listPayload = await readJsonResponse(listResponse);

  if (!listResponse.ok) {
    throw new Error(parseApiError(listPayload, "Failed to load Fireworks accounts."));
  }

  const accounts = extractRecordArray(listPayload)
    .map(normalizeAccountRecord)
    .filter((entry): entry is FireworksAccountRecord => Boolean(entry));

  const selectedAccount = chooseAccount(accounts, preferredAccountId);
  if (!selectedAccount) {
    return {
      account: null,
      accounts,
      resolvedAccountId: null,
    };
  }

  const detailResponse = await fetch(
    `${FIREWORKS_API_ROOT}/v1/accounts/${encodeURIComponent(selectedAccount.accountId)}`,
    {
      headers: getAuthHeaders(trimmedApiKey),
    },
  );
  const detailPayload = await readJsonResponse(detailResponse);

  if (!detailResponse.ok) {
    return {
      account: selectedAccount,
      accounts,
      resolvedAccountId: selectedAccount.accountId,
    };
  }

  const detailRecord =
    detailPayload && typeof detailPayload === "object"
      ? normalizeAccountRecord(detailPayload as JsonRecord)
      : null;

  return {
    account: detailRecord || selectedAccount,
    accounts,
    resolvedAccountId: selectedAccount.accountId,
  };
};

export const detectFireworksCli = async (): Promise<FireworksCliStatus> => {
  const result = await executeCommand("firectl version", undefined, "powershell");
  const output = normalizeCliMessage(`${result.stdout}\n${result.stderr}`);

  if (!result.success) {
    return {
      available: false,
      message: output,
      version: null,
    };
  }

  return {
    available: true,
    message: output || "firectl is available.",
    version: output || null,
  };
};

export const exportFireworksUsage = async (
  apiKey: string,
  accountId?: string,
): Promise<FireworksUsageSummary> => {
  const trimmedApiKey = apiKey.trim();
  if (!trimmedApiKey) {
    throw new Error("Add a Fireworks API key before syncing usage.");
  }

  const cliStatus = await detectFireworksCli();
  if (!cliStatus.available) {
    throw new Error(cliStatus.message);
  }

  const command = buildBillingExportCommand(trimmedApiKey, accountId);
  const result = await executeCommand(command, undefined, "powershell");
  const output = result.stdout.trim();

  if (!result.success) {
    throw new Error(result.stderr.trim() || output || "Failed to export Fireworks billing metrics.");
  }

  if (!output) {
    throw new Error("Fireworks metrics export returned an empty CSV payload.");
  }

  return parseUsageSummary(output);
};
