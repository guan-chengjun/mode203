/**
 * 真空上料机 3D 动态仿真 —— 主程序
 *
 * 技术要点：
 *  - Three.js 原生 + OrbitControls 轨道交互
 *  - GLTFLoader 加载本地 GLB 模型，加载失败时程序化几何体兜底
 *  - requestAnimationFrame 驱动；粒子为 GPU Points（自定义 ShaderMaterial），
 *    CPU 只更新位置缓冲，无物理/流体求解库
 *
 * 流程：风机抽气形成负压 → 取料口粉体被吸入输送管 → 进入主机仓沉降 →
 *       空气穿过滤筒经风机从排气口排出。仅作视觉示意。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/* =====================================================================
 * 1. 全局参数与设备布局（单位：米）
 * ===================================================================== */
const SETTINGS = {
  running: true,          // 仿真启停
  windFactor: 1.0,        // 风速系数 0.4 ~ 2.0（滑块 40%~200%）
  windBase: 1.6,          // 基准输送风速 m/s（系数 1.0 时）
};

// 各设备在世界坐标中的落点（基座上表面 y=0.12）
const POS = {
  baseTop: 0.12,
  hopper: new THREE.Vector3(-2.9, 0.12, 0),
  chamber: new THREE.Vector3(0, 0.12, 0),
  fan: new THREE.Vector3(1.9, 0.12, 0),
};

// 输送管路关键节点：取料嘴 → 提升 → 水平 → 主机进料口
const PIPE_POINTS = [
  new THREE.Vector3(-2.9, 0.46, 0),
  new THREE.Vector3(-2.9, 0.95, 0),
  new THREE.Vector3(-2.9, 1.55, 0),
  new THREE.Vector3(-2.72, 1.55, 0),
  new THREE.Vector3(-1.2, 1.55, 0),
  new THREE.Vector3(-0.68, 1.55, 0),
];
const PIPE_RADIUS = 0.11;

// 空气路径：仓内上升穿过滤筒 → 顶部排气管 → 风机 → 排气口（含口外消散段）
const AIR_POINTS = [
  new THREE.Vector3(0, 1.05, 0),
  new THREE.Vector3(0, 1.7, 0),
  new THREE.Vector3(0, 2.25, 0),
  new THREE.Vector3(0, 2.55, 0),
  new THREE.Vector3(0, 2.78, 0),
  new THREE.Vector3(0.3, 2.82, 0),
  new THREE.Vector3(1.15, 2.72, 0),
  new THREE.Vector3(1.55, 2.42, 0),
  new THREE.Vector3(1.78, 2.1, 0),
  new THREE.Vector3(1.9, 2.02, 0),
  new THREE.Vector3(2.3, 2.02, 0),
  new THREE.Vector3(2.85, 2.02, 0),   // 实体排气管末端
  new THREE.Vector3(3.25, 2.02, 0),   // —— 以下为口外气流消散段（无管壁）
  new THREE.Vector3(3.7, 1.98, 0),
];

// 粉体进入主机后的沉降落点（锥底中心）
const DROP_POINT = new THREE.Vector3(0, 0.55, 0);

/* =====================================================================
 * 2. 渲染器 / 场景 / 相机 / 控制器 / 灯光 / 地面 / 雾
 * ===================================================================== */
const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;       // 柔和阴影
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xdfe5ec);
scene.fog = new THREE.Fog(0xdfe5ec, 11, 26);            // 淡雾，增加纵深

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(5.2, 3.6, 6.4);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(-0.4, 1.25, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxDistance = 16;
controls.minDistance = 2.2;
controls.maxPolarAngle = Math.PI * 0.49;
controls.update();

// 环境光 + 方向光（投射阴影）
scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.35);
dirLight.position.set(5.5, 9, 4.5);
dirLight.castShadow = true;
dirLight.shadow.mapSize.set(2048, 2048);
dirLight.shadow.camera.near = 1;
dirLight.shadow.camera.far = 25;
dirLight.shadow.camera.left = -7;
dirLight.shadow.camera.right = 7;
dirLight.shadow.camera.top = 7;
dirLight.shadow.camera.bottom = -7;
dirLight.shadow.bias = -0.0004;
scene.add(dirLight);
const fillLight = new THREE.DirectionalLight(0xbfd4ff, 0.35);
fillLight.position.set(-5, 4, -4);
scene.add(fillLight);

// 地面 + 设备基座
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(60, 60),
  new THREE.MeshStandardMaterial({ color: 0xcfd5dc, roughness: 0.95, metalness: 0 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const base = new THREE.Mesh(
  new THREE.BoxGeometry(7.2, 0.12, 2.8),
  new THREE.MeshStandardMaterial({ color: 0x5a616a, roughness: 0.7, metalness: 0.45 })
);
base.position.set(-0.3, 0.06, 0);
base.receiveShadow = true;
base.castShadow = true;
scene.add(base);

/* =====================================================================
 * 3. GLTFLoader 加载设备模型（含程序化兜底）
 * ===================================================================== */
const loader = new GLTFLoader();
const equipment = new THREE.Group();
scene.add(equipment);

let impeller = null;   // 风机叶轮引用，按节点名查找

/** 给模型组统一开启阴影 */
function enableShadows(obj) {
  obj.traverse((c) => {
    if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; }
  });
}

/** 加载一个 GLB；失败则用 fallback 几何体顶替，保证页面始终可运行 */
function loadModel(file, fallbackFn, position) {
  return new Promise((resolve) => {
    loader.load(
      `./models/${file}`,
      (gltf) => {
        const group = gltf.scene;
        enableShadows(group);
        // 风机叶轮按名称取出，供动画驱动
        gltf.scene.traverse((c) => { if (c.name === 'impeller') impeller = c; });
        group.position.copy(position);
        equipment.add(group);
        resolve(group);
      },
      undefined,
      () => {
        console.warn(`模型 ${file} 加载失败，启用程序化兜底模型`);
        const group = fallbackFn();
        enableShadows(group);
        group.position.copy(position);
        equipment.add(group);
        resolve(group);
      }
    );
  });
}

/* ---------- 兜底几何体（与 GLB 布局一致，材质风格统一） ---------- */
const MAT = {
  steel: () => new THREE.MeshStandardMaterial({ color: 0x9ea6ad, metalness: 0.55, roughness: 0.45 }),
  vessel: () => new THREE.MeshStandardMaterial({ color: 0xccd1d6, metalness: 0.35, roughness: 0.5 }),
  frame: () => new THREE.MeshStandardMaterial({ color: 0x474c53, metalness: 0.6, roughness: 0.5 }),
  blue: () => new THREE.MeshStandardMaterial({ color: 0x29598c, metalness: 0.4, roughness: 0.45 }),
  pipe: () => new THREE.MeshStandardMaterial({ color: 0x8c949c, metalness: 0.55, roughness: 0.4 }),
  media: () => new THREE.MeshStandardMaterial({ color: 0xc2c9d1, metalness: 0.05, roughness: 0.9 }),
  orange: () => new THREE.MeshStandardMaterial({ color: 0xc74724, metalness: 0.3, roughness: 0.5 }),
};

function fallbackHopper() {
  const g = new THREE.Group();
  const bin = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.13, 0.83, 28), MAT.steel());
  bin.position.y = 0.635; g.add(bin);
  const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.22, 18, 1, true), MAT.pipe());
  nozzle.position.y = 0.12; g.add(nozzle);
  return g;
}
function fallbackChamber() {
  const g = new THREE.Group();
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0xc7ced4, metalness: 0.25, roughness: 0.35, transparent: true, opacity: 0.32,
  });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.15, 2.17, 32), glassMat);
  body.position.y = 1.365; g.add(body);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.605, 0.605, 0.1, 32, 1, true), MAT.blue());
  band.position.y = 2.18; g.add(band);
  const inlet = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.3, 18, 1, true), MAT.pipe());
  inlet.rotation.z = Math.PI / 2; inlet.position.set(-0.68, 1.55, 0); g.add(inlet);
  return g;
}
function fallbackFilter() {
  const g = new THREE.Group();
  const c = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.95, 24), MAT.media());
  g.add(c);
  return g;
}
function fallbackFan() {
  const g = new THREE.Group();
  const basePlate = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.18, 0.8), MAT.frame());
  basePlate.position.y = 0.09; g.add(basePlate);
  const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.55, 24), MAT.blue());
  motor.rotation.z = Math.PI / 2; motor.position.set(0.5, 0.72, 0); g.add(motor);
  const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.08, 20), MAT.orange());
  wheel.rotation.z = Math.PI / 2; wheel.position.set(-0.12, 0.72, 0);
  impeller = wheel; g.add(wheel);
  return g;
}

/* ---------- 管路：沿输送曲线生成实体管，并从 pipes.glb 取法兰点缀 ---------- */
const powderCurve = new THREE.CatmullRomCurve3(PIPE_POINTS, false, 'centripetal');
powderCurve.arcLengthDivisions = 400;
const powderPathLen = powderCurve.getLength();

const airCurve = new THREE.CatmullRomCurve3(AIR_POINTS, false, 'centripetal');
airCurve.arcLengthDivisions = 400;
const airPathLen = airCurve.getLength();
// 实体排气管只到风机排气口（第 12 个点），之后是口外气流消散段
const exhaustCurve = new THREE.CatmullRomCurve3(AIR_POINTS.slice(0, 12), false, 'centripetal');

function buildPipes(pipeModel) {
  // 输送管（粉体）
  const tube1 = new THREE.Mesh(
    new THREE.TubeGeometry(powderCurve, 120, PIPE_RADIUS, 20, false), MAT.pipe()
  );
  tube1.castShadow = true; tube1.receiveShadow = true;
  equipment.add(tube1);

  // 排气管（空气），仅实体管路部分；口外消散段无管壁
  const tube2 = new THREE.Mesh(
    new THREE.TubeGeometry(exhaustCurve, 120, 0.09, 18, false), MAT.pipe()
  );
  tube2.castShadow = true; tube2.receiveShadow = true;
  equipment.add(tube2);

  // 从 pipes.glb 中取法兰节点，在输送管起止处各装一片（模型缺失时跳过）
  if (pipeModel) {
    const flangeSrc = pipeModel.getObjectByName('flange');
    if (flangeSrc) {
      const place = (pos, horizontal) => {
        const f = flangeSrc.clone();
        f.position.copy(pos);
        if (horizontal) f.rotation.z = Math.PI / 2;
        equipment.add(f);
      };
      place(PIPE_POINTS[0], false);                                  // 取料嘴法兰
      place(PIPE_POINTS[PIPE_POINTS.length - 1], true);              // 主机进料口法兰
      place(exhaustCurve.getPointAt(1), true);                       // 排气口法兰（贴合真实管口）
    }
  }
}

/* =====================================================================
 * 4. 粒子系统
 *    两套 THREE.Points + 自定义着色器：粉体（暖色）与空气（浅色半透明）
 *    CPU 每帧只写 position / alpha 两个缓冲，无碰撞计算
 * ===================================================================== */

// 圆形软粒子片元着色器（两类粒子共用）
const VERT = /* glsl */`
  attribute float aAlpha;
  attribute float aSize;
  varying float vAlpha;
  void main() {
    vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * (300.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;
const FRAG = /* glsl */`
  uniform vec3 uColor;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - vec2(0.5));
    if (d > 0.5) discard;
    float soft = smoothstep(0.5, 0.12, d);
    gl_FragColor = vec4(uColor, vAlpha * soft);
  }
`;

function makePoints(capacity, color, size, blending) {
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(capacity * 3);
  const alphas = new Float32Array(capacity);
  const sizes = new Float32Array(capacity);
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1).setUsage(THREE.DynamicDrawUsage));
  geo.setDrawRange(0, 0);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) } },
    vertexShader: VERT, fragmentShader: FRAG,
    transparent: true, depthWrite: false, blending,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  scene.add(points);
  return { points, geo, positions, alphas, sizes, count: 0 };
}

/* ---------- 粉体粒子 ---------- */
const POWDER_CAP = 1500;
const PILE_CAP = 520;                 // 仓内最大沉降粒数（堆满后循环复用）
const powder = makePoints(POWDER_CAP, 0xd8b07a, 0.115, THREE.NormalBlending);

// 预计算沉降堆槽位：严格落在锥体内腔（r 随高度收窄），分 6 层
const pileSlots = [];
(() => {
  const layers = [
    { y: 0.36, r: 0.09, n: 26 },
    { y: 0.45, r: 0.13, n: 40 },
    { y: 0.55, r: 0.17, n: 58 },
    { y: 0.66, r: 0.21, n: 78 },
    { y: 0.78, r: 0.25, n: 100 },
    { y: 0.9, r: 0.29, n: 124 },
  ];
  for (const L of layers) {
    for (let i = 0; i < L.n && pileSlots.length < PILE_CAP; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * L.r;
      pileSlots.push(new THREE.Vector3(
        DROP_POINT.x + Math.cos(a) * r, L.y + Math.random() * 0.025, DROP_POINT.z + Math.sin(a) * r
      ));
    }
  }
})();

/**
 * 粉体粒子状态：
 *  travel  沿管路曲线运动（t: 曲线参数 0→1，带径向抖动与轻微旋流）
 *  settle  进入仓内后向锥底下沉（0.7s 过渡）
 *  settled 已落入料堆，位置固定，等待复用
 */
const powderPool = [];
let powderSpawnAcc = 0;
let settledCount = 0;
let nextSlot = 0;          // 料堆槽位轮转分配，独立于 settledCount（重置后仍安全）

function spawnPowder() {
  // 池满且都在料堆中：复用最老的沉降粒子（料堆视觉保持稳定）
  let p = powderPool.find((q) => !q.alive);
  if (!p) {
    if (powderPool.length >= POWDER_CAP) {
      p = powderPool.find((q) => q.state === 'settled');
      if (!p) return;
      settledCount--;
    } else {
      p = {
        alive: false, state: 'travel', t: 0,
        jitter: new THREE.Vector3(), swirl: Math.random() * Math.PI * 2,
        settleT: 0, from: new THREE.Vector3(), slot: 0,
      };
      powderPool.push(p);
    }
  }
  p.alive = true;
  p.state = 'travel';
  p.t = 0;
  p.swirl = Math.random() * Math.PI * 2;
  p.jitter.set((Math.random() - 0.5) * 0.12, (Math.random() - 0.5) * 0.12, (Math.random() - 0.5) * 0.12);
  p.settleT = 0;
  p.slot = nextSlot % PILE_CAP;   // 始终落在有效槽位内
  nextSlot++;
}

/* ---------- 空气粒子 ---------- */
const AIR_CAP = 420;
// 浅色背景下用普通混合 + 稍高不透明度，保证排气气流清晰可辨
const air = makePoints(AIR_CAP, 0x7fb8dd, 0.1, THREE.NormalBlending);
const airPool = [];
let airSpawnAcc = 0;

function spawnAir() {
  let p = airPool.find((q) => !q.alive);
  if (!p) {
    if (airPool.length >= AIR_CAP) return;
    p = { alive: false, t: 0, jitter: new THREE.Vector3() };
    airPool.push(p);
  }
  p.alive = true;
  p.t = 0;
  p.jitter.set((Math.random() - 0.5) * 0.08, (Math.random() - 0.5) * 0.08, (Math.random() - 0.5) * 0.08);
}

/* ---------- 每帧粒子更新 ---------- */
const tmpV = new THREE.Vector3();

function updatePowder(dt) {
  const speed = SETTINGS.windFactor * SETTINGS.windBase;      // m/s
  const dtRate = dt * speed / powderPathLen;                  // 曲线参数推进量
  let n = 0;
  for (const p of powderPool) {
    if (!p.alive) continue;

    if (p.state === 'travel') {
      p.t += dtRate;
      p.swirl += dt * 3.5 * SETTINGS.windFactor;
      if (p.t >= 1) {
        // 到达进料口 → 进入沉降阶段
        p.state = 'settle';
        p.settleT = 0;
        powderCurve.getPointAt(1, p.from);
      } else {
        powderCurve.getPointAt(p.t, tmpV);
        const j = 0.55 + 0.45 * Math.sin(Math.PI * p.t);     // 管内收紧、出口略散
        writePowder(n++, tmpV.x + p.jitter.x * j, tmpV.y + p.jitter.y * j, tmpV.z + p.jitter.z * j, 0.95, p);
        continue;
      }
    }

    if (p.state === 'settle') {
      p.settleT += dt;
      const k = Math.min(p.settleT / 0.7, 1);                 // 0.7s 下沉
      const e = 1 - Math.pow(1 - k, 3);
      const target = pileSlots[p.slot] ?? pileSlots[0];       // 防御性兜底
      tmpV.lerpVectors(p.from, target, e);
      writePowder(n++, tmpV.x, tmpV.y, tmpV.z, 0.95, p);
      if (k >= 1) { p.state = 'settled'; settledCount++; }
      continue;
    }

    // settled：固定在料堆槽位
    const s = pileSlots[p.slot] ?? pileSlots[0];
    writePowder(n++, s.x, s.y, s.z, 0.95, p);
  }
  powder.count = n;
  powder.geo.setDrawRange(0, n);
  powder.geo.attributes.position.needsUpdate = true;
  powder.geo.attributes.aAlpha.needsUpdate = true;
  powder.geo.attributes.aSize.needsUpdate = true;
}

function writePowder(idx, x, y, z, alpha, p) {
  const i3 = idx * 3;
  powder.positions[i3] = x; powder.positions[i3 + 1] = y; powder.positions[i3 + 2] = z;
  powder.alphas[idx] = alpha;
  powder.sizes[idx] = 0.105 + ((p.slot * 37) % 7) * 0.004;  // 轻微大小差异
}

function updateAir(dt) {
  const speed = SETTINGS.windFactor * SETTINGS.windBase * 1.15;
  const dtRate = dt * speed / airPathLen;
  let n = 0;
  for (const p of airPool) {
    if (!p.alive) continue;
    p.t += dtRate;
    if (p.t >= 1) { p.alive = false; continue; }
    airCurve.getPointAt(p.t, tmpV);
    const i3 = n * 3;
    air.positions[i3] = tmpV.x + p.jitter.x;
    air.positions[i3 + 1] = tmpV.y + p.jitter.y;
    air.positions[i3 + 2] = tmpV.z + p.jitter.z;
    // 仓内偏淡，穿出滤筒后渐显；管口(约 t=0.80)外扩散并淡出
    let alpha = 0.4;
    if (p.t > 0.28) alpha = 0.4 + Math.min((p.t - 0.28) / 0.15, 1) * 0.4;
    if (p.t > 0.8) alpha *= 1 - (p.t - 0.8) / 0.2;
    air.alphas[n] = Math.max(alpha, 0);
    air.sizes[n] = 0.1 + Math.max(0, p.t - 0.8) * 0.35;   // 口外略微扩散变大
    n++;
  }
  air.count = n;
  air.geo.setDrawRange(0, n);
  air.geo.attributes.position.needsUpdate = true;
  air.geo.attributes.aAlpha.needsUpdate = true;
  air.geo.attributes.aSize.needsUpdate = true;
}

/* =====================================================================
 * 5. 模型装配入口
 * ===================================================================== */
async function assemble() {
  const pipeModel = await loadModel('pipes.glb', () => new THREE.Group(), new THREE.Vector3());
  await loadModel('hopper.glb', fallbackHopper, POS.hopper);
  await loadModel('chamber.glb', fallbackChamber, POS.chamber);
  await loadModel('filter.glb', fallbackFilter, new THREE.Vector3(0, 2.25, 0));
  await loadModel('fan_base.glb', fallbackFan, POS.fan);
  buildPipes(pipeModel);
}

/* =====================================================================
 * 6. 动画循环（RAF）+ UI 联动
 * ===================================================================== */
const clock = new THREE.Clock();
const el = {
  toggle: document.getElementById('btnToggle'),
  reset: document.getElementById('btnReset'),
  slider: document.getElementById('windSlider'),
  windVal: document.getElementById('windVal'),
  stRun: document.getElementById('stRun'),
  stFan: document.getElementById('stFan'),
  stPowder: document.getElementById('stPowder'),
  stSettled: document.getElementById('stSettled'),
};

function resetParticles() {
  for (const p of powderPool) p.alive = false;
  for (const p of airPool) p.alive = false;
  powderPool.length = 0;
  airPool.length = 0;
  settledCount = 0;
  nextSlot = 0;
  powderSpawnAcc = 0;
  airSpawnAcc = 0;
  powder.geo.setDrawRange(0, 0);
  air.geo.setDrawRange(0, 0);
}

el.toggle.addEventListener('click', () => {
  SETTINGS.running = !SETTINGS.running;
  el.toggle.textContent = SETTINGS.running ? '暂停' : '启动';
  el.stRun.textContent = SETTINGS.running ? '运行中' : '已暂停（定格）';
  el.stFan.textContent = SETTINGS.running ? '运转' : '停止';
});
el.reset.addEventListener('click', resetParticles);
el.slider.addEventListener('input', () => {
  SETTINGS.windFactor = Number(el.slider.value) / 100;
  el.windVal.textContent = (SETTINGS.windFactor * SETTINGS.windBase).toFixed(1) + ' m/s';
});

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);   // 限幅，防止切后台后跳变
  controls.update();

  if (SETTINGS.running) {
    // 生成速率随风速联动：基准 95 粒/秒（粉体）、40 粒/秒（空气）
    powderSpawnAcc += dt * 95 * SETTINGS.windFactor;
    airSpawnAcc += dt * 40 * SETTINGS.windFactor;
    while (powderSpawnAcc >= 1) { spawnPowder(); powderSpawnAcc -= 1; }
    while (airSpawnAcc >= 1) { spawnAir(); airSpawnAcc -= 1; }

    updatePowder(dt);
    updateAir(dt);

    // 叶轮转速随风速变化
    if (impeller) impeller.rotation.x += dt * 9 * SETTINGS.windFactor;
  }

  // 状态栏数字（每帧刷新成本可忽略）
  el.stPowder.textContent = powder.count;
  el.stSettled.textContent = settledCount;

  renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

assemble().then(() => animate());

// 调试/自动化验证用只读钩子（不影响正常运行）
window.__sim = {
  get poolPowder() { return powderPool.filter((p) => p.alive).length; },
  get settled() { return settledCount; },
  get poolAir() { return airPool.filter((p) => p.alive).length; },
  get running() { return SETTINGS.running; },
  get windFactor() { return SETTINGS.windFactor; },
  get drawRangePowder() { return powder.geo.drawRange.count; },
  get drawRangeAir() { return air.geo.drawRange.count; },
  get impellerAngle() { return impeller ? impeller.rotation.x : -1; },
  // 验证用视角切换
  setView(name) {
    const views = {
      overview: [new THREE.Vector3(5.2, 3.6, 6.4), new THREE.Vector3(-0.4, 1.25, 0)],
      side: [new THREE.Vector3(-0.2, 2.0, 6.8), new THREE.Vector3(-1.2, 1.4, 0)],
      chamber: [new THREE.Vector3(2.6, 3.2, 3.4), new THREE.Vector3(0, 1.35, 0)],
      exhaust: [new THREE.Vector3(4.3, 2.9, 2.6), new THREE.Vector3(2.9, 2.0, 0)],
    };
    const v = views[name];
    if (v) { camera.position.copy(v[0]); controls.target.copy(v[1]); controls.update(); }
  },
};
