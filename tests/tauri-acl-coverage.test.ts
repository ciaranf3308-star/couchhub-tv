// Tauri ACL coverage — every frontend invoke() must be allowed, every
// allowed custom command must exist.
//
// 0.11.2 W1: `ai_key_set` (and all four of its siblings, plus six
// Followed Series commands) were registered in src-tauri/src/lib.rs and
// invoked from the main window, but listed in NO permission set — so the
// packaged app rejected every call with "Command ai_key_set not allowed
// by ACL" and Settings always reported "No key saved" (user photo
// 2026-11-11). The Discover feature (fe32bdf) added the commands without
// touching src-tauri/permissions/; the 0.11.1 error-surfacing pass
// (e7c8eb6) made the failure visible but did not grant anything.
//
// This test parses the three sides statically — invoke call sites in
// src/, permission sets in src-tauri/permissions/, capability files in
// src-tauri/capabilities/, and the generate_handler! registrations in
// lib.rs — and asserts they agree, so this class of bug fails CI instead
// of failing on the user's projector. No key material anywhere in this
// file: command names only.

import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join, dirname } from "node:path"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel: string) => readFileSync(join(root, rel), "utf8")

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry !== "node_modules") walk(full, out)
    } else if (/\.(ts|js|astro|svelte)$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

// First string argument of any *invoke* call: literal invoke("cmd"),
// generic invoke<T>("cmd"), and the local wrappers invokeAi("cmd") /
// invokeRegisterCommand("cmd") / the followed-startup + followed-card
// wrappers — all pass the command name as a string literal at the call
// site. The two genuinely dynamic sites (keystore.ts invokeAi and
// vod-proxy.ts invokeRegisterCommand) forward that literal, so every
// reachable command appears here as a literal.
const INVOKE_RE =
  /(?:invoke\w*|tauriInvoke)\s*(?:<[^>]*>)?\(\s*["']([a-z][a-z0-9_]*)["']/g

function invokedFromMain(): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const file of walk(join(root, "src"))) {
    const lines = readFileSync(file, "utf8").split("\n")
    lines.forEach((line, index) => {
      for (const match of line.matchAll(INVOKE_RE)) {
        const cmd = match[1]
        const site = `${file.replace(`${root}/`, "")}:${index + 1}`
        if (!found.has(cmd)) found.set(cmd, [])
        found.get(cmd)!.push(site)
      }
    })
  }
  return found
}

// Commands the sniffer window's remote page may invoke: injected as JS
// by src-tauri/src/sniffer.rs, not present in src/.
function invokedFromSniffer(): Set<string> {
  const sniffer = read("src-tauri/src/sniffer.rs")
  return new Set(
    [...sniffer.matchAll(/__TAURI_INTERNALS__\.invoke\(["']([a-z][a-z0-9_]*)["']/g)].map(
      (match) => match[1]
    )
  )
}

function registeredCommands(): Set<string> {
  const lib = read("src-tauri/src/lib.rs")
  const registered = new Set<string>()
  for (const block of lib.matchAll(/invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\)/g)) {
    for (const match of block[1].matchAll(/::([a-z][a-z0-9_]*),/g)) {
      registered.add(match[1])
    }
  }
  return registered
}

// identifier -> commands.allow from src-tauri/permissions/*.toml.
// A hand-rolled parse (identifier + one commands.allow array per file)
// is enough for these files and keeps the test free of a TOML dep.
function permissionSets(): Map<string, Set<string>> {
  const sets = new Map<string, Set<string>>()
  const dir = join(root, "src-tauri/permissions")
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".toml"))) {
    const text = read(`src-tauri/permissions/${file}`)
    const identifier = text.match(/identifier\s*=\s*"([^"]+)"/)?.[1]
    expect(identifier, `${file} must declare an identifier`).toBeTruthy()
    const allowBlock = text.match(/commands\.allow\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? ""
    sets.set(
      identifier!,
      new Set([...allowBlock.matchAll(/"([a-z][a-z0-9_]*)"/g)].map((m) => m[1]))
    )
  }
  return sets
}

interface Capability {
  windows: string[]
  permissions: string[]
}

function capabilities(): Map<string, Capability> {
  const caps = new Map<string, Capability>()
  const dir = join(root, "src-tauri/capabilities")
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const parsed = JSON.parse(read(`src-tauri/capabilities/${file}`)) as {
      windows?: string[]
      permissions?: Array<string | { identifier: string }>
    }
    caps.set(file, {
      windows: parsed.windows ?? [],
      permissions: (parsed.permissions ?? []).map((p) =>
        typeof p === "string" ? p : p.identifier
      ),
    })
  }
  return caps
}

// Custom commands allowed for a window: union of the commands.allow
// lists of every permission set the window's capability files grant.
// Plugin permissions ("core:default", "fs:allow-...") contain a colon
// and are not custom commands — they are skipped here.
function allowedForWindow(window: string, caps: Map<string, Capability>, sets: Map<string, Set<string>>): Set<string> {
  const allowed = new Set<string>()
  for (const cap of caps.values()) {
    if (!cap.windows.includes(window)) continue
    for (const permission of cap.permissions) {
      const commands = sets.get(permission)
      if (commands) for (const cmd of commands) allowed.add(cmd)
    }
  }
  return allowed
}

describe("Tauri ACL coverage (0.11.2 W1)", () => {
  const invoked = invokedFromMain()
  const snifferInvoked = invokedFromSniffer()
  const registered = registeredCommands()
  const sets = permissionSets()
  const caps = capabilities()
  const mainAllowed = allowedForWindow("main", caps, sets)
  const snifferAllowed = allowedForWindow("sniffer", caps, sets)

  it("the main window is covered by the default + desktop capabilities", () => {
    expect(caps.get("default.json")?.windows).toContain("main")
    expect(caps.get("desktop.json")?.windows).toContain("main")
  })

  it("every command the main window invokes is allowed by the ACL", () => {
    const gaps = [...invoked.keys()].filter((cmd) => !mainAllowed.has(cmd))
    expect(
      gaps,
      `invoked but not allowed on main: ${gaps
        .map((cmd) => `${cmd} (at ${invoked.get(cmd)!.join(", ")})`)
        .join("; ")}`
    ).toEqual([])
  })

  it("every command the main window invokes is registered in Rust", () => {
    const ghosts = [...invoked.keys()].filter((cmd) => !registered.has(cmd))
    expect(ghosts, `invoked but not registered: ${ghosts.join(", ")}`).toEqual([])
  })

  it("the AI key store commands are allowed on the main window (0.11.1 defect)", () => {
    // The exact five commands behind the 2026-11-11 photo:
    // "Could not save the key. (Command ai_key_set not allowed by ACL)".
    for (const cmd of ["ai_key_set", "ai_key_get", "ai_key_has", "ai_key_delete", "ai_test_connection"]) {
      expect(mainAllowed.has(cmd), `${cmd} must be allowed on main`).toBe(true)
      expect(registered.has(cmd), `${cmd} must be registered`).toBe(true)
      expect(invoked.has(cmd), `${cmd} must still be invoked (test is live)`).toBe(true)
    }
  })

  it("the Followed Series commands are allowed on the main window", () => {
    // Same class of gap, found by the audit: registered + invoked, never granted.
    for (const cmd of [
      "followed_headless_mode",
      "followed_take_pending_deep_link",
      "followed_headless_done",
      "followed_publish_notifications",
      "followed_schedule_status",
      "followed_schedule_set",
      "followed_schedule_repair",
    ]) {
      expect(mainAllowed.has(cmd), `${cmd} must be allowed on main`).toBe(true)
      expect(registered.has(cmd), `${cmd} must be registered`).toBe(true)
    }
  })

  it("every allowed custom command exists in Rust", () => {
    const ghosts: string[] = []
    for (const [identifier, commands] of sets) {
      for (const cmd of commands) {
        if (!registered.has(cmd)) ghosts.push(`${identifier}: ${cmd}`)
      }
    }
    expect(ghosts, `allowed but not registered: ${ghosts.join(", ")}`).toEqual([])
  })

  it("the sniffer window's report commands are allowed only there, and registered", () => {
    for (const cmd of snifferInvoked) {
      expect(snifferAllowed.has(cmd), `${cmd} must be allowed on sniffer`).toBe(true)
      expect(registered.has(cmd), `${cmd} must be registered`).toBe(true)
    }
    expect(mainAllowed.has("sniff_report"), "sniff_report must NOT be reachable from main").toBe(false)
    expect(mainAllowed.has("sniff_report_drm"), "sniff_report_drm must NOT be reachable from main").toBe(false)
  })
})
