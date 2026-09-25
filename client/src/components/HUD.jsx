import React from 'react';

export function HUD({ visible, transport, streamFps, renderFps, bandwidth, m2p, sprites, drawCalls }) {
    if (!visible) return null;

    return (
        <div className="absolute top-2 left-2 z-10 flex flex-wrap gap-3 max-w-[95vw] px-3 py-1.5 rounded bg-slate-900/75 backdrop-blur-sm border border-white/10 text-[11px] font-mono text-sky-400 select-none pointer-events-none">
            <div>Transport: <span className={transport && transport.startsWith('UDP') ? "text-emerald-400 font-bold" : "text-amber-400 font-bold"}>{transport || 'TCP'}</span></div>
            <div>Stream: <span className="text-slate-100 font-bold">{streamFps} fps</span></div>
            <div>Render: <span className="text-slate-100 font-bold">{renderFps} fps</span></div>
            <div>Bandwidth: <span className="text-slate-100 font-bold">{bandwidth} kbps</span></div>
            <div>M2P: <span className="text-slate-100 font-bold">{m2p}</span></div>
            <div>Sprites: <span className="text-slate-100 font-bold">{sprites} ({drawCalls} draw)</span></div>
        </div>
    );
}
