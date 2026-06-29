const BASE       = 'https://v3.football.api-sports.io';
const WC_LEAGUE  = 1;
const WC_SEASON  = 2026;
const EPL_LEAGUE = 39;
const EPL_SEASON = 2025;
const LIVE_TTL   = 5 * 60 * 1000; // 5 mins

const RELEGATED_CLUBS = ['West Ham', 'Burnley', 'Wolverhampton', 'Wolves'];
function isRelegated(clubName){
  if(!clubName) return false;
  return RELEGATED_CLUBS.some(c => clubName.toLowerCase().includes(c.toLowerCase()));
}

// Separate cache from stats.js — independent 5 min refresh
const C = {
  eplMap: { data:null, at:0 },
  result: { data:null, at:0 },
};
const EPL_SQUAD_TTL = 7 * 86400 * 1000; // 7 days, shared logic with stats.js

module.exports = async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS') return res.status(200).end();

  const key = process.env.API_FOOTBALL_KEY;
  if(!key) return res.status(500).json({error:'API_FOOTBALL_KEY not configured'});

  // Serve from cache if fresh
  if(C.result.data && (Date.now()-C.result.at) < LIVE_TTL){
    return res.status(200).json({...C.result.data, cached:true});
  }

  const headers = {'x-apisports-key': key};
  async function get(path){
    const r = await fetch(`${BASE}${path}`,{headers});
    const d = await r.json();
    if(d.errors && Object.keys(d.errors).length>0) throw new Error(JSON.stringify(d.errors));
    return d.response||[];
  }

  try {
    // ── Step 0: Cheap check first — is anything even live? ──
    // Only 1 API call. If nothing's live, skip all the expensive squad fetching entirely.
    const liveFixtures = await get(`/fixtures?league=${WC_LEAGUE}&season=${WC_SEASON}&live=all`);

    if(!liveFixtures.length){
      const result = { live:false, matches:[], message:'No World Cup matches in progress right now.' };
      C.result = { data:result, at:Date.now() };
      return res.status(200).json({...result, cached:false});
    }

    // ── Step 1: EPL squad map — only fetched if a match is actually live ──
    let eplMap = {};
    if(C.eplMap.data && (Date.now()-C.eplMap.at)<EPL_SQUAD_TTL){
      eplMap = C.eplMap.data;
    } else {
      const eplTeams = await get(`/teams?league=${EPL_LEAGUE}&season=${EPL_SEASON}`);
      for(const e of eplTeams){
        const t = e.team;
        if(isRelegated(t.name)) continue;
        const squads = await get(`/players/squads?team=${t.id}`);
        for(const sq of squads)
          for(const p of (sq.players||[]))
            eplMap[p.id] = { club:t.name, clubLogo:t.logo||'' };
      }
      C.eplMap = { data:eplMap, at:Date.now() };
    }

    // ── Step 3: For each live fixture, get player stats ──
    const liveMatches = [];
    for(const fx of liveFixtures){
      const fid = fx.fixture?.id;
      const home = fx.teams?.home;
      const away = fx.teams?.away;
      const homeScore = fx.goals?.home ?? 0;
      const awayScore = fx.goals?.away ?? 0;
      const minute = fx.fixture?.status?.elapsed;

      const fxPlayers = await get(`/fixtures/players?fixture=${fid}`);
      const eplPlayersInMatch = [];

      for(const teamData of fxPlayers){
        const teamIsHome = teamData.team?.id === home?.id;
        const opponent = teamIsHome ? away?.name : home?.name;
        const myScore   = teamIsHome ? homeScore : awayScore;
        const oppScore  = teamIsHome ? awayScore : homeScore;

        for(const pe of (teamData.players||[])){
          const pid = pe.player?.id;
          const epl = eplMap[pid];
          if(!epl) continue; // not an EPL player

          const stat = pe.statistics?.[0];
          if(!stat?.games?.minutes) continue; // hasn't played in this match

          eplPlayersInMatch.push({
            id:        pid,
            name:      pe.player?.name,
            club:      epl.club,
            clubLogo:  epl.clubLogo,
            nation:    teamData.team?.name,
            opponent,
            myScore, oppScore,
            minute,
            goals:    stat.goals?.total   || 0,
            assists:  stat.goals?.assists || 0,
          });
        }
      }

      if(eplPlayersInMatch.length){
        liveMatches.push({
          fixtureId: fid,
          home: home?.name, away: away?.name,
          homeScore, awayScore, minute,
          players: eplPlayersInMatch,
        });
      }
    }

    const result = {
      live: liveMatches.length > 0,
      matches: liveMatches,
      message: liveMatches.length ? null : 'No EPL players currently in live matches.',
    };

    C.result = { data:result, at:Date.now() };
    return res.status(200).json({...result, cached:false});

  } catch(e){
    if(C.result.data) return res.status(200).json({...C.result.data, cached:true, stale:true});
    return res.status(500).json({error:e.message});
  }
};
