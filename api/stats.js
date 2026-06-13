module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const key = process.env.FOOTBALL_DATA_API_KEY;
  if (!key) return res.status(500).json({ error: 'API key not configured' });

  const headers = { 'X-Auth-Token': key };

  try {
    // Step 1: Get all EPL teams + their squads
    const teamsRes = await fetch('https://api.football-data.org/v4/competitions/PL/teams', { headers });
    if (!teamsRes.ok) {
      const e = await teamsRes.json();
      throw new Error('EPL teams error: ' + (e.message || teamsRes.status));
    }
    const teamsData = await teamsRes.json();
    const eplTeams = teamsData.teams || [];

    // Build playerId -> { clubName, playerName, nationality, position } from EPL squads
    const eplPlayerMap = {};
    for (const team of eplTeams) {
      for (const player of (team.squad || [])) {
        eplPlayerMap[player.id] = {
          club: team.name,
          name: player.name,
          nationality: player.nationality || '—',
          position: player.position || '—',
        };
      }
    }

    // Step 2: Get all WC squads to find which players are actually at the tournament
    const wcSquadsRes = await fetch('https://api.football-data.org/v4/competitions/WC/teams', { headers });
    if (!wcSquadsRes.ok) {
      const e = await wcSquadsRes.json();
      throw new Error('WC teams error: ' + (e.message || wcSquadsRes.status));
    }
    const wcSquadsData = await wcSquadsRes.json();
    const wcTeams = wcSquadsData.teams || [];

    // Build set of player IDs at the WC + their national team name
    const wcPlayerNation = {}; // playerId -> nationalTeamName
    for (const team of wcTeams) {
      for (const player of (team.squad || [])) {
        wcPlayerNation[player.id] = team.name;
      }
    }

    // Step 3: Find EPL players who are at the WC — start all with 0 stats
    const playerMap = {};
    for (const [pid, info] of Object.entries(eplPlayerMap)) {
      const nation = wcPlayerNation[pid];
      if (!nation) continue; // not at the WC
      playerMap[pid] = {
        id: parseInt(pid),
        name: info.name,
        nationality: nation,
        club: info.club,
        minutes: 0,
        goals: 0,
        assists: 0,
        yellow: 0,
        red: 0,
      };
    }

    // Step 4: Layer in WC scorer stats (goals + assists)
    const scorersRes = await fetch('https://api.football-data.org/v4/competitions/WC/scorers?limit=100', { headers });
    if (scorersRes.ok) {
      const scorersData = await scorersRes.json();
      for (const entry of (scorersData.scorers || [])) {
        const pid = entry.player?.id;
        if (!pid || !playerMap[pid]) continue;
        playerMap[pid].goals = entry.goals || 0;
        playerMap[pid].assists = entry.assists || 0;
        playerMap[pid].minutes = (entry.playedMatches || 0) * 90;
      }
    }

    // Step 5: Layer in cards + better minutes from finished matches
    const matchesRes = await fetch('https://api.football-data.org/v4/competitions/WC/matches?status=FINISHED', { headers });
    if (matchesRes.ok) {
      const matchesData = await matchesRes.json();
      for (const match of (matchesData.matches || [])) {
        // Cards
        for (const booking of (match.bookings || [])) {
          const pid = booking.player?.id;
          if (!pid || !playerMap[pid]) continue;
          if (booking.card === 'YELLOW_CARD') playerMap[pid].yellow++;
          if (booking.card === 'RED_CARD' || booking.card === 'YELLOW_RED_CARD') playerMap[pid].red++;
        }
      }
    }

    const players = Object.values(playerMap);

    return res.status(200).json({
      players,
      total: players.length,
      source: 'football-data.org',
      updated: new Date().toISOString()
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
