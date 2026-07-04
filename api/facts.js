const FACTS_TTL = 60 * 60 * 1000; // 1 hour — facts don't need to change every 30 mins

const C = { result: { data: null, at: 0 } };

module.exports = async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS') return res.status(200).end();

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const footballKey  = process.env.API_FOOTBALL_KEY;
  if(!anthropicKey) return res.status(500).json({error:'ANTHROPIC_API_KEY not configured'});
  if(!footballKey)  return res.status(500).json({error:'API_FOOTBALL_KEY not configured'});

  // Serve from cache if fresh
  if(C.result.data && (Date.now()-C.result.at) < FACTS_TTL){
    return res.status(200).json({...C.result.data, cached:true});
  }

  const footballHeaders = {'x-apisports-key': footballKey};

  try {
    // ── Step 1: Fetch top scorers from API-Football ──
    const [scorersRes, assistsRes, fixturesRes] = await Promise.all([
      fetch(`https://v3.football.api-sports.io/players/topscorers?league=1&season=2026`, {headers: footballHeaders}),
      fetch(`https://v3.football.api-sports.io/players/topassists?league=1&season=2026`,  {headers: footballHeaders}),
      fetch(`https://v3.football.api-sports.io/fixtures?league=1&season=2026&status=FT`,  {headers: footballHeaders}),
    ]);

    const scorers  = (await scorersRes.json()).response  || [];
    const assists  = (await assistsRes.json()).response  || [];
    const fixtures = (await fixturesRes.json()).response || [];

    const EPL_CLUBS = ['Arsenal','Chelsea','Manchester City','Manchester United','Liverpool',
      'Tottenham','Newcastle','Aston Villa','Brighton','Brentford','Fulham',
      'Nottingham Forest','Everton','Crystal Palace','Leicester','Southampton',
      'Ipswich','Bournemouth','Sunderland','Leeds'];

    function isEPL(teamName){
      if(!teamName) return false;
      return EPL_CLUBS.some(c => teamName.toLowerCase().includes(c.toLowerCase().split(' ')[0]));
    }

    // Get finished WC fixtures
    const fixturesRes = await fetch(`https://v3.football.api-sports.io/fixtures?league=1&season=2026&status=FT`, {headers: footballHeaders});
    const fixtures = (await fixturesRes.json()).response || [];
    const fixtureIds = fixtures.map(f => f.fixture?.id).filter(Boolean);

    // Build EPL player stats from fixture player data — same source as main stats
    const playerStatsMap = {}; // playerId -> { name, club, goals, assists, mins, ratings }

    for(const fid of fixtureIds){
      const fpRes = await fetch(`https://v3.football.api-sports.io/fixtures/players?fixture=${fid}`, {headers: footballHeaders});
      const fpData = (await fpRes.json()).response || [];
      for(const teamData of fpData){
        const teamName = teamData.team?.name || '';
        if(!isEPL(teamName)) continue; // skip non-EPL teams
        for(const pe of (teamData.players || [])){
          const pid = pe.player?.id;
          const stat = pe.statistics?.[0];
          if(!pid || !stat) continue;
          if(!playerStatsMap[pid]){
            playerStatsMap[pid] = {
              name: pe.player?.name,
              club: teamName,
              goals: 0, assists: 0, mins: 0, ratings: []
            };
          }
          playerStatsMap[pid].goals   += stat.goals?.total   || 0;
          playerStatsMap[pid].assists += stat.goals?.assists || 0;
          playerStatsMap[pid].mins    += stat.games?.minutes || 0;
          if(stat.games?.rating) playerStatsMap[pid].ratings.push(parseFloat(stat.games.rating));
        }
      }
    }

    // Build sorted lists
    const allEPLPlayers = Object.values(playerStatsMap).map(p => ({
      ...p,
      avgRating: p.ratings.length ? Math.round((p.ratings.reduce((a,b)=>a+b,0)/p.ratings.length)*10)/10 : null,
      g90: p.mins > 0 ? Math.round((p.goals / p.mins * 90)*100)/100 : 0,
    }));

    if(allEPLPlayers.length === 0){
      const result = { facts: ['No EPL player stats available yet — check back after the next match!', 'Stats update after each World Cup match involving EPL players.'], updated: new Date().toISOString() };
      C.result = { data: result, at: Date.now() };
      return res.status(200).json({...result, cached:false});
    }

    const topScorers  = [...allEPLPlayers].sort((a,b)=>b.goals-a.goals).slice(0,8);
    const topAssists  = [...allEPLPlayers].sort((a,b)=>b.assists-a.assists).slice(0,5);
    const topRated    = [...allEPLPlayers].sort((a,b)=>(b.avgRating||0)-(a.avgRating||0)).slice(0,5);
    const mostMins    = [...allEPLPlayers].sort((a,b)=>b.mins-a.mins).slice(0,5);

    // Club totals
    const clubTotals = {};
    for(const p of allEPLPlayers){
      if(!clubTotals[p.club]) clubTotals[p.club] = { club:p.club, goals:0, assists:0, players:0 };
      clubTotals[p.club].goals   += p.goals;
      clubTotals[p.club].assists += p.assists;
      clubTotals[p.club].players++;
    }
    const topClubs = Object.values(clubTotals).sort((a,b)=>(b.goals+b.assists)-(a.goals+a.assists)).slice(0,5);

    const prompt = `You are a football stats analyst covering EPL (English Premier League) players at the FIFA World Cup 2026.
Here is verified real data about EPL players at this tournament:

TOP SCORERS (EPL players only):
${JSON.stringify(topScorers, null, 2)}

TOP ASSISTS (EPL players only):
${JSON.stringify(topAssists, null, 2)}

TOP RATED (EPL players only):
${JSON.stringify(topRated, null, 2)}

MOST MINUTES PLAYED (EPL players only):
${JSON.stringify(mostMins, null, 2)}

TOP EPL CLUBS BY GOAL CONTRIBUTIONS:
${JSON.stringify(topClubs, null, 2)}

Based ONLY on this real data, generate exactly 2 short interesting facts about EPL players at this World Cup.
Rules:
- Every fact MUST reference a specific EPL player or club from the data above
- Only use numbers that appear in the data — do not invent or estimate any statistics
- Do not mention match results, scorelines or opponents
- Keep each fact to one sentence, punchy and specific
- If data is limited, focus on what IS there (e.g. most minutes played, highest rated, etc.)

Return ONLY a JSON array of exactly 2 strings. No markdown. Example:
["Fact one.", "Fact two."]`;

    const matchResults = fixtures.slice(-10).map(f=>({
      home:      f.teams?.home?.name,
      away:      f.teams?.away?.name,
      homeGoals: f.goals?.home,
      awayGoals: f.goals?.away,
    }));

    const prompt = `You are a football stats analyst covering EPL (English Premier League) players at the FIFA World Cup 2026.
Here is the current tournament data for EPL players only:

TOP SCORERS (EPL players):
${JSON.stringify(topScorers, null, 2)}

TOP ASSISTS (EPL players):
${JSON.stringify(topAssists, null, 2)}

RECENT RESULTS:
${JSON.stringify(matchResults, null, 2)}

Based ONLY on this real data, generate exactly 2 short, interesting, specific facts about EPL players at this World Cup.
Every fact MUST be about a specific EPL player or EPL club — never about a non-EPL player or general World Cup stats.
Each fact should be surprising, specific and data-driven. Do not make up statistics not in the data.
Focus on patterns, comparisons, records or surprising findings about Premier League players.

Return ONLY a JSON array of exactly 2 strings. No markdown, no explanation. Example format:
["Fact one about an EPL player here.", "Fact two about an EPL club here."]`;

    // ── Step 2: Ask Claude to generate facts ──
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const claudeData = await claudeRes.json();
    const text  = claudeData.content?.map(b=>b.text||'').join('') || '';
    const clean = text.replace(/```json|```/g,'').trim();
    const facts = JSON.parse(clean);

    const result = { facts, updated: new Date().toISOString() };
    C.result = { data: result, at: Date.now() };
    return res.status(200).json({...result, cached:false});

  } catch(e){
    if(C.result.data) return res.status(200).json({...C.result.data, cached:true, stale:true});
    return res.status(500).json({error: e.message});
  }
};
