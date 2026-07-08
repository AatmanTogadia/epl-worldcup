const BASE = 'https://v3.football.api-sports.io';
const WC_LEAGUE = 1;
const WC_SEASON = 2026;

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

module.exports = async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  const key = process.env.API_FOOTBALL_KEY;
  const headers = {'x-apisports-key': key};
  async function get(path){
    const r = await fetch(`${BASE}${path}`,{headers});
    const d = await r.json();
    return d.response||[];
  }

  try {
    // Get all finished fixtures
    const fixtures = await get(`/fixtures?league=${WC_LEAGUE}&season=${WC_SEASON}&status=FT`);
    const fixtureIds = fixtures.map(f=>f.fixture?.id).filter(Boolean);

    // Fetch ratings for all fixtures
    const ratingsCache = {};
    for(const fid of fixtureIds){
      await sleep(200);
      const fxPlayers = await get(`/fixtures/players?fixture=${fid}`);
      ratingsCache[fid] = {};
      for(const teamData of fxPlayers){
        for(const pe of (teamData.players||[])){
          const pid  = pe.player?.id;
          const stat = pe.statistics?.[0];
          if(pid) ratingsCache[fid][pid] = {
            rating:  stat?.games?.rating   ? parseFloat(stat.games.rating)  : null,
            mins:    stat?.games?.minutes   ? parseInt(stat.games.minutes)   : 0,
            goals:   stat?.goals?.total     ? parseInt(stat.goals.total)     : 0,
            assists: stat?.goals?.assists   ? parseInt(stat.goals.assists)   : 0,
            yellow:  stat?.cards?.yellow    ? parseInt(stat.cards.yellow)    : 0,
            red:    (stat?.cards?.red||0)+(stat?.cards?.yellowred||0),
          };
        }
      }
    }

    return res.status(200).json({
      fixtureCount: fixtureIds.length,
      fixtureIds,
      ratingsCache,
    });

  } catch(e){
    return res.status(500).json({error:e.message});
  }
};
