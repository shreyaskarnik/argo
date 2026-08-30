import type { AccentColors } from './accent.js';

/**
 * Inline HTML template for the Playwright page used to render shader frames.
 * The page exposes two globals:
 *   window.__loadFrames(aDataUri, bDataUri) — uploads A/B textures
 *   window.__renderAt(progress) → Promise<string> — returns PNG as data URI
 */
export function buildShaderPageHtml(
  width: number,
  height: number,
  fragmentShaderGlsl: string,
  accent?: AccentColors,
): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; }
  html, body { background: transparent; }
  canvas { display: block; }
</style></head>
<body>
<canvas id="c" width="${width}" height="${height}"></canvas>
<script>
(() => {
  const canvas = document.getElementById('c');
  const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true });
  if (!gl) { window.__glError = 'webgl not available'; return; }

  const vsSrc = \`
    attribute vec2 aPos;
    varying vec2 vUv;
    void main() {
      vUv = vec2((aPos.x + 1.0) * 0.5, 1.0 - (aPos.y + 1.0) * 0.5);
      gl_Position = vec4(aPos, 0.0, 1.0);
    }
  \`;
  const fsSrc = ${JSON.stringify(fragmentShaderGlsl)};

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      window.__glError = 'shader compile: ' + gl.getShaderInfoLog(s);
      return null;
    }
    return s;
  }

  const vs = compile(gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
  if (!vs || !fs) return;

  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    window.__glError = 'program link: ' + gl.getProgramInfoLog(prog);
    return;
  }
  gl.useProgram(prog);

  // Optional uniforms — WebGL silently ignores uniform* calls with a null
  // location, so shaders that don't declare these are unaffected.
  const accentColors = ${JSON.stringify(accent ?? null)};
  if (accentColors) {
    const set3 = (name, v) => gl.uniform3f(gl.getUniformLocation(prog, name), v[0], v[1], v[2]);
    set3('accent', accentColors.accent);
    set3('accentDark', accentColors.accentDark);
    set3('accentBright', accentColors.accentBright);
  }
  gl.uniform2f(gl.getUniformLocation(prog, 'resolution'), ${width}, ${height});

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
  const aPosLoc = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(aPosLoc);
  gl.vertexAttribPointer(aPosLoc, 2, gl.FLOAT, false, 0, 0);

  const uFromLoc = gl.getUniformLocation(prog, 'from');
  const uToLoc = gl.getUniformLocation(prog, 'to');
  const uProgLoc = gl.getUniformLocation(prog, 'progress');

  function loadTex(unit, img) {
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    return tex;
  }

  window.__loadFrames = (aUri, bUri) => new Promise((resolve, reject) => {
    const imgA = new Image();
    const imgB = new Image();
    let loaded = 0;
    const done = () => { if (++loaded === 2) {
      loadTex(0, imgA);
      loadTex(1, imgB);
      gl.uniform1i(uFromLoc, 0);
      gl.uniform1i(uToLoc, 1);
      resolve();
    }};
    imgA.onload = done; imgB.onload = done;
    imgA.onerror = () => reject(new Error('failed to load A'));
    imgB.onerror = () => reject(new Error('failed to load B'));
    imgA.src = aUri;
    imgB.src = bUri;
  });

  window.__renderAt = (progress) => new Promise((resolve) => {
    gl.uniform1f(uProgLoc, progress);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    canvas.toBlob((blob) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    }, 'image/png');
  });
})();
</script>
</body>
</html>`;
}
