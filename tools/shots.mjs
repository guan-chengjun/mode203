/**
 * shots.mjs —— 多视角/长时间截图，用于人工核对粒子表现
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9335;
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${resolve(HERE, '.cdp-shots')}`,
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--no-first-run', '--no-default-browser-check', '--window-size=1500,950',
  'about:blank',
]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getWs() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
    } catch { await sleep(250); }
  }
  throw new Error('no target');
}
const ws = new WebSocket(await getWs());
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pend = new Map();
const errors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown')
    errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
};
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value;

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 950, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'http://localhost:8080/' });

const shoot = async (name) => {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(resolve(HERE, name), Buffer.from(shot.data, 'base64'));
  console.log('saved', name);
};

// 运行 12 秒让料堆积累，再调整相机到各视角
await sleep(12000);
const stats = await evalJs(`({ powder: window.__sim.poolPowder, settled: window.__sim.settled, air: window.__sim.poolAir })`);
console.log('12s stats:', JSON.stringify(stats));

await shoot('view-overview.png');

// 侧视：贴近管路观察粉体流动
await evalJs(`window.__sim.setView('side')`);
await sleep(800);
await shoot('view-side.png');

// 俯视主机仓：看沉降料堆
await evalJs(`window.__sim.setView('chamber')`);
await sleep(800);
await shoot('view-chamber.png');

// 排气口特写：看空气粒子排出
await evalJs(`window.__sim.setView('exhaust')`);
await sleep(800);
await shoot('view-exhaust.png');

console.log('page errors:', errors.length ? errors.join('\n') : 'none');
edge.kill();
ws.close();
process.exit(0);
