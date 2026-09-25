/**
 * Copyright (c) 2018 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { BaseWindow } from './baseWindow';
import type { IControlWindow } from '../controlBar';
import { attachFpsOverlay, type IFpsOverlayHandle } from '../fpsOverlay';

export class WebglWindow extends BaseWindow implements IControlWindow {
  public readonly id = 'addon-webgl';
  public readonly label = 'webgl';

  private _textureAtlasContainer!: HTMLElement;
  private _fpsOverlay: IFpsOverlayHandle | undefined;

  public build(container: HTMLElement): void {
    const zoomCheckbox = document.createElement('input');
    zoomCheckbox.type = 'checkbox';
    zoomCheckbox.id = 'texture-atlas-zoom';
    container.appendChild(zoomCheckbox);

    const zoomLabel = document.createElement('label');
    zoomLabel.htmlFor = 'texture-atlas-zoom';
    zoomLabel.textContent = 'Zoom texture atlas';
    container.appendChild(zoomLabel);

    container.appendChild(document.createElement('br'));

    const fpsCheckbox = document.createElement('input');
    fpsCheckbox.type = 'checkbox';
    fpsCheckbox.id = 'webgl-fps';
    fpsCheckbox.addEventListener('change', () => {
      if (fpsCheckbox.checked) {
        this._fpsOverlay = attachFpsOverlay();
      } else {
        this._fpsOverlay?.destroy();
        this._fpsOverlay = undefined;
      }
    });
    container.appendChild(fpsCheckbox);

    const fpsLabel = document.createElement('label');
    fpsLabel.htmlFor = 'webgl-fps';
    fpsLabel.textContent = 'Show FPS overlay';
    container.appendChild(fpsLabel);

    this._textureAtlasContainer = document.createElement('div');
    this._textureAtlasContainer.id = 'texture-atlas';
    container.appendChild(this._textureAtlasContainer);
  }

  public setTextureAtlas(canvas: HTMLCanvasElement): void {
    this._styleAtlasPage(canvas);
    this._textureAtlasContainer.replaceChildren(canvas);
  }

  public appendTextureAtlas(canvas: HTMLCanvasElement): void {
    this._styleAtlasPage(canvas);
    this._textureAtlasContainer.appendChild(canvas);
  }

  public removeTextureAtlas(canvas: HTMLCanvasElement): void {
    canvas.remove();
  }

  private _styleAtlasPage(canvas: HTMLCanvasElement): void {
    // eslint-disable-next-line no-restricted-syntax
    const dpr = window.devicePixelRatio;
    canvas.style.width = `${canvas.width / dpr}px`;
    canvas.style.height = `${canvas.height / dpr}px`;
  }
}
