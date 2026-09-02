const { createCanvas } = require('@napi-rs/canvas');
const { ElementShim } = require('./dom');

const WEBGL_CONSTANTS = {
  VERSION: 0x1f02,
  SHADING_LANGUAGE_VERSION: 0x8b8c,
  VENDOR: 0x1f00,
  RENDERER: 0x1f01,
  MAX_TEXTURE_SIZE: 0x0d33,
  MAX_CUBE_MAP_TEXTURE_SIZE: 0x851c,
  MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8b4d,
  MAX_TEXTURE_IMAGE_UNITS: 0x8872,
  MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0x8b4c,
  MAX_FRAGMENT_UNIFORM_VECTORS: 0x8dfd,
  MAX_VERTEX_UNIFORM_VECTORS: 0x8dfb,
  MAX_VARYING_VECTORS: 0x8dfc,
  MAX_VERTEX_ATTRIBS: 0x8869,
  MAX_RENDERBUFFER_SIZE: 0x84e8,
  MAX_VIEWPORT_DIMS: 0x0d3a,
  ALIASED_LINE_WIDTH_RANGE: 0x846e,
  ALIASED_POINT_SIZE_RANGE: 0x846d,
  RED_BITS: 0x0d52,
  GREEN_BITS: 0x0d53,
  BLUE_BITS: 0x0d54,
  ALPHA_BITS: 0x0d55,
  DEPTH_BITS: 0x0d56,
  STENCIL_BITS: 0x0d57,
  UNMASKED_VENDOR_WEBGL: 0x9245,
  UNMASKED_RENDERER_WEBGL: 0x9246,
  ARRAY_BUFFER: 0x8892,
  STATIC_DRAW: 0x88e4,
  FLOAT: 0x1406,
  VERTEX_SHADER: 0x8b31,
  FRAGMENT_SHADER: 0x8b30,
  HIGH_FLOAT: 0x8df2,
  MEDIUM_FLOAT: 0x8df1,
  LOW_FLOAT: 0x8df0,
  HIGH_INT: 0x8df5,
  MEDIUM_INT: 0x8df4,
  LOW_INT: 0x8df3,
  DEPTH_TEST: 0x0b71,
  LEQUAL: 0x0203
};

function createWebGLContext(profile) {
  const gl = { ...WEBGL_CONSTANTS };
  const unmaskedVendor = 'Google Inc. (NVIDIA)';
  const unmaskedRenderer =
    'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)';
  const parameters = new Map([
    [gl.VERSION, 'WebGL 1.0 (OpenGL ES 2.0 Chromium)'],
    [gl.SHADING_LANGUAGE_VERSION, 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)'],
    [gl.VENDOR, 'WebKit'],
    [gl.RENDERER, 'WebKit WebGL'],
    [gl.MAX_TEXTURE_SIZE, 16384],
    [gl.MAX_CUBE_MAP_TEXTURE_SIZE, 16384],
    [gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS, 32],
    [gl.MAX_TEXTURE_IMAGE_UNITS, 16],
    [gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS, 16],
    [gl.MAX_FRAGMENT_UNIFORM_VECTORS, 1024],
    [gl.MAX_VERTEX_UNIFORM_VECTORS, 4096],
    [gl.MAX_VARYING_VECTORS, 31],
    [gl.MAX_VERTEX_ATTRIBS, 16],
    [gl.MAX_RENDERBUFFER_SIZE, 16384],
    [gl.MAX_VIEWPORT_DIMS, new Int32Array([
      profile.screen.width * 16,
      profile.screen.height * 16
    ])],
    [gl.ALIASED_LINE_WIDTH_RANGE, new Float32Array([1, 1])],
    [gl.ALIASED_POINT_SIZE_RANGE, new Float32Array([1, 1024])],
    [gl.RED_BITS, 8],
    [gl.GREEN_BITS, 8],
    [gl.BLUE_BITS, 8],
    [gl.ALPHA_BITS, 8],
    [gl.DEPTH_BITS, profile.screen.colorDepth],
    [gl.STENCIL_BITS, 8],
    [gl.UNMASKED_VENDOR_WEBGL, unmaskedVendor],
    [gl.UNMASKED_RENDERER_WEBGL, unmaskedRenderer],
    [0x84ff, 16]
  ]);
  const extensions = [
    'ANGLE_instanced_arrays',
    'EXT_blend_minmax',
    'EXT_frag_depth',
    'EXT_shader_texture_lod',
    'EXT_texture_filter_anisotropic',
    'OES_element_index_uint',
    'OES_standard_derivatives',
    'OES_texture_float',
    'OES_texture_float_linear',
    'WEBGL_debug_renderer_info',
    'WEBGL_depth_texture'
  ];
  const debugRendererInfo = {
    UNMASKED_VENDOR_WEBGL: gl.UNMASKED_VENDOR_WEBGL,
    UNMASKED_RENDERER_WEBGL: gl.UNMASKED_RENDERER_WEBGL
  };
  const anisotropyInfo = { MAX_TEXTURE_MAX_ANISOTROPY_EXT: 0x84ff };

  gl.getParameter = parameter => parameters.get(parameter) ?? null;
  gl.getSupportedExtensions = () => [...extensions];
  gl.getExtension = name => {
    if (name === 'WEBGL_debug_renderer_info') return debugRendererInfo;
    if ([
      'EXT_texture_filter_anisotropic',
      'MOZ_EXT_texture_filter_anisotropic',
      'WEBKIT_EXT_texture_filter_anisotropic'
    ].includes(name)) {
      return anisotropyInfo;
    }
    return extensions.includes(name) ? {} : null;
  };
  gl.getContextAttributes = () => ({
    alpha: true,
    antialias: true,
    depth: true,
    failIfMajorPerformanceCaveat: false,
    powerPreference: 'default',
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
    stencil: false
  });
  gl.getShaderPrecisionFormat = () => ({
    rangeMin: 127,
    rangeMax: 127,
    precision: 23
  });

  for (const method of [
    'createBuffer',
    'createFramebuffer',
    'createProgram',
    'createRenderbuffer',
    'createShader',
    'createTexture'
  ]) {
    gl[method] = () => ({});
  }
  gl.getAttribLocation = () => 0;
  gl.getUniformLocation = () => ({});
  gl.getProgramParameter = () => true;
  gl.getShaderParameter = () => true;
  gl.getProgramInfoLog = () => '';
  gl.getShaderInfoLog = () => '';
  for (const method of [
    'activeTexture',
    'attachShader',
    'bindBuffer',
    'bindFramebuffer',
    'bindRenderbuffer',
    'bindTexture',
    'blendFunc',
    'bufferData',
    'clear',
    'clearColor',
    'compileShader',
    'deleteBuffer',
    'deleteFramebuffer',
    'deleteProgram',
    'deleteRenderbuffer',
    'deleteShader',
    'deleteTexture',
    'disable',
    'drawArrays',
    'drawElements',
    'enable',
    'enableVertexAttribArray',
    'framebufferRenderbuffer',
    'framebufferTexture2D',
    'linkProgram',
    'renderbufferStorage',
    'shaderSource',
    'texImage2D',
    'texParameteri',
    'uniform1f',
    'uniform1i',
    'uniform2f',
    'uniform3f',
    'uniform4f',
    'useProgram',
    'vertexAttribPointer',
    'viewport'
  ]) {
    gl[method] = () => {};
  }
  return gl;
}

class CanvasElementShim extends ElementShim {
  constructor(profile) {
    super('canvas');
    this.backingCanvas = createCanvas(300, 150);
    this.webglContext = createWebGLContext(profile);
  }

  get width() {
    return this.backingCanvas.width;
  }

  set width(value) {
    this.backingCanvas.width = Number(value);
  }

  get height() {
    return this.backingCanvas.height;
  }

  set height(value) {
    this.backingCanvas.height = Number(value);
  }

  getContext(type, ...args) {
    if (type === '2d') {
      return this.backingCanvas.getContext('2d', ...args);
    }
    if (type === 'webgl' || type === 'experimental-webgl') {
      return this.webglContext;
    }
    return null;
  }

  toDataURL(...args) {
    return this.backingCanvas.toDataURL(...args);
  }
}

function createCanvasFactory(profile) {
  return tagName => {
    if (String(tagName).toLowerCase() === 'canvas') {
      return new CanvasElementShim(profile);
    }
    return new ElementShim(tagName);
  };
}

function createAudioNode(properties = {}) {
  return {
    ...properties,
    connect() {
      return this;
    },
    disconnect() {}
  };
}

class AudioContextShim {
  constructor() {
    this.destination = createAudioNode();
    this.sampleRate = 44100;
    this.currentTime = 0;
    this.state = 'running';
  }

  createOscillator() {
    return createAudioNode({
      type: 'sine',
      frequency: { value: 440 },
      detune: { value: 0 },
      start() {},
      stop() {}
    });
  }

  createDynamicsCompressor() {
    return createAudioNode({
      threshold: { value: -24 },
      knee: { value: 30 },
      ratio: { value: 12 },
      reduction: 0,
      attack: { value: 0.003 },
      release: { value: 0.25 }
    });
  }

  createAnalyser() {
    return createAudioNode({
      fftSize: 2048,
      frequencyBinCount: 1024,
      getFloatFrequencyData(values) {
        values.fill(-100);
      },
      getByteFrequencyData(values) {
        values.fill(0);
      }
    });
  }

  createGain() {
    return createAudioNode({ gain: { value: 1 } });
  }

  close() {
    this.state = 'closed';
    return Promise.resolve();
  }
}

class OfflineAudioContextShim extends AudioContextShim {
  constructor(numberOfChannels = 1, length = 44100, sampleRate = 44100) {
    super();
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.oncomplete = null;
  }

  startRendering() {
    const channelData = new Float32Array(44100);
    for (let index = 0; index < channelData.length; index += 1) {
      channelData[index] = Math.sin(index / 100) * 0.001;
    }
    const renderedBuffer = {
      length: channelData.length,
      sampleRate: 44100,
      numberOfChannels: this.numberOfChannels,
      getChannelData() {
        return channelData;
      }
    };
    queueMicrotask(() => {
      if (typeof this.oncomplete === 'function') {
        this.oncomplete({ renderedBuffer });
      }
    });
    return Promise.resolve(renderedBuffer);
  }
}

module.exports = {
  createCanvasFactory,
  AudioContextShim,
  OfflineAudioContextShim
};
