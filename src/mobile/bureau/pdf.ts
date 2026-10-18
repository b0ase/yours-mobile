import type { PDFDocumentProxy } from 'pdfjs-dist';

/**
 * pdf.js, loaded on first use only (its own chunk: nobody who never opens a PDF pays for it). Import these
 * functions, never `pdfjs-dist` directly. Ported from bChat desktop src/lib/pdf.ts.
 */
type PdfJs = typeof import('pdfjs-dist');
let cached: Promise<PdfJs> | null = null;

export const loadPdfJs = (): Promise<PdfJs> =>
  (cached ??= import('pdfjs-dist').then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
    return pdfjs;
  }));

/** Open from bytes (a copy: pdf.js detaches the buffer it is given). Keep `destroy` to release the worker. */
export const openPdf = async (bytes: Uint8Array): Promise<{ doc: PDFDocumentProxy; destroy: () => Promise<void> }> => {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes) });
  const doc = await task.promise;
  return { doc, destroy: () => task.destroy() };
};

export const renderPage = async (doc: PDFDocumentProxy, n: number, canvas: HTMLCanvasElement, cssWidth: number) => {
  const page = await doc.getPage(n);
  const viewport = page.getViewport({ scale: cssWidth / page.getViewport({ scale: 1 }).width });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
};
