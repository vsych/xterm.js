/**
 * Copyright (c) 2017 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { IColorContrastCache } from 'browser/Types';
import { DIM_OPACITY, TEXT_BASELINE } from './Constants';
import { tryDrawCustomGlyph } from './customGlyphs/CustomGlyphRasterizer';
import { computeNextVariantOffset, treatGlyphAsBackgroundColor, isRestrictedPowerlineGlyph, throwIfFalsy } from 'browser/renderer/shared/RendererUtils';
import { IBoundingBox, ICharAtlasConfig, IRasterizedGlyph, ITextureAtlas } from './Types';
import { NULL_COLOR, channels, color, rgba } from 'common/Color';
import { TwoKeyMap } from 'common/MultiKeyMap';
import { IdleTaskQueue } from 'common/TaskQueue';
import { IColor } from 'common/Types';
import { AttributeData } from 'common/buffer/AttributeData';
import { Attributes, UnderlineStyle } from 'common/buffer/Constants';
import { ILogService, IUnicodeService } from 'common/services/Services';
import { Emitter } from 'common/Event';

/**
 * A shared object which is used to draw nothing for a particular cell.
 */
const NULL_RASTERIZED_GLYPH: IRasterizedGlyph = {
  texturePage: 0,
  texturePosition: { x: 0, y: 0 },
  texturePositionClipSpace: { x: 0, y: 0 },
  offset: { x: 0, y: 0 },
  size: { x: 0, y: 0 },
  sizeClipSpace: { x: 0, y: 0 },
  lastFrame: 0,
  isColored: false
};

const enum StyleFlags {
  BOLD = 1 << 0,
  ITALIC = 1 << 1,
  UNDERLINE = 1 << 2,
  STRIKETHROUGH = 1 << 3,
  OVERLINE = 1 << 4,
  UNDERLINE_STYLE_SHIFT = 5,
  UNDERLINE_STYLE_MASK = 0x7 << 5,
  VARIANT_OFFSET_SHIFT = 8,
  VARIANT_OFFSET_MASK = 0x3f << 8
}

const TMP_CANVAS_GLYPH_PADDING = 2;

const enum Constants {
  /**
   * The amount of pixel padding to allow in each row. Setting this to zero would make the atlas
   * page pack as tightly as possible, but more pages would end up being created as a result.
   */
  ROW_PIXEL_THRESHOLD = 2,
  /**
   * The maximum texture size regardless of what the actual hardware maximum turns out to be. This
   * is enforced to ensure uploading the texture still finishes in a reasonable amount of time. A
   * 4096 squared image takes up 16MB of GPU memory.
   */
  FORCED_MAX_TEXTURE_SIZE = 4096
}

interface ICharAtlasActiveRow {
  x: number;
  y: number;
  height: number;
}

// Work variables to avoid garbage collection
let $glyph = undefined;

export class TextureAtlas implements ITextureAtlas {
  private _didWarmUp: boolean = false;

  private _cacheMap: TwoKeyMap<number, number, IRasterizedGlyph> = new TwoKeyMap();
  private _cacheMapCombined: TwoKeyMap<string, number, IRasterizedGlyph> = new TwoKeyMap();

  // The texture that the atlas is drawn to
  private _pages: AtlasPage[] = [];
  public get pages(): { canvas: HTMLCanvasElement, version: number }[] { return this._pages; }

  // The set of atlas pages that can be written to
  private _activePages: AtlasPage[] = [];
  private _overflowSizePage: AtlasPage | undefined;

  private _tmpCanvas: HTMLCanvasElement;
  // A temporary context that glyphs are drawn to before being transfered to the atlas.
  private _tmpCtx: CanvasRenderingContext2D;

  private _workBoundingBox: IBoundingBox = { top: 0, left: 0, bottom: 0, right: 0 };
  private _workAttributeData: AttributeData = new AttributeData();

  private _textureSize: number = 1024;

  public static maxAtlasPages: number | undefined;
  public static maxTextureSize: number | undefined;

  private readonly _onAddTextureAtlasCanvas = new Emitter<HTMLCanvasElement>();
  public readonly onAddTextureAtlasCanvas = this._onAddTextureAtlasCanvas.event;
  private readonly _onRemoveTextureAtlasCanvas = new Emitter<HTMLCanvasElement>();
  public readonly onRemoveTextureAtlasCanvas = this._onRemoveTextureAtlasCanvas.event;

  constructor(
    private readonly _document: Document,
    private readonly _config: ICharAtlasConfig,
    private readonly _unicodeService: IUnicodeService,
    private readonly _logService: ILogService
  ) {
    this._createNewPage();
    this._tmpCanvas = createCanvas(
      _document,
      this._config.deviceCellWidth * 4 + TMP_CANVAS_GLYPH_PADDING * 2,
      this._config.deviceCellHeight + TMP_CANVAS_GLYPH_PADDING * 2
    );
    this._tmpCtx = throwIfFalsy(this._tmpCanvas.getContext('2d', {
      alpha: true,
      willReadFrequently: true
    }));
  }

  public dispose(): void {
    this._tmpCanvas.remove();
    for (const page of this.pages) {
      page.canvas.remove();
    }
    this._onAddTextureAtlasCanvas.dispose();
  }

  public warmUp(): void {
    if (!this._didWarmUp) {
      this._doWarmUp();
      this._didWarmUp = true;
    }
  }

  private _doWarmUp(): void {
    // Pre-fill with ASCII 33-126, this is not urgent and done in idle callbacks
    const queue = new IdleTaskQueue(this._logService);
    for (let i = 33; i < 126; i++) {
      queue.enqueue(() => {
        if (!this._cacheMap.get(i, 0)) {
          const rasterizedGlyph = this._drawToCache(i, 0, false, undefined);
          if (rasterizedGlyph !== NULL_RASTERIZED_GLYPH) {
            this._cacheMap.set(i, 0, rasterizedGlyph);
          }
        }
      });
    }
  }

  private _requestClearModel = false;
  private _currentFrame = 0;
  public beginFrame(): boolean {
    this._currentFrame++;
    const result = this._requestClearModel;
    this._requestClearModel = false;
    return result;
  }

  public clearTexture(): void {
    if (this._pages[0].currentRow.x === 0 && this._pages[0].currentRow.y === 0) {
      return;
    }
    for (const page of this._pages) {
      page.clear();
    }
    this._cacheMap.clear();
    this._cacheMapCombined.clear();
    this._didWarmUp = false;
  }

  private _createNewPage(): AtlasPage {
    if (TextureAtlas.maxAtlasPages && this._pages.length >= TextureAtlas.maxAtlasPages) {
      return this._evictLruPage();
    }
    const newPage = new AtlasPage(this._document, this._textureSize);
    this._pages.push(newPage);
    this._activePages.push(newPage);
    this._onAddTextureAtlasCanvas.fire(newPage.canvas);
    return newPage;
  }

  private _evictLruPage(): AtlasPage {
    let victim = this._pages[0];
    for (let i = 1; i < this._pages.length; i++) {
      if (this._pages[i].lastFrame < victim.lastFrame) {
        victim = this._pages[i];
      }
    }
    victim.evict();
    if (this._activePages.indexOf(victim) === -1) {
      this._activePages.push(victim);
    }
    this._requestClearModel = true;
    return victim;
  }

  public getRasterizedGlyphCombinedChar(chars: string, styleFlags: number, restrictToCellHeight: boolean, domContainer: HTMLElement | undefined): IRasterizedGlyph {
    return this._getFromCacheMap(this._cacheMapCombined, chars, styleFlags, restrictToCellHeight, domContainer);
  }

  public getRasterizedGlyph(code: number, styleFlags: number, restrictToCellHeight: boolean, domContainer: HTMLElement | undefined): IRasterizedGlyph {
    return this._getFromCacheMap(this._cacheMap, code, styleFlags, restrictToCellHeight, domContainer);
  }

  // Packs the cell's style attributes (fg flag bits + ext underline style/variant) into the
  // single number used as the alpha-only atlas's cache key.
  public extractStyleFlags(fg: number, ext: number): number {
    this._workAttributeData.fg = fg;
    this._workAttributeData.bg = 0;
    this._workAttributeData.extended.ext = ext;
    let flags = 0;
    if (this._workAttributeData.isBold()) flags |= StyleFlags.BOLD;
    if (this._workAttributeData.isItalic()) flags |= StyleFlags.ITALIC;
    if (this._workAttributeData.isStrikethrough()) flags |= StyleFlags.STRIKETHROUGH;
    if (this._workAttributeData.isOverline()) flags |= StyleFlags.OVERLINE;
    if (this._workAttributeData.isUnderline()) {
      flags |= StyleFlags.UNDERLINE;
      flags |= (this._workAttributeData.extended.underlineStyle & 0x7) << StyleFlags.UNDERLINE_STYLE_SHIFT;
      flags |= (this._workAttributeData.getUnderlineVariantOffset() & 0x3f) << StyleFlags.VARIANT_OFFSET_SHIFT;
    }
    return flags;
  }

  // Resolves the per-cell foreground color into normalized RGBA, applying inverse,
  // dim and minimumContrastRatio adjustments. Returns true if the cell should not
  // render a glyph (the INVISIBLE flag was set, e.g. blinking text in its off phase).
  public resolveFgRgba(bg: number, fg: number, ext: number, charCode: number, dst: Float32Array, dstOffset: number): boolean {
    this._workAttributeData.fg = fg;
    this._workAttributeData.bg = bg;
    this._workAttributeData.extended.ext = ext;
    if (this._workAttributeData.isInvisible()) {
      return true;
    }
    const bold = !!this._workAttributeData.isBold();
    const inverse = !!this._workAttributeData.isInverse();
    const dim = !!this._workAttributeData.isDim();
    let fgColor = this._workAttributeData.getFgColor();
    let fgColorMode = this._workAttributeData.getFgColorMode();
    let bgColor = this._workAttributeData.getBgColor();
    let bgColorMode = this._workAttributeData.getBgColorMode();
    if (inverse) {
      const temp = fgColor; fgColor = bgColor; bgColor = temp;
      const temp2 = fgColorMode; fgColorMode = bgColorMode; bgColorMode = temp2;
    }
    const color = this._getForegroundColor(bg, bgColorMode, bgColor, fg, fgColorMode, fgColor, inverse, dim, bold, treatGlyphAsBackgroundColor(charCode));
    dst[dstOffset    ] = ((color.rgba >>> 24) & 0xFF) / 255;
    dst[dstOffset + 1] = ((color.rgba >>> 16) & 0xFF) / 255;
    dst[dstOffset + 2] = ((color.rgba >>> 8) & 0xFF) / 255;
    dst[dstOffset + 3] = (color.rgba & 0xFF) / 255;
    return false;
  }

  private _getFromCacheMap(
    cacheMap: TwoKeyMap<string | number, number, IRasterizedGlyph>,
    key: string | number,
    styleFlags: number,
    restrictToCellHeight: boolean,
    domContainer: HTMLElement | undefined
  ): IRasterizedGlyph {
    $glyph = cacheMap.get(key, styleFlags);
    if (!$glyph) {
      $glyph = this._drawToCache(key, styleFlags, restrictToCellHeight, domContainer);
      if ($glyph !== NULL_RASTERIZED_GLYPH) {
        cacheMap.set(key, styleFlags, $glyph);
        $glyph.removeFromCache = () => cacheMap.delete(key, styleFlags);
      }
    }
    if ($glyph !== NULL_RASTERIZED_GLYPH) {
      $glyph.lastFrame = this._currentFrame;
      const page = this._pages[$glyph.texturePage];
      if (page) {
        page.lastFrame = this._currentFrame;
      }
    }
    return $glyph;
  }

  private _getColorFromAnsiIndex(idx: number): IColor {
    if (idx >= this._config.colors.ansi.length) {
      throw new Error('No color found for idx ' + idx);
    }
    return this._config.colors.ansi[idx];
  }

  private _getForegroundColor(bg: number, bgColorMode: number, bgColor: number, fg: number, fgColorMode: number, fgColor: number, inverse: boolean, dim: boolean, bold: boolean, excludeFromContrastRatioDemands: boolean): IColor {
    const minimumContrastColor = this._getMinimumContrastColor(bg, bgColorMode, bgColor, fg, fgColorMode, fgColor, inverse, bold, dim, excludeFromContrastRatioDemands);
    if (minimumContrastColor) {
      return minimumContrastColor;
    }

    let result: IColor;
    switch (fgColorMode) {
      case Attributes.CM_P16:
      case Attributes.CM_P256:
        if (this._config.drawBoldTextInBrightColors && bold && fgColor < 8) {
          fgColor += 8;
        }
        result = this._getColorFromAnsiIndex(fgColor);
        break;
      case Attributes.CM_RGB:
        const arr = AttributeData.toColorRGB(fgColor);
        result = channels.toColor(arr[0], arr[1], arr[2]);
        break;
      case Attributes.CM_DEFAULT:
      default:
        if (inverse) {
          result = this._config.colors.background;
        } else {
          result = this._config.colors.foreground;
        }
    }

    // Always use an opaque color regardless of allowTransparency
    if (this._config.allowTransparency) {
      result = color.opaque(result);
    }

    // Apply dim to the color, opacity is fine to use for the foreground color
    if (dim) {
      result = color.multiplyOpacity(result, DIM_OPACITY);
    }

    return result;
  }

  private _resolveBackgroundRgba(bgColorMode: number, bgColor: number, inverse: boolean): number {
    switch (bgColorMode) {
      case Attributes.CM_P16:
      case Attributes.CM_P256:
        return this._getColorFromAnsiIndex(bgColor).rgba;
      case Attributes.CM_RGB:
        return bgColor << 8;
      case Attributes.CM_DEFAULT:
      default:
        if (inverse) {
          return this._config.colors.foreground.rgba;
        }
        return this._config.colors.background.rgba;
    }
  }

  private _resolveForegroundRgba(fgColorMode: number, fgColor: number, inverse: boolean, bold: boolean): number {
    switch (fgColorMode) {
      case Attributes.CM_P16:
      case Attributes.CM_P256:
        if (this._config.drawBoldTextInBrightColors && bold && fgColor < 8) {
          fgColor += 8;
        }
        return this._getColorFromAnsiIndex(fgColor).rgba;
      case Attributes.CM_RGB:
        return fgColor << 8;
      case Attributes.CM_DEFAULT:
      default:
        if (inverse) {
          return this._config.colors.background.rgba;
        }
        return this._config.colors.foreground.rgba;
    }
  }

  private _getMinimumContrastColor(bg: number, bgColorMode: number, bgColor: number, fg: number, fgColorMode: number, fgColor: number, inverse: boolean, bold: boolean, dim: boolean, excludeFromContrastRatioDemands: boolean): IColor | undefined {
    if (this._config.minimumContrastRatio === 1 || excludeFromContrastRatioDemands) {
      return undefined;
    }

    // Try get from cache first
    const cache = this._getContrastCache(dim);
    const adjustedColor = cache.getColor(bg, fg);
    if (adjustedColor !== undefined) {
      return adjustedColor ?? undefined;
    }

    const bgRgba = this._resolveBackgroundRgba(bgColorMode, bgColor, inverse);
    const fgRgba = this._resolveForegroundRgba(fgColorMode, fgColor, inverse, bold);
    // Dim cells only require half the contrast, otherwise they wouldn't be distinguishable from
    // non-dim cells
    const result = rgba.ensureContrastRatio(bgRgba, fgRgba, this._config.minimumContrastRatio / (dim ? 2 : 1));

    if (!result) {
      cache.setColor(bg, fg, null);
      return undefined;
    }

    const color = channels.toColor(
      (result >> 24) & 0xFF,
      (result >> 16) & 0xFF,
      (result >> 8) & 0xFF
    );
    cache.setColor(bg, fg, color);

    return color;
  }

  private _getContrastCache(dim: boolean): IColorContrastCache {
    if (dim) {
      return this._config.colors.halfContrastCache;
    }
    return this._config.colors.contrastCache;
  }

  private _drawToCache(codeOrChars: number | string, styleFlags: number, restrictToCellHeight: boolean, domContainer: HTMLElement | undefined): IRasterizedGlyph {
    const chars = typeof codeOrChars === 'number' ? String.fromCharCode(codeOrChars) : codeOrChars;

    if (domContainer && this._tmpCanvas.parentElement !== domContainer) {
      this._tmpCanvas.style.display = 'none';
      domContainer.append(this._tmpCanvas);
    }

    const allowedWidth = Math.min(this._config.deviceCellWidth * Math.max(chars.length, 2) + TMP_CANVAS_GLYPH_PADDING * 2, this._config.deviceMaxTextureSize);
    if (this._tmpCanvas.width < allowedWidth) {
      this._tmpCanvas.width = allowedWidth;
    }
    const allowedHeight = Math.min(this._config.deviceCellHeight + TMP_CANVAS_GLYPH_PADDING * 4, this._textureSize);
    if (this._tmpCanvas.height < allowedHeight) {
      this._tmpCanvas.height = allowedHeight;
    }

    const bold = (styleFlags & StyleFlags.BOLD) !== 0;
    const italic = (styleFlags & StyleFlags.ITALIC) !== 0;
    const underline = (styleFlags & StyleFlags.UNDERLINE) !== 0;
    const strikethrough = (styleFlags & StyleFlags.STRIKETHROUGH) !== 0;
    const overline = (styleFlags & StyleFlags.OVERLINE) !== 0;
    const underlineStyle = (styleFlags & StyleFlags.UNDERLINE_STYLE_MASK) >>> StyleFlags.UNDERLINE_STYLE_SHIFT;
    const variantOffset = (styleFlags & StyleFlags.VARIANT_OFFSET_MASK) >>> StyleFlags.VARIANT_OFFSET_SHIFT;

    this._tmpCtx.save();
    this._tmpCtx.clearRect(0, 0, this._tmpCanvas.width, this._tmpCanvas.height);

    const fontWeight = bold ? this._config.fontWeightBold : this._config.fontWeight;
    const fontStyle = italic ? 'italic' : '';
    this._tmpCtx.font =
      `${fontStyle} ${fontWeight} ${this._config.fontSize * this._config.devicePixelRatio}px ${this._config.fontFamily}`;
    this._tmpCtx.textBaseline = TEXT_BASELINE;

    const restrictedPowerlineGlyph = chars.length === 1 && isRestrictedPowerlineGlyph(chars.charCodeAt(0));

    // Alpha-only rasterization: glyph drawn in white on a transparent canvas. The fragment
    // shader tints by the per-cell fg color at draw time, so the same atlas entry serves any
    // fg/bg combination — eliminating the cache-key explosion that drives atlas thrash.
    this._tmpCtx.fillStyle = '#ffffff';

    const padding = restrictedPowerlineGlyph ? 0 : TMP_CANVAS_GLYPH_PADDING * 2;

    let customGlyph = false;
    if (this._config.customGlyphs !== false) {
      customGlyph = tryDrawCustomGlyph(this._tmpCtx, chars, padding, padding, this._config.deviceCellWidth, this._config.deviceCellHeight, this._config.deviceCharWidth, this._config.deviceCharHeight, this._config.fontSize, this._config.devicePixelRatio, undefined, variantOffset);
    }

    let chWidth: number;
    if (typeof codeOrChars === 'number') {
      chWidth = this._unicodeService.wcwidth(codeOrChars);
    } else {
      chWidth = this._unicodeService.getStringCellWidth(codeOrChars);
    }

    if (underline) {
      this._tmpCtx.save();
      const lineWidth = Math.max(1, Math.floor(this._config.fontSize * this._config.devicePixelRatio / 15));
      const yOffset = lineWidth % 2 === 1 ? 0.5 : 0;
      this._tmpCtx.lineWidth = lineWidth;
      this._tmpCtx.strokeStyle = '#ffffff';
      this._tmpCtx.fillStyle = '#ffffff';

      this._tmpCtx.beginPath();
      const xLeft = padding;
      const yTopDefault = Math.ceil(padding + this._config.deviceCharHeight) - yOffset - (restrictToCellHeight ? lineWidth * 2 : 0);
      const yBotDefault = yTopDefault + lineWidth * 2;
      let nextOffset = variantOffset;

      for (let i = 0; i < chWidth; i++) {
        let wasFilled = false;
        this._tmpCtx.save();
        const xChLeft = xLeft + i * this._config.deviceCellWidth;
        const xChRight = xLeft + (i + 1) * this._config.deviceCellWidth;
        switch (underlineStyle) {
          case UnderlineStyle.DOUBLE:
            this._tmpCtx.moveTo(xChLeft, yTopDefault);
            this._tmpCtx.lineTo(xChRight, yTopDefault);
            this._tmpCtx.moveTo(xChLeft, yBotDefault);
            this._tmpCtx.lineTo(xChRight, yBotDefault);
            break;
          case UnderlineStyle.CURLY: {
            const yTop = this._config.deviceCharHeight + 1;
            const yBot = yTop + 3 * this._config.devicePixelRatio;
            const clipRegion = new Path2D();
            clipRegion.rect(xChLeft, yTop, this._config.deviceCellWidth, yBot - yTop);
            this._tmpCtx.clip(clipRegion);
            const cellW = this._config.deviceCellWidth;
            const curlyH = (yBot - yTop);
            const scaleX = cellW / 6;
            const scaleY = curlyH / 3;
            const polygons: number[][] = [
              [0, 2, 1, 3, 2.4, 3, 0, 0.6],
              [5.5, 0, 2.5, 3, 1.1, 3, 4.1, 0],
              [4, 0, 6, 2, 6, 0.6, 5.4, 0]
            ];
            for (const polygon of polygons) {
              this._tmpCtx.beginPath();
              for (let i = 0; i < polygon.length; i += 2) {
                const x = xChLeft + polygon[i] * scaleX;
                const y = yBot - polygon[i + 1] * scaleY;
                if (i === 0) {
                  this._tmpCtx.moveTo(x, y);
                } else {
                  this._tmpCtx.lineTo(x, y);
                }
              }
              this._tmpCtx.closePath();
              this._tmpCtx.fill();
            }
            wasFilled = true;
            break;
          }
          case UnderlineStyle.DOTTED: {
            const offsetWidth = nextOffset === 0 ? 0 :
              (nextOffset >= lineWidth ? lineWidth * 2 - nextOffset : lineWidth - nextOffset);
            const isLineStart = nextOffset >= lineWidth ? false : true;
            if (isLineStart === false || offsetWidth === 0) {
              this._tmpCtx.setLineDash([Math.round(lineWidth), Math.round(lineWidth)]);
              this._tmpCtx.moveTo(xChLeft + offsetWidth, yTopDefault);
              this._tmpCtx.lineTo(xChRight, yTopDefault);
            } else {
              this._tmpCtx.setLineDash([Math.round(lineWidth), Math.round(lineWidth)]);
              this._tmpCtx.moveTo(xChLeft, yTopDefault);
              this._tmpCtx.lineTo(xChLeft + offsetWidth, yTopDefault);
              this._tmpCtx.moveTo(xChLeft + offsetWidth + lineWidth, yTopDefault);
              this._tmpCtx.lineTo(xChRight, yTopDefault);
            }
            nextOffset = computeNextVariantOffset(xChRight - xChLeft, lineWidth, nextOffset);
            break;
          }
          case UnderlineStyle.DASHED: {
            const lineRatio = 0.6;
            const gapRatio = 0.3;
            const xChWidth = xChRight - xChLeft;
            const line = Math.floor(lineRatio * xChWidth);
            const gap = Math.floor(gapRatio * xChWidth);
            const end = xChWidth - line - gap;
            this._tmpCtx.setLineDash([line, gap, end]);
            this._tmpCtx.moveTo(xChLeft, yTopDefault);
            this._tmpCtx.lineTo(xChRight, yTopDefault);
            break;
          }
          case UnderlineStyle.SINGLE:
          default:
            this._tmpCtx.moveTo(xChLeft, yTopDefault);
            this._tmpCtx.lineTo(xChRight, yTopDefault);
            break;
        }
        if (!wasFilled) {
          this._tmpCtx.stroke();
        }
        this._tmpCtx.restore();
      }
      this._tmpCtx.restore();
    }

    if (overline) {
      const lineWidth = Math.max(1, Math.floor(this._config.fontSize * this._config.devicePixelRatio / 15));
      const yOffset = lineWidth % 2 === 1 ? 0.5 : 0;
      this._tmpCtx.lineWidth = lineWidth;
      this._tmpCtx.strokeStyle = '#ffffff';
      this._tmpCtx.beginPath();
      this._tmpCtx.moveTo(padding, padding + yOffset);
      this._tmpCtx.lineTo(padding + this._config.deviceCharWidth * chWidth, padding + yOffset);
      this._tmpCtx.stroke();
    }

    if (!customGlyph) {
      this._tmpCtx.fillText(chars, padding, padding + this._config.deviceCharHeight);
    }

    // Shift underscore up if it falls outside the cell.
    if (chars === '_') {
      let cellPixels = this._tmpCtx.getImageData(padding, padding, this._config.deviceCellWidth, this._config.deviceCellHeight);
      if (checkCompletelyTransparent(cellPixels)) {
        for (let offset = 1; offset <= 5; offset++) {
          this._tmpCtx.clearRect(0, 0, this._tmpCanvas.width, this._tmpCanvas.height);
          this._tmpCtx.fillText(chars, padding, padding + this._config.deviceCharHeight - offset);
          cellPixels = this._tmpCtx.getImageData(padding, padding, this._config.deviceCellWidth, this._config.deviceCellHeight);
          if (!checkCompletelyTransparent(cellPixels)) {
            break;
          }
        }
      }
    }

    if (strikethrough) {
      const lineWidth = Math.max(1, Math.floor(this._config.fontSize * this._config.devicePixelRatio / 10));
      const yOffset = this._tmpCtx.lineWidth % 2 === 1 ? 0.5 : 0;
      this._tmpCtx.lineWidth = lineWidth;
      this._tmpCtx.strokeStyle = '#ffffff';
      this._tmpCtx.beginPath();
      this._tmpCtx.moveTo(padding, padding + Math.floor(this._config.deviceCharHeight / 2) - yOffset);
      this._tmpCtx.lineTo(padding + this._config.deviceCharWidth * chWidth, padding + Math.floor(this._config.deviceCharHeight / 2) - yOffset);
      this._tmpCtx.stroke();
    }

    this._tmpCtx.restore();

    const imageData = this._tmpCtx.getImageData(0, 0, this._tmpCanvas.width, this._tmpCanvas.height);

    if (checkCompletelyTransparent(imageData)) {
      return NULL_RASTERIZED_GLYPH;
    }

    // Detect non-grayscale pixels (e.g. color emoji) so the shader can sample directly
    // instead of tinting.
    let isColored = false;
    for (let i = 0; i < imageData.data.length; i += 4) {
      if (imageData.data[i + 3] === 0) {
        continue;
      }
      if (imageData.data[i] !== imageData.data[i + 1] || imageData.data[i + 1] !== imageData.data[i + 2]) {
        isColored = true;
        break;
      }
    }

    const rasterizedGlyph = this._findGlyphBoundingBox(imageData, this._workBoundingBox, allowedWidth, restrictedPowerlineGlyph, customGlyph, padding);
    rasterizedGlyph.isColored = isColored;

    // Find the best atlas row to use
    let activePage: AtlasPage;
    let activeRow: ICharAtlasActiveRow;
    while (true) {
      // If there are no active pages (the last smallest 4 were merged), create a new one
      if (this._activePages.length === 0) {
        const newPage = this._createNewPage();
        activePage = newPage;
        activeRow = newPage.currentRow;
        activeRow.height = rasterizedGlyph.size.y;
        break;
      }

      // Get the best current row from all active pages
      activePage = this._activePages[this._activePages.length - 1];
      activeRow = activePage.currentRow;
      for (const p of this._activePages) {
        if (rasterizedGlyph.size.y <= p.currentRow.height) {
          activePage = p;
          activeRow = p.currentRow;
        }
      }

      // TODO: This algorithm could be simplified:
      // - Search for the page with ROW_PIXEL_THRESHOLD in mind
      // - Keep track of current/fixed rows in a Map

      // Replace the best current row with a fixed row if there is one at least as good as the
      // current row. Search in reverse to prioritize filling in older pages.
      for (let i = this._activePages.length - 1; i >= 0; i--) {
        for (const row of this._activePages[i].fixedRows) {
          if (row.height <= activeRow.height && rasterizedGlyph.size.y <= row.height) {
            activePage = this._activePages[i];
            activeRow = row;
          }
        }
      }

      // Create a new page for oversized glyphs as they come up
      if (rasterizedGlyph.size.x > this._textureSize) {
        if (!this._overflowSizePage) {
          this._overflowSizePage = new AtlasPage(this._document, this._config.deviceMaxTextureSize);
          this.pages.push(this._overflowSizePage);

          // Request the model to be cleared to refresh all texture pages.
          this._requestClearModel = true;
          this._onAddTextureAtlasCanvas.fire(this._overflowSizePage.canvas);
        }
        activePage = this._overflowSizePage;
        activeRow = this._overflowSizePage.currentRow;
        // Move to next row if necessary
        if (activeRow.x + rasterizedGlyph.size.x >= activePage.canvas.width) {
          activeRow.x = 0;
          activeRow.y += activeRow.height;
          activeRow.height = 0;
        }
        break;
      }

      // Create a new page if too much vertical space would be wasted or there is not enough room
      // left in the page. The previous active row will become fixed in the process as it now has a
      // fixed height
      if (activeRow.y + rasterizedGlyph.size.y >= activePage.canvas.height || activeRow.height > rasterizedGlyph.size.y + Constants.ROW_PIXEL_THRESHOLD) {
        // Create the new fixed height row, creating a new page if there isn't enough room on the
        // current page
        let wasPageAndRowFound = false;
        if (activePage.currentRow.y + activePage.currentRow.height + rasterizedGlyph.size.y >= activePage.canvas.height) {
          // Find the first page with room to create the new row on
          let candidatePage: AtlasPage | undefined;

          for (const p of this._activePages) {
            if (p.currentRow.y + p.currentRow.height + rasterizedGlyph.size.y < p.canvas.height) {
              candidatePage = p;
              break;
            }
          }
          if (candidatePage) {
            activePage = candidatePage;
          } else {
            // Before creating a new atlas page that would trigger a page merge, check if the
            // current active row is sufficient when ignoring the ROW_PIXEL_THRESHOLD. This will
            // improve texture utilization by using the available space before the page is merged
            // and becomes static.
            if (
              TextureAtlas.maxAtlasPages &&
              this._pages.length >= TextureAtlas.maxAtlasPages &&
              activeRow.y + rasterizedGlyph.size.y <= activePage.canvas.height &&
              activeRow.height >= rasterizedGlyph.size.y &&
              activeRow.x + rasterizedGlyph.size.x <= activePage.canvas.width
            ) {
              // activePage and activeRow is already valid
              wasPageAndRowFound = true;
            } else {
              // Create a new page if there is no room
              const newPage = this._createNewPage();
              activePage = newPage;
              activeRow = newPage.currentRow;
              activeRow.height = rasterizedGlyph.size.y;
              wasPageAndRowFound = true;
            }
          }
        }
        if (!wasPageAndRowFound) {
          // Fix the current row as the new row is being added below
          if (activePage.currentRow.height > 0) {
            activePage.fixedRows.push(activePage.currentRow);
          }
          activeRow = {
            x: 0,
            y: activePage.currentRow.y + activePage.currentRow.height,
            height: rasterizedGlyph.size.y
          };
          activePage.fixedRows.push(activeRow);

          // Create the new current row below the new fixed height row
          activePage.currentRow = {
            x: 0,
            y: activeRow.y + activeRow.height,
            height: 0
          };
        }
        // TODO: Remove pages from _activePages when all rows are filled
      }

      // Exit the loop if there is enough room in the row
      if (activeRow.x + rasterizedGlyph.size.x <= activePage.canvas.width) {
        break;
      }

      // If there is not enough room in the current row, finish it and try again
      if (activeRow === activePage.currentRow) {
        activeRow.x = 0;
        activeRow.y += activeRow.height;
        activeRow.height = 0;
      } else {
        activePage.fixedRows.splice(activePage.fixedRows.indexOf(activeRow), 1);
      }
    }

    // Record texture position
    rasterizedGlyph.texturePage = this._pages.indexOf(activePage);
    rasterizedGlyph.texturePosition.x = activeRow.x;
    rasterizedGlyph.texturePosition.y = activeRow.y;
    rasterizedGlyph.texturePositionClipSpace.x = activeRow.x / activePage.canvas.width;
    rasterizedGlyph.texturePositionClipSpace.y = activeRow.y / activePage.canvas.height;

    // Fix the clipspace position as pages may be of differing size
    rasterizedGlyph.sizeClipSpace.x /= activePage.canvas.width;
    rasterizedGlyph.sizeClipSpace.y /= activePage.canvas.height;

    // Update atlas current row, for fixed rows the glyph height will never be larger than the row
    // height
    activeRow.height = Math.max(activeRow.height, rasterizedGlyph.size.y);
    activeRow.x += rasterizedGlyph.size.x;

    // putImageData doesn't do any blending, so it will overwrite any existing cache entry for us
    activePage.ctx.putImageData(
      imageData,
      rasterizedGlyph.texturePosition.x - this._workBoundingBox.left,
      rasterizedGlyph.texturePosition.y - this._workBoundingBox.top,
      this._workBoundingBox.left,
      this._workBoundingBox.top,
      rasterizedGlyph.size.x,
      rasterizedGlyph.size.y
    );
    activePage.addGlyph(rasterizedGlyph);
    activePage.version = ++AtlasPage.nextVersion;

    return rasterizedGlyph;
  }

  /**
   * Given an ImageData object, find the bounding box of the non-transparent
   * portion of the texture and return an IRasterizedGlyph with these
   * dimensions.
   * @param imageData The image data to read.
   * @param boundingBox An IBoundingBox to put the clipped bounding box values.
   */
  private _findGlyphBoundingBox(imageData: ImageData, boundingBox: IBoundingBox, allowedWidth: number, restrictedGlyph: boolean, customGlyph: boolean, padding: number): IRasterizedGlyph {
    boundingBox.top = 0;
    const height = restrictedGlyph ? this._config.deviceCellHeight : this._tmpCanvas.height;
    const width = restrictedGlyph ? this._config.deviceCellWidth : allowedWidth;
    let found = false;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const alphaOffset = y * this._tmpCanvas.width * 4 + x * 4 + 3;
        if (imageData.data[alphaOffset] !== 0) {
          boundingBox.top = y;
          found = true;
          break;
        }
      }
      if (found) {
        break;
      }
    }
    boundingBox.left = 0;
    found = false;
    for (let x = 0; x < padding + width; x++) {
      for (let y = 0; y < height; y++) {
        const alphaOffset = y * this._tmpCanvas.width * 4 + x * 4 + 3;
        if (imageData.data[alphaOffset] !== 0) {
          boundingBox.left = x;
          found = true;
          break;
        }
      }
      if (found) {
        break;
      }
    }
    boundingBox.right = width;
    found = false;
    for (let x = padding + width - 1; x >= padding; x--) {
      for (let y = 0; y < height; y++) {
        const alphaOffset = y * this._tmpCanvas.width * 4 + x * 4 + 3;
        if (imageData.data[alphaOffset] !== 0) {
          boundingBox.right = x;
          found = true;
          break;
        }
      }
      if (found) {
        break;
      }
    }
    boundingBox.bottom = height;
    found = false;
    for (let y = height - 1; y >= 0; y--) {
      for (let x = 0; x < width; x++) {
        const alphaOffset = y * this._tmpCanvas.width * 4 + x * 4 + 3;
        if (imageData.data[alphaOffset] !== 0) {
          boundingBox.bottom = y;
          found = true;
          break;
        }
      }
      if (found) {
        break;
      }
    }
    return {
      texturePage: 0,
      texturePosition: { x: 0, y: 0 },
      texturePositionClipSpace: { x: 0, y: 0 },
      size: {
        x: boundingBox.right - boundingBox.left + 1,
        y: boundingBox.bottom - boundingBox.top + 1
      },
      sizeClipSpace: {
        x: (boundingBox.right - boundingBox.left + 1),
        y: (boundingBox.bottom - boundingBox.top + 1)
      },
      offset: {
        x: -boundingBox.left + padding + ((restrictedGlyph || customGlyph) ? Math.floor((this._config.deviceCellWidth - this._config.deviceCharWidth) / 2) : 0),
        y: -boundingBox.top + padding + ((restrictedGlyph || customGlyph) ? this._config.lineHeight === 1 ? 0 : Math.round((this._config.deviceCellHeight - this._config.deviceCharHeight) / 2) : 0)
      },
      lastFrame: 0,
      isColored: false
    };
  }
}

class AtlasPage {
  public readonly canvas: HTMLCanvasElement;
  public readonly ctx: CanvasRenderingContext2D;

  private _usedPixels: number = 0;
  public get percentageUsed(): number { return this._usedPixels / (this.canvas.width * this.canvas.height); }

  private readonly _glyphs: IRasterizedGlyph[] = [];
  public get glyphs(): ReadonlyArray<IRasterizedGlyph> { return this._glyphs; }
  public addGlyph(glyph: IRasterizedGlyph): void {
    this._glyphs.push(glyph);
    this._usedPixels += glyph.size.x * glyph.size.y;
  }

  /**
   * Frame counter of the most recent glyph access on this page; used for LRU eviction.
   */
  public lastFrame: number = 0;

  /**
   * Globally monotonic so the GPU-side version check cannot collide across page identity
   * changes (a freshly-evicted page reused at the same index gets a fresh value).
   */
  public static nextVersion: number = 0;
  public version: number = ++AtlasPage.nextVersion;

  // Texture atlas current positioning data. The texture packing strategy used is to fill from
  // left-to-right and top-to-bottom. When the glyph being written is less than half of the current
  // row's height, the following happens:
  //
  // - The current row becomes the fixed height row A
  // - A new fixed height row B the exact size of the glyph is created below the current row
  // - A new dynamic height current row is created below B
  //
  // This strategy does a good job preventing space being wasted for very short glyphs such as
  // underscores, hyphens etc. or those with underlines rendered.
  public currentRow: ICharAtlasActiveRow = {
    x: 0,
    y: 0,
    height: 0
  };
  public readonly fixedRows: ICharAtlasActiveRow[] = [];

  constructor(
    document: Document,
    size: number
  ) {
    this.canvas = createCanvas(document, size, size);
    this.ctx = throwIfFalsy(this.canvas.getContext('2d', { alpha: true }));
  }

  public clear(): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.currentRow.x = 0;
    this.currentRow.y = 0;
    this.currentRow.height = 0;
    this.fixedRows.length = 0;
    this.version = ++AtlasPage.nextVersion;
  }

  public evict(): void {
    for (const g of this._glyphs) {
      g.removeFromCache?.();
    }
    this._glyphs.length = 0;
    this._usedPixels = 0;
    this.lastFrame = 0;
    this.clear();
  }
}

function checkCompletelyTransparent(imageData: ImageData): boolean {
  for (let offset = 0; offset < imageData.data.length; offset += 4) {
    if (imageData.data[offset + 3] > 0) {
      return false;
    }
  }
  return true;
}

function createCanvas(document: Document, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}
