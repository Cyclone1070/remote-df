import React from 'react';

export function StatusBadge({ visible, status }) {
    if (!visible) return null;

    let badgeColors = 'bg-amber-600 text-amber-50';
    let text = 'Connecting';

    if (status === 'connected') {
        badgeColors = 'bg-emerald-600 text-emerald-50';
        text = 'Connected';
    } else if (status === 'disconnected') {
        badgeColors = 'bg-rose-600 text-rose-50';
        text = 'Disconnected';
    }

    return (
        <div className={`absolute top-2 right-2 z-10 px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider select-none pointer-events-none ${badgeColors}`}>
            {text}
        </div>
    );
}
