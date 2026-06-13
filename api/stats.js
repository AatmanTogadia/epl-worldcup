const BASE       = 'https://v3.football.api-sports.io';
const WC_LEAGUE  = 1;
const WC_SEASON  = 2026;
const EPL_LEAGUE = 39;
const EPL_SEASON = 2025;

const STATS_TTL    = 5  * 60   * 1000;
const IDLE_TTL     = 6  * 3600 * 1000;
const WC_SQUAD_TTL = 24 * 3600 * 1000;
const EPL_SQUAD_TTL= 7  * 86400* 1000;

const WC_START = new Date('2026-06-11').getTime();
const WC_END   = new Date('2026-07-20').getTime();
function isMatchDay(){ const n=Date.now(); return n>=WC_START&&n<=WC_END; }

function posLabel(pos){
  if(!pos) return '—';
  const p=pos.toUpperCase();
  if(p.includes('GOALKEEPER')) return 'GK';
  if(p.includes('DEFENDER'))   return 'DEF';
  if(p.includes('MIDFIELDER')) return 'MID';
  if(p.includes('ATTACKER')||p.includes('FORWARD')) return 'FWD';
  return pos;
}

const C = {
  eplMap:   { data:null, at:0 },
  wcSquads: { data:null, at:0 },
  result:   { data:null, at:0 },
};

module.exports = async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS') return res.status(200).end();

  const key = process.env.API_FOOTBALL_KEY;
  if(!key) return res.status(500).json({error:'API_FOOTBALL_KEY not configured'});

  const ttl = isMatchDay() ? STATS_TTL : IDLE_TTL;

  if(C.result.data && (Date.now()-C.result.at)<ttl){
    return res.status(200).json({
      ...C.result.data,
      cached:true,
      cacheAge: Math.round((Date.now()-C.result.at)/1000)+'s'
    });
  }

  const headers = {'x-apisports-key': key};

  async function get(path){
    const r = await fetch(`${BASE}${path}`,{headers});
    const d = await r.json();
    if(d.errors && Object.keys(d.errors).length>0) throw new Error(JSON.stringify(d.errors));
    return d.response||[];
  }

  try {
    // ── STEP 1: EPL squad map — 7 day cache ──
    let eplMap = {};
    if(C.eplMap.data && (Date.now()-C.eplMap.at)<EPL_SQUAD_TTL){
      eplMap = C.eplMap.data;
    } else {
      const eplTeams = await get(`/teams?league=${EPL_LEAGUE}&season=${EPL_SEASON}`);
      for(const e of eplTeams){
        const t = e.team;
        const squads = await get(`/players/squads?team=${t.id}`);
        for(const sq of squads)
          for(const p of (sq.players||[]))
            eplMap[p.id] = { club:t.name, clubLogo:t.logo||'', position:posLabel(p.position) };
      }
      C.eplMap = { data:eplMap, at:Date.now() };
    }

    // ── STEP 2: WC squad map — 24 hr cache ──
    // This gives us NAMES + nations for everyone including "yet to play"
    let wcSquads = {};
    if(C.wcSquads.data && (Date.now()-C.wcSquads.at)<WC_SQUAD_TTL){
      wcSquads = C.wcSquads.data;
    } else {
      const wcTeams = await get(`/teams?league=${WC_LEAGUE}&season=${WC_SEASON}`);
      for(const e of wcTeams){
        const t = e.team;
        const squads = await get(`/players/squads?team=${t.id}`);
        for(const sq of squads)
          for(const p of (sq.players||[]))
            wcSquads[p.id] = {
              nation:   t.name,
              flag:     t.logo||'',
              name:     p.name||'Unknown',
              position: posLabel(p.position),
              teamId:   t.id,   // store team ID for targeted fetching
            };
      }
      C.wcSquads = { data:wcSquads, at:Date.now() };
    }

    // ── STEP 3: Cross-reference — all EPL players at WC, 0 stats baseline ──
    const playerMap = {};
    const wcTeamIds = new Set(); // WC team IDs that have EPL players

    for(const [pid, epl] of Object.entries(eplMap)){
      const wc = wcSquads[pid];
      if(!wc) continue;
      playerMap[pid] = {
        id:          parseInt(pid),
        name:        wc.name,
        nationality: wc.nation,
        flag:        wc.flag,
        club:        epl.club,
        clubLogo:    epl.clubLogo,
        position:    epl.position||wc.position,
        minutes:     0, appearances: 0,
        goals:       0, assists:     0,
        yellow:      0, red:         0,
      };
      if(wc.teamId) wcTeamIds.add(wc.teamId);
    }

    // ── STEP 4: Top stats — 4 parallel calls ──
    function applyEntry(entry){
      const p    = entry.player;
      const stat = entry.statistics?.[0];
      if(!stat||!playerMap[p.id]) return;
      const pm = playerMap[p.id];
      if(p.name) pm.name = p.name;
      if(stat.games?.minutes)      pm.minutes     = stat.games.minutes;
      if(stat.games?.appearences)  pm.appearances = stat.games.appearences;
      if(stat.goals?.total)        pm.goals       = stat.goals.total;
      if(stat.goals?.assists)      pm.assists     = stat.goals.assists;
      if(stat.cards?.yellow)       pm.yellow      = stat.cards.yellow;
      const red=(stat.cards?.red||0)+(stat.cards?.yellowred||0);
      if(red) pm.red=red;
    }

    const [scorers, topAssists, topYellow, topRed] = await Promise.all([
      get(`/players/topscorers?league=${WC_LEAGUE}&season=${WC_SEASON}`),
      get(`/players/topassists?league=${WC_LEAGUE}&season=${WC_SEASON}`),
      get(`/players/topyellowcards?league=${WC_LEAGUE}&season=${WC_SEASON}`),
      get(`/players/topredcards?league=${WC_LEAGUE}&season=${WC_SEASON}`),
    ]);
    [...scorers,...topAssists,...topYellow,...topRed].forEach(applyEntry);

    // ── STEP 5: Fetch player stats PER WC TEAM that has EPL players ──
    // This is the Robinson fix — gets minutes for non-scorers
    // Instead of paginating ALL WC players, we only fetch teams with EPL players
    // Much more targeted — typically 10-15 national teams max
    for(const teamId of wcTeamIds){
      const teamPlayers = await get(`/players?league=${WC_LEAGUE}&season=${WC_SEASON}&team=${teamId}`);
      for(const entry of teamPlayers){
        const p    = entry.player;
        const stat = entry.statistics?.[0];
        if(!stat||!playerMap[p.id]) continue;
        const pm = playerMap[p.id];
        if(p.name) pm.name = p.name;
        // Update minutes for anyone who played — this catches Robinson
        if(stat.games?.minutes && stat.games.minutes > pm.minutes)
          pm.minutes = stat.games.minutes;
        if(stat.games?.appearences && stat.games.appearences > pm.appearances)
          pm.appearances = stat.games.appearences;
        // Only update goals/assists/cards if not already set by top endpoints
        if(!pm.goals   && stat.goals?.total)   pm.goals   = stat.goals.total;
        if(!pm.assists && stat.goals?.assists)  pm.assists = stat.goals.assists;
        if(!pm.yellow  && stat.cards?.yellow)   pm.yellow  = stat.cards.yellow;
        const red=(stat.cards?.red||0)+(stat.cards?.yellowred||0);
        if(!pm.red && red) pm.red = red;
      }
    }

    const players = Object.values(playerMap);
    const result  = {
      players,
      total:    players.length,
      matchDay: isMatchDay(),
      source:   'api-football.com',
      updated:  new Date().toISOString(),
    };

    C.result = { data:result, at:Date.now() };
    return res.status(200).json({...result, cached:false});

  } catch(e){
    if(C.result.data)
      return res.status(200).json({...C.result.data,cached:true,stale:true,error:e.message});
    return res.status(500).json({error:e.message});
  }
};
