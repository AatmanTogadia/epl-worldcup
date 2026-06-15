const BASE = 'https://v3.football.api-sports.io';
const WC_LEAGUE = 1;
const WC_SEASON = 2026;

module.exports = async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  const key = process.env.API_FOOTBALL_KEY;
  const headers = {'x-apisports-key': key};

  try {
    // Find Germany fixtures
    const wcTeamsRes = await fetch(`${BASE}/teams?league=${WC_LEAGUE}&season=${WC_SEASON}`,{headers});
    const wcTeams = (await wcTeamsRes.json()).response||[];
    const germany = wcTeams.find(e=>e.team?.name?.toLowerCase().includes('germany'));

    const fxRes = await fetch(`${BASE}/fixtures?league=${WC_LEAGUE}&season=${WC_SEASON}&team=${germany?.team?.id}&status=FT`,{headers});
    const fixtures = (await fxRes.json()).response||[];

    // Check topscorers for Havertz
    const scorersRes = await fetch(`${BASE}/players/topscorers?league=${WC_LEAGUE}&season=${WC_SEASON}`,{headers});
    const scorers = (await scorersRes.json()).response||[];
    const havertzScorer = scorers.find(e=>e.player?.name?.toLowerCase().includes('havertz'));

    // Check fixture events for Havertz goal
    let havertzEvents = [];
    for(const fx of fixtures){
      const evRes = await fetch(`${BASE}/fixtures/events?fixture=${fx.fixture?.id}`,{headers});
      const events = (await evRes.json()).response||[];
      const hav = events.filter(e=>e.player?.name?.toLowerCase().includes('havertz'));
      if(hav.length) havertzEvents.push({
        fixture: `${fx.teams?.home?.name} vs ${fx.teams?.away?.name}`,
        events: hav.map(e=>({ type:e.type, detail:e.detail, minute:e.time?.elapsed }))
      });
    }

    // Check fixture players for Havertz stats
    let havertzFixtureStats = [];
    for(const fx of fixtures){
      const fpRes = await fetch(`${BASE}/fixtures/players?fixture=${fx.fixture?.id}`,{headers});
      const fpData = (await fpRes.json()).response||[];
      for(const team of fpData){
        const hav = (team.players||[]).find(p=>p.player?.name?.toLowerCase().includes('havertz'));
        if(hav) havertzFixtureStats.push({
          fixture: `${fx.teams?.home?.name} vs ${fx.teams?.away?.name}`,
          goals: hav.statistics?.[0]?.goals?.total,
          rating: hav.statistics?.[0]?.games?.rating,
          mins: hav.statistics?.[0]?.games?.minutes,
        });
      }
    }

    return res.status(200).json({
      havertzInTopScorers: havertzScorer ? {
        goals: havertzScorer.goals,
        name: havertzScorer.player?.name,
      } : '❌ Not in top scorers yet',
      havertzFixtureEvents: havertzEvents,
      havertzFixtureStats,
    });

  } catch(e){
    return res.status(500).json({error:e.message});
  }
};
