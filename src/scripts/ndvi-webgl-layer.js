/**
 * WebGL NDVI Renderer
 *
 * Uses an offscreen WebGL context to compute NDVI from Red/NIR bands
 * and map it to a colormap — all on the GPU.
 * The result is read back as a canvas that MapLibre can consume
 * as a standard image source (no WebGL state conflicts).
 */

const VERT_SRC = `
  attribute vec2 a_pos;
  varying vec2 v_uv;
  void main() {
    v_uv = a_pos * 0.5 + 0.5;
    gl_Position = vec4(a_pos, 0.0, 1.0);
  }
`;

const FRAG_SRC = `
  precision highp float;
  uniform sampler2D u_red;
  uniform sampler2D u_nir;
  uniform sampler2D u_colormap;
  varying vec2 v_uv;

  void main() {
    // Values stored as normalized floats [0, 1] representing [0, 65535]
    float redRaw = texture2D(u_red, v_uv).r * 65535.0;
    float nirRaw = texture2D(u_nir, v_uv).r * 65535.0;

    // Skip nodata pixels (Sentinel-2 nodata = 0)
    if (redRaw < 1.0 && nirRaw < 1.0) {
      gl_FragColor = vec4(0.0);
      return;
    }

    // Sentinel-2 L2A PB 04.00+ radiometric offset: DN 1000 = 0 reflectance
    float red = max(0.0, redRaw - 1000.0);
    float nir = max(0.0, nirRaw - 1000.0);

    float denom = nir + red;
    float ndvi = 0.0;
    if (denom > 0.0) {
      ndvi = (nir - red) / denom;
    }

    // Map NDVI [-1, 1] → texture coord [0, 1]
    float lookup = clamp((ndvi + 1.0) * 0.5, 0.0, 1.0);
    gl_FragColor = texture2D(u_colormap, vec2(lookup, 0.5));
  }
`;

/**
 * Render NDVI on the GPU and return a canvas with the result.
 *
 * @param {Uint16Array} redBand  - Red band DN values
 * @param {Uint16Array} nirBand  - NIR band DN values
 * @param {number} width         - Raster width in pixels
 * @param {number} height        - Raster height in pixels
 * @param {HTMLCanvasElement} colormapCanvas - 256×1 colormap canvas
 * @returns {HTMLCanvasElement}  - Canvas with NDVI colored pixels
 */
export function renderNDVIWebGL(redBand, nirBand, width, height, colormapCanvas) {
  // ── Create offscreen WebGL canvas ──
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const gl = canvas.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true });
  if (!gl) {
    throw new Error('WebGL is not supported by your browser.');
  }

  // Require OES_texture_float for scientific data
  const floatExt = gl.getExtension('OES_texture_float');
  if (!floatExt) {
    throw new Error('OES_texture_float extension not available. WebGL cannot process satellite data.');
  }
  // Optional: enable linear filtering on float textures
  gl.getExtension('OES_texture_float_linear');

  // ── Compile shaders ──
  const program = createProgram(gl, VERT_SRC, FRAG_SRC);
  gl.useProgram(program);

  // ── Full-screen quad ──
  const quadBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1,  1, -1,  -1, 1,
    -1,  1,  1, -1,   1, 1
  ]), gl.STATIC_DRAW);

  const posLoc = gl.getAttribLocation(program, 'a_pos');
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

  // ── Upload band textures ──
  const redTex = uploadBandTexture(gl, redBand, width, height);
  const nirTex = uploadBandTexture(gl, nirBand, width, height);
  const cmapTex = uploadColormapTexture(gl, colormapCanvas);

  // ── Bind textures to uniform samplers ──
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, redTex);
  gl.uniform1i(gl.getUniformLocation(program, 'u_red'), 0);

  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, nirTex);
  gl.uniform1i(gl.getUniformLocation(program, 'u_nir'), 1);

  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, cmapTex);
  gl.uniform1i(gl.getUniformLocation(program, 'u_colormap'), 2);

  // ── Draw ──
  gl.viewport(0, 0, width, height);
  gl.drawArrays(gl.TRIANGLES, 0, 6);

  // ── Cleanup GPU resources (the canvas retains the pixels) ──
  gl.deleteTexture(redTex);
  gl.deleteTexture(nirTex);
  gl.deleteTexture(cmapTex);
  gl.deleteBuffer(quadBuf);
  gl.deleteProgram(program);

  return canvas;
}

// ── Helpers ────────────────────────────────────────────────────────

function createProgram(gl, vSrc, fSrc) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fSrc);

  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);

  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error('Shader link error: ' + log);
  }
  return prog;
}

function compileShader(gl, type, src) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, src);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error('Shader compile error: ' + log);
  }
  return shader;
}

function uploadBandTexture(gl, uint16Data, w, h) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);

  // Normalize Uint16 → Float32 [0, 1]
  const floats = new Float32Array(uint16Data.length);
  for (let i = 0; i < uint16Data.length; i++) {
    floats[i] = uint16Data[i] / 65535.0;
  }

  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, w, h, 0, gl.LUMINANCE, gl.FLOAT, floats);

  // NEAREST is always safe; LINEAR requires OES_texture_float_linear
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  return tex;
}

function uploadColormapTexture(gl, canvas) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}
