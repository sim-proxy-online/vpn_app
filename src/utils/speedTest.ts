/**
 * Speed Test Utilities
 * Тестирование скорости соединения
 */

export interface SpeedTestProgress {
  stage: 'download' | 'upload' | 'ping';
  progress: number;
}

export async function measureDownloadSpeed(
  testUrl: string = 'https://speed.cloudflare.com/__down?bytes=10000000',
  onProgress?: (progress: SpeedTestProgress) => void
): Promise<number> {
  try {
    const startTime = performance.now();
    const response = await fetch(testUrl, {
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const buffer = await response.arrayBuffer();
    const endTime = performance.now();

    const durationSeconds = (endTime - startTime) / 1000;
    const bytes = buffer.byteLength;
    const speedMbps = (bytes * 8) / (durationSeconds * 1000000);

    onProgress?.({ stage: 'download', progress: 100 });
    return Math.max(0, speedMbps);
  } catch (e) {
    console.error('Download speed test failed:', e);
    return 0;
  }
}

export async function measureUploadSpeed(
  testUrl: string = 'https://speed.cloudflare.com/__up',
  onProgress?: (progress: SpeedTestProgress) => void
): Promise<number> {
  try {
    const testSize = 1024 * 1024; // 1 MB
    const data = new Uint8Array(testSize);
    crypto.getRandomValues(data);

    const startTime = performance.now();
    const response = await fetch(testUrl, {
      method: 'POST',
      body: data,
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const endTime = performance.now();
    const durationSeconds = (endTime - startTime) / 1000;
    const speedMbps = (testSize * 8) / (durationSeconds * 1000000);

    onProgress?.({ stage: 'upload', progress: 100 });
    return Math.max(0, speedMbps);
  } catch (e) {
    console.error('Upload speed test failed:', e);
    return 0;
  }
}

export async function measurePing(
  testUrl: string = 'https://1.1.1.1/dns-query'
): Promise<number> {
  try {
    const startTime = performance.now();

    await fetch(testUrl, {
      method: 'HEAD',
      signal: AbortSignal.timeout(5000),
    });

    const endTime = performance.now();
    return Math.round(endTime - startTime);
  } catch (e) {
    console.error('Ping test failed:', e);
    return -1;
  }
}

export function formatSpeed(speedMbps: number): string {
  if (speedMbps >= 1000) {
    return `${(speedMbps / 1000).toFixed(2)} Gbps`;
  }
  return `${speedMbps.toFixed(2)} Mbps`;
}

