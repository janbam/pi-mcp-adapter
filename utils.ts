import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { McpConfig, ServerEntry } from "./types.ts";

async function execOpen(pi: ExtensionAPI, target: string, browser?: string) {
  const os = platform();

  if (os === "darwin") {
    return browser ? pi.exec("open", ["-a", browser, target]) : pi.exec("open", [target]);
  }
  if (os === "win32") {
    return browser
      ? pi.exec("cmd", ["/c", "start", "", browser, target])
      : pi.exec("cmd", ["/c", "start", "", target]);
  }
  return browser ? pi.exec(browser, [target]) : pi.exec("xdg-open", [target]);
}

export async function openUrl(pi: ExtensionAPI, url: string, browser?: string): Promise<void> {
  const result = await execOpen(pi, url, browser);
  if (result.code !== 0) {
    throw new Error(result.stderr || `Failed to open browser (exit code ${result.code})`);
  }
}

export async function openPath(pi: ExtensionAPI, targetPath: string): Promise<void> {
  const result = await execOpen(pi, targetPath);
  if (result.code !== 0) {
    throw new Error(result.stderr || `Failed to open path (exit code ${result.code})`);
  }
}

export async function parallelLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array(Math.min(limit, items.length)).fill(null).map(() => worker());
  await Promise.all(workers);
  return results;
}

export function getConfigPathFromArgv(): string | undefined {
  const idx = process.argv.indexOf("--mcp-config");
  if (idx >= 0 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  return undefined;
}

export function interpolateEnvVars(value: string): string {
  return value
    .replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "")
    .replace(/\$env:(\w+)/g, (_, name) => process.env[name] ?? "");
}

export function interpolateEnvRecord(values: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!values) return undefined;

  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    resolved[key] = interpolateEnvVars(value);
  }
  return resolved;
}

export function resolveConfigPath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;

  const resolved = interpolateEnvVars(value);
  if (resolved === "~") return homedir();
  if (resolved.startsWith("~/") || resolved.startsWith("~\\")) {
    return join(homedir(), resolved.slice(2));
  }
  return resolved;
}

export function resolveBearerToken(definition: Pick<ServerEntry, "bearerToken" | "bearerTokenEnv">): string | undefined {
  if (definition.bearerToken !== undefined) {
    return interpolateEnvVars(definition.bearerToken);
  }
  return definition.bearerTokenEnv ? process.env[definition.bearerTokenEnv] : undefined;
}

const DEFAULT_CALL_TIMEOUT_MS = 60_000;
let cachedCallTimeoutMs: number | undefined;

/**
 * FORK-OWNED (janbam/pi-mcp-adapter): per-call MCP request timeout.
 *
 * Upstream nicobailon/pi-mcp-adapter calls `client.callTool` with no options,
 * so the SDK's DEFAULT_REQUEST_TIMEOUT_MSEC (60000ms) applies silently and is not
 * configurable. This fork threads a per-call `timeout` (and
 * `resetTimeoutOnProgress: true`) into every callTool site and makes the value
 * settable via the `PI_MCP_TIMEOUT` env var. Preserve across upstream syncs.
 *
 * Override with `PI_MCP_TIMEOUT` (positive integer milliseconds); unset falls
 * back to 60000. Invalid values fail loud on first use rather than silently
 * degrading.
 */
export function getCallTimeoutMs(): number {
  if (cachedCallTimeoutMs !== undefined) return cachedCallTimeoutMs;
  const raw = process.env.PI_MCP_TIMEOUT;
  if (raw === undefined || raw === "") {
    cachedCallTimeoutMs = DEFAULT_CALL_TIMEOUT_MS;
    return cachedCallTimeoutMs;
  }
  // Strict integer parse: reject trailing garbage ("60abc"), fractions ("60.5"),
  // hex ("0x10"), and scientific notation ("1e3") that parseInt/Number would
  // otherwise coerce silently, honoring the documented fail-loud contract.
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || String(parsed) !== raw.trim()) {
    throw new Error(
      `Invalid PI_MCP_TIMEOUT="${raw}": expected a positive integer (milliseconds). ` +
        `Unset to use the default (${DEFAULT_CALL_TIMEOUT_MS}ms).`,
    );
  }
  cachedCallTimeoutMs = parsed;
  return cachedCallTimeoutMs;
}

export function truncateAtWord(text: string, target: number): string {
  if (!text || text.length <= target) return text;

  const truncated = text.slice(0, target);
  const lastSpace = truncated.lastIndexOf(" ");

  if (lastSpace > target * 0.6) {
    return truncated.slice(0, lastSpace) + "...";
  }

  return truncated + "...";
}

export function formatAuthRequiredMessage(
  config: Pick<McpConfig, "settings">,
  serverName: string,
  defaultMessage: string,
): string {
  const template = config.settings?.authRequiredMessage;
  return template ? template.replaceAll("${server}", serverName) : defaultMessage;
}

/**
 * Extract the adapter-owned UI stream mode from tool metadata.
 */
export function extractToolUiStreamMode(toolMeta: Record<string, unknown> | undefined): "eager" | "stream-first" | undefined {
  const uiMeta = toolMeta?.ui;
  if (!uiMeta || typeof uiMeta !== "object") return undefined;
  const streamMode = (uiMeta as Record<string, unknown>)["pi-mcp-adapter.streamMode"];
  if (streamMode === "eager" || streamMode === "stream-first") {
    return streamMode;
  }
  return undefined;
}
