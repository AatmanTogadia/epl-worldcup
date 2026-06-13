module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const key = process.env.FOOTBALL_DATA_API_KEY;
  if (!key) return res.status(500).json({ error: 'API key not configured' });

  const headers = { 'X-Auth-Token': key };

  try {
    // Step 1: Get all EPL teams (competition code PL = Premier League)
    const teamsRes = await fetch('https://api.football-data.org/v4/competitions/PL/teams', { headers });
    if (!teamsRes.ok) {
      const e = await teamsRes.json();
      throw new Error('EPL teams error: ' + (e.message || teamsRes.status));
    }
    const teamsData = await teamsRes.json();
    const eplTeams = teamsData.teams || [];

    // Step 2: Build a map of player ID -> EPL club name from all EPL squads
    const eplPlayerMap = {}; // playerId -> clubName
    for (const team of eplTeams) {
      const squad = team.squad || [];
      for (const player of squad) {
        eplPlayerMap[player.id] = team.name;
      }
    }

    // Step 3: Get World Cup top scorers
    const scorersRes = await fetch('https://api.football-data.org/v4/competitions/WC/scorers?limit=100', { headers });
    if (!scorersRes.ok) {
      const e = await scorersRes.json();
      throw new Error('WC scorers error: ' + (e.message || scorersRes.status));
    }
    const scorersData = await scorersRes.json();
    const scorers = scorersData.scorers || [];

    // Step 4: Cross-reference — keep only players in EPL squads
    const playerMap = {};
    for (const entry of scorers) {
      const p = entry.player;
      const eplClub = eplPlayerMap[p.id];
      if (!eplClub) continue; // not an EPL player

      playerMap[p.id] = {
        id: p.id,
        name: p.name,
        nationality: p.nationality || entry.team?.name || '—',
        club: eplClub,
        minutes: (entry.playedMatches || 0) * 90,
        goals: entry.goals || 0,
        assists: entry.assists || 0,
        yellow: 0,
        red: 0,
      };
    }

    // Step 5: Get finished WC matches to extract cards
    const matchesRes = await fetch('https://api.football-data.org/v4/competitions/WC/matches?status=FINISHED', { headers });
    if (matchesRes.ok) {
      const matchesData = await matchesRes.json();
      for (const match of (matchesData.matches || [])) {
        for (const booking of (match.bookings || [])) {
          const pid = booking.player?.id;
          if (!pid) continue;
          const eplClub = eplPlayerMap[pid];
          if (!eplClub) continue; // not EPL
          if (!playerMap[pid]) {
            playerMap[pid] = {
              id: pid,
              name: booking.player?.name || '—',
              nationality: booking.team?.name || '—',
              club: eplClub,
              minutes: 90,
              goals: 0, assists: 0, yellow: 0, red: 0
            };
          }
          if (booking.card === 'YELLOW_CARD') playerMap[pid].yellow++;
          if (booking.card === 'RED_CARD' || booking.card === 'YELLOW_RED_CARD') playerMap[pid].red++;
        }
      }
    }

    const players = Object.values(playerMap);

    return res.status(200).json({
      players,
      total: players.length,
      eplSquadSize: Object.keys(eplPlayerMap).length,
      source: 'football-data.org',
      updated: new Date().toISOString()
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
