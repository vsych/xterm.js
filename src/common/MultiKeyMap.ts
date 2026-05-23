/**
 * Copyright (c) 2022 The xterm.js authors. All rights reserved.
 * @license MIT
 */

export class TwoKeyMap<TFirst extends string | number, TSecond extends string | number, TValue> {
  private _data: { [bg: string | number]: { [fg: string | number]: TValue | undefined } | undefined } = {};

  public set(first: TFirst, second: TSecond, value: TValue): void {
    if (!this._data[first]) {
      this._data[first] = {};
    }
    this._data[first as string | number]![second] = value;
  }

  public get(first: TFirst, second: TSecond): TValue | undefined {
    return this._data[first as string | number] ? this._data[first as string | number]![second] : undefined;
  }

  public delete(first: TFirst, second: TSecond): void {
    const inner = this._data[first as string | number];
    if (inner) {
      delete inner[second];
    }
  }

  public clear(): void {
    this._data = {};
  }
}

export class FourKeyMap<TFirst extends string | number, TSecond extends string | number, TThird extends string | number, TFourth extends string | number, TValue> {
  private _data: TwoKeyMap<TFirst, TSecond, TwoKeyMap<TThird, TFourth, TValue>> = new TwoKeyMap();

  public set(first: TFirst, second: TSecond, third: TThird, fourth: TFourth, value: TValue): void {
    if (!this._data.get(first, second)) {
      this._data.set(first, second, new TwoKeyMap());
    }
    this._data.get(first, second)!.set(third, fourth, value);
  }

  public get(first: TFirst, second: TSecond, third: TThird, fourth: TFourth): TValue | undefined {
    return this._data.get(first, second)?.get(third, fourth);
  }

  public delete(first: TFirst, second: TSecond, third: TThird, fourth: TFourth): void {
    this._data.get(first, second)?.delete(third, fourth);
  }

  public clear(): void {
    this._data.clear();
  }
}
