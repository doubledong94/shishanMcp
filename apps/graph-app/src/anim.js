/**
 * 轻量动画/tween 引擎 —— 移植自旧项目 shishandaimaViewer 的 AnimationUtil（无第三方依赖）。
 *
 * - 正弦缓动（sine ease-in-out），等价旧项目 `sin(p*π - π/2)/2 + 0.5`：
 *   平滑起步 -> 中间快 -> 平滑收尾，约 30 帧（~500ms）。
 * - `onUpdate(v)` 逐帧回传当前插值 v（from..to），供外部按需应用增量/直接赋值。
 * - 返回 token 可取消。
 */

/** 正弦缓动：p∈[0,1] → eased∈[0,1] */
export function sineInOut(p) {
  return 0.5 * (1 - Math.cos(Math.PI * p));
}

/**
 * 创建 tween 引擎。
 * @returns {{
 *   add(opts:{from?:number,to?:number,duration?:number,ease?:Function,onUpdate?:Function,onEnd?:Function}):number,
 *   cancel(id:number):void,
 *   cancelAll():void,
 *   update(dt:number):void
 * }}
 */
export function createTweenEngine() {
  const tweens = [];
  let nextId = 1;

  return {
    add({ from = 0, to = 1, duration = 500, ease = sineInOut, onUpdate, onEnd } = {}) {
      const id = nextId++;
      tweens.push({ id, from, to, t: 0, duration, ease, onUpdate, onEnd });
      return id;
    },

    cancel(id) {
      const i = tweens.findIndex((x) => x.id === id);
      if (i >= 0) tweens.splice(i, 1);
    },

    cancelAll() {
      tweens.length = 0;
    },

    /** 每帧调用，dt 为毫秒 */
    update(dt) {
      for (let i = tweens.length - 1; i >= 0; i--) {
        const x = tweens[i];
        x.t += dt > 0 ? dt : 0;
        const p = x.duration <= 0 ? 1 : Math.min(x.t / x.duration, 1);
        const v = x.from + (x.to - x.from) * x.ease(p);
        if (x.onUpdate) x.onUpdate(v, p);
        if (p >= 1) {
          tweens.splice(i, 1);
          if (x.onEnd) x.onEnd(v);
        }
      }
    },
  };
}
