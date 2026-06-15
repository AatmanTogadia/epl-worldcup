const BASE = 'https://v3.football.api-sports.io';
const WC_LEAGUE = 1;
const WC_SEASON = 2026;

module.exports = async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  const key = process.env.API_FOOTBALL_KEY;
  const headers = {'x-apisports-key': key};

  try {
    // Find Germany in WC
    const wcTeamsRes = await fetch(`${BASE}/teams?league=${WC_LEAGUE}&season=${WC_SEASON}`,{headers});
    const wcTeams = (await wcTeamsRes.json()).response||[];
    const germany = wcTeams.find(e=>e.team?.name?.toLowerCase().includes('germany'));
    const germanyId = germany?.team?.id;

    // Germany finished fixtures
    const fxRes = await fetch(`${BASE}/fixtures?league=${WC_LEAGUE}&season=${WC_SEASON}&team=${germanyId}&status=FT`,{headers});
    const fixtures = (await fxRes.json()).response||[];

    // Check topscorers for Havertz
    const scorersRes = await fetch(`${BASE}/players/topscorers?league=${WC_LEAGUE}&season=${WC_SEASON}`,{headers});
    const scorers = (await scorersRes.json()).response||[];
    const havertzScorer = scorers.find(e=>e.player?.name?.toLowerCase().includes('havertz'));

    // Check fixture events for Havertz goal
    let havertzEvents = [];
    let havertzFixtureStats = [];

    for(const fx of fixtures){
      // Events
      const evRes = await fetch(`${BASE}/fixtures/events?fixture=${fx.fixture?.id}`,{headers});
      const events = (await evRes.json()).response||[];
      const havEvents = events.filter(e=>e.player?.name?.toLowerCase().includes('havertz'));
      if(havEvents.length) havertzEvents.push({
        fixture: `${fx.teams?.home?.name} vs ${fx.teams?.away?.name}`,
        events: havEvents.map(e=>({ type:e.type, detail:e.detail, minute:e.time?.elapsed }))
      });

      // Fixture player stats
      const fpRes = await fetch(`${BASE}/fixtures/players?fixture=${fx.fixture?.id}`,{headers});
      const fpData = (await fpRes.json()).response||[];
      for(const team of fpData){
        const hav = (team.players||[]).find(p=>p.player?.name?.toLowerCase().includes('havertz'));
        if(hav) havertzFixtureStats.push({
          fixture: `${fx.teams?.home?.name} vs ${fx.teams?.away?.name}`,
          goals: hav.statistics?.[0]?.goals?.total,
          assists: hav.statistics?.[0]?.goals?.assists,
          rating: hav.statistics?.[0]?.games?.rating,
          mins: hav.statistics?.[0]?.games?.minutes,
        });
      }
    }

    // Germany /players endpoint
    const germanyPlayersRes = await fetch(`${BASE}/players?league=${WC_LEAGUE}&season=${WC_SEASON}&team=${germanyId}`,{headers});
    const germanyPlayersData = await germanyPlayersRes.json();
    const havertzPlayer = (germanyPlayersData.response||[]).find(e=>e.player?.name?.toLowerCase().includes('havertz'));

    return res.status(200).json({
      germanyTeamId: germanyId,
      germanyFixtures: fixtures.map(f=>({
        id: f.fixture?.id,
        match: `${f.teams?.home?.name} vs ${f.teams?.away?.name}`,
        date: f.fixture?.date,
      })),
      havertzInTopScorers: havertzScorer
        ? { name: havertzScorer.player?.name, goals: havertzScorer.goals }
        : '❌ Not in topscorers',
      havertzInGermanyPlayersEndpoint: havertzPlayer
        ? { name: havertzPlayer.player?.name, goals: havertzPlayer.statistics?.[0]?.goals?.total, mins: havertzPlayer.statistics?.[0]?.games?.minutes }
        : '❌ Not in /players endpoint',
      havertzFixtureEvents: havertzEvents.length ? havertzEvents : '❌ No events found',
      havertzFixtureStats: havertzFixtureStats.length ? havertzFixtureStats : '❌ No fixture stats found',
    });

  } catch(e){
    return res.status(500).json({error:e.message});
  }
};
