const BASE = 'https://v3.football.api-sports.io';
const WC_LEAGUE = 1;
const WC_SEASON = 2026;

module.exports = async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  const key = process.env.API_FOOTBALL_KEY;
  const headers = {'x-apisports-key': key};

  try {
    // Find Switzerland team ID in WC
    const teamsRes = await fetch(`${BASE}/teams?league=${WC_LEAGUE}&season=${WC_SEASON}`,{headers});
    const teamsData = await teamsRes.json();
    const sui = (teamsData.response||[]).find(e=>e.team?.name?.toLowerCase().includes('swi'));
    const suiId = sui?.team?.id;

    // Fetch Switzerland players in WC
    const playersRes = await fetch(`${BASE}/players?league=${WC_LEAGUE}&season=${WC_SEASON}&team=${suiId}`,{headers});
    const playersData = await playersRes.json();

    // Look for Xhaka and Amdouni
    const relevant = (playersData.response||[]).filter(e=>
      e.player?.name?.toLowerCase().includes('xhaka') ||
      e.player?.name?.toLowerCase().includes('amdouni') ||
      e.player?.name?.toLowerCase().includes('ndoye') ||
      e.player?.name?.toLowerCase().includes('zakaria')
    );

    // Also check fixture players for Qatar vs Switzerland
    const qatSuiFixture = 1489373;
    const fxRes = await fetch(`${BASE}/fixtures/players?fixture=${qatSuiFixture}`,{headers});
    const fxData = await fxRes.json();
    const fxRelevant = [];
    for(const t of (fxData.response||[])){
      for(const p of (t.players||[])){
        const name = p.player?.name?.toLowerCase();
        if(name?.includes('xhaka')||name?.includes('amdouni')||name?.includes('ndoye')){
          fxRelevant.push({
            name: p.player?.name,
            mins: p.statistics?.[0]?.games?.minutes,
            rating: p.statistics?.[0]?.games?.rating,
            playerId: p.player?.id,
          });
        }
      }
    }

    return res.status(200).json({
      suiTeamId: suiId,
      suiTeamName: sui?.team?.name,
      playersApiTotal: playersData.results,
      playersApiPaging: playersData.paging,
      relevantPlayers: relevant.map(e=>({
        id: e.player?.id,
        name: e.player?.name,
        minutes: e.statistics?.[0]?.games?.minutes,
        appearances: e.statistics?.[0]?.games?.appearences,
        goals: e.statistics?.[0]?.goals?.total,
      })),
      fixturePlayerData: fxRelevant,
    });

  } catch(e){
    return res.status(500).json({error: e.message});
  }
};
