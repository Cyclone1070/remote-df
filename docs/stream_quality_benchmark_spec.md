# Remote-DF Stream Quality & Benchmarking Specification (v2.0)

## 1. Objective
Define an objective, mathematically rigorous, and verifiable set of telemetry metrics and stress-workload phases to quantify real-time WebRTC streaming quality for Dwarf Fortress across direct LAN and tunneled WAN paths.

---

## 2. Core Telemetry Metrics

### A. Network Frame Timing (Measured at `dc.onmessage` $t_{dc\_rx}$)
To avoid 50 Hz onto 60 Hz display refresh aliasing (5:6 pulldown cadence), network stream metrics are calculated strictly at the **DataChannel arrival boundary**, separate from the display swap (`requestAnimationFrame`).

1. **Stream Arrival Rate ($FPS_{stream}$)**:
   $$\text{FPS}_{stream} = \frac{\Delta \text{Frames Received}}{\Delta t_{rx} \text{ (seconds)}}$$
   * Target: $\ge 48.0$ FPS in steady state (DF nominal simulation rate is 50 Hz).
2. **RFC 3550 Interarrival Jitter ($J$)**:
   Computed recursively per RFC 3550 across inter-arrival intervals $D(i, j) = (R_j - S_j) - (R_i - S_i)$:
   $$J_i = J_{i-1} + \frac{|D(i-1, i)| - J_{i-1}}{16}$$
   * Target (LAN): $J \le 4.0\text{ ms}$.
   * Target (WAN): $J \le 12.0\text{ ms}$.
3. **Late Network Frame Ratio ($R_{late}^{net}$)**:
   Percentage of frames arriving $> 1.5\times$ target nominal interval ($t_{dc\_rx}(i) - t_{dc\_rx}(i-1) > 30.0\text{ ms}$):
   $$R_{late}^{net} = \frac{\text{Count}(\Delta t_{dc\_rx} > 30\text{ ms})}{N_{total}} \times 100\%$$
   * Target (LAN): $R_{late}^{net} \le 1.0\%$.
   * Target (WAN): $R_{late}^{net} \le 4.0\%$.
4. **Engine Stall vs Network Freeze Segregation**:
   * **Engine Stall ($T_{engine}$)**: Engine main-thread pause (e.g. worldgen or save I/O). Detected when server frame sequence gap occurs with zero internal ticks emitted ($\Delta t_{server} > 100\text{ ms}$). Excluded from network quality score.
   * **Network Freeze ($T_{freeze}^{net}$)**: Longest gap between received network frames while server is actively generating frames:
     $$T_{freeze}^{net} = \max_i (\Delta t_{dc\_rx}(i) - \Delta t_{server}(i))$$
   * Target (LAN): $T_{freeze}^{net} \le 50\text{ ms}$.
   * Target (WAN): $T_{freeze}^{net} \le 120\text{ ms}$. Failure: $> 250\text{ ms}$.

### B. Display Presentation Timing (Measured at `requestAnimationFrame` $t_{present}$)
5. **Render Presentation Rate ($FPS_{render}$)**:
   Canvas rendering cadence presented to the user WebGL context.
   * Target: Matches display refresh ceiling ($\ge 50$ FPS on 60/120 Hz displays).
6. **Display Frame Dropped / Stutter Ratio ($R_{stutter}$)**:
   Frames ready in buffer that missed their presentation VSync window:
   * Target: $\le 1.0\%$.

### C. Motion-to-Photon (M2P) Application Latency
7. **Roundtrip Input-to-Presentation Delay ($L_{M2P}$)**:
   Measured via application-level loopback timestamps:
   * Client embeds monotonic 16-bit sequence into input packet at $t_{send}$ (`performance.now()`).
   * Interposer injects input, hooks `SDL_RenderPresent`, records client stamp into `FrameHeader`.
   * Client receives frame, matches timestamp, and measures upon WebGL buffer swap $t_{present}$.
   $$L_{M2P} = t_{present} - t_{send}$$
   * Note: Minimum theoretical $L_{M2P} \ge \text{RTT} + T_{engine\_cadence} (40\text{--}60\text{ms for DF 3-tick pipeline}) + T_{rAF} (0\text{--}16.7\text{ms}) + T_{decode}$.
   * **Target Profile (LAN)**: Median $p_{50} \le 75\text{ ms}$, 95th percentile $p_{95} \le 85\text{ ms}$.
   * **Target Profile (WAN / Tunnel)**: Median $p_{50} \le 125\text{ ms}$, 95th percentile $p_{95} \le 140\text{ ms}$.

### D. Network, Transport & Buffer Congestion
8. **Sender Buffer Backpressure Drop Count ($N_{drop}^{sender}$)**:
   Count of frames dropped server-side due to SCTP congestion buffer backpressure (`bufferedAmount() >= 131072` in `df_streamer.cpp:1274`).
   * Target: 0 drops in steady state; $\le 5$ drops during full-screen pan bursts.
9. **Packet / Frame Gap Rate ($R_{gap}$)**:
   Number of out-of-order sequence arrivals triggering `GAP_ACK` combined delta recovery per minute:
   * Target (LAN): 0 gaps.
   * Target (WAN): $\le 1.0\text{ gap / min}$.
10. **WebRTC RTT ($RTT_{webrtc}$)**:
    ICE candidate-pair smoothed RTT via `RTCPeerConnection.getStats()`.
    * Target (LAN): $\le 6\text{ ms}$.
    * Target (WAN): $\le 60\text{ ms}$.

### E. Visual Parity Gate
11. **Tolerant Pixel Parity ($M_{visual}$)**:
    Perceptual visual comparison against host-rendered native frame buffer using `qa_pixel_comparator.py`:
    * Target: $M_{visual} \ge 99.5\%$ foreground match with 0 missing texture slots.

---

## 3. Benchmark Workload Phases

### Phase 1: Rapid Menu Navigation & Churn (Stress Test)
* 20 cycles of rapid opening and closing Settings (`Escape` / click toggle at 80–150ms intervals).
* Measures: Zero DataChannel stall, $N_{drop}^{sender} = 0$, $R_{gap} \le 1$.

### Phase 2: Engine Transition & Arena World Generation
* Enters "Object testing arena" on Title Screen.
* Engine generation phase is explicitly timed and quarantined ($T_{worldgen} \approx 4\text{--}6\text{s}$).
* Telemetry verifies clean stream resumption immediately upon generation completion without reconnection drop.

### Phase 3: High-Frequency Camera Panning (Peak Bandwidth Burst)
* Rapid camera panning across arena terrain (Arrow keys at 20 moves/sec for 60 ticks).
* Triggers tile churn $> 50\%$, forcing periodic Zstd keyframe bursts.
* Measures: SCTP buffer recovery, frame delivery under heavy delta bursts, sender drop count.

### Phase 4: Entity Spawning & Interactive M2P
* Opens Creature Spawning menu via GUI interaction.
* Places units, moves cursor across grid.
* Measures: High-density M2P latency distribution ($p_{50}$, $p_{95}$, $p_{99}$) and visual parity.

---

## 4. Segregated Quality Gates

| Metric | LAN / Tailscale (Pass) | WAN / Cloudflare (Pass) | Critical Failure Gate |
| :--- | :--- | :--- | :--- |
| **Steady FPS ($FPS_{stream}$)** | $\ge 49.0$ FPS | $\ge 47.0$ FPS | $< 40.0$ FPS |
| **RFC 3550 Jitter ($J$)** | $\le 5.0\text{ ms}$ | $\le 12.0\text{ ms}$ | $> 25.0\text{ ms}$ |
| **Max Network Freeze ($T_{freeze}^{net}$)** | $\le 80\text{ ms}$ | $\le 120\text{ ms}$ | $> 250\text{ ms}$ |
| **Late Network Frames ($R_{late}^{net}$)** | $\le 3.0\%$ | $\le 4.0\%$ | $> 8.0\%$ |
| **M2P Latency ($p_{95}$)** | $\le 85\text{ ms}$ | $\le 140\text{ ms}$ | $> 200\text{ ms}$ |
| **Frame Gaps ($R_{gap}$)** | 0 gaps | $\le 1.5$ gaps / min | $> 5.0$ gaps / min |
| **Sender Buffer Drops** | 0 drops | $\le 5$ drops / pan burst | $> 20$ drops |
| **Visual Parity Match** | $\ge 99.8\%$ | $\ge 99.5\%$ | $< 98.0\%$ |
| **Transport Stability** | UDP `host <-> host` | UDP `host <-> host` (or `srflx`) | Drops to TCP / closes |
