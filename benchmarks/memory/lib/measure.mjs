import fs from "node:fs";
import v8 from "node:v8";

export function rssKb() {
  try {
    const st = fs.readFileSync("/proc/self/status", "utf8");
    const m = /VmRSS:\s+(\d+)/.exec(st);
    return m ? Number(m[1]) : Math.round(process.memoryUsage().rss / 1024);
  } catch {
    return Math.round(process.memoryUsage().rss / 1024);
  }
}

export function hasExposeGc() {
  return typeof global.gc === "function";
}

export function snap(label, { gc = false } = {}) {
  if (gc && typeof global.gc === "function") global.gc();
  const mu = process.memoryUsage();
  const hs = v8.getHeapStatistics();
  return {
    label,
    gcForced: Boolean(gc && global.gc),
    rssMb: +(mu.rss / 1048576).toFixed(2),
    rssKb: rssKb(),
    heapUsedMb: +(mu.heapUsed / 1048576).toFixed(2),
    heapTotalMb: +(mu.heapTotal / 1048576).toFixed(2),
    externalMb: +(mu.external / 1048576).toFixed(2),
    arrayBuffersMb: +(mu.arrayBuffers / 1048576).toFixed(2),
    heapSizeLimitMb: +(hs.heap_size_limit / 1048576).toFixed(2),
    usedHeapSizeMb: +(hs.used_heap_size / 1048576).toFixed(2),
  };
}

export function deltaMb(after, before, field = "heapUsedMb") {
  return +(after[field] - before[field]).toFixed(2);
}
