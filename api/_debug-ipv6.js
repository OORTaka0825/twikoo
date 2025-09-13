// api/_debug-ipv6.js  —— 部署后访问  /api/_debug-ipv6
module.exports = async (req, res) => {
  const fs = require('fs');
  const path = require('path');

  // 找到实际在跑的 twikoo-vercel 文件
  const modPath = require.resolve('twikoo-vercel/api/index.js');
  const code = fs.readFileSync(modPath, 'utf8');
  const patched = code.includes('__twk_ipToRegion__');

  // 顺便测一把 IPv6 查询链路
  let probe = { ok: false, region: '', error: '' };
  try {
    const IPAPI_BASE = process.env.IPAPI_BASE || 'https://ipapi.co';
    const r = await fetch(`${IPAPI_BASE}/2606:4700:4700::1111/json/`, { cache: 'no-store' });
    const d = await r.json();
    probe.ok = !!d && !d.error;
    probe.region = (d && (d.country_name || d.country)) || '';
  } catch (e) {
    probe.error = (e && e.message) || String(e);
  }

  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({
    twikoo_index: modPath,
    patched,
    SHOW_REGION: process.env.SHOW_REGION,
    DEBUG_TWIKOO_IPV6: process.env.DEBUG_TWIKOO_IPV6 || '',
    IPAPI_BASE: process.env.IPAPI_BASE || '',
    IPSB_BASE: process.env.IPSB_BASE || '',
    probe
  }, null, 2));
};
