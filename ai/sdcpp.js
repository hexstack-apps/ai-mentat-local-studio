'use strict';
//
// stable-diffusion.cpp driver — every still frame in the app comes from here.
//
// Runs the `sd` binary as a child process, streaming its output into the run log
// so a failure is visible rather than silent, and honouring cancellation so the
// Stop button can actually interrupt a generation mid-step.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/** Progress lines from sd.cpp look like "  |==>  | 7/20 - 1.23s/it". */
const STEP_RE = /(\d+)\s*\/\s*(\d+)/;

class SdCpp {
  /**
   * @param {object} opts
   * @param {string} opts.binary     path to the `sd` executable
   * @param {string} opts.modelPath  path to the .gguf weights
   * @param {string} [opts.arch]     'sd' (default) | 'flux'
   * @param {string} [opts.vaePath]  FLUX only — separate VAE weights
   * @param {string} [opts.clipPath] FLUX only — separate text encoder
   * @param {import('./logger').RunLogger} opts.logger
   */
  constructor({ binary, modelPath, logger, arch = 'sd', vaePath, clipPath }) {
    this.binary = binary;
    this.modelPath = modelPath;
    this.logger = logger;
    // FLUX is not a drop-in for the SD checkpoint layout. sd.cpp loads a
    // monolithic SD/SDXL checkpoint with `-m`, but FLUX ships the transformer,
    // VAE and text encoder as SEPARATE files and needs `--diffusion-model`
    // instead — passing a FLUX transformer to `-m` fails with an unhelpful
    // tensor-shape error. Hence an explicit arch switch rather than sniffing
    // the filename, which would misfire on a renamed file.
    this.arch = arch;
    this.vaePath = vaePath;
    this.clipPath = clipPath;
  }

  available() {
    return !!(this.binary && fs.existsSync(this.binary) && this.modelPath && fs.existsSync(this.modelPath));
  }

  assertAvailable() {
    if (!this.binary || !fs.existsSync(this.binary)) {
      throw new Error('Image engine missing. Install stable-diffusion.cpp from the Setup tab.');
    }
    if (!this.modelPath || !fs.existsSync(this.modelPath)) {
      // The original surfaced exactly this as a dead-end string; it now names
      // the fix and the app has a button for it.
      throw new Error('SD model not downloaded yet. Open Setup and download an image model first.');
    }
  }

  /**
   * Generate one image.
   *
   * @param {object} o
   * @param {string} o.prompt
   * @param {string} [o.negative]
   * @param {string} o.outPath
   * @param {number} [o.steps]
   * @param {number} [o.width] @param {number} [o.height]
   * @param {number} [o.seed]
   * @param {string} [o.initImage]  reference image for img2img
   * @param {number} [o.strength]   img2img denoise strength
   * @param {AbortSignal} [o.signal]
   * @param {(p:{step:number,total:number,pct:number})=>void} [o.onProgress]
   */
  async generate(o) {
    this.assertAvailable();
    fs.mkdirSync(path.dirname(o.outPath), { recursive: true });

    // FLUX takes its components separately; SD/SDXL take one checkpoint.
    const args = this.arch === 'flux'
      ? ['--diffusion-model', this.modelPath]
      : ['-m', this.modelPath];

    if (this.arch === 'flux') {
      if (this.vaePath && fs.existsSync(this.vaePath)) args.push('--vae', this.vaePath);
      if (this.clipPath && fs.existsSync(this.clipPath)) args.push('--clip_l', this.clipPath);
    }

    args.push(
      '-p', o.prompt,
      '-o', o.outPath,
      '--steps', String(o.steps ?? 20),
      '-W', String(o.width ?? 512),
      '-H', String(o.height ?? 512),
      '--seed', String(o.seed ?? -1),
    );

    // FLUX is a guidance-distilled, flow-matching model: it is trained to
    // produce its result in very few steps and IGNORES a negative prompt.
    // Passing one is not merely useless, sd.cpp rejects the combination on some
    // builds — so it is dropped for flux rather than forwarded.
    if (o.negative && this.arch !== 'flux') args.push('-n', o.negative);
    if (this.arch === 'flux') args.push('--cfg-scale', '1.0');

    // Reference-image support, from "can we use reference images for our movie
    // generation?" — img2img keeps every scene anchored to the same subject
    // instead of drifting between shots.
    if (o.initImage && fs.existsSync(o.initImage)) {
      args.push('-M', 'img2img', '-i', o.initImage, '--strength', String(o.strength ?? 0.55));
    }

    this.logger?.info(`sd: ${path.basename(this.modelPath)} ${o.width ?? 512}x${o.height ?? 512} steps=${o.steps ?? 20}${o.initImage ? ' (img2img)' : ''}`);

    return this.run(args, o.signal, (line) => {
      const m = line.match(STEP_RE);
      if (m && o.onProgress) {
        const step = +m[1], total = +m[2];
        if (total > 0 && step <= total) o.onProgress({ step, total, pct: (step / total) * 100 });
      }
    }).then(() => {
      if (!fs.existsSync(o.outPath)) {
        throw new Error('stable-diffusion.cpp exited cleanly but produced no image — see the run log.');
      }
      return o.outPath;
    });
  }

  run(args, signal, onLine) {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let tail = '';

      const onAbort = () => {
        try { proc.kill('SIGTERM'); } catch {}
        // SIGKILL if it ignores the polite request — a diffusion step can take
        // seconds and Stop must feel immediate.
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 1500);
      };
      if (signal) {
        if (signal.aborted) { onAbort(); return reject(new Error('cancelled')); }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      const handle = (buf) => {
        const text = buf.toString();
        tail = (tail + text).slice(-4000);
        for (const line of text.split(/[\r\n]+/)) {
          const t = line.trim();
          if (!t) continue;
          this.logger?.info(`sd| ${t}`);
          onLine?.(t);
        }
      };
      proc.stdout.on('data', handle);
      proc.stderr.on('data', handle);

      proc.on('error', (e) => reject(
        e.code === 'ENOENT'
          ? new Error(`Image engine not found at ${this.binary}. Reinstall it from Setup.`)
          : e,
      ));
      proc.on('exit', (code, sig) => {
        if (signal?.aborted) return reject(new Error('cancelled'));
        if (code === 0) return resolve();
        reject(new Error(`stable-diffusion.cpp failed (code ${code}${sig ? `, ${sig}` : ''}): ${tail.trim().split('\n').slice(-3).join(' | ')}`));
      });
    });
  }
}

module.exports = { SdCpp };
