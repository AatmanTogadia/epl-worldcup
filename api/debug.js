const BASE = 'https://v3.football.api-sports.io';
const WC_LEAGUE = 1;
const WC_SEASON = 2026;

module.exports = async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  const key = process.env.API_FOOTBALL_KEY;
  const headers = {'x-apisports-key': key};

  try {
    // Check all finished fixtures
    const ftRes  = await fetch(`${BASE}/fixtures?league=${WC_LEAGUE}&season=${WC_SEASON}&status=FT`,{headers});
    const ftData = await ftRes.json();
    const finished = ftData.response || [];

    // Check live fixtures
    const liveRes  = await fetch(`${BASE}/fixtures?live=all`,{headers});
    const liveData = await liveRes.json();
    const live = liveData.response || [];

    // Check today's fixtures
    const today = new Date().toISOString().split('T')[0];
    const todayRes  = await fetch(`${BASE}/fixtures?league=${WC_LEAGUE}&season=${WC_SEASON}&date=${today}`,{headers});
    const todayData = await todayRes.json();
    const todayFx = todayData.response || [];

    // Get last finished fixture player stats
    let sampleRatings = [];
    if(finished.length > 0){
      const lastFx = finished[finished.length-1];
      const fpRes = await fetch(`${BASE}/fixtures/players?fixture=${lastFx.fixture?.id}`,{headers});
      const fpData = await fpRes.json();
      const teams = fpData.response || [];
      for(const t of teams){
        for(const p of (t.players||[]).slice(0,2)){
          sampleRatings.push({
            name:   p.player?.name,
            rating: p.statistics?.[0]?.games?.rating,
            mins:   p.statistics?.[0]?.games?.minutes,
          });
        }
      }
    }

    // Check topscorers
    const scorersRes = await fetch(`${BASE}/players/topscorers?league=${WC_LEAGUE}&season=${WC_SEASON}`,{headers});
    const scorersData = await scorersRes.json();

    return res.status(200).json({
      today,
      finishedFixtures: finished.map(f=>({
        id: f.fixture?.id,
        match: `${f.teams?.home?.name} vs ${f.teams?.away?.name}`,
        date: f.fixture?.date,
        status: f.fixture?.status?.long,
      })),
      liveFixtures: live.map(f=>({
        id: f.fixture?.id,
        match: `${f.teams?.home?.name} vs ${f.teams?.away?.name}`,
        minute: f.fixture?.status?.elapsed,
      })),
      todayFixtures: todayFx.map(f=>({
        id: f.fixture?.id,
        match: `${f.teams?.home?.name} vs ${f.teams?.away?.name}`,
        status: f.fixture?.status?.long,
        date: f.fixture?.date,
      })),
      topScorers: (scorersData.response||[]).slice(0,5).map(e=>({
        name: e.player?.name,
        goals: e.goals,
        team: e.statistics?.[0]?.team?.name,
      })),
      sampleRatingsFromLastMatch: sampleRatings,
      apiErrors: {
        ft: ftData.errors,
        live: liveData.errors,
        today: todayData.errors,
      }
    });

  } catch(e){
    return res.status(500).json({error: e.message});
  }
};
