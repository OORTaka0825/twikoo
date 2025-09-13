// /api/index.js  —— 覆盖 twikoo 内置入口：先查 IPv6/IPv4 归属地，再交给 twikoo-vercel
const { server: twikoo } = require('twikoo-vercel');

const IPAPI_BASE = process.env.IPAPI_BASE || 'https://ipapi.co';
const IPINFO_TK  = process.env.IPINFO_TOKEN || '';   // 可选
const IPSB_BASE  = process.env.IPSB_BASE  || 'https://ip.sb';

const PRIVATE_RE = /^(::1|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.|fc00:|fe80:)/i;
const norm = (ip = '') => ip.trim().replace(/^::ffff:/i, '');

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  const cand = Array.isArray(xff) ? xff[0] : (xff || '').split(',')[0];
  return (cand && cand.trim())
      || (req.headers['x-vercel-forwarded-for'] || '').trim()
      || (req.headers['x-real-ip'] || '').trim()
      || (req.headers['cf-connecting-ip'] || '').trim()
      || (req.socket && req.socket.remoteAddress) || '';
}
function fmt({ country, country_code, region, city }) {
  const isCN = country_code === 'CN' || /^中国$/i.test(country) || /^China$/i.test(country);
  return isCN ? [region, city].filter(Boolean).join(' ')
              : [country || country_code, region].filter(Boolean).join(' / ');
}
async function fromIpapi(ip) {
  const r = await fetch(`${IPAPI_BASE}/${encodeURIComponent(ip)}/json/`, { cache: 'no-store' });
  const d = await r.json();
  if (d && !d.error) return { text: fmt({
    country: d.country_name, country_code: d.country_code,
    region: d.region || d.region_code || d.state, city: d.city
  }), provider: 'ipapi' };
  return { text: '', provider: 'ipapi' };
}
async function fromIpinfo(ip) {
  if (!IPINFO_TK) return { text: '', provider: 'ipinfo' };
  const r = await fetch(`https://ipinfo.io/${encodeURIComponent(ip)}?token=${IPINFO_TK}`, { cache: 'no-store' });
  const d = await r.json();
  return { text: fmt({ country: d.country, country_code: d.country, region: d.region || '', city: d.city || '' }), provider: 'ipinfo' };
}
async function fromIpsb(ip) {
  const r = await fetch(`${IPSB_BASE}/geoip/${encodeURIComponent(ip)}`, { cache: 'no-store' });
  const d = await r.json();
  return { text: fmt({ country: d.country, country_code: d.country_code || d.country_code2 || '', region: d.region, city: d.city }), provider: 'ip.sb' };
}
async function ipToRegion(ipRaw) {
  const ip = norm(ipRaw);
  if (!ip || PRIVATE_RE.test(ip)) return { text: '', provider: '' };
  for (const fn of [fromIpapi, fromIpinfo, fromIpsb]) {
    try { const { text, provider } = await fn(ip); if (text) return { text, provider }; } catch {}
  }
  return { text: '', provider: '' };
}

module.exports = async (req, res) => {
  // 1) 调试探针：/api/index?__probe=1  —— 用来确认这个入口是否生效
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.searchParams.has('__probe')) {
      const ip = getClientIp(req);
      const { text, provider } = await ipToRegion(ip);
      res.setHeader('content-type', 'application/json; charset=utf-8');
      return res.status(200).end(JSON.stringify({
        ok: true, ip, ipVersion: ip.includes(':') ? 6 : 4,
        region: text, provider,
        headers: {
          'x-forwarded-for': req.headers['x-forwarded-for'] || '',
          'x-vercel-forwarded-for': req.headers['x-vercel-forwarded-for'] || '',
          'x-real-ip': req.headers['x-real-ip'] || '',
          'cf-connecting-ip': req.headers['cf-connecting-ip'] || ''
        }
      }));
    }
  } catch {}

  // 2) 创建评论时注入 region 字段
  try {
    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body) } catch {} }
      if (!body || typeof body !== 'object') body = {};
      const maybeCreate =
        (typeof body.event === 'string' && body.event.toUpperCase().includes('COMMENT')) ||
        (typeof body.action === 'string' && body.action.toUpperCase().includes('COMMENT')) ||
        body.comment || body.content;
      if (maybeCreate) {
        const ip = getClientIp(req);
        if (ip) {
          const { text } = await ipToRegion(ip);
          if (text) {
            body.comment = body.comment || {};
            body.comment.region = body.comment.region || text; // Twikoo 读取这里
            body._region = body._region || text;                // 保险，多存一份
          }
        }
      }
      req.body = body;
    }
  } catch {}

  // 3) 交回 twikoo-vercel 继续处理（入库、通知等）
  return twikoo(req, res);
};
