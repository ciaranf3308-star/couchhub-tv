// Sports Corner fix-3 (w1) — LIVE reachability through the real client path.
//
// Gated behind FOOTBALL_DATA_LIVE_TEST=1: this hits the live
// api.football-data.org with a runtime-generated dummy token (32 hex
// chars, never a real key). It runs the REAL football-data.ts module
// in a REAL Chromium, served from the repo's own Astro dev server
// (own port, so it does not depend on the suite's preview server).
//
// What it proves:
// 1. The bug (plain browser): a webview fetch() to the API fails with
//    a CORS TypeError — the preflight answers the fixed
//    `Access-Control-Allow-Origin: http://localhost`, which matches
//    neither the dev origin nor the production Tauri origin
//    (`https://tauri.localhost`). The module reports status "error" /
//    "Failed to fetch", which the UI shows as "couldn't be reached".
// 2. The fix (Tauri transport): with `window.__TAURI_INTERNALS__`
//    present, the module routes through @tauri-apps/plugin-http.
//    The Rust side cannot run in plain Chromium, so the spec stands
//    in for it with a faithful emulation of the plugin's IPC contract
//    (`plugin:http|fetch` / `fetch_send` / `fetch_read_body`) whose
//    Node side executes the EXACT request the plugin would send (same
//    URL, method, headers) as a real HTTPS request to the live API.
//    A dummy token then returns a real HTTP 400
//    ({"message":"Your API token is invalid."}) — an auth response,
//    not a network failure — and the module reports it as a key
//    rejection. That is the reachability proof: the request leaves
//    the machine through the fixed path and the API answers.
//    A real table load still needs the user's real key on his PC;
//    the parse path is covered by the mocked unit tests.
//
// Sandbox egress: this VM reaches the internet through an
// authenticating proxy that drops unauthenticated CONNECTs (no 407),
// so Chromium tunnels via a small local forwarder (below) that adds
// the Proxy-Authorization from the sandbox env, and the egress proxy
// MITMs TLS — hence ignoreHTTPSErrors while the forwarder is in use.
// On a machine without HTTPS_PROXY set, the browser goes direct and
// no cert errors are ignored.
import { test, expect, type Browser, type Page } from "@playwright/test"
import { spawn, type ChildProcess } from "node:child_process"
import {
  createServer,
  connect,
  type Server,
  type Socket,
} from "node:net"
import { randomBytes } from "node:crypto"

const LIVE = process.env.FOOTBALL_DATA_LIVE_TEST === "1"
test.skip(!LIVE, "live API test — run with FOOTBALL_DATA_LIVE_TEST=1")

const DEV_PORT = 4331
let devUrl = `http://localhost:${DEV_PORT}`
const STANDINGS_URL =
  "https://api.football-data.org/v4/competitions/PL/standings"

test.setTimeout(180_000)

function dummyToken(): string {
  return randomBytes(16).toString("hex")
}

let devServer: ChildProcess | null = null
let forwarder: { port: number; close: () => void } | null = null

async function waitForDevServer(url: string): Promise<boolean> {
  const deadline = Date.now() + 90_000
  for (;;) {
    try {
      const res = await fetch(`${url}/`)
      if (res.ok) return true
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

/**
 * Local CONNECT forwarder for the sandbox egress proxy (see header).
 * Returns null when no proxy env is set (browser goes direct).
 */
async function startAuthForwarder(): Promise<{
  port: number
  close: () => void
} | null> {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy
  if (!proxyUrl) return null
  const u = new URL(proxyUrl)
  const auth = Buffer.from(
    `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`,
  ).toString("base64")
  const upstreamHost = u.hostname
  const upstreamPort = Number(u.port) || 3128
  const server: Server = createServer((client) => {
    let head = Buffer.alloc(0)
    let upstream: Socket | null = null
    let established = false
    let upHead = Buffer.alloc(0)
    client.on("data", (chunk: Buffer) => {
      if (established) return
      head = Buffer.concat([head, chunk])
      const idx = head.indexOf("\r\n\r\n")
      if (idx === -1) return
      const headStr = head.slice(0, idx).toString("latin1")
      const firstLine = headStr.split("\r\n")[0]
      const m = firstLine.match(/^CONNECT\s+(\S+)\s+HTTP\/1\.1$/)
      if (!m) {
        client.end("HTTP/1.1 405 Method Not Allowed\r\n\r\n")
        return
      }
      const rest = head.slice(idx + 4)
      upstream = connect(upstreamPort, upstreamHost, () => {
        upstream!.write(
          `CONNECT ${m[1]} HTTP/1.1\r\n` +
            `Host: ${m[1]}\r\n` +
            `Proxy-Authorization: Basic ${auth}\r\n` +
            `Proxy-Connection: keep-alive\r\n\r\n`,
        )
        if (rest.length) upstream!.write(rest)
      })
      upstream.on("data", (d: Buffer) => {
        if (established) return
        upHead = Buffer.concat([upHead, d])
        if (!upHead.includes("\r\n\r\n")) return
        const statusLine = upHead.toString("latin1").split("\r\n")[0]
        if (!statusLine.includes("200")) {
          client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n")
          upstream!.destroy()
          return
        }
        established = true
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
        upstream!.pipe(client)
        client.pipe(upstream!)
      })
      upstream.on("error", () => client.destroy())
      client.on("error", () => upstream?.destroy())
    })
    client.on("error", () => upstream?.destroy())
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  const port =
    typeof address === "object" && address ? address.port : 0
  return { port, close: () => server.close() }
}

test.beforeAll(async (_fixtures, testInfo) => {
  // Playwright hooks take no timeout argument (the 150_000 that used
  // to sit here was silently ignored — the hook ran under the 30s
  // default and a cold astro start timed it out). Set it on testInfo.
  testInfo.setTimeout(150_000)
  forwarder = await startAuthForwarder()
  // Reuse a dev server already running on the default port (local
  // runs); otherwise spawn one on a scratch port. A cold start
  // re-optimizes dependencies and can take well over the default
  // 30s hook timeout, hence the testInfo.setTimeout above.
  const defaultUp = await waitForDevServer("http://localhost:4321")
  if (defaultUp) {
    devUrl = "http://localhost:4321"
    return
  }
  devServer = spawn("./node_modules/.bin/astro", ["dev", "--port", String(DEV_PORT)], {
    cwd: process.cwd(),
    stdio: "ignore",
  })
  devUrl = `http://localhost:${DEV_PORT}`
  const up = await waitForDevServer(devUrl)
  if (!up) throw new Error("Astro dev server did not start")
})

test.afterAll(async () => {
  devServer?.kill("SIGTERM")
  devServer = null
  forwarder?.close()
  forwarder = null
})

function contextOptions() {
  if (!forwarder) return {}
  return {
    proxy: {
      server: `http://127.0.0.1:${forwarder.port}`,
      bypass: "localhost,127.0.0.1",
    },
    // Sandbox egress MITMs TLS (see header); the API responses are
    // still the real ones.
    ignoreHTTPSErrors: true,
  }
}

interface ModuleProbe {
  rawFetch: { ok: boolean; status?: number; name?: string; message?: string }
  validate: { ok: boolean; status?: number }
  table: { status: string; error: string | null; entries: number | null }
  invokeCalls: Array<{
    url: string
    method: string
    headers: Array<[string, string]>
  }> | null
}

async function probeModule(page: Page, token: string): Promise<ModuleProbe> {
  return (await page.evaluate(
    async ({ dummy, standingsUrl }: { dummy: string; standingsUrl: string }) => {
      const out: Record<string, unknown> = {}
      try {
        const r = await fetch(standingsUrl, {
          headers: { "X-Auth-Token": dummy },
        })
        out.rawFetch = { ok: true, status: r.status }
      } catch (e) {
        const err = e as Error
        out.rawFetch = {
          ok: false,
          name: err?.name,
          message: String(err?.message ?? e),
        }
      }
      const fd = await import("/src/scripts/lib/football-data.ts")
      localStorage.setItem("xt_football_data_key", dummy)
      out.validate = await fd.validateFootballDataKey(dummy)
      const table = await fd.getLeagueTable({ forceRefresh: true })
      out.table = {
        status: table.status,
        error: table.error ?? null,
        entries: table.table ? table.table.entries.length : null,
      }
      out.invokeCalls =
        (window as unknown as { __fdInvokeCalls?: unknown })
          .__fdInvokeCalls ?? null
      return out
    },
    { dummy: token, standingsUrl: STANDINGS_URL },
  )) as ModuleProbe
}

/**
 * Stand in for the Tauri Rust side: the real @tauri-apps/plugin-http
 * JS client calls window.__TAURI_INTERNALS__.invoke with these
 * commands; this emulation executes the exact request (same URL,
 * method, headers) as a real HTTPS request from Node and returns
 * the live response through the same chunk protocol (body bytes +
 * trailing 1 = end of stream).
 */
async function installTauriStub(browser: Browser) {
  const context = await browser.newContext(contextOptions())
  await context.exposeFunction(
    "__fdNodeHttp",
    async (clientConfig: {
      method: string
      url: string
      headers: Array<[string, string]>
    }) => {
      const res = await fetch(clientConfig.url, {
        method: clientConfig.method,
        headers: clientConfig.headers,
      })
      const body = [...new Uint8Array(await res.arrayBuffer())]
      const headers: Array<[string, string]> = []
      res.headers.forEach((value, key) => headers.push([key, value]))
      return {
        status: res.status,
        statusText: res.statusText,
        url: res.url,
        headers,
        body,
      }
    },
  )
  await context.addInitScript(() => {
    const calls: Array<{
      url: string
      method: string
      headers: Array<[string, string]>
    }> = []
    const pending = new Map<
      number,
      {
        res: {
          status: number
          statusText: string
          url: string
          headers: Array<[string, string]>
          body: number[]
        }
        read: boolean
      }
    >()
    let nextRid = 1
    ;(window as unknown as { __fdInvokeCalls?: unknown }).__fdInvokeCalls =
      calls
    ;(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ =
      {
        invoke: async (cmd: string, args: Record<string, unknown>) => {
          if (cmd === "plugin:http|fetch") {
            const cc = args.clientConfig as {
              method: string
              url: string
              headers: Array<[string, string]>
            }
            calls.push({ url: cc.url, method: cc.method, headers: cc.headers })
            const rid = nextRid++
            const res = await (
              window as unknown as {
                __fdNodeHttp: (cc: unknown) => Promise<{
                  status: number
                  statusText: string
                  url: string
                  headers: Array<[string, string]>
                  body: number[]
                }>
              }
            ).__fdNodeHttp(cc)
            pending.set(rid, { res, read: false })
            return rid
          }
          if (cmd === "plugin:http|fetch_send") {
            const entry = pending.get(args.rid as number)
            if (!entry) throw new Error("unknown rid")
            const responseRid = nextRid++
            pending.set(responseRid, entry)
            return {
              status: entry.res.status,
              statusText: entry.res.statusText,
              url: entry.res.url,
              headers: entry.res.headers,
              rid: responseRid,
            }
          }
          if (cmd === "plugin:http|fetch_read_body") {
            const entry = pending.get(args.rid as number)
            if (!entry) throw new Error("unknown rid")
            // The real Rust side sends data chunks with a trailing 0
            // and a final empty chunk [1] as the end-of-stream
            // marker; the JS client DISCARDS a chunk whose last byte
            // is 1, so the body must never ride in the same chunk as
            // the terminator.
            if (entry.read) return [1]
            entry.read = true
            if (entry.res.body.length === 0) return [1]
            return [...entry.res.body, 0]
          }
          if (
            cmd === "plugin:http|fetch_cancel" ||
            cmd === "plugin:http|fetch_cancel_body"
          )
            return
          throw new Error(`unexpected invoke ${cmd}`)
        },
      }
  })
  return context
}

test("plain webview fetch cannot reach the API (the reported bug)", async ({
  browser,
}) => {
  const context = await browser.newContext(contextOptions())
  const page = await context.newPage()
  await page.goto(devUrl, { waitUntil: "domcontentloaded" })
  const result = await probeModule(page, dummyToken())
  await context.close()
  // The browser's own fetch is CORS-blocked by the API (preflight
  // ACAO is the fixed `http://localhost`), so the module sees a
  // network TypeError and reports the honest "error" state.
  expect(result.rawFetch.ok).toBe(false)
  expect(result.rawFetch.name).toBe("TypeError")
  expect(result.validate).toEqual({ ok: false })
  expect(result.table.status).toBe("error")
  expect(result.table.error ?? "").toContain("Failed to fetch")
  expect(result.table.entries).toBeNull()
  expect(result.invokeCalls).toBeNull()
})

test("Tauri transport reaches the live API (dummy token gets an auth answer)", async ({
  browser,
}) => {
  const token = dummyToken()
  const context = await installTauriStub(browser)
  const page = await context.newPage()
  await page.goto(devUrl, { waitUntil: "domcontentloaded" })
  const result = await probeModule(page, token)
  await context.close()
  // Sanity: the plain browser path is still CORS-blocked in the same
  // page — the stub only changes the Tauri transport, not the webview.
  expect(result.rawFetch.ok).toBe(false)
  expect(result.rawFetch.name).toBe("TypeError")
  // The fixed path: both module calls went through plugin-http, with
  // the exact standings URL and the dummy token as X-Auth-Token.
  expect(result.invokeCalls).not.toBeNull()
  expect(result.invokeCalls!.length).toBe(2)
  for (const call of result.invokeCalls!) {
    expect(call.url).toBe(STANDINGS_URL)
    expect(call.method).toBe("GET")
    expect(
      call.headers.find(
        ([name]) => name.toLowerCase() === "x-auth-token",
      )?.[1],
    ).toBe(token)
  }
  // The live API answered the dummy token with a real HTTP auth
  // rejection (400 "Your API token is invalid.") — reachability
  // proven, and the module reports it as a key rejection, never as
  // "couldn't be reached".
  expect(result.validate.ok).toBe(false)
  expect(typeof result.validate.status).toBe("number")
  expect(result.validate.status!).toBeGreaterThanOrEqual(400)
  expect(result.validate.status!).toBeLessThan(500)
  expect(result.table.status).toBe("error")
  expect(result.table.error ?? "").toContain("rejected the API key")
})
