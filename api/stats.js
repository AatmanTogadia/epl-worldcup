const BASE = 'https://v3.football.api-sports.io';
const WC_LEAGUE = 1;
const WC_SEASON = 2026;
const EPL_LEAGUE = 39;
const EPL_SEASON = 2025;

function posLabel(pos) {
  if (!pos) return '—';
  const p = pos.toUpperCase();
  if (p.includes('GOALKEEPER') || p === 'G') return 'GK';
  if (p.includes('DEFENDER') || p === 'D') return 'DEF';
  if (p.includes('MIDFIELDER') || p === 'M') return 'MID';
  if (p.includes('ATTACKER') || p === 'F') return 'FWD';
  return pos;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const key = process.env.API_FOOTBALL_KEY;
  if (!key) return res.status(500).json({ error: 'API_FOOTBALL_KEY not configured' });

  const headers = {
    'x-apisports-key': key
  };

  async function apiFetch(path) {
    const r = await fetch(`${BASE}${path}`, { headers });
    if (!r.ok) {
      const e = await r.json();
      throw new Error(e.message || `HTTP ${r.status} on ${path}`);
    }
    const data = await r.json();
    if (data.errors && Object.keys(data.errors).length > 0) {
      throw new Error(JSON.stringify(data.errors));
    }
    return data.response;
  }

  try {
    // Step 1: Get all EPL teams with squads (league=39, season=2025)
    const eplTeams = await apiFetch(`/teams?league=${EPL_LEAGUE}&season=${EPL_SEASON}`);

    // For each EPL team, get their squad
    const eplPlayerMap = {}; // playerId -> { club, clubLogo, position }
    for (const entry of eplTeams) {
      const team = entry.team;
      const squadRes = await apiFetch(`/players/squads?team=${team.id}`);
      for (const squadEntry of (squadRes || [])) {
        for (const player of (squadEntry.players || [])) {
          eplPlayerMap[player.id] = {
            club: team.name,
            clubLogo: team.logo || '',
            position: posLabel(player.position),
          };
        }
      }
    }

    // Step 2: Get all WC players with stats — paginated
    const playerMap = {}; // playerId -> full stats object

    // Fetch page 1 to get total pages
    const firstPage = await fetch(`${BASE}/players?league=${WC_LEAGUE}&season=${WC_SEASON}&page=1`, { headers });
    const firstData = await firstPage.json();
    const totalPages = firstData.paging?.total || 1;
    const allWcPlayers = [...(firstData.response || [])];

    // Fetch remaining pages (up to 10 to stay within rate limits)
    const pagesToFetch = Math.min(totalPages, 10);
    for (let page = 2; page <= pagesToFetch; page++) {
      const pageData = await apiFetch(`/players?league=${WC_LEAGUE}&season=${WC_SEASON}&page=${page}`);
      allWcPlayers.push(...(pageData || []));
    }

    // Build WC player stats — only keep EPL players
    for (const entry of allWcPlayers) {
      const p = entry.player;
      const epl = eplPlayerMap[p.id];
      if (!epl) continue; // not an EPL player

      const stat = entry.statistics?.[0]; // WC stats
      playerMap[p.id] = {
        id: p.id,
        name: p.name,
        photo: p.photo || '',
        nationality: p.nationality || '—',
        flag: `https://media.api-sports.io/flags/${(p.nationality || '').toLowerCase().replace(/ /g, '-')}.svg`,
        club: epl.club,
        clubLogo: epl.clubLogo,
        position: epl.position || posLabel(stat?.games?.position),
        minutes: stat?.games?.minutes || 0,
        appearances: stat?.games?.appearences || 0,
        goals: stat?.goals?.total || 0,
        assists: stat?.goals?.assists || 0,
        yellow: stat?.cards?.yellow || 0,
        red: (stat?.cards?.red || 0) + (stat?.cards?.yellowred || 0),
      };
    }

    // Step 3: For EPL players NOT found via WC stats (played but didn't score/get cards)
    // Get WC squads to ensure we list everyone
    const wcSquads = await apiFetch(`/players/squads?league=${WC_LEAGUE}&season=${WC_SEASON}`);
    for (const squadEntry of (wcSquads || [])) {
      const nation = squadEntry.team?.name || '—';
      for (const player of (squadEntry.players || [])) {
        if (playerMap[player.id]) {
          // Already have stats — just make sure nationality is set
          playerMap[player.id].nationality = nation;
          continue;
        }
        const epl = eplPlayerMap[player.id];
        if (!epl) continue; // not EPL
        // Add with 0 stats
        playerMap[player.id] = {
          id: player.id,
          name: player.name,
          photo: player.photo || '',
          nationality: nation,
          flag: `https://media.api-sports.io/flags/${nation.toLowerCase().replace(/ /g, '-')}.svg`,
          club: epl.club,
          clubLogo: epl.clubLogo,
          position: epl.position || posLabel(player.position),
          minutes: 0,
          appearances: 0,
          goals: 0,
          assists: 0,
          yellow: 0,
          red: 0,
        };
      }
    }

    const players = Object.values(playerMap);

    return res.status(200).json({
      players,
      total: players.length,
      source: 'api-football.com',
      updated: new Date().toISOString()
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
