import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"

const DEFAULT_LOG_PATH = join(homedir(), "opencode-llm.log")
const STATS_PATH = join(homedir(), ".config", "opencode", "snip-stats.json")
const PLUGIN_META_PATH = join(homedir(), ".local", "state", "opencode", "plugin-meta.json")
const VERSION_CHECK_PATH = join(homedir(), ".local", "state", "opencode", "snip-version-check.json")
const DEFAULT_MAX_PLUS_PLUS_TOOL_LINES = 40
const DEFAULT_MAX_PLUS_PLUS_TOOL_CHARS = 4000
const PACKAGE_NAME = "opencode-plugin-snip"
const VERSION_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const REMOVED_CONTROL_PREFIXES = ["[step-start]", "[step-finish]", "[reasoning]"]
const PROTECTED_BLOCK_TAGS = ["system-reminder"]
const REMOVED_CONTROL_PART_TYPES = new Set(["step-start", "step-finish", "reasoning"])

let cachedSystem = null

export default async function SnipServerPlugin(_input, options) {
  const settings = resolveSettings(options)
  void maybeRefreshLatestCache()

  return {
    "experimental.chat.system.transform": async (_input, output) => {
      cachedSystem = output.system
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      const originalMessages = output.messages
      const compressedMessages = originalMessages
        .map((message) => compressMessage(message, settings))
        .filter(Boolean)

      updateSavedCharsStats(originalMessages, compressedMessages, _input?.sessionID || _input?.session_id)

      output.messages = compressedMessages

      if (!settings.logEnabled) {
        return
      }

      writeFileSync(
        settings.logPath,
        buildLogContent({
          system: cachedSystem,
          compressedMessages,
          mode: settings.mode,
        }),
        "utf8",
      )
    },
  }
}

async function maybeRefreshLatestCache() {
  try {
    const meta = loadPluginMeta()
    if (!hasLatestPluginMetaEntry(meta)) {
      return
    }

    const localVersion = loadCurrentVersion()
    if (!localVersion || !shouldCheckLatest(localVersion)) {
      return
    }

    const latestVersion = await fetchLatestVersion()
    recordVersionCheck(localVersion, latestVersion)
    if (!latestVersion || compareVersions(latestVersion, localVersion) <= 0) {
      return
    }

    const latestCachePath = join(homedir(), ".cache", "opencode", "packages", `${PACKAGE_NAME}@latest`)
    rmSync(latestCachePath, { recursive: true, force: true })

    removeLatestPluginMetaEntries(meta)
    writeFileSync(PLUGIN_META_PATH, JSON.stringify(meta, null, 2), "utf8")
  } catch {}
}

function resolveSettings(options) {
  const mode = normalizeMode(options?.mode)
  const logEnabled = parseBoolean(options?.logEnabled, false)
  const logPath = resolveLogPath(options?.logPath)
  const toolMaxLines = parsePositiveInteger(options?.toolMaxLines, DEFAULT_MAX_PLUS_PLUS_TOOL_LINES)
  const toolMaxChars = parsePositiveInteger(options?.toolMaxChars, DEFAULT_MAX_PLUS_PLUS_TOOL_CHARS)

  return {
    mode,
    logEnabled,
    logPath,
    toolMaxLines,
    toolMaxChars,
  }
}

function loadCurrentVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"))
    return typeof pkg?.version === "string" ? pkg.version : ""
  } catch {
    return ""
  }
}

function loadPluginMeta() {
  try {
    const meta = JSON.parse(readFileSync(PLUGIN_META_PATH, "utf8"))
    return isRecord(meta) ? meta : {}
  } catch {
    return {}
  }
}

function hasLatestPluginMetaEntry(meta) {
  return Object.values(meta).some((entry) => isLatestPluginMetaEntry(entry))
}

function removeLatestPluginMetaEntries(meta) {
  for (const [key, entry] of Object.entries(meta)) {
    if (isLatestPluginMetaEntry(entry)) {
      delete meta[key]
    }
  }
}

function isLatestPluginMetaEntry(entry) {
  return (
    isRecord(entry) &&
    entry.spec === PACKAGE_NAME &&
    entry.requested === "latest" &&
    typeof entry.target === "string" &&
    entry.target.includes(`${PACKAGE_NAME}@latest`)
  )
}

function shouldCheckLatest(localVersion) {
  try {
    const state = JSON.parse(readFileSync(VERSION_CHECK_PATH, "utf8"))
    const checkedAt = Number(state?.checkedAt || 0)
    const latestVersion = typeof state?.latestVersion === "string" ? state.latestVersion : ""
    const currentVersion = typeof state?.currentVersion === "string" ? state.currentVersion : ""
    if (currentVersion !== localVersion) {
      return true
    }

    if (!checkedAt || Date.now() - checkedAt >= VERSION_CHECK_INTERVAL_MS) {
      return true
    }

    return compareVersions(latestVersion, localVersion) > 0
  } catch {
    return true
  }
}

function recordVersionCheck(currentVersion, latestVersion) {
  try {
    writeFileSync(
      VERSION_CHECK_PATH,
      JSON.stringify({ checkedAt: Date.now(), currentVersion, latestVersion }, null, 2),
      "utf8",
    )
  } catch {}
}

async function fetchLatestVersion() {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000)
    const response = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    })
    clearTimeout(timer)
    if (!response.ok) {
      return ""
    }

    const payload = await response.json()
    return typeof payload?.version === "string" ? payload.version : ""
  } catch {
    return ""
  }
}

function compareVersions(left, right) {
  const leftParts = String(left || "").split(".").map((part) => Number(part) || 0)
  const rightParts = String(right || "").split(".").map((part) => Number(part) || 0)
  const length = Math.max(leftParts.length, rightParts.length)

  for (let i = 0; i < length; i++) {
    const diff = (leftParts[i] || 0) - (rightParts[i] || 0)
    if (diff !== 0) {
      return diff
    }
  }

  return 0
}

function resolveLogPath(value) {
  if (typeof value !== "string") {
    return DEFAULT_LOG_PATH
  }

  const trimmed = value.trim()
  return trimmed || DEFAULT_LOG_PATH
}

function parsePositiveInteger(value, fallback) {
  const numeric = Number(value)
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return fallback
  }

  return numeric
}

function parseBoolean(value, fallback) {
  if (value == null) {
    return fallback
  }

  const normalized = String(value).trim().toLowerCase()
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false
  }

  return fallback
}

function normalizeMode(value) {
  const normalized = String(value || "max").trim().toLowerCase()
  if (normalized === "pro" || normalized === "max" || normalized === "max++") {
    return normalized
  }
  return "max"
}

function updateSavedCharsStats(originalMessages, compressedMessages, hookSessionID) {
  const sessionID = hookSessionID || detectSessionID(originalMessages, compressedMessages)
  if (!sessionID) {
    return
  }

  const stats = loadStats()
  const sessions = isRecord(stats.sessions) ? stats.sessions : {}
  const session = isRecord(sessions[sessionID]) ? sessions[sessionID] : { savedChars: 0, seen: {} }
  const seen = isRecord(session.seen) ? session.seen : {}
  let delta = 0

  for (let i = 0; i < originalMessages.length; i++) {
    const original = originalMessages[i]
    const compressed = compressedMessages[i]
    if (!original || !compressed) {
      continue
    }

    const key = getMessageKey(original, i)
    const savedChars = Math.max(0, estimateMessagesSize([original]) - estimateMessagesSize([compressed]))
    const previous = Math.max(0, Number(seen[key]) || 0)
    if (savedChars === previous) {
      continue
    }

    seen[key] = savedChars
    delta += savedChars - previous
  }

  if (delta === 0) {
    return
  }

  const next = {
    version: 2,
    sessions: {
      ...sessions,
      [sessionID]: {
        savedChars: Math.max(0, (Number(session.savedChars) || 0) + delta),
        seen,
      },
    },
    updatedAt: new Date().toISOString(),
  }

  try {
    writeFileSync(STATS_PATH, JSON.stringify(next, null, 2), "utf8")
  } catch {}
}

function loadStats() {
  try {
    const stats = JSON.parse(readFileSync(STATS_PATH, "utf8"))
    if (stats?.version === 2 && isRecord(stats.sessions)) {
      return stats
    }
  } catch {
    return { version: 2, sessions: {} }
  }

  return { version: 2, sessions: {} }
}

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function detectSessionID(originalMessages, compressedMessages) {
  for (const message of [...(originalMessages || []), ...(compressedMessages || [])]) {
    const sessionID =
      message?.sessionID ||
      message?.info?.sessionID ||
      message?.parts?.find?.((part) => typeof part?.sessionID === "string" && part.sessionID)?.sessionID
    if (typeof sessionID === "string" && sessionID) {
      return sessionID
    }
  }

  return null
}

function getMessageKey(message, index) {
  const explicit = message?.id || message?.messageID || message?.info?.id
  if (explicit) {
    return String(explicit)
  }

  const role = String(message?.info?.role || "unknown")
  const parts = (message?.parts || [])
    .map((part) => {
      if (part?.type === "text") {
        return `text:${String(part.text || "").slice(0, 200)}`
      }

      try {
        return `${String(part?.type || "unknown")}:${JSON.stringify(part).slice(0, 200)}`
      } catch {
        return String(part?.type || "unknown")
      }
    })
    .join("|")

  return `${index}:${role}:${parts}`
}

function estimateMessagesSize(messages) {
  let total = 0

  for (const message of messages || []) {
    total += String(message.info?.role || "").length

    for (const part of message.parts || []) {
      total += String(part.type || "").length
      if (part.type === "text") {
        total += String(part.text || "").length
        continue
      }

      try {
        total += JSON.stringify(part).length
      } catch {}
    }
  }

  return total
}

function compressMessage(message, settings) {
  const parts = []

  for (const part of message.parts || []) {
    if (REMOVED_CONTROL_PART_TYPES.has(part.type)) {
      continue
    }

    if (part.type === "tool") {
      const text = normalizeToolPart(part, settings)
      if (!text) {
        continue
      }

      parts.push({ type: "text", text })
      continue
    }

    if (part.type !== "text") {
      parts.push({ ...part })
      continue
    }

    const text = compressTextPart(part.text, settings)
    if (!text) {
      continue
    }

    parts.push({ ...part, text })
  }

  if (parts.length === 0) {
    return null
  }

  return {
    ...message,
    info: message.info ? { ...message.info } : message.info,
    parts,
  }
}

function compressTextPart(text, settings) {
  const lines = String(text || "").split(/\r?\n/)
  const keptLines = []
  let protectedTag = null

  for (const line of lines) {
    const trimmed = line.trim()
    const nextProtectedTag = updateProtectedTagState(trimmed, protectedTag)

    if (!protectedTag && shouldRemoveControlLine(trimmed)) {
      continue
    }

    if (trimmed.startsWith("[tool]")) {
      const normalizedToolLine = normalizeToolLine(line, settings)
      if (normalizedToolLine) {
        keptLines.push(...normalizedToolLine.split("\n"))
      }
      continue
    }

    keptLines.push(line.replace(/[ \t]+$/g, ""))
    protectedTag = nextProtectedTag
  }

  return cleanupWhitespace(keptLines.join("\n"))
}

function normalizeToolLine(line, settings) {
  if (settings.mode === "pro") {
    return line.replace(/[ \t]+$/g, "")
  }

  const match = line.match(/^\s*\[tool\]\s*(.+)$/)
  if (!match) {
    return line.replace(/[ \t]+$/g, "")
  }

  let payload
  try {
    payload = JSON.parse(match[1])
  } catch {
    return line.replace(/[ \t]+$/g, "")
  }

  return formatToolPayload(payload, settings)
}

function normalizeToolPart(part, settings) {
  return formatToolPayload(part, settings)
}

function formatToolPayload(payload, settings) {
  if (settings.mode === "pro") {
    return `[tool] ${JSON.stringify(payload)}`
  }

  const toolName = payload.tool || payload.name || "unknown"
  const status = payload.state?.status || payload.status || "unknown"
  const output = formatToolOutput(payload.state?.output ?? payload.output)
  const body = settings.mode === "max++" ? truncateToolOutput(output, settings) : output

  let result = `[tool:${toolName}][${status}]`
  if (body) {
    result += `\n${body}`
  }
  return result
}

function formatToolOutput(output) {
  let text

  if (output == null) {
    return ""
  }

  if (typeof output === "string") {
    text = output
  } else {
    text = JSON.stringify(output, null, 2)
  }

  return stripControlLines(text)
}

function truncateToolOutput(text, settings) {
  const lines = String(text || "").split(/\r?\n/)
  const limitedLines = lines.slice(0, settings.toolMaxLines).join("\n")
  if (limitedLines.length <= settings.toolMaxChars && lines.length <= settings.toolMaxLines) {
    return limitedLines
  }

  const truncated = limitedLines.slice(0, settings.toolMaxChars)
  return `${truncated}\n[tool-output-truncated]`
}

function cleanupWhitespace(text) {
  const normalized = String(text || "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

  return normalized
}

function stripControlLines(text) {
  const lines = String(text || "").split(/\r?\n/)
  const keptLines = []
  let protectedTag = null

  for (const line of lines) {
    const trimmed = line.trim()
    const nextProtectedTag = updateProtectedTagState(trimmed, protectedTag)

    if (!protectedTag && shouldRemoveControlLine(trimmed)) {
      continue
    }

    keptLines.push(line.replace(/[ \t]+$/g, ""))
    protectedTag = nextProtectedTag
  }

  return cleanupWhitespace(keptLines.join("\n"))
}

function shouldRemoveControlLine(trimmed) {
  return REMOVED_CONTROL_PREFIXES.some((prefix) => matchesFrameworkEventLine(trimmed, prefix))
}

function matchesFrameworkEventLine(trimmed, prefix) {
  if (!trimmed.startsWith(prefix)) {
    return false
  }

  const suffix = trimmed.slice(prefix.length)
  return suffix === "" || /^\s*\{/.test(suffix)
}

function updateProtectedTagState(trimmed, currentTag) {
  if (currentTag) {
    if (trimmed.includes(`</${currentTag}>`)) {
      return null
    }
    return currentTag
  }

  for (const tag of PROTECTED_BLOCK_TAGS) {
    if (trimmed.includes(`<${tag}>`)) {
      if (trimmed.includes(`</${tag}>`)) {
        return null
      }
      return tag
    }
  }

  return null
}

function buildLogContent({ system, compressedMessages, mode }) {
  const timestamp = new Date().toISOString()
  let content = `=== opencode log at ${timestamp} ===\n`
  content += `compression mode: ${mode}\n`

  if (system) {
    content += `\n${"=".repeat(60)}\n`
    content += `[${timestamp}] SYSTEM PROMPT (${system.length} blocks)\n`
    content += "=".repeat(60) + "\n"
    for (let i = 0; i < system.length; i++) {
      content += `--- system[${i}] ---\n`
      content += system[i] + "\n"
    }
  }

  content += `\n${"=".repeat(60)}\n`
  content += `[${timestamp}] MESSAGES -> LLM (${compressedMessages.length} items)\n`
  content += "=".repeat(60) + "\n"
  content += renderMessages(compressedMessages)

  return content
}

function renderMessages(messages) {
  let content = ""
  for (const msg of messages) {
    const role = msg.info?.role || "unknown"
    content += `\n--- [${role}] ---\n`
    for (const part of msg.parts || []) {
      if (part.type === "text") {
        content += part.text + "\n"
      }
    }
  }
  return content
}
