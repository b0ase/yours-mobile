import { useEffect, useRef, useState } from 'react';
import type { DocContent } from './api';

const MAX_PAGES = 40;

/** Every page of a PDF at the pane's width (pdf.js loaded on first use). */
const PdfView = ({ bytes }: { bytes: Uint8Array }) => {
  const box = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'failed'>('loading');
  const [pages, setPages] = useState(0);
  useEffect(() => {
    let live = true;
    let release: (() => Promise<void>) | null = null;
    void (async () => {
      try {
        const { openPdf, renderPage } = await import('./pdf');
        const { doc, destroy } = await openPdf(bytes);
        release = destroy;
        if (!live || !box.current) return;
        const n = Math.min(doc.numPages, MAX_PAGES);
        setPages(doc.numPages);
        box.current.replaceChildren();
        const width = Math.max(280, Math.min(900, box.current.clientWidth - 24));
        for (let i = 1; i <= n && live; i++) {
          const c = document.createElement('canvas');
          c.className = 'bu-pdf-page';
          box.current.appendChild(c);
          await renderPage(doc, i, c, width);
        }
        if (live) setState('ok');
      } catch {
        if (live) setState('failed');
      }
    })();
    return () => {
      live = false;
      void release?.();
    };
  }, [bytes]);
  return (
    <div className="bu-pdf">
      {state === 'loading' && <p className="bu-note">Opening the PDF…</p>}
      {state === 'failed' && <p className="bu-note">This PDF could not be shown.</p>}
      {state === 'ok' && pages > MAX_PAGES && <p className="bu-note">Showing the first {MAX_PAGES} pages.</p>}
      <div ref={box} />
    </div>
  );
};

export const DocView = ({ content, title }: { content: DocContent; title: string }) => {
  switch (content.kind) {
    case 'pdf':
      return <PdfView bytes={content.bytes} />;
    case 'html':
      // No scripts, no same-origin: the document can show itself and nothing else.
      return <iframe className="bu-html" sandbox="" srcDoc={content.html} title={title} />;
    case 'image':
      return (
        <img
          className="bu-img"
          alt={title}
          src={URL.createObjectURL(new Blob([content.bytes as BlobPart], { type: content.mime }))}
        />
      );
    case 'text':
      return <pre className="bu-text">{content.text}</pre>;
    case 'encrypted':
      return <p className="bu-note">{content.reason} Opening those here is coming.</p>;
    case 'empty':
      return <p className="bu-note">{content.reason}</p>;
    case 'other':
      return <p className="bu-note">This file type ({content.mime}) can’t be shown here.</p>;
  }
};
