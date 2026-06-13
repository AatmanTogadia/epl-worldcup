const BASE = 'https://v3.football.api-sports.io';
const WC_LEAGUE = 1;
const WC_SEASON = 2026;

module.exports = async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  const key = process.env.API_FOOTBALL_KEY;
  const headers = {'x-apisports-key': key};

  try {
    // Get a finished WC fixture
    const fxRes  = await fetch(`${BASE}/fixtures?league=${WC_LEAGUE}&season=${WC_SEASON}&status=FT`, {headers});
    const fxData = await fxRes.json();
    const fixtures = fxData.response || [];

    if(!fixtures.length) return res.status(200).json({msg:'No finished fixtures yet'});

    // Take the first fixture
    const fx  = fixtures[0];
    const fid = fx.fixture?.id;

    // Fetch player stats for that fixture
    const fpRes  = await fetch(`${BASE}/fixtures/players?fixture=${fid}`, {headers});
    const fpData = await fpRes.json();

    // Extract a sample of ratings
    const sample = [];
    for(const teamData of (fpData.response||[])){
      for(const pe of (teamData.players||[]).slice(0,3)){
        sample.push({
          name:   pe.player?.name,
          rating: pe.statistics?.[0]?.games?.rating,
          mins:   pe.statistics?.[0]?.games?.minutes,
        });
      }
    }

    return res.status(200).json({
      fixtureId:   fid,
      fixture:     `${fx.teams?.home?.name} vs ${fx.teams?.away?.name}`,
      totalFixtures: fixtures.length,
      samplePlayers: sample,
      rawErrors: fpData.errors,
    });

  } catch(e){
    return res.status(500).json({error: e.message});
  }
};
