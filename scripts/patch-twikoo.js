// scripts/patch-twikoo.js
// 把 twikoo-vercel 的“IP→属地(仅IPv4)”改成 IPv4/IPv6 在线查询（ipapi → ipinfo → ip.sb）
const fs = require('fs');
const path = require('path');

const preferred = [
  'node_modules/twikoo-vercel/api/index.js',                     // 你的日志里就是这个
  'node_modules/twikoo-vercel/dist/index.cjs',
  'node_modules/twikoo-vercel/dist/adapter/vercel.cjs',
  'node_modules/twikoo-vercel/dist/vercel.cjs'
];

function findTarget() {
  for (const p of preferred) {
    const f = path.resolve(p);
    if (fs.existsSync(f)) return f;
  }
  // 兜底：在 twikoo-vercel 目录里找包含 SHOW_REGION 的 js 文件
  const root = path.resolve('node_modules/twikoo-vercel');
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const stat = fs.statSync(p);
      if (stat.isDirectory()) stack.push(p);
      else if (stat.isFile() && /\.c?js$/.test(name)) {
        const s = fs.readFileSync(p, 'utf8');
        if (s.includes('SHOW_REGION')) return p;
      }
    }
  }
  return null;
}

function insertOnce(code, needle, block) {
  return code.includes(needle) ? code : code + '\n' + block + '\n';
}

function patch(file) {
  let code = fs.readFileSync(file, 'utf8');

  // —— 注入 IPv6 友好的查询函数（使用 Node18 的 fetch）——
  const block = `
/* --- twikoo-ipv6 patch begin --- */
const IPAPI_BASE = process.env.IPAPI_BASE || 'https://ipapi.co';
const IPINFO_TK  = process.env.IPINFO_TOKEN || '';
const IPSB_BASE  = process.env.IPSB_BASE  || 'https://ip.sb';
const __TWK_DEBUG__ = process.env.DEBUG_TWIKOO_IPV6 === '1';
const __TWK_PRV_RE__ = /^(::1|127\\.|10\\.|192\\.168\\.|172\\.(1[6-9]|2\\d|3[0-1])\\.|fc00:|fe80:)/i;
const __twk_norm__ = (ip = '') => ip.trim().replace(/^::ffff:/i, '');
const __twk_fmt__ = ({ country, country_code, region, city }) => {
  const isCN = country_code === 'CN' || /^(中国|China)$/i.test(country);
  return isCN ? [region, city].filter(Boolean).join(' ') : [country || country_code, region].filter(Boolean).join(' / ');
};
async function __twk_fromIpapi__(ip){
  const r = await fetch(\`\${IPAPI_BASE}/\${encodeURIComponent(ip)}/json/\`, { cache: 'no-store' });
  const d = await r.json(); if (d && !d.error) return __twk_fmt__({ country: d.country_name, country_code: d.country_code, region: d.region || d.region_code || d.state, city: d.city });
  return '';
}
async function __twk_fromIpinfo__(ip){
  if(!IPINFO_TK) return '';
  const r = await fetch(\`https://ipinfo.io/\${encodeURIComponent(ip)}?token=\${IPINFO_TK}\`, { cache: 'no-store' });
  const d = await r.json(); return __twk_fmt__({ country: d.country, country_code: d.country, region: d.region || '', city: d.city || '' });
}
async function __twk_fromIpsb__(ip){
  const r = await fetch(\`\${IPSB_BASE}/geoip/\${encodeURIComponent(ip)}\`, { cache: 'no-store' });
  const d = await r.json(); return __twk_fmt__({ country: d.country, country_code: d.country_code || d.country_code2 || '', region: d.region, city: d.city });
}
async function __twk_ipToRegion__(ipRaw){
  const ip = __twk_norm__(ipRaw);
  if(!ip || __TWK_PRV_RE__.test(ip)) return '';
  for (const fn of [__twk_fromIpapi__, __twk_fromIpinfo__, __twk_fromIpsb__]) {
    try { const s = await fn(ip); if (s) { if(__TWK_DEBUG__) console.log('[twk-ipv6] hit', fn.name, ip, s); return s; } } catch(e){ if(__TWK_DEBUG__) console.log('[twk-ipv6] err', fn.name, e && e.message); }
  }
  return '';
}
/* --- twikoo-ipv6 patch end --- */
`;
  code = insertOnce(code, '__twk_ipToRegion__', block);

  // —— 屏蔽旧的 ip2region 引用（如果存在）——
  code = code
    .replace(/require\(['"]@imaegoo\/node-ip2region['"]\)/g, 'undefined')
    .replace(/ip2region\s*\.\s*\w+/g, 'undefined');

  // —— 把 SHOW_REGION 分支里的赋值改成我们的查询 —— 
  const before = code;
  code = code.replace(
    /(if\s*\([^)]*process\.env\.SHOW_REGION[^)]*\)\s*\{[\s\S]*?)(comment\.region\s*=\s*[^;]+;)([\s\S]*?\})/m,
    (_m, p1, _old, p3) => `${p1}comment.region = await __twk_ipToRegion__(ip) || '';${p3}`
  );
  if (code === before) {
    // 再兜底：即使没有显式的 comment.region，也强行在 SHOW_REGION 分支里写入
    code = code.replace(
      /(if\s*\([^)]*process\.env\.SHOW_REGION[^)]*\)\s*\{)/m,
      (_m, p1) => `${p1} try{ comment.region = await __twk_ipToRegion__(ip) || ''; }catch(e){} `
    );
  }

  fs.writeFileSync(file, code, 'utf8');
  console.log('[twikoo-ipv6] patched:', file);
}

const f = findTarget();
if (!f) {
  console.warn('[twikoo-ipv6] twikoo-vercel entry not found, skip patch');
  process.exit(0);
}
patch(f);
