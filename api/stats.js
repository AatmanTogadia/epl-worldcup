const BASE       = 'https://v3.football.api-sports.io';
const WC_LEAGUE  = 1;
const WC_SEASON  = 2026;
const EPL_LEAGUE = 39;
const EPL_SEASON = 2025;

// Cache TTLs in seconds (for Redis EX parameter)
const STATS_TTL    = 60 * 60;        // 1 hour
const WC_SQUAD_TTL = 24 * 3600;      // 24 hrs
const EPL_SQUAD_TTL= 7  * 86400;     // 7 days
const RATINGS_TTL  = 24 * 3600;      // 24 hrs

function posLabel(pos){
  if(!pos) return '—';
  const p=pos.toUpperCase();
  if(p.includes('GOALKEEPER')) return 'GK';
  if(p.includes('DEFENDER'))   return 'DEF';
  if(p.includes('MIDFIELDER')) return 'MID';
  if(p.includes('ATTACKER')||p.includes('FORWARD')) return 'FWD';
  return pos;
}

// ── Upstash Redis helpers ──
// Uses REST API — no npm package needed, works in Vercel serverless
async function redisGet(key){
  const url  = process.env.KV_REST_API_URL;
  const token= process.env.KV_REST_API_TOKEN;
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const d = await r.json();
  if(!d.result) return null;
  try { return JSON.parse(d.result); } catch{ return d.result; }
}

async function redisSet(key, value, ttlSeconds){
  const url  = process.env.KV_REST_API_URL;
  const token= process.env.KV_REST_API_TOKEN;
  await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: JSON.stringify(value), ex: ttlSeconds })
  });
}

module.exports = async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS') return res.status(200).end();

  const key = process.env.API_FOOTBALL_KEY;
  if(!key) return res.status(500).json({error:'API_FOOTBALL_KEY not configured'});

  const headers = {'x-apisports-key': key};
  async function get(path){
    const r = await fetch(`${BASE}${path}`,{headers});
    const d = await r.json();
    if(d.errors && Object.keys(d.errors).length>0) throw new Error(JSON.stringify(d.errors));
    return d.response||[];
  }

  try {
    // ── Check Redis cache first — shared across ALL Vercel instances ──
    const cached = await redisGet('eplstats:result');
    if(cached) {
      return res.status(200).json({...cached, cached:true});
    }

    // ── STEP 1: EPL squad map — 7 day Redis cache ──
    let eplMap = await redisGet('eplstats:eplmap');
    if(!eplMap){
      eplMap = {};
      const eplTeams = await get(`/teams?league=${EPL_LEAGUE}&season=${EPL_SEASON}`);
      for(const e of eplTeams){
        const t = e.team;
        const squads = await get(`/players/squads?team=${t.id}`);
        for(const sq of squads)
          for(const p of (sq.players||[]))
            eplMap[p.id] = { club:t.name, clubLogo:t.logo||'', position:posLabel(p.position) };
      }
      await redisSet('eplstats:eplmap', eplMap, EPL_SQUAD_TTL);
    }

    // ── STEP 2: WC squad map — 24hr Redis cache ──
    let wcSquads = await redisGet('eplstats:wcsquads');
    if(!wcSquads){
      wcSquads = {};
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
      await redisSet('eplstats:wcsquads', wcSquads, WC_SQUAD_TTL);
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
        minutes:     0, appearances: 0,
        goals:       0, assists:     0,
        yellow:      0, red:         0,
        ratings:     [],
        avgRating:   null,
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

    // ── STEP 5: Ratings AND minutes from finished fixtures ──
    const finishedFixtures = await get(`/fixtures?league=${WC_LEAGUE}&season=${WC_SEASON}&status=FT`);
    const fixtureIds = finishedFixtures.map(f=>f.fixture?.id).filter(Boolean);

    // Load existing ratings cache from Redis
    let ratingsCache = await redisGet('eplstats:ratings') || {};
    let ratingsCacheUpdated = false;

    for(const fid of fixtureIds){
      if(ratingsCache[fid]) continue; // already cached in Redis
      const fxPlayers = await get(`/fixtures/players?fixture=${fid}`);
      ratingsCache[fid] = {};
      for(const teamData of fxPlayers){
        for(const pe of (teamData.players||[])){
          const pid    = pe.player?.id;
          const stat   = pe.statistics?.[0];
          const rating = stat?.games?.rating;
          const mins   = stat?.games?.minutes;
          if(pid) ratingsCache[fid][pid] = {
            rating: rating ? parseFloat(rating) : null,
            mins:   mins   ? parseInt(mins)     : 0,
          };
        }
      }
      ratingsCacheUpdated = true;
    }

    // Save ratings cache back to Redis if updated
    if(ratingsCacheUpdated){
      await redisSet('eplstats:ratings', ratingsCache, RATINGS_TTL);
    }

    // Apply ratings and minutes from fixture data
    for(const [pid, pm] of Object.entries(playerMap)){
      const gameRatings = [];
      let totalMins = 0;
      for(const fid of fixtureIds){
        const entry = ratingsCache[fid]?.[parseInt(pid)];
        if(!entry) continue;
        if(entry.rating) gameRatings.push(entry.rating);
        if(entry.mins)   totalMins += entry.mins;
      }
      if(gameRatings.length){
        pm.ratings   = gameRatings;
        pm.avgRating = Math.round((gameRatings.reduce((a,b)=>a+b,0)/gameRatings.length)*10)/10;
      }
      if(totalMins > pm.minutes) pm.minutes = totalMins;
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
        totalMins: cs.totalMins,
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

    // Save result to Redis — expires in 10 mins
    await redisSet('eplstats:result', result, STATS_TTL);

    return res.status(200).json({...result, cached:false});

  } catch(e){
    // Try to serve stale Redis cache on error
    const stale = await redisGet('eplstats:result');
    if(stale) return res.status(200).json({...stale, cached:true, stale:true, error:e.message});
    return res.status(500).json({error:e.message});
  }
};
