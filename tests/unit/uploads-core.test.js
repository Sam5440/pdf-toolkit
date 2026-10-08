// 上传登记册纯逻辑单测：多格式外链、失效探测策略、GitHub 上传辅助
// （IndexedDB/Image/fetch 探测的用户链路归 e2e；这里只测 node 可运行的纯函数）
import { describe, it, expect } from 'vitest';
import {
  formatLinks, extOfUrl, probeStrategy,
} from '../../src/core/uploads.js';
import {
  IMAGE_SERVICES, GH_MAX_MB, IMAGE_EXTS, buildGhPath, ghErrMsg, extOf,
} from '../../src/tools/more/image-bed.js';

describe('上传登记册：链接格式与探测策略', () => {
  it('formatLinks 四种格式', () => {
    const L = formatLinks('https://raw.githubusercontent.com/o/r/main/pdftoolkit/图.png', '图.png');
    expect(L.url).toBe('https://raw.githubusercontent.com/o/r/main/pdftoolkit/图.png');
    expect(L.markdown).toBe('![图.png](https://raw.githubusercontent.com/o/r/main/pdftoolkit/图.png)');
    expect(L.html).toBe('<img src="https://raw.githubusercontent.com/o/r/main/pdftoolkit/图.png" alt="图.png">');
    expect(L.bbcode).toBe('[img]https://raw.githubusercontent.com/o/r/main/pdftoolkit/图.png[/img]');
  });

  it('formatLinks 名称缺省', () => {
    const L = formatLinks('https://x.test/a');
    expect(L.markdown).toBe('![file](https://x.test/a)');
  });

  it('extOfUrl 大小写不敏感、无扩展名返回空', () => {
    expect(extOfUrl('https://x.test/a/b.PNG')).toBe('png');
    expect(extOfUrl('https://x.test/a/b?query=1')).toBe('');
    expect(extOfUrl('not a url')).toBe('');
    expect(extOfUrl('https://x.test/.hidden')).toBe('');
  });

  it('probeStrategy：图片/视频走元素加载，其余走 HEAD', () => {
    expect(probeStrategy('https://x.test/a.png')).toBe('image');
    expect(probeStrategy('https://x.test/a.JPG')).toBe('image');
    expect(probeStrategy('https://x.test/a.webp')).toBe('image');
    expect(probeStrategy('https://x.test/a.mp4')).toBe('video');
    expect(probeStrategy('https://x.test/a.mov')).toBe('video');
    // 分享页/任意文件走 fetch HEAD
    expect(probeStrategy('https://onlyfiles.com/abc')).toBe('head');
    expect(probeStrategy('https://x.test/a.zip')).toBe('head');
  });
});

describe('图床：GitHub 上传辅助与服务预设', () => {
  it('服务预设结构：github 推荐 + 可直传三服务齐备', () => {
    for (const id of ['github', 'onlyfiles', 'tmpfiles', 'yohuo', 'custom']) {
      expect(IMAGE_SERVICES[id], `缺少服务 ${id}`).toBeTruthy();
      expect(IMAGE_SERVICES[id].maxMB).toBeGreaterThan(0);
    }
    expect(GH_MAX_MB).toBe(40);
    expect(IMAGE_SERVICES.github.embed).toBe(true);
  });

  it('图片扩展白名单含常用格式', () => {
    expect([...IMAGE_EXTS].sort()).toEqual(
      ['avif', 'bmp', 'gif', 'ico', 'jpeg', 'jpg', 'png', 'svg', 'webp'],
    );
  });

  it('buildGhPath：前缀清洗 + 原名保留 + 冲突加时间戳', () => {
    expect(buildGhPath('photo.png', 'pdftoolkit')).toBe('pdftoolkit/photo.png');
    expect(buildGhPath('photo.png', '/images/')).toMatch(/^images\/photo\.png$/);
    expect(buildGhPath('a/b.png', 'img')).toBe('img/a_b.png');
    const conflict = buildGhPath('photo.png', 'pdftoolkit', true);
    expect(conflict).toMatch(/^pdftoolkit\/[0-9a-z]+-photo\.png$/);
  });

  it('ghErrMsg：常见错误码转可读中文', () => {
    expect(ghErrMsg(401)).toMatch(/token 无效/);
    expect(ghErrMsg(403)).toMatch(/权限不足/);
    expect(ghErrMsg(404)).toMatch(/仓库或分支不存在/);
    expect(ghErrMsg(422)).toMatch(/同名文件/);
    expect(ghErrMsg(500, 'boom')).toBe('boom');
    expect(ghErrMsg(500)).toMatch(/HTTP 500/);
  });

  it('extOf 与文件床一致：大小写不敏感', () => {
    expect(extOf('PIC.WebP')).toBe('webp');
    expect(extOf('noext')).toBe('');
  });
});
