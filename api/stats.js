const BASE       = 'https://v3.football.api-sports.io';
const WC_LEAGUE  = 1;
const WC_SEASON  = 2026;
const EPL_LEAGUE = 39;
const EPL_SEASON = 2025;

const STATS_TTL    = 5  * 60   * 1000;   // 5 mins  — during tournament
const IDLE_TTL     = 6  * 3600 * 1000;   // 6 hrs   — no matches
const WC_SQUAD_TTL = 24 * 3600 * 1000;   // 24 hrs
const EPL_SQUAD_TTL= 7  * 86400* 1000;   // 7 days

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

// In-memory cache — persists across requests on same Vercel instance
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

  // Return cached result if still fresh
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
    // ── STEP 1: EPL squad map — 7 day cache (~21 calls once a week) ──
    // playerId → { club, clubLogo, position }
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

    // ── STEP 2: WC squad map — 24 hr cache (~49 calls once a day) ──
    // playerId → { nation, flag, name, position }
    // KEY FIX: We get player NAMES here from the squad list
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
              name:     p.name||'Unknown',   // ← NAME from WC squad roster
              position: posLabel(p.position),
            };
      }
      C.wcSquads = { data:wcSquads, at:Date.now() };
    }

    // ── STEP 3: Cross-reference — all EPL players at WC, start with 0 stats ──
    const playerMap = {};
    for(const [pid, epl] of Object.entries(eplMap)){
      const wc = wcSquads[pid];
      if(!wc) continue; // not at the WC
      playerMap[pid] = {
        id:          parseInt(pid),
        name:        wc.name,               // ← from WC squad, always populated
        nationality: wc.nation,
        flag:        wc.flag,
        club:        epl.club,
        clubLogo:    epl.clubLogo,
        position:    epl.position||wc.position,
        minutes:     0, appearances: 0,
        goals:       0, assists:     0,
        yellow:      0, red:         0,
      };
    }

    // ── STEP 4: Layer in stats — just 4 API calls ──
    // topscorers/topassists/topcards — covers everyone with goals, assists or cards
    // This is where Robinson's minutes would show IF he scored/got a card
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
      const red = (stat.cards?.red||0)+(stat.cards?.yellowred||0);
      if(red) pm.red = red;
    }

    const [scorers, topAssists, topYellow, topRed] = await Promise.all([
      get(`/players/topscorers?league=${WC_LEAGUE}&season=${WC_SEASON}`),
      get(`/players/topassists?league=${WC_LEAGUE}&season=${WC_SEASON}`),
      get(`/players/topyellowcards?league=${WC_LEAGUE}&season=${WC_SEASON}`),
      get(`/players/topredcards?league=${WC_LEAGUE}&season=${WC_SEASON}`),
    ]);
    [...scorers,...topAssists,...topYellow,...topRed].forEach(applyEntry);

    // ── STEP 5: Get minutes for ALL players who played — 1 call ──
    // /players endpoint with league+season gives us full stats per player
    // We paginate but only update minutes (goals etc already handled above)
    // This catches Robinson and anyone else who played but didn't score/get cards
    const p1 = await fetch(`${BASE}/players?league=${WC_LEAGUE}&season=${WC_SEASON}&page=1`,{headers});
    const p1d = await p1.json();
    const totalPages = Math.min(p1d.paging?.total||1, 8); // cap at 8 pages
    const allStats   = [...(p1d.response||[])];

    for(let pg=2; pg<=totalPages; pg++){
      const rows = await get(`/players?league=${WC_LEAGUE}&season=${WC_SEASON}&page=${pg}`);
      allStats.push(...rows);
    }

    // Apply minutes for ALL players — this is the Robinson fix
    for(const entry of allStats){
      const p    = entry.player;
      const stat = entry.statistics?.[0];
      if(!stat||!playerMap[p.id]) continue;
      const pm = playerMap[p.id];
      if(p.name) pm.name = p.name;
      // Only update minutes if API has a value — don't overwrite with 0
      if(stat.games?.minutes)     pm.minutes     = stat.games.minutes;
      if(stat.games?.appearences) pm.appearances = stat.games.appearences;
      // Stats already set from topscorers/topassists above — don't overwrite with nulls
      if(stat.goals?.total)       pm.goals   = stat.goals.total;
      if(stat.goals?.assists)     pm.assists  = stat.goals.assists;
      if(stat.cards?.yellow)      pm.yellow   = stat.cards.yellow;
      const red=(stat.cards?.red||0)+(stat.cards?.yellowred||0);
      if(red) pm.red=red;
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
