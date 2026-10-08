// 常用小功能批次单测：哈希计算、文本加解密、文件床校验
// （二维码往返见 qr-roundtrip.test.js；用户链路归 e2e more-util.spec.js）
import { describe, it, expect } from 'vitest';
import { md5, sha1, sha256, sha512, createMD5 } from 'hash-wasm';
import {
  cipherEncrypt, cipherDecrypt, b64Encode, b64Decode,
} from '../../src/tools/more/crypt.js';
import { hashBytes, hashFile } from '../../src/tools/more/hash-calc.js';
import {
  extOf, ALLOWED, DEFAULT_ENDPOINT, YOHUO_MB, PROXY_MB,
  SERVICES, parseUploadResponse, resolveService, uploadUrlOf,
} from '../../src/tools/more/filebed.js';

// ---- 哈希计算 ----
describe('哈希计算（hash-wasm）', () => {
  it('标准测试向量：abc', async () => {
    const bytes = new TextEncoder().encode('abc');
    expect(await md5(bytes)).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(await sha1(bytes)).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    expect(await sha256(bytes)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await sha512(bytes)).toBe('ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f');
  });

  it('空输入', async () => {
    expect(await md5(new Uint8Array(0))).toBe('d41d8cd98f00b204e9800998ecf8427e');
  });

  it('文件分块流式与一次性结果一致（含中文多字节跨块）', async () => {
    // 4MB+2 确定性伪随机字节 + 跨块中文，块大小与工具一致为 4MB → 制造跨块切分
    const enc = new TextEncoder();
    const part1 = new Uint8Array(4 * 1024 * 1024 + 2);
    let seed = 0x9e3779b9;
    for (let i = 0; i < part1.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      part1[i] = seed & 0xff;
    }
    const tail = enc.encode('中文尾部 tail');
    const all = new Uint8Array(part1.length + tail.length);
    all.set(part1); all.set(tail, part1.length);
    const fakeFile = { size: all.length, slice: (a, b) => new Blob([all.slice(a, b)]) };
    expect(await hashFile(createMD5, fakeFile)).toBe(await md5(all));
  });

  it('hashBytes 快捷入口与流式一致', async () => {
    const bytes = new TextEncoder().encode('quick check');
    expect(await hashBytes(md5, bytes)).toBe(await md5(bytes));
  });
});

// ---- 文本加解密 ----
describe('文本加解密（crypto-js）', () => {
  it('AES 往返：中英文 + 标点', () => {
    const msg = '机密文件 top-secret #2026！';
    const cipher = cipherEncrypt('aes', msg, '密钥k1');
    expect(cipher).not.toContain(msg);
    expect(cipherDecrypt('aes', cipher, '密钥k1')).toBe(msg);
  });

  it('DES / 3DES / RC4 往返', () => {
    for (const algo of ['des', 'tripledes', 'rc4']) {
      const msg = `roundtrip-${algo}-中文`;
      expect(cipherDecrypt(algo, cipherEncrypt(algo, msg, 'pw'), 'pw')).toBe(msg);
    }
  });

  it('错误密钥解密必须报错而非返回乱码', () => {
    const cipher = cipherEncrypt('aes', 'hello', 'right-key');
    expect(() => cipherDecrypt('aes', cipher, 'wrong-key')).toThrow(/解密失败/);
  });

  it('密文被篡改时解密报错', () => {
    const cipher = cipherEncrypt('aes', 'hello', 'k');
    const broken = cipher.slice(0, -4) + 'AAAA';
    expect(() => cipherDecrypt('aes', broken, 'k')).toThrow(/解密失败/);
  });

  it('Base64 往返（中文）', () => {
    const msg = '中文 base64 内容 +/';
    expect(b64Decode(b64Encode(msg))).toBe(msg);
  });

  it('非 Base64 输入解码报错', () => {
    expect(() => b64Decode('not@base64!!')).toThrow(/Base64/);
  });
});

// ---- 文件床 ----
describe('文件床（多服务约束与响应解析）', () => {
  it('扩展名解析大小写不敏感', () => {
    expect(extOf('photo.PNG')).toBe('png');
    expect(extOf('clip.MOV')).toBe('mov');
    expect(extOf('noext')).toBe('');
    expect(extOf('.hidden')).toBe('');
  });

  it('服务预设：默认站与各服务上限', () => {
    expect(DEFAULT_ENDPOINT).toBe('https://img.yohuo.eu.org');
    expect(YOHUO_MB).toBe(30);   // telegraph 服务端 MAX_SIZE_MB
    expect(PROXY_MB).toBe(100);  // onlyfiles / tmpfiles
    expect(SERVICES.onlyfiles.api).toBe('https://onlyfiles.com/api/v1/upload');
    expect(SERVICES.tmpfiles.api).toBe('https://tmpfiles.org/api/v1/upload');
    expect(SERVICES.yohuo.api).toBe('https://img.yohuo.eu.org/upload');
    // 可直传服务不限类型（无 telegraph 白名单），yohuo/自定义保留白名单
    expect(SERVICES.onlyfiles.telegraphWhitelist).toBe(false);
    expect(SERVICES.tmpfiles.telegraphWhitelist).toBe(false);
    expect(SERVICES.yohuo.telegraphWhitelist).toBe(true);
  });

  it('白名单与该部署 telegraph 的 ALLOWED_EXTENSIONS 一致', () => {
    expect([...ALLOWED].sort()).toEqual(
      ['avi', 'bmp', 'gif', 'jpeg', 'jpg', 'mov', 'mp4', 'png', 'svg', 'webm', 'webp'],
    );
  });

  it('响应解析：onlyfiles / tmpfiles / yohuo / telegraph 四种格式', () => {
    expect(parseUploadResponse({
      status: true, data: { file: { url: { full: 'https://onlyfiles.com/abc/x.png', short: 'https://onlyfiles.com/abc' } } },
    })).toBe('https://onlyfiles.com/abc/x.png');
    expect(parseUploadResponse({ status: 'success', data: { url: 'https://tmpfiles.org/abc/x.png' } }))
      .toBe('https://tmpfiles.org/abc/x.png');
    expect(parseUploadResponse({ data: 'https://src.yohuo.eu.org/1-abc.png' }))
      .toBe('https://src.yohuo.eu.org/1-abc.png');
    expect(parseUploadResponse([{ src: '/file/abc.png' }])).toBe('https://telegra.ph/file/abc.png');
    expect(parseUploadResponse([{ src: 'https://else.where/f.png' }])).toBe('https://else.where/f.png');
  });

  it('响应解析：服务端错误优先抛出；未知格式报错', () => {
    expect(() => parseUploadResponse({ error: 'File too large' })).toThrow(/File too large/);
    expect(() => parseUploadResponse({ hello: 'world' })).toThrow(/无法识别/);
    expect(() => parseUploadResponse(null)).toThrow(/无法识别/);
    expect(() => parseUploadResponse([{}])).toThrow(/无法识别/);
  });

  it('resolveService：老用户按旧 endpoint 归位，新用户默认 onlyfiles', () => {
    expect(resolveService('tmpfiles', null)).toBe('tmpfiles');
    expect(resolveService(null, DEFAULT_ENDPOINT)).toBe('yohuo');       // 老用户保持默认站
    expect(resolveService(null, 'https://my-worker.dev')).toBe('custom'); // 改过端点 → 自定义
    expect(resolveService(null, null)).toBe('onlyfiles');               // 新用户用可直传推荐服务
    expect(resolveService('bogus', null)).toBe('onlyfiles');            // 脏值兜底
  });

  it('uploadUrlOf：/upload 结尾原样，否则自动拼接', () => {
    expect(uploadUrlOf('https://w.dev')).toBe('https://w.dev/upload');
    expect(uploadUrlOf('https://w.dev/')).toBe('https://w.dev/upload');
    expect(uploadUrlOf('https://w.dev/upload')).toBe('https://w.dev/upload');
    expect(uploadUrlOf('https://onlyfiles.com/api/v1/upload')).toBe('https://onlyfiles.com/api/v1/upload');
  });
});
