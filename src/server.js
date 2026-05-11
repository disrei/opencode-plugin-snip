import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"

const DEFAULT_LOG_PATH = join(homedir(), "opencode-llm.log")
const STATS_PATH = join(homedir(), ".config", "opencode", "snip-stats.json")
const CONFIG_PATH = join(homedir(), ".config", "opencode", "opencode.json")
const TUI_CONFIG_PATH = join(homedir(), ".config", "opencode", "tui.json")
const PLUGIN_META_PATH = join(homedir(), ".local", "state", "opencode", "plugin-meta.json")
const VERSION_CHECK_PATH = join(homedir(), ".local", "state", "opencode", "snip-version-check.json")
const PACKAGE_NAME = "opencode-plugin-snip"
const VERSION_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const HISTORICAL_TOOL_OUTPUT_OMITTED = "[historical-tool-output-omitted]"
const SYSTEM_REMINDER_PATTERN = /<system-reminder(?:\s|>)/i
const HISTORICAL_TOOL_OUTPUT_OMIT_THRESHOLD_CHARS = 1500

const REMOVED_CONTROL_PREFIXES = ["[step-start]", "[step-finish]", "[reasoning]"]
const PROTECTED_BLOCK_TAGS = ["system-reminder"]
const REMOVED_CONTROL_PART_TYPES = new Set(["step-start", "step-finish", "reasoning"])

let cachedSystem = null
let pendingPackageRemoval = null

export default async function SnipServerPlugin(_input, options) {
  const settings = resolveSettings(options)
  void maybeRefreshLatestCache()

  return {
    "experimental.chat.system.transform": async (_input, output) => {
      cachedSystem = output.system
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      const originalMessages = output.messages
      const lastUserMessageIndex = findLastUserMessageIndex(originalMessages)
      const compressedEntries = originalMessages.map((message, index) =>
          compressMessage(message, settings, {
            preserveToolOutput: shouldPreserveToolOutput(settings, index, lastUserMessageIndex),
          }),
        )
      const compressedMessages = compressedEntries.filter(Boolean)

      updateSavedCharsStats(originalMessages, compressedEntries, _input?.sessionID || _input?.session_id)

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
    const installContext = resolveInstalledPackageContext()
    if (!installContext) {
      return
    }

    const meta = loadPluginMeta()
    const localVersion = loadCurrentVersion()
    if (!localVersion || !shouldCheckLatest(localVersion)) {
      return
    }

    const latestVersion = await fetchLatestVersion()
    recordVersionCheck(localVersion, latestVersion)
    if (!latestVersion || compareVersions(latestVersion, localVersion) <= 0) {
      return
    }

    pinPluginVersionInConfig(latestVersion)
    invalidateInstalledPackageContext(installContext)

    removeManagedPluginMetaEntries(meta)
    writeFileSync(PLUGIN_META_PATH, JSON.stringify(meta, null, 2), "utf8")
  } catch {}
}

function resolveSettings(options) {
  const mode = normalizeMode(options?.mode)
  const logEnabled = parseBoolean(options?.logEnabled, false)
  const logPath = resolveLogPath(options?.logPath)

  return {
    mode,
    logEnabled,
    logPath,
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

function pinPluginVersionInConfig(version) {
  const pinnedSpec = `${PACKAGE_NAME}@${version}`
  updateJsonFile(CONFIG_PATH, (config) => {
    const next = isRecord(config) ? { ...config } : {}
    const plugins = Array.isArray(next.plugin) ? next.plugin : []
    next.plugin = plugins.map((entry) => {
      if (!Array.isArray(entry) || entry.length < 2) {
        return entry
      }

      const [spec, pluginOptions] = entry
      return isPackageSpec(spec) ? [pinnedSpec, pluginOptions] : entry
    })
    return next
  })

  updateJsonFile(TUI_CONFIG_PATH, (config) => {
    const next = isRecord(config) ? { ...config } : {}
    const plugins = Array.isArray(next.plugin) ? next.plugin : []
    next.plugin = plugins.map((entry) => (isPackageSpec(entry) ? pinnedSpec : entry))
    return next
  })
}

function loadPluginMeta() {
  try {
    const meta = JSON.parse(readFileSync(PLUGIN_META_PATH, "utf8"))
    return isRecord(meta) ? meta : {}
  } catch {
    return {}
  }
}

function updateJsonFile(filePath, transform) {
  try {
    const current = parseJsonLike(readFileSync(filePath, "utf8"))
    const next = transform(current)
    writeFileSync(filePath, JSON.stringify(next, null, 2), "utf8")
  } catch {}
}

function parseJsonLike(content) {
  return JSON.parse(stripJsonCommentsAndTrailingCommas(content))
}

function stripJsonCommentsAndTrailingCommas(content) {
  return content
    .replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (match, comment) => (comment ? "" : match))
    .replace(/,(\s*[}\]])/g, "$1")
}

function isPackageSpec(value) {
  return typeof value === "string" && (value === PACKAGE_NAME || value.startsWith(`${PACKAGE_NAME}@`))
}

function hasManagedPluginMetaEntry(meta) {
  return Object.values(meta).some((entry) => isManagedPluginMetaEntry(entry))
}

function removeManagedPluginMetaEntries(meta) {
  for (const [key, entry] of Object.entries(meta)) {
    if (isManagedPluginMetaEntry(entry)) {
      delete meta[key]
    }
  }
}

function isManagedPluginMetaEntry(entry) {
  return isRecord(entry) && isPackageSpec(entry.spec)
}

function resolveInstalledPackageContext() {
  if (basename(PACKAGE_ROOT) !== PACKAGE_NAME) {
    return null
  }

  const nodeModulesDir = dirname(PACKAGE_ROOT)
  if (basename(nodeModulesDir) !== "node_modules") {
    return null
  }

  const installRoot = dirname(nodeModulesDir)
  if (!installRoot || installRoot === nodeModulesDir) {
    return null
  }

  return {
    packageRoot: PACKAGE_ROOT,
    nodeModulesDir,
    installRoot,
    manifestPath: join(installRoot, "package.json"),
    lockPath: join(installRoot, "bun.lock"),
  }
}

function invalidateInstalledPackageContext(context) {
  let changed = false

  changed = removePackageFromInstallManifest(context.manifestPath) || changed
  changed = removePackageFromBunLock(context.lockPath) || changed

  // Defer deleting the live package until process shutdown so the current session
  // can keep using both server and TUI entrypoints safely.
  changed = schedulePackageRemoval(context.packageRoot) || changed

  return changed
}

function schedulePackageRemoval(packageRoot) {
  if (!packageRoot || pendingPackageRemoval === packageRoot) {
    return false
  }

  pendingPackageRemoval = packageRoot

  const cleanup = () => {
    try {
      if (pendingPackageRemoval && existsSync(pendingPackageRemoval)) {
        rmSync(pendingPackageRemoval, { recursive: true, force: true })
      }
    } catch {}
  }

  process.once("exit", cleanup)
  return true
}

function removePackageFromInstallManifest(filePath) {
  try {
    if (!existsSync(filePath)) {
      return false
    }

    const manifest = parseJsonLike(readFileSync(filePath, "utf8"))
    if (!isRecord(manifest)) {
      return false
    }

    let changed = false
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      if (isRecord(manifest[field]) && Object.prototype.hasOwnProperty.call(manifest[field], PACKAGE_NAME)) {
        delete manifest[field][PACKAGE_NAME]
        changed = true
      }
    }

    if (!changed) {
      return false
    }

    writeFileSync(filePath, JSON.stringify(manifest, null, 2), "utf8")
    return true
  } catch {
    return false
  }
}

function removePackageFromBunLock(filePath) {
  try {
    if (!existsSync(filePath)) {
      return false
    }

    const lockfile = parseJsonLike(readFileSync(filePath, "utf8"))
    if (!isRecord(lockfile)) {
      return false
    }

    let changed = false
    const workspaceDependencies = lockfile?.workspaces?.[""]?.dependencies
    if (isRecord(workspaceDependencies) && Object.prototype.hasOwnProperty.call(workspaceDependencies, PACKAGE_NAME)) {
      delete workspaceDependencies[PACKAGE_NAME]
      changed = true
    }

    const packages = lockfile.packages
    if (isRecord(packages)) {
      for (const key of Object.keys(packages)) {
        if (key === PACKAGE_NAME || key.startsWith(`${PACKAGE_NAME}@`)) {
          delete packages[key]
          changed = true
        }
      }
    }

    if (!changed) {
      return false
    }

    writeFileSync(filePath, JSON.stringify(lockfile, null, 2), "utf8")
    return true
  } catch {
    return false
  }
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
    if (!original) {
      continue
    }

    const key = getMessageKey(original, i)
    const originalSize = estimateMessagesSize([original])
    const compressedSize = compressed ? estimateMessagesSize([compressed]) : 0
    const savedChars = Math.max(0, originalSize - compressedSize)
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

  const nextSavedChars = Math.max(0, (Number(session.savedChars) || 0) + delta)
  const next = {
    version: 2,
    sessions: {
      ...sessions,
      [sessionID]: {
        savedChars: nextSavedChars,
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

function findLastUserMessageIndex(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    if (String(messages[i]?.info?.role || "") === "user") {
      return i
    }
  }

  return -1
}

function shouldPreserveToolOutput(settings, messageIndex, lastUserMessageIndex) {
  if (settings.mode !== "max++") {
    return false
  }

  if (lastUserMessageIndex < 0) {
    return true
  }

  return messageIndex > lastUserMessageIndex
}

function compressMessage(message, settings, context = {}) {
  const parts = []

  for (const part of message.parts || []) {
    if (REMOVED_CONTROL_PART_TYPES.has(part.type)) {
      continue
    }

    if (part.type === "tool") {
      const text = normalizeToolPart(part, settings, context)
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

    const text = compressTextPart(part.text, settings, context)
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

function compressTextPart(text, settings, context) {
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
      const normalizedToolLine = normalizeToolLine(line, settings, context)
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

function normalizeToolLine(line, settings, context) {
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

  return formatToolPayload(payload, settings, context)
}

function normalizeToolPart(part, settings, context) {
  return formatToolPayload(part, settings, context)
}

function formatToolPayload(payload, settings, context) {
  if (settings.mode === "pro") {
    return `[tool] ${JSON.stringify(payload)}`
  }

  const toolName = payload.tool || payload.name || "unknown"
  const status = payload.state?.status || payload.status || "unknown"
  const output = formatToolOutput(payload.state?.output ?? payload.output)
  const body = shouldOmitHistoricalToolOutput(settings, context, output) ? summarizeHistoricalToolOutput(output, payload) : output

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

function summarizeHistoricalToolOutput(text, payload) {
  const normalized = String(text || "")
  if (!normalized) {
    return HISTORICAL_TOOL_OUTPUT_OMITTED
  }

  const lineCount = normalized.split(/\r?\n/).length
  const charCount = normalized.length
  const fileHint = extractToolPayloadHint(payload, normalized)
  const hintSuffix = fileHint ? `, ${fileHint}` : ""
  return `${HISTORICAL_TOOL_OUTPUT_OMITTED} (${lineCount} lines, ${charCount} chars${hintSuffix})`
}

function extractToolPayloadHint(payload, output) {
  const input = payload?.state?.input ?? payload?.input
  if (input && typeof input === "object") {
    const filePath = input.filePath
    if (typeof filePath === "string" && filePath) {
      const parts = String(filePath).replace(/\\/g, "/").split("/")
      return `file: ${parts[parts.length - 1]}`
    }

    const dirPath = input.path
    if (typeof dirPath === "string" && dirPath) {
      const parts = String(dirPath).replace(/\\/g, "/").split("/")
      return `path: ${parts[parts.length - 1]}`
    }

    const fileName = input.file
    if (typeof fileName === "string" && fileName) {
      const parts = String(fileName).replace(/\\/g, "/").split("/")
      return `file: ${parts[parts.length - 1]}`
    }
  }

  const firstLine = String(output || "").split(/\r?\n/)[0]
  if (firstLine && firstLine.trim()) {
    const trimmed = firstLine.trim()
    return `"${trimmed.length > 80 ? trimmed.slice(0, 80) + "..." : trimmed}"`
  }

  return null
}

function shouldOmitHistoricalToolOutput(settings, context, output) {
  if (settings.mode !== "max++" || context.preserveToolOutput) {
    return false
  }

  const normalized = String(output || "")
  if (SYSTEM_REMINDER_PATTERN.test(normalized)) {
    return false
  }

  return normalized.length > HISTORICAL_TOOL_OUTPUT_OMIT_THRESHOLD_CHARS
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
