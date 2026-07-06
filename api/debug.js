const BASE = 'https://v3.football.api-sports.io';
const WC_LEAGUE  = 1;
const WC_SEASON  = 2026;
const EPL_LEAGUE = 39;
const EPL_SEASON = 2025;

const RELEGATED = ['West Ham','Burnley','Wolverhampton','Wolves'];
function isRelegated(n){ return RELEGATED.some(c=>n?.toLowerCase().includes(c.toLowerCase().split(' ')[0])); }

module.exports = async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  const key = process.env.API_FOOTBALL_KEY;
  const headers = {'x-apisports-key': key};
  async function get(path){
    const r = await fetch(`${BASE}${path}`,{headers});
    const d = await r.json();
    return d.response||[];
  }
  function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

  try {
    // Fetch EPL squads
    const eplMap = {};
    const eplTeams = await get(`/teams?league=${EPL_LEAGUE}&season=${EPL_SEASON}`);
    for(const e of eplTeams){
      const t = e.team;
      if(isRelegated(t.name)) continue;
      await sleep(150);
      const squads = await get(`/players/squads?team=${t.id}`);
      for(const sq of squads)
        for(const p of (sq.players||[]))
          eplMap[p.id] = { club:t.name, clubLogo:t.logo||'', position:p.position||'—' };
    }

    // Fetch WC squads
    const wcMap = {};
    const wcTeams = await get(`/teams?league=${WC_LEAGUE}&season=${WC_SEASON}`);
    for(const e of wcTeams){
      const t = e.team;
      await sleep(150);
      const squads = await get(`/players/squads?team=${t.id}`);
      for(const sq of squads)
        for(const p of (sq.players||[]))
          wcMap[p.id] = { nation:t.name, flag:t.logo||'', name:p.name||'', position:p.position||'—', teamId:t.id };
    }

    return res.status(200).json({
      eplPlayerCount: Object.keys(eplMap).length,
      wcPlayerCount:  Object.keys(wcMap).length,
      eplMap,
      wcMap,
    });

  } catch(e){
    return res.status(500).json({error:e.message});
  }
};
