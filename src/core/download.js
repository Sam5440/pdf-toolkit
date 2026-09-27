// 产物下载与 ZIP 打包
import { zipSync } from 'fflate';
import { sanitizeFilename } from './format.js';

/** 生成不重复的文件名列表 */
function uniqueNames(artifacts) {
  const used = new Map();
  return artifacts.map((a) => {
    let name = sanitizeFilename(a.name);
    const n = used.get(name) || 0;
    used.set(name, n + 1);
    if (n > 0) {
      const dot = name.lastIndexOf('.');
      name = dot > 0 ? `${name.slice(0, dot)}(${n + 1})${name.slice(dot)}` : `${name}(${n + 1})`;
    }
    return name;
  });
}

/**
 * 触发浏览器下载（真实产物字节）
 * @param {{name:string, mime:string, bytes:Uint8Array|Blob}} artifact
 */
export function downloadArtifact(artifact) {
  const blob = artifact.bytes instanceof Blob
    ? artifact.bytes
    : new Blob([artifact.bytes], { type: artifact.mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = sanitizeFilename(artifact.name);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** 打包下载多个产物为 zip */
export async function downloadZip(artifacts, zipName = '输出文件.zip') {
  const names = uniqueNames(artifacts);
  const entries = await Promise.all(artifacts.map(async (a, i) => {
    const u8 = a.bytes instanceof Blob ? new Uint8Array(await a.bytes.arrayBuffer()) : a.bytes;
    return [names[i], u8];
  }));
  const zipped = zipSync(Object.fromEntries(entries), { level: 6 });
  downloadArtifact({ name: zipName, mime: 'application/zip', bytes: zipped });
}
