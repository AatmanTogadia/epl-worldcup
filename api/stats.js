const BASE = 'https://v3.football.api-sports.io';
const WC_LEAGUE = 1;
const WC_SEASON = 2026;
const EPL_LEAGUE = 39;
const EPL_SEASON = 2025;

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

  const headers = { 'x-apisports-key': key };

  async function get(path) {
    const r = await fetch(`${BASE}${path}`, { headers });
    const data = await r.json();
    if (data.errors && Object.keys(data.errors).length > 0) throw new Error(JSON.stringify(data.errors));
    return data.response || [];
  }

  try {
    // ── Step 1: Build EPL player map (playerId → club info) ──
    // Get all EPL teams for season 2025
    const eplTeams = await get(`/teams?league=${EPL_LEAGUE}&season=${EPL_SEASON}`);
    const eplPlayerMap = {}; // id → { club, clubLogo, position }

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

    // ── Step 2: Get all WC teams then their squads ──
    // Get WC team IDs
    const wcTeams = await get(`/teams?league=${WC_LEAGUE}&season=${WC_SEASON}`);

    // playerId → nationalTeam name
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

    // ── Step 3: Cross-reference — all EPL players at WC with 0 stats ──
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

    // ── Step 4: Layer in real WC stats via /players endpoint ──
    // Fetch page 1 first to get paging info
    const p1res = await fetch(`${BASE}/players?league=${WC_LEAGUE}&season=${WC_SEASON}&page=1`, { headers });
    const p1data = await p1res.json();
    const totalPages = p1data.paging?.total || 1;
    const allWcStats = [...(p1data.response || [])];

    for (let page = 2; page <= Math.min(totalPages, 10); page++) {
      const pageRows = await get(`/players?league=${WC_LEAGUE}&season=${WC_SEASON}&page=${page}`);
      allWcStats.push(...pageRows);
    }

    for (const entry of allWcStats) {
      const p = entry.player;
      if (!playerMap[p.id]) continue; // not EPL
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
    return res.status(200).json({ players, total: players.length, source: 'api-football.com', updated: new Date().toISOString() });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
