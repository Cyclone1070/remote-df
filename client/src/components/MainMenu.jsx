import React, { useState } from 'react';

const TAG_STYLES = {
    genre: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    subgenre: 'bg-zinc-800 text-zinc-300 border-zinc-700/60',
    default: 'bg-zinc-800/60 text-zinc-400 border-zinc-700/40',
};

export function MainMenu({ games = [], session, onLaunch, onStop, onResume, isStarting, isStopping }) {
    const isRunning = session && session.state === 'running';
    const [selectedGameId, setSelectedGameId] = useState(
        games.length > 0 ? games[0].id : 'dwarf-fortress'
    );

    const currentGame = games.find(g => g.id === selectedGameId) || games[0] || {
        id: 'dwarf-fortress',
        name: 'Dwarf Fortress',
        description: "The deepest, most intricate simulation of a world that's ever been created."
    };

    const isCurrentRunning = isRunning && session.gameId === currentGame.id;

    return (
        <div className="min-h-screen w-full bg-[#0c0d12] text-zinc-100 flex flex-col justify-between p-6 sm:p-12 select-none font-sans">
            {/* Top Bar: Minimal brand & session status */}
            <header className="max-w-4xl w-full mx-auto flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-zinc-800/90 border border-zinc-700/80 flex items-center justify-center text-zinc-300 shadow-sm">
                        <svg className="w-4 h-4 text-zinc-200" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="2" y="6" width="20" height="12" rx="6"></rect>
                            <line x1="6" y1="12" x2="10" y2="12"></line>
                            <line x1="8" y1="10" x2="8" y2="14"></line>
                            <line x1="15" y1="13" x2="15.01" y2="13"></line>
                            <line x1="18" y1="11" x2="18.01" y2="11"></line>
                        </svg>
                    </div>
                    <span className="font-bold tracking-tight text-sm text-zinc-200">Remote Play</span>
                </div>

                {isRunning ? (
                    <div className="flex items-center gap-2 px-3 py-1 bg-emerald-950/60 border border-emerald-700/50 rounded-full text-xs text-emerald-300 font-medium">
                        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                        <span>{session.gameName || 'Game'} running</span>
                    </div>
                ) : (
                    <div className="flex items-center gap-2 px-3 py-1 bg-zinc-900/90 border border-zinc-800 rounded-full text-xs text-zinc-400 font-medium">
                        <span className="w-2 h-2 rounded-full bg-zinc-500"></span>
                        <span>Idle</span>
                    </div>
                )}
            </header>

            {/* Main Center Stage: Hero Card */}
            <main className="max-w-4xl w-full mx-auto my-auto py-8">
                <div className="relative rounded-2xl bg-gradient-to-b from-zinc-900/90 to-zinc-950/90 border border-zinc-800/80 p-8 sm:p-12 shadow-2xl overflow-hidden">
                    {/* Subtle warm glow background accent */}
                    <div className="absolute top-0 right-0 w-80 h-80 bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />

                    <div className="relative z-10 max-w-xl">
                        {/* Dynamic Tags */}
                        {currentGame.tags && currentGame.tags.length > 0 && (
                            <div className="flex items-center gap-2 mb-4 flex-wrap">
                                {currentGame.tags.map((tag) => {
                                    const style = TAG_STYLES[tag.level] || TAG_STYLES.default;
                                    return (
                                        <span
                                            key={tag.name}
                                            className={`text-[10px] font-bold uppercase tracking-wider px-2.5 py-0.5 rounded border ${style}`}
                                        >
                                            {tag.name}
                                        </span>
                                    );
                                })}
                            </div>
                        )}

                        <h1 className="text-4xl sm:text-5xl font-black text-white tracking-tight mb-4">
                            {currentGame.name}
                        </h1>

                        <p className="text-base text-zinc-400 leading-relaxed mb-8">
                            {currentGame.description}
                        </p>

                        {/* Functional Action Buttons */}
                        <div className="flex items-center gap-3">
                            {isCurrentRunning ? (
                                <>
                                    <button
                                        disabled={isStopping}
                                        onClick={onResume}
                                        className={`px-8 py-3.5 bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 text-white font-bold text-sm rounded-xl shadow-lg shadow-emerald-950/60 flex items-center gap-2.5 transition transform ${
                                            isStopping ? 'opacity-50 cursor-not-allowed' : 'hover:-translate-y-0.5 cursor-pointer'
                                        }`}
                                    >
                                        <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24">
                                            <path d="M8 5v14l11-7z" />
                                        </svg>
                                        Resume Game
                                    </button>
                                    <button
                                        disabled={isStopping}
                                        onClick={onStop}
                                        className={`px-5 py-3.5 font-semibold text-sm rounded-xl border transition flex items-center gap-2 ${
                                            isStopping
                                                ? 'bg-zinc-800 text-zinc-400 border-zinc-700/60 cursor-wait'
                                                : 'bg-zinc-900 hover:bg-red-950/50 text-zinc-300 hover:text-red-300 border-zinc-700/60 hover:border-red-800/60 cursor-pointer'
                                        }`}
                                    >
                                        {isStopping ? (
                                            <>
                                                <svg className="animate-spin h-3.5 w-3.5 text-zinc-400" fill="none" viewBox="0 0 24 24">
                                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
                                                </svg>
                                                Stopping...
                                            </>
                                        ) : (
                                            'Stop Game'
                                        )}
                                    </button>
                                </>
                            ) : (
                                <button
                                    disabled={isStarting || isRunning}
                                    onClick={() => onLaunch(currentGame.id)}
                                    className={`px-8 py-3.5 text-sm font-extrabold rounded-xl shadow-xl flex items-center gap-2.5 transition transform cursor-pointer ${
                                        isRunning
                                            ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed shadow-none'
                                            : isStarting
                                                ? 'bg-amber-700 text-amber-100 cursor-wait'
                                                : 'bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-zinc-950 hover:-translate-y-0.5 shadow-amber-950/60'
                                    }`}
                                >
                                    {isStarting ? (
                                        <>
                                            <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-zinc-950" fill="none" viewBox="0 0 24 24">
                                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
                                            </svg>
                                            Starting Session...
                                        </>
                                    ) : (
                                        <>
                                            <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24">
                                                <path d="M8 5v14l11-7z" />
                                            </svg>
                                            Launch Game
                                        </>
                                    )}
                                </button>
                            )}

                            {isRunning && !isCurrentRunning && (
                                <button
                                    onClick={onResume}
                                    className="px-5 py-3.5 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-sm rounded-xl transition cursor-pointer"
                                >
                                    Resume {session.gameName || 'Active Game'}
                                </button>
                            )}
                        </div>
                    </div>
                </div>

                {/* Multiple Games Selector (Only shown if 2+ games exist) */}
                {games.length > 1 && (
                    <div className="mt-6 flex items-center gap-3">
                        <span className="text-xs uppercase tracking-wider text-zinc-400 font-semibold">Games:</span>
                        <div className="flex gap-2">
                            {games.map(game => (
                                <button
                                    key={game.id}
                                    onClick={() => setSelectedGameId(game.id)}
                                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition cursor-pointer ${
                                        selectedGameId === game.id
                                            ? 'bg-zinc-800 text-white border-amber-500/60'
                                            : 'bg-zinc-900/60 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                                    }`}
                                >
                                    {game.name}
                                </button>
                            ))}
                        </div>
                    </div>
                )}
            </main>

            {/* Clean bottom */}
            <div className="h-6" />
        </div>
    );
}
