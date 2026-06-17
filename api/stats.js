const BASE       = 'https://v3.football.api-sports.io';
const WC_LEAGUE  = 1;
const WC_SEASON  = 2026;
const EPL_LEAGUE = 39;
const EPL_SEASON = 2025;

// Clubs relegated from the Premier League — exclude entirely
const RELEGATED_CLUBS = ['West Ham', 'Burnley', 'Wolverhampton', 'Wolves'];
function isRelegated(clubName){
  if(!clubName) return false;
  return RELEGATED_CLUBS.some(c => clubName.toLowerCase().includes(c.toLowerCase()));
}

const STATS_TTL    = 30 * 60  * 1000;  // 30 mins
const WC_SQUAD_TTL = 24 * 3600* 1000;  // 24 hrs
const EPL_SQUAD_TTL= 7  * 86400*1000;  // 7 days
const RATINGS_TTL  = 24 * 3600* 1000;  // 24 hrs

function posLabel(pos){
  if(!pos) return '—';
  const p=pos.toUpperCase();
  if(p.includes('GOALKEEPER')) return 'GK';
  if(p.includes('DEFENDER'))   return 'DEF';
  if(p.includes('MIDFIELDER')) return 'MID';
  if(p.includes('ATTACKER')||p.includes('FORWARD')) return 'FWD';
  return pos;
}

// Simple in-memory cache — fast, reliable, no serialization issues
const C = {
  eplMap:   { data:null, at:0 },
  wcSquads: { data:null, at:0 },
  ratings:  { data:{},   at:0 },
  result:   { data:null, at:0 },
};

module.exports = async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS') return res.status(200).end();

  const key = process.env.API_FOOTBALL_KEY;
  if(!key) return res.status(500).json({error:'API_FOOTBALL_KEY not configured'});

  // Serve from in-memory cache if fresh
  if(C.result.data && Array.isArray(C.result.data.players) && (Date.now()-C.result.at)<STATS_TTL){
    return res.status(200).json({...C.result.data, cached:true,
      cacheAge: Math.round((Date.now()-C.result.at)/1000)+'s'});
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
        if(isRelegated(t.name)) continue; // skip relegated clubs entirely
        const squads = await get(`/players/squads?team=${t.id}`);
        for(const sq of squads)
          for(const p of (sq.players||[]))
            eplMap[p.id] = { club:t.name, clubLogo:t.logo||'', position:posLabel(p.position) };
      }
      C.eplMap = { data:eplMap, at:Date.now() };
    }

    // ── STEP 2: WC squad map — 24 hr cache ──
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
              teamId:   t.id,
            };
      }
      C.wcSquads = { data:wcSquads, at:Date.now() };
    }

    // ── STEP 3: Cross reference ──
    const playerMap = {};
    const wcTeamIds = new Set();
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
        minutes:     0, appearances:0,
        goals:       0, assists:    0,
        yellow:      0, red:        0,
        ratings:     [], avgRating: null,
      };
      if(wc.teamId) wcTeamIds.add(wc.teamId);
    }

    // ── STEP 4: All stats from finished fixtures (single source of truth) ──
    // goals, assists, minutes, ratings, cards — all from fixture player data
    // No need for separate topscorers/topassists/topcards calls
    const finishedFixtures = await get(`/fixtures?league=${WC_LEAGUE}&season=${WC_SEASON}&status=FT`);
    const fixtureIds = finishedFixtures.map(f=>f.fixture?.id).filter(Boolean);

    for(const fid of fixtureIds){
      if(C.ratings.data[fid]) continue;
      const fxPlayers = await get(`/fixtures/players?fixture=${fid}`);
      C.ratings.data[fid] = {};
      for(const teamData of fxPlayers){
        for(const pe of (teamData.players||[])){
          const pid    = pe.player?.id;
          const stat   = pe.statistics?.[0];
          if(pid) C.ratings.data[fid][pid] = {
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

    // Apply ratings, minutes, goals and assists from fixture data
    // This is more reliable than topscorers endpoint which can lag
    for(const [pid, pm] of Object.entries(playerMap)){
      const gameRatings = [];
      let totalMins    = 0;
      let totalGoals   = 0;
      let totalAssists = 0;
      let totalYellow  = 0;
      let totalRed     = 0;
      for(const fid of fixtureIds){
        const entry = C.ratings.data[fid]?.[parseInt(pid)];
        if(!entry) continue;
        if(entry.rating)  gameRatings.push(entry.rating);
        if(entry.mins)    totalMins    += entry.mins;
        if(entry.goals)   totalGoals   += entry.goals;
        if(entry.assists) totalAssists += entry.assists;
        if(entry.yellow)  totalYellow  += entry.yellow;
        if(entry.red)     totalRed     += entry.red;
      }
      if(gameRatings.length){
        pm.ratings   = gameRatings;
        pm.avgRating = Math.round((gameRatings.reduce((a,b)=>a+b,0)/gameRatings.length)*10)/10;
      }
      if(totalMins > pm.minutes)       pm.minutes = totalMins;
      if(totalGoals > pm.goals)         pm.goals   = totalGoals;
      if(totalAssists > pm.assists)     pm.assists  = totalAssists;
      if(totalYellow > pm.yellow)       pm.yellow  = totalYellow;
      if(totalRed > pm.red)             pm.red     = totalRed;
    }

    // ── STEP 6: Club leaderboard ──
    const clubStats = {};
    for(const pm of Object.values(playerMap)){
      if(!clubStats[pm.club]) clubStats[pm.club] = {
        club:pm.club, clubLogo:pm.clubLogo,
        players:0, goals:0, assists:0, totalMins:0, ratings:[]
      };
      const cs = clubStats[pm.club];
      cs.players++;
      cs.goals    += pm.goals||0;
      cs.assists  += pm.assists||0;
      cs.totalMins+= pm.minutes||0;
      if(pm.avgRating) cs.ratings.push(pm.avgRating);
    }

    const clubLeaderboard = Object.values(clubStats)
      .map(cs=>({
        ...cs,
        ga: cs.goals+cs.assists,
        avgRating: cs.ratings.length
          ? Math.round((cs.ratings.reduce((a,b)=>a+b,0)/cs.ratings.length)*10)/10
          : null,
      }))
      .sort((a,b)=>b.ga-a.ga||(b.avgRating||0)-(a.avgRating||0))
      .slice(0,20);

    const players = Object.values(playerMap);
    const result  = {
      players,
      clubLeaderboard,
      total:    players.length,
      source:   'api-football.com',
      updated:  new Date().toISOString(),
    };

    C.result = { data:result, at:Date.now() };
    return res.status(200).json({...result, cached:false});

  } catch(e){
    if(C.result.data && Array.isArray(C.result.data.players))
      return res.status(200).json({...C.result.data, cached:true, stale:true});
    return res.status(500).json({error:e.message});
  }
};
