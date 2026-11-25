/**
 * cdp-check.mjs —— 通过 CDP 驱动无头浏览器做自动验证（零依赖，用 WebSocket）
 * 1. 打开页面，收集 console / pageerror
 * 2. 等待若干秒真实时间后读取粒子数量、料堆数量、叶轮状态
 * 3. 模拟暂停、风速调节、重置，验证交互逻辑
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9333;
const URL = 'http://localhost:8080/';

const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${resolve(HERE, '.cdp-profile')}`,
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--no-first-run', '--no-default-browser-check', 'about:blank',
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      // 页面级 target 才支持 Runtime / Page 域；browser 级端点仅支持 Browser 域
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch { await sleep(250); }
  }
  throw new Error('CDP page target not reachable');
}

// 极简 WebSocket 客户端（Node 22 内置全局 WebSocket）
const wsUrl = await getWsUrl();
const ws = new WebSocket(wsUrl);
await new Promise((r) => (ws.onopen = r));

let msgId = 0;
const pending = new Map();
const logs = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result, m.error); pending.delete(m.id); }
  if (m.method === 'Runtime.consoleAPICalled') {
    logs.push('[console.' + m.params.type + '] ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  }
  if (m.method === 'Runtime.exceptionThrown') {
    logs.push('[PAGE ERROR] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++msgId;
  pending.set(id, (result, error) => error ? rej(new Error(method + ': ' + JSON.stringify(error))) : res(result));
  ws.send(JSON.stringify({ id, method, params }));
});
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (!r || r.exceptionDetails) return { error: r?.exceptionDetails?.text ?? 'empty result' };
  return r.result.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: URL });

// 等待模型加载 + 粒子系统运转（真实时间 6 秒）
await sleep(6000);

const state1 = await evalJs(`(() => ({
  powder: document.getElementById('stPowder').textContent,
  settled: document.getElementById('stSettled').textContent,
  run: document.getElementById('stRun').textContent,
  wind: document.getElementById('windVal').textContent,
  canvasSize: (() => { const c = document.querySelector('canvas'); return c ? c.width + 'x' + c.height : 'none'; })(),
  gl: (() => { const c = document.querySelector('canvas'); return c ? !!c.getContext('webgl2') : false; })(),
}))()`);
console.log('运行 6s 后状态:', JSON.stringify(state1));

// 暂停：粒子数应定格
await evalJs(`document.getElementById('btnToggle').click()`);
const pausedUi = await evalJs(`document.getElementById('stRun').textContent`);
const frozen1 = await evalJs(`document.getElementById('stPowder').textContent`);
await sleep(1200);
const frozen2 = await evalJs(`document.getElementById('stPowder').textContent`);
console.log(`暂停测试: UI="${pausedUi}", 定格前=${frozen1}, 1.2s后=${frozen2}, ${frozen1 === frozen2 ? 'PASS' : 'FAIL'}`);

// 恢复 + 风速调到 200%
await evalJs(`document.getElementById('btnToggle').click()`);
await evalJs(`(() => { const s = document.getElementById('windSlider'); s.value = 200; s.dispatchEvent(new Event('input')); })()`);
const windUi = await evalJs(`document.getElementById('windVal').textContent`);
console.log('风速调节:', windUi, windUi === '3.2 m/s' ? 'PASS' : 'FAIL');
await sleep(3000);
const state2 = await evalJs(`({ powder: document.getElementById('stPowder').textContent, settled: document.getElementById('stSettled').textContent })`);
console.log('高风速 3s 后:', JSON.stringify(state2));

// 重置：内部池与 GPU 绘制范围应同步清零（同一调用栈内立即生效）
await evalJs(`document.getElementById('btnReset').click()`);
const state3 = await evalJs(`({ pool: window.__sim.poolPowder, settled: window.__sim.settled, air: window.__sim.poolAir, draw: window.__sim.drawRangePowder, drawAir: window.__sim.drawRangeAir })`);
const resetOk = state3.pool === 0 && state3.settled === 0 && state3.air === 0 && state3.draw === 0 && state3.drawAir === 0;
console.log('重置后(内部+绘制范围):', JSON.stringify(state3), resetOk ? 'PASS' : 'FAIL');

// 再等 2 秒确认重新开始生成
await sleep(2000);
const state4 = await evalJs(`({ powder: window.__sim.poolPowder, settled: window.__sim.settled })`);
console.log('重置后重新运行 2s:', JSON.stringify(state4), state4.powder > 0 ? 'PASS' : 'FAIL');

// 叶轮旋转验证：运行时角度应变化；暂停后应冻结
const impAngle = async () => evalJs(`window.__sim.impellerAngle`);
const a1 = await impAngle();
await sleep(400);
const a2 = await impAngle();
console.log(`叶轮运转: ${a1.toFixed(3)} → ${a2.toFixed(3)}`, a2 !== a1 ? 'PASS' : 'FAIL');
await evalJs(`document.getElementById('btnToggle').click()`);
const a3 = await impAngle();
await sleep(400);
const a4 = await impAngle();
console.log(`叶轮暂停定格: ${a3.toFixed(3)} → ${a4.toFixed(3)}`, a3 === a4 ? 'PASS' : 'FAIL');
await evalJs(`document.getElementById('btnToggle').click()`);

// 帧率采样（3 秒平均）
const fps = await evalJs(`new Promise((res) => {
  let n = 0; const t0 = performance.now();
  function tick() { n++; if (performance.now() - t0 < 3000) requestAnimationFrame(tick); else res(Math.round(n * 1000 / (performance.now() - t0))); }
  requestAnimationFrame(tick);
})`);
console.log('平均帧率(FPS):', fps, fps >= 45 ? 'PASS' : 'CHECK(软渲染环境偏低可接受)');

// 最低风速联动
await evalJs(`(() => { const s = document.getElementById('windSlider'); s.value = 40; s.dispatchEvent(new Event('input')); })()`);
const windLow = await evalJs(`document.getElementById('windVal').textContent`);
await sleep(1500);
const lowStats = await evalJs(`({ powder: window.__sim.poolPowder, factor: window.__sim.windFactor })`);
console.log('最低风速:', windLow, JSON.stringify(lowStats), windLow === '0.6 m/s' && lowStats.factor === 0.4 ? 'PASS' : 'FAIL');

console.log('\n--- 浏览器控制台日志 (' + logs.length + ' 条) ---');
console.log(logs.length ? logs.join('\n') : '(无任何 console 输出 / 报错)');

// 截图保存（通过 Page.captureScreenshot）
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(resolve(HERE, 'cdp-shot.png'), Buffer.from(shot.data, 'base64'));
console.log('\n截图已保存 tools/cdp-shot.png');

edge.kill();
ws.close();
process.exit(0);
