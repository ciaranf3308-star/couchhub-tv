// Live TV sports classifier (0.11.12 W1).
//
// Deterministic title parsing for the sports-aware artwork hierarchy in
// livetv-enrichment.ts. It answers one narrow question — "does this EPG
// title describe a sporting programme, and if so which sport?" — so the
// hierarchy can skip blind TMDb searches for fixtures and fall back to
// verified sports art or a generic sport photograph instead of a blank tile.
//
// Honesty rules (do not weaken):
// - Positive evidence only. A title is sport only when the TITLE carries
//   a fixture pattern, a known competition/league indicator, or a sport
//   keyword. Channel name and provider category are supporting evidence:
//   they can raise a weak title signal from low to medium, but they can
//   never create a sport classification on their own. A film shown on a
//   sports channel stays non-sport.
// - No guessed identities. Team aliases map title text to SPORT evidence
//   only; `teams` always carries the sides exactly as written in the
//   title ("Man Utd", never expanded to "Manchester United"), and
//   `competition` is set only from a matched indicator or an explicit
//   "Sport: Event" label. Nothing here invents synopses, scores, or
//   kick-off times, and EPG titles are never rewritten.
// - Ambiguity degrades, never guesses. A bare "World Cup", "US Open" or
//   "United v Sunderland" keeps sport null / medium confidence, and the
//   hierarchy still tries exact TMDb art first for anything below high
//   confidence — so "Kramer vs Kramer" and "Alien vs Predator" resolve
//   to their films, never to sport art.
//
// The SportId union is the contract W2's artwork manifest keys against:
// manifest entries MUST use these ids verbatim.

export type SportId =
  | "football"
  | "ice-hockey"
  | "snooker"
  | "rugby"
  | "motorsport"
  | "darts"
  | "tennis"
  | "golf"
  | "cricket"
  | "basketball"
  | "american-football"
  | "baseball"
  | "boxing"
  | "mma"
  | "cycling"
  | "athletics"
  | "other-sport"

export interface SportsClassification {
  isSport: boolean
  sport: SportId | null
  kind: "fixture" | "tournament" | "league-broadcast" | "general-sport" | "non-sport"
  teams?: [string, string]
  competition?: string
  confidence: "high" | "medium" | "low"
}

const NON_SPORT: SportsClassification = {
  isSport: false,
  sport: null,
  kind: "non-sport",
  confidence: "low",
}

// ---------------------------------------------------------------------------
// Evidence tables
// ---------------------------------------------------------------------------

interface CompetitionAlias {
  pattern: RegExp
  sport: SportId | null
  competition: string
  kindHint: "tournament" | "league-broadcast" | null
}

/** Strong indicators: a match is high-confidence sport evidence. */
const COMPETITION_ALIASES: CompetitionAlias[] = [
  // Football.
  { pattern: /\benglish\s+premier\s+league\b/i, sport: "football", competition: "Premier League", kindHint: "league-broadcast" },
  { pattern: /\bpremier\s+league\b/i, sport: "football", competition: "Premier League", kindHint: "league-broadcast" },
  { pattern: /\bchampions\s+league\b/i, sport: "football", competition: "Champions League", kindHint: "tournament" },
  { pattern: /\beuropa\s+league\b/i, sport: "football", competition: "Europa League", kindHint: "tournament" },
  { pattern: /\bconference\s+league\b/i, sport: "football", competition: "Conference League", kindHint: "tournament" },
  { pattern: /\bfa\s+cup\b/i, sport: "football", competition: "FA Cup", kindHint: "tournament" },
  { pattern: /\bcarabao\s+cup\b/i, sport: "football", competition: "Carabao Cup", kindHint: "tournament" },
  { pattern: /\bleague\s+cup\b/i, sport: "football", competition: "League Cup", kindHint: "tournament" },
  { pattern: /\bcopa\s+del\s+rey\b/i, sport: "football", competition: "Copa del Rey", kindHint: "tournament" },
  { pattern: /\bcoppa\s+italia\b/i, sport: "football", competition: "Coppa Italia", kindHint: "tournament" },
  { pattern: /\bdfb[\s-]?pokal\b/i, sport: "football", competition: "DFB-Pokal", kindHint: "tournament" },
  { pattern: /\bserie\s+a\b/i, sport: "football", competition: "Serie A", kindHint: "league-broadcast" },
  { pattern: /\bla\s+liga\b/i, sport: "football", competition: "La Liga", kindHint: "league-broadcast" },
  { pattern: /\bbundesliga\b/i, sport: "football", competition: "Bundesliga", kindHint: "league-broadcast" },
  { pattern: /\bligue\s+1\b/i, sport: "football", competition: "Ligue 1", kindHint: "league-broadcast" },
  { pattern: /\bscottish\s+premiership\b/i, sport: "football", competition: "Scottish Premiership", kindHint: "league-broadcast" },
  { pattern: /\beredivisie\b/i, sport: "football", competition: "Eredivisie", kindHint: "league-broadcast" },
  { pattern: /\bprimeira\s+liga\b/i, sport: "football", competition: "Primeira Liga", kindHint: "league-broadcast" },
  { pattern: /\befl\b/i, sport: "football", competition: "EFL", kindHint: "league-broadcast" },
  { pattern: /\bfifa\s+world\s+cup\b/i, sport: "football", competition: "FIFA World Cup", kindHint: "tournament" },
  { pattern: /\bcopa\s+am[eé]rica\b/i, sport: "football", competition: "Copa America", kindHint: "tournament" },
  { pattern: /\bafrica\s+cup\s+of\s+nations\b/i, sport: "football", competition: "Africa Cup of Nations", kindHint: "tournament" },
  { pattern: /\bnations\s+league\b/i, sport: "football", competition: "Nations League", kindHint: "tournament" },
  // A bare World Cup is certainly sport, but the sport is unknown without
  // a sport keyword (football, rugby and cricket all have one).
  { pattern: /\bworld\s+cup\b/i, sport: null, competition: "World Cup", kindHint: "tournament" },
  // Ice hockey.
  { pattern: /\bnhl\b/i, sport: "ice-hockey", competition: "NHL", kindHint: "league-broadcast" },
  { pattern: /\bstanley\s+cup\b/i, sport: "ice-hockey", competition: "Stanley Cup", kindHint: "tournament" },
  // Snooker.
  { pattern: /\bworld\s+snooker\s+championship\b/i, sport: "snooker", competition: "World Snooker Championship", kindHint: "tournament" },
  // Rugby.
  { pattern: /\bsix\s+nations\b/i, sport: "rugby", competition: "Six Nations", kindHint: "tournament" },
  { pattern: /\bunited\s+rugby\s+championship\b/i, sport: "rugby", competition: "United Rugby Championship", kindHint: "league-broadcast" },
  { pattern: /\burc\b/i, sport: "rugby", competition: "United Rugby Championship", kindHint: "league-broadcast" },
  { pattern: /\bpremiership\s+rugby\b/i, sport: "rugby", competition: "Premiership Rugby", kindHint: "league-broadcast" },
  { pattern: /\bsuper\s+rugby\b/i, sport: "rugby", competition: "Super Rugby", kindHint: "league-broadcast" },
  { pattern: /\btop\s+14\b/i, sport: "rugby", competition: "Top 14", kindHint: "league-broadcast" },
  { pattern: /\brugby\s+world\s+cup\b/i, sport: "rugby", competition: "Rugby World Cup", kindHint: "tournament" },
  { pattern: /\bautumn\s+nations\b/i, sport: "rugby", competition: "Autumn Nations Series", kindHint: "tournament" },
  { pattern: /\bautumn\s+internationals\b/i, sport: "rugby", competition: "Autumn Internationals", kindHint: "tournament" },
  { pattern: /\bbritish\s+(?:&|and)\s+irish\s+lions\b/i, sport: "rugby", competition: "British & Irish Lions", kindHint: "tournament" },
  { pattern: /\bnrl\b/i, sport: "rugby", competition: "NRL", kindHint: "league-broadcast" },
  { pattern: /\bsuper\s+league\b/i, sport: "rugby", competition: "Super League", kindHint: "league-broadcast" },
  { pattern: /\bchallenge\s+cup\b/i, sport: "rugby", competition: "Challenge Cup", kindHint: "tournament" },
  // Motorsport.
  { pattern: /\bformula\s+(?:1|one)\b/i, sport: "motorsport", competition: "Formula 1", kindHint: "league-broadcast" },
  { pattern: /\bf1\b/i, sport: "motorsport", competition: "Formula 1", kindHint: "league-broadcast" },
  { pattern: /\bmoto\s?gp\b/i, sport: "motorsport", competition: "MotoGP", kindHint: "league-broadcast" },
  { pattern: /\bnascar\b/i, sport: "motorsport", competition: "NASCAR", kindHint: "league-broadcast" },
  { pattern: /\bindycar\b/i, sport: "motorsport", competition: "IndyCar", kindHint: "league-broadcast" },
  { pattern: /\bworld\s+rally\s+championship\b/i, sport: "motorsport", competition: "World Rally Championship", kindHint: null },
  { pattern: /\bwrc\b/i, sport: "motorsport", competition: "World Rally Championship", kindHint: null },
  { pattern: /\bformula\s+e\b/i, sport: "motorsport", competition: "Formula E", kindHint: "league-broadcast" },
  { pattern: /\ble\s+mans\b/i, sport: "motorsport", competition: "24 Hours of Le Mans", kindHint: "tournament" },
  { pattern: /\bindy\s+500\b/i, sport: "motorsport", competition: "Indianapolis 500", kindHint: "tournament" },
  { pattern: /\bworld\s+superbikes?\b/i, sport: "motorsport", competition: "World Superbikes", kindHint: "league-broadcast" },
  { pattern: /\bwsbk\b/i, sport: "motorsport", competition: "World Superbikes", kindHint: "league-broadcast" },
  { pattern: /\bbritish\s+superbikes?\b/i, sport: "motorsport", competition: "British Superbikes", kindHint: "league-broadcast" },
  // Darts. Full phrases first in match-length terms: the longest match
  // wins, so "Premier League Darts" beats the football "Premier League".
  { pattern: /\bpdc\s+world\s+darts\s+championship\b/i, sport: "darts", competition: "PDC World Darts Championship", kindHint: "tournament" },
  { pattern: /\bworld\s+darts\s+championship\b/i, sport: "darts", competition: "World Darts Championship", kindHint: "tournament" },
  { pattern: /\bpremier\s+league\s+darts\b/i, sport: "darts", competition: "Premier League Darts", kindHint: "league-broadcast" },
  { pattern: /\bworld\s+matchplay\b/i, sport: "darts", competition: "World Matchplay", kindHint: "tournament" },
  { pattern: /\bpdc\b/i, sport: "darts", competition: "PDC", kindHint: "league-broadcast" },
  // Tennis.
  { pattern: /\bwimbledon\b/i, sport: "tennis", competition: "Wimbledon", kindHint: "tournament" },
  { pattern: /\batp\b/i, sport: "tennis", competition: "ATP", kindHint: "league-broadcast" },
  { pattern: /\bwta\b/i, sport: "tennis", competition: "WTA", kindHint: "league-broadcast" },
  { pattern: /\baustralian\s+open\b/i, sport: "tennis", competition: "Australian Open", kindHint: "tournament" },
  { pattern: /\bfrench\s+open\b/i, sport: "tennis", competition: "French Open", kindHint: "tournament" },
  { pattern: /\broland\s+garros\b/i, sport: "tennis", competition: "Roland Garros", kindHint: "tournament" },
  { pattern: /\bdavis\s+cup\b/i, sport: "tennis", competition: "Davis Cup", kindHint: "tournament" },
  { pattern: /\bbillie\s+jean\s+king\s+cup\b/i, sport: "tennis", competition: "Billie Jean King Cup", kindHint: "tournament" },
  // Golf.
  { pattern: /\bpga\b/i, sport: "golf", competition: "PGA", kindHint: "league-broadcast" },
  { pattern: /\bdp\s+world\s+tour\b/i, sport: "golf", competition: "DP World Tour", kindHint: "league-broadcast" },
  { pattern: /\beuropean\s+tour\b/i, sport: "golf", competition: "European Tour", kindHint: "league-broadcast" },
  { pattern: /\bthe\s+open\s+championship\b/i, sport: "golf", competition: "The Open Championship", kindHint: "tournament" },
  { pattern: /\bryder\s+cup\b/i, sport: "golf", competition: "Ryder Cup", kindHint: "tournament" },
  { pattern: /\bpresidents\s+cup\b/i, sport: "golf", competition: "Presidents Cup", kindHint: "tournament" },
  { pattern: /\bliv\s+golf\b/i, sport: "golf", competition: "LIV Golf", kindHint: "league-broadcast" },
  // Cricket.
  { pattern: /\bthe\s+ashes\b/i, sport: "cricket", competition: "The Ashes", kindHint: "tournament" },
  { pattern: /\bindian\s+premier\s+league\b/i, sport: "cricket", competition: "Indian Premier League", kindHint: "league-broadcast" },
  { pattern: /\bipl\b/i, sport: "cricket", competition: "Indian Premier League", kindHint: "league-broadcast" },
  { pattern: /\bt20\s+world\s+cup\b/i, sport: "cricket", competition: "T20 World Cup", kindHint: "tournament" },
  { pattern: /\bcricket\s+world\s+cup\b/i, sport: "cricket", competition: "Cricket World Cup", kindHint: "tournament" },
  { pattern: /\bthe\s+hundred\b/i, sport: "cricket", competition: "The Hundred", kindHint: "league-broadcast" },
  { pattern: /\bcounty\s+championship\b/i, sport: "cricket", competition: "County Championship", kindHint: "league-broadcast" },
  { pattern: /\bbig\s+bash\b/i, sport: "cricket", competition: "Big Bash League", kindHint: "league-broadcast" },
  // Basketball.
  { pattern: /\bnba\b/i, sport: "basketball", competition: "NBA", kindHint: "league-broadcast" },
  { pattern: /\bwnba\b/i, sport: "basketball", competition: "WNBA", kindHint: "league-broadcast" },
  { pattern: /\beuroleague\b/i, sport: "basketball", competition: "EuroLeague", kindHint: "league-broadcast" },
  { pattern: /\beuro\s+league\b/i, sport: "basketball", competition: "EuroLeague", kindHint: "league-broadcast" },
  { pattern: /\bfiba\b/i, sport: "basketball", competition: "FIBA", kindHint: "league-broadcast" },
  { pattern: /\bmarch\s+madness\b/i, sport: "basketball", competition: "March Madness", kindHint: "tournament" },
  // American football.
  { pattern: /\bnfl\b/i, sport: "american-football", competition: "NFL", kindHint: "league-broadcast" },
  { pattern: /\bsuper\s+bowl\b/i, sport: "american-football", competition: "Super Bowl", kindHint: "tournament" },
  // Baseball.
  { pattern: /\bmlb\b/i, sport: "baseball", competition: "MLB", kindHint: "league-broadcast" },
  { pattern: /\bworld\s+series\b/i, sport: "baseball", competition: "World Series", kindHint: "tournament" },
  { pattern: /\bmajor\s+league\s+baseball\b/i, sport: "baseball", competition: "Major League Baseball", kindHint: "league-broadcast" },
  // MMA.
  { pattern: /\bufc\b/i, sport: "mma", competition: "UFC", kindHint: "league-broadcast" },
  { pattern: /\bbellator\b/i, sport: "mma", competition: "Bellator", kindHint: "league-broadcast" },
  { pattern: /\bcage\s+warriors\b/i, sport: "mma", competition: "Cage Warriors", kindHint: "league-broadcast" },
  { pattern: /\bone\s+championship\b/i, sport: "mma", competition: "ONE Championship", kindHint: "league-broadcast" },
  // Cycling.
  { pattern: /\btour\s+de\s+france\b/i, sport: "cycling", competition: "Tour de France", kindHint: "tournament" },
  { pattern: /\bgiro\s+d['’]italia\b/i, sport: "cycling", competition: "Giro d'Italia", kindHint: "tournament" },
  { pattern: /\bvuelta\s+a\s+espa[nñ]a\b/i, sport: "cycling", competition: "Vuelta a España", kindHint: "tournament" },
  { pattern: /\bla\s+vuelta\b/i, sport: "cycling", competition: "Vuelta a España", kindHint: "tournament" },
  // Athletics.
  { pattern: /\bdiamond\s+league\b/i, sport: "athletics", competition: "Diamond League", kindHint: "league-broadcast" },
  { pattern: /\bworld\s+athletics\s+championships\b/i, sport: "athletics", competition: "World Athletics Championships", kindHint: "tournament" },
  // Other sport (multi-sport events, GAA, horse racing).
  { pattern: /\ball[\s-]ireland\b/i, sport: "other-sport", competition: "All-Ireland Championship", kindHint: "tournament" },
  { pattern: /\bgaa\b/i, sport: "other-sport", competition: "GAA", kindHint: "league-broadcast" },
  { pattern: /\bcheltenham\s+festival\b/i, sport: "other-sport", competition: "Cheltenham Festival", kindHint: "tournament" },
  { pattern: /\bgrand\s+national\b/i, sport: "other-sport", competition: "Grand National", kindHint: "tournament" },
  { pattern: /\bcommonwealth\s+games\b/i, sport: "other-sport", competition: "Commonwealth Games", kindHint: "tournament" },
  { pattern: /\bwinter\s+olympics\b/i, sport: "other-sport", competition: "Winter Olympics", kindHint: "tournament" },
  { pattern: /\bolympic\s+games\b/i, sport: "other-sport", competition: "Olympic Games", kindHint: "tournament" },
  { pattern: /\bolympics\b/i, sport: "other-sport", competition: "Olympic Games", kindHint: "tournament" },
]

interface WeakIndicator {
  pattern: RegExp
  sport: SportId | null
  competition?: string
}

/** Ambiguous phrases: sport evidence, but never high confidence alone. An
 *  explicit sport keyword elsewhere in the title always beats these. */
const WEAK_INDICATORS: WeakIndicator[] = [
  { pattern: /\bgrand\s+prix\b/i, sport: "motorsport" },
  { pattern: /\bgrand\s+slam\b/i, sport: "tennis" },
  { pattern: /\bthe\s+masters\b/i, sport: "golf" },
  { pattern: /\bthe\s+open\b/i, sport: "golf" },
  { pattern: /\bus\s+open\b/i, sport: null, competition: "US Open" },
  { pattern: /\bfight\s+night\b/i, sport: null },
]

interface SportKeyword {
  pattern: RegExp
  sport: SportId
  weight: number
}

/** Explicit sport words. Multi-word phrases are matched with span
 *  suppression, so "gaelic football" wins over the "football" inside it
 *  and "ice hockey" wins over bare "hockey". Bare "hockey" maps to
 *  other-sport: without an NHL/team signal it may be field hockey. */
const SPORT_KEYWORDS: SportKeyword[] = [
  { pattern: /\bice\s+hockey\b/i, sport: "ice-hockey", weight: 2 },
  { pattern: /\bfield\s+hockey\b/i, sport: "other-sport", weight: 2 },
  { pattern: /\bamerican\s+football\b/i, sport: "american-football", weight: 2 },
  { pattern: /\bgaelic\s+football\b/i, sport: "other-sport", weight: 2 },
  { pattern: /\bmixed\s+martial\s+arts\b/i, sport: "mma", weight: 2 },
  { pattern: /\bhorse\s+racing\b/i, sport: "other-sport", weight: 2 },
  { pattern: /\btable\s+tennis\b/i, sport: "other-sport", weight: 2 },
  { pattern: /\bmotor\s+sport\b/i, sport: "motorsport", weight: 2 },
  { pattern: /\bfootball\b/i, sport: "football", weight: 2 },
  { pattern: /\bsoccer\b/i, sport: "football", weight: 2 },
  { pattern: /\bsnooker\b/i, sport: "snooker", weight: 2 },
  { pattern: /\bdarts\b/i, sport: "darts", weight: 2 },
  { pattern: /\btennis\b/i, sport: "tennis", weight: 2 },
  { pattern: /\bgolf\b/i, sport: "golf", weight: 2 },
  { pattern: /\bcricket\b/i, sport: "cricket", weight: 2 },
  { pattern: /\brugby\b/i, sport: "rugby", weight: 2 },
  { pattern: /\bboxing\b/i, sport: "boxing", weight: 2 },
  { pattern: /\bbasketball\b/i, sport: "basketball", weight: 2 },
  { pattern: /\bbaseball\b/i, sport: "baseball", weight: 2 },
  { pattern: /\bcycling\b/i, sport: "cycling", weight: 2 },
  { pattern: /\bathletics\b/i, sport: "athletics", weight: 2 },
  { pattern: /\bmma\b/i, sport: "mma", weight: 2 },
  { pattern: /\bmotorsport\b/i, sport: "motorsport", weight: 2 },
  { pattern: /\bhurling\b/i, sport: "other-sport", weight: 2 },
  { pattern: /\bhandball\b/i, sport: "other-sport", weight: 2 },
  { pattern: /\bvolleyball\b/i, sport: "other-sport", weight: 2 },
  { pattern: /\bnetball\b/i, sport: "other-sport", weight: 2 },
  { pattern: /\bbadminton\b/i, sport: "other-sport", weight: 2 },
  { pattern: /\bsquash\b/i, sport: "other-sport", weight: 2 },
  { pattern: /\bbowls\b/i, sport: "other-sport", weight: 2 },
  { pattern: /\bwrestling\b/i, sport: "other-sport", weight: 2 },
  { pattern: /\browing\b/i, sport: "other-sport", weight: 2 },
  { pattern: /\bsailing\b/i, sport: "other-sport", weight: 2 },
  { pattern: /\bskiing\b/i, sport: "other-sport", weight: 2 },
  { pattern: /\bskating\b/i, sport: "other-sport", weight: 2 },
  { pattern: /\bgymnastics\b/i, sport: "other-sport", weight: 2 },
  { pattern: /\btriathlon\b/i, sport: "other-sport", weight: 2 },
  { pattern: /\bhockey\b/i, sport: "other-sport", weight: 2 },
  { pattern: /\bracing\b/i, sport: "other-sport", weight: 1 },
]

/**
 * Team-name aliases: full names (plus famous unambiguous short forms)
 * mapped to their sport. Deliberately small and conservative — the list
 * exists only to resolve the SPORT of a fixture whose sides are named,
 * never to identify or expand a team. Unknown sides are never guessed:
 * they still yield a fixture classification with sport from other
 * evidence, or sport null. Single-word entries are included only where
 * the name is unambiguous as a club in a fixture ("Sunderland"); bare
 * "United" is NOT an entry — it must never be read as Manchester United.
 */
const TEAM_ALIASES: ReadonlyMap<string, SportId> = new Map<string, SportId>([
  // NHL (full names).
  ["anaheim ducks", "ice-hockey"],
  ["boston bruins", "ice-hockey"],
  ["buffalo sabres", "ice-hockey"],
  ["calgary flames", "ice-hockey"],
  ["carolina hurricanes", "ice-hockey"],
  ["chicago blackhawks", "ice-hockey"],
  ["colorado avalanche", "ice-hockey"],
  ["columbus blue jackets", "ice-hockey"],
  ["dallas stars", "ice-hockey"],
  ["detroit red wings", "ice-hockey"],
  ["edmonton oilers", "ice-hockey"],
  ["florida panthers", "ice-hockey"],
  ["los angeles kings", "ice-hockey"],
  ["minnesota wild", "ice-hockey"],
  ["montreal canadiens", "ice-hockey"],
  ["nashville predators", "ice-hockey"],
  ["new jersey devils", "ice-hockey"],
  ["new york islanders", "ice-hockey"],
  ["new york rangers", "ice-hockey"],
  ["ottawa senators", "ice-hockey"],
  ["philadelphia flyers", "ice-hockey"],
  ["pittsburgh penguins", "ice-hockey"],
  ["san jose sharks", "ice-hockey"],
  ["seattle kraken", "ice-hockey"],
  ["st louis blues", "ice-hockey"],
  ["tampa bay lightning", "ice-hockey"],
  ["toronto maple leafs", "ice-hockey"],
  ["utah mammoth", "ice-hockey"],
  ["utah hockey club", "ice-hockey"],
  ["vancouver canucks", "ice-hockey"],
  ["vegas golden knights", "ice-hockey"],
  ["washington capitals", "ice-hockey"],
  ["winnipeg jets", "ice-hockey"],
  // Football: Premier League + famous European clubs (full names and
  // famous short forms only).
  ["manchester united", "football"],
  ["man utd", "football"],
  ["manchester city", "football"],
  ["man city", "football"],
  ["arsenal", "football"],
  ["chelsea", "football"],
  ["liverpool", "football"],
  ["tottenham hotspur", "football"],
  ["tottenham", "football"],
  ["spurs", "football"],
  ["newcastle united", "football"],
  ["newcastle", "football"],
  ["aston villa", "football"],
  ["everton", "football"],
  ["west ham united", "football"],
  ["west ham", "football"],
  ["leeds united", "football"],
  ["leeds", "football"],
  ["nottingham forest", "football"],
  ["leicester city", "football"],
  ["brighton", "football"],
  ["brighton and hove albion", "football"],
  ["brentford", "football"],
  ["fulham", "football"],
  ["crystal palace", "football"],
  ["wolverhampton wanderers", "football"],
  ["wolves", "football"],
  ["sunderland", "football"],
  ["southampton", "football"],
  ["bournemouth", "football"],
  ["burnley", "football"],
  ["sheffield united", "football"],
  ["norwich city", "football"],
  ["ipswich town", "football"],
  ["celtic", "football"],
  ["rangers", "football"],
  ["real madrid", "football"],
  ["barcelona", "football"],
  ["fc barcelona", "football"],
  ["atletico madrid", "football"],
  ["bayern munich", "football"],
  ["borussia dortmund", "football"],
  ["juventus", "football"],
  ["inter milan", "football"],
  ["ac milan", "football"],
  ["napoli", "football"],
  ["paris saint germain", "football"],
  ["psg", "football"],
  ["ajax", "football"],
  ["benfica", "football"],
  ["porto", "football"],
  ["galatasaray", "football"],
  ["inter miami", "football"],
  ["wrexham", "football"],
  // Rugby: Irish provinces + famous Premiership/Top 14 clubs.
  ["leinster", "rugby"],
  ["munster", "rugby"],
  ["ulster", "rugby"],
  ["connacht", "rugby"],
  ["saracens", "rugby"],
  ["harlequins", "rugby"],
  ["bath", "rugby"],
  ["exeter chiefs", "rugby"],
  ["sale sharks", "rugby"],
  ["bristol bears", "rugby"],
  ["gloucester", "rugby"],
  ["northampton saints", "rugby"],
  ["toulouse", "rugby"],
  ["la rochelle", "rugby"],
  ["leicester tigers", "rugby"],
])

/** "Sport: ..." label prefixes. An explicit label wins over every other
 *  sport signal: the EPG itself names the sport. */
const PREFIX_SPORTS: ReadonlyMap<string, SportId> = new Map<string, SportId>([
  ["football", "football"],
  ["soccer", "football"],
  ["ice hockey", "ice-hockey"],
  ["hockey", "other-sport"],
  ["field hockey", "other-sport"],
  ["snooker", "snooker"],
  ["rugby", "rugby"],
  ["rugby league", "rugby"],
  ["rugby union", "rugby"],
  ["formula 1", "motorsport"],
  ["formula one", "motorsport"],
  ["f1", "motorsport"],
  ["motogp", "motorsport"],
  ["moto gp", "motorsport"],
  ["motorsport", "motorsport"],
  ["motor sport", "motorsport"],
  ["nascar", "motorsport"],
  ["indycar", "motorsport"],
  ["wrc", "motorsport"],
  ["darts", "darts"],
  ["pdc", "darts"],
  ["tennis", "tennis"],
  ["atp", "tennis"],
  ["wta", "tennis"],
  ["golf", "golf"],
  ["pga", "golf"],
  ["cricket", "cricket"],
  ["basketball", "basketball"],
  ["nba", "basketball"],
  ["american football", "american-football"],
  ["nfl", "american-football"],
  ["baseball", "baseball"],
  ["mlb", "baseball"],
  ["boxing", "boxing"],
  ["mma", "mma"],
  ["mixed martial arts", "mma"],
  ["ufc", "mma"],
  ["cycling", "cycling"],
  ["athletics", "athletics"],
  ["horse racing", "other-sport"],
  ["racing", "other-sport"],
  ["hurling", "other-sport"],
  ["gaelic football", "other-sport"],
  ["gaa", "other-sport"],
  ["nhl", "ice-hockey"],
])

const EVENT_WORDS =
  /\b(championships?|cup|open|classic|masters|trophy|finals?|semi[\s-]?finals?|quarter[\s-]?finals?|grand\s+prix|qualifying|qualification|qualifier|race|sprint|stage|leg|playoffs?|tour)\b/i
const BROADCAST_WORDS = /\b(live|highlights?|coverage|preview|review|build[\s-]?up|special|magazine|show|weekly|extras?)\b/i
const GENERIC_EVENT_LABELS = new Set([
  "live",
  "highlights",
  "highlight",
  "build-up",
  "buildup",
  "build up",
  "coverage",
  "preview",
  "review",
  "special",
  "magazine",
  "show",
  "weekly",
  "daily",
  "news",
  "extra",
  "extras",
])

const SPORTS_CHANNEL_HINT = /\b(sports?|espn|eurosport|dazn|bein)\b|racing\s+tv|tnt\s+sports|sky\s+sports|premier\s+sports|bt\s+sport/i
const SPORTS_CATEGORY_HINT = /\bsports?\b/i

const TRAILING_QUALITY_SUFFIX = /\s+(?:HD|FHD|UHD|4K|\+1)\s*$/i
const LEADING_LIVE_LABEL = /^\s*live(?:\s+coverage)?\s*[:\-–—]\s*/i
const FIXTURE_PATTERN = /^(.+?)\s+(v\.?|vs\.?|versus|@)\s+(.+)$/i

// ---------------------------------------------------------------------------
// Parsing helpers (pure)
// ---------------------------------------------------------------------------

function normaliseForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function normaliseSideForAlias(side: string): string {
  return normaliseForMatch(side)
    .replace(/\s+(fc|afc|cf)$/, "")
    .replace(/\s+u\d{2}$/, "")
    .replace(/\s+women$/, "")
    .trim()
}

function cleanSide(raw: string): string {
  return raw.replace(/\s+/g, " ").replace(/[.,;:!?]+$/, "").trim()
}

/** Split "A v B" / "A vs B" / "A versus B" / "A @ B", preserving the
 *  sides as written (minus a leading "Live" label on side A and any
 *  trailing competition/segment suffix on side B). */
function parseFixture(text: string): [string, string] | null {
  const match = text.match(FIXTURE_PATTERN)
  if (!match) return null
  const sideA = cleanSide(match[1].replace(/^live\s+/i, ""))
  let sideB = cleanSide(match[3])
  // Side B may carry a trailing segment ("Sunderland: Premier League",
  // "Sunderland - Live", "Sunderland (Sky Sports)"): cut at the first
  // segment separator. Team names never contain these.
  const cut = sideB.search(/\s*[:|([]|\s+[–—]\s+|\s+-\s+/)
  if (cut >= 0) sideB = cleanSide(sideB.slice(0, cut))
  if (sideA.length < 2 || sideB.length < 2) return null
  if (!/[a-z]/i.test(sideA) || !/[a-z]/i.test(sideB)) return null
  if (sideA.length > 60 || sideB.length > 60) return null
  return [sideA, sideB]
}

interface SpanEvidence {
  start: number
  end: number
  sport: SportId | null
  weight: number
  index: number
}

function collectKeywordEvidence(text: string): SpanEvidence[] {
  const spans: SpanEvidence[] = []
  for (const keyword of SPORT_KEYWORDS) {
    const match = text.match(keyword.pattern)
    if (!match || match.index == null) continue
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      sport: keyword.sport,
      weight: keyword.weight,
      index: match.index,
    })
  }
  // Drop any span fully contained in another (longer phrase wins):
  // "gaelic football" suppresses "football", "ice hockey" suppresses
  // "hockey", "horse racing" suppresses "racing".
  return spans.filter(
    (span) => !spans.some((other) => other !== span && other.start <= span.start && other.end >= span.end)
  )
}

interface AliasMatch {
  alias: CompetitionAlias
  index: number
  length: number
}

function collectAliasMatches(text: string): AliasMatch[] {
  const matches: AliasMatch[] = []
  for (const alias of COMPETITION_ALIASES) {
    const match = text.match(alias.pattern)
    if (!match || match.index == null) continue
    matches.push({ alias, index: match.index, length: match[0].length })
  }
  return matches
}

function collectWeakMatches(text: string): Array<{ indicator: WeakIndicator; index: number }> {
  const matches: Array<{ indicator: WeakIndicator; index: number }> = []
  for (const indicator of WEAK_INDICATORS) {
    const match = text.match(indicator.pattern)
    if (!match || match.index == null) continue
    matches.push({ indicator, index: match.index })
  }
  return matches
}

/** "Sport: Event" label — the text before the first ": " naming a sport. */
function parseSportPrefix(text: string): { sport: SportId; remainder: string } | null {
  const colon = text.indexOf(":")
  if (colon <= 0) return null
  const rawPrefix = text.slice(0, colon).trim()
  if (!rawPrefix || rawPrefix.length > 30) return null
  const prefix = normaliseForMatch(rawPrefix.replace(/^live\s+/i, ""))
  const sport = PREFIX_SPORTS.get(prefix)
  if (!sport) return null
  const remainder = text.slice(colon + 1).trim()
  if (!remainder) return null
  return { sport, remainder }
}

function hasSportsChannelSupport(opts?: { channelName?: string; category?: string }): boolean {
  if (opts?.channelName && SPORTS_CHANNEL_HINT.test(opts.channelName)) return true
  if (opts?.category && SPORTS_CATEGORY_HINT.test(opts.category)) return true
  return false
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function classifySportsProgramme(
  title: string,
  opts?: { channelName?: string; category?: string }
): SportsClassification {
  const raw = (title || "").trim()
  if (!raw) return { ...NON_SPORT }

  const parseText = raw.replace(TRAILING_QUALITY_SUFFIX, "").replace(LEADING_LIVE_LABEL, "").trim()
  if (!parseText) return { ...NON_SPORT }

  const fixture = parseFixture(parseText)
  const prefix = parseSportPrefix(parseText)
  const aliasMatches = collectAliasMatches(parseText)
  const keywordEvidence = collectKeywordEvidence(parseText)
  const weakMatches = collectWeakMatches(parseText)

  // Team-alias evidence for fixture sides (sport only — the original
  // side strings are preserved untouched in `teams`).
  const sideSports: Array<SportId | null> = fixture
    ? fixture.map((side) => TEAM_ALIASES.get(normaliseSideForAlias(side)) ?? null)
    : []
  const knownSides = sideSports.filter((sport): sport is SportId => sport != null)
  const bothSidesKnown =
    fixture != null && knownSides.length === 2 && sideSports[0] === sideSports[1]

  // Resolve the sport. An explicit "Sport:" label wins outright. Otherwise
  // the strongest evidence wins (competition alias 3 > keyword/team 2 >
  // weak phrase 1); ties break by longest match, then earliest position.
  // Evidence with an unknown sport ("World Cup") never overrides sport-specific
  // evidence — it only marks the title as sport when nothing else does.
  let sport: SportId | null = null
  const strongAliasMatched = aliasMatches.length > 0
  if (prefix) {
    sport = prefix.sport
  } else {
    const evidence: SpanEvidence[] = []
    for (const match of aliasMatches) {
      if (match.alias.sport != null) {
        evidence.push({ start: match.index, end: match.index + match.length, sport: match.alias.sport, weight: 3, index: match.index })
      }
    }
    for (const span of keywordEvidence) evidence.push(span)
    if (fixture) {
      const separatorIndex = parseText.search(/\s+(v\.?|vs\.?|versus|@)\s+/i)
      for (const sideSport of sideSports) {
        if (sideSport != null) {
          evidence.push({ start: separatorIndex, end: separatorIndex, sport: sideSport, weight: 2, index: separatorIndex })
        }
      }
    }
    for (const weak of weakMatches) {
      if (weak.indicator.sport != null) {
        evidence.push({ start: weak.index, end: weak.index, sport: weak.indicator.sport, weight: 1, index: weak.index })
      }
    }
    // The strongest evidence wins (competition alias 3 > keyword/team 2
    // > weak phrase 1); ties break by longest match, then by earliest
    // position — so "Premier League Darts" resolves to darts, not to
    // the football "Premier League" contained inside it.
    evidence.sort(
      (a, b) => b.weight - a.weight || b.end - b.start - (a.end - a.start) || a.index - b.index
    )
    sport = evidence.length ? evidence[0].sport : null
  }

  const hasSportEvidence =
    prefix != null ||
    aliasMatches.length > 0 ||
    keywordEvidence.length > 0 ||
    weakMatches.length > 0 ||
    knownSides.length > 0 ||
    fixture != null

  if (!hasSportEvidence) return { ...NON_SPORT }

  // Kind: fixture beats tournament beats league-broadcast.
  let kind: SportsClassification["kind"]
  const hasEventWord = EVENT_WORDS.test(parseText)
  const remainderHasEventWord = prefix != null && EVENT_WORDS.test(prefix.remainder)
  if (fixture) {
    kind = "fixture"
  } else if (
    remainderHasEventWord ||
    aliasMatches.some((match) => match.alias.kindHint === "tournament") ||
    (sport != null && hasEventWord && (keywordEvidence.length > 0 || prefix != null || aliasMatches.length > 0))
  ) {
    kind = "tournament"
  } else if (aliasMatches.some((match) => match.alias.kindHint === "league-broadcast")) {
    kind = "league-broadcast"
  } else {
    kind = "general-sport"
  }

  // Competition: fixtures take it from matched indicators only; a
  // "Sport: Event" label takes the event text (unless generic); otherwise
  // the longest matched indicator wins ("PDC World Darts Championship"
  // beats "PDC"; "Premier League Darts" beats "Premier League").
  let competition: string | undefined
  if (fixture) {
    const sameSport = aliasMatches.filter((match) => match.alias.sport == null || match.alias.sport === sport)
    const pool = sameSport.length ? sameSport : aliasMatches
    const longest = [...pool].sort((a, b) => b.length - a.length || a.index - b.index)[0]
    if (longest) competition = longest.alias.competition
  } else if (prefix) {
    const eventText = prefix.remainder.split(/\s+[–—|]\s+/)[0].trim()
    if (eventText && !GENERIC_EVENT_LABELS.has(normaliseForMatch(eventText))) {
      competition = eventText
    } else {
      const sameSport = aliasMatches.filter((match) => match.alias.sport === sport)
      const longest = [...sameSport].sort((a, b) => b.length - a.length || a.index - b.index)[0]
      if (longest) competition = longest.alias.competition
    }
  } else {
    const longest = [...aliasMatches].sort((a, b) => b.length - a.length || a.index - b.index)[0]
    if (longest) {
      competition = longest.alias.competition
    } else {
      const weakWithName = weakMatches.find((match) => match.indicator.competition)
      if (weakWithName?.indicator.competition) competition = weakWithName.indicator.competition
    }
  }

  // Confidence. High is title-only evidence: a strong indicator, both
  // fixture sides known, or a "Sport: Event" label. Channel/category
  // support can only lift low to medium — never to high, and never
  // from nothing.
  let confidence: SportsClassification["confidence"]
  if (strongAliasMatched || bothSidesKnown || remainderHasEventWord) {
    confidence = "high"
  } else if (
    fixture != null ||
    prefix != null ||
    (keywordEvidence.length > 0 && (hasEventWord || BROADCAST_WORDS.test(parseText)))
  ) {
    confidence = "medium"
  } else if (hasSportsChannelSupport(opts)) {
    confidence = "medium"
  } else {
    confidence = "low"
  }
  // A fixture whose sport is unknown stays medium at most: without a
  // known competition or team it may be a film ("Kramer vs Kramer"),
  // and the hierarchy must still try exact TMDb art first.
  if (fixture != null && sport == null && !strongAliasMatched && confidence === "high") {
    confidence = "medium"
  }

  const result: SportsClassification = { isSport: true, sport, kind, confidence }
  if (fixture) result.teams = fixture
  if (competition) result.competition = competition
  return result
}
