import React from 'react';
import { FONT_OPTIONS } from '../lib/fonts';
import type { MintLayer } from '../lib/types';

type Props = {
  layer: MintLayer;
  onConfigChange: (patch: Record<string, unknown>) => void;
};

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="control-row">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="small" style={{ minWidth: 36, textAlign: 'right' }}>
        {value}
      </span>
    </label>
  );
}

function ColorRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="control-row">
      <span>{label}</span>
      <input
        type="color"
        value={value.startsWith('#') ? value : '#ffffff'}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function TextRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="control-row">
      <span>{label}</span>
      <input type="text" value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function GuillocheControls({ layer, onConfigChange }: Props) {
  const c = layer.config as MintLayer & { type: 'guilloche' } extends { config: infer C } ? C : never;
  return (
    <>
      <SliderRow
        label="Waves"
        value={c.waves}
        min={2}
        max={5}
        step={1}
        onChange={(v) => onConfigChange({ waves: v })}
      />
      <SliderRow
        label="Frequency"
        value={c.frequency}
        min={1}
        max={20}
        step={0.5}
        onChange={(v) => onConfigChange({ frequency: v })}
      />
      <SliderRow
        label="Amplitude"
        value={c.amplitude}
        min={10}
        max={200}
        step={5}
        onChange={(v) => onConfigChange({ amplitude: v })}
      />
      <SliderRow
        label="Lines"
        value={c.lines}
        min={5}
        max={80}
        step={1}
        onChange={(v) => onConfigChange({ lines: v })}
      />
      <SliderRow
        label="Stroke"
        value={c.strokeWidth}
        min={0.3}
        max={3}
        step={0.1}
        onChange={(v) => onConfigChange({ strokeWidth: v })}
      />
      <SliderRow
        label="Phase"
        value={c.phase}
        min={0}
        max={360}
        step={5}
        onChange={(v) => onConfigChange({ phase: v })}
      />
      <SliderRow
        label="Damping"
        value={c.damping}
        min={0}
        max={1}
        step={0.05}
        onChange={(v) => onConfigChange({ damping: v })}
      />
      <ColorRow label="Color" value={c.color} onChange={(v) => onConfigChange({ color: v })} />
    </>
  );
}

function RosetteControls({ layer, onConfigChange }: Props) {
  const c = layer.config as {
    petals: number;
    rings: number;
    radius: number;
    strokeWidth: number;
    color: string;
    rotation: number;
    innerRadius: number;
  };
  return (
    <>
      <SliderRow
        label="Petals"
        value={c.petals}
        min={4}
        max={24}
        step={1}
        onChange={(v) => onConfigChange({ petals: v })}
      />
      <SliderRow
        label="Rings"
        value={c.rings}
        min={3}
        max={20}
        step={1}
        onChange={(v) => onConfigChange({ rings: v })}
      />
      <SliderRow
        label="Radius"
        value={c.radius}
        min={0.1}
        max={0.5}
        step={0.01}
        onChange={(v) => onConfigChange({ radius: v })}
      />
      <SliderRow
        label="Inner R"
        value={c.innerRadius}
        min={0.1}
        max={0.9}
        step={0.05}
        onChange={(v) => onConfigChange({ innerRadius: v })}
      />
      <SliderRow
        label="Stroke"
        value={c.strokeWidth}
        min={0.2}
        max={3}
        step={0.1}
        onChange={(v) => onConfigChange({ strokeWidth: v })}
      />
      <SliderRow
        label="Rotation"
        value={c.rotation}
        min={0}
        max={360}
        step={5}
        onChange={(v) => onConfigChange({ rotation: v })}
      />
      <ColorRow label="Color" value={c.color} onChange={(v) => onConfigChange({ color: v })} />
    </>
  );
}

function FineLineControls({ layer, onConfigChange }: Props) {
  const c = layer.config as {
    angle: number;
    spacing: number;
    strokeWidth: number;
    color: string;
    wave: boolean;
    waveAmplitude: number;
    waveFrequency: number;
  };
  return (
    <>
      <SliderRow
        label="Angle"
        value={c.angle}
        min={0}
        max={180}
        step={5}
        onChange={(v) => onConfigChange({ angle: v })}
      />
      <SliderRow
        label="Spacing"
        value={c.spacing}
        min={2}
        max={20}
        step={0.5}
        onChange={(v) => onConfigChange({ spacing: v })}
      />
      <SliderRow
        label="Stroke"
        value={c.strokeWidth}
        min={0.2}
        max={2}
        step={0.1}
        onChange={(v) => onConfigChange({ strokeWidth: v })}
      />
      <label className="control-row">
        <span>Wavy</span>
        <input type="checkbox" checked={c.wave} onChange={(e) => onConfigChange({ wave: e.target.checked })} />
      </label>
      {c.wave && (
        <>
          <SliderRow
            label="Wave Amp"
            value={c.waveAmplitude}
            min={1}
            max={20}
            step={0.5}
            onChange={(v) => onConfigChange({ waveAmplitude: v })}
          />
          <SliderRow
            label="Wave Freq"
            value={c.waveFrequency}
            min={1}
            max={20}
            step={0.5}
            onChange={(v) => onConfigChange({ waveFrequency: v })}
          />
        </>
      )}
      <ColorRow label="Color" value={c.color} onChange={(v) => onConfigChange({ color: v })} />
    </>
  );
}

function BorderControls({ layer, onConfigChange }: Props) {
  const c = layer.config as {
    style: string;
    thickness: number;
    color: string;
    cornerStyle: string;
    innerBorder: boolean;
    innerGap: number;
  };
  return (
    <>
      <label className="control-row">
        <span>Style</span>
        <select value={c.style} onChange={(e) => onConfigChange({ style: e.target.value })}>
          <option value="classic">Classic</option>
          <option value="ornate">Ornate</option>
          <option value="geometric">Geometric</option>
          <option value="art-deco">Art Deco</option>
        </select>
      </label>
      <SliderRow
        label="Thickness"
        value={c.thickness}
        min={20}
        max={100}
        step={2}
        onChange={(v) => onConfigChange({ thickness: v })}
      />
      <label className="control-row">
        <span>Corners</span>
        <select value={c.cornerStyle} onChange={(e) => onConfigChange({ cornerStyle: e.target.value })}>
          <option value="square">Square</option>
          <option value="rounded">Rounded</option>
          <option value="ornament">Ornament</option>
        </select>
      </label>
      <label className="control-row">
        <span>Inner Border</span>
        <input
          type="checkbox"
          checked={c.innerBorder}
          onChange={(e) => onConfigChange({ innerBorder: e.target.checked })}
        />
      </label>
      {c.innerBorder && (
        <SliderRow
          label="Inner Gap"
          value={c.innerGap}
          min={2}
          max={30}
          step={1}
          onChange={(v) => onConfigChange({ innerGap: v })}
        />
      )}
      <ColorRow label="Color" value={c.color} onChange={(v) => onConfigChange({ color: v })} />
    </>
  );
}

function MicroprintControls({ layer, onConfigChange }: Props) {
  const c = layer.config as {
    text: string;
    fontSize: number;
    color: string;
    rows: number;
    angle: number;
    spacing: number;
  };
  return (
    <>
      <TextRow label="Text" value={c.text} onChange={(v) => onConfigChange({ text: v })} />
      <SliderRow
        label="Font Size"
        value={c.fontSize}
        min={2}
        max={6}
        step={0.5}
        onChange={(v) => onConfigChange({ fontSize: v })}
      />
      <SliderRow label="Rows" value={c.rows} min={3} max={40} step={1} onChange={(v) => onConfigChange({ rows: v })} />
      <SliderRow
        label="Angle"
        value={c.angle}
        min={0}
        max={360}
        step={5}
        onChange={(v) => onConfigChange({ angle: v })}
      />
      <SliderRow
        label="Spacing"
        value={c.spacing}
        min={3}
        max={20}
        step={0.5}
        onChange={(v) => onConfigChange({ spacing: v })}
      />
      <ColorRow label="Color" value={c.color} onChange={(v) => onConfigChange({ color: v })} />
    </>
  );
}

function TextControls({ layer, onConfigChange }: Props) {
  const c = layer.config as {
    text: string;
    fontFamily: string;
    fontSize: number;
    fontWeight: number;
    color: string;
    letterSpacing: number;
    align: string;
    x: number;
    y: number;
  };
  return (
    <>
      <TextRow label="Text" value={c.text} onChange={(v) => onConfigChange({ text: v })} />
      <label className="control-row">
        <span>Font</span>
        <select value={c.fontFamily} onChange={(e) => onConfigChange({ fontFamily: e.target.value })}>
          {FONT_OPTIONS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </label>
      <SliderRow
        label="Size"
        value={c.fontSize}
        min={12}
        max={200}
        step={2}
        onChange={(v) => onConfigChange({ fontSize: v })}
      />
      <SliderRow
        label="Weight"
        value={c.fontWeight}
        min={100}
        max={900}
        step={100}
        onChange={(v) => onConfigChange({ fontWeight: v })}
      />
      <SliderRow
        label="Spacing"
        value={c.letterSpacing}
        min={0}
        max={30}
        step={1}
        onChange={(v) => onConfigChange({ letterSpacing: v })}
      />
      <label className="control-row">
        <span>Align</span>
        <select value={c.align} onChange={(e) => onConfigChange({ align: e.target.value })}>
          <option value="left">Left</option>
          <option value="center">Center</option>
          <option value="right">Right</option>
        </select>
      </label>
      <SliderRow label="X Pos" value={c.x} min={0} max={1} step={0.01} onChange={(v) => onConfigChange({ x: v })} />
      <SliderRow label="Y Pos" value={c.y} min={0} max={1} step={0.01} onChange={(v) => onConfigChange({ y: v })} />
      <ColorRow label="Color" value={c.color} onChange={(v) => onConfigChange({ color: v })} />
    </>
  );
}

function ImageControls({ layer, onConfigChange }: Props) {
  const c = layer.config as { src: string; fit: string; x: number; y: number; scale: number };

  // Read as a data URL so the picture survives in saved drafts and the SVG export.
  const handlePickImage = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => onConfigChange({ src: String(reader.result) });
      reader.readAsDataURL(file);
    };
    input.click();
  };

  return (
    <>
      <div className="control-row">
        <button className="secondary" onClick={handlePickImage}>
          {c.src ? 'Change Image' : 'Choose Image'}
        </button>
      </div>
      <label className="control-row">
        <span>Fit</span>
        <select value={c.fit} onChange={(e) => onConfigChange({ fit: e.target.value })}>
          <option value="contain">Contain</option>
          <option value="cover">Cover</option>
          <option value="fill">Fill</option>
        </select>
      </label>
      <SliderRow label="X Pos" value={c.x} min={0} max={1} step={0.01} onChange={(v) => onConfigChange({ x: v })} />
      <SliderRow label="Y Pos" value={c.y} min={0} max={1} step={0.01} onChange={(v) => onConfigChange({ y: v })} />
      <SliderRow
        label="Scale"
        value={c.scale}
        min={0.1}
        max={3}
        step={0.05}
        onChange={(v) => onConfigChange({ scale: v })}
      />
    </>
  );
}

function SerialNumberControls({ layer, onConfigChange }: Props) {
  const c = layer.config as {
    prefix: string;
    startNumber: number;
    digits: number;
    fontFamily: string;
    fontSize: number;
    color: string;
    letterSpacing: number;
    x: number;
    y: number;
  };
  return (
    <>
      <TextRow label="Prefix" value={c.prefix} onChange={(v) => onConfigChange({ prefix: v })} />
      <label className="control-row">
        <span>Start #</span>
        <input
          type="number"
          value={c.startNumber}
          min={0}
          step={1}
          onChange={(e) => onConfigChange({ startNumber: Number(e.target.value) })}
          style={{ width: 80 }}
        />
      </label>
      <SliderRow
        label="Digits"
        value={c.digits}
        min={1}
        max={10}
        step={1}
        onChange={(v) => onConfigChange({ digits: v })}
      />
      <label className="control-row">
        <span>Font</span>
        <select value={c.fontFamily} onChange={(e) => onConfigChange({ fontFamily: e.target.value })}>
          {FONT_OPTIONS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </label>
      <SliderRow
        label="Size"
        value={c.fontSize}
        min={8}
        max={72}
        step={2}
        onChange={(v) => onConfigChange({ fontSize: v })}
      />
      <SliderRow
        label="Spacing"
        value={c.letterSpacing}
        min={0}
        max={20}
        step={1}
        onChange={(v) => onConfigChange({ letterSpacing: v })}
      />
      <SliderRow label="X Pos" value={c.x} min={0} max={1} step={0.01} onChange={(v) => onConfigChange({ x: v })} />
      <SliderRow label="Y Pos" value={c.y} min={0} max={1} step={0.01} onChange={(v) => onConfigChange({ y: v })} />
      <ColorRow label="Color" value={c.color} onChange={(v) => onConfigChange({ color: v })} />
    </>
  );
}

function ThreadControls({ layer, onConfigChange }: Props) {
  const c = layer.config as {
    x: number;
    width: number;
    color: string;
    text: string;
    textColor: string;
    dashed: boolean;
    dashLength: number;
    gapLength: number;
  };
  return (
    <>
      <SliderRow label="X Pos" value={c.x} min={0} max={1} step={0.01} onChange={(v) => onConfigChange({ x: v })} />
      <SliderRow
        label="Width"
        value={c.width}
        min={1}
        max={20}
        step={0.5}
        onChange={(v) => onConfigChange({ width: v })}
      />
      <TextRow label="Text" value={c.text} onChange={(v) => onConfigChange({ text: v })} />
      <label className="control-row">
        <span>Dashed</span>
        <input type="checkbox" checked={c.dashed} onChange={(e) => onConfigChange({ dashed: e.target.checked })} />
      </label>
      {c.dashed && (
        <>
          <SliderRow
            label="Dash"
            value={c.dashLength}
            min={5}
            max={80}
            step={5}
            onChange={(v) => onConfigChange({ dashLength: v })}
          />
          <SliderRow
            label="Gap"
            value={c.gapLength}
            min={5}
            max={80}
            step={5}
            onChange={(v) => onConfigChange({ gapLength: v })}
          />
        </>
      )}
      <ColorRow label="Color" value={c.color} onChange={(v) => onConfigChange({ color: v })} />
      <ColorRow label="Text Color" value={c.textColor} onChange={(v) => onConfigChange({ textColor: v })} />
    </>
  );
}

function LatheControls({ layer, onConfigChange }: Props) {
  const c = layer.config as {
    lineCount: number;
    strokeWidth: number;
    color: string;
    centerX: number;
    centerY: number;
    scale: number;
    rotation: number;
  };
  return (
    <>
      <SliderRow
        label="Lines"
        value={c.lineCount}
        min={10}
        max={200}
        step={5}
        onChange={(v) => onConfigChange({ lineCount: v })}
      />
      <SliderRow
        label="Stroke"
        value={c.strokeWidth}
        min={0.1}
        max={2}
        step={0.1}
        onChange={(v) => onConfigChange({ strokeWidth: v })}
      />
      <SliderRow
        label="Center X"
        value={c.centerX}
        min={0}
        max={1}
        step={0.01}
        onChange={(v) => onConfigChange({ centerX: v })}
      />
      <SliderRow
        label="Center Y"
        value={c.centerY}
        min={0}
        max={1}
        step={0.01}
        onChange={(v) => onConfigChange({ centerY: v })}
      />
      <SliderRow
        label="Scale"
        value={c.scale}
        min={0.3}
        max={3}
        step={0.1}
        onChange={(v) => onConfigChange({ scale: v })}
      />
      <SliderRow
        label="Rotation"
        value={c.rotation}
        min={0}
        max={360}
        step={5}
        onChange={(v) => onConfigChange({ rotation: v })}
      />
      <ColorRow label="Color" value={c.color} onChange={(v) => onConfigChange({ color: v })} />
    </>
  );
}

function GradientControls({ layer, onConfigChange }: Props) {
  const c = layer.config as { type: string; colors: string[]; angle: number; opacity: number };

  const updateColor = (index: number, value: string) => {
    const colors = [...c.colors];
    colors[index] = value;
    onConfigChange({ colors });
  };

  const addStop = () => {
    onConfigChange({ colors: [...c.colors, '#000000'] });
  };

  const removeStop = (index: number) => {
    if (c.colors.length <= 2) return;
    const colors = c.colors.filter((_, i) => i !== index);
    onConfigChange({ colors });
  };

  return (
    <>
      <label className="control-row">
        <span>Type</span>
        <select value={c.type} onChange={(e) => onConfigChange({ type: e.target.value })}>
          <option value="linear">Linear</option>
          <option value="radial">Radial</option>
        </select>
      </label>
      {c.type === 'linear' && (
        <SliderRow
          label="Angle"
          value={c.angle}
          min={0}
          max={360}
          step={5}
          onChange={(v) => onConfigChange({ angle: v })}
        />
      )}
      <SliderRow
        label="Opacity"
        value={c.opacity}
        min={0}
        max={1}
        step={0.05}
        onChange={(v) => onConfigChange({ opacity: v })}
      />
      <div className="control-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
        <span style={{ fontSize: 12 }}>Color Stops</span>
        {c.colors.map((color, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="color"
              value={color.startsWith('#') ? color : '#000000'}
              onChange={(e) => updateColor(i, e.target.value)}
            />
            <span className="small" style={{ flex: 1 }}>
              Stop {i + 1}
            </span>
            {c.colors.length > 2 && (
              <button className="ghost" style={{ fontSize: 10, padding: '2px 6px' }} onClick={() => removeStop(i)}>
                x
              </button>
            )}
          </div>
        ))}
        <button className="ghost" style={{ fontSize: 11 }} onClick={addStop}>
          + Add Stop
        </button>
      </div>
    </>
  );
}

function QRCodeControls({ layer, onConfigChange }: Props) {
  const c = layer.config as {
    text: string;
    size: number;
    x: number;
    y: number;
    color: string;
    backgroundColor: string;
  };
  return (
    <>
      <TextRow label="Text" value={c.text} onChange={(v) => onConfigChange({ text: v })} />
      <SliderRow
        label="Size"
        value={c.size}
        min={0.05}
        max={0.5}
        step={0.01}
        onChange={(v) => onConfigChange({ size: v })}
      />
      <SliderRow label="X Pos" value={c.x} min={0} max={1} step={0.01} onChange={(v) => onConfigChange({ x: v })} />
      <SliderRow label="Y Pos" value={c.y} min={0} max={1} step={0.01} onChange={(v) => onConfigChange({ y: v })} />
      <ColorRow label="Color" value={c.color} onChange={(v) => onConfigChange({ color: v })} />
      <ColorRow label="Background" value={c.backgroundColor} onChange={(v) => onConfigChange({ backgroundColor: v })} />
    </>
  );
}

function TextArcControls({ layer, onConfigChange }: Props) {
  const c = layer.config as {
    text: string;
    fontFamily: string;
    fontSize: number;
    fontWeight: number;
    color: string;
    letterSpacing: number;
    radius: number;
    startAngle: number;
    centerX: number;
    centerY: number;
    flipText: boolean;
  };
  return (
    <>
      <TextRow label="Text" value={c.text} onChange={(v) => onConfigChange({ text: v })} />
      <label className="control-row">
        <span>Font</span>
        <select value={c.fontFamily} onChange={(e) => onConfigChange({ fontFamily: e.target.value })}>
          {FONT_OPTIONS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </label>
      <SliderRow
        label="Size"
        value={c.fontSize}
        min={8}
        max={72}
        step={2}
        onChange={(v) => onConfigChange({ fontSize: v })}
      />
      <SliderRow
        label="Weight"
        value={c.fontWeight}
        min={100}
        max={900}
        step={100}
        onChange={(v) => onConfigChange({ fontWeight: v })}
      />
      <SliderRow
        label="Spacing"
        value={c.letterSpacing}
        min={0}
        max={20}
        step={1}
        onChange={(v) => onConfigChange({ letterSpacing: v })}
      />
      <SliderRow
        label="Radius"
        value={c.radius}
        min={0.1}
        max={0.5}
        step={0.01}
        onChange={(v) => onConfigChange({ radius: v })}
      />
      <SliderRow
        label="Start Angle"
        value={c.startAngle}
        min={-180}
        max={180}
        step={5}
        onChange={(v) => onConfigChange({ startAngle: v })}
      />
      <SliderRow
        label="Center X"
        value={c.centerX}
        min={0}
        max={1}
        step={0.01}
        onChange={(v) => onConfigChange({ centerX: v })}
      />
      <SliderRow
        label="Center Y"
        value={c.centerY}
        min={0}
        max={1}
        step={0.01}
        onChange={(v) => onConfigChange({ centerY: v })}
      />
      <label className="control-row">
        <span>Flip</span>
        <input type="checkbox" checked={c.flipText} onChange={(e) => onConfigChange({ flipText: e.target.checked })} />
      </label>
      <ColorRow label="Color" value={c.color} onChange={(v) => onConfigChange({ color: v })} />
    </>
  );
}

function MoireControls({ layer, onConfigChange }: Props) {
  const c = layer.config as { angle1: number; angle2: number; spacing: number; strokeWidth: number; color: string };
  return (
    <>
      <SliderRow
        label="Angle 1"
        value={c.angle1}
        min={0}
        max={180}
        step={1}
        onChange={(v) => onConfigChange({ angle1: v })}
      />
      <SliderRow
        label="Angle 2"
        value={c.angle2}
        min={0}
        max={180}
        step={1}
        onChange={(v) => onConfigChange({ angle2: v })}
      />
      <SliderRow
        label="Spacing"
        value={c.spacing}
        min={2}
        max={20}
        step={0.5}
        onChange={(v) => onConfigChange({ spacing: v })}
      />
      <SliderRow
        label="Stroke"
        value={c.strokeWidth}
        min={0.1}
        max={2}
        step={0.1}
        onChange={(v) => onConfigChange({ strokeWidth: v })}
      />
      <ColorRow label="Color" value={c.color} onChange={(v) => onConfigChange({ color: v })} />
    </>
  );
}

function CrosshatchControls({ layer, onConfigChange }: Props) {
  const c = layer.config as { angle: number; spacing: number; strokeWidth: number; color: string; sets: number };
  return (
    <>
      <SliderRow
        label="Angle"
        value={c.angle}
        min={0}
        max={180}
        step={5}
        onChange={(v) => onConfigChange({ angle: v })}
      />
      <SliderRow
        label="Spacing"
        value={c.spacing}
        min={2}
        max={20}
        step={0.5}
        onChange={(v) => onConfigChange({ spacing: v })}
      />
      <SliderRow
        label="Stroke"
        value={c.strokeWidth}
        min={0.1}
        max={2}
        step={0.1}
        onChange={(v) => onConfigChange({ strokeWidth: v })}
      />
      <SliderRow label="Sets" value={c.sets} min={2} max={4} step={1} onChange={(v) => onConfigChange({ sets: v })} />
      <ColorRow label="Color" value={c.color} onChange={(v) => onConfigChange({ color: v })} />
    </>
  );
}

function StippleControls({ layer, onConfigChange }: Props) {
  const c = layer.config as { density: number; dotSize: number; color: string; pattern: string; seed: number };
  return (
    <>
      <SliderRow
        label="Density"
        value={c.density}
        min={10}
        max={1000}
        step={10}
        onChange={(v) => onConfigChange({ density: v })}
      />
      <SliderRow
        label="Dot Size"
        value={c.dotSize}
        min={0.2}
        max={5}
        step={0.1}
        onChange={(v) => onConfigChange({ dotSize: v })}
      />
      <label className="control-row">
        <span>Pattern</span>
        <select value={c.pattern} onChange={(e) => onConfigChange({ pattern: e.target.value })}>
          <option value="random">Random</option>
          <option value="halftone">Halftone</option>
          <option value="noise">Noise</option>
        </select>
      </label>
      <SliderRow label="Seed" value={c.seed} min={1} max={999} step={1} onChange={(v) => onConfigChange({ seed: v })} />
      <ColorRow label="Color" value={c.color} onChange={(v) => onConfigChange({ color: v })} />
    </>
  );
}

function WatermarkPatternControls({ layer, onConfigChange }: Props) {
  const c = layer.config as {
    text: string;
    fontFamily: string;
    fontSize: number;
    color: string;
    angle: number;
    spacingX: number;
    spacingY: number;
  };
  return (
    <>
      <TextRow label="Text" value={c.text} onChange={(v) => onConfigChange({ text: v })} />
      <label className="control-row">
        <span>Font</span>
        <select value={c.fontFamily} onChange={(e) => onConfigChange({ fontFamily: e.target.value })}>
          {FONT_OPTIONS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </label>
      <SliderRow
        label="Size"
        value={c.fontSize}
        min={8}
        max={48}
        step={2}
        onChange={(v) => onConfigChange({ fontSize: v })}
      />
      <SliderRow
        label="Angle"
        value={c.angle}
        min={-90}
        max={90}
        step={5}
        onChange={(v) => onConfigChange({ angle: v })}
      />
      <SliderRow
        label="Space X"
        value={c.spacingX}
        min={50}
        max={500}
        step={10}
        onChange={(v) => onConfigChange({ spacingX: v })}
      />
      <SliderRow
        label="Space Y"
        value={c.spacingY}
        min={20}
        max={200}
        step={5}
        onChange={(v) => onConfigChange({ spacingY: v })}
      />
      <ColorRow label="Color" value={c.color} onChange={(v) => onConfigChange({ color: v })} />
    </>
  );
}

function HologramControls({ layer, onConfigChange }: Props) {
  const c = layer.config as {
    colors: string[];
    angle: number;
    stripWidth: number;
    shimmer: number;
    x: number;
    y: number;
    width: number;
    height: number;
  };

  const updateColor = (index: number, value: string) => {
    const colors = [...c.colors];
    colors[index] = value;
    onConfigChange({ colors });
  };

  return (
    <>
      <SliderRow label="X Pos" value={c.x} min={0} max={1} step={0.01} onChange={(v) => onConfigChange({ x: v })} />
      <SliderRow label="Y Pos" value={c.y} min={0} max={1} step={0.01} onChange={(v) => onConfigChange({ y: v })} />
      <SliderRow
        label="Width"
        value={c.width}
        min={0.05}
        max={1}
        step={0.01}
        onChange={(v) => onConfigChange({ width: v })}
      />
      <SliderRow
        label="Height"
        value={c.height}
        min={0.05}
        max={1}
        step={0.01}
        onChange={(v) => onConfigChange({ height: v })}
      />
      <SliderRow
        label="Angle"
        value={c.angle}
        min={0}
        max={360}
        step={5}
        onChange={(v) => onConfigChange({ angle: v })}
      />
      <SliderRow
        label="Strip W"
        value={c.stripWidth}
        min={2}
        max={30}
        step={1}
        onChange={(v) => onConfigChange({ stripWidth: v })}
      />
      <SliderRow
        label="Shimmer"
        value={c.shimmer}
        min={0}
        max={1}
        step={0.05}
        onChange={(v) => onConfigChange({ shimmer: v })}
      />
      <div className="control-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
        <span style={{ fontSize: 12 }}>Colors</span>
        {c.colors.map((color, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="color"
              value={color.startsWith('#') ? color : '#ff0080'}
              onChange={(e) => updateColor(i, e.target.value)}
            />
            <span className="small" style={{ flex: 1 }}>
              Color {i + 1}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

const CONTROLS: Record<string, React.FC<Props>> = {
  guilloche: GuillocheControls,
  rosette: RosetteControls,
  'fine-line': FineLineControls,
  border: BorderControls,
  microprint: MicroprintControls,
  text: TextControls,
  image: ImageControls,
  'serial-number': SerialNumberControls,
  thread: ThreadControls,
  lathe: LatheControls,
  gradient: GradientControls,
  'qr-code': QRCodeControls,
  'text-arc': TextArcControls,
  moire: MoireControls,
  crosshatch: CrosshatchControls,
  stipple: StippleControls,
  'watermark-pattern': WatermarkPatternControls,
  hologram: HologramControls,
};

export default function PatternControls({ layer, onConfigChange }: Props) {
  const Control = CONTROLS[layer.type];
  if (!Control) return <div className="small">No controls for this layer type.</div>;
  return <Control layer={layer} onConfigChange={onConfigChange} />;
}
