import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApprovalCard, Chip } from '../../../components/approval/ApprovalCard';
import { CARD } from '../../../components/approval/cardTheme';
import { MintHero } from '../../../components/approval/ApprovalHeroes';
import { useServiceContext } from '../../../hooks/useServiceContext';
import { fetchExchangeRate } from '../../../utils/wallet';
import { money } from '../../money/money';
import {
  BLOCKED_MESSAGE,
  blockedText,
  buildMap,
  checkSize,
  estimateCost,
  fileToBase64,
  notifyMinted,
  wocTxUrl,
} from '../../mint/mint';
import { mintMedia } from '../../mint/mintMedia';
import { ART_TEMPLATES } from '../lib/artTemplates';
import { deleteDraft, listDrafts, newDraftId, saveDraft, type Draft } from '../lib/drafts';
import { embeddedFonts, loadFonts } from '../lib/fonts';
import { COLOR_SCHEMES, MINT_TEMPLATES, type ColorScheme } from '../lib/mint-defaults';
import { fileBase, noteMap, noteTitle } from '../lib/noteMint';
import { composeSvg } from '../lib/svg';
import type { MintBlendMode, MintLayerConfig } from '../lib/types';
import LayerList from './LayerList';
import MintCanvas from './MintCanvas';
import PatternControls from './PatternControls';
import { useMintDesigner } from './useMintDesigner';

/**
 * /m/bmint/notes: the Banknote designer (ported from bcorp-mint: useMintDesigner, patterns,
 * canvas, layers, pattern controls). Drafts stay on this device (IndexedDB). Export PNG / SVG as a
 * download. "Mint as NFT" renders the PNG and inscribes it through the wallet's own picture mint
 * (mint/mintMedia.ts) after ONE approval sheet. bMint holds no keys and broadcasts nothing itself.
 */

const LAYER_TYPES: { type: MintLayerConfig['type']; label: string; group: string }[] = [
  { type: 'guilloche', label: 'Guilloche', group: 'Patterns' },
  { type: 'rosette', label: 'Rosette', group: 'Patterns' },
  { type: 'fine-line', label: 'Fine lines', group: 'Patterns' },
  { type: 'moire', label: 'Moiré', group: 'Patterns' },
  { type: 'crosshatch', label: 'Crosshatch', group: 'Patterns' },
  { type: 'stipple', label: 'Stipple', group: 'Patterns' },
  { type: 'border', label: 'Border', group: 'Structure' },
  { type: 'microprint', label: 'Microprint', group: 'Structure' },
  { type: 'thread', label: 'Foil thread', group: 'Structure' },
  { type: 'serial-number', label: 'Serial', group: 'Structure' },
  { type: 'qr-code', label: 'QR code', group: 'Structure' },
  { type: 'text', label: 'Text', group: 'Content' },
  { type: 'text-arc', label: 'Text arc', group: 'Content' },
  { type: 'image', label: 'Image', group: 'Content' },
  { type: 'gradient', label: 'Gradient', group: 'Background' },
  { type: 'lathe', label: 'Lathe', group: 'Background' },
  { type: 'watermark-pattern', label: 'Watermark', group: 'Background' },
  { type: 'hologram', label: 'Hologram', group: 'Effects' },
];

const BLEND_MODES: { value: MintBlendMode; label: string }[] = [
  { value: 'source-over', label: 'Normal' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'screen', label: 'Screen' },
  { value: 'overlay', label: 'Overlay' },
  { value: 'soft-light', label: 'Soft light' },
];

type Panel = 'templates' | 'colours' | 'drafts' | null;

const download = (blob: Blob, name: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const dataUrlToBlob = async (dataUrl: string) => (await fetch(dataUrl)).blob();

/** A small JPEG of the design for the drafts list. */
const thumbOf = (pngDataUrl: string): Promise<string> =>
  new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = 160;
      c.height = Math.round((160 * img.naturalHeight) / img.naturalWidth) || 90;
      c.getContext('2d')?.drawImage(img, 0, 0, c.width, c.height);
      res(c.toDataURL('image/jpeg', 0.7));
    };
    img.onerror = () => res('');
    img.src = pngDataUrl;
  });

type MintState = { file: File; url: string; sats: { network: number; fee: number; total: number } };

export const NotesPage = () => {
  const d = useMintDesigner();
  const { doc, selectedLayer } = d;
  const { apiContext, chromeStorageService } = useServiceContext();
  const [panel, setPanel] = useState<Panel>('templates');
  const [template, setTemplate] = useState('default');
  const [showGrid, setShowGrid] = useState(false);
  const [animate, setAnimate] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok?: boolean } | null>(null);
  const [rate, setRate] = useState(0);
  const [mint, setMint] = useState<MintState | null>(null);
  const [minting, setMinting] = useState(false);
  const [mintError, setMintError] = useState('');
  const [txid, setTxid] = useState('');

  const { refreshAll } = d;
  useEffect(() => {
    void loadFonts().then(refreshAll);
    // Fonts load once; later documents re-render through the hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshDrafts = useCallback(() => {
    listDrafts()
      .then(setDrafts)
      .catch(() => setDrafts([]));
  }, []);
  useEffect(refreshDrafts, [refreshDrafts]);

  useEffect(() => {
    fetchExchangeRate('main')
      .then(setRate)
      .catch(() => setRate(0));
  }, []);

  const say = (text: string, ok?: boolean) => setMsg({ text, ok });

  const toggle = (p: Panel) => setPanel((cur) => (cur === p ? null : p));

  const loadTemplate = (id: string, factory: () => typeof doc) => {
    d.loadDocument(factory());
    setTemplate(id);
    setDraftId(null);
    say('');
  };

  const applyScheme = (s: ColorScheme) => {
    d.setBackgroundColor(s.background);
    for (const l of doc.layers) {
      if (l.type === 'border' || l.type === 'guilloche' || l.type === 'rosette')
        d.updateLayerConfig(l.id, { color: s.primary });
      else if (l.type === 'text' || l.type === 'text-arc' || l.type === 'serial-number')
        d.updateLayerConfig(l.id, { color: s.text });
      else if (l.type === 'microprint' || l.type === 'watermark-pattern')
        d.updateLayerConfig(l.id, { color: `${s.secondary}33` });
      else if (l.type === 'thread')
        d.updateLayerConfig(l.id, { color: `${s.secondary}33`, textColor: `${s.secondary}55` });
    }
  };

  const save = async () => {
    try {
      const png = d.exportPng();
      const id = draftId ?? newDraftId();
      await saveDraft({
        id,
        name: doc.name.trim() || 'Untitled note',
        updatedAt: Date.now(),
        template,
        doc,
        thumb: png ? await thumbOf(png) : undefined,
      });
      setDraftId(id);
      refreshDrafts();
      say('Saved on this device.', true);
    } catch {
      say("Couldn't save here (private window?). Export instead.");
    }
  };

  const exportPng = async () => {
    const png = d.exportPng();
    if (png) download(await dataUrlToBlob(png), `${fileBase(doc)}.png`);
  };
  const exportSvg = () =>
    download(new Blob([composeSvg(doc, embeddedFonts())], { type: 'image/svg+xml' }), `${fileBase(doc)}.svg`);

  const startMint = async () => {
    setMintError('');
    setTxid('');
    if (blockedText({ title: noteTitle(doc), description: doc.description, collection: { kind: 'none' } }))
      return say(BLOCKED_MESSAGE);
    const png = d.exportPng();
    if (!png) return;
    const blob = await dataUrlToBlob(png);
    const size = checkSize(blob.size);
    if (!size.ok) return say(size.message);
    const file = new File([blob], `${fileBase(doc)}.png`, { type: 'image/png' });
    const cost = estimateCost(blob.size, chromeStorageService.getCustomFeeRate(), rate);
    setMint({
      file,
      url: URL.createObjectURL(blob),
      sats: { network: cost.networkSats, fee: cost.feeSats, total: cost.totalSats },
    });
  };

  const closeMint = () => {
    if (minting) return;
    if (mint) URL.revokeObjectURL(mint.url);
    setMint(null);
  };

  const allow = async () => {
    if (!mint || !apiContext) return;
    setMinting(true);
    setMintError('');
    try {
      const title = noteTitle(doc);
      const form = { title, description: doc.description, collection: { kind: 'none' } as const };
      const res = await mintMedia(apiContext, {
        base64Content: fileToBase64(await mint.file.arrayBuffer()),
        contentType: 'image/png',
        title,
        description: doc.description,
        collection: form.collection,
        feeSats: mint.sats.fee,
        map: { ...buildMap(form), ...noteMap({ doc, template }) },
      });
      notifyMinted();
      setTxid(res.txid);
      URL.revokeObjectURL(mint.url);
      setMint(null);
      say('Minted. It shows in Wallet › NFTs once indexed.', true);
    } catch (e) {
      setMintError(e instanceof Error ? e.message : 'Mint failed. Nothing was sent.');
    } finally {
      setMinting(false);
    }
  };

  const t = selectedLayer?.transform ?? { x: 0, y: 0, rotation: 0, scale: 1 };
  const groups = useMemo(() => [...new Set(LAYER_TYPES.map((l) => l.group))], []);

  return (
    <div className="bm-body">
      <div className="bm-designer">
        <section className="bm-stage" aria-label="Banknote designer">
          <div className="bm-toolbar">
            <button type="button" className="ghost" onClick={d.undo} disabled={!d.canUndo}>
              Undo
            </button>
            <button type="button" className="ghost" onClick={d.redo} disabled={!d.canRedo}>
              Redo
            </button>
            <button type="button" className={`ghost${showGrid ? ' on' : ''}`} onClick={() => setShowGrid((v) => !v)}>
              Grid
            </button>
            <button
              type="button"
              className={`ghost${d.uvMode ? ' on' : ''}`}
              onClick={() => d.setUvMode(!d.uvMode)}
              title="Show UV-only layers"
            >
              UV
            </button>
            <button type="button" className={`ghost${animate ? ' on' : ''}`} onClick={() => setAnimate((v) => !v)}>
              Shimmer
            </button>
            <span className="spacer" />
            <button type="button" className="ghost" onClick={exportPng}>
              PNG
            </button>
            <button type="button" className="ghost" onClick={exportSvg}>
              SVG
            </button>
          </div>
          <MintCanvas
            doc={doc}
            renderToCanvas={d.renderToCanvas}
            onSelectLayer={d.selectLayer}
            selectedLayerId={d.selectedLayerId}
            showGrid={showGrid}
            animatePreview={animate}
          />
          <div className="bm-row" style={{ flexWrap: 'wrap' }}>
            <button type="button" className="bm-btn" onClick={save}>
              Save draft
            </button>
            <button type="button" className="bm-btn gold" onClick={startMint} disabled={!apiContext}>
              Mint as NFT
            </button>
          </div>
          {msg?.text && (
            <div className={`bm-msg${msg.ok ? ' ok' : ''}`} role="status">
              {msg.text}{' '}
              {txid && (
                <a href={wocTxUrl(txid)} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>
                  View transaction
                </a>
              )}
            </div>
          )}
        </section>

        <aside className="bm-panel" aria-label="Design controls">
          <div className="bm-card">
            <input
              type="text"
              className="bm-name"
              value={doc.name}
              placeholder="Name this note"
              aria-label="Note name"
              onChange={(e) => d.setDocMeta({ name: e.target.value })}
            />
            <textarea
              rows={2}
              value={doc.description}
              placeholder="Description (optional, inscribed with the NFT)"
              aria-label="Description"
              onChange={(e) => d.setDocMeta({ description: e.target.value })}
            />
            <div className="bm-row">
              <button
                type="button"
                className={`ghost${panel === 'templates' ? ' on' : ''}`}
                onClick={() => toggle('templates')}
              >
                Templates
              </button>
              <button
                type="button"
                className={`ghost${panel === 'colours' ? ' on' : ''}`}
                onClick={() => toggle('colours')}
              >
                Colours
              </button>
              <button
                type="button"
                className={`ghost${panel === 'drafts' ? ' on' : ''}`}
                onClick={() => toggle('drafts')}
              >
                Drafts{drafts.length ? ` (${drafts.length})` : ''}
              </button>
            </div>
          </div>

          {panel === 'templates' && (
            <div className="bm-card">
              <h3>Templates</h3>
              <div className="bm-templates">
                {MINT_TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.id}
                    type="button"
                    className={`bm-tpl${template === tpl.id ? ' on' : ''}`}
                    title={tpl.description}
                    onClick={() => loadTemplate(tpl.id, tpl.factory)}
                  >
                    <span className="bm-tpl-art">{tpl.name.split(' ')[0]}</span>
                    {tpl.name}
                  </button>
                ))}
                {ART_TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.id}
                    type="button"
                    className={`bm-tpl${template === tpl.id ? ' on' : ''}`}
                    onClick={() => loadTemplate(tpl.id, tpl.factory)}
                  >
                    <img src={tpl.thumb} alt="" loading="lazy" />
                    {tpl.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {panel === 'colours' && (
            <div className="bm-card">
              <h3>Colour schemes</h3>
              <div className="bm-schemes">
                {COLOR_SCHEMES.map((s) => (
                  <button key={s.name} type="button" className="bm-scheme" onClick={() => applyScheme(s)}>
                    <i style={{ background: `linear-gradient(135deg, ${s.primary}, ${s.secondary})` }} />
                    {s.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {panel === 'drafts' && (
            <div className="bm-card">
              <h3>Drafts on this device</h3>
              {drafts.length === 0 ? (
                <div className="small">No drafts yet. Save draft keeps the design here, never online.</div>
              ) : (
                <div className="bm-drafts">
                  {drafts.map((dr) => (
                    <div key={dr.id} className="bm-draft">
                      {dr.thumb ? <img src={dr.thumb} alt="" /> : null}
                      <button
                        type="button"
                        className="link"
                        onClick={() => {
                          d.loadDocument(dr.doc);
                          setTemplate(dr.template);
                          setDraftId(dr.id);
                        }}
                      >
                        {dr.name}
                        <div className="small">{new Date(dr.updatedAt).toLocaleString()}</div>
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        aria-label={`Delete ${dr.name}`}
                        onClick={() => {
                          void deleteDraft(dr.id).then(refreshDrafts);
                          if (draftId === dr.id) setDraftId(null);
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="bm-card">
            <h3>
              Layers ({doc.layers.length})
              <button type="button" className={`ghost${showAdd ? ' on' : ''}`} onClick={() => setShowAdd((v) => !v)}>
                + Add
              </button>
            </h3>
            {showAdd && (
              <div className="bm-add-menu">
                {groups.map((g) => [
                  <span key={g} className="label">
                    {g}
                  </span>,
                  ...LAYER_TYPES.filter((l) => l.group === g).map((l) => (
                    <button
                      key={l.type}
                      type="button"
                      className="ghost"
                      onClick={() => {
                        d.addLayer(l.type);
                        setShowAdd(false);
                      }}
                    >
                      {l.label}
                    </button>
                  )),
                ])}
              </div>
            )}
            <LayerList
              layers={doc.layers}
              selectedLayerId={d.selectedLayerId}
              getThumbnailSrc={d.getLayerThumbnailSrc}
              onSelect={d.selectLayer}
              onReorder={d.reorderLayer}
              onToggleVisible={(id) => {
                const l = doc.layers.find((x) => x.id === id);
                if (l) d.updateLayerMeta(id, { visible: !l.visible });
              }}
              onToggleLock={(id) => {
                const l = doc.layers.find((x) => x.id === id);
                if (l) d.updateLayerMeta(id, { locked: !l.locked });
              }}
              onRemove={d.removeLayer}
              onDuplicate={d.duplicateLayer}
            />
          </div>

          {selectedLayer && (
            <div className="bm-card">
              <h3>{selectedLayer.name}</h3>
              <div className="control-group">
                <label className="control-row">
                  <span>Name</span>
                  <input
                    type="text"
                    value={selectedLayer.name}
                    onChange={(e) => d.updateLayerMeta(selectedLayer.id, { name: e.target.value })}
                  />
                </label>
                <label className="control-row">
                  <span>Opacity</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={selectedLayer.opacity}
                    onChange={(e) => d.updateLayerMeta(selectedLayer.id, { opacity: Number(e.target.value) })}
                  />
                </label>
                <label className="control-row">
                  <span>Blend</span>
                  <select
                    value={selectedLayer.blendMode}
                    onChange={(e) =>
                      d.updateLayerMeta(selectedLayer.id, { blendMode: e.target.value as MintBlendMode })
                    }
                  >
                    {BLEND_MODES.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="control-row">
                  <span>UV only</span>
                  <input
                    type="checkbox"
                    checked={selectedLayer.uvOnly ?? false}
                    onChange={(e) => d.updateLayerMeta(selectedLayer.id, { uvOnly: e.target.checked })}
                  />
                </label>
                {(
                  [
                    ['X', 'x', -500, 500, 1],
                    ['Y', 'y', -500, 500, 1],
                    ['Rotate', 'rotation', -180, 180, 1],
                    ['Scale', 'scale', 0.1, 3, 0.05],
                  ] as const
                ).map(([label, key, min, max, step]) => (
                  <label key={key} className="control-row">
                    <span>{label}</span>
                    <input
                      type="range"
                      min={min}
                      max={max}
                      step={step}
                      value={t[key]}
                      onChange={(e) => d.updateLayerTransform(selectedLayer.id, { [key]: Number(e.target.value) })}
                    />
                  </label>
                ))}
              </div>
              <div className="control-group">
                <PatternControls
                  layer={selectedLayer}
                  onConfigChange={(patch) => d.updateLayerConfig(selectedLayer.id, patch)}
                />
              </div>
            </div>
          )}

          <div className="bm-card">
            <h3>Canvas</h3>
            <div className="control-group">
              <div className="bm-row">
                <label className="control-row">
                  <span>W</span>
                  <input
                    type="number"
                    min={100}
                    max={4000}
                    step={50}
                    value={doc.width}
                    onChange={(e) => d.setCanvasSize(Number(e.target.value), doc.height)}
                  />
                </label>
                <label className="control-row">
                  <span>H</span>
                  <input
                    type="number"
                    min={100}
                    max={4000}
                    step={50}
                    value={doc.height}
                    onChange={(e) => d.setCanvasSize(doc.width, Number(e.target.value))}
                  />
                </label>
              </div>
              <label className="control-row">
                <span>Background</span>
                <input
                  type="color"
                  value={doc.backgroundColor}
                  onChange={(e) => d.setBackgroundColor(e.target.value)}
                />
              </label>
              <label className="control-row">
                <span>Coin mask</span>
                <input
                  type="checkbox"
                  checked={doc.circleMask}
                  onChange={(e) => d.setDocMeta({ circleMask: e.target.checked })}
                />
              </label>
              {doc.circleMask && (
                <label className="control-row">
                  <span>Milled rim</span>
                  <input
                    type="checkbox"
                    checked={doc.rimPattern?.enabled ?? false}
                    onChange={(e) => d.setDocMeta({ rimPattern: { ...doc.rimPattern, enabled: e.target.checked } })}
                  />
                </label>
              )}
            </div>
          </div>
        </aside>
      </div>

      {mint &&
        createPortal(
          <div
            className="fixed inset-0 z-[420] flex flex-col"
            style={{
              background: CARD.bg,
              paddingTop: 'env(safe-area-inset-top)',
              paddingBottom: 'env(safe-area-inset-bottom)',
            }}
          >
            <ApprovalCard
              ours
              site="bWalletX"
              siteSub="bMint"
              onClose={closeMint}
              closeDisabled={minting}
              hero={<MintHero image={mint.url} alt={noteTitle(doc)} />}
              title={
                <>
                  Mint <span style={{ color: CARD.gold }}>{noteTitle(doc)}</span>
                </>
              }
              primary={{ label: 'Allow', onClick: () => void allow(), busy: minting, disabled: minting || !apiContext }}
              secondary={{ label: 'Not now', onClick: closeMint, disabled: minting }}
              error={mintError}
              testId="bmint-mint-sheet"
            >
              <div className="flex flex-wrap gap-2">
                <Chip>≈ {money(mint.sats.total, rate)}</Chip>
                <Chip>1 NFT</Chip>
                <Chip>
                  {doc.width}×{doc.height} PNG
                </Chip>
                <Chip>Locked to your wallet</Chip>
              </div>
            </ApprovalCard>
          </div>,
          document.body,
        )}
    </div>
  );
};

export default NotesPage;
