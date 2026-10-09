// Real-3D mark renderer (WebGL via three.js from a pinned CDN build — prototype only, no repo
// dependency). Renders on demand: frames run only while the mark is moving or "thinking".
const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.min.js';
let threePromise;
export function loadThree() {
  threePromise ??= import(/* @vite-ignore */ THREE_URL);
  return threePromise;
}

const DEG = Math.PI / 180;

function makeEnv(THREE, renderer, warm) {
  // A tiny "studio": a few soft emissive panels give physical materials something to reflect.
  const env = new THREE.Scene();
  env.background = new THREE.Color(warm ? 0x55514c : 0x4d535f);
  const panel = (w, h, x, y, z, ry, c) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide }));
    m.position.set(x, y, z);
    m.rotation.y = ry;
    env.add(m);
  };
  panel(7, 4, -1, 4, 5, -0.2, 0xffffff);
  panel(2, 7, 4, 1, 5, -0.55, 0xffffff);
  panel(5, 3, 0, -4, 3, 0, 0x17191e);
  panel(3, 4, -5, 1, 0, Math.PI / 2, 0xfff6ec);
  panel(3, 4, 5, 0, -1, -Math.PI / 2, warm ? 0xffd9c4 : 0xd6deff);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const tex = pmrem.fromScene(env, 0.05).texture;
  pmrem.dispose();
  return tex;
}

function buildKnot(THREE, pal) {
  const g = new THREE.Group();
  const body = new THREE.MeshPhysicalMaterial({ color: pal.body, roughness: 0.32, metalness: 0.05, clearcoat: 1, clearcoatRoughness: 0.15 });
  const knot = new THREE.Mesh(new THREE.TorusKnotGeometry(0.82, 0.075, 360, 24, 2, 3), body);
  g.add(knot);
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(1.22, 0.018, 16, 180),
    new THREE.MeshPhysicalMaterial({ color: pal.accent, roughness: 0.25, metalness: 0.2, clearcoat: 1 }),
  );
  ring.rotation.x = 72 * DEG;
  g.add(ring);
  return g;
}

function petalGeometry(THREE) {
  // Six rounded trapezoids share one continuous rim and hub. Their outer edges stay
  // broad and straight; the offset shoulders give a pinwheel without pointed tips.
  const corners = [];
  for (let i = 0; i < 6; i++) {
    for (const [degrees, radius] of [[0, 0.87], [19, 1.37], [54, 1.37]]) {
      const a = (i * 60 + degrees) * DEG;
      corners.push(new THREE.Vector2(Math.cos(a) * radius, Math.sin(a) * radius));
    }
  }
  const outline = new THREE.CurvePath();
  const entries = corners.map((p, i) => p.clone().lerp(corners[(i + corners.length - 1) % corners.length], 0.22));
  const exits = corners.map((p, i) => p.clone().lerp(corners[(i + 1) % corners.length], 0.22));
  for (let i = 0; i < corners.length; i++) {
    outline.add(new THREE.QuadraticBezierCurve(entries[i], corners[i], exits[i]));
    outline.add(new THREE.LineCurve(exits[i], entries[(i + 1) % corners.length]));
  }
  const segments = 288;
  const section = 64;
  const rim = outline.getSpacedPoints(segments);
  const pos = [];
  const idx = [];
  for (let i = 0; i < segments; i++) {
    const angle = Math.atan2(rim[i].y, rim[i].x);
    const outer = rim[i].length();
    for (let j = 0; j < section; j++) {
      const t = (j / section) * Math.PI * 2;
      const radial = (1 + Math.cos(t)) * 0.5;
      const radius = 0.22 + (outer - 0.22) * radial;
      const sweep = angle - 0.38 * (1 - radial);
      const curl = 0.07 * radial * Math.sin(6 * angle - 0.5);
      const depth = 0.23 * Math.sin(t);
      pos.push(radius * Math.cos(sweep), radius * Math.sin(sweep), depth + curl);
    }
  }
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < section; j++) {
      const a = i * section + j;
      const b = ((i + 1) % segments) * section + j;
      const c = i * section + (j + 1) % section;
      const d = ((i + 1) % segments) * section + (j + 1) % section;
      idx.push(a, b, c, b, d, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

function buildFlower(THREE, pal) {
  const g = new THREE.Group();
  const glass = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(0xffffff).lerp(new THREE.Color(pal.accent), 0.025),
    metalness: 0,
    roughness: 0.055,
    transmission: 1,
    transparent: true,
    premultipliedAlpha: true,
    side: THREE.DoubleSide,
    thickness: 0.38,
    ior: 1.46,
    attenuationColor: new THREE.Color(0xffffff).lerp(new THREE.Color(pal.accent), 0.14),
    attenuationDistance: 1.6,
    envMapIntensity: 1.65,
    clearcoat: 1,
    clearcoatRoughness: 0.08,
  });
  // r170 clears its transmission buffer to white at alpha 0.5 when the canvas is
  // transparent. This isolated mark has no scene behind it: refract the studio instead,
  // and composite its weak contribution over the DOM with Fresnel/absorption coverage.
  glass.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <transmission_fragment>', `
      #include <transmission_fragment>
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
      material.transmissionAlpha = 1.0 - (1.0 - glassLoss) * (1.0 - glassRefraction) * (1.0 - glassFresnel);
    `).replace('#include <opaque_fragment>', `
      material.transmissionAlpha = max(material.transmissionAlpha,
        min(0.85, max(outgoingLight.r, max(outgoingLight.g, outgoingLight.b))));
      outgoingLight /= max(material.transmissionAlpha, 0.001);
      #include <opaque_fragment>
    `);
  };
  glass.customProgramCacheKey = () => 'loom-glass-alpha-r170';
  g.add(new THREE.Mesh(petalGeometry(THREE), glass));
  return g;
}

function buildSurface(THREE, pal) {
  // Hyperboloid of one sheet drawn as its two families of rulings (string art) plus a faint skin.
  // Lines join the bottom circle at angle t to the top circle at t ± phi; the waist radius is
  // R·cos(phi/2) and the surface satisfies r(h)² = w² + (R² − w²)(h/H)².
  const g = new THREE.Group();
  const R = 1;
  const H = 1.05;
  const n = 36;
  const phi = 120 * DEG;
  const w = R * Math.cos(phi / 2);
  const pts = [];
  for (const sign of [1, -1]) {
    for (let i = 0; i < n; i++) {
      const t = (i / n) * 2 * Math.PI;
      pts.push(new THREE.Vector3(R * Math.cos(t), -H, R * Math.sin(t)));
      pts.push(new THREE.Vector3(R * Math.cos(t + sign * phi), H, R * Math.sin(t + sign * phi)));
    }
  }
  g.add(
    new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: pal.ink, transparent: true, opacity: 0.55 }),
    ),
  );
  const prof = [];
  for (let i = 0; i <= 48; i++) {
    const h = -H + (2 * H * i) / 48;
    prof.push(new THREE.Vector2(Math.sqrt(w * w + (R * R - w * w) * (h / H) ** 2) * 0.985, h));
  }
  g.add(
    new THREE.Mesh(
      new THREE.LatheGeometry(prof, 96),
      new THREE.MeshPhysicalMaterial({
        color: pal.soft,
        roughness: 0.2,
        transmission: 0.6,
        thickness: 0.2,
        transparent: true,
        opacity: 0.5,
        side: THREE.DoubleSide,
      }),
    ),
  );
  const waist = new THREE.Mesh(new THREE.TorusGeometry(w, 0.014, 12, 120), new THREE.MeshBasicMaterial({ color: pal.accent }));
  waist.rotation.x = Math.PI / 2;
  g.add(waist);
  return g;
}

const BUILD = { knot: buildKnot, flower: buildFlower, surface: buildSurface };

export async function createGLMark(canvas, { kind, pal, warm }) {
  const THREE = await loadThree();
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const scene = new THREE.Scene();
  scene.environment = makeEnv(THREE, renderer, warm);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7f72, 0.45));
  const key = new THREE.DirectionalLight(0xfff8f0, 1.9);
  key.position.set(-2.5, 3.5, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffe6d6, 0.6);
  rim.position.set(3, -1, -2);
  scene.add(rim);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  camera.position.set(0, 0, 6.2);

  const root = new THREE.Group();
  scene.add(root);
  let obj = BUILD[kind](THREE, pal);
  root.add(obj);

  const target = new THREE.Quaternion();
  const euler = new THREE.Euler();
  let spin = 0;
  let thinking = false;
  let raf = 0;
  let last = 0;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const size = () => {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(() => {
    size();
    renderer.render(scene, camera);
  });
  ro.observe(canvas);
  size();

  const frame = (t) => {
    const dt = Math.min(0.05, (t - (last || t)) / 1000);
    last = t;
    if (thinking) spin += dt * 1.5; // turns like a pinwheel in a breeze
    const goal = target.clone();
    if (spin) goal.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), spin)); // spin about its own face normal
    if (reduce) root.quaternion.copy(goal);
    else root.quaternion.slerp(goal, 1 - Math.exp(-dt * 5.5));
    renderer.render(scene, camera);
    if (thinking || root.quaternion.angleTo(goal) > 0.0015) raf = requestAnimationFrame(frame);
    else {
      raf = 0;
      last = 0;
    }
  };
  const wake = () => {
    if (!raf) raf = requestAnimationFrame(frame);
  };

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
    pulse() {
      // Quarter turn as a quiet "received" acknowledgement.
      spin += Math.PI / 3; // one blade forward
      wake();
    },
    setLook(nextKind, nextPal, nextWarm) {
      root.remove(obj);
      obj.traverse((o) => {
        o.geometry?.dispose();
        o.material?.dispose();
      });
      obj = BUILD[nextKind](THREE, nextPal);
      root.add(obj);
      scene.environment = makeEnv(THREE, renderer, nextWarm);
      wake();
    },
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.dispose();
    },
  };
}
