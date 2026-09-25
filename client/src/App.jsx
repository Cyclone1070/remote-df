import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { GameCanvas } from './components/GameCanvas.jsx';
import { HUD } from './components/HUD.jsx';
import { StatusBadge } from './components/StatusBadge.jsx';
import { MainMenu } from './components/MainMenu.jsx';
import { StreamToast } from './components/StreamToast.jsx';

function isStreamPath() {
    return typeof window !== 'undefined' && (window.location.pathname === '/df' || window.location.pathname === '/dwarf-fortress');
}

export function App() {
    const isDebug = useMemo(() => {
        const params = new URLSearchParams(window.location.search);
        return params.has('debug') || params.get('debug') === '1';
    }, []);

    const [view, setView] = useState(() => isStreamPath() ? 'stream' : 'menu');
    const [games, setGames] = useState([]);
    const [session, setSession] = useState({ state: 'idle' });
    const [isStarting, setIsStarting] = useState(false);
    const [isStopping, setIsStopping] = useState(false);

    const navigateToStream = useCallback(() => {
        if (window.location.pathname !== '/df') {
            window.history.pushState(null, '', '/df');
        }
        setView('stream');
    }, []);

    const [status, setStatus] = useState('connecting');
    const [transport, setTransport] = useState('TCP (WebSocket)');
    const [metrics, setMetrics] = useState({
        streamFps: 0,
        renderFps: 0,
        bandwidth: 0,
        m2p: '--',
        sprites: 0,
        drawCalls: 0
    });

    const fetchSession = useCallback(async () => {
        try {
            const res = await fetch('/api/session');
            if (res.ok) {
                const data = await res.json();
                setSession(data);
            }
        } catch {
            // Ignore offline errors
        }
    }, []);

    const fetchGames = useCallback(async () => {
        try {
            const res = await fetch('/api/games');
            if (res.ok) {
                const data = await res.json();
                setGames(data);
            }
        } catch {
            // Ignore offline errors
        }
    }, []);

    useEffect(() => {
        fetchGames();
        fetchSession();
        const timer = setInterval(fetchSession, 3000);

        const handlePopState = () => {
            setView(isStreamPath() ? 'stream' : 'menu');
        };
        window.addEventListener('popstate', handlePopState);

        return () => {
            clearInterval(timer);
            window.removeEventListener('popstate', handlePopState);
        };
    }, [fetchGames, fetchSession]);

    const handleLaunch = async (gameId) => {
        setIsStarting(true);
        try {
            const res = await fetch('/api/session/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ gameId })
            });
            if (res.ok) {
                const data = await res.json();
                setSession(data);
                // Allow process 500ms to spin up framebuffer & stream server
                setTimeout(() => {
                    setIsStarting(false);
                    navigateToStream();
                }, 600);
            } else {
                setIsStarting(false);
                alert('Failed to start game session');
            }
        } catch (err) {
            setIsStarting(false);
            alert(`Error starting game: ${err.message}`);
        }
    };

    const handleStop = async () => {
        setIsStopping(true);
        try {
            const res = await fetch('/api/session/stop', { method: 'POST' });
            if (res.ok) {
                const data = await res.json();
                setSession(data);
                if (window.location.pathname !== '/') {
                    window.history.pushState(null, '', '/');
                }
                setView('menu');
            }
        } catch (err) {
            alert(`Error stopping game: ${err.message}`);
        } finally {
            setIsStopping(false);
        }
    };

    const handleStatusChange = useCallback((newStatus) => {
        setStatus(newStatus);
    }, []);

    const handleMetricsUpdate = useCallback((newMetrics) => {
        setMetrics(newMetrics);
    }, []);

    if (view === 'menu') {
        return (
            <MainMenu
                games={games}
                session={session}
                onLaunch={handleLaunch}
                onStop={handleStop}
                onResume={navigateToStream}
                isStarting={isStarting}
                isStopping={isStopping}
            />
        );
    }

    return (
        <div id="canvas-container" className="relative w-full h-full overflow-hidden bg-black flex items-center justify-center">
            <StreamToast />

            <GameCanvas
                isDebug={isDebug}
                onStatusChange={handleStatusChange}
                onMetricsUpdate={handleMetricsUpdate}
                onTransportChange={setTransport}
            />
            <HUD
                visible={isDebug}
                transport={transport}
                streamFps={metrics.streamFps}
                renderFps={metrics.renderFps}
                bandwidth={metrics.bandwidth}
                m2p={metrics.m2p}
                sprites={metrics.sprites}
                drawCalls={metrics.drawCalls}
            />
            <StatusBadge
                visible={isDebug}
                status={status}
            />
        </div>
    );
}
