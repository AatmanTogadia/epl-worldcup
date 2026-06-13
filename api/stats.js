const EPL_CLUBS = [
  'Arsenal','Chelsea','Manchester City','Manchester United','Liverpool',
  'Tottenham','Newcastle','Aston Villa','West Ham','Brighton',
  'Brentford','Fulham','Nottingham Forest','Everton','Crystal Palace',
  'Wolverhampton Wanderers','Leicester City','Southampton','Ipswich Town','Bournemouth'
];

function isEPL(clubName) {
  if (!clubName) return false;
  return EPL_CLUBS.some(c => clubName.toLowerCase().includes(c.toLowerCase().split(' ')[0]));
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const key = process.env.FOOTBALL_DATA_API_KEY;
  if (!key) return res.status(500).json({ error: 'API key not configured' });

  try {
    // Fetch top scorers for World Cup 2026
    const scorersRes = await fetch('https://api.football-data.org/v4/competitions/WC/scorers?limit=100', {
      headers: { 'X-Auth-Token': key }
    });

    if (!scorersRes.ok) {
      const err = await scorersRes.json();
      return res.status(500).json({ error: err.message || 'football-data.org error: ' + scorersRes.status });
    }

    const scorersData = await scorersRes.json();
    const scorers = scorersData.scorers || [];

    // Build player map from scorers (goals + assists)
    const playerMap = {};
    for (const entry of scorers) {
      const p = entry.player;
      const club = entry.team?.name || '';
      playerMap[p.id] = {
        id: p.id,
        name: p.name,
        nationality: p.nationality || '—',
        club,
        minutes: entry.playedMatches ? entry.playedMatches * 90 : 0,
        goals: entry.goals || 0,
        assists: entry.assists || 0,
        yellow: 0,
        red: 0,
      };
    }

    // Fetch matches to extract cards and minutes played
    const matchesRes = await fetch('https://api.football-data.org/v4/competitions/WC/matches?status=FINISHED', {
      headers: { 'X-Auth-Token': key }
    });

    if (matchesRes.ok) {
      const matchesData = await matchesRes.json();
      const matches = matchesData.matches || [];

      // Extract bookings (cards) from each match
      for (const match of matches) {
        const bookings = match.bookings || [];
        for (const booking of bookings) {
          const pid = booking.player?.id;
          if (!pid) continue;
          if (!playerMap[pid]) {
            playerMap[pid] = {
              id: pid,
              name: booking.player?.name || '—',
              nationality: '—',
              club: booking.team?.name || '—',
              minutes: 0, goals: 0, assists: 0, yellow: 0, red: 0
            };
          }
          if (booking.card === 'YELLOW_CARD') playerMap[pid].yellow++;
          if (booking.card === 'RED_CARD' || booking.card === 'YELLOW_RED_CARD') playerMap[pid].red++;
        }

        // Extract minutes from lineups
        const lineupTeams = [match.homeTeam, match.awayTeam].filter(Boolean);
        for (const team of lineupTeams) {
          const lineup = [
            ...(match.lineup?.[team.id]?.startXI || []),
            ...(match.lineup?.[team.id]?.substitutes || [])
          ];
          for (const player of lineup) {
            const pid = player?.player?.id;
            if (!pid || !playerMap[pid]) continue;
            playerMap[pid].minutes = (playerMap[pid].minutes || 0) + (player.minutesPlayed || 90);
          }
        }
      }
    }

    // Filter to EPL players only
    let eplPlayers = Object.values(playerMap).filter(p => isEPL(p.club));

    // If no EPL players found yet (early tournament), return all players with a note
    if (eplPlayers.length === 0) {
      eplPlayers = Object.values(playerMap);
    }

    return res.status(200).json({
      players: eplPlayers,
      total: eplPlayers.length,
      source: 'football-data.org',
      updated: new Date().toISOString()
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
