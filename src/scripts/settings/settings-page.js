// Settings pages shared behaviour (0.11.4 W1).
//
// Extracted verbatim from the inline <script> of src/pages/settings.astro
// (0.11.3, lines 2592-5624) when Settings was split into one page per
// section. The script was already null-safe for a subset of the controls
// (every section is guarded by `?.` / early return), so the same module
// runs unchanged on every settings subpage: only the controls present on
// that page are wired. The old nav/scroll-spy block lived in a separate
// <script> and was deleted with the split — navigation is page-based now,
// so there is no spy left to lie. One deliberate edit: the Network log
// "Include image requests" checkbox became an On/Off pill pair (see
// syncNetLogIncludeImages below).

    import { Store } from "@tauri-apps/plugin-store"
    import { log } from "@/scripts/lib/log.js"
    import { t, LOCALE_EVENT, getActiveLocale, initI18n } from "@/scripts/lib/i18n.js"
    import { LANGUAGE_TOKENS, languageTagLabel } from "@/scripts/lib/language-tags.ts"
    import { ICON_CHECK } from "@/scripts/lib/icons.ts"
    import {
      getActiveEntry,
      getEntries,
      refreshActive,
      isTauri,
      loadCreds,
      addEntry,
    } from "@/scripts/lib/creds.js"
    import {
      getNewestCacheTimeAsync,
      getCacheSizeAsync,
      clearAll as clearAllCache,
      hydrate as hydrateCache,
    } from "@/scripts/lib/cache.js"
    import { clearImageCache } from "@/scripts/lib/img-cache.ts"
    import {
      renderPlaylistRow,
      getPlaylistListEmptyCopy,
    } from "@/scripts/lib/playlist-rows.js"
    import { clearViewingHistory } from "@/scripts/lib/preferences.js"
    import { confirmDialog } from "@/scripts/lib/confirm-dialog.ts"
    import { snifferAvailable } from "@/scripts/lib/stream-sniffer.ts"
    import { fetchReleases, renderMarkdown, filterReleasesForDisplay } from "@/scripts/lib/changelog.ts"
    import {
      checkForUpdate,
      isStoreBuild,
      isPlayStoreInstall,
      getPlayStoreUrl,
      getCurrentAppVersion,
      resolveUpdateFeedUrl,
      withUpdaterRetry,
      isTransientUpdaterError,
      MS_STORE_UPDATES_URL,
    } from "@/scripts/lib/update-check.js"
    import { sandboxRuntimeSync } from "@/scripts/lib/sandbox.ts"
    import {
      getCompositingState,
      setCompositingSetting,
      relaunchApp as relaunchForCompositing,
    } from "@/scripts/lib/compositing.ts"
    import { openExternal } from "@/scripts/lib/external-link.js"
    import { attachDialogSpatialNav } from "@/scripts/lib/dialog-spatial-nav.js"
    import {
      UA_PRESETS,
      getUserAgent,
      setUserAgent,
      getDownloadDir,
      setDownloadDir,
      getDownloadConcurrency,
      setDownloadConcurrency,
      getWriteNfoEnabled,
      setWriteNfoEnabled,
      getPerfMode,
      setPerfMode,
      getUiSoundsEnabled,
      setUiSoundsEnabled,
      getMonoAudioEnabled,
      setMonoAudioEnabled,
      getCaptionsAutoEnabled,
      setCaptionsAutoEnabled,
      getDensity,
      setDensity,
      getProgressRetentionDays,
      setProgressRetentionDays,
      getNetworkTimeoutSeconds,
      setNetworkTimeoutSeconds,
      getUpdateChannel,
      setUpdateChannel,
      getAutoUpdateEnabled,
      setAutoUpdateEnabled,
      getContentLanguage,
      setContentLanguage,
      getLanguageGroupingEnabled,
      setLanguageGroupingEnabled,
      getAudioTranscodeAuto,
      setAudioTranscodeAuto,
      getFfmpegPath,
      setFfmpegPath,
      getDevModeEnabled,
      setDevModeEnabled,
      DEV_MODE_EVENT,
    } from "@/scripts/lib/app-settings.js"
    import { playUiSound } from "@/scripts/lib/ui-sounds.ts"
    import { audioTranscodeStatus } from "@/scripts/lib/audio-proxy.ts"
    import { ensureHevcDecodable, isWindowsDesktop as isWindowsDesktopEnv } from "@/scripts/lib/hevc-extension.ts"
    import { deviceSupportsHevc } from "@/scripts/lib/codec-hints.ts"
    import {
      ensureUserInfo,
      getMaxConnectionsSync,
      getActiveConnectionsSync,
      USER_INFO_LOADED_EVENT,
    } from "@/scripts/lib/account-info.js"
    import { isDownloadable, scanDownloadsFolder } from "@/scripts/lib/downloads.js"
    import {
      getTmdbApiKey,
      setTmdbApiKey,
      getTmdbEnabled,
      setTmdbEnabled,
      getTvdbEnabled,
      setTvdbEnabled,
      getAiEndpoint,
      setAiEndpoint,
      getAiModel,
      setAiModel,
      getAiEnabled,
      setAiEnabled,
    } from "@/scripts/lib/app-settings.js"
    import { validateTmdbKey } from "@/scripts/lib/tmdb.ts"
    import { saveAiKey, deleteAiKey, hasAiKey } from "@/scripts/lib/ai/keystore.ts"
    import {
      getAiStatus,
      testAiConnection,
      aiStatusMessage,
      clearAiTestRecord,
      getAiShareTaste,
      setAiShareTaste,
      getAiAutoRequests,
      setAiAutoRequests,
      getAiProvider,
      setAiProvider,
      AI_MODE_LABELS,
      OPENAI_ENDPOINT,
      OPENAI_KEYS_URL,
    } from "@/scripts/lib/ai/status.ts"
    import { initAI } from "@/scripts/lib/ai/init.ts"
    import { bindExternalLinks } from "@/scripts/lib/external-link.js"
    import { bindBackupRestore } from "@/scripts/lib/restore-backup.js"
    import {
      saveBackupSnapshot,
      loadBackupSnapshot,
      hasBackupSnapshot,
    } from "@/scripts/lib/backup-snapshot.ts"
    import {
      getNetworkLog,
      clearNetworkLog,
      getNetLogIncludeImages,
      setNetLogIncludeImages,
      NET_LOG_EVENT,
    } from "@/scripts/lib/net-log.ts"
    import { fmtAgo } from "@/scripts/lib/playlist-health.ts"
    import { writeClipboardText } from "@/scripts/lib/clipboard.ts"

    bindExternalLinks()
    import { toast, toastSuccess, toastError } from "@/scripts/lib/toast.js"
    import {
      getOffsetSetting,
      setOffsetSetting,
      getProgrammesSync,
    } from "@/scripts/lib/epg-data.js"

    // Linux notice: surface that auto-updates only land on the AppImage
    // build. Shown on any Tauri Linux session - AppImage users will see
    // the line as a confirmation, deb / rpm users as guidance. Skipped in
    // Snap/Flatpak, where the store handles updates instead.
    try {
      const ua = navigator.userAgent || ""
      const isTauriRuntime =
        !!window.__TAURI_INTERNALS__ || !!window.__TAURI__
      const isLinux = ua.includes("Linux") && !ua.includes("Android")
      if (isTauriRuntime && isLinux && !sandboxRuntimeSync()) {
        document.getElementById("linux-appimage-notice")?.removeAttribute("hidden")
      }
    } catch {}

    // A small thank-you for the curious - prints once per session when
    // someone pops the devtools open on Settings.
    try {
      if (!sessionStorage.getItem("xt_console_signed")) {
        sessionStorage.setItem("xt_console_signed", "1")
        const heading = "background: oklch(0.5 0.2 330); color: white; padding: 4px 10px; border-radius: 6px; font-weight: 600;"
        const body = "color: inherit; padding: 4px 0;"
        const link = "color: oklch(0.78 0.15 330); text-decoration: underline;"
        // eslint-disable-next-line no-console
        console.log(
          "%cNylahBox Studios%c  thanks for poking around. %csource & issues -> github.com/infinitel8p/Extreme-InfiniTV",
          heading,
          body,
          link,
        )
      }
    } catch {}

    // -------------------------------------------------------------------
    // What's new: lazy-fetch GitHub releases, render the latest 10 with
    // tag + date, latest expanded by default, others collapsed.
    // -------------------------------------------------------------------
    function loadChangelog() {
      const body = document.getElementById("changelog-body")
      const status = document.getElementById("changelog-status")
      if (!body) return
      Promise.all([fetchReleases(), getCurrentAppVersion()])
        .then(([allReleases, currentVersion]) => {
          const releases = filterReleasesForDisplay(allReleases, currentVersion || "").slice(0, 3)
          if (!releases.length) {
            if (status) {
              status.textContent = t("settings.about.whatsNewEmpty")
              status.removeAttribute("data-i18n")
            }
            return
          }
          if (status) {
            status.textContent = ""
            status.removeAttribute("data-i18n")
          }
          body.replaceChildren()
          const chevronSvg =
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="size-4 shrink-0 changelog-chevron transition-transform duration-200"><path d="M6 9l6 6 6-6"/></svg>'
          for (const release of releases) {
            const details = document.createElement("details")
            details.className =
              "changelog-entry border border-line/60 rounded-xl bg-bg overflow-hidden"

            const summary = document.createElement("summary")
            summary.className =
              "px-4 py-3 cursor-pointer flex items-center gap-3 hover:bg-surface-2 transition-colors list-none"

            const left = document.createElement("div")
            left.className = "flex items-center gap-3 flex-1 min-w-0"

            const tag = document.createElement("span")
            tag.className = "font-medium text-sm tabular-nums truncate"
            tag.textContent = release.name || release.tagName
            left.appendChild(tag)

            if (release.publishedAt) {
              const date = document.createElement("time")
              date.className = "text-xs text-fg-3 shrink-0 tabular-nums"
              date.dateTime = release.publishedAt
              const parsed = new Date(release.publishedAt)
              date.textContent = parsed.toLocaleDateString(undefined, {
                year: "numeric",
                month: "short",
                day: "numeric",
              })
              left.appendChild(date)
            }

            summary.appendChild(left)
            const chevronWrap = document.createElement("span")
            chevronWrap.className = "text-fg-3 shrink-0"
            chevronWrap.innerHTML = chevronSvg
            summary.appendChild(chevronWrap)

            details.appendChild(summary)

            const content = document.createElement("div")
            content.className =
              "changelog-md px-4 py-3 border-t border-line/60 text-sm text-fg-2"
            // marked + DOMPurify are dynamically imported the first time
            // this runs; resolves to the sanitized HTML.
            renderMarkdown(release.body || "").then((html) => {
              content.innerHTML = html
            })
            details.appendChild(content)

            body.appendChild(details)
          }
        })
        .catch(() => {
          if (status) {
            status.textContent = t("settings.about.whatsNewError")
            status.removeAttribute("data-i18n")
          }
        })
    }
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(loadChangelog, { timeout: 2000 })
    } else {
      setTimeout(loadChangelog, 500)
    }

    const playlistsEl = document.getElementById("settings-playlists-list")
    const refreshBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById("settings-refresh-active"))
    const addFromWebsiteBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById("settings-add-from-website"))
    if (snifferAvailable) addFromWebsiteBtn?.classList.remove("hidden")
    addFromWebsiteBtn?.addEventListener("click", async () => {
      const { openAddFromWebsiteDialog } = await import("@/scripts/lib/add-from-website-dialog.ts")
      await openAddFromWebsiteDialog()
    })

    const newCustomPlaylistBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById("settings-new-custom-playlist"))
    const newCustomPlaylistDialog = /** @type {HTMLDialogElement|null} */ (document.getElementById("settings-new-custom-playlist-dialog"))
    const newCustomPlaylistNameInput = /** @type {HTMLInputElement|null} */ (document.getElementById("settings-new-custom-playlist-name"))
    if (newCustomPlaylistDialog) {
      attachDialogSpatialNav(newCustomPlaylistDialog, { defaultElement: "#settings-new-custom-playlist-name" })
    }
    newCustomPlaylistBtn?.addEventListener("click", () => {
      if (!newCustomPlaylistDialog || !newCustomPlaylistNameInput) return
      newCustomPlaylistNameInput.value = ""
      newCustomPlaylistDialog.showModal()
    })
    newCustomPlaylistDialog
      ?.querySelector('[data-role="cancel"]')
      ?.addEventListener("click", () => newCustomPlaylistDialog.close())
    newCustomPlaylistDialog?.querySelector("form")?.addEventListener("submit", async (ev) => {
      ev.preventDefault()
      const title = newCustomPlaylistNameInput?.value.trim() || ""
      newCustomPlaylistDialog?.close()
      try {
        const entry = await addEntry(title ? { type: "custom", title } : { type: "custom" })
        location.href = `/playlist-editor?id=${encodeURIComponent(entry._id)}`
      } catch (e) {
        log.error("[settings:new-custom-playlist] failed:", e)
        toastError(t("editor.newPlaylistCreateFail"))
      }
    })

    const cacheSizeEl = document.getElementById("settings-cache-size")
    const cacheNewestEl = document.getElementById("settings-cache-newest")
    const cacheMsgEl = document.getElementById("settings-cache-msg")
    const clearCacheBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById("settings-clear-cache"))
    const clearHistoryBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById("settings-clear-history"))
    const resetBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById("settings-reset-all"))
    const resetMsgEl = document.getElementById("settings-reset-msg")
    const resetDialog = /** @type {HTMLDialogElement|null} */ (document.getElementById("settings-reset-dialog"))
    if (resetDialog) attachDialogSpatialNav(resetDialog, { defaultElement: "#settings-reset-cancel" })
    const resetCancelBtn = document.getElementById("settings-reset-cancel")
    const resetConfirmBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById("settings-reset-confirm"))
    const restoreLastBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById("settings-restore-last"))
    const restoreLastHelperEl = document.getElementById("settings-restore-last-helper")

    function fmtAge(ts) {
      if (!ts) return "Never"
      const ms = Date.now() - ts
      if (ms < 60_000) return "Just now"
      const m = Math.floor(ms / 60_000)
      if (m < 60) return `${m}m ago`
      const h = Math.floor(m / 60)
      if (h < 24) return `${h}h ago`
      const d = Math.floor(h / 24)
      return `${d}d ago`
    }

    function fmtBytes(n) {
      if (n === 0) return "Empty"
      if (n < 1024) return `${n} B`
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
      return `${(n / (1024 * 1024)).toFixed(1)} MB`
    }

    /** @type {Map<HTMLElement, number>} */
    const msgTimers = new Map()
    function flashMsg(el, text) {
      if (!el) return
      const prev = msgTimers.get(el)
      if (prev) window.clearTimeout(prev)
      el.textContent = text
      el.classList.remove("opacity-0")
      const t = window.setTimeout(() => {
        el.classList.add("opacity-0")
        const t2 = window.setTimeout(() => {
          if (el.textContent === text) el.textContent = ""
          el.classList.remove("opacity-0")
          msgTimers.delete(el)
        }, 320)
        msgTimers.set(el, t2)
      }, 3500)
      msgTimers.set(el, t)
    }

    function setLoading(btn, loading) {
      if (!btn) return
      if (loading) {
        btn.setAttribute("data-loading", "true")
        btn.setAttribute("aria-busy", "true")
        btn.disabled = true
      } else {
        btn.removeAttribute("data-loading")
        btn.removeAttribute("aria-busy")
        btn.disabled = false
      }
    }

    /** @type {WeakMap<HTMLElement, number>} */
    const successTimers = new WeakMap()
    /** Briefly swap a button's leading icon for the project's check-draw
     *  glyph, then restore. Reuses the same vocabulary PlaylistSwitcher
     *  uses when an entry is selected. */
    function flashSuccess(btn) {
      if (!btn) return
      const icon = btn.querySelector(".btn-icon")
      if (!icon) return
      const prev = successTimers.get(btn)
      if (prev) {
        window.clearTimeout(prev)
        const stash = btn.querySelector('[data-icon-stash="1"]')
        if (stash) stash.remove()
      }
      const original = icon.cloneNode(true)
      original.setAttribute("data-icon-stash", "1")
      original.classList.add("hidden")
      btn.insertBefore(original, icon)

      const tmp = document.createElement("span")
      tmp.innerHTML = ICON_CHECK
      const check = tmp.firstElementChild
      if (!check) return
      check.setAttribute("aria-hidden", "true")
      check.classList.add("btn-icon", "check-draw", "text-accent")
      icon.replaceWith(check)

      const timer = window.setTimeout(() => {
        const stash = btn.querySelector('[data-icon-stash="1"]')
        const live = btn.querySelector(".btn-icon:not([data-icon-stash])")
        if (stash && live) {
          stash.classList.remove("hidden")
          stash.removeAttribute("data-icon-stash")
          live.remove()
        }
        successTimers.delete(btn)
      }, 1100)
      successTimers.set(btn, timer)
    }

    let playlistsRenderGeneration = 0

    async function renderPlaylists() {
      if (!playlistsEl) return
      const generation = ++playlistsRenderGeneration
      const [entries, active] = await Promise.all([
        getEntries(),
        getActiveEntry(),
      ])

      if (!entries.length) {
        playlistsEl.innerHTML = `<div class="px-4 py-4 text-xs text-fg-3">${getPlaylistListEmptyCopy()}</div>`
        refreshBtn?.classList.add("hidden")
        return
      }

      const buildRows = () => {
        const frag = document.createDocumentFragment()
        for (const entry of entries) {
          frag.appendChild(
            renderPlaylistRow({
              entry,
              isActive: active?._id === entry._id,
              density: "full",
            })
          )
        }
        playlistsEl.replaceChildren(frag)
      }

      // Rows paint from memory immediately; hydration only refreshes counts.
      buildRows()

      if (active) refreshBtn?.classList.remove("hidden")
      else refreshBtn?.classList.add("hidden")

      void Promise.allSettled(
        entries.flatMap((entry) => [
          hydrateCache(entry._id, "live"),
          hydrateCache(entry._id, "m3u"),
          hydrateCache(entry._id, "vod"),
          hydrateCache(entry._id, "series"),
        ])
      ).then(() => {
        if (generation === playlistsRenderGeneration) buildRows()
      })
    }

    async function syncCache() {
      try {
        const bytes = await getCacheSizeAsync()
        if (cacheSizeEl) cacheSizeEl.textContent = fmtBytes(bytes)
        if (clearCacheBtn) clearCacheBtn.disabled = bytes === 0
      } catch {}
      try {
        const a = await getActiveEntry()
        const newest = a ? await getNewestCacheTimeAsync(a._id) : null
        if (cacheNewestEl) cacheNewestEl.textContent = fmtAge(newest)
      } catch {}
    }

    refreshBtn?.addEventListener("click", async () => {
      setLoading(refreshBtn, true)
      let ok = false
      try {
        await refreshActive()
        ok = true
      } catch (e) {
        toastError(t("settings.toast.refreshFail"), {
          description: (e && e.message) || t("settings.toast.checkConnLogin"),
          duration: 6000,
        })
      } finally {
        setLoading(refreshBtn, false)
        syncCache()
        if (ok) {
          flashSuccess(refreshBtn)
          toastSuccess(t("settings.toast.refreshOk"))
        }
      }
    })

    let cacheTweenRaf = 0
    function tweenBytes(el, from, to, duration) {
      if (!el) return
      if (cacheTweenRaf) cancelAnimationFrame(cacheTweenRaf)
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      if (reduceMotion || duration <= 0) {
        el.textContent = fmtBytes(to)
        return
      }
      const start = performance.now()
      const frame = (now) => {
        const elapsed = now - start
        const progress = Math.min(1, elapsed / duration)
        const eased = progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress)
        const value = Math.round(from + (to - from) * eased)
        el.textContent = fmtBytes(value)
        if (progress < 1) {
          cacheTweenRaf = requestAnimationFrame(frame)
        } else {
          cacheTweenRaf = 0
        }
      }
      cacheTweenRaf = requestAnimationFrame(frame)
    }

    clearCacheBtn?.addEventListener("click", async () => {
      setLoading(clearCacheBtn, true)
      let removed = 0
      let ok = false
      let startBytes = 0
      try {
        startBytes = await getCacheSizeAsync()
      } catch {}
      try {
        removed = await clearAllCache()
        removed += await clearImageCache()
        ok = true
        if (removed > 0) {
          toastSuccess(t("settings.toast.cacheCleared"), {
            description: `${removed} ${removed === 1 ? "entry" : "entries"} removed.`,
          })
        } else {
          flashMsg(cacheMsgEl, "Cache was already empty.")
        }
      } catch {
        toastError(t("settings.toast.cacheClearFail"))
      } finally {
        setLoading(clearCacheBtn, false)
        if (ok && startBytes > 0) {
          tweenBytes(cacheSizeEl, startBytes, 0, 720)
          window.setTimeout(syncCache, 760)
        } else {
          syncCache()
        }
        if (ok && removed > 0) flashSuccess(clearCacheBtn)
      }
    })

    clearHistoryBtn?.addEventListener("click", async () => {
      const confirmed = await confirmDialog({
        title: t("settings.viewingHistory.confirmTitle"),
        message: t("settings.viewingHistory.confirm"),
        confirmLabel: t("settings.viewingHistory.clear"),
        destructive: true,
      })
      if (!confirmed) return
      setLoading(clearHistoryBtn, true)
      try {
        const removed = await clearViewingHistory()
        if (removed > 0) {
          toastSuccess(t("settings.toast.historyCleared"))
          flashSuccess(clearHistoryBtn)
        } else {
          toast({ title: t("settings.toast.historyEmpty") })
        }
      } catch {
        toastError(t("settings.toast.historyClearFail"))
      } finally {
        setLoading(clearHistoryBtn, false)
      }
    })

    const openLogsBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById("settings-open-logs"))
    const shareLogsBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById("settings-share-logs"))
    const isTauriEnv =
      typeof window !== "undefined" && (!!window.__TAURI_INTERNALS__ || !!window.__TAURI__)
    const isAndroidEnv = /Android/i.test(navigator.userAgent || "")
    if (openLogsBtn && isTauriEnv && !isAndroidEnv) {
      openLogsBtn.classList.remove("hidden")
      openLogsBtn.addEventListener("click", async () => {
        let dir = ""
        try {
          const { appLogDir } = await import("@tauri-apps/api/path")
          dir = await appLogDir()
          try {
            const { invoke } = await import("@tauri-apps/api/core")
            dir = await invoke("resolve_explorer_path", { path: dir })
          } catch {}
          const { openPath } = await import("@tauri-apps/plugin-opener")
          await openPath(dir)
        } catch (err) {
          log.warn("[settings] open log folder failed:", err)
          if (dir) {
            try {
              const { writeClipboardText } = await import("@/scripts/lib/clipboard.ts")
              await writeClipboardText(dir)
              flashMsg(cacheMsgEl, t("settings.storage.logPathCopied", { dir }))
              return
            } catch {}
          }
          toastError(t("settings.storage.openLogsFail") || "Couldn't open the log folder.")
        }
      })
    }

    const openAppDataBtn = /** @type {HTMLButtonElement|null} */ (
      document.getElementById("settings-open-appdata")
    )
    if (openAppDataBtn && isTauriEnv && !isAndroidEnv) {
      openAppDataBtn.classList.remove("hidden")
      openAppDataBtn.addEventListener("click", async () => {
        try {
          const { appDataDir } = await import("@tauri-apps/api/path")
          let dir = await appDataDir()
          try {
            const { invoke } = await import("@tauri-apps/api/core")
            dir = await invoke("resolve_explorer_path", { path: dir })
          } catch {}
          const { openPath } = await import("@tauri-apps/plugin-opener")
          await openPath(dir)
        } catch (err) {
          log.warn("[settings] open app data folder failed:", err)
          toastError(
            t("settings.storage.openAppDataFail") || "Couldn't open the app data folder."
          )
        }
      })
    }

    if (shareLogsBtn && isTauriEnv && isAndroidEnv) {
      shareLogsBtn.classList.remove("hidden")
      shareLogsBtn.addEventListener("click", async () => {
        try {
          const { appLogDir } = await import("@tauri-apps/api/path")
          const dir = await appLogDir()
          const bridge = /** @type {any} */ (window).AndroidLog
          const shared =
            typeof bridge?.shareNewestLog === "function" ? bridge.shareNewestLog(dir) : false
          if (!shared) {
            flashMsg(cacheMsgEl, t("settings.storage.noLogs") || "No log file yet.")
          }
        } catch (err) {
          log.warn("[settings] share logs failed:", err)
          toastError(t("settings.storage.shareLogsFail") || "Couldn't share the log file.")
        }
      })
    }

    // -------------------------
    // Backup: export / import
    // -------------------------
    const exportBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById("settings-export"))
    const importBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById("settings-import"))
    const importInput = /** @type {HTMLInputElement|null} */ (document.getElementById("settings-import-input"))
    const backupMsgEl = document.getElementById("settings-backup-msg")

    async function downloadBlobWeb(name, content, mime = "application/json") {
      const blob = new Blob([content], { type: mime })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = name
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 5000)
    }

    exportBtn?.addEventListener("click", async () => {
      setLoading(exportBtn, true)
      try {
        const { exportAll, suggestedFilename } = await import("@/scripts/lib/backup.js")
        const snapshot = await exportAll()
        const json = JSON.stringify(snapshot, null, 2)
        const filename = suggestedFilename()
        let savedTo = ""
        if (isTauri && isAndroid) {
          const androidFs = await import("@/scripts/lib/android-fs.js")
          let pickerError = null
          try {
            const written = await androidFs.saveJsonFile(filename, json)
            if (!written) {
              setLoading(exportBtn, false)
              return
            }
          } catch (e) {
            pickerError = e
            log.warn(
              "[settings:export] SAF save picker failed, falling back to public Download/:",
              e
            )
          }
          if (pickerError) {
            try {
              const publicPath = await androidFs.savePublicJsonFile(filename, json)
              savedTo = publicPath || ""
            } catch (publicErr) {
              log.error("[settings:export] public Download/ save failed:", publicErr)
              toastError(t("settings.toast.backupExportFail"), {
                description:
                  (publicErr && publicErr.message) ||
                  (pickerError && pickerError.message) ||
                  "Android FS is not available.",
                duration: 7000,
              })
              return
            }
          }
        } else if (isTauri) {
          const { save } = await import("@tauri-apps/plugin-dialog")
          const target = await save({
            defaultPath: filename,
            filters: [{ name: "JSON", extensions: ["json"] }],
          })
          if (!target) {
            setLoading(exportBtn, false)
            return
          }
          const { writeTextFile } = await import("@tauri-apps/plugin-fs")
          await writeTextFile(target, json)
          savedTo = target
        } else {
          await downloadBlobWeb(filename, json)
        }
        toastSuccess(t("settings.toast.backupExported"), {
          description: savedTo
            ? `${snapshot.creds.entries.length} playlist(s) - ${savedTo}`
            : `${snapshot.creds.entries.length} playlist(s).`,
          duration: 6000,
        })
        flashMsg(backupMsgEl, "Saved.")
        saveBackupSnapshot()
          .then(refreshRestoreLastVisibility)
          .catch((err) => log.warn("[settings:export] backup snapshot refresh failed:", err))
      } catch (e) {
        log.error("[settings:export] failed:", e)
        toastError(t("settings.toast.backupExportFail"), {
          description: (e && e.message) || "See console.",
        })
      } finally {
        setLoading(exportBtn, false)
      }
    })

    // -------------------------
    // Diagnostics export
    // -------------------------
    const exportDiagnosticsBtn = /** @type {HTMLButtonElement|null} */ (
      document.getElementById("settings-export-diagnostics")
    )
    const exportDiagnosticsMsgEl = document.getElementById("settings-export-diagnostics-msg")

    exportDiagnosticsBtn?.addEventListener("click", async () => {
      setLoading(exportDiagnosticsBtn, true)
      try {
        const { collectDiagnosticBundle } = await import("@/scripts/lib/diagnostic-bundle.js")
        const bundle = await collectDiagnosticBundle()
        let savedTo = ""
        if (isTauriEnv && isAndroidEnv) {
          const androidFs = await import("@/scripts/lib/android-fs.js")
          let pickerError = null
          try {
            const written = await androidFs.saveBinaryFile(bundle.filename, bundle.bytes, "application/zip")
            if (!written) return
            try {
              await androidFs.shareFile(written)
            } catch (shareErr) {
              log.warn("[settings:export-diagnostics] share failed:", shareErr)
            }
          } catch (e) {
            pickerError = e
            log.warn(
              "[settings:export-diagnostics] SAF save picker failed, falling back to public Download/:",
              e
            )
          }
          if (pickerError) {
            try {
              const publicPath = await androidFs.savePublicBinaryFile(
                bundle.filename,
                bundle.bytes,
                "application/zip"
              )
              savedTo = publicPath || ""
            } catch (publicErr) {
              log.error("[settings:export-diagnostics] public Download/ save failed:", publicErr)
              toastError(t("settings.toast.diagnosticsExportFail"), {
                description:
                  (publicErr && publicErr.message) ||
                  (pickerError && pickerError.message) ||
                  "Android FS is not available.",
                duration: 7000,
              })
              return
            }
          }
        } else if (isTauriEnv) {
          const { save } = await import("@tauri-apps/plugin-dialog")
          const target = await save({
            defaultPath: bundle.filename,
            filters: [{ name: "ZIP", extensions: ["zip"] }],
          })
          if (!target) return
          const { writeFile } = await import("@tauri-apps/plugin-fs")
          await writeFile(target, bundle.bytes)
          savedTo = target
        } else {
          await downloadBlobWeb(bundle.filename, bundle.bytes, "application/zip")
        }
        toastSuccess(t("settings.toast.diagnosticsExported"), {
          description: savedTo
            ? `${bundle.fileNames.length} file(s) included - ${savedTo}`
            : `${bundle.fileNames.length} file(s) included.`,
          duration: 6000,
        })
        flashSuccess(exportDiagnosticsBtn)
        flashMsg(exportDiagnosticsMsgEl, "Saved.")
      } catch (e) {
        log.error("[settings:export-diagnostics] failed:", e)
        toastError(t("settings.toast.diagnosticsExportFail"), {
          description: (e && e.message) || "See console.",
        })
      } finally {
        setLoading(exportDiagnosticsBtn, false)
      }
    })

    const importDialog = /** @type {HTMLDialogElement|null} */ (
      document.getElementById("settings-import-dialog")
    )
    const importConfirmBtn = document.getElementById("settings-import-confirm")
    const importCancelBtn = document.getElementById("settings-import-cancel")
    if (importDialog)
      attachDialogSpatialNav(importDialog, { defaultElement: "#settings-import-cancel" })

    function askImportConfirm() {
      return new Promise((resolve) => {
        if (!importDialog) {
          resolve(false)
          return
        }
        const cleanup = () => {
          importConfirmBtn?.removeEventListener("click", onYes)
          importCancelBtn?.removeEventListener("click", onNo)
          importDialog.removeEventListener("close", onClose)
          importDialog.removeEventListener("click", onBackdrop)
        }
        const onYes = () => {
          cleanup()
          importDialog.close?.()
          resolve(true)
        }
        const onNo = () => {
          cleanup()
          importDialog.close?.()
          resolve(false)
        }
        const onClose = () => {
          cleanup()
          resolve(false)
        }
        const onBackdrop = (event) => {
          if (event.target === importDialog) onNo()
        }
        importConfirmBtn?.addEventListener("click", onYes)
        importCancelBtn?.addEventListener("click", onNo)
        importDialog.addEventListener("close", onClose)
        importDialog.addEventListener("click", onBackdrop)
        if (typeof importDialog.showModal === "function") importDialog.showModal()
        else importDialog.setAttribute("open", "")
        requestAnimationFrame(() => {
          window.SpatialNavigation?.makeFocusable?.()
          importCancelBtn?.focus?.()
        })
      })
    }

    bindBackupRestore(importBtn, {
      fileInput: importInput,
      logTag: "settings:import",
      confirm: askImportConfirm,
      successDuration: 6000,
      onRestored: async () => {
        flashMsg(backupMsgEl, "Imported.")
        // Force a hub/sidebar refresh by re-rendering playlists.
        await renderPlaylists()
        syncCache()
      },
    })

    function openResetDialog() {
      if (!resetDialog) return
      if (typeof resetDialog.showModal === "function") resetDialog.showModal()
      else resetDialog.setAttribute("open", "")
      requestAnimationFrame(() => {
        window.SpatialNavigation?.makeFocusable?.()
        resetCancelBtn?.focus?.()
      })
    }

    function closeResetDialog() {
      resetDialog?.close?.()
    }

    resetBtn?.addEventListener("click", openResetDialog)
    resetCancelBtn?.addEventListener("click", closeResetDialog)
    resetDialog?.addEventListener("click", (e) => {
      if (e.target === resetDialog) closeResetDialog()
    })
    resetDialog?.addEventListener("close", () => resetBtn?.focus())

    resetConfirmBtn?.addEventListener("click", async () => {
      if (!resetConfirmBtn) return
      setLoading(resetConfirmBtn, true)
      try {
        try {
          await saveBackupSnapshot()
        } catch (err) {
          log.warn("[settings:reset] backup snapshot failed:", err)
        }
        try { await clearAllCache() } catch {}
        try { localStorage.clear() } catch {}
        try { sessionStorage.clear() } catch {}
        try {
          const all = document.cookie.split(";")
          for (const c of all) {
            const eq = c.indexOf("=")
            const name = (eq > -1 ? c.slice(0, eq) : c).trim()
            if (!name) continue
            document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`
          }
        } catch {}

        if (isTauri) {
          try {
            const store = await Store.load(".xtream.creds.json")
            const keys = await store.keys()
            for (const k of keys) await store.delete(k)
            await store.save()
          } catch (e) {
            log.warn("Tauri store reset failed:", e)
          }
        }

        if (resetMsgEl) {
          resetMsgEl.textContent = "Reset complete. Reloading…"
          resetMsgEl.classList.remove("opacity-0")
        }
        closeResetDialog()
        // Hard reload so module-level caches in stream.js / movies.js / etc.
        // are re-initialised from the now-empty stores.
        setTimeout(() => {
          window.location.href = "/"
        }, 400)
      } finally {
        setLoading(resetConfirmBtn, false)
      }
    })

    async function refreshRestoreLastVisibility() {
      const available = await hasBackupSnapshot()
      if (restoreLastBtn) restoreLastBtn.hidden = !available
      if (restoreLastHelperEl) restoreLastHelperEl.hidden = !available
    }
    refreshRestoreLastVisibility()

    restoreLastBtn?.addEventListener("click", async () => {
      if (!(await askImportConfirm())) return
      setLoading(restoreLastBtn, true)
      try {
        const text = await loadBackupSnapshot()
        if (!text) {
          toastError(t("settings.toast.backupRestoreFail"), {
            description: t("settings.danger.restoreLastMissing"),
          })
          return
        }
        let parsed
        try {
          parsed = JSON.parse(text)
        } catch (parseError) {
          log.warn("[settings:restore-last] backup JSON parse failed:", parseError)
          toastError(t("settings.toast.backupParseFail"), { description: "Not valid JSON." })
          return
        }
        const { importAll } = await import("@/scripts/lib/backup.js")
        const summary = await importAll(parsed)
        toastSuccess(t("settings.toast.backupRestored"), {
          description: `${summary.playlists} playlist(s), ${summary.prefsPlaylists} preference set(s).`,
          duration: 6000,
        })
        flashMsg(backupMsgEl, "Imported.")
        await renderPlaylists()
        syncCache()
      } catch (error) {
        log.error("[settings:restore-last] backup import failed:", error)
        toastError(t("settings.toast.backupRestoreFail"), {
          description: (error && error.message) || "See console.",
        })
      } finally {
        setLoading(restoreLastBtn, false)
      }
    })

    document.addEventListener("xt:active-changed", () => {
      renderPlaylists()
      syncCache()
    })
    document.addEventListener("xt:entries-updated", () => {
      renderPlaylists()
      syncCache()
    })
    document.addEventListener("xt:catalog-warmed", () => {
      renderPlaylists()
      syncCache()
    })

    renderPlaylists()
    syncCache()

    // ---------------------------------------------------------------------
    // Font scale - applied inline in <head> on every page load (see
    // Layout.astro). Here we just expose the picker UI and persist changes.
    // ---------------------------------------------------------------------
    const fontScaleGroup = document.getElementById("settings-font-scale")
    function readFontScale() {
      const s = parseFloat(localStorage.getItem("xt_font_scale") || "1")
      return Number.isFinite(s) && s >= 0.75 && s <= 2 ? s : 1
    }
    /** @type {number | null} */
    let fontScaleAnimTimer = null
    function applyFontScale(s) {
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      const root = document.documentElement
      if (!reduceMotion) {
        root.classList.add("xt-fontscale-animating")
        if (fontScaleAnimTimer !== null) window.clearTimeout(fontScaleAnimTimer)
        fontScaleAnimTimer = window.setTimeout(() => {
          root.classList.remove("xt-fontscale-animating")
          fontScaleAnimTimer = null
        }, 420)
      }
      root.style.setProperty("--xt-font-scale", String(s))
      try {
        if (s === 1) localStorage.removeItem("xt_font_scale")
        else localStorage.setItem("xt_font_scale", String(s))
      } catch {}
      syncFontScaleButtons()
    }
    function syncFontScaleButtons() {
      const current = readFontScale()
      for (const btn of fontScaleGroup?.querySelectorAll(".font-scale-btn") ||
        []) {
        const v = parseFloat(btn.dataset.scale || "1")
        btn.setAttribute("aria-pressed", String(Math.abs(v - current) < 0.001))
      }
    }
    fontScaleGroup?.addEventListener("click", (e) => {
      const t = /** @type {HTMLElement} */ (e.target)
      const btn = t.closest(".font-scale-btn")
      if (!btn) return
      const v = parseFloat(btn.dataset.scale || "1")
      if (!Number.isFinite(v)) return
      applyFontScale(v)
    })
    syncFontScaleButtons()

    // ---------------------------------------------------------------------
    // Density: applied inline in <head> on every page load (see
    // Layout.astro). Here we just expose the picker UI and persist changes.
    // No preview/animation logic - density flips are discrete.
    // ---------------------------------------------------------------------
    const densityGroup = document.getElementById("settings-density")
    function syncDensityButtons() {
      const currentDensity = getDensity()
      for (const densityButton of densityGroup?.querySelectorAll(".density-btn") ||
        []) {
        densityButton.setAttribute(
          "aria-pressed",
          String(densityButton.dataset.density === currentDensity)
        )
      }
    }
    densityGroup?.addEventListener("click", (event) => {
      const clickedElement = /** @type {HTMLElement} */ (event.target)
      const densityButton = clickedElement.closest(".density-btn")
      if (!densityButton) return
      setDensity(densityButton.dataset.density)
      syncDensityButtons()
    })
    syncDensityButtons()

    // ---------------------------------------------------------------------
    // Performance mode: persisted to xt_perf_mode; the inline script in
    // Layout.astro mirrors it to `data-perf-mode` on <html> before paint
    // so the brand-mark + entry animations don't flash on first frame.
    // focus-glide.ts re-attaches/detaches its listeners on
    // `xt:perf-mode-changed`, so toggling here takes effect immediately.
    // ---------------------------------------------------------------------
    const perfModeGroup = document.getElementById("settings-perf-mode")
    function syncPerfModeButtons() {
      const current = getPerfMode()
      for (const btn of perfModeGroup?.querySelectorAll(".perf-mode-btn") || []) {
        const isOn = btn.dataset.perf === "on"
        btn.setAttribute("aria-pressed", String(isOn === current))
      }
    }
    perfModeGroup?.addEventListener("click", (event) => {
      const target = /** @type {HTMLElement} */ (event.target)
      const btn = target.closest(".perf-mode-btn")
      if (!btn) return
      setPerfMode(btn.dataset.perf === "on")
      syncPerfModeButtons()
    })
    syncPerfModeButtons()

    // ---------------------------------------------------------------------
    // Interface sounds
    // ---------------------------------------------------------------------
    const uiSoundsGroup = document.getElementById("settings-ui-sounds")
    function syncUiSoundsButtons() {
      const current = getUiSoundsEnabled()
      for (const btn of uiSoundsGroup?.querySelectorAll(".ui-sounds-btn") || []) {
        const isOn = btn.dataset.sounds === "on"
        btn.setAttribute("aria-pressed", String(isOn === current))
      }
    }
    uiSoundsGroup?.addEventListener("click", (event) => {
      const target = /** @type {HTMLElement} */ (event.target)
      const btn = target.closest(".ui-sounds-btn")
      if (!btn) return
      const next = btn.dataset.sounds === "on"
      setUiSoundsEnabled(next)
      syncUiSoundsButtons()
      if (next) void playUiSound("confirm")
    })
    syncUiSoundsButtons()

    // ---------------------------------------------------------------------
    // Rendering (Linux desktop only): WebKitGTK DMA-BUF safe mode
    // ---------------------------------------------------------------------
    const renderingCard = document.getElementById("card-rendering")
    const renderingStatusEl = document.getElementById("rendering-status")
    const renderingSelectEl = /** @type {HTMLSelectElement|null} */ (
      document.getElementById("rendering-select")
    )
    const renderingEnvOverrideNoteEl = document.getElementById("rendering-env-override-note")
    const renderingRestartNoteEl = document.getElementById("rendering-restart-note")
    const renderingRestartBtn = /** @type {HTMLButtonElement|null} */ (
      document.getElementById("rendering-restart")
    )

    function renderingDetectionLabel(detection) {
      if (detection === "raspberry-pi") return t("settings.rendering.detectionRaspberryPi")
      if (detection === "nvidia") return t("settings.rendering.detectionNvidia")
      if (detection === "vm") return t("settings.rendering.detectionVm")
      return ""
    }

    async function initRenderingCard() {
      const state = await getCompositingState()
      if (!renderingCard || !state?.platformSupported) return
      renderingCard.classList.remove("hidden")

      if (renderingSelectEl) {
        renderingSelectEl.value = state.setting === "fast-trial" ? "fast" : state.setting
      }
      if (renderingStatusEl) {
        const detectionLabel = renderingDetectionLabel(state.detection)
        if (state.active === "safe") {
          renderingStatusEl.textContent = detectionLabel
            ? t("settings.rendering.statusSafeWithDetection", { detection: detectionLabel })
            : t("settings.rendering.statusSafe")
        } else {
          renderingStatusEl.textContent = detectionLabel
            ? t("settings.rendering.statusFastWithDetection", { detection: detectionLabel })
            : t("settings.rendering.statusFast")
        }
      }
      if (state.envOverride) {
        renderingSelectEl?.setAttribute("disabled", "")
        renderingEnvOverrideNoteEl?.removeAttribute("hidden")
      }

      renderingSelectEl?.addEventListener("change", async () => {
        const chosen = renderingSelectEl.value
        const isTrial = chosen === "fast"
        try {
          await setCompositingSetting(isTrial ? "fast-trial" : chosen)
        } catch (err) {
          log.error("Rendering setting update failed:", err)
          return
        }
        if (renderingRestartNoteEl) {
          renderingRestartNoteEl.textContent = isTrial
            ? t("settings.rendering.trialRestartNote")
            : t("settings.rendering.restartNote")
          renderingRestartNoteEl.removeAttribute("hidden")
        }
        renderingRestartBtn?.removeAttribute("hidden")
      })

      renderingRestartBtn?.addEventListener("click", async () => {
        try {
          await relaunchForCompositing()
        } catch (err) {
          log.error("Rendering relaunch failed:", err)
        }
      })
    }
    initRenderingCard()

    // ---------------------------------------------------------------------
    // Mono audio
    // ---------------------------------------------------------------------
    const monoAudioGroup = document.getElementById("settings-mono-audio")
    function syncMonoAudioButtons() {
      const current = getMonoAudioEnabled()
      for (const btn of monoAudioGroup?.querySelectorAll(".mono-audio-btn") || []) {
        const isOn = btn.dataset.mono === "on"
        btn.setAttribute("aria-pressed", String(isOn === current))
      }
    }
    monoAudioGroup?.addEventListener("click", (event) => {
      const target = /** @type {HTMLElement} */ (event.target)
      const btn = target.closest(".mono-audio-btn")
      if (!btn) return
      setMonoAudioEnabled(btn.dataset.mono === "on")
      syncMonoAudioButtons()
    })
    syncMonoAudioButtons()

    // ---------------------------------------------------------------------
    // Captions on by default
    // ---------------------------------------------------------------------
    const captionsAutoGroup = document.getElementById("settings-captions-auto")
    function syncCaptionsAutoButtons() {
      const current = getCaptionsAutoEnabled()
      for (const btn of captionsAutoGroup?.querySelectorAll(".captions-auto-btn") || []) {
        const isOn = btn.dataset.captions === "on"
        btn.setAttribute("aria-pressed", String(isOn === current))
      }
    }
    captionsAutoGroup?.addEventListener("click", (event) => {
      const target = /** @type {HTMLElement} */ (event.target)
      const btn = target.closest(".captions-auto-btn")
      if (!btn) return
      setCaptionsAutoEnabled(btn.dataset.captions === "on")
      syncCaptionsAutoButtons()
    })
    syncCaptionsAutoButtons()

    const langGroupingSelectEl = /** @type {HTMLSelectElement|null} */ (
      document.getElementById("lang-grouping-select")
    )
    if (langGroupingSelectEl) langGroupingSelectEl.value = getLanguageGroupingEnabled() ? "on" : "off"
    langGroupingSelectEl?.addEventListener("change", () => {
      setLanguageGroupingEnabled(langGroupingSelectEl.value === "on")
    })

    const contentLangSelectEl = /** @type {HTMLSelectElement|null} */ (
      document.getElementById("content-lang-select")
    )
    // initI18n() may not have settled yet, so await it before reading locale-dependent labels.
    // Guard against re-entrant runs: a LOCALE_EVENT fired while populating
    // must not start a second populate (a locale change mid-run re-queues
    // one pass instead).
    let contentLangPopulating = false
    let contentLangRepopulateQueued = false
    async function populateContentLangSelect() {
      if (!contentLangSelectEl) return
      if (contentLangPopulating) {
        contentLangRepopulateQueued = true
        return
      }
      contentLangPopulating = true
      try {
        await initI18n()
        contentLangSelectEl.replaceChildren()

      const autoOption = document.createElement("option")
      autoOption.value = ""
      autoOption.textContent = t("settings.contentLang.auto")
      contentLangSelectEl.appendChild(autoOption)

      const activeLocale = getActiveLocale()
      const languageOptions = Object.keys(LANGUAGE_TOKENS)
        .map((tag) => ({ tag, label: languageTagLabel(tag, activeLocale) }))
        .sort((firstOption, secondOption) => firstOption.label.localeCompare(secondOption.label, activeLocale))
      for (const languageOption of languageOptions) {
        const option = document.createElement("option")
        option.value = languageOption.tag
        option.textContent = `${languageOption.label} (${languageOption.tag})`
        contentLangSelectEl.appendChild(option)
      }

      contentLangSelectEl.value = getContentLanguage()
      } finally {
        contentLangPopulating = false
        if (contentLangRepopulateQueued) {
          contentLangRepopulateQueued = false
          void populateContentLangSelect()
        }
      }
    }
    contentLangSelectEl?.addEventListener("change", () => {
      setContentLanguage(contentLangSelectEl.value)
    })
    document.addEventListener(LOCALE_EVENT, populateContentLangSelect)
    populateContentLangSelect()

    // ---------------------------------------------------------------------
    // Audio transcode auto-fix: desktop-only section (visible whether or not
    // ffmpeg is currently resolvable - it's the recovery UI for a missing
    // or broken ffmpeg, so it can't gate on the probe result).
    // ---------------------------------------------------------------------
    const audioTranscodeSection = document.getElementById("audio-transcode-section")
    const audioTranscodeGroup = document.getElementById("settings-audio-transcode-auto")
    const ffmpegStatusEl = document.getElementById("ffmpeg-status")
    const ffmpegPathInput = /** @type {HTMLInputElement|null} */ (document.getElementById("ffmpeg-path-input"))
    const ffmpegBrowseBtn = document.getElementById("ffmpeg-browse-btn")
    const ffmpegTestBtn = document.getElementById("ffmpeg-test-btn")

    function syncAudioTranscodeButtons() {
      const current = getAudioTranscodeAuto()
      for (const btn of audioTranscodeGroup?.querySelectorAll(".audio-transcode-btn") || []) {
        const isOn = btn.dataset.audioTranscode === "on"
        btn.setAttribute("aria-pressed", String(isOn === current))
      }
    }
    audioTranscodeGroup?.addEventListener("click", (event) => {
      const target = /** @type {HTMLElement} */ (event.target)
      const btn = target.closest(".audio-transcode-btn")
      if (!btn) return
      setAudioTranscodeAuto(btn.dataset.audioTranscode === "on")
      syncAudioTranscodeButtons()
    })
    syncAudioTranscodeButtons()

    function ffmpegSourceLabel(source) {
      if (source === "custom") return t("settings.playback.ffmpegSourceCustom") || "custom"
      if (source === "system") return t("settings.playback.ffmpegSourceSystem") || "system"
      return t("settings.playback.ffmpegSourceBundled") || "bundled"
    }

    function stripErrorPrefix(raw) {
      const idx = raw.indexOf(":")
      return idx > 0 ? raw.slice(idx + 1) : raw
    }

    function renderFfmpegStatus(status) {
      const available = !!status?.available
      for (const btn of audioTranscodeGroup?.querySelectorAll(".audio-transcode-btn") || []) {
        btn.disabled = !available
      }
      if (!ffmpegStatusEl) return
      if (available) {
        ffmpegStatusEl.textContent =
          t("settings.playback.ffmpegStatusReady", {
            version: status.version || "",
            source: ffmpegSourceLabel(status.source),
          }) || `Ready (${status.version || "unknown"}, ${ffmpegSourceLabel(status.source)})`
        ffmpegStatusEl.classList.remove("text-bad")
        ffmpegStatusEl.classList.add("text-ok")
      } else {
        const missing = t("settings.playback.ffmpegStatusMissing") || "FFmpeg not found. Install ffmpeg or set a custom path below."
        const detail = status?.customError ? stripErrorPrefix(status.customError) : ""
        ffmpegStatusEl.textContent = detail ? `${missing} (${detail})` : missing
        ffmpegStatusEl.classList.remove("text-ok")
        ffmpegStatusEl.classList.add("text-bad")
      }
    }

    async function refreshFfmpegStatus() {
      renderFfmpegStatus(await audioTranscodeStatus())
    }

    if (isTauriEnv && !isAndroidEnv) {
      audioTranscodeSection?.classList.remove("hidden")
      if (ffmpegPathInput) ffmpegPathInput.value = getFfmpegPath()
      refreshFfmpegStatus()

      let ffmpegPathSaveTimer = null
      function flushFfmpegPath() {
        if (ffmpegPathSaveTimer) {
          window.clearTimeout(ffmpegPathSaveTimer)
          ffmpegPathSaveTimer = null
        }
        if (ffmpegPathInput) setFfmpegPath(ffmpegPathInput.value)
      }

      ffmpegPathInput?.addEventListener("input", () => {
        if (ffmpegPathSaveTimer) window.clearTimeout(ffmpegPathSaveTimer)
        ffmpegPathSaveTimer = window.setTimeout(() => {
          ffmpegPathSaveTimer = null
          if (ffmpegPathInput) setFfmpegPath(ffmpegPathInput.value)
        }, 350)
      })
      ffmpegPathInput?.addEventListener("blur", flushFfmpegPath)

      ffmpegBrowseBtn?.addEventListener("click", async () => {
        try {
          const { open } = await import("@tauri-apps/plugin-dialog")
          const filters = /Win/i.test(navigator.userAgent || "")
            ? [{ name: "Executable", extensions: ["exe"] }]
            : undefined
          const picked = await open({ multiple: false, directory: false, filters })
          if (typeof picked !== "string" || !picked) return
          if (ffmpegPathInput) ffmpegPathInput.value = picked
          flushFfmpegPath()
          await refreshFfmpegStatus()
        } catch (err) {
          log.warn("[settings] ffmpeg browse failed:", err)
          toastError(t("settings.toast.pickFileFail"), {
            description: (err && err.message) || String(err) || "See console.",
          })
        }
      })

      ffmpegTestBtn?.addEventListener("click", async () => {
        flushFfmpegPath()
        await refreshFfmpegStatus()
      })
    }

    const hevcRow = document.getElementById("card-hevc")
    const hevcInstallBtn = document.getElementById("settings-hevc-install")
    const hevcStatus = document.getElementById("settings-hevc-status")
    function renderHevcRow() {
      const hevcSupported = deviceSupportsHevc()
      if (hevcStatus) hevcStatus.textContent = hevcSupported ? (t("settings.playback.hevcSupported") || "Already supported on this device.") : ""
      if (hevcInstallBtn) hevcInstallBtn.classList.toggle("hidden", hevcSupported)
    }
    if (isWindowsDesktopEnv()) {
      hevcRow?.classList.remove("hidden")
      renderHevcRow()
      hevcInstallBtn?.addEventListener("click", async () => {
        hevcInstallBtn.disabled = true
        try {
          await ensureHevcDecodable({ generic: true })
        } finally {
          hevcInstallBtn.disabled = false
        }
        renderHevcRow()
      })
    }

    // ---------------------------------------------------------------------
    // Continue Watching retention: 30 / 90 / 180 days or Never. Read by
    // trimBucket() in preferences.js on every progress save, so flipping
    // here takes effect on the next playback tick - no reload required.
    // ---------------------------------------------------------------------
    const retentionGroup = document.getElementById("settings-progress-retention")
    function syncRetentionButtons() {
      const current = String(getProgressRetentionDays())
      for (const btn of retentionGroup?.querySelectorAll(".retention-btn") || []) {
        btn.setAttribute(
          "aria-pressed",
          String(btn.dataset.retention === current)
        )
      }
    }
    retentionGroup?.addEventListener("click", (event) => {
      const target = /** @type {HTMLElement} */ (event.target)
      const btn = target.closest(".retention-btn")
      if (!btn) return
      setProgressRetentionDays(Number(btn.dataset.retention))
      syncRetentionButtons()
    })
    syncRetentionButtons()

    // ---------------------------------------------------------------------
    // Live TV layout: channel column width.
    // ---------------------------------------------------------------------
    const channelWidthGroup = document.getElementById("settings-channel-width")
    const CHANNEL_WIDTH_DEFAULT = 28
    function readChannelWidth() {
      const raw = parseFloat(localStorage.getItem("xt_channels_w") || "")
      return Number.isFinite(raw) && raw >= 18 && raw <= 60
        ? raw
        : CHANNEL_WIDTH_DEFAULT
    }
    function applyChannelWidth(rem) {
      document.documentElement.style.setProperty("--xt-channels-w", `${rem}rem`)
      try {
        if (rem === CHANNEL_WIDTH_DEFAULT) localStorage.removeItem("xt_channels_w")
        else localStorage.setItem("xt_channels_w", String(rem))
      } catch {}
      syncChannelWidthButtons()
    }
    function syncChannelWidthButtons() {
      const current = readChannelWidth()
      for (const btn of channelWidthGroup?.querySelectorAll(".channel-width-btn") ||
        []) {
        const v = parseFloat(btn.dataset.width || "0")
        btn.setAttribute("aria-pressed", String(Math.abs(v - current) < 0.001))
      }
    }
    channelWidthGroup?.addEventListener("click", (e) => {
      const t = /** @type {HTMLElement} */ (e.target)
      const btn = t.closest(".channel-width-btn")
      if (!btn) return
      const v = parseFloat(btn.dataset.width || "0")
      if (!Number.isFinite(v) || v <= 0) return
      applyChannelWidth(v)
    })
    syncChannelWidthButtons()

    // ---------------------------------------------------------------------
    // EPG time zone offset (per active playlist)
    // ---------------------------------------------------------------------
    const tzSelect = /** @type {HTMLSelectElement|null} */ (
      document.getElementById("epg-tz-select")
    )
    const tzStatus = document.getElementById("epg-tz-status")
    if (tzSelect) {
      tzSelect.replaceChildren()
      const autoOpt = document.createElement("option")
      autoOpt.value = "auto"
      autoOpt.textContent = "Auto-detect"
      tzSelect.appendChild(autoOpt)
      for (let mins = -12 * 60; mins <= 14 * 60; mins += 30) {
        const sign = mins < 0 ? "-" : "+"
        const abs = Math.abs(mins)
        const h = Math.floor(abs / 60)
        const m = abs % 60
        const label = `UTC${sign}${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`
        const opt = document.createElement("option")
        opt.value = String(mins)
        opt.textContent = label
        tzSelect.appendChild(opt)
      }
    }

    let tzActiveId = ""
    async function syncTz() {
      const active = await getActiveEntry()
      if (!tzSelect || !tzStatus) return
      if (!active) {
        tzActiveId = ""
        tzSelect.disabled = true
        tzSelect.value = "auto"
        tzStatus.textContent = "No playlist selected."
        return
      }
      tzActiveId = active._id
      tzSelect.disabled = false
      const setting = getOffsetSetting(active._id)
      tzSelect.value = setting === "auto" ? "auto" : String(setting)
      const state = getProgrammesSync(active._id)
      if (state) {
        const sign = state.offsetMin < 0 ? "-" : "+"
        const abs = Math.abs(state.offsetMin)
        const label = `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`
        tzStatus.textContent = state.offsetIsAuto
          ? `Auto-detected ${label}.`
          : `Using manual ${label}.`
      } else {
        tzStatus.textContent =
          "EPG hasn't been loaded for this playlist yet - open Live TV or the EPG grid first."
      }
    }
    tzSelect?.addEventListener("change", () => {
      if (!tzActiveId) return
      const raw = tzSelect.value
      setOffsetSetting(tzActiveId, raw === "auto" ? "auto" : Number(raw))
      if (tzStatus) tzStatus.textContent = "Saved. Applies next time EPG loads."
    })
    document.addEventListener("xt:active-changed", syncTz)
    document.addEventListener("xt:epg-loaded", syncTz)
    document.addEventListener("xt:epg-offset-changed", syncTz)
    syncTz()

    // ---------------------------------------------------------------------
    // Network / User-Agent
    // ---------------------------------------------------------------------
    const uaPresetEl = /** @type {HTMLSelectElement|null} */ (
      document.getElementById("ua-preset")
    )
    const uaCustomEl = /** @type {HTMLInputElement|null} */ (
      document.getElementById("ua-custom")
    )
    const uaSaveBtn = /** @type {HTMLButtonElement|null} */ (
      document.getElementById("ua-save")
    )
    const uaMsgEl = document.getElementById("ua-msg")

    if (uaPresetEl) {
      for (const p of UA_PRESETS) {
        const opt = document.createElement("option")
        opt.value = p.id
        opt.textContent = p.label
        uaPresetEl.appendChild(opt)
      }
      const opt = document.createElement("option")
      opt.value = "custom"
      opt.textContent = "Custom"
      uaPresetEl.appendChild(opt)

      const current = getUserAgent()
      const matchPreset = UA_PRESETS.find((p) => p.value === current)
      if (current && !matchPreset) {
        uaPresetEl.value = "custom"
        if (uaCustomEl) uaCustomEl.value = current
      } else {
        uaPresetEl.value = matchPreset ? matchPreset.id : "default"
        if (uaCustomEl) uaCustomEl.value = ""
      }
    }

    function readUaFromForm() {
      if (!uaPresetEl) return ""
      const custom = (uaCustomEl?.value || "").trim()
      if (custom) return custom
      if (uaPresetEl.value === "custom") return ""
      const preset = UA_PRESETS.find((p) => p.id === uaPresetEl.value)
      return preset ? preset.value : ""
    }

    uaSaveBtn?.addEventListener("click", () => {
      setUserAgent(readUaFromForm())
      flashMsg(
        uaMsgEl,
        isTauri
          ? "Saved. Reload pages to apply."
          : "Saved. Active in the desktop build only."
      )
      flashSuccess(uaSaveBtn)
    })

    // ---------------------------------------------------------------------
    // Network timeout: how long providerFetch waits before aborting. The
    // setting is read on every fetch, so the change takes effect on the
    // next catalog refresh without a reload.
    // ---------------------------------------------------------------------
    const netTimeoutGroup = document.getElementById("settings-network-timeout")
    function syncNetTimeoutButtons() {
      const current = String(getNetworkTimeoutSeconds())
      for (const btn of netTimeoutGroup?.querySelectorAll(".net-timeout-btn") || []) {
        btn.setAttribute(
          "aria-checked",
          String(btn.dataset.timeout === current)
        )
      }
    }
    netTimeoutGroup?.addEventListener("click", (event) => {
      const target = /** @type {HTMLElement} */ (event.target)
      const btn = target.closest(".net-timeout-btn")
      if (!btn) return
      setNetworkTimeoutSeconds(Number(btn.dataset.timeout))
      syncNetTimeoutButtons()
    })
    syncNetTimeoutButtons()

    // ---------------------------------------------------------------------
    // Developer mode: unlocks the network log card below.
    // ---------------------------------------------------------------------
    const devModeGroup = document.getElementById("settings-dev-mode")
    function syncDevModeButtons() {
      const current = getDevModeEnabled()
      for (const btn of devModeGroup?.querySelectorAll(".dev-mode-btn") || []) {
        btn.setAttribute("aria-checked", String((btn.dataset.dev === "on") === current))
      }
    }
    function applyDevModeVisibility() {
      document.getElementById("card-net-log")?.classList.toggle("hidden", !getDevModeEnabled())
    }
    devModeGroup?.addEventListener("click", (event) => {
      const target = /** @type {HTMLElement} */ (event.target)
      const btn = target.closest(".dev-mode-btn")
      if (!btn) return
      setDevModeEnabled(btn.dataset.dev === "on")
      syncDevModeButtons()
      applyDevModeVisibility()
    })
    document.addEventListener(DEV_MODE_EVENT, () => {
      syncDevModeButtons()
      applyDevModeVisibility()
    })
    syncDevModeButtons()
    applyDevModeVisibility()

    // ---------------------------------------------------------------------
    // Downloads folder
    // ---------------------------------------------------------------------
    const dirInput = /** @type {HTMLInputElement|null} */ (
      document.getElementById("download-dir-input")
    )
    const dirPickBtn = /** @type {HTMLButtonElement|null} */ (
      document.getElementById("download-dir-pick")
    )
    const dirClearBtn = /** @type {HTMLButtonElement|null} */ (
      document.getElementById("download-dir-clear")
    )
    const downloadsAvailEl = document.getElementById("downloads-availability")

    const isAndroid = /Android/i.test(navigator.userAgent || "")

    function prettifyAndroidUri(stored) {
      if (!stored) return ""
      let raw = stored
      try {
        const parsed = JSON.parse(stored)
        if (parsed && typeof parsed.uri === "string") raw = parsed.uri
      } catch {}
      try {
        const u = decodeURIComponent(raw)
        const m = u.match(/document\/(?:tree\/)?([^/]+)$/) ||
                  u.match(/tree\/([^/]+)$/)
        if (m && m[1]) return m[1].replace(/^primary:/, "")
        return u
      } catch {
        return raw
      }
    }

    function syncDir() {
      if (!dirInput) return
      let v = getDownloadDir() || ""
      if (isAndroid && v === "[object Object]") {
        setDownloadDir("")
        v = ""
      }
      if (isAndroid) {
        dirInput.value = v
          ? prettifyAndroidUri(v)
          : "/Download/NylahBox Studios/ (default)"
      } else {
        dirInput.value = v
      }
      if (dirClearBtn) dirClearBtn.disabled = !v
    }
    syncDir()

    if (downloadsAvailEl) {
      downloadsAvailEl.textContent = isDownloadable() ? "" : "Desktop only"
    }
    if (!isDownloadable()) {
      if (dirPickBtn) dirPickBtn.disabled = true
      if (dirClearBtn) dirClearBtn.disabled = true
    }

    const openDownloadsBtn = /** @type {HTMLButtonElement|null} */ (
      document.getElementById("settings-open-downloads")
    )
    if (openDownloadsBtn && isTauriEnv && !isAndroidEnv) {
      openDownloadsBtn.classList.remove("hidden")
      openDownloadsBtn.addEventListener("click", async () => {
        try {
          let dir = getDownloadDir()
          if (!dir) {
            const { downloadDir } = await import("@tauri-apps/api/path")
            dir = await downloadDir()
          }
          const { openPath } = await import("@tauri-apps/plugin-opener")
          await openPath(dir)
        } catch (err) {
          log.warn("[settings] open downloads folder failed:", err)
          toastError(
            t("downloads.action.openFolderFail") || "Couldn't open the downloads folder."
          )
        }
      })
    }

    dirPickBtn?.addEventListener("click", async () => {
      if (!isDownloadable() || !dirPickBtn) return
      setLoading(dirPickBtn, true)
      try {
        if (isAndroid) {
          const { pickDirectory, serializeUri } = await import(
            "@/scripts/lib/android-fs.js"
          )
          const picked = await pickDirectory()
          if (picked) {
            setDownloadDir(serializeUri(picked))
            syncDir()
          }
        } else {
          const { open } = await import("@tauri-apps/plugin-dialog")
          const picked = await open({
            directory: true,
            title: "Choose download folder",
          })
          if (typeof picked === "string" && picked) {
            setDownloadDir(picked)
            syncDir()
          }
        }
      } catch (e) {
        if (e && e.name === "NoDirectoryPickerError") {
          // Nothing to pick with, but the public Downloads folder still works.
          if (dirPickBtn) dirPickBtn.disabled = true
          toast({
            title: t("settings.toast.noFolderPicker"),
            description: t("settings.toast.noFolderPickerHint"),
            duration: 7000,
          })
        } else {
          log.error("Pick folder failed:", e)
          toastError(t("settings.toast.pickFolderFail"), {
            description: (e && e.message) || String(e) || "See console.",
            duration: 7000,
          })
        }
      } finally {
        setLoading(dirPickBtn, false)
      }
    })

    const scanBtn = /** @type {HTMLButtonElement|null} */ (
      document.getElementById("downloads-scan")
    )
    const scanMsgEl = document.getElementById("downloads-scan-msg")
    if (!isDownloadable() || isAndroid) {
      scanBtn?.setAttribute("disabled", "")
      if (scanBtn) {
        scanBtn.classList.add("opacity-50", "cursor-not-allowed")
        scanBtn.title = "Folder scan is desktop-only."
      }
    }
    scanBtn?.addEventListener("click", async () => {
      if (!scanBtn) return
      setLoading(scanBtn, true)
      try {
        const summary = await scanDownloadsFolder()
        if (summary.error) {
          toastError(t("settings.toast.scanFail"), { description: summary.error })
          flashMsg(scanMsgEl, summary.error)
        } else if (summary.imported > 0) {
          toastSuccess(t("settings.toast.imported", { count: summary.imported }), {
            description: `Scanned ${summary.scanned} sidecar${summary.scanned === 1 ? "" : "s"}.`,
          })
          flashMsg(scanMsgEl, `Imported ${summary.imported} item(s).`)
          flashSuccess(scanBtn)
        } else if (summary.scanned === 0) {
          flashMsg(scanMsgEl, "No `.xtmeta.json` sidecars found in this folder.")
        } else {
          flashMsg(
            scanMsgEl,
            `Already up to date. ${summary.skipped} skipped, ${summary.missing} missing media.`
          )
        }
      } catch (error) {
        log.error("[settings:scan] failed:", error)
        toastError(t("settings.toast.scanFail"), {
          description: (error && error.message) || "See console.",
        })
      } finally {
        setLoading(scanBtn, false)
      }
    })

    dirClearBtn?.addEventListener("click", async () => {
      const prev = getDownloadDir()
      if (isAndroid && prev) {
        const { releasePickedDir, deserializeUri } = await import(
          "@/scripts/lib/android-fs.js"
        )
        const uri = deserializeUri(prev)
        if (uri) releasePickedDir(uri).catch(() => {})
      }
      setDownloadDir("")
      syncDir()
    })

    const concurrencyGroup = document.getElementById(
      "settings-download-concurrency"
    )
    const concurrencyCapEl = document.getElementById(
      "settings-download-concurrency-cap"
    )

    function readSelectedPlaylistId() {
      try {
        const active = JSON.parse(
          localStorage.getItem("xt_playlists") || '{"selectedId":""}'
        )
        return active?.selectedId || ""
      } catch {
        return ""
      }
    }
    function readProviderCap() {
      // 0 means "unknown" (M3U source or cache cold). UI falls back to the
      // previous behaviour: all four buttons enabled, no cap message.
      return getMaxConnectionsSync(readSelectedPlaylistId())
    }
    function readActiveCons() {
      return getActiveConnectionsSync(readSelectedPlaylistId())
    }

    function syncConcurrencyButtons() {
      if (!concurrencyGroup) return
      const current = getDownloadConcurrency()
      const cap = readProviderCap()
      for (const btn of concurrencyGroup.querySelectorAll(".dl-concurrency-btn")) {
        const v = parseInt(btn.getAttribute("data-concurrency") || "1", 10)
        btn.setAttribute("aria-pressed", v === current ? "true" : "false")
        const exceedsCap = cap > 0 && v > cap
        btn.disabled = exceedsCap
        btn.classList.toggle("opacity-50", exceedsCap)
        btn.classList.toggle("cursor-not-allowed", exceedsCap)
        btn.title = exceedsCap
          ? `Your provider only allows ${cap} connection${cap === 1 ? "" : "s"}.`
          : ""
      }
      if (concurrencyCapEl) {
        if (cap <= 0) {
          concurrencyCapEl.textContent = ""
        } else {
          const activeCons = readActiveCons()
          const slots = `${cap} connection${cap === 1 ? "" : "s"}`
          concurrencyCapEl.textContent = activeCons > 0
            ? `Provider allows ${slots} (${activeCons} in use).`
            : `Provider allows ${slots}.`
        }
      }
    }
    syncConcurrencyButtons()
    concurrencyGroup?.addEventListener("click", (e) => {
      const btn = /** @type {HTMLElement} */ (e.target).closest(
        ".dl-concurrency-btn"
      )
      if (!btn || btn.disabled) return
      const v = parseInt(btn.getAttribute("data-concurrency") || "1", 10)
      setDownloadConcurrency(v)
      syncConcurrencyButtons()
    })

    const nfoCard = document.getElementById("card-write-nfo")
    if (nfoCard && isTauriEnv && !isAndroidEnv) nfoCard.classList.remove("hidden")

    const writeNfoGroup = document.getElementById("settings-write-nfo")
    function syncWriteNfoButtons() {
      const current = getWriteNfoEnabled()
      for (const btn of writeNfoGroup?.querySelectorAll(".write-nfo-btn") || []) {
        const isOn = btn.dataset.nfo === "on"
        btn.setAttribute("aria-pressed", String(isOn === current))
      }
    }
    writeNfoGroup?.addEventListener("click", (event) => {
      const target = /** @type {HTMLElement} */ (event.target)
      const btn = target.closest(".write-nfo-btn")
      if (!btn) return
      setWriteNfoEnabled(btn.dataset.nfo === "on")
      syncWriteNfoButtons()
    })
    syncWriteNfoButtons()

    // Refresh user_info on every active-playlist change and on Settings load
    // so the cap reflects the current provider, not whatever was warmed last.
    // The connection-limit banner subscribes to USER_INFO_LOADED_EVENT itself
    // (see ConnectionLimitBanner.svelte); we just kick the hydration.
    async function refreshUserInfoForActive() {
      try {
        const active = await getActiveEntry()
        if (!active) {
          syncConcurrencyButtons()
          return
        }
        const creds = await loadCreds()
        await ensureUserInfo(creds, active._id)
        syncConcurrencyButtons()
      } catch {
        syncConcurrencyButtons()
      }
    }
    refreshUserInfoForActive()
    document.addEventListener(USER_INFO_LOADED_EVENT, () => {
      syncConcurrencyButtons()
    })
    document.addEventListener("xt:active-changed", refreshUserInfoForActive)

    const updateSectionEl = document.getElementById("update-section")
    const updatePillEl = document.getElementById("update-pill")
    const updateCurrentEl = document.getElementById("update-current")
    const updateLatestEl = document.getElementById("update-latest")
    const updateNotesEl = document.getElementById("update-notes")
    const updateMsgEl = document.getElementById("update-msg")
    const updateGithubLink = /** @type {HTMLAnchorElement|null} */ (
      document.getElementById("update-github")
    )
    const updateCheckBtn = /** @type {HTMLButtonElement|null} */ (
      document.getElementById("update-check")
    )
    const updateInstallBtn = /** @type {HTMLButtonElement|null} */ (
      document.getElementById("update-install")
    )
    const updateInstallLabelEl = document.getElementById("update-install-label")
    const updateRelaunchBtn = /** @type {HTMLButtonElement|null} */ (
      document.getElementById("update-relaunch")
    )
    const updateGetBtn = /** @type {HTMLButtonElement|null} */ (
      document.getElementById("update-get")
    )
    const updateGetLabelEl = document.getElementById("update-get-label")
    const updateManualOnlyEl = document.getElementById("update-manual-only")
    const updateDegradedEl = document.getElementById("update-degraded")
    const updateProgressWrap = document.getElementById("update-progress-wrap")
    const updateProgressTrack = document.getElementById("update-progress-track")
    const updateProgressBar = document.getElementById("update-progress-bar")
    const updateProgressText = document.getElementById("update-progress-text")
    const updateChannelRowEl = document.getElementById("update-channel-row")
    const updateChannelSelectEl = /** @type {HTMLSelectElement|null} */ (
      document.getElementById("update-channel-select")
    )
    const autoUpdateRowEl = document.getElementById("auto-update-row")
    const autoUpdateSelectEl = /** @type {HTMLSelectElement|null} */ (
      document.getElementById("auto-update-select")
    )

    const GITHUB_RELEASES_URL =
      "https://github.com/ciaranf3308-star/couchhub-tv/releases"

    function setUpdateState(state) {
      if (updateSectionEl) updateSectionEl.setAttribute("data-state", state)
      if (updatePillEl) {
        if (state === "available") {
          updatePillEl.classList.remove("hidden")
          updatePillEl.classList.add("inline-flex")
        } else {
          updatePillEl.classList.add("hidden")
          updatePillEl.classList.remove("inline-flex")
        }
      }
    }

    const isWindowsDesktop =
      isTauri && /Windows/i.test(navigator.userAgent || "")
    const isLinuxDesktop =
      isTauri &&
      /Linux/i.test(navigator.userAgent || "") &&
      !/Android/i.test(navigator.userAgent || "")
    const playStoreInstall = isPlayStoreInstall()
    // Snap/Flatpak: store owns updates, same as MS Store.
    const sandboxed = isLinuxDesktop ? sandboxRuntimeSync() : null
    // Resolved below; checkViaGithub/checkForUpdates close over these.
    let storeBuild = false
    let canUseTauriUpdater = false

    if (updateChannelSelectEl) updateChannelSelectEl.value = getUpdateChannel()
    if (autoUpdateSelectEl) autoUpdateSelectEl.value = getAutoUpdateEnabled() ? "on" : "off"

    if (updateCurrentEl) {
      import("@tauri-apps/api/app")
        .then(({ getVersion }) => getVersion())
        .then((version) => {
          updateCurrentEl.textContent = version
        })
        .catch(() => {
          const tag = document.querySelector(
            'meta[name="x-app-version"]'
          )?.getAttribute("content")
          updateCurrentEl.textContent = tag || "-"
        })
    }

    // 0.11.2 W2 — display diagnostics. The 0.11.1 purple-wash report
    // could not be reproduced from the bundle: the built Settings page
    // renders burgundy headless under every combination tried (default,
    // OS light scheme, couch.css blocked, forced light + violet accent),
    // so the packaged build's LIVE values are surfaced here for a
    // one-photo check on the PC — no devtools needed. Read it as:
    // computed colour scheme, the html background actually painted, the
    // --color-bg token as specified (its hue decides burgundy vs
    // purple), the OS scheme, how many of the 3 linked stylesheets
    // loaded, and the WebView Chrome version.
    function fillDisplayDiagnostics() {
      const el = document.getElementById("update-display-diag")
      if (!el) return
      try {
        const root = document.documentElement
        const cs = getComputedStyle(root)
        const linkSheets = Array.from(document.styleSheets).filter((s) => !!s.href)
        let loaded = 0
        for (const s of linkSheets) {
          try {
            if (s.cssRules) loaded++
          } catch {
            // Blocked/cross-origin sheet: not loaded.
          }
        }
        const ua = navigator.userAgent || ""
        const chrome = (ua.match(/Chrome\/([\d.]+)/) || [])[1] || "?"
        const osScheme = window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        el.textContent =
          `Display: scheme ${cs.colorScheme} · html ${cs.backgroundColor} · bg ${cs.getPropertyValue("--color-bg").trim() || "?"} · OS ${osScheme} · css ${loaded}/${linkSheets.length} · Chrome ${chrome}`
      } catch {
        el.textContent = "Display: unavailable"
      }
    }
    fillDisplayDiagnostics()

    // Off the top-level await chain: a stuck isStoreBuild() IPC must not block this script.
    const updaterConfigReady = (async () => {
      storeBuild = await isStoreBuild()
      const noInAppUpdate = storeBuild || !!sandboxed
      // Linux falls back to the GitHub check below if `check()` throws (non-AppImage installs).
      canUseTauriUpdater = (isWindowsDesktop && !storeBuild) || (isLinuxDesktop && !sandboxed)

      if (noInAppUpdate) updateChannelRowEl?.setAttribute("hidden", "")
      if (!canUseTauriUpdater) autoUpdateRowEl?.setAttribute("hidden", "")

      if (!canUseTauriUpdater) {
        updateManualOnlyEl?.removeAttribute("hidden")
        // data-i18n stays in sync with locale changes; textContent updates it immediately.
        if (updateGetLabelEl && storeBuild) {
          updateGetLabelEl.setAttribute("data-i18n", "settings.update.getFromStore")
          updateGetLabelEl.textContent = t("settings.update.getFromStore")
        } else if (updateGetLabelEl && playStoreInstall) {
          updateGetLabelEl.setAttribute("data-i18n", "settings.update.getFromPlay")
          updateGetLabelEl.textContent = t("settings.update.getFromPlay")
        }
      }

      checkForUpdates()
    })().catch(() => {})

    let pendingUpdate = null
    // "plugin": pendingUpdate is a @tauri-apps/plugin-updater Update object.
    // "invoke": pendingUpdate is the {version, notes, pubDate} payload from updater_check_from (beta channel).
    let updateInstallMode = "plugin"

    let progressFrame = 0
    let queuedProgress = null

    function setProgress(pct, text) {
      if (progressFrame) {
        cancelAnimationFrame(progressFrame)
        progressFrame = 0
        queuedProgress = null
      }
      paintProgress(pct, text)
    }

    // Progress events can arrive far faster than frames; paint at most once per frame.
    function queueProgress(pct, text) {
      queuedProgress = { pct, text }
      if (progressFrame) return
      progressFrame = requestAnimationFrame(() => {
        progressFrame = 0
        if (!queuedProgress) return
        paintProgress(queuedProgress.pct, queuedProgress.text)
        queuedProgress = null
      })
    }

    function paintProgress(pct, text) {
      if (!updateProgressWrap || !updateProgressBar || !updateProgressText) return
      if (pct == null) {
        updateProgressWrap.classList.add("hidden")
        updateProgressWrap.classList.remove("flex")
        return
      }
      updateProgressWrap.classList.remove("hidden")
      updateProgressWrap.classList.add("flex")
      if (pct < 0) {
        updateProgressBar.classList.add("indeterminate")
        updateProgressBar.style.width = "40%"
        updateProgressText.textContent = text || ""
        // Absent aria-valuenow is how ARIA signals an indeterminate progressbar.
        updateProgressTrack?.removeAttribute("aria-valuenow")
        return
      }
      updateProgressBar.classList.remove("indeterminate")
      const clamped = Math.max(0, Math.min(100, pct))
      updateProgressBar.style.width = `${clamped}%`
      updateProgressText.textContent = text || `${clamped.toFixed(0)}%`
      updateProgressTrack?.setAttribute("aria-valuenow", String(Math.round(clamped)))
    }

    function fmtUpdateBytes(n) {
      if (!n) return "0 B"
      if (n < 1024) return `${n} B`
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
      return `${(n / (1024 * 1024)).toFixed(1)} MB`
    }

    function setInstallLabel(text) {
      if (updateInstallLabelEl) updateInstallLabelEl.textContent = text
    }

    let updateGetTarget = GITHUB_RELEASES_URL

    async function checkViaBetaInvoke() {
      const { invoke } = await import("@tauri-apps/api/core")
      const url = await resolveUpdateFeedUrl()
      const update = await invoke("updater_check_from", { url })
      updateInstallMode = "invoke"
      if (!update) {
        pendingUpdate = null
        if (updateLatestEl) updateLatestEl.textContent = t("settings.about.upToDate")
        if (updateMsgEl) updateMsgEl.textContent = t("settings.update.upToDateMsg")
        if (updateGithubLink) {
          updateGithubLink.href = `${GITHUB_RELEASES_URL}/latest`
        }
        setUpdateState("up-to-date")
        return
      }
      pendingUpdate = update
      if (updateLatestEl) {
        updateLatestEl.textContent = update.version
          ? `v${update.version}`
          : t("settings.update.available")
      }
      if (updateNotesEl && update.notes) {
        updateNotesEl.textContent = update.notes
        updateNotesEl.classList.remove("hidden")
      }
      if (updateMsgEl) {
        updateMsgEl.textContent = update.pubDate
          ? t("settings.update.releasedOn", { date: new Date(update.pubDate).toLocaleDateString() })
          : t("settings.update.updateAvailableMsg")
      }
      if (updateGithubLink) {
        updateGithubLink.href = update.version
          ? `${GITHUB_RELEASES_URL}/tag/v${update.version}`
          : `${GITHUB_RELEASES_URL}/latest`
      }
      updateInstallBtn?.removeAttribute("hidden")
      setUpdateState("available")
    }

    async function checkViaTauriUpdater() {
      if (getUpdateChannel() === "beta") {
        await checkViaBetaInvoke()
        return
      }
      updateInstallMode = "plugin"
      const { check } = await import("@tauri-apps/plugin-updater")
      const update = await check()
      if (!update) {
        pendingUpdate = null
        if (updateLatestEl) updateLatestEl.textContent = t("settings.about.upToDate")
        if (updateMsgEl) updateMsgEl.textContent = t("settings.update.upToDateMsg")
        if (updateGithubLink) {
          updateGithubLink.href = `${GITHUB_RELEASES_URL}/latest`
        }
        setUpdateState("up-to-date")
        return
      }
      pendingUpdate = update
      if (updateLatestEl) {
        updateLatestEl.textContent = update.version
          ? `v${update.version}`
          : t("settings.update.available")
      }
      if (updateNotesEl && update.body) {
        updateNotesEl.textContent = update.body
        updateNotesEl.classList.remove("hidden")
      }
      if (updateMsgEl) {
        updateMsgEl.textContent = update.date
          ? t("settings.update.releasedOn", { date: new Date(update.date).toLocaleDateString() })
          : t("settings.update.updateAvailableMsg")
      }
      if (updateGithubLink) {
        updateGithubLink.href = update.version
          ? `${GITHUB_RELEASES_URL}/tag/v${update.version}`
          : `${GITHUB_RELEASES_URL}/latest`
      }
      updateInstallBtn?.removeAttribute("hidden")
      setUpdateState("available")
    }

    async function checkViaGithub() {
      const status = await checkForUpdate()
      if (!status) throw new Error("couldn't reach GitHub")
      if (updateGithubLink) updateGithubLink.href = status.latestUrl
      if (!status.updateAvailable) {
        if (updateLatestEl) updateLatestEl.textContent = t("settings.about.upToDate")
        if (updateMsgEl) updateMsgEl.textContent = t("settings.update.upToDateMsg")
        updateGetBtn?.setAttribute("hidden", "")
        updateDegradedEl?.setAttribute("hidden", "")
        setUpdateState("up-to-date")
        return
      }
      updateGetTarget = storeBuild
        ? MS_STORE_UPDATES_URL
        : playStoreInstall
          ? getPlayStoreUrl()
          : status.latestUrl
      if (updateLatestEl) updateLatestEl.textContent = `v${status.latest}`
      if (updateMsgEl) {
        updateMsgEl.textContent = status.publishedAt
          ? t("settings.update.releasedOn", { date: new Date(status.publishedAt).toLocaleDateString() })
          : t("settings.update.updateAvailableMsg")
      }
      if (updateNotesEl && status.notes) {
        updateNotesEl.textContent = status.notes
        updateNotesEl.classList.remove("hidden")
      }
      // No package-manager deep link to send Snap/Flatpak users to.
      if (sandboxed) updateGetBtn?.setAttribute("hidden", "")
      else updateGetBtn?.removeAttribute("hidden")
      setUpdateState("available")
    }

    async function checkForUpdates() {
      // Give the store-build detection a moment; degrades to the GitHub path if it's still stuck.
      await Promise.race([updaterConfigReady, new Promise((resolve) => setTimeout(resolve, 2000))])
      if (updateMsgEl) updateMsgEl.textContent = t("settings.update.checking")
      setUpdateState("checking")
      updateCheckBtn?.setAttribute("disabled", "")
      updateInstallBtn?.setAttribute("hidden", "")
      updateRelaunchBtn?.setAttribute("hidden", "")
      updateGetBtn?.setAttribute("hidden", "")
      updateDegradedEl?.setAttribute("hidden", "")
      setInstallLabel(t("settings.about.installUpdate"))
      setProgress(null)
      if (updateNotesEl) {
        updateNotesEl.textContent = ""
        updateNotesEl.classList.add("hidden")
      }

      if (canUseTauriUpdater) {
        try {
          await withUpdaterRetry(checkViaTauriUpdater)
          updateCheckBtn?.removeAttribute("disabled")
          return
        } catch (e) {
          log.warn("Tauri update check failed, falling back to GitHub check:", e)
          if (isTransientUpdaterError(e)) updateDegradedEl?.removeAttribute("hidden")
        }
      }

      try {
        await checkViaGithub()
      } catch (e) {
        log.error("Update check failed:", e)
        if (updateMsgEl) {
          updateMsgEl.textContent = t("settings.update.checkFailed", { error: String(e?.message || e) })
        }
        setUpdateState("error")
      } finally {
        updateCheckBtn?.removeAttribute("disabled")
      }
    }

    async function installUpdateViaInvoke() {
      updateInstallBtn?.setAttribute("disabled", "")
      updateCheckBtn?.setAttribute("disabled", "")
      let total = 0
      let received = 0
      let unlisten = null
      setProgress(0, t("settings.update.preparing"))
      try {
        const { listen } = await import("@tauri-apps/api/event")
        const { invoke } = await import("@tauri-apps/api/core")
        unlisten = await listen("xt:updater-progress", (event) => {
          const payload = event.payload
          if (payload.event === "Started") {
            total = payload.data?.contentLength || 0
            setProgress(total ? 0 : -1, total ? `0 / ${fmtUpdateBytes(total)}` : t("settings.update.starting"))
          } else if (payload.event === "Progress") {
            received += payload.data?.chunkLength || 0
            const pct = total ? (received / total) * 100 : -1
            queueProgress(
              pct,
              total
                ? `${fmtUpdateBytes(received)} / ${fmtUpdateBytes(total)}`
                : fmtUpdateBytes(received)
            )
          } else if (payload.event === "Finished") {
            setProgress(100, t("settings.update.installed"))
            if (updateMsgEl) updateMsgEl.textContent = t("settings.update.installedRestart")
            setInstallLabel(t("settings.about.installUpdate"))
            updateRelaunchBtn?.removeAttribute("hidden")
          }
        })
        await invoke("updater_install")
        // Windows exits the process here; the "Finished" event above is the terminal UI state.
      } catch (e) {
        log.error("Update install failed:", e)
        if (updateMsgEl) {
          const message = String(e?.message || e || "").replace(/^OTHER:/, "")
          updateMsgEl.textContent = t("settings.update.downloadFailed", { error: message })
        }
        setProgress(null)
        setInstallLabel(t("settings.update.reDownload"))
        updateInstallBtn?.removeAttribute("disabled")
      } finally {
        if (unlisten) unlisten()
        updateCheckBtn?.removeAttribute("disabled")
      }
    }

    async function installUpdate() {
      if (!pendingUpdate) return
      if (updateInstallMode === "invoke") {
        await installUpdateViaInvoke()
        return
      }
      updateInstallBtn?.setAttribute("disabled", "")
      updateCheckBtn?.setAttribute("disabled", "")
      let total = 0
      let received = 0
      setProgress(0, t("settings.update.preparing"))
      try {
        await pendingUpdate.downloadAndInstall((event) => {
          if (event.event === "Started") {
            total = event.data?.contentLength || 0
            setProgress(total ? 0 : -1, total ? `0 / ${fmtUpdateBytes(total)}` : t("settings.update.starting"))
          } else if (event.event === "Progress") {
            received += event.data?.chunkLength || 0
            const pct = total ? (received / total) * 100 : -1
            queueProgress(
              pct,
              total
                ? `${fmtUpdateBytes(received)} / ${fmtUpdateBytes(total)}`
                : fmtUpdateBytes(received)
            )
          } else if (event.event === "Finished") {
            setProgress(100, t("settings.update.installed"))
          }
        })
        if (updateMsgEl) {
          updateMsgEl.textContent = t("settings.update.installedRestart")
        }
        setInstallLabel(t("settings.about.installUpdate"))
        updateRelaunchBtn?.removeAttribute("hidden")
      } catch (e) {
        log.error("Update install failed:", e)
        if (updateMsgEl) {
          updateMsgEl.textContent = t("settings.update.downloadFailed", { error: String(e?.message || e) })
        }
        setProgress(null)
        setInstallLabel(t("settings.update.reDownload"))
        updateInstallBtn?.removeAttribute("disabled")
      } finally {
        updateCheckBtn?.removeAttribute("disabled")
      }
    }

    async function relaunchApp() {
      try {
        const { relaunch } = await import("@tauri-apps/plugin-process")
        await relaunch()
      } catch (e) {
        log.error("Relaunch failed:", e)
        if (updateMsgEl) {
          updateMsgEl.textContent = `Restart failed - ${String(e?.message || e)}`
        }
      }
    }

    updateCheckBtn?.addEventListener("click", checkForUpdates)
    updateInstallBtn?.addEventListener("click", installUpdate)
    updateRelaunchBtn?.addEventListener("click", relaunchApp)
    updateGetBtn?.addEventListener("click", () => {
      openExternal(updateGetTarget)
    })
    updateChannelSelectEl?.addEventListener("change", () => {
      setUpdateChannel(updateChannelSelectEl.value)
      checkForUpdates()
    })

    autoUpdateSelectEl?.addEventListener("change", () => {
      setAutoUpdateEnabled(autoUpdateSelectEl.value === "on")
    })

    // -------------------------------------------------------------------
    // TMDb metadata enrichment
    // -------------------------------------------------------------------
    const tmdbEnabledGroup = document.getElementById("settings-tmdb-enabled")
    const tmdbKeyInput = /** @type {HTMLInputElement|null} */ (
      document.getElementById("settings-tmdb-key")
    )
    const tmdbRevealBtn = /** @type {HTMLButtonElement|null} */ (
      document.getElementById("settings-tmdb-reveal")
    )
    const tmdbTestBtn = /** @type {HTMLButtonElement|null} */ (
      document.getElementById("settings-tmdb-test")
    )
    const tmdbMsgEl = document.getElementById("settings-tmdb-msg")

    function syncTmdbEnabled() {
      if (!tmdbEnabledGroup) return
      const enabled = getTmdbEnabled()
      for (const btn of tmdbEnabledGroup.querySelectorAll(".tmdb-enabled-btn")) {
        const isOn = btn.getAttribute("data-tmdb") === "on"
        btn.setAttribute("aria-pressed", isOn === enabled ? "true" : "false")
      }
    }
    syncTmdbEnabled()

    tmdbEnabledGroup?.addEventListener("click", (event) => {
      const btn = /** @type {HTMLElement} */ (event.target).closest(".tmdb-enabled-btn")
      if (!btn) return
      setTmdbEnabled(btn.getAttribute("data-tmdb") === "on")
      syncTmdbEnabled()
    })

    const tvdbEnabledGroup = document.getElementById("settings-tvdb-enabled")

    function syncTvdbEnabled() {
      if (!tvdbEnabledGroup) return
      const enabled = getTvdbEnabled()
      for (const btn of tvdbEnabledGroup.querySelectorAll(".tvdb-enabled-btn")) {
        const isOn = btn.getAttribute("data-tvdb") === "on"
        btn.setAttribute("aria-pressed", isOn === enabled ? "true" : "false")
      }
    }
    syncTvdbEnabled()

    tvdbEnabledGroup?.addEventListener("click", (event) => {
      const btn = /** @type {HTMLElement} */ (event.target).closest(".tvdb-enabled-btn")
      if (!btn) return
      setTvdbEnabled(btn.getAttribute("data-tvdb") === "on")
      syncTvdbEnabled()
    })

    function syncTmdbTestDisabled() {
      if (tmdbTestBtn) tmdbTestBtn.disabled = !(tmdbKeyInput?.value || "").trim()
    }

    if (tmdbKeyInput) {
      tmdbKeyInput.value = getTmdbApiKey()
      let tmdbSaveTimer = null
      // A failed write must say so here: setTmdbApiKey returns false when
      // the localStorage write did not land (quota / unavailable profile),
      // which used to fail silently and look like a key lost on restart.
      function saveTmdbKey() {
        if (!setTmdbApiKey(tmdbKeyInput.value)) {
          flashMsg(tmdbMsgEl, t("settings.tmdb.saveFail"))
          return false
        }
        return true
      }
      tmdbKeyInput.addEventListener("input", () => {
        syncTmdbTestDisabled()
        if (tmdbSaveTimer) window.clearTimeout(tmdbSaveTimer)
        tmdbSaveTimer = window.setTimeout(() => {
          saveTmdbKey()
        }, 350)
      })
      tmdbKeyInput.addEventListener("blur", () => {
        if (tmdbSaveTimer) {
          window.clearTimeout(tmdbSaveTimer)
          tmdbSaveTimer = null
        }
        if (tmdbKeyInput.value !== getTmdbApiKey()) saveTmdbKey()
      })
      syncTmdbTestDisabled()
    }

    tmdbRevealBtn?.addEventListener("click", () => {
      if (!tmdbKeyInput) return
      const revealed = tmdbKeyInput.type === "text"
      tmdbKeyInput.type = revealed ? "password" : "text"
      tmdbRevealBtn.setAttribute("aria-label", t(revealed ? "settings.tmdb.reveal" : "settings.tmdb.conceal"))
      tmdbRevealBtn.querySelector('[data-tmdb-reveal-icon="show"]')?.classList.toggle("hidden", !revealed)
      tmdbRevealBtn.querySelector('[data-tmdb-reveal-icon="hide"]')?.classList.toggle("hidden", revealed)
    })

    tmdbTestBtn?.addEventListener("click", async () => {
      // Save the typed key first (mirrors the AI Test button): a key typed
      // moments ago may still be waiting on the 350ms debounce, and a
      // test must never run against a key that failed to save.
      if (tmdbKeyInput && tmdbKeyInput.value !== getTmdbApiKey()) {
        if (!setTmdbApiKey(tmdbKeyInput.value)) {
          flashMsg(tmdbMsgEl, t("settings.tmdb.saveFail"))
          return
        }
      }
      const key = (tmdbKeyInput?.value || getTmdbApiKey() || "").trim()
      setLoading(tmdbTestBtn, true)
      try {
        const result = await validateTmdbKey(key)
        if (result.ok) {
          flashMsg(tmdbMsgEl, t("settings.tmdb.testOk"))
          flashSuccess(tmdbTestBtn)
        } else if (result.status === 401 || result.status === 403 || result.status === 404) {
          flashMsg(tmdbMsgEl, t("settings.tmdb.testFail"))
        } else {
          flashMsg(tmdbMsgEl, t("settings.tmdb.testNetwork"))
        }
      } finally {
        setLoading(tmdbTestBtn, false)
      }
    })

    // -------------------------------------------------------------------
    // AI Discovery (optional) — key lives in the OS credential store,
    // never in localStorage; the field is never filled back from it.
    // Status + verification live in ai/status.ts (C4); this block only
    // wires the card's controls to it.
    // -------------------------------------------------------------------
    const aiEnabledGroup = document.getElementById("settings-ai-enabled")
    const aiEndpointInput = /** @type {HTMLInputElement|null} */ (
      document.getElementById("settings-ai-endpoint")
    )
    const aiModelSelect = /** @type {HTMLSelectElement|null} */ (
      document.getElementById("settings-ai-model")
    )
    const aiModelCustomInput = /** @type {HTMLInputElement|null} */ (
      document.getElementById("settings-ai-model-custom")
    )
    const aiKeyInput = /** @type {HTMLInputElement|null} */ (
      document.getElementById("settings-ai-key")
    )
    const aiRevealBtn = /** @type {HTMLButtonElement|null} */ (
      document.getElementById("settings-ai-reveal")
    )
    const aiClearBtn = /** @type {HTMLButtonElement|null} */ (
      document.getElementById("settings-ai-clear")
    )
    const aiTestBtn = /** @type {HTMLButtonElement|null} */ (
      document.getElementById("settings-ai-test")
    )
    const aiKeyStatusEl = document.getElementById("settings-ai-key-status")
    const aiMsgEl = document.getElementById("settings-ai-msg")
    const aiTestDetailEl = document.getElementById("settings-ai-test-detail")
    const aiStatusEl = document.getElementById("settings-ai-status")
    const aiStatusDetailEl = document.getElementById("settings-ai-status-detail")
    const aiLastTestedEl = document.getElementById("settings-ai-last-tested")
    const aiProviderGroup = document.getElementById("settings-ai-provider")
    const aiShareGroup = document.getElementById("settings-ai-share-taste")
    const aiAutoGroup = document.getElementById("settings-ai-auto")
    const aiKeysLink = /** @type {HTMLAnchorElement|null} */ (
      document.getElementById("settings-ai-keys-link")
    )
    const aiKeysNote = document.getElementById("settings-ai-keys-note")

    /** Refresh the connection-status row from the C4 status model. */
    async function syncAiStatus() {
      if (!aiStatusEl) return
      try {
        const status = await getAiStatus()
        aiStatusEl.textContent = AI_MODE_LABELS[status.mode] ?? status.mode
        if (aiStatusDetailEl) aiStatusDetailEl.textContent = status.detail
        if (aiLastTestedEl) {
          aiLastTestedEl.textContent = status.lastTestedAt
            ? `Last tested ${new Date(status.lastTestedAt).toLocaleString()}.`
            : ""
        }
      } catch {
        aiStatusEl.textContent = "Local recommendations"
        if (aiStatusDetailEl) {
          aiStatusDetailEl.textContent = "AI status couldn't be checked — using local recommendations."
        }
      }
    }
    syncAiStatus()

    function syncAiEnabled() {
      if (!aiEnabledGroup) return
      const enabled = getAiEnabled()
      for (const btn of aiEnabledGroup.querySelectorAll(".ai-enabled-btn")) {
        const isOn = btn.getAttribute("data-ai") === "on"
        btn.setAttribute("aria-pressed", isOn === enabled ? "true" : "false")
      }
    }
    syncAiEnabled()

    aiEnabledGroup?.addEventListener("click", (event) => {
      const btn = /** @type {HTMLElement} */ (event.target).closest(".ai-enabled-btn")
      if (!btn) return
      setAiEnabled(btn.getAttribute("data-ai") === "on")
      syncAiEnabled()
      void syncAiStatus()
    })

    /** Generic segmented-control sync for the On/Off + Manual/Auto rows. */
    function syncSeg(group, attr, current) {
      if (!group) return
      for (const btn of group.querySelectorAll("button")) {
        btn.setAttribute("aria-pressed", btn.getAttribute(attr) === current ? "true" : "false")
      }
    }

    function syncAiProvider() {
      const provider = getAiProvider()
      syncSeg(aiProviderGroup, "data-provider", provider)
      if (aiKeysLink) {
        aiKeysLink.classList.toggle("hidden", provider !== "openai")
        if (provider === "openai") aiKeysLink.href = OPENAI_KEYS_URL
      }
      aiKeysNote?.classList.toggle("hidden", provider === "openai")
    }
    syncAiProvider()

    aiProviderGroup?.addEventListener("click", (event) => {
      const btn = /** @type {HTMLElement} */ (event.target).closest(".ai-provider-btn")
      if (!btn) return
      const provider = btn.getAttribute("data-provider") === "other" ? "other" : "openai"
      setAiProvider(provider)
      if (provider === "openai") {
        setAiEndpoint(OPENAI_ENDPOINT)
        if (aiEndpointInput) aiEndpointInput.value = getAiEndpoint()
      }
      syncAiProvider()
      void syncAiStatus()
    })

    function syncAiShare() {
      syncSeg(aiShareGroup, "data-share", getAiShareTaste() ? "on" : "off")
    }
    syncAiShare()

    aiShareGroup?.addEventListener("click", (event) => {
      const btn = /** @type {HTMLElement} */ (event.target).closest(".ai-share-btn")
      if (!btn) return
      setAiShareTaste(btn.getAttribute("data-share") === "on")
      syncAiShare()
    })

    function syncAiAuto() {
      syncSeg(aiAutoGroup, "data-auto", getAiAutoRequests() ? "auto" : "manual")
    }
    syncAiAuto()

    aiAutoGroup?.addEventListener("click", (event) => {
      const btn = /** @type {HTMLElement} */ (event.target).closest(".ai-auto-btn")
      if (!btn) return
      setAiAutoRequests(btn.getAttribute("data-auto") === "auto")
      syncAiAuto()
    })

    async function syncAiKeyStatus() {
      if (!aiKeyStatusEl) return
      const has = await hasAiKey()
      aiKeyStatusEl.textContent = has ? t("settings.ai.keySaved") : t("settings.ai.keyMissing")
      if (aiClearBtn) aiClearBtn.disabled = !has
    }
    syncAiKeyStatus()

    function bindAiTextInput(input, getter, setter) {
      if (!input) return
      input.value = getter()
      let saveTimer = null
      input.addEventListener("input", () => {
        if (saveTimer) window.clearTimeout(saveTimer)
        saveTimer = window.setTimeout(() => setter(input.value), 350)
      })
      input.addEventListener("blur", () => {
        if (saveTimer) {
          window.clearTimeout(saveTimer)
          saveTimer = null
        }
        if (input.value !== getter()) setter(input.value)
      })
    }
    bindAiTextInput(aiEndpointInput, getAiEndpoint, setAiEndpoint)

    // Model: a select of supported models, with a free-text box for
    // anything else (other providers, newer models).
    function syncAiModel() {
      if (!aiModelSelect) return
      const current = getAiModel()
      const known = [...aiModelSelect.options].some((opt) => opt.value === current)
      if (known && current) {
        aiModelSelect.value = current
        aiModelCustomInput?.classList.add("hidden")
      } else {
        aiModelSelect.value = "custom"
        if (aiModelCustomInput) {
          aiModelCustomInput.classList.remove("hidden")
          aiModelCustomInput.value = current
        }
      }
    }
    syncAiModel()

    aiModelSelect?.addEventListener("change", () => {
      const value = aiModelSelect.value
      if (value === "custom") {
        aiModelCustomInput?.classList.remove("hidden")
        aiModelCustomInput?.focus()
        return
      }
      aiModelCustomInput?.classList.add("hidden")
      setAiModel(value)
      void syncAiStatus()
    })
    bindAiTextInput(aiModelCustomInput, getAiModel, (value) => {
      setAiModel(value)
      void syncAiStatus()
    })

    aiRevealBtn?.addEventListener("click", () => {
      if (!aiKeyInput) return
      const revealed = aiKeyInput.type === "text"
      aiKeyInput.type = revealed ? "password" : "text"
      aiRevealBtn.setAttribute("aria-label", t(revealed ? "settings.ai.reveal" : "settings.ai.conceal"))
      aiRevealBtn.querySelector('[data-ai-reveal-icon="show"]')?.classList.toggle("hidden", !revealed)
      aiRevealBtn.querySelector('[data-ai-reveal-icon="hide"]')?.classList.toggle("hidden", revealed)
    })

    // Save on blur (and on Test): the field is cleared on success so the
    // key is never left sitting in the page, and never read back.
    async function saveTypedAiKey() {
      const typed = (aiKeyInput?.value || "").trim()
      if (!typed) return false
      await saveAiKey(typed)
      aiKeyInput.value = ""
      await initAI()
      await syncAiKeyStatus()
      return true
    }

    // Show a save failure WITH its cause: the keystore error carries a
    // safe detail (Rust error code/message, never the key). The old code
    // showed only the generic "Could not save the key." and dropped the
    // error entirely, which made save-time failures undiagnosable from
    // the UI or the log file.
    function flashAiSaveFailed(error) {
      log.error("[xt:ai] key save failed:", error)
      const base = t(
        error?.kind === "unsupported"
          ? "settings.ai.storageUnavailable"
          : "settings.ai.keySaveFailed"
      )
      flashMsg(aiMsgEl, error?.detail ? `${base} (${error.detail})` : base)
    }

    aiKeyInput?.addEventListener("blur", async () => {
      try {
        if (await saveTypedAiKey()) {
          flashMsg(aiMsgEl, t("settings.ai.keySaved"))
          void syncAiStatus()
        }
      } catch (error) {
        flashAiSaveFailed(error)
      }
    })

    aiClearBtn?.addEventListener("click", async () => {
      await deleteAiKey()
      clearAiTestRecord()
      await initAI()
      await syncAiKeyStatus()
      await syncAiStatus()
      flashMsg(aiMsgEl, t("settings.ai.keyCleared"))
    })

    aiTestBtn?.addEventListener("click", async () => {
      setLoading(aiTestBtn, true)
      try {
        try {
          await saveTypedAiKey()
        } catch (error) {
          flashAiSaveFailed(error)
          return
        }
        // Real verification (C4): endpoint + key + model, via the
        // status model. A stored key alone is not proof AI works.
        const result = await testAiConnection()
        await syncAiStatus()
        if (result.ok) {
          flashMsg(aiMsgEl, t("settings.ai.testOk"))
          if (aiTestDetailEl) {
            aiTestDetailEl.textContent = result.modelVerified
              ? "Endpoint, key and model all verified."
              : "Endpoint and key verified."
          }
          flashSuccess(aiTestBtn)
        } else {
          flashMsg(aiMsgEl, aiStatusMessage(result.error))
          if (aiTestDetailEl) aiTestDetailEl.textContent = ""
        }
      } finally {
        setLoading(aiTestBtn, false)
      }
    })

    // -------------------------------------------------------------------
    // Network log: recent provider requests, dev-mode gated.
    // -------------------------------------------------------------------
    const netLogCard = /** @type {HTMLDetailsElement|null} */ (
      document.getElementById("card-net-log")
    )
    const netLogRowsEl = document.getElementById("net-log-rows")
    const netLogCountEl = document.getElementById("net-log-count")
    const netLogMsgEl = document.getElementById("net-log-msg")
    const netLogKindFilterEl = /** @type {HTMLSelectElement|null} */ (
      document.getElementById("net-log-kind-filter")
    )
    const netLogIncludeImagesGroup = document.getElementById("net-log-include-images")
    const netLogClearBtn = document.getElementById("net-log-clear")
    const netLogCopyBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById("net-log-copy"))

    const NET_LOG_RENDER_CAP = 100
    const NET_LOG_BADGE = "shrink-0 px-2 py-0.5 rounded-full text-2xs font-medium bg-surface-2 text-fg-3 uppercase tracking-wide"

    function netLogTone(entry) {
      if (entry.outcome === "error") return "bad"
      if (entry.status != null && entry.status >= 500) return "bad"
      if (entry.outcome === "aborted") return "warn"
      if (entry.status != null && entry.status >= 400) return "warn"
      if (entry.outcome === "ok" && entry.status != null && entry.status >= 200 && entry.status < 300) return "good"
      return "neutral"
    }

    function netLogRow(entry) {
      const row = document.createElement("div")
      row.className = "flex flex-col gap-1 px-3 py-2 text-2xs"

      const tone = netLogTone(entry)
      const toneClass =
        tone === "good" ? "text-good" : tone === "warn" ? "text-warn" : tone === "bad" ? "text-bad" : "text-fg-2"

      const metaRow = document.createElement("div")
      metaRow.className = "flex flex-wrap items-center gap-2"

      const time = document.createElement("span")
      time.className = "tabular-nums text-fg-3 shrink-0"
      time.textContent = fmtAgo(entry.startedAt)

      const method = document.createElement("span")
      method.className = "font-mono text-fg-3 shrink-0"
      method.textContent = entry.method

      // No HTTP status: show the outcome word, not just a colour, so failure isn't hue-only.
      const status = document.createElement("span")
      status.className = `tabular-nums font-medium shrink-0 ${toneClass}`
      status.textContent = entry.status != null ? String(entry.status) : entry.outcome.toUpperCase()

      const duration = document.createElement("span")
      duration.className = "tabular-nums text-fg-3 shrink-0"
      duration.textContent = `${entry.durationMs}ms`

      const kindBadge = document.createElement("span")
      kindBadge.className = NET_LOG_BADGE
      kindBadge.textContent = entry.kind

      const transportBadge = document.createElement("span")
      transportBadge.className = NET_LOG_BADGE
      transportBadge.textContent = entry.transport

      metaRow.append(time, method, status, duration, kindBadge, transportBadge)
      row.appendChild(metaRow)

      const url = document.createElement("div")
      url.className = "font-mono text-fg-2 break-all"
      url.textContent = entry.url
      row.appendChild(url)

      if (entry.error) {
        const errorLine = document.createElement("div")
        errorLine.className = "text-bad break-all"
        errorLine.textContent = entry.error
        row.appendChild(errorLine)
      }

      return row
    }

    function netLogCardVisible() {
      return !!netLogCard && !netLogCard.classList.contains("hidden") && netLogCard.open
    }

    function repaintNetLog() {
      if (!netLogRowsEl || !netLogCardVisible()) return

      const snapshot = getNetworkLog()
      const kindFilter = netLogKindFilterEl?.value || "all"
      const filtered = kindFilter === "all"
        ? snapshot.entries
        : snapshot.entries.filter((entry) => entry.kind === kindFilter)
      const newestFirst = filtered.slice().reverse().slice(0, NET_LOG_RENDER_CAP)

      netLogRowsEl.replaceChildren()
      if (!newestFirst.length) {
        const empty = document.createElement("div")
        empty.className = "px-4 py-4 text-xs text-fg-3"
        empty.textContent = t("settings.netLog.empty")
        netLogRowsEl.appendChild(empty)
      } else {
        for (const entry of newestFirst) netLogRowsEl.appendChild(netLogRow(entry))
      }

      if (netLogCountEl) {
        const base = t("settings.netLog.count", { count: snapshot.entries.length, capacity: snapshot.capacity })
        netLogCountEl.textContent = snapshot.dropped > 0
          ? `${base} ${t("settings.netLog.droppedCount", { count: snapshot.dropped })}`
          : base
      }
    }

    // NET_LOG_EVENT can fire dozens of times a second during a catalog load;
    // coalesce repaints into one per frame so it doesn't wipe text selection.
    let netLogRepaintFrame = 0
    function scheduleNetLogRepaint() {
      if (netLogRepaintFrame) return
      netLogRepaintFrame = requestAnimationFrame(() => {
        netLogRepaintFrame = 0
        repaintNetLog()
      })
    }

    // 0.11.4 W1 (f): "Include image requests" is an On/Off pill pair like
    // every other boolean on the page — not a checkbox.
    function syncNetLogIncludeImages() {
      if (!netLogIncludeImagesGroup) return
      const enabled = getNetLogIncludeImages()
      for (const btn of netLogIncludeImagesGroup.querySelectorAll(".netlog-images-btn")) {
        btn.setAttribute("aria-pressed", String(btn.getAttribute("data-images") === (enabled ? "on" : "off")))
      }
    }
    syncNetLogIncludeImages()

    netLogCard?.addEventListener("toggle", repaintNetLog)
    netLogKindFilterEl?.addEventListener("change", repaintNetLog)
    netLogIncludeImagesGroup?.addEventListener("click", (event) => {
      const btn = /** @type {HTMLElement} */ (event.target).closest(".netlog-images-btn")
      if (!btn) return
      setNetLogIncludeImages(btn.getAttribute("data-images") === "on")
      syncNetLogIncludeImages()
      repaintNetLog()
    })
    netLogClearBtn?.addEventListener("click", () => {
      clearNetworkLog()
      repaintNetLog()
      flashMsg(netLogMsgEl, t("settings.netLog.cleared"))
    })
    netLogCopyBtn?.addEventListener("click", async () => {
      try {
        await writeClipboardText(JSON.stringify(getNetworkLog(), null, 2))
        toastSuccess(t("settings.netLog.copied"))
        flashSuccess(netLogCopyBtn)
      } catch (copyError) {
        log.warn("[settings] network log copy failed:", copyError)
        toast({ title: t("toast.copyError"), variant: "warn", duration: 2800 })
      }
    })
    document.addEventListener(NET_LOG_EVENT, scheduleNetLogRepaint)
    document.addEventListener(LOCALE_EVENT, repaintNetLog)
    repaintNetLog()