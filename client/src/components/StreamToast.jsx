import React, { useState, useEffect } from 'react';

export function StreamToast({ durationMs = 3500 }) {
    const [visible, setVisible] = useState(false);
    const [mounted, setMounted] = useState(true);

    useEffect(() => {
        // Trigger enter animation on mount
        const enterTimer = setTimeout(() => setVisible(true), 50);

        // Trigger exit animation
        const exitTimer = setTimeout(() => setVisible(false), durationMs);

        // Unmount after exit transition completes
        const unmountTimer = setTimeout(() => setMounted(false), durationMs + 600);

        return () => {
            clearTimeout(enterTimer);
            clearTimeout(exitTimer);
            clearTimeout(unmountTimer);
        };
    }, [durationMs]);

    if (!mounted) return null;

    return (
        <div
            className={`fixed top-4 left-1/2 -translate-x-1/2 z-50 pointer-events-none transition-all duration-500 ease-out transform ${
                visible
                    ? 'opacity-100 translate-y-0 scale-100'
                    : 'opacity-0 -translate-y-4 scale-95'
            }`}
            role="status"
            aria-live="polite"
        >
            <div className="flex items-center gap-2.5 px-4 py-2 bg-zinc-900/90 text-zinc-200 border border-zinc-700/60 rounded-full shadow-2xl backdrop-blur-md text-xs font-medium tracking-wide">
                <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                </span>
                <span>All inputs are captured and forwarded to the game.</span>
            </div>
        </div>
    );
}
