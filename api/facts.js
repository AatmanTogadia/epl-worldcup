const FACTS_TTL = 60 * 60 * 1000; // 1 hour
const C = { result: { data: null, at: 0 } };

module.exports = async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS') return res.status(200).end();

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if(!anthropicKey) return res.status(500).json({error:'ANTHROPIC_API_KEY not configured'});

  // Serve from cache if fresh
  if(C.result.data && (Date.now()-C.result.at) < FACTS_TTL){
    return res.status(200).json({...C.result.data, cached:true});
  }

  try {
    // ── Step 1: Get stats from our own /api/stats endpoint ──
    // This is already cached — costs 0 extra API-Football calls
    const statsRes = await fetch(`https://${req.headers.host}/api/stats`);
    const statsData = await statsRes.json();
    const players = statsData.players || [];

    if(!players.length){
      return res.status(200).json({
        facts: ['Stats are still loading — check back soon! ⚽'],
        updated: new Date().toISOString()
      });
    }

    // Build compact summary for Claude
    const played = players.filter(p => p.minutes > 0);
    const topScorers = [...played].sort((a,b)=>b.goals-a.goals).slice(0,8).map(p=>({
      name: p.name, club: p.club, goals: p.goals, assists: p.assists, mins: p.minutes
    }));
    const topAssists = [...played].sort((a,b)=>b.assists-a.assists).slice(0,5).map(p=>({
      name: p.name, club: p.club, assists: p.assists, goals: p.goals
    }));
    const topRated = [...played].filter(p=>p.avgRating).sort((a,b)=>(b.avgRating||0)-(a.avgRating||0)).slice(0,5).map(p=>({
      name: p.name, club: p.club, rating: p.avgRating, mins: p.minutes
    }));

    // Club totals
    const clubMap = {};
    for(const p of played){
      if(!clubMap[p.club]) clubMap[p.club] = { club:p.club, goals:0, assists:0, players:0 };
      clubMap[p.club].goals   += p.goals||0;
      clubMap[p.club].assists += p.assists||0;
      clubMap[p.club].players++;
    }
    const topClubs = Object.values(clubMap).sort((a,b)=>(b.goals+b.assists)-(a.goals+a.assists)).slice(0,5);

    const prompt = `You are a football stats analyst. Here is real data about EPL players at FIFA World Cup 2026:

TOP SCORERS: ${JSON.stringify(topScorers)}
TOP ASSISTS: ${JSON.stringify(topAssists)}
TOP RATED: ${JSON.stringify(topRated)}
TOP CLUBS: ${JSON.stringify(topClubs)}

Generate exactly 2 short punchy facts about EPL players at this World Cup.
Rules:
- Only reference players/clubs from the data above
- Only use numbers from the data — never invent statistics
- No match results or opponents
- One sentence each, specific and interesting

Return ONLY a JSON array of 2 strings. No markdown.`;

    // ── Step 2: Ask Claude ──
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 200,
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
