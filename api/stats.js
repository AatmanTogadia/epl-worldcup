const BASE = 'https://v3.football.api-sports.io';
const WC_LEAGUE  = 1;
const WC_SEASON  = 2026;
const EPL_LEAGUE = 39;
const EPL_SEASON = 2025;

// Cache durations
const STATS_CACHE_MS    = 5  * 60 * 1000;       // 5 mins  — WC stats during match day
const IDLE_CACHE_MS     = 6  * 60 * 60 * 1000;  // 6 hours — between match days
const WC_SQUAD_CACHE_MS = 24 * 60 * 60 * 1000;  // 24 hours — WC squads
const EPL_SQUAD_CACHE_MS= 7  * 24 * 60 * 60 * 1000; // 7 days — EPL squads (season over)

// World Cup 2026 match days (UTC dates) — June 11 to July 19
// We treat any date in this range as a potential match day
const WC_START = new Date('2026-06-11').getTime();
const WC_END   = new Date('2026-07-19').getTime();

function isMatchDay() {
  const now = Date.now();
  return now >= WC_START && now <= WC_END;
}

function getStatsCacheDuration() {
  return isMatchDay() ? STATS_CACHE_MS : IDLE_CACHE_MS;
}

function posLabel(pos) {
  if (!pos) return '—';
  const p = pos.toUpperCase();
  if (p.includes('GOALKEEPER')) return 'GK';
  if (p.includes('DEFENDER'))   return 'DEF';
  if (p.includes('MIDFIELDER')) return 'MID';
  if (p.includes('ATTACKER') || p.includes('FORWARD')) return 'FWD';
  return pos;
}

// In-memory cache (shared across requests on same Vercel instance)
const cache = {
  eplMap:      { data: null, at: 0 },
  wcSquads:    { data: null, at: 0 },
  statsResult: { data: null, at: 0 },
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const key = process.env.API_FOOTBALL_KEY;
  if (!key) return res.status(500).json({ error: 'API_FOOTBALL_KEY not configured' });

  const statsTTL = getStatsCacheDuration();

  // Return fully cached result if fresh
  if (cache.statsResult.data && (Date.now() - cache.statsResult.at) < statsTTL) {
    return res.status(200).json({
      ...cache.statsResult.data,
      cached: true,
      cacheAge: Math.round((Date.now() - cache.statsResult.at) / 1000) + 's',
      nextRefresh: Math.round((statsTTL - (Date.now() - cache.statsResult.at)) / 1000) + 's',
    });
  }

  const headers = { 'x-apisports-key': key };

  async function get(path) {
    const r = await fetch(`${BASE}${path}`, { headers });
    const data = await r.json();
    if (data.errors && Object.keys(data.errors).length > 0) throw new Error(JSON.stringify(data.errors));
    return data.response || [];
  }

  try {
    let apiCallCount = 0;

    // ── Step 1: EPL player map — cache 7 days ──
    let eplPlayerMap = {};
    if (cache.eplMap.data && (Date.now() - cache.eplMap.at) < EPL_SQUAD_CACHE_MS) {
      eplPlayerMap = cache.eplMap.data;
    } else {
      const eplTeams = await get(`/teams?league=${EPL_LEAGUE}&season=${EPL_SEASON}`);
      apiCallCount++;
      for (const entry of eplTeams) {
        const team = entry.team;
        const squads = await get(`/players/squads?team=${team.id}`);
        apiCallCount++;
        for (const sq of squads) {
          for (const p of (sq.players || [])) {
            eplPlayerMap[p.id] = {
              club:     team.name,
              clubLogo: team.logo || '',
              position: posLabel(p.position),
            };
          }
        }
      }
      cache.eplMap = { data: eplPlayerMap, at: Date.now() };
    }

    // ── Step 2: WC squads — cache 24 hrs ──
    let wcPlayerNation = {};
    if (cache.wcSquads.data && (Date.now() - cache.wcSquads.at) < WC_SQUAD_CACHE_MS) {
      wcPlayerNation = cache.wcSquads.data;
    } else {
      const wcTeams = await get(`/teams?league=${WC_LEAGUE}&season=${WC_SEASON}`);
      apiCallCount++;
      for (const entry of wcTeams) {
        const team = entry.team;
        const squads = await get(`/players/squads?team=${team.id}`);
        apiCallCount++;
        for (const sq of squads) {
          for (const p of (sq.players || [])) {
            wcPlayerNation[p.id] = { nation: team.name, flag: team.logo || '' };
          }
        }
      }
      cache.wcSquads = { data: wcPlayerNation, at: Date.now() };
    }

    // ── Step 3: Build player map — all EPL players at WC with 0 stats ──
    const playerMap = {};
    for (const [pid, epl] of Object.entries(eplPlayerMap)) {
      const wc = wcPlayerNation[pid];
      if (!wc) continue;
      playerMap[pid] = {
        id:          parseInt(pid),
        name:        '—',
        nationality: wc.nation,
        flag:        wc.flag,
        club:        epl.club,
        clubLogo:    epl.clubLogo,
        position:    epl.position,
        minutes:     0, appearances: 0,
        goals:       0, assists:     0,
        yellow:      0, red:         0,
      };
    }

    // ── Step 4: Layer in stats — 4 calls only ──
    // Use topscorers/topassists/topcards instead of paginating all players
    const [scorers, assists, yellows, reds] = await Promise.all([
      get(`/players/topscorers?league=${WC_LEAGUE}&season=${WC_SEASON}`),
      get(`/players/topassists?league=${WC_LEAGUE}&season=${WC_SEASON}`),
      get(`/players/topyellowcards?league=${WC_LEAGUE}&season=${WC_SEASON}`),
      get(`/players/topredcards?league=${WC_LEAGUE}&season=${WC_SEASON}`),
    ]);
    apiCallCount += 4;

    function applyStats(entries, field) {
      for (const entry of entries) {
        const p   = entry.player;
        const stat = entry.statistics?.[0];
        if (!stat) continue;
        // Add player even if not in our EPL map (might be missing from squad list)
        if (playerMap[p.id]) {
          playerMap[p.id].name        = p.name || playerMap[p.id].name;
          playerMap[p.id].minutes     = stat.games?.minutes      || playerMap[p.id].minutes;
          playerMap[p.id].appearances = stat.games?.appearences  || playerMap[p.id].appearances;
          playerMap[p.id].goals       = stat.goals?.total        || playerMap[p.id].goals;
          playerMap[p.id].assists     = stat.goals?.assists       || playerMap[p.id].assists;
          playerMap[p.id].yellow      = stat.cards?.yellow        || playerMap[p.id].yellow;
          playerMap[p.id].red         = (stat.cards?.red || 0) + (stat.cards?.yellowred || 0) || playerMap[p.id].red;
        }
      }
    }

    applyStats(scorers,  'goals');
    applyStats(assists,  'assists');
    applyStats(yellows,  'yellow');
    applyStats(reds,     'red');

    // Also apply minutes from scorers for anyone who played
    for (const entry of scorers) {
      const p = entry.player;
      if (!playerMap[p.id]) continue;
      const stat = entry.statistics?.[0];
      if (stat?.games?.minutes) playerMap[p.id].minutes = stat.games.minutes;
    }

    const players = Object.values(playerMap);
    const result = {
      players,
      total:       players.length,
      apiCalls:    apiCallCount,
      matchDay:    isMatchDay(),
      source:      'api-football.com',
      updated:     new Date().toISOString(),
    };

    cache.statsResult = { data: result, at: Date.now() };
    return res.status(200).json({ ...result, cached: false });

  } catch (e) {
    // Serve stale cache rather than error if available
    if (cache.statsResult.data) {
      return res.status(200).json({
        ...cache.statsResult.data,
        cached: true,
        stale:  true,
        error:  e.message,
      });
    }
    return res.status(500).json({ error: e.message });
  }
};
