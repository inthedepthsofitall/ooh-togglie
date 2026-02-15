import http from 'k6/http';
import { check, sleep, fail } from 'k6';


const BASE = __ENV.BASE || 'https://togglie.aihof757.workers.dev';
const API_KEY = __ENV.API_KEY;

export const options = {
  vus: 10,
  duration: '10s',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<300'],
  },
  discardResponseBodies: false,
};

function hLower(headers) {
  const out = {};
  for (const k in headers) out[k.toLowerCase()] = headers[k];
  return out;
}

export function setup() {
  // ensure the flag exists
  const headers = { 'x-api-key': API_KEY, 'content-type': 'application/json', 'Origin': BASE };
  const body = JSON.stringify({ key: 'welcome_banner', description: 'k6 seed', enabled: true });
  const res = http.post(`${BASE}/v1/flags`, body, { headers });
  if (![201, 409].includes(res.status)) {
    fail(`Failed to ensure flag: status=${res.status} body=${res.body}`);
  }
}

export default function () {
  const headers = {
    'x-api-key': API_KEY,
    'content-type': 'application/json',
    'Origin': BASE, // optional for k6, but keeps your server’s CORS happy
  };

  // 1) GET flag
  let res = http.get(`${BASE}/v1/flags/welcome_banner`, { headers });
  const h1 = hLower(res.headers);
  check(res, {
    'get flag 200': r => r.status === 200,
    'rate headers on GET': _ =>
      !!h1['x-ratelimit-limit'] && !!h1['x-ratelimit-remaining'] && !!h1['x-ratelimit-reset'],
  });

  // 2) evaluate
  const evalBody = JSON.stringify({ flag_key: 'welcome_banner', user: { id: `u-${__VU}-${__ITER}` } });
  res = http.post(`${BASE}/v1/evaluate`, evalBody, { headers });
  check(res, {
    'evaluate 200': r => r.status === 200,
    'evaluate has keys': r => {
      try {
        const j = r.json();
        return j && typeof j.key === 'string' && typeof j.enabled === 'boolean' &&
               typeof j.version === 'number' && typeof j.reason === 'string';
      } catch { return false; }
    },
  });

  // 3) PUT flag occasionally to exercise write path
  if (__ITER % 10 === 0) {
    const putBody = JSON.stringify({ enabled: (__ITER / 10) % 2 === 0 });
    const put = http.put(`${BASE}/v1/flags/welcome_banner`, putBody, { headers });
    check(put, { 'put flag 200': r => r.status === 200 });
  }

  sleep(1);
}


