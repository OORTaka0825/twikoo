// 中间件：IPv4/IPv6 属地注入（ipapi → ipinfo → ip.sb）
const { server: twikoo } = require('twikoo-vercel'); // 依赖包的原始处理器

const IPAPI_BASE = process.env.IPAPI_BASE || 'https://ipapi.co';
const IPINFO_TK  = process.env.IPINFO_TOKEN || '';   // 可选：ipinfo Lite token
const IPSB_BASE  = process.env.IPSB_BASE  || 'https://ip.sb';

const PRIVATE_RE = /^(::1|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.|fc00:|fe80:)/i;
const norm = (ip = '') => ip.trim().replace(/^::ffff:/i, ''); // 还原 IPv4-mapped IPv6

function getClientIp(req) {
  // 尽量取链路最前的真实 IP；XFF 可能是 "ip, proxy1, proxy2"
  const xff = req.headers['x-forwarded-for'];
  const cand = Array.isArray(xff) ? xff[0] : (xff || '').split(',')[0];
  return (cand && cand.trim())
      || (req.headers['x-vercel-forwarded-for'] || '').trim()
      || (req.headers['x-real-ip'] || '').trim()
      || (req.headers['cf-connecting-ip'] || '').trim()
      || (req.socket && req.socket.remoteAddress) || '';
}

function formatRegion({ country, country_code, region, city }) {
  const isCN = country_code === 'CN' || /^中国$/i.test(country) || /^China$/i.test(country);
  return isCN ? [region, city].filter(Boolean).join(' ')
              : [country || country_code, region].filter(Boolean).join(' / ');
}

async function fromIpapi(ip) {
  const r = await fetch(`${IPAPI_BASE}/${encodeURIComponent(ip)}/json/`, { cache: 'no-store' });
  const d = await r.json();
  if (d && !d.error) {
    return formatRegion({
      country: d.country_name, country_code: d.country_code,
      region: d.region || d.region_code || d.state, city: d.city
    });
  }
  return '';
}

async function fromIpinfo(ip) {
  if (!IPINFO_TK) return '';
  const r = await fetch(`https://ipinfo.io/${encodeURIComponent(ip)}?token=${IPINFO_TK}`, { cache: 'no-store' });
  const d = await r.json();
  return formatRegion({ country: d.country, country_code: d.country, region: d.region || '', city: d.city || '' });
}

async function fromIpsb(ip) {
  const r = await fetch(`${IPSB_BASE}/geoip/${encodeURIComponent(ip)}`, { cache: 'no-store' });
  const d = await r.json();
  return formatRegion({ country: d.country, country_code: d.country_code || d.country_code2 || '', region: d.region, city: d.city });
}

async function ipToRegion(ipRaw) {
  const ip = norm(ipRaw);
  if (!ip || PRIVATE_RE.test(ip)) return '';
  for (const fn of [fromIpapi, fromIpinfo, fromIpsb]) {
    try { const s = await fn(ip); if (s) return s; } catch {}
  }
  return '';
}

// —— 包装原来的 handler —— //
module.exports = async function handler(req, res) {
  try {
    if (req.method === 'POST') {
      // 1) 解析请求体
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch {} }
      if (!body || typeof body !== 'object') body = {};

      // 2) 判断是否「创建评论」类请求（尽量宽松，不误伤其他动作）
      const maybeCreate =
        (typeof body.event === 'string' && body.event.toUpperCase().includes('COMMENT')) ||
        (typeof body.action === 'string' && body.action.toUpperCase().includes('COMMENT')) ||
        body.comment || body.content;

      if (maybeCreate) {
        const ip = getClientIp(req);
        if (ip) {
          const region = await ipToRegion(ip);
          if (region) {
            // 优先写入 comment.region；顺带放一个顶层备用字段
            body.comment = body.comment || {};
            body.comment.region = body.comment.region || region;
            body._region = body._region || region;
          }
        }
      }
      req.body = body;
    }
  } catch {}
  // 交回 Twikoo 原处理逻辑（入库 / 返回）
  return twikoo(req, res);
};
