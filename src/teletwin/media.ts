import type { ApiOnProgress } from '../api/types';
import { ApiMediaFormat } from '../api/types';

import * as mediaLoader from '../util/mediaLoader';
import { downloadCorpFile } from './api';
import { corpEngine } from './engine';
import { parseCorpMediaHash } from './ids';

// Corp media never enters the persistent media cache: the provider serves it straight from the corp server, and
// the in-memory blob URLs it produced are dropped on logout or revoke
const servedUrls = new Set<string>();

// 1x1 transparent PNG: answers thumbnail requests for media uploaded without a preview
const EMPTY_PNG = Uint8Array.from(atob(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
), (char) => char.charCodeAt(0));

export async function downloadCorpMedia(
  {
    url, mediaFormat, start, end,
  }: { url: string; mediaFormat: ApiMediaFormat; start?: number; end?: number },
  onProgress?: ApiOnProgress,
) {
  const parsed = parseCorpMediaHash(url);
  const credentials = corpEngine.credentials;
  if (!parsed || !credentials) return undefined;

  const isThumb = parsed.query.startsWith('size=');
  if (isThumb && !parsed.thumbFileId && !url.includes('photo')) {
    return buildResult(new Blob([EMPTY_PNG], { type: 'image/png' }), mediaFormat, 'image/png');
  }

  const fileId = isThumb && parsed.thumbFileId ? parsed.thumbFileId : parsed.fileId;
  const range = mediaFormat === ApiMediaFormat.Progressive && start !== undefined && end !== undefined
    ? { start, end }
    : undefined;

  try {
    const { response, mimeType, fullSize } = await downloadCorpFile(
      credentials.server, credentials.token, fileId, range,
    );
    if (mediaFormat === ApiMediaFormat.Progressive) {
      const arrayBuffer = await response.arrayBuffer();
      return {
        dataBlob: '', arrayBuffer, mimeType, fullSize,
      };
    }

    const blob = await readWithProgress(response, mimeType, fullSize, onProgress);
    if (!blob) return undefined;
    servedUrls.add(url);

    return buildResult(blob, mediaFormat, mimeType, fullSize);
  } catch (err) {
    corpEngine.handleFailure(err);
    return undefined;
  }
}

export function clearCorpMedia() {
  servedUrls.forEach((url) => {
    void mediaLoader.unload(url);
  });
  servedUrls.clear();
}

// Telegram stickers and GIFs are sent to corp chats as files: their bytes come from the regular media loader
export async function fetchMediaBlob(mediaHash: string) {
  const blobUrl = await mediaLoader.fetch(mediaHash, ApiMediaFormat.BlobUrl);
  if (!blobUrl) return undefined;

  return (await fetch(blobUrl)).blob();
}

async function readWithProgress(
  response: Response, mimeType: string, fullSize: number | undefined, onProgress?: ApiOnProgress,
) {
  if (!onProgress || !fullSize || !response.body) return response.blob();

  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (onProgress.isCanceled) {
      void reader.cancel();
      return undefined;
    }
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded / fullSize);
  }

  return new Blob(chunks, { type: mimeType });
}

async function buildResult(blob: Blob, mediaFormat: ApiMediaFormat, mimeType: string, fullSize?: number) {
  switch (mediaFormat) {
    case ApiMediaFormat.Text:
      return {
        dataBlob: await blob.text(), arrayBuffer: undefined, mimeType, fullSize,
      };
    case ApiMediaFormat.Progressive:
    case ApiMediaFormat.DownloadUrl:
      return {
        dataBlob: '', arrayBuffer: await blob.arrayBuffer(), mimeType, fullSize,
      };
    default:
      return {
        dataBlob: blob, arrayBuffer: undefined, mimeType, fullSize,
      };
  }
}
