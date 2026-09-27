import { describe, it, expect } from 'vitest';
import { normBox, visualSize, visualToUser, userToVisual, userAngleForVisual, visualVecToUser, anchorPoint, clampCrop, composeRotation } from '../../src/core/geometry.js';

describe('geometry 坐标变换', () => {
  const box = { x0: 0, y0: 0, x1: 100, y1: 50 };

  it('visualSize 旋转互换', () => {
    expect(visualSize(box, 0)).toEqual({ w: 100, h: 50 });
    expect(visualSize(box, 90)).toEqual({ w: 50, h: 100 });
    expect(visualSize(box, 270)).toEqual({ w: 50, h: 100 });
    expect(visualSize(box, 450)).toEqual({ w: 50, h: 100 }); // 450 ≡ 90
  });

  it('visualToUser/userToVisual 互逆（四角）', () => {
    for (const r of [0, 90, 180, 270]) {
      const { w, h } = visualSize(box, r);
      const corners = [[0, 0], [w, 0], [0, h], [w, h], [w / 2, h / 2]];
      for (const [vx, vy] of corners) {
        const u = visualToUser(vx, vy, box, r);
        const v = userToVisual(u.x, u.y, box, r);
        expect(v.vx).toBeCloseTo(vx, 6);
        expect(v.vy).toBeCloseTo(vy, 6);
      }
    }
  });

  it('r=90 角标映射（顺时针显示）', () => {
    // 用户左下 → 视觉左上
    expect(visualToUser(0, 0, box, 90)).toEqual({ x: 0, y: 0 });
    // 用户左上 → 视觉右上
    const u = visualToUser(50, 0, box, 90);
    expect(u.x).toBeCloseTo(0); expect(u.y).toBeCloseTo(50);
  });

  it('r=0 视觉顶部 = 用户 y 大', () => {
    const u = visualToUser(10, 0, box, 0);
    expect(u.y).toBeCloseTo(50); // 顶部
  });

  it('userAngleForVisual：r=90 视觉水平 → 用户逆时针90°', () => {
    expect(userAngleForVisual(0, 90)).toBe(90);
    expect(userAngleForVisual(45, 0)).toBe(45);
  });

  it('visualVecToUser 方向正确', () => {
    // r=0：视觉向下 = 用户 y 减小
    expect(visualVecToUser(0, 1, 0)).toEqual({ dx: 0, dy: -1 });
    // r=90：视觉向右 = 用户 y 增大
    expect(visualVecToUser(1, 0, 90)).toEqual({ dx: 0, dy: 1 });
    // r=180：视觉向右 = 用户 x 减小
    expect(visualVecToUser(1, 0, 180)).toEqual({ dx: -1, dy: 0 });
  });

  it('anchorPoint 九宫格', () => {
    expect(anchorPoint('tl', 100, 50)).toEqual({ vx: 0, vy: 0 });
    expect(anchorPoint('mc', 100, 50)).toEqual({ vx: 50, vy: 25 });
    expect(anchorPoint('br', 100, 50)).toEqual({ vx: 100, vy: 50 });
  });

  it('clampCrop 限制在 MediaBox', () => {
    const c = clampCrop({ x0: -10, y0: -10, x1: 200, y1: 200 }, box);
    expect(c.x0).toBe(0); expect(c.y0).toBe(0);
    expect(c.x1).toBe(100); expect(c.y1).toBe(50);
  });

  it('normBox 兼容两种输入', () => {
    expect(normBox({ x: 5, y: 5, width: 10, height: 20 })).toEqual({ x0: 5, y0: 5, x1: 15, y1: 25, w: 10, h: 20 });
  });

  it('composeRotation', () => {
    expect(composeRotation(270, 90)).toBe(0);
    expect(composeRotation(90, 180)).toBe(270);
    expect(composeRotation(0, -90)).toBe(270);
  });
});
