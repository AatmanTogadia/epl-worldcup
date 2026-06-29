const BASE = 'https://v3.football.api-sports.io';
const WC_LEAGUE = 1;
const WC_SEASON = 2026;

module.exports = async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  const key = process.env.API_FOOTBALL_KEY;
  const headers = {'x-apisports-key': key};

  try {
    // Check ALL live fixtures (any league)
    const allLiveRes = await fetch(`${BASE}/fixtures?live=all`,{headers});
    const allLive = (await allLiveRes.json()).response||[];

    // Check WC live fixtures specifically with league+season filter
    const wcLiveRes = await fetch(`${BASE}/fixtures?league=${WC_LEAGUE}&season=${WC_SEASON}&live=all`,{headers});
    const wcLiveData = await wcLiveRes.json();
    const wcLive = wcLiveData.response||[];

    return res.status(200).json({
      allLiveCount: allLive.length,
      wcLiveCount: wcLive.length,
      wcLiveErrors: wcLiveData.errors,
      wcLiveMatches: wcLive.map(f=>({
        match: `${f.teams?.home?.name} vs ${f.teams?.away?.name}`,
        status: f.fixture?.status?.long,
        minute: f.fixture?.status?.elapsed,
      })),
      sampleAllLive: allLive.slice(0,5).map(f=>({
        league: f.league?.name,
        match: `${f.teams?.home?.name} vs ${f.teams?.away?.name}`,
      })),
    });
  } catch(e){
    return res.status(500).json({error:e.message});
  }
};
