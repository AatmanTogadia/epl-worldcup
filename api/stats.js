const BASE = 'https://v3.football.api-sports.io';
const WC_LEAGUE = 1;
const WC_SEASON = 2026;
const EPL_LEAGUE = 39;
const EPL_SEASON = 2025;
const CACHE_MS = 5 * 60 * 1000; // 5 minutes

// In-memory cache (persists between requests on same Vercel instance)
let cache = { data: null, builtAt: 0, eplMap: null, eplBuiltAt: 0 };

function posLabel(pos) {
  if (!pos) return '—';
  const p = pos.toUpperCase();
  if (p.includes('GOALKEEPER')) return 'GK';
  if (p.includes('DEFENDER')) return 'DEF';
  if (p.includes('MIDFIELDER')) return 'MID';
  if (p.includes('ATTACKER') || p.includes('FORWARD')) return 'FWD';
  return pos;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const key = process.env.API_FOOTBALL_KEY;
  if (!key) return res.status(500).json({ error: 'API_FOOTBALL_KEY not configured' });

  // Return cached data if still fresh
  if (cache.data && (Date.now() - cache.builtAt) < CACHE_MS) {
    return res.status(200).json({
      ...cache.data,
      cached: true,
      cacheAge: Math.round((Date.now() - cache.builtAt) / 1000) + 's'
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
    // ── Step 1: EPL player map (cache for 24hrs — squads don't change daily) ──
    const EPL_CACHE_MS = 24 * 60 * 60 * 1000;
    let eplPlayerMap = {};

    if (cache.eplMap && (Date.now() - cache.eplBuiltAt) < EPL_CACHE_MS) {
      // Reuse EPL map — saves ~20 API calls
      eplPlayerMap = cache.eplMap;
    } else {
      const eplTeams = await get(`/teams?league=${EPL_LEAGUE}&season=${EPL_SEASON}`);
      for (const entry of eplTeams) {
        const team = entry.team;
        const squads = await get(`/players/squads?team=${team.id}`);
        for (const sq of squads) {
          for (const p of (sq.players || [])) {
            eplPlayerMap[p.id] = {
              club: team.name,
              clubLogo: team.logo || '',
              position: posLabel(p.position),
            };
          }
        }
      }
      cache.eplMap = eplPlayerMap;
      cache.eplBuiltAt = Date.now();
    }

    // ── Step 2: WC teams + squads ──
    const wcTeams = await get(`/teams?league=${WC_LEAGUE}&season=${WC_SEASON}`);
    const wcPlayerNation = {};
    for (const entry of wcTeams) {
      const team = entry.team;
      const squads = await get(`/players/squads?team=${team.id}`);
      for (const sq of squads) {
        for (const p of (sq.players || [])) {
          wcPlayerNation[p.id] = { nation: team.name, flag: team.logo || '' };
        }
      }
    }

    // ── Step 3: Cross-reference EPL + WC ──
    const playerMap = {};
    for (const [pid, epl] of Object.entries(eplPlayerMap)) {
      const wc = wcPlayerNation[pid];
      if (!wc) continue;
      playerMap[pid] = {
        id: parseInt(pid),
        name: epl.name || '—',
        nationality: wc.nation,
        flag: wc.flag,
        club: epl.club,
        clubLogo: epl.clubLogo,
        position: epl.position,
        minutes: 0, appearances: 0,
        goals: 0, assists: 0,
        yellow: 0, red: 0,
      };
    }

    // ── Step 4: Layer in WC stats ──
    const p1res = await fetch(`${BASE}/players?league=${WC_LEAGUE}&season=${WC_SEASON}&page=1`, { headers });
    const p1data = await p1res.json();
    const totalPages = p1data.paging?.total || 1;
    const allWcStats = [...(p1data.response || [])];

    for (let page = 2; page <= Math.min(totalPages, 10); page++) {
      const rows = await get(`/players?league=${WC_LEAGUE}&season=${WC_SEASON}&page=${page}`);
      allWcStats.push(...rows);
    }

    for (const entry of allWcStats) {
      const p = entry.player;
      if (!playerMap[p.id]) continue;
      const stat = entry.statistics?.[0];
      if (!stat) continue;
      playerMap[p.id].name = p.name || playerMap[p.id].name;
      playerMap[p.id].minutes = stat.games?.minutes || 0;
      playerMap[p.id].appearances = stat.games?.appearences || 0;
      playerMap[p.id].goals = stat.goals?.total || 0;
      playerMap[p.id].assists = stat.goals?.assists || 0;
      playerMap[p.id].yellow = stat.cards?.yellow || 0;
      playerMap[p.id].red = (stat.cards?.red || 0) + (stat.cards?.yellowred || 0);
    }

    const players = Object.values(playerMap);
    const result = {
      players,
      total: players.length,
      source: 'api-football.com',
      updated: new Date().toISOString()
    };

    // Store in cache
    cache.data = result;
    cache.builtAt = Date.now();

    return res.status(200).json({ ...result, cached: false });

  } catch (e) {
    // If we have stale cache, return it rather than an error
    if (cache.data) {
      return res.status(200).json({
        ...cache.data,
        cached: true,
        stale: true,
        error: e.message
      });
    }
    return res.status(500).json({ error: e.message });
  }
};
