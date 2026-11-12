// Settings section index (0.11.4 W1).
//
// Single source of truth for the split Settings: the Settings home list,
// the per-page section nav in SettingsShell, and the cross-page search
// results. One entry per section page; `items` are the headline controls
// on that page so search can point at the right page (and card anchor)
// even from another section. Keywords are lowercase match text, not
// display copy — keep them in sync with the controls when a page changes.

export interface SettingsIndexItem {
  label: string
  keywords: string
  /** Anchor id on the section page, when the item has one. */
  anchor?: string
}

export interface SettingsSectionEntry {
  slug: string
  href: string
  title: string
  titleKey: string
  desc: string
  /** Lowercase keywords for the home search filter. */
  keywords: string
  danger?: boolean
  items: SettingsIndexItem[]
}

export const SETTINGS_SECTIONS: SettingsSectionEntry[] = [
  {
    slug: "playlists",
    href: "/settings/playlists",
    title: "Playlists",
    titleKey: "settings.group.playlists",
    desc: "Add, refresh and switch playlists",
    keywords: "playlists add refresh switch m3u xtream custom website login",
    items: [
      { label: "Playlists", keywords: "playlist list switch active", anchor: "settings-playlists" },
      { label: "Add playlist", keywords: "add playlist login xtream m3u", anchor: "settings-playlists" },
      { label: "Refresh active", keywords: "refresh active reload playlist", anchor: "settings-playlists" },
      { label: "Add from website", keywords: "add website url import playlist", anchor: "settings-playlists" },
      { label: "New custom playlist", keywords: "new custom playlist create", anchor: "settings-playlists" },
    ],
  },
  {
    slug: "profile",
    href: "/settings/profile",
    title: "Profile",
    titleKey: "settings.group.profile",
    desc: "Who is watching",
    keywords: "profile who watching switcher user account",
    items: [{ label: "Profile", keywords: "profile switcher who watching", anchor: "settings-profile" }],
  },
  {
    slug: "display",
    href: "/settings/display",
    title: "Display",
    titleKey: "settings.section.display",
    desc: "Language, text size, sounds and home sections",
    keywords: "display language font scale density text size tv safe area overscan performance mode interface sounds close to tray home page sections rendering linux",
    items: [
      { label: "Language", keywords: "language locale translate", anchor: "card-language" },
      { label: "Font scale", keywords: "font scale text size large small", anchor: "card-display" },
      { label: "Density", keywords: "density spacing compact cozy comfortable", anchor: "card-display" },
      { label: "Performance mode", keywords: "performance mode animations smooth", anchor: "card-perf-mode" },
      { label: "Interface sounds", keywords: "interface sounds chime ticks", anchor: "card-ui-sounds" },
      { label: "TV safe area", keywords: "tv safe area overscan inset edges", anchor: "card-tv-overscan" },
      { label: "Close to tray", keywords: "close tray quit minimise hide", anchor: "card-display" },
      { label: "Rendering", keywords: "rendering linux safe mode webkit", anchor: "card-rendering" },
      { label: "Home page sections", keywords: "home page sections strips order", anchor: "card-hub-strips" },
    ],
  },
  {
    slug: "playback",
    href: "/settings/playback",
    title: "Playback",
    titleKey: "settings.playback.title",
    desc: "Players, audio, captions and continue watching",
    keywords: "playback player audio captions subtitles hevc ffmpeg transcode mono language continue watching retention",
    items: [
      { label: "Player", keywords: "player picker external mpv vlc", anchor: "playback-section" },
      { label: "Fix unsupported audio automatically", keywords: "fix unsupported audio transcode ffmpeg", anchor: "audio-transcode-section" },
      { label: "HEVC video", keywords: "hevc h265 video extension install", anchor: "card-hevc" },
      { label: "Preferred audio language", keywords: "preferred audio language content", anchor: "card-content-language" },
      { label: "Group language variants", keywords: "group language variants channels", anchor: "card-lang-grouping" },
      { label: "Resume last channel", keywords: "resume last channel reopen start", anchor: "card-resume-last-channel" },
      { label: "Captions on by default", keywords: "captions subtitles default", anchor: "card-captions-auto" },
      { label: "Continue watching", keywords: "continue watching retention keep paused", anchor: "card-progress-retention" },
    ],
  },
  {
    slug: "live-tv",
    href: "/settings/live-tv",
    title: "Live TV",
    titleKey: "nav.livetv",
    desc: "Channels, EPG, categories and favourites",
    keywords: "live tv channels epg time zone column width categories hidden channel edits favorites reorder resume last channel",
    items: [
      { label: "Resume last channel", keywords: "resume last channel reopen start", anchor: "card-resume-last-channel-livetv" },
      { label: "Channel column width", keywords: "channel column width layout", anchor: "card-livetv-layout" },
      { label: "EPG time zone", keywords: "epg time zone offset", anchor: "epg-tz-section" },
      { label: "Categories", keywords: "categories hidden hide", anchor: "card-categories" },
      { label: "Channel edits", keywords: "channel edits rename logo number", anchor: "card-channel-overrides" },
      { label: "Favorites", keywords: "favorites reorder order", anchor: "card-favorites" },
    ],
  },
  {
    slug: "followed",
    href: "/settings/followed",
    title: "Followed Series",
    titleKey: "settings.followed.title",
    desc: "New-episode checks and notifications",
    keywords: "followed series new episodes scheduled checks interval notifications",
    items: [
      { label: "Scheduled background checks", keywords: "scheduled background checks task", anchor: "card-followed" },
      { label: "Check every", keywords: "check interval hours", anchor: "card-followed" },
      { label: "Check now", keywords: "status check now manual", anchor: "card-followed" },
    ],
  },
  {
    slug: "discover-ai",
    href: "/settings/discover-ai",
    title: "Discover & AI",
    titleKey: "",
    desc: "Recommendations, metadata and AI",
    keywords: "discover ai recommendations metadata tmdb tvdb enrichment api key endpoint model test connection",
    items: [
      { label: "Metadata enrichment", keywords: "metadata enrichment tmdb tvdb api key", anchor: "card-tmdb" },
      { label: "AI Discovery", keywords: "ai discovery endpoint model key test", anchor: "card-ai-discovery" },
      { label: "Test connection", keywords: "test connection ai", anchor: "card-ai-discovery" },
    ],
  },
  {
    slug: "casting",
    href: "/settings/casting",
    title: "Casting",
    titleKey: "settings.casting.title",
    desc: "Cast to this TV and play on other TVs",
    keywords: "casting cast receiver pair code device play on tv paired",
    items: [
      { label: "Allow casting to this device", keywords: "allow casting receiver", anchor: "card-tv-receiver" },
      { label: "Device name", keywords: "device name receiver", anchor: "card-tv-receiver" },
      { label: "Pair code", keywords: "pair code pairing", anchor: "card-tv-receiver" },
      { label: "Paired devices", keywords: "paired devices", anchor: "card-tv-receiver" },
      { label: "Play on TV", keywords: "play on tv paired cast", anchor: "card-play-on-tv" },
    ],
  },
  {
    slug: "data-backup",
    href: "/settings/data-backup",
    title: "Data & Backup",
    titleKey: "",
    desc: "Downloads, backup and storage",
    keywords: "data backup restore downloads folder storage cache clear history export import",
    items: [
      { label: "Downloads", keywords: "downloads folder save scan concurrent", anchor: "downloads-folder-section" },
      { label: "Backup", keywords: "backup export import restore file", anchor: "card-backup" },
      { label: "Storage", keywords: "storage cache clear size logs", anchor: "card-storage" },
    ],
  },
  {
    slug: "app-updates",
    href: "/settings/app-updates",
    title: "App & Updates",
    titleKey: "",
    desc: "Version, update channel and what's new",
    keywords: "app update version channel auto update whats new changelog licenses attribution display diagnostics",
    items: [
      { label: "App update", keywords: "app update version check install channel", anchor: "update-section" },
      { label: "What's new", keywords: "whats new changelog releases", anchor: "changelog-section" },
      { label: "Licenses and attribution", keywords: "licenses attribution ffmpeg tmdb fonts", anchor: "licenses-section" },
    ],
  },
  {
    slug: "help-diagnostics",
    href: "/settings/help-diagnostics",
    title: "Help & Diagnostics",
    titleKey: "",
    desc: "Docs, feedback and network log",
    keywords: "help diagnostics docs feedback bug report network log user agent timeout developer mode export",
    items: [
      { label: "Network", keywords: "network user agent timeout developer mode", anchor: "card-network" },
      { label: "Network log", keywords: "network log requests images copy json", anchor: "card-net-log" },
      { label: "Read the docs", keywords: "docs read quick start guide", anchor: "card-docs" },
      { label: "Send feedback", keywords: "feedback bug report github discord export diagnostics", anchor: "card-feedback" },
    ],
  },
  {
    slug: "danger",
    href: "/settings/danger",
    title: "Danger zone",
    titleKey: "settings.group.dangerZone",
    desc: "Reset everything",
    keywords: "danger zone reset everything restore wipe",
    danger: true,
    items: [
      { label: "Reset everything", keywords: "reset everything wipe restore", anchor: "settings-danger" },
    ],
  },
]

export interface SettingsSearchHit {
  label: string
  sectionTitle: string
  href: string
}

/** Flat cross-page hits for a query (AND over whitespace tokens). */
export function searchSettingsIndex(query: string, limit = 8): SettingsSearchHit[] {
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return []
  const hits: SettingsSearchHit[] = []
  for (const section of SETTINGS_SECTIONS) {
    for (const item of section.items) {
      const hay = `${section.title} ${section.keywords} ${item.label} ${item.keywords}`.toLowerCase()
      if (!tokens.every((t) => hay.includes(t))) continue
      hits.push({
        label: item.label,
        sectionTitle: section.title,
        href: item.anchor ? `${section.href}#${item.anchor}` : section.href,
      })
      if (hits.length >= limit) return hits
    }
  }
  return hits
}
