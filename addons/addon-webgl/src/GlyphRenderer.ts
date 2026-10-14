/**
 * Copyright (c) 2018 The xterm.js authors. All rights reserved.
 * @license MIT
 */
import { TextureAtlas } from './TextureAtlas';
import { IRenderDimensions } from 'browser/renderer/shared/Types';
import { NULL_CELL_CODE } from 'common/buffer/Constants';
import { Disposable, toDisposable } from 'common/Lifecycle';
import { Terminal } from '@xterm/xterm';
import { IRenderModel, IWebGL2RenderingContext, IWebGLVertexArrayObject, type IRasterizedGlyph, type ITextureAtlas } from './Types';
import { createProgram, PROJECTION_MATRIX } from './WebglUtils';
import type { ILogService, IOptionsService } from 'common/services/Services';
import { allowRescaling, throwIfFalsy } from 'browser/renderer/shared/RendererUtils';

interface IVertices {
  attributes: Float32Array;
  /**
   * These buffers are the ones used to bind to WebGL, the reason there are
   * multiple is to allow double buffering to work as you cannot modify the
   * buffer while it's being used by the GPU. Having multiple lets us start
   * working on the next frame.
   */
  attributesBuffers: Float32Array[];
  count: number;
}

const enum VertexAttribLocations {
  UNIT_QUAD = 0,
  CELL_POSITION = 1,
  OFFSET = 2,
  SIZE = 3,
  TEXPAGE = 4,
  TEXCOORD = 5,
  TEXSIZE = 6,
  FGCOLOR = 7,
  DECOCOLOR = 8
}

const vertexShaderSource = `#version 300 es
layout (location = ${VertexAttribLocations.UNIT_QUAD}) in vec2 a_unitquad;
layout (location = ${VertexAttribLocations.CELL_POSITION}) in vec2 a_cellpos;
layout (location = ${VertexAttribLocations.OFFSET}) in vec2 a_offset;
layout (location = ${VertexAttribLocations.SIZE}) in vec2 a_size;
layout (location = ${VertexAttribLocations.TEXPAGE}) in float a_texpage;
layout (location = ${VertexAttribLocations.TEXCOORD}) in vec2 a_texcoord;
layout (location = ${VertexAttribLocations.TEXSIZE}) in vec2 a_texsize;
layout (location = ${VertexAttribLocations.FGCOLOR}) in vec4 a_fgcolor;
layout (location = ${VertexAttribLocations.DECOCOLOR}) in vec4 a_decocolor;

uniform mat4 u_projection;
uniform vec2 u_resolution;

out vec2 v_texcoord;
flat out int v_texpage;
flat out vec4 v_fgcolor;
flat out vec4 v_decocolor;

void main() {
  vec2 zeroToOne = (a_offset / u_resolution) + a_cellpos + (a_unitquad * a_size);
  gl_Position = u_projection * vec4(zeroToOne, 0.0, 1.0);
  v_texpage = int(a_texpage);
  v_texcoord = a_texcoord + a_unitquad * a_texsize;
  v_fgcolor = a_fgcolor;
  v_decocolor = a_decocolor;
}`;

// Atlas layers store glyph coverage in the R channel and decoration coverage in the G
// channel. The shader tints them separately with v_fgcolor and v_decocolor; decoration is
// suppressed where the glyph is opaque so underlines don't run through descenders.
// A negative v_fgcolor.a is the sentinel for "this glyph is colored (e.g. emoji), sample
// the texture directly without tinting".
const fragmentShaderSource = `#version 300 es
precision mediump float;
precision lowp sampler2DArray;

in vec2 v_texcoord;
flat in int v_texpage;
flat in vec4 v_fgcolor;
flat in vec4 v_decocolor;

uniform sampler2DArray u_atlas;

out vec4 outColor;

// Stem darkening: lifts mid-coverage pixels so antialiased stems read as thick as macOS's
// CoreText. Without it, alpha-only AA looks anemic at small sizes — this is the same trick
// FreeType's stem-darkening / Apple's CoreText apply at the rasterizer level. The 0.85
// exponent maps coverage 0.5 -> 0.56, leaving 0 and 1 untouched.
const float STEM_DARKEN = 0.85;

void main() {
  vec4 sampled = texture(u_atlas, vec3(v_texcoord, float(v_texpage)));
  if (v_fgcolor.a < 0.0) {
    outColor = sampled.a > 0.0 ? vec4(sampled.rgb / sampled.a, sampled.a) : vec4(0.0);
    return;
  }
  float glyphA = pow(sampled.r, STEM_DARKEN) * v_fgcolor.a;
  float decoA = pow(sampled.g, STEM_DARKEN) * v_decocolor.a;
  // Composite decoration over glyph; output premultiplied alpha so the GPU blend correctly
  // composites against whatever the rect renderer drew.
  vec3 premul = v_decocolor.rgb * decoA + v_fgcolor.rgb * glyphA * (1.0 - decoA);
  float a = decoA + glyphA * (1.0 - decoA);
  outColor = a > 0.0 ? vec4(premul / a, a) : vec4(0.0);
}`;

const enum Constants {
  INDICES_PER_CELL = 19,
  BYTES_PER_CELL = INDICES_PER_CELL * 4/* Float32Array.BYTES_PER_ELEMENT */,
  CELL_POSITION_INDICES = 2
}

// Work variables to avoid garbage collection
let $i = 0;
let $glyph: IRasterizedGlyph | undefined = undefined;
let $leftCellPadding = 0;
let $clippedPixels = 0;

export class GlyphRenderer extends Disposable {
  private readonly _program: WebGLProgram;
  private readonly _vertexArrayObject: IWebGLVertexArrayObject;
  private readonly _projectionLocation: WebGLUniformLocation;
  private readonly _resolutionLocation: WebGLUniformLocation;
  private readonly _attributesBuffer: WebGLBuffer;
  private _atlasTexture: WebGLTexture;
  private _atlasLayerVersions: Int32Array;
  private readonly _atlasLayerSize: number;

  private _atlas: ITextureAtlas | undefined;
  private _lastSeenPageLayoutVersion: number = -1;
  private _pageOverflowWarned: boolean = false;
  private _activeBuffer: number = 0;
  private readonly _vertices: IVertices = {
    count: 0,
    attributes: new Float32Array(0),
    attributesBuffers: [
      new Float32Array(0),
      new Float32Array(0)
    ]
  };

  constructor(
    private readonly _terminal: Terminal,
    private readonly _gl: IWebGL2RenderingContext,
    private _dimensions: IRenderDimensions,
    private readonly _optionsService: IOptionsService,
    private readonly _logService: ILogService
  ) {
    super();

    const gl = this._gl;

    if (TextureAtlas.maxAtlasPages === undefined) {
      // Typically 8 or 16
      TextureAtlas.maxAtlasPages = Math.min(32, throwIfFalsy(gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) as number | null));
      // Almost all clients will support >= 4096
      TextureAtlas.maxTextureSize = throwIfFalsy(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number | null);
    }

    this._program = throwIfFalsy(createProgram(gl, vertexShaderSource, fragmentShaderSource, this._logService));
    this._register(toDisposable(() => gl.deleteProgram(this._program)));

    // Uniform locations
    this._projectionLocation = throwIfFalsy(gl.getUniformLocation(this._program, 'u_projection'));
    this._resolutionLocation = throwIfFalsy(gl.getUniformLocation(this._program, 'u_resolution'));
    const atlasLocation = throwIfFalsy(gl.getUniformLocation(this._program, 'u_atlas'));

    // Create and set the vertex array object
    const vertexArrayObject = this._vertexArrayObject = gl.createVertexArray();
    this._register(toDisposable(() => gl.deleteVertexArray(vertexArrayObject)));
    gl.bindVertexArray(vertexArrayObject);

    // Setup a_unitquad, this defines the 4 vertices of a rectangle
    const unitQuadVertices = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
    const unitQuadVerticesBuffer = gl.createBuffer();
    this._register(toDisposable(() => gl.deleteBuffer(unitQuadVerticesBuffer)));
    gl.bindBuffer(gl.ARRAY_BUFFER, unitQuadVerticesBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, unitQuadVertices, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(VertexAttribLocations.UNIT_QUAD);
    gl.vertexAttribPointer(VertexAttribLocations.UNIT_QUAD, 2, this._gl.FLOAT, false, 0, 0);

    // Setup the unit quad element array buffer, this points to indices in
    // unitQuadVertices to allow is to draw 2 triangles from the vertices via a
    // triangle strip
    const unitQuadElementIndices = new Uint8Array([0, 1, 2, 3]);
    const elementIndicesBuffer = gl.createBuffer();
    this._register(toDisposable(() => gl.deleteBuffer(elementIndicesBuffer)));
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, elementIndicesBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, unitQuadElementIndices, gl.STATIC_DRAW);

    // Setup attributes
    this._attributesBuffer = throwIfFalsy(gl.createBuffer());
    this._register(toDisposable(() => gl.deleteBuffer(this._attributesBuffer)));
    gl.bindBuffer(gl.ARRAY_BUFFER, this._attributesBuffer);
    gl.enableVertexAttribArray(VertexAttribLocations.OFFSET);
    gl.vertexAttribPointer(VertexAttribLocations.OFFSET, 2, gl.FLOAT, false, Constants.BYTES_PER_CELL, 0);
    gl.vertexAttribDivisor(VertexAttribLocations.OFFSET, 1);
    gl.enableVertexAttribArray(VertexAttribLocations.SIZE);
    gl.vertexAttribPointer(VertexAttribLocations.SIZE, 2, gl.FLOAT, false, Constants.BYTES_PER_CELL, 2 * Float32Array.BYTES_PER_ELEMENT);
    gl.vertexAttribDivisor(VertexAttribLocations.SIZE, 1);
    gl.enableVertexAttribArray(VertexAttribLocations.TEXPAGE);
    gl.vertexAttribPointer(VertexAttribLocations.TEXPAGE, 1, gl.FLOAT, false, Constants.BYTES_PER_CELL, 4 * Float32Array.BYTES_PER_ELEMENT);
    gl.vertexAttribDivisor(VertexAttribLocations.TEXPAGE, 1);
    gl.enableVertexAttribArray(VertexAttribLocations.TEXCOORD);
    gl.vertexAttribPointer(VertexAttribLocations.TEXCOORD, 2, gl.FLOAT, false, Constants.BYTES_PER_CELL, 5 * Float32Array.BYTES_PER_ELEMENT);
    gl.vertexAttribDivisor(VertexAttribLocations.TEXCOORD, 1);
    gl.enableVertexAttribArray(VertexAttribLocations.TEXSIZE);
    gl.vertexAttribPointer(VertexAttribLocations.TEXSIZE, 2, gl.FLOAT, false, Constants.BYTES_PER_CELL, 7 * Float32Array.BYTES_PER_ELEMENT);
    gl.vertexAttribDivisor(VertexAttribLocations.TEXSIZE, 1);
    gl.enableVertexAttribArray(VertexAttribLocations.FGCOLOR);
    gl.vertexAttribPointer(VertexAttribLocations.FGCOLOR, 4, gl.FLOAT, false, Constants.BYTES_PER_CELL, 9 * Float32Array.BYTES_PER_ELEMENT);
    gl.vertexAttribDivisor(VertexAttribLocations.FGCOLOR, 1);
    gl.enableVertexAttribArray(VertexAttribLocations.DECOCOLOR);
    gl.vertexAttribPointer(VertexAttribLocations.DECOCOLOR, 4, gl.FLOAT, false, Constants.BYTES_PER_CELL, 13 * Float32Array.BYTES_PER_ELEMENT);
    gl.vertexAttribDivisor(VertexAttribLocations.DECOCOLOR, 1);
    gl.enableVertexAttribArray(VertexAttribLocations.CELL_POSITION);
    gl.vertexAttribPointer(VertexAttribLocations.CELL_POSITION, 2, gl.FLOAT, false, Constants.BYTES_PER_CELL, 17 * Float32Array.BYTES_PER_ELEMENT);
    gl.vertexAttribDivisor(VertexAttribLocations.CELL_POSITION, 1);

    gl.useProgram(this._program);
    gl.uniform1i(atlasLocation, 0);
    gl.uniformMatrix4fv(this._projectionLocation, false, PROJECTION_MATRIX);

    // Allocate one TEXTURE_2D_ARRAY for the whole atlas: each page is a layer. Layers are
    // populated lazily in render() when their TextureAtlas page version changes. The array starts
    // with a single layer and grows with the atlas, since texStorage3D allocates every layer up
    // front and most terminals only ever use one page.
    this._atlasLayerSize = TextureAtlas.atlasPageSize;
    this._atlasTexture = this._createAtlasTexture(1);
    this._atlasLayerVersions = new Int32Array(1).fill(-1);
    // Read the field at dispose time as growing replaces the texture
    this._register(toDisposable(() => gl.deleteTexture(this._atlasTexture)));

    // Allow drawing of transparent texture
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // Set viewport
    this.handleResize();
  }

  /**
   * Call when a frame is being drawn. Returns whether the full model must be rebuilt before
   * rendering this frame because the atlas page layout changed since this renderer last drew.
   */
  public beginFrame(): boolean {
    if (!this._atlas) {
      return true;
    }
    if (this._atlas.pageLayoutVersion !== this._lastSeenPageLayoutVersion) {
      this._lastSeenPageLayoutVersion = this._atlas.pageLayoutVersion;
      return true;
    }
    return false;
  }

  public updateCell(x: number, y: number, code: number, styleFlags: number, chars: string, width: number, fgR: number, fgG: number, fgB: number, fgA: number, dR: number, dG: number, dB: number, dA: number, leftClipBg: boolean): void {
    this._updateCell(this._vertices.attributes, x, y, code, styleFlags, chars, width, fgR, fgG, fgB, fgA, dR, dG, dB, dA, leftClipBg);
  }

  private _updateCell(array: Float32Array, x: number, y: number, code: number | undefined, styleFlags: number, chars: string, width: number, fgR: number, fgG: number, fgB: number, fgA: number, dR: number, dG: number, dB: number, dA: number, leftClipBg: boolean): void {
    $i = (y * this._terminal.cols + x) * Constants.INDICES_PER_CELL;

    if (code === NULL_CELL_CODE || code === undefined) {
      array.fill(0, $i, $i + Constants.INDICES_PER_CELL - 1 - Constants.CELL_POSITION_INDICES);
      return;
    }

    if (!this._atlas) {
      return;
    }

    if (chars && chars.length > 1) {
      $glyph = this._atlas.getRasterizedGlyphCombinedChar(chars, styleFlags, false, this._terminal.element);
    } else {
      $glyph = this._atlas.getRasterizedGlyph(code, styleFlags, false, this._terminal.element);
    }

    $leftCellPadding = Math.floor((this._dimensions.device.cell.width - this._dimensions.device.char.width) / 2);
    if (leftClipBg && $glyph.offset.x > $leftCellPadding) {
      $clippedPixels = $glyph.offset.x - $leftCellPadding;
      array[$i    ] = -($glyph.offset.x - $clippedPixels) + this._dimensions.device.char.left;
      array[$i + 1] = -$glyph.offset.y + this._dimensions.device.char.top;
      array[$i + 2] = ($glyph.size.x - $clippedPixels) / this._dimensions.device.canvas.width;
      array[$i + 3] = $glyph.size.y / this._dimensions.device.canvas.height;
      array[$i + 4] = $glyph.texturePage;
      array[$i + 5] = $glyph.texturePositionClipSpace.x + $clippedPixels / this._atlas.pages[$glyph.texturePage].canvas.width;
      array[$i + 6] = $glyph.texturePositionClipSpace.y;
      array[$i + 7] = $glyph.sizeClipSpace.x - $clippedPixels / this._atlas.pages[$glyph.texturePage].canvas.width;
      array[$i + 8] = $glyph.sizeClipSpace.y;
    } else {
      array[$i    ] = -$glyph.offset.x + this._dimensions.device.char.left;
      array[$i + 1] = -$glyph.offset.y + this._dimensions.device.char.top;
      array[$i + 2] = $glyph.size.x / this._dimensions.device.canvas.width;
      array[$i + 3] = $glyph.size.y / this._dimensions.device.canvas.height;
      array[$i + 4] = $glyph.texturePage;
      array[$i + 5] = $glyph.texturePositionClipSpace.x;
      array[$i + 6] = $glyph.texturePositionClipSpace.y;
      array[$i + 7] = $glyph.sizeClipSpace.x;
      array[$i + 8] = $glyph.sizeClipSpace.y;
    }

    if (this._optionsService.rawOptions.rescaleOverlappingGlyphs) {
      if (allowRescaling(code, width, $glyph.size.x, this._dimensions.device.cell.width)) {
        array[$i + 2] = (this._dimensions.device.cell.width - 1) / this._dimensions.device.canvas.width;
      }
    }

    // a_fgcolor: rgb tint + alpha. Alpha < 0 tells the shader the glyph is colored (e.g. emoji)
    // and to sample the texture directly instead of tinting.
    array[$i + 9] = fgR;
    array[$i + 10] = fgG;
    array[$i + 11] = fgB;
    array[$i + 12] = $glyph.isColored ? -1 : fgA;
    // a_decocolor: tint for the decoration channel (underline / strikethrough / overline).
    array[$i + 13] = dR;
    array[$i + 14] = dG;
    array[$i + 15] = dB;
    array[$i + 16] = dA;
  }

  public clear(): void {
    const terminal = this._terminal;
    const newCount = terminal.cols * terminal.rows * Constants.INDICES_PER_CELL;

    // Clear vertices
    if (this._vertices.count !== newCount) {
      this._vertices.attributes = new Float32Array(newCount);
    } else {
      this._vertices.attributes.fill(0);
    }
    let i = 0;
    for (; i < this._vertices.attributesBuffers.length; i++) {
      if (this._vertices.count !== newCount) {
        this._vertices.attributesBuffers[i] = new Float32Array(newCount);
      } else {
        this._vertices.attributesBuffers[i].fill(0);
      }
    }
    this._vertices.count = newCount;
    i = 0;
    for (let y = 0; y < terminal.rows; y++) {
      for (let x = 0; x < terminal.cols; x++) {
        this._vertices.attributes[i + 17] = x / terminal.cols;
        this._vertices.attributes[i + 18] = y / terminal.rows;
        i += Constants.INDICES_PER_CELL;
      }
    }
  }

  public handleResize(): void {
    const gl = this._gl;
    gl.useProgram(this._program);
    gl.viewport(0, 0, this._dimensions.device.canvas.width, this._dimensions.device.canvas.height);
    gl.uniform2f(this._resolutionLocation, this._dimensions.device.canvas.width, this._dimensions.device.canvas.height);
    this.clear();
  }

  public render(renderModel: IRenderModel): void {
    if (!this._atlas) {
      return;
    }

    const gl = this._gl;

    gl.useProgram(this._program);
    gl.bindVertexArray(this._vertexArrayObject);

    // Alternate buffers each frame as the active buffer gets locked while it's in use by the GPU
    this._activeBuffer = (this._activeBuffer + 1) % 2;
    const activeBuffer = this._vertices.attributesBuffers[this._activeBuffer];

    // Copy data for each cell of each line up to its line length (the last non-whitespace cell)
    // from the attributes buffer into activeBuffer, which is the one that gets bound to the GPU.
    // The reasons for this are as follows:
    // - So the active buffer can be alternated so we don't get blocked on rendering finishing
    // - To copy either the normal attributes buffer or the selection attributes buffer when there
    //   is a selection
    // - So we don't send vertices for all the line-ending whitespace to the GPU
    let bufferLength = 0;
    for (let y = 0; y < renderModel.lineLengths.length; y++) {
      const si = y * this._terminal.cols * Constants.INDICES_PER_CELL;
      const sub = this._vertices.attributes.subarray(si, si + renderModel.lineLengths[y] * Constants.INDICES_PER_CELL);
      activeBuffer.set(sub, bufferLength);
      bufferLength += sub.length;
    }

    // Bind the attributes buffer
    gl.bindBuffer(gl.ARRAY_BUFFER, this._attributesBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, activeBuffer.subarray(0, bufferLength), gl.STREAM_DRAW);

    if (this._atlas.pages.length > this._atlasLayerVersions.length) {
      this._growAtlasTexture(this._atlas.pages.length);
    }

    // Upload any atlas page whose canvas content has changed into its texture-array layer.
    // Premultiply on upload so canvas's straight alpha bakes coverage into R/G — without this,
    // AA edges (R=255, A<255) read back as fully opaque and glyph edges look blocky.
    // Clamp defensively in case the atlas unexpectedly exceeds the texture array's layer count.
    const pageCount = Math.min(this._atlas.pages.length, this._atlasLayerVersions.length);
    if (this._atlas.pages.length > this._atlasLayerVersions.length && !this._pageOverflowWarned) {
      this._pageOverflowWarned = true;
      this._logService.warn(`Atlas page count (${this._atlas.pages.length}) exceeds the renderer's texture capacity (${this._atlasLayerVersions.length}), some glyphs will not render correctly`);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this._atlasTexture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    for (let i = 0; i < pageCount; i++) {
      const page = this._atlas.pages[i];
      if (page.version !== this._atlasLayerVersions[i]) {
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, page.canvas.width, page.canvas.height, 1, gl.RGBA, gl.UNSIGNED_BYTE, page.canvas);
        this._atlasLayerVersions[i] = page.version;
      }
    }
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

    gl.drawElementsInstanced(gl.TRIANGLE_STRIP, 4, gl.UNSIGNED_BYTE, 0, bufferLength / Constants.INDICES_PER_CELL);
  }

  public setAtlas(atlas: ITextureAtlas): void {
    this._atlas = atlas;
    this._lastSeenPageLayoutVersion = -1;
    this.invalidateAtlasTextures();
  }

  public invalidateAtlasTextures(): void {
    this._atlasLayerVersions.fill(-1);
  }

  private _createAtlasTexture(layerCount: number): WebGLTexture {
    const gl = this._gl;
    const texture = throwIfFalsy(gl.createTexture());
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, this._atlasLayerSize, this._atlasLayerSize, layerCount);
    return texture;
  }

  /**
   * Replaces the atlas texture with one that has at least `pageCount` layers, capped at
   * maxAtlasPages. Texture storage is immutable so it can't be resized in place, the pages are
   * re-uploaded from their canvases by render().
   */
  private _growAtlasTexture(pageCount: number): void {
    const layerCount = Math.min(TextureAtlas.maxAtlasPages ?? pageCount, Math.max(pageCount, this._atlasLayerVersions.length * 2));
    if (layerCount <= this._atlasLayerVersions.length) {
      return;
    }
    this._gl.deleteTexture(this._atlasTexture);
    this._atlasTexture = this._createAtlasTexture(layerCount);
    this._atlasLayerVersions = new Int32Array(layerCount).fill(-1);
  }

  public setDimensions(dimensions: IRenderDimensions): void {
    this._dimensions = dimensions;
  }
}
