'use strict';
//
// Engine and model installation.
//
// Design notes:
//   "we need to avoid manual pinokio install (replace with bundable solution or
//    embed into app (per-os executables)"
//   "but i wanted download for user, not manual install"
//   "why Wan 2.1 I2V (real video diffusion) isnt installable (no button)?"
//
// The original shipped a Pinokio dependency the user had to install by hand.
// Here every engine and model is an entry in a registry with a download button,
// a size, a status probe and an uninstall — including the video engines, which
// is what "no button" was complaining about. Nothing is hidden behind a manual
// step, and anything not installable on the current platform says why instead of
// silently missing its button.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawn } = require('child_process');
const { downloadFile, fetchJson, humanBytes } = require('./download');

// ─── Platform ──────────────────────────────────────────────────────────────

function platformKey() {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'macos-arm64' : 'macos-x64';
  if (process.platform === 'win32') return 'win-x64';
  return 'linux-x64';
}

// ─── Registry ──────────────────────────────────────────────────────────────
//
// `kind: 'engine'` entries are executables, `kind: 'model'` entries are weights.
// `platforms: null` means every platform.

const ENGINES = [
  {
    id: 'sdcpp',
    kind: 'engine',
    name: 'stable-diffusion.cpp',
    purpose: 'Image generation (and the still frames behind every video mode)',
    required: true,
    platforms: null,
    // Resolved from the GitHub release feed at install time; upstream renames
    // assets between builds, so pinning a filename here would rot.
    github: { repo: 'leejet/stable-diffusion.cpp', assetMatch: {
      'macos-arm64': /bin-macos-arm64\.zip$/i,
      'macos-x64':   /bin-macos-x64\.zip$/i,
      'win-x64':     /bin-win-avx2-x64\.zip$/i,
      'linux-x64':   /bin-ubuntu.*x64\.zip$/i,
    } },
    binary: { 'win-x64': 'sd.exe', default: 'sd' },
    approxBytes: 12 * 1024 * 1024,
  },
  {
    id: 'ffmpeg',
    kind: 'engine',
    name: 'FFmpeg',
    purpose: 'Composition, Ken Burns motion, audio muxing',
    required: true,
    platforms: null,
    // Preferred from the system: distro packages are better maintained than a
    // vendored copy, and most machines already have one.
    system: { probe: 'ffmpeg -version', hint: {
      darwin: 'brew install ffmpeg',
      win32: 'winget install Gyan.FFmpeg',
      linux: 'sudo apt install ffmpeg',
    } },
    approxBytes: 0,
  },
];

// Models come from the two-stack registry in stacks.ts rather than a second
// hardcoded list.
//
// WHY: this file used to own its own `MODELS` array. Adding the Studio stack
// would have meant maintaining the same models in two places, and the two would
// drift — a model added to stacks.ts but missing here resolves to `null` in
// `find()`, which surfaces as "model not downloaded" for a model the advisor
// just recommended. One registry, one source of truth.
//
// The shape is adapted, not replaced: `approxBytes` is what the download UI and
// progress bars already use, so it is derived from the registry's measured
// `downloadGb` instead of being restated.
const { allItems } = require('./stacks');

const MODELS = allItems().map((m) => ({
  id: m.id,
  kind: 'model',
  name: m.name,
  purpose: m.purpose,
  engine: m.engine,
  // Only the baseline image model and the planner are required for a usable
  // first run; everything else is opt-in, exactly as before. The advisor
  // decides what to SUGGEST, this decides what is mandatory.
  required: m.id === 'sd15',
  file: m.file,
  url: m.url,
  approxBytes: Math.round((m.downloadGb || 0) * 1024 ** 3),
  heavy: !!m.heavy,
  stack: m.stack,
  role: m.role,
  note: m.note,
  // Carried through so status() can mark a primary model's mandatory
  // companions as required too. Dropping this field made FLUX report "ready"
  // with no VAE or text encoder — which looks installed and then fails at load.
  companions: m.companions,
}));

// ─── Paths ─────────────────────────────────────────────────────────────────

class Setup {
  /** @param {{enginesDir:string, modelsDir:string}} dirs */
  constructor({ enginesDir, modelsDir }) {
    this.enginesDir = enginesDir;
    this.modelsDir = modelsDir;
    for (const d of [enginesDir, modelsDir]) {
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    }
    this.active = new Map(); // id -> AbortController
  }

  engineBinaryPath(engine) {
    const key = platformKey();
    const name = engine.binary ? (engine.binary[key] || engine.binary.default) : engine.id;
    return path.join(this.enginesDir, engine.id, name);
  }

  modelPath(model) { return path.join(this.modelsDir, model.file); }

  // ─── Status ──────────────────────────────────────────────────────────────

  systemBinary(engine) {
    if (!engine.system) return null;
    try {
      execSync(engine.system.probe, { timeout: 5000, stdio: 'pipe' });
      return engine.id;
    } catch { return null; }
  }

  engineStatus(engine) {
    const supported = !engine.platforms || engine.platforms.includes(platformKey());
    if (!supported) {
      return { id: engine.id, installed: false, supported: false,
        reason: `Not available for ${platformKey()}` };
    }
    if (engine.system) {
      const found = this.systemBinary(engine);
      return {
        id: engine.id, installed: !!found, supported: true, viaSystem: true,
        hint: found ? null : engine.system.hint[process.platform],
      };
    }
    const p = this.engineBinaryPath(engine);
    return { id: engine.id, installed: fs.existsSync(p), supported: true, path: p };
  }

  modelStatus(model) {
    const p = this.modelPath(model);
    let size = 0;
    try { size = fs.statSync(p).size; } catch {}
    return { id: model.id, installed: size > 0, path: p, sizeOnDisk: size };
  }

  /**
   * @param {object} [opts]
   * @param {Record<string,string>} [opts.modelStack] the advisor's per-role
   *   selection, from settings. When present it REPLACES the static `required`
   *   flag for models.
   */
  status(opts = {}) {
    const engines = ENGINES.map((e) => ({
      ...e, github: undefined, system: undefined, binary: undefined,
      approxHuman: e.approxBytes ? humanBytes(e.approxBytes) : null,
      ...this.engineStatus(e),
    }));
    const models = MODELS.map((m) => ({
      ...m, url: undefined,
      approxHuman: humanBytes(m.approxBytes),
      ...this.modelStatus(m),
    }));

    // "Required" means required FOR THE SELECTED STACK, not a fixed list.
    //
    // Before this, `required` was hardcoded to sd15. Once the advisor could
    // recommend FLUX.2 Klein, a Studio-stack user was shown a warning badge and
    // "Missing required: Stable Diffusion 1.5" for a 1.7 GB model the app would
    // never load — pushing a pointless download and implying the app was not
    // ready when it was.
    //
    // With a stack selected, the requirement is exactly the models filling the
    // roles the pipeline cannot skip, PLUS their mandatory companions (ACE-Step
    // needs its LM stage; FLUX needs its VAE and text encoder — a primary model
    // alone looks installed and then fails at load).
    //
    // Falls back to the static flag when no stack has been chosen yet, which is
    // the pre-advisor behaviour and the correct answer on a first run that has
    // not reached the startup check.
    const stack = opts.modelStack && Object.keys(opts.modelStack).length ? opts.modelStack : null;
    let requiredModelIds;
    if (stack) {
      // 'animation' is intentionally excluded: it is the one optional role, and
      // Ken Burns covers motion without any model at all.
      const essential = ['plot', 'images', 'diction', 'music'];
      requiredModelIds = new Set();
      for (const role of essential) {
        const id = stack[role];
        if (!id) continue;
        requiredModelIds.add(id);
        const entry = MODELS.find((m) => m.id === id);
        for (const c of entry?.companions || []) requiredModelIds.add(c);
      }
    }

    const modelIsRequired = (m) => (requiredModelIds ? requiredModelIds.has(m.id) : m.required);

    const missingRequired = [
      ...engines.filter((e) => e.required && !e.installed).map((e) => e.name),
      ...models.filter((m) => modelIsRequired(m) && !m.installed).map((m) => m.name),
    ];
    return {
      platform: platformKey(),
      engines,
      // Re-stamp each row's `required` flag so the per-model "Required" pill
      // agrees with the banner above it. Leaving the static flag here would
      // show "Required" on SD 1.5 while the banner said everything was ready.
      models: models.map((m) => ({ ...m, required: modelIsRequired(m) })),
      ready: missingRequired.length === 0,
      missingRequired,
      enginesDir: this.enginesDir,
      modelsDir: this.modelsDir,
    };
  }

  // ─── Install ─────────────────────────────────────────────────────────────

  find(id) {
    return ENGINES.find((e) => e.id === id) || MODELS.find((m) => m.id === id) || null;
  }

  cancel(id) {
    const ctrl = this.active.get(id);
    if (ctrl) { ctrl.abort(); this.active.delete(id); return true; }
    return false;
  }

  async install(id, onProgress = () => {}) {
    const item = this.find(id);
    if (!item) throw new Error(`Unknown component: ${id}`);
    if (this.active.has(id)) throw new Error(`${item.name} is already downloading`);

    const ctrl = new AbortController();
    this.active.set(id, ctrl);
    try {
      if (item.kind === 'model') return await this.installModel(item, onProgress, ctrl.signal);
      return await this.installEngine(item, onProgress, ctrl.signal);
    } finally {
      this.active.delete(id);
    }
  }

  async installModel(model, onProgress, signal) {
    const dest = this.modelPath(model);
    onProgress({ id: model.id, phase: 'download', pct: 0, note: `Downloading ${model.name}` });
    await downloadFile(model.url, dest, {
      signal,
      onProgress: (p) => onProgress({
        id: model.id, phase: 'download', pct: p.pct,
        note: `${humanBytes(p.received)} of ${humanBytes(p.total)} · ${humanBytes(p.speed)}/s`,
      }),
    });
    onProgress({ id: model.id, phase: 'done', pct: 100, note: 'Installed' });
    return { installed: true, path: dest };
  }

  async installEngine(engine, onProgress, signal) {
    if (engine.system) {
      // Nothing to download — surface the one command that installs it.
      const found = this.systemBinary(engine);
      if (found) return { installed: true, viaSystem: true };
      throw new Error(
        `${engine.name} must come from your package manager. Run: ${engine.system.hint[process.platform]}`,
      );
    }

    const key = platformKey();
    const pattern = engine.github.assetMatch[key];
    if (!pattern) throw new Error(`${engine.name} has no build for ${key}`);

    onProgress({ id: engine.id, phase: 'resolve', pct: 0, note: 'Finding latest release…' });
    const rel = await fetchJson(`https://api.github.com/repos/${engine.github.repo}/releases/latest`);
    const asset = (rel.assets || []).find((a) => pattern.test(a.name));
    if (!asset) {
      throw new Error(`No ${key} asset in ${engine.github.repo} ${rel.tag_name}. Assets: ${(rel.assets || []).map(a => a.name).join(', ') || 'none'}`);
    }

    const outDir = path.join(this.enginesDir, engine.id);
    fs.mkdirSync(outDir, { recursive: true });
    const zipPath = path.join(outDir, asset.name);

    await downloadFile(asset.browser_download_url, zipPath, {
      signal,
      onProgress: (p) => onProgress({
        id: engine.id, phase: 'download', pct: p.pct * 0.9,
        note: `${humanBytes(p.received)} of ${humanBytes(p.total)} · ${rel.tag_name}`,
      }),
    });

    onProgress({ id: engine.id, phase: 'extract', pct: 92, note: 'Extracting…' });
    await extractZip(zipPath, outDir);
    try { fs.unlinkSync(zipPath); } catch {}

    // Release archives vary in whether they nest a directory; find the binary.
    const binName = engine.binary[key] || engine.binary.default;
    const found = findFile(outDir, binName);
    if (!found) throw new Error(`Extracted ${engine.name} but could not find "${binName}" inside the archive`);
    const target = this.engineBinaryPath(engine);
    if (found !== target) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(found, target);
    }
    if (process.platform !== 'win32') { try { fs.chmodSync(target, 0o755); } catch {} }

    onProgress({ id: engine.id, phase: 'done', pct: 100, note: `Installed ${rel.tag_name}` });
    return { installed: true, path: target, version: rel.tag_name };
  }

  uninstall(id) {
    const item = this.find(id);
    if (!item) throw new Error(`Unknown component: ${id}`);
    const target = item.kind === 'model' ? this.modelPath(item) : path.join(this.enginesDir, item.id);
    try { fs.rmSync(target, { recursive: true, force: true }); } catch (e) { throw new Error(e.message); }
    return { installed: false };
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function extractZip(zip, dest) {
  return new Promise((resolve, reject) => {
    // Both platforms ship a usable extractor, which avoids pulling a native
    // unzip dependency into the packaged app.
    const cmd = process.platform === 'win32'
      ? { bin: 'powershell', args: ['-NoProfile', '-Command', `Expand-Archive -LiteralPath "${zip}" -DestinationPath "${dest}" -Force`] }
      : { bin: 'unzip', args: ['-o', '-q', zip, '-d', dest] };
    const p = spawn(cmd.bin, cmd.args, { stdio: 'pipe' });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', reject);
    p.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Extract failed (${code}): ${err.trim()}`)));
  });
}

function findFile(dir, name, depth = 4) {
  if (depth < 0) return null;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === name) return p;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const hit = findFile(path.join(dir, e.name), name, depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}

module.exports = { Setup, ENGINES, MODELS, platformKey };
