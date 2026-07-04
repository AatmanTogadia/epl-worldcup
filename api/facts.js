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

    // EPL clubs to filter by
    const EPL_CLUBS = ['Arsenal','Chelsea','Manchester City','Manchester United','Liverpool',
      'Tottenham','Newcastle','Aston Villa','Brighton','Brentford','Fulham',
      'Nottingham Forest','Everton','Crystal Palace','Leicester','Southampton',
      'Ipswich','Bournemouth','Sunderland','Leeds'];

    function isEPL(teamName){
      if(!teamName) return false;
      return EPL_CLUBS.some(c => teamName.toLowerCase().includes(c.toLowerCase().split(' ')[0]));
    }

    // Only include EPL players in the data sent to Claude
    const topScorers = scorers
      .filter(e => isEPL(e.statistics?.[0]?.team?.name))
      .slice(0,10).map(e=>({
        name:    e.player?.name,
        club:    e.statistics?.[0]?.team?.name,
        nation:  e.player?.nationality,
        goals:   e.goals,
        assists: e.assists,
        mins:    e.statistics?.[0]?.games?.minutes,
      }));

    const topAssists = assists
      .filter(e => isEPL(e.statistics?.[0]?.team?.name))
      .slice(0,5).map(e=>({
        name:    e.player?.name,
        club:    e.statistics?.[0]?.team?.name,
        nation:  e.player?.nationality,
        assists: e.assists,
        goals:   e.goals,
      }));

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
