export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const prompt = `You are a football stats API. The FIFA World Cup 2026 is currently in progress (hosted in USA, Canada, Mexico, started June 11 2026).

Return a JSON array of exactly 30 real EPL (English Premier League 2024/25 season) players who are participating at the 2026 FIFA World Cup with their current realistic tournament stats.

Rules:
- Use real player names who actually play in the EPL and would realistically be at the World Cup
- Spread players across many different EPL clubs (at least 10 different clubs)
- Spread players across many different nationalities / national teams
- Stats should be realistic for a tournament in its early stages (most players 90-270 mins, goals 0-3, assists 0-2)
- A few star players can have more goals/assists
- Yellow cards: most players 0, some 1, rarely 2
- Red cards: 0 for almost everyone, max 1 player with a red

Return ONLY a valid JSON array, no markdown, no explanation. Each object must have exactly:
name, nationality, club, minutes, goals, assists, yellow, red`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.json();
      return res.status(500).json({ error: err.error?.message || 'Anthropic API error' });
    }

    const data = await response.json();
    const text = data.content?.map(b => b.text || '').join('') || '';
    const clean = text.replace(/```json|```/g, '').trim();
    const players = JSON.parse(clean);
    res.status(200).json(players);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
