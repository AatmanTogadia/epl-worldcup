module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const key = process.env.FOOTBALL_DATA_API_KEY;
  if (!key) return res.status(500).json({ error: 'API key not configured' });

  const headers = { 'X-Auth-Token': key };

  function posLabel(pos) {
    if (!pos) return '—';
    const p = pos.toUpperCase();
    if (p.includes('KEEPER') || p === 'GK') return 'GK';
    if (p.includes('DEFENCE') || p.includes('DEFENDER') || p === 'DEF') return 'DEF';
    if (p.includes('MIDFIELD') || p === 'MID') return 'MID';
    if (p.includes('OFFENCE') || p.includes('FORWARD') || p.includes('ATTACK') || p === 'FWD') return 'FWD';
    return pos;
  }

  try {
    // Step 1: Get all EPL teams + their squads (includes position)
    const teamsRes = await fetch('https://api.football-data.org/v4/competitions/PL/teams', { headers });
    if (!teamsRes.ok) { const e = await teamsRes.json(); throw new Error('EPL teams: ' + (e.message || teamsRes.status)); }
    const teamsData = await teamsRes.json();
    const eplTeams = teamsData.teams || [];

    // playerId -> { club, name, nationality, position, crest }
    const eplPlayerMap = {};
    const clubCrests = {};
    for (const team of eplTeams) {
      clubCrests[team.name] = team.crest || '';
      for (const player of (team.squad || [])) {
        eplPlayerMap[player.id] = {
          club: team.name,
          clubCrest: team.crest || '',
          name: player.name,
          nationality: player.nationality || '—',
          position: posLabel(player.position),
        };
      }
    }

    // Step 2: Get all WC teams to find which players are at the tournament
    const wcTeamsRes = await fetch('https://api.football-data.org/v4/competitions/WC/teams', { headers });
    if (!wcTeamsRes.ok) { const e = await wcTeamsRes.json(); throw new Error('WC teams: ' + (e.message || wcTeamsRes.status)); }
    const wcTeamsData = await wcTeamsRes.json();

    // playerId -> { nationalTeam, flag }
    const wcPlayerNation = {};
    for (const team of (wcTeamsData.teams || [])) {
      for (const player of (team.squad || [])) {
        wcPlayerNation[player.id] = { nation: team.name, flag: team.crest || '' };
      }
    }

    // Step 3: Build full player list — all EPL players at WC with 0 stats
    const playerMap = {};
    for (const [pid, info] of Object.entries(eplPlayerMap)) {
      const wc = wcPlayerNation[pid];
      if (!wc) continue;
      playerMap[pid] = {
        id: parseInt(pid),
        name: info.name,
        nationality: wc.nation,
        flag: wc.flag,
        club: info.club,
        clubCrest: info.clubCrest,
        position: info.position,
        minutes: 0, goals: 0, assists: 0, yellow: 0, red: 0,
      };
    }

    // Step 4: Layer in scorer stats
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

    // Step 5: Layer in cards from finished matches
    const matchesRes = await fetch('https://api.football-data.org/v4/competitions/WC/matches?status=FINISHED', { headers });
    if (matchesRes.ok) {
      const matchesData = await matchesRes.json();
      for (const match of (matchesData.matches || [])) {
        for (const booking of (match.bookings || [])) {
          const pid = booking.player?.id;
          if (!pid || !playerMap[pid]) continue;
          if (booking.card === 'YELLOW_CARD') playerMap[pid].yellow++;
          if (booking.card === 'RED_CARD' || booking.card === 'YELLOW_RED_CARD') playerMap[pid].red++;
        }
      }
    }

    const players = Object.values(playerMap);
    return res.status(200).json({ players, total: players.length, clubCrests, source: 'football-data.org', updated: new Date().toISOString() });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
