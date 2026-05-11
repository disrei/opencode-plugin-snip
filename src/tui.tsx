/** @jsxImportSource @opentui/solid */
import { readFileSync } from "node:fs"
import { basename, join } from "node:path"
import { homedir } from "node:os"
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { TuiPlugin, TuiPluginModule, TuiPluginApi, TuiSlotPlugin } from "@opencode-ai/plugin/tui"

const CONFIG_PATH = join(homedir(), ".config", "opencode", "opencode.json")
const STATS_PATH = join(homedir(), ".config", "opencode", "snip-stats.json")
const PACKAGE_NAME = "opencode-plugin-snip"

function normalizePluginSpec(spec: string) {
  return String(spec || "")
    .replace(/^file:\/\//, "")
    .replace(/\\/g, "/")
    .toLowerCase()
}

function isLogPluginSpec(spec: string) {
  const normalized = normalizePluginSpec(spec)
  return (
    normalized === PACKAGE_NAME ||
    normalized.startsWith(`${PACKAGE_NAME}@`) ||
    basename(normalized) === "server.js" ||
    basename(normalized) === "log-llm.js"
  )
}

function loadMode() {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8")
    const config = JSON.parse(raw)
    const plugins = Array.isArray(config?.plugin) ? config.plugin : []

    for (const entry of plugins) {
      if (!Array.isArray(entry) || entry.length < 2) continue
      const [spec, pluginOptions] = entry
      if (!isLogPluginSpec(String(spec || ""))) continue

      const mode = String(pluginOptions?.mode || "max").trim().toLowerCase()
      if (mode === "pro" || mode === "max" || mode === "max++") return mode
    }
  } catch {}

  return "max"
}

function labelForMode(mode: string) {
  if (mode === "max++") return "snip max++"
  if (mode === "pro") return "snip pro"
  return "snip max"
}

function currentRouteSessionID(api: TuiPluginApi) {
  const current = api.route.current
  if (current?.name !== "session") {
    return null
  }

  const sessionID = current.params?.sessionID || current.params?.session_id
  return typeof sessionID === "string" && sessionID ? sessionID : null
}

function slotSessionID(value: unknown) {
  if (!value || typeof value !== "object") return null
  const sessionID = (value as { session_id?: unknown; sessionID?: unknown }).session_id ??
    (value as { session_id?: unknown; sessionID?: unknown }).sessionID
  return typeof sessionID === "string" && sessionID ? sessionID : null
}

function loadSavedCharsForSession(sessionID: string) {
  try {
    const stats = JSON.parse(readFileSync(STATS_PATH, "utf8"))
    return Math.max(0, Number(stats?.sessions?.[sessionID]?.savedChars) || 0)
  } catch {
    return 0
  }
}

function formatSavedChars(savedChars: number) {
  const value = Math.max(0, savedChars) / 1000
  return `${value.toFixed(1)}k`
}

function useCurrentRouteSavedChars(api: TuiPluginApi) {
  const [savedChars, setSavedChars] = createSignal(0)

  const update = () => {
    const sessionID = currentRouteSessionID(api)
    setSavedChars(sessionID ? loadSavedCharsForSession(sessionID) : 0)
  }

  update()
  const timer = setInterval(update, 2000)

  onCleanup(() => clearInterval(timer))

  return savedChars
}

function useSessionSavedChars(getSessionID: () => string) {
  const [savedChars, setSavedChars] = createSignal(0)

  const update = () => {
    const sessionID = getSessionID()
    setSavedChars(sessionID ? loadSavedCharsForSession(sessionID) : 0)
  }

  createEffect(update)
  const timer = setInterval(update, 2000)

  onCleanup(() => clearInterval(timer))

  return savedChars
}

function HomeLabel(props: { api: TuiPluginApi; label: string }) {
  const savedChars = useCurrentRouteSavedChars(props.api)
  const text = createMemo(() => {
    props.api.state.session.count()
    props.api.route.current
    return `${props.label} ${formatSavedChars(savedChars())}`
  })

  return <text fg="#ffd54a">{text()}</text>
}

function SessionLabel(props: { api: TuiPluginApi; label: string; sessionID: string }) {
  const savedChars = useSessionSavedChars(() => props.sessionID)
  const text = createMemo(() => {
    props.api.state.session.messages(props.sessionID).length
    props.api.state.session.status(props.sessionID)
    return `${props.label} ${formatSavedChars(savedChars())}`
  })

  return <text fg="#ffd54a">{text()}</text>
}

function rightSlot(api: TuiPluginApi, label: string): TuiSlotPlugin {
  return {
    id: "prompt-right",
    slots: {
      home_prompt_right(_ctx, _value) {
        return <HomeLabel api={api} label={label} />
      },
      session_prompt_right(_ctx, value) {
        const selectedSessionID = slotSessionID(value) || currentRouteSessionID(api) || ""
        return <SessionLabel api={api} label={label} sessionID={selectedSessionID} />
      },
    },
  }
}

const tui: TuiPlugin = async (api: TuiPluginApi) => {
  const label = labelForMode(loadMode())
  api.slots.register(rightSlot(api, label))
}

const plugin: TuiPluginModule & { id: string } = {
  id: "snip-tui",
  tui,
}

export default plugin
