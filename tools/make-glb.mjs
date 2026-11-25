/**
 * make-glb.mjs —— 零依赖 glTF 2.0 / GLB 模型生成器
 *
 * 真空上料机仿真所需的 5 个轻量化模型全部由本脚本程序化生成：
 *   models/hopper.glb       取料仓（料斗 + 支腿 + 吸料口）
 *   models/pipes.glb        输送管路套件（直管 / 90° 弯头 / 法兰）
 *   models/chamber.glb      主机（集料仓罐体 + 锥底 + 支腿 + 接口）
 *   models/filter.glb       滤筒（滤芯 + 端盖 + 吊杆）
 *   models/fan_base.glb     风机底座（底座 + 电机 + 蜗壳 + 叶轮 impeller）
 *
 * 顶点数均为百级，材质为 PBR 简单材质，保证大量粒子渲染时依然流畅。
 * 运行：node tools/make-glb.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'models');

/* ---------------- 基础几何：返回 { pos, nor, idx } ---------------- */

/** 旋转体：profile = [[r, y], ...]，绕 Y 轴旋转 seg 段 */
function lathe(profile, seg = 32) {
  const pos = [], nor = [], idx = [];
  const row = seg + 1;
  for (let i = 0; i < profile.length; i++) {
    const [r, y] = profile[i];
    const i0 = Math.max(0, i - 1), i1 = Math.min(profile.length - 1, i + 1);
    const dr = profile[i1][0] - profile[i0][0];
    const dy = profile[i1][1] - profile[i0][1];
    const len = Math.hypot(dr, dy) || 1;
    const nx = dy / len, ny = -dr / len; // 剖面外法线
    for (let j = 0; j <= seg; j++) {
      const t = (j / seg) * Math.PI * 2;
      const s = Math.sin(t), c = Math.cos(t);
      pos.push(r * s, y, r * c);
      nor.push(nx * s, ny, nx * c);
    }
  }
  for (let i = 0; i < profile.length - 1; i++) {
    for (let j = 0; j < seg; j++) {
      const a = i * row + j, b = a + 1, c = a + row, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  return pack(pos, nor, idx);
}

/** 圆柱（可选封顶） */
function cylinder(rTop, rBottom, h, seg = 28, openEnded = false) {
  const parts = [lathe([[rTop, h / 2], [rBottom, -h / 2]], seg)];
  if (!openEnded) {
    parts.push(cap(0, rTop, h / 2, seg, true));
    parts.push(cap(0, rBottom, -h / 2, seg, false));
  }
  return merge(parts);
}

/** 中心在 (0, y, 0)、半径 r 的封口扇面 */
function cap(cx, r, y, seg, up) {
  const pos = [cx, y, 0], nor = [0, up ? 1 : -1, 0], idx = [];
  for (let j = 0; j <= seg; j++) {
    const t = (j / seg) * Math.PI * 2;
    pos.push(cx + r * Math.sin(t), y, r * Math.cos(t));
    nor.push(0, up ? 1 : -1, 0);
  }
  for (let j = 1; j <= seg; j++) idx.push(0, j, j + 1);
  return pack(pos, nor, idx);
}

/** 圆环（Y 轴） */
function torus(R, tube, tubular = 36, radial = 10) {
  const pos = [], nor = [], idx = [];
  const row = radial + 1;
  for (let i = 0; i <= tubular; i++) {
    const u = (i / tubular) * Math.PI * 2;
    for (let j = 0; j <= radial; j++) {
      const v = (j / radial) * Math.PI * 2;
      const cv = Math.cos(v), sv = Math.sin(v);
      const rr = R + tube * cv;
      pos.push(rr * Math.sin(u), tube * sv, rr * Math.cos(u));
      nor.push(cv * Math.sin(u), sv, cv * Math.cos(u));
    }
  }
  for (let i = 0; i < tubular; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * row + j, b = a + 1, c = a + row, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  return pack(pos, nor, idx);
}

/** 长方体 */
function box(w, h, d) {
  const pos = [], nor = [], idx = [];
  const faces = [
    [[1, 0, 0], [[w / 2, -h / 2, -d / 2], [w / 2, h / 2, -d / 2], [w / 2, h / 2, d / 2], [w / 2, -h / 2, d / 2]]],
    [[-1, 0, 0], [[-w / 2, -h / 2, d / 2], [-w / 2, h / 2, d / 2], [-w / 2, h / 2, -d / 2], [-w / 2, -h / 2, -d / 2]]],
    [[0, 1, 0], [[-w / 2, h / 2, -d / 2], [-w / 2, h / 2, d / 2], [w / 2, h / 2, d / 2], [w / 2, h / 2, -d / 2]]],
    [[0, -1, 0], [[-w / 2, -h / 2, d / 2], [-w / 2, -h / 2, -d / 2], [w / 2, -h / 2, -d / 2], [w / 2, -h / 2, d / 2]]],
    [[0, 0, 1], [[-w / 2, -h / 2, d / 2], [w / 2, -h / 2, d / 2], [w / 2, h / 2, d / 2], [-w / 2, h / 2, d / 2]]],
    [[0, 0, -1], [[w / 2, -h / 2, -d / 2], [-w / 2, -h / 2, -d / 2], [-w / 2, h / 2, -d / 2], [w / 2, h / 2, -d / 2]]],
  ];
  for (const [n, verts] of faces) {
    const base = pos.length / 3;
    for (const v of verts) { pos.push(...v); nor.push(...n); }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return pack(pos, nor, idx);
}

/** 几何合并（索引偏移自动处理） */
function merge(list) {
  const pos = [], nor = [], idx = [];
  for (const g of list) {
    const off = pos.length / 3;
    pos.push(...g.pos), nor.push(...g.nor);
    for (const i of g.idx) idx.push(i + off);
  }
  return pack(pos, nor, idx);
}

function pack(pos, nor, idx) {
  return { pos: Float32Array.from(pos), nor: Float32Array.from(nor), idx: Uint16Array.from(idx) };
}

/* ---------------- 几何变换（平移 / 绕轴旋转 90°） ---------------- */

function move(g, x, y, z) {
  for (let i = 0; i < g.pos.length; i += 3) {
    g.pos[i] += x; g.pos[i + 1] += y; g.pos[i + 2] += z;
  }
  return g;
}

/** 绕 Z 轴旋转 90°：Y 轴圆柱 -> X 轴圆柱，dir = -1 时反向 */
function rotZ90(g, dir = 1) {
  for (let i = 0; i < g.pos.length; i += 3) {
    const x = g.pos[i], y = g.pos[i + 1];
    if (dir === 1) { g.pos[i] = -y; g.pos[i + 1] = x; }
    else { g.pos[i] = y; g.pos[i + 1] = -x; }
    const nx = g.nor[i], ny = g.nor[i + 1];
    if (dir === 1) { g.nor[i] = -ny; g.nor[i + 1] = nx; }
    else { g.nor[i] = ny; g.nor[i + 1] = -nx; }
  }
  return g;
}

/* ---------------- 材质 ---------------- */

const MAT = {
  steel: { color: [0.62, 0.65, 0.68], metal: 0.55, rough: 0.45 },
  vessel: { color: [0.80, 0.82, 0.84], metal: 0.35, rough: 0.5 },
  // 主机罐体用半透明钢，便于观察内部滤筒与粉体沉降（alphaMode: BLEND）
  vesselGlass: { color: [0.78, 0.81, 0.85], metal: 0.25, rough: 0.35, alpha: 0.32 },
  frame: { color: [0.28, 0.30, 0.33], metal: 0.6, rough: 0.5 },
  blue: { color: [0.16, 0.35, 0.55], metal: 0.4, rough: 0.45 },
  pipe: { color: [0.55, 0.58, 0.62], metal: 0.55, rough: 0.4 },
  flange: { color: [0.40, 0.43, 0.47], metal: 0.6, rough: 0.4 },
  media: { color: [0.76, 0.79, 0.83], metal: 0.05, rough: 0.9 },
  motor: { color: [0.20, 0.42, 0.55], metal: 0.4, rough: 0.45 },
  orange: { color: [0.78, 0.28, 0.14], metal: 0.3, rough: 0.5 },
};

/* ---------------- GLB 写出 ---------------- */

class GlbBuilder {
  constructor() {
    this.parts = [];       // { name, geom, matKey, translation? }
    this.mats = new Map();
  }

  addPart(name, geom, matKey, translation = null) {
    if (!this.mats.has(matKey)) this.mats.set(matKey, MAT[matKey]);
    this.parts.push({ name, geom, matKey, translation });
  }

  build() {
    const bin = [];                 // Uint8Array 片段
    let offset = 0;
    const align4 = (n) => (n + 3) & ~3;
    const pushView = (arr, target) => {
      const byteOffset = offset;
      bin.push(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength));
      offset += arr.byteLength;
      const pad = align4(offset) - offset;
      if (pad) { bin.push(new Uint8Array(pad)); offset += pad; }
      // glTF 规定 bufferView 必须显式引用 buffer（内嵌 BIN 即索引 0）
      return { buffer: 0, byteOffset, byteLength: arr.byteLength, target };
    };

    const bufferViews = [], accessors = [], meshes = [], nodes = [], matIndex = new Map();
    const materials = [];
    for (const [key, m] of this.mats) {
      matIndex.set(key, materials.length);
      const mat = {
        name: key,
        pbrMetallicRoughness: {
          baseColorFactor: [...m.color, m.alpha ?? 1],
          metallicFactor: m.metal,
          roughnessFactor: m.rough,
        },
        doubleSided: true,
      };
      if (m.alpha !== undefined) mat.alphaMode = 'BLEND';
      materials.push(mat);
    }

    for (const part of this.parts) {
      const g = part.geom;
      const vPos = pushView(g.pos, 34962);
      const vNor = pushView(g.nor, 34962);
      const vIdx = pushView(g.idx, 34963);
      const aiPos = accessors.length;
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < g.pos.length; i += 3)
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], g.pos[i + k]);
          max[k] = Math.max(max[k], g.pos[i + k]);
        }
      accessors.push({ bufferView: bufferViews.length, componentType: 5126, type: 'VEC3', count: g.pos.length / 3, min, max });
      bufferViews.push(vPos);
      accessors.push({ bufferView: bufferViews.length, componentType: 5126, type: 'VEC3', count: g.nor.length / 3 });
      bufferViews.push(vNor);
      accessors.push({ bufferView: bufferViews.length, componentType: 5123, type: 'SCALAR', count: g.idx.length });
      bufferViews.push(vIdx);

      meshes.push({
        name: part.name,
        primitives: [{ attributes: { POSITION: aiPos, NORMAL: aiPos + 1 }, indices: aiPos + 2, material: matIndex.get(part.matKey) }],
      });
      const node = { name: part.name, mesh: nodes.length };
      if (part.translation) node.translation = part.translation;
      nodes.push(node);
    }

    const gltf = {
      asset: { version: '2.0', generator: 'make-glb.mjs (vacuum-loader demo)' },
      scene: 0,
      scenes: [{ name: 'root', nodes: nodes.map((_, i) => i) }],
      nodes, meshes, accessors, bufferViews, materials,
      buffers: [{ byteLength: offset }],
    };

    // 拼装 GLB：12 字节头 + JSON 块 + BIN 块
    const jsonBuf = Buffer.from(JSON.stringify(gltf), 'utf8');
    const jsonPad = align4(jsonBuf.length) - jsonBuf.length;
    const binBuf = Buffer.concat(bin);
    const total = 12 + 8 + jsonBuf.length + jsonPad + 8 + binBuf.length;
    const out = Buffer.alloc(total);
    let p = 0;
    out.writeUInt32LE(0x46546c67, p); p += 4;       // "glTF"
    out.writeUInt32LE(2, p); p += 4;
    out.writeUInt32LE(total, p); p += 4;
    out.writeUInt32LE(jsonBuf.length + jsonPad, p); p += 4;
    out.writeUInt32LE(0x4e4f534a, p); p += 4;       // "JSON"
    jsonBuf.copy(out, p); p += jsonBuf.length;
    out.fill(0x20, p, p + jsonPad); p += jsonPad;
    out.writeUInt32LE(binBuf.length, p); p += 4;
    out.writeUInt32LE(0x004e4942, p); p += 4;       // "BIN\0"
    binBuf.copy(out, p);
    return out;
  }

  save(file) {
    const path = resolve(OUT, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, this.build());
    console.log('written', path);
  }
}

/* ---------------- 五个设备模型 ---------------- */

/** 1. 取料仓：方形支腿 + 锥形料斗 + 顶部围边 + 底部吸料嘴 */
function buildHopper() {
  const b = new GlbBuilder();
  // 料斗：圆筒段 + 锥段，原点在支腿底面（落于基座上表面）
  b.addPart('hopperBody', merge([
    lathe([[0.55, 1.05], [0.55, 0.72], [0.13, 0.22]], 36),
    torus(0.55, 0.035, 36, 8),
  ]), 'steel');
  // 四条支腿
  for (const [x, z] of [[0.42, 0.42], [-0.42, 0.42], [0.42, -0.42], [-0.42, -0.42]]) {
    b.addPart('leg', move(box(0.07, 1.0, 0.07), x, 0.5, z), 'frame');
  }
  // 底部吸料嘴（短管 + 法兰）
  b.addPart('pickupNozzle', move(cylinder(0.1, 0.1, 0.22, 24, true), 0, 0.12, 0), 'pipe');
  b.addPart('pickupFlange', move(torus(0.1, 0.025, 24, 8), 0, 0.24, 0), 'flange');
  b.save('hopper.glb');
}

/** 2. 输送管路套件：直管 / 90° 弯头 / 法兰，均以原点为基准，供主程序克隆摆放 */
function buildPipes() {
  const b = new GlbBuilder();
  b.addPart('straightPipe', cylinder(0.11, 0.11, 1, 24, true), 'pipe');
  b.addPart('elbow90', elbowSegment(0.3, 0.11, Math.PI / 2, 20, 12), 'pipe');
  b.addPart('flange', cylinder(0.16, 0.16, 0.05, 24, true), 'flange');
  b.save('pipes.glb');
}

/** 定角弯管：从 +X 方向弯向 +Y 方向，起点位于原点 */
function elbowSegment(R, tube, angle, tubular, radial) {
  const pos = [], nor = [], idx = [];
  const row = radial + 1;
  for (let i = 0; i <= tubular; i++) {
    const u = (i / tubular) * angle;
    for (let j = 0; j <= radial; j++) {
      const v = (j / radial) * Math.PI * 2;
      const cv = Math.cos(v), sv = Math.sin(v);
      const cx = R * (1 - Math.cos(u)), cy = R * Math.sin(u);
      pos.push(cx + tube * cv * Math.cos(u), cy + tube * cv * Math.sin(u), tube * sv);
      nor.push(cv * Math.cos(u), cv * Math.sin(u), sv);
    }
  }
  for (let i = 0; i < tubular; i++)
    for (let j = 0; j < radial; j++) {
      const a = i * row + j, c = a + row;
      idx.push(a, c, a + 1, a + 1, c, c + 1);
    }
  return pack(pos, nor, idx);
}

/** 3. 主机（集料仓一体）：罐体 + 锥底 + 顶盖 + 支腿 + 进料/排气接口 + 卸料阀 */
function buildChamber() {
  const b = new GlbBuilder();
  // 罐体圆柱 + 锥底（原点在支腿底面），半透明以便观察内部
  b.addPart('vessel', merge([
    lathe([[0.6, 2.45], [0.6, 1.05], [0.15, 0.28]], 40),
    torus(0.6, 0.03, 40, 8),
  ]), 'vesselGlass');
  // 顶盖 + 顶部排气短管
  b.addPart('lid', move(cylinder(0.62, 0.62, 0.08, 40), 0, 2.49, 0), 'steel');
  b.addPart('topNozzle', move(cylinder(0.12, 0.12, 0.22, 24, true), 0, 2.62, 0), 'pipe');
  b.addPart('topFlange', move(torus(0.12, 0.025, 24, 8), 0, 2.72, 0), 'flange');
  // 侧向进料口（-X 方向），中心高 1.55
  b.addPart('inlet', move(rotZ90(cylinder(0.12, 0.12, 0.3, 24, true), -1), -0.68, 1.55, 0), 'pipe');
  b.addPart('inletFlange', move(torus(0.12, 0.025, 24, 8), 0, 0, 0), 'flange');
  move(b.parts[b.parts.length - 1].geom, -0.84, 1.55, 0);
  // 蓝色装饰环带
  b.addPart('band', move(cylinder(0.605, 0.605, 0.1, 40, true), 0, 2.18, 0), 'blue');
  // 四条支腿
  for (const [x, z] of [[0.46, 0.46], [-0.46, 0.46], [0.46, -0.46], [-0.46, -0.46]]) {
    b.addPart('leg', move(box(0.09, 1.02, 0.09), x, 0.51, z), 'frame');
  }
  // 锥底卸料阀（方箱 + 短管）
  b.addPart('valveBox', move(box(0.26, 0.22, 0.26), 0, 0.18, 0), 'blue');
  b.addPart('discharge', move(cylinder(0.09, 0.09, 0.18, 20, true), 0, 0.02, 0), 'pipe');
  b.save('chamber.glb');
}

/** 4. 滤筒：褶皱滤芯（多段圆柱近似） + 上下端盖 + 中心吊杆，原点在滤芯底部中心 */
function buildFilter() {
  const b = new GlbBuilder();
  b.addPart('cartridge', cylinder(0.19, 0.19, 0.95, 36), 'media');
  b.addPart('capTop', move(cylinder(0.21, 0.21, 0.06, 36), 0, 0.5, 0), 'flange');
  b.addPart('capBottom', move(cylinder(0.21, 0.21, 0.06, 36), 0, -0.5, 0), 'flange');
  b.addPart('rod', move(cylinder(0.025, 0.025, 1.25, 12), 0, 0.6, 0), 'frame');
  b.save('filter.glb');
}

/** 5. 风机底座：底座 + 电机 + 蜗壳 + 可旋转叶轮(impeller) + 排气口，轴线沿 X */
function buildFan() {
  const b = new GlbBuilder();
  b.addPart('base', move(box(1.3, 0.18, 0.8), 0, 0.09, 0), 'frame');
  b.addPart('bracketA', move(box(0.1, 0.42, 0.5), -0.2, 0.39, 0), 'frame');
  b.addPart('bracketB', move(box(0.1, 0.42, 0.5), 0.45, 0.39, 0), 'frame');
  // 电机筒（X 轴）
  b.addPart('motor', move(rotZ90(cylinder(0.22, 0.22, 0.55, 28), 1), 0.5, 0.72, 0), 'motor');
  // 蜗壳
  b.addPart('volute', move(rotZ90(cylinder(0.34, 0.34, 0.28, 32), 1), -0.12, 0.72, 0), 'motor');
  // 排气口（+X 水平短管）
  b.addPart('outlet', move(rotZ90(cylinder(0.13, 0.13, 0.42, 24, true), 1), 0.42, 0.72, 0), 'pipe');
  b.addPart('outletFlange', move(rotZ90(torus(0.13, 0.025, 24, 8), 1), 0.64, 0.72, 0), 'flange');
  // 叶轮：圆盘 + 6 片叶片，独立节点，主程序按名查找并驱动旋转
  const impeller = merge([
    rotZ90(cylinder(0.12, 0.12, 0.06, 20), 1),
    ...Array.from({ length: 6 }, (_, i) => {
      const blade = box(0.04, 0.16, 0.08);
      const a = (i / 6) * Math.PI * 2;
      for (let k = 0; k < blade.pos.length; k += 3) {
        const x = blade.pos[k + 1], z = blade.pos[k + 2];
        blade.pos[k + 1] = x * Math.cos(a) - z * Math.sin(a) + 0.16 * Math.cos(a);
        blade.pos[k + 2] = x * Math.sin(a) + z * Math.cos(a) + 0.16 * Math.sin(a);
        const nx = blade.nor[k + 1], nz = blade.nor[k + 2];
        blade.nor[k + 1] = nx * Math.cos(a) - nz * Math.sin(a);
        blade.nor[k + 2] = nx * Math.sin(a) + nz * Math.cos(a);
      }
      return blade;
    }),
  ]);
  b.addPart('impeller', impeller, 'orange', [-0.12, 0.72, 0]);
  b.save('fan_base.glb');
}

mkdirSync(OUT, { recursive: true });
buildHopper();
buildPipes();
buildChamber();
buildFilter();
buildFan();
console.log('all GLB models generated.');
