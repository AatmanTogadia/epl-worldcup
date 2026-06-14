module.exports = async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  const url  = process.env.KV_REST_API_URL;
  const token= process.env.KV_REST_API_TOKEN;

  try {
    // Delete all eplstats keys from Redis
    const keys = ['eplstats:result','eplstats:eplmap','eplstats:wcsquads','eplstats:ratings'];
    for(const key of keys){
      await fetch(`${url}/del/${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
    }
    return res.status(200).json({ success: true, message: 'Cache cleared! Visit the site to rebuild.' });
  } catch(e){
    return res.status(500).json({ error: e.message });
  }
};
