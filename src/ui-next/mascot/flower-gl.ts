// The glass pinwheel flower in WebGL (B2, B4). This module is only reached through a dynamic
// import from Mascot.tsx, so three.js lands in its own chunk, loaded at idle time.
//
// It draws on demand: a frame runs only while the flower is turning toward a new orientation or
// spinning while the page is thinking (M1). Size is the DOM box's job (CSS), so layout changes
// never redraw the canvas.
import {
  ACESFilmicToneMapping,
  BufferGeometry,
  Color,
  CurvePath,
  DirectionalLight,
  DoubleSide,
  Euler,
  Float32BufferAttribute,
  HemisphereLight,
  LineCurve,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  PMREMGenerator,
  PerspectiveCamera,
  PlaneGeometry,
  QuadraticBezierCurve,
  Quaternion,
  Scene,
  type Texture,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { Orientation } from './orientation';

const DEG = Math.PI / 180;
const WHITE = 0xffffff;
const Z_AXIS = new Vector3(0, 0, 1);
/** One petal of six: the "settle" step (B2). */
const PETAL = Math.PI / 3;
/** Thinking spin, radians per second: a pinwheel in a light breeze. */
const SPIN_SPEED = 1.5;
/** How quickly the flower turns toward its goal orientation (per second, exponential). */
const TURN_RATE = 5.5;

export interface FlowerHandle {
  setRotation(orientation: Orientation): void;
  setThinking(on: boolean): void;
  /** Stand `turns` petals forward from the start (B2); idempotent, so it can be re-sent. */
  setTurns(turns: number): void;
  setTint(accent: string): void;
  dispose(): void;
}

export interface FlowerOptions {
  /** Drawing size in CSS px (square). */
  size: number;
  /** The accent colour the glass is faintly tinted with. */
  tint: string;
  /** Where the flower faces on its first frame. */
  rotation: Orientation;
  /** Petals already turned before the glass took over, so it starts where the still one is. */
  turns?: number;
  /**
   * The flower can no longer draw: the context was lost (GPU reset, too many contexts) or a
   * shader failed to compile later on. Fall back to the still flower.
   */
  onFail?: (reason: 'context-lost' | 'shader-failed') => void;
}

/** Thrown by createFlower when the first frame's shaders fail to compile or link. */
export class FlowerShaderError extends Error {}

/** A small warm "studio" of emissive panels: something for the glass to reflect and refract. */
function studio(renderer: WebGLRenderer): Texture {
  const env = new Scene();
  env.background = new Color(0x55514c);
  const panel = (w: number, h: number, pos: [number, number, number], ry: number, c: number) => {
    const m = new Mesh(
      new PlaneGeometry(w, h),
      new MeshBasicMaterial({ color: c, side: DoubleSide }),
    );
    m.position.set(...pos);
    m.rotation.y = ry;
    env.add(m);
  };
  panel(7, 4, [-1, 4, 5], -0.2, WHITE);
  panel(2, 7, [4, 1, 5], -0.55, WHITE);
  panel(5, 3, [0, -4, 3], 0, 0x17191e);
  panel(3, 4, [-5, 1, 0], Math.PI / 2, 0xfff6ec);
  panel(3, 4, [5, 0, -1], -Math.PI / 2, 0xffd9c4);
  const pmrem = new PMREMGenerator(renderer);
  try {
    return pmrem.fromScene(env, 0.05).texture;
  } finally {
    pmrem.dispose();
    env.traverse((o) => {
      if (o instanceof Mesh) {
        o.geometry.dispose();
        (o.material as MeshBasicMaterial).dispose();
      }
    });
  }
}

/**
 * Six rounded trapezoids sharing one rim and hub, swept into a tube: broad straight outer edges,
 * offset shoulders for the pinwheel, no pointed tips. FlowerStill.tsx draws the same rim flat.
 */
function petals(): BufferGeometry {
  const corners: Vector2[] = [];
  for (let i = 0; i < 6; i++) {
    for (const [degrees, radius] of [
      [0, 0.87],
      [19, 1.37],
      [54, 1.37],
    ] as const) {
      const a = (i * 60 + degrees) * DEG;
      corners.push(new Vector2(Math.cos(a) * radius, Math.sin(a) * radius));
    }
  }
  const n = corners.length;
  const at = (i: number) => corners[((i % n) + n) % n] as Vector2;
  const outline = new CurvePath<Vector2>();
  const entries = corners.map((p, i) => p.clone().lerp(at(i - 1), 0.22));
  const exits = corners.map((p, i) => p.clone().lerp(at(i + 1), 0.22));
  for (let i = 0; i < n; i++) {
    outline.add(new QuadraticBezierCurve(entries[i], corners[i], exits[i]));
    outline.add(new LineCurve(exits[i] as Vector2, entries[(i + 1) % n] as Vector2));
  }
  const segments = 288;
  const section = 64;
  const rim = outline.getSpacedPoints(segments);
  const positions: number[] = [];
  const index: number[] = [];
  for (let i = 0; i < segments; i++) {
    const p = rim[i] as Vector2;
    const angle = Math.atan2(p.y, p.x);
    const outer = p.length();
    for (let j = 0; j < section; j++) {
      const t = (j / section) * Math.PI * 2;
      const radial = (1 + Math.cos(t)) * 0.5;
      const radius = 0.22 + (outer - 0.22) * radial;
      const sweep = angle - 0.38 * (1 - radial);
      const curl = 0.07 * radial * Math.sin(6 * angle - 0.5);
      const depth = 0.23 * Math.sin(t);
      positions.push(radius * Math.cos(sweep), radius * Math.sin(sweep), depth + curl);
    }
  }
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < section; j++) {
      const a = i * section + j;
      const b = ((i + 1) % segments) * section + j;
      const c = i * section + ((j + 1) % section);
      const d = ((i + 1) % segments) * section + ((j + 1) % section);
      index.push(a, b, c, b, d, c);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

function glass(): MeshPhysicalMaterial {
  const material = new MeshPhysicalMaterial({
    metalness: 0,
    roughness: 0.055,
    transmission: 1,
    transparent: true,
    premultipliedAlpha: true,
    side: DoubleSide,
    thickness: 0.38,
    ior: 1.46,
    attenuationDistance: 1.6,
    envMapIntensity: 1.65,
    clearcoat: 1,
    clearcoatRoughness: 0.08,
  });
  // r170 clears its transmission buffer to half-transparent white on a transparent canvas. This
  // flower has no scene behind it, so refract the studio instead and composite the glass over the
  // page with Fresnel and absorption as its coverage.
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <transmission_fragment>',
        `#include <transmission_fragment>
        float glassFacing = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
        vec3 glassWorldNormal = inverseTransformDirection(normal, viewMatrix);
        vec3 glassWorldView = normalize(cameraPosition - vWorldPosition);
        vec3 glassRay = refract(-glassWorldView, glassWorldNormal, 1.0 / ior);
        float glassPath = thickness / max(glassFacing, 0.25);
        vec3 glassAbsorption = volumeAttenuation(glassPath, attenuationColor, attenuationDistance);
        float glassLoss = 1.0 - dot(glassAbsorption, vec3(0.333333));
        float glassRefraction = 0.16;
        totalDiffuse = textureCubeUV(envMap, envMapRotation * glassRay, roughness).rgb
          * glassAbsorption * glassRefraction * envMapIntensity;
        float glassFresnel = 0.035 + 0.965 * pow(1.0 - glassFacing, 5.0);
        material.transmissionAlpha =
          1.0 - (1.0 - glassLoss) * (1.0 - glassRefraction) * (1.0 - glassFresnel);`,
      )
      .replace(
        '#include <opaque_fragment>',
        `material.transmissionAlpha = max(material.transmissionAlpha,
          min(0.85, max(outgoingLight.r, max(outgoingLight.g, outgoingLight.b))));
        outgoingLight /= max(material.transmissionAlpha, 0.001);
        #include <opaque_fragment>`,
      );
  };
  material.customProgramCacheKey = () => 'un-flower-glass-r170';
  return material;
}

function tintGlass(material: MeshPhysicalMaterial, accent: string) {
  const color = new Color();
  try {
    color.setStyle(accent);
  } catch {
    color.set(0xd97757);
  }
  material.color.set(WHITE).lerp(color, 0.025);
  material.attenuationColor.set(WHITE).lerp(color, 0.14);
}

/**
 * Build the renderer on `canvas`. Throws if WebGL cannot be created or the first frame's shaders
 * fail (FlowerShaderError); either way nothing is left holding the context.
 */
export function createFlower(canvas: HTMLCanvasElement, options: FlowerOptions): FlowerHandle {
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
  // Everything made after the renderer, released in reverse if building fails part-way.
  const owned: (() => void)[] = [];
  try {
    return assemble(canvas, renderer, options, owned);
  } catch (error) {
    for (const release of owned.reverse()) release();
    renderer.debug.onShaderError = null;
    renderer.dispose();
    renderer.forceContextLoss();
    throw error;
  }
}

function assemble(
  canvas: HTMLCanvasElement,
  renderer: WebGLRenderer,
  options: FlowerOptions,
  owned: (() => void)[],
): FlowerHandle {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(options.size, options.size, false);
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  // three only logs a failed compile or link and then draws nothing: catch it instead.
  let built = false;
  let shaderFailed = false;
  renderer.debug.onShaderError = () => {
    shaderFailed = true;
    if (built) options.onFail?.('shader-failed');
  };

  const scene = new Scene();
  const environment = studio(renderer);
  owned.push(() => environment.dispose());
  scene.environment = environment;
  scene.add(new HemisphereLight(WHITE, 0x8a7f72, 0.45));
  const key = new DirectionalLight(0xfff8f0, 1.9);
  key.position.set(-2.5, 3.5, 4);
  scene.add(key);
  const rim = new DirectionalLight(0xffe6d6, 0.6);
  rim.position.set(3, -1, -2);
  scene.add(rim);
  const camera = new PerspectiveCamera(30, 1, 0.1, 50);
  camera.position.set(0, 0, 6.2);

  const geometry = petals();
  owned.push(() => geometry.dispose());
  const material = glass();
  owned.push(() => material.dispose());
  tintGlass(material, options.tint);
  const flower = new Mesh(geometry, material);
  scene.add(flower);

  const target = new Quaternion();
  const goal = new Quaternion();
  const twist = new Quaternion();
  const euler = new Euler();
  let turned = options.turns ?? 0;
  let spin = (turned * PETAL) % (Math.PI * 2);
  let thinking = false;
  let frame = 0;
  let last = 0;
  let disposed = false;

  const aimGoal = () => {
    goal.copy(target);
    if (spin) goal.multiply(twist.setFromAxisAngle(Z_AXIS, spin));
  };
  const draw = (now: number) => {
    const dt = Math.min(0.05, (now - (last || now)) / 1000);
    last = now;
    if (thinking) spin = (spin + dt * SPIN_SPEED) % (Math.PI * 2);
    aimGoal();
    flower.quaternion.slerp(goal, 1 - Math.exp(-dt * TURN_RATE));
    renderer.render(scene, camera);
    if (thinking || flower.quaternion.angleTo(goal) > 0.0015) {
      frame = requestAnimationFrame(draw);
    } else {
      frame = 0;
      last = 0;
    }
  };
  const wake = () => {
    if (!disposed && !frame) frame = requestAnimationFrame(draw);
  };

  const onLost = (event: Event) => {
    event.preventDefault();
    cancelAnimationFrame(frame);
    frame = 0;
    options.onFail?.('context-lost');
  };
  canvas.addEventListener('webglcontextlost', onLost);
  owned.push(() => canvas.removeEventListener('webglcontextlost', onLost));

  // First frame: already facing where the slot asks and turned as far as the still flower was,
  // rather than turning in from straight-on.
  euler.set(options.rotation.x * DEG, options.rotation.y * DEG, options.rotation.z * DEG);
  target.setFromEuler(euler);
  aimGoal();
  flower.quaternion.copy(goal);
  renderer.render(scene, camera);
  if (shaderFailed) throw new FlowerShaderError('mascot shader failed to compile');
  built = true;

  return {
    setRotation({ x, y, z }) {
      euler.set(x * DEG, y * DEG, z * DEG);
      target.setFromEuler(euler);
      wake();
    },
    setThinking(on) {
      thinking = on;
      wake();
    },
    setTurns(turns) {
      if (turns === turned) return;
      spin = (spin + (turns - turned) * PETAL) % (Math.PI * 2);
      turned = turns;
      wake();
    },
    setTint(accent) {
      tintGlass(material, accent);
      wake();
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      renderer.debug.onShaderError = null;
      for (const release of owned.reverse()) release();
      owned.length = 0;
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
