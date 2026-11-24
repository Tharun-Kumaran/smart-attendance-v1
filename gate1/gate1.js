(function () {
  'use strict';

  // Elements
  const btnToggleRx = document.getElementById('btnToggleRx');
  const btnToggleRxText = document.getElementById('btnToggleRxText');
  const rxPing = document.getElementById('rxPing');
  const rxDot = document.getElementById('rxDot');
  const rxStatusBadge = document.getElementById('rxStatusBadge');
  const fftCanvas = document.getElementById('fftCanvas');
  const fftPeakBadge = document.getElementById('fftPeakBadge');
  const srLabel = document.getElementById('srLabel');
  const energyLabel = document.getElementById('energyLabel');

  const verdictBox = document.getElementById('verdictBox');
  const verdictIcon = document.getElementById('verdictIcon');
  const verdictTitle = document.getElementById('verdictTitle');
  const verdictDetail = document.getElementById('verdictDetail');
  const verdictAge = document.getElementById('verdictAge');
  const verdictAgeSub = document.getElementById('verdictAgeSub');

  const cardToken = document.getElementById('cardToken');
  const cardPayload = document.getElementById('cardPayload');
  const cardDistortion = document.getElementById('cardDistortion');
  const cardCrc = document.getElementById('cardCrc');

  const rxCountBadge = document.getElementById('rxCountBadge');
  const rxLogBody = document.getElementById('rxLogBody');

  const btnSimulateReplay = document.getElementById('btnSimulateReplay');
  const btnSimulateDistortion = document.getElementById('btnSimulateDistortion');
  const freshnessThreshold = document.getElementById('freshnessThreshold');
  const freshnessThresholdVal = document.getElementById('freshnessThresholdVal');
  const distortionThreshold = document.getElementById('distortionThreshold');
  const distortionThresholdVal = document.getElementById('distortionThresholdVal');
  const chkSound = document.getElementById('chkSound');
  const chkVibrate = document.getElementById('chkVibrate');

  // State
  const getHelper = () => window.GGWaveHelper || window.ggwaveHelper;
  let audioCtx = null;
  let micStream = null;
  let micSource = null;
  let analyser = null;
  let scriptNode = null;
  let ggwaveHandle = null;
  let isListening = false;
  let totalCaptures = 0;
  let latestDistortionRatio = 0;
  let latestUltrasoundEnergy = 0;

  // CRC-8 validation
  function calcCrc(str) {
    let c = 0xAA;
    for (let i = 0; i < str.length; i++) {
      c = (c ^ (str.charCodeAt(i) * 31)) & 0xFF;
    }
    return c.toString(16).padStart(2, '0').toUpperCase();
  }

  // Audio synthesized feedback
  function playBeep(type) {
    if (!chkSound.checked || !audioCtx) return;
    try {
      const now = audioCtx.currentTime;
      if (type === 'success') {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, now); // A5
        osc.frequency.exponentialRampToValueAtTime(1320, now + 0.15); // E6
        gain.gain.setValueAtTime(0.15, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(now);
        osc.stop(now + 0.2);
      } else if (type === 'replay' || type === 'error') {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(220, now);
        osc.frequency.setValueAtTime(160, now + 0.1);
        gain.gain.setValueAtTime(0.2, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(now);
        osc.stop(now + 0.3);
      }
    } catch (_) {}
  }

  function triggerVibrate(pattern) {
    if (chkVibrate.checked && 'vibrate' in navigator) {
      try {
        navigator.vibrate(pattern);
      } catch (_) {}
    }
  }

  // Start microphone and ggwave pipeline
  async function startListening() {
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AudioContextClass({ latencyHint: 'interactive' });
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }

      // Request raw audio without voice compression or low-pass filtering
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });

      srLabel.textContent = `${(audioCtx.sampleRate / 1000).toFixed(1)} kHz`;

      // ggwave WASM instance
      if (!ggwaveHandle) {
        ggwaveHandle = await getHelper().createInstance(audioCtx.sampleRate, audioCtx.sampleRate);
      }

      // Setup audio graph
      micSource = audioCtx.createMediaStreamSource(micStream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.4;
      micSource.connect(analyser);

      // ScriptProcessor / PCM pipeline for ggwave
      scriptNode = audioCtx.createScriptProcessor(2048, 1, 1);
      scriptNode.onaudioprocess = (e) => {
        if (!isListening) return;
        const inputData = e.inputBuffer.getChannelData(0);
        try {
          const text = getHelper().decodeFromFloat32(ggwaveHandle, inputData);
          if (text) {
            handleDecodedPayload(text);
          }
        } catch (err) {
          console.error('ggwave decode error:', err);
        }
      };

      micSource.connect(scriptNode);
      scriptNode.connect(audioCtx.destination); // Required for Chrome to pump audio through ScriptProcessor

      isListening = true;
      btnToggleRxText.textContent = 'Stop Listening (Mic)';
      btnToggleRx.className = 'px-5 py-3 rounded-xl font-bold text-sm bg-rose-600 hover:bg-rose-500 active:bg-rose-700 text-white shadow-lg shadow-rose-950/50 flex items-center gap-2 transition cursor-pointer';

      rxStatusBadge.textContent = 'LISTENING ACTIVE';
      rxStatusBadge.className = 'px-2.5 py-1 rounded-full text-xs font-mono font-medium bg-sky-950 text-sky-400 border border-sky-800 animate-pulse';

      rxPing.classList.remove('hidden');
      rxDot.className = 'relative inline-flex rounded-full h-3 w-3 bg-sky-400';

      startFftLoop();
    } catch (err) {
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        alert('Microphone permission was denied. Please allow microphone permissions in your browser.');
      } else {
        alert('Microphone initialization failed: ' + err.message);
      }
      console.error(err);
      stopListening();
    }
  }

  // Stop microphone
  function stopListening() {
    isListening = false;
    if (scriptNode) {
      scriptNode.disconnect();
      scriptNode = null;
    }
    if (micSource) {
      micSource.disconnect();
      micSource = null;
    }
    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
      micStream = null;
    }

    btnToggleRxText.textContent = 'Start Listening (Mic)';
    btnToggleRx.className = 'px-5 py-3 rounded-xl font-bold text-sm bg-sky-600 hover:bg-sky-500 active:bg-sky-700 text-white shadow-lg shadow-sky-950/50 flex items-center gap-2 transition cursor-pointer';

    rxStatusBadge.textContent = 'STANDBY';
    rxStatusBadge.className = 'px-2.5 py-1 rounded-full text-xs font-mono font-medium bg-slate-800 text-slate-400 border border-slate-700';

    rxPing.classList.add('hidden');
    rxDot.className = 'relative inline-flex rounded-full h-3 w-3 bg-slate-600';
  }

  // Real-time FFT spectrum visualizer & distortion calculator
  function startFftLoop() {
    const ctx = fftCanvas.getContext('2d');
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    const nyquist = audioCtx.sampleRate / 2;
    const binHz = nyquist / bufferLength;

    function render() {
      if (!isListening) return;
      requestAnimationFrame(render);
      analyser.getByteFrequencyData(dataArray);

      const width = fftCanvas.width;
      const height = fftCanvas.height;

      ctx.fillStyle = '#020617';
      ctx.fillRect(0, 0, width, height);

      // Highlight Ultrasound Zone (15 kHz - 20 kHz)
      const usStartBin = Math.floor(15000 / binHz);
      const usEndBin = Math.min(bufferLength - 1, Math.floor(20000 / binHz));
      const usXStart = (usStartBin / bufferLength) * width;
      const usXEnd = (usEndBin / bufferLength) * width;

      ctx.fillStyle = 'rgba(16, 185, 129, 0.08)';
      ctx.fillRect(usXStart, 0, usXEnd - usXStart, height);

      // Highlight Sub-Harmonic Distortion Zone (7 kHz - 13 kHz)
      const distStartBin = Math.floor(7000 / binHz);
      const distEndBin = Math.floor(13000 / binHz);

      let peakVal = 0;
      let peakBin = 0;
      let usEnergySum = 0;
      let distEnergySum = 0;

      // Draw FFT Bars
      const barWidth = (width / bufferLength) * 2.2;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        const val = dataArray[i];
        const barHeight = (val / 255) * (height - 10);

        if (val > peakVal && i > 10) {
          peakVal = val;
          peakBin = i;
        }

        // Energy in ultrasound
        if (i >= usStartBin && i <= usEndBin) {
          usEnergySum += val;
        }
        // Energy in sub-harmonic distortion band
        if (i >= distStartBin && i <= distEndBin) {
          distEnergySum += val;
        }

        if (i >= usStartBin && i <= usEndBin) {
          ctx.fillStyle = val > 120 ? '#34d399' : '#059669';
        } else if (i >= distStartBin && i <= distEndBin) {
          ctx.fillStyle = val > 140 ? '#f59e0b' : '#38bdf8';
        } else {
          ctx.fillStyle = '#1e293b';
        }

        ctx.fillRect(x, height - barHeight, barWidth, barHeight);
        x += barWidth;
        if (x > width) break;
      }

      // Peak Frequency Display
      const peakFreq = Math.round(peakBin * binHz);
      fftPeakBadge.textContent = `Peak: ${peakFreq.toLocaleString()} Hz`;
      if (peakFreq >= 15000 && peakFreq <= 20000 && peakVal > 90) {
        fftPeakBadge.className = 'text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-950 text-emerald-300 border border-emerald-700 font-bold';
      } else {
        fftPeakBadge.className = 'text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700';
      }

      // Energy calculation
      const avgUsEnergy = usEnergySum / (usEndBin - usStartBin + 1);
      const avgDistEnergy = distEnergySum / (distEndBin - distStartBin + 1);
      latestUltrasoundEnergy = Math.round((avgUsEnergy / 255) * 100);
      energyLabel.textContent = `${latestUltrasoundEnergy}%`;

      // Distortion ratio
      if (avgUsEnergy > 15) {
        latestDistortionRatio = Math.round((avgDistEnergy / (avgUsEnergy + 0.001)) * 100);
      } else {
        latestDistortionRatio = 0;
      }
    }
    render();
  }

  // Handle incoming decoded ultrasonic payload
  function handleDecodedPayload(rawString, isSimulation = false) {
    totalCaptures++;
    rxCountBadge.textContent = `${totalCaptures} capture${totalCaptures === 1 ? '' : 's'}`;

    const parts = rawString.trim().split(':');
    let token = '????';
    let tsHex = '';
    let receivedCrc = '';
    let ageSec = 999;
    let isValidCrc = false;

    if (parts.length >= 3) {
      token = parts[0];
      tsHex = parts[1];
      receivedCrc = parts[2];
      const expectedCrc = calcCrc(token + ':' + tsHex);
      isValidCrc = receivedCrc.toUpperCase() === expectedCrc.toUpperCase();
      const tsSec = parseInt(tsHex, 16);
      if (!isNaN(tsSec)) {
        ageSec = (Date.now() / 1000) - tsSec;
      }
    } else {
      token = rawString.slice(0, 4);
    }

    // Parameters
    const maxFreshness = parseFloat(freshnessThreshold.value);
    const maxDistortion = parseInt(distortionThreshold.value, 10);
    const distortion = isSimulation ? latestDistortionRatio : latestDistortionRatio;

    // Security Verification Matrix
    let verdict = '';
    let verdictClass = '';
    let icon = '';
    let title = '';
    let detail = '';

    if (!isValidCrc && parts.length >= 3) {
      verdict = 'CHECKSUM_FAILED';
      verdictClass = 'border-amber-700 bg-amber-950/40 text-amber-300';
      icon = '⚠️';
      title = 'Corrupted / Incomplete Packet';
      detail = 'CRC checksum mismatch. Packet might have experienced acoustic interference.';
      playBeep('error');
    } else if (ageSec > maxFreshness) {
      // Replay Attack Detected!
      verdict = 'REPLAY_ATTACK';
      verdictClass = 'border-rose-700 bg-rose-950/50 text-rose-300 shadow-[0_0_30px_rgba(244,63,94,0.3)] animate-pulse';
      icon = '🛑';
      title = 'REPLAY ATTACK BLOCKED!';
      detail = `Token expired! Acoustic timestamp is ${ageSec.toFixed(1)}s old (limit: ${maxFreshness.toFixed(1)}s). Pre-recorded playback detected.`;
      playBeep('replay');
      triggerVibrate([200, 100, 200, 100, 300]);
    } else if (distortion > maxDistortion && latestUltrasoundEnergy > 20) {
      // Loudspeaker distortion detected
      verdict = 'SPEAKER_DISTORTION';
      verdictClass = 'border-amber-700 bg-amber-950/50 text-amber-300';
      icon = '📢';
      title = 'Loudspeaker Distortion Detected';
      detail = `High sub-harmonics (${distortion}%). Sound profile matches a phone speaker replaying audio rather than direct sound.`;
      playBeep('error');
      triggerVibrate([100, 80, 100]);
    } else {
      // Clean genuine direct sound!
      verdict = 'VERIFIED_LIVE';
      verdictClass = 'border-emerald-700 bg-emerald-950/50 text-emerald-300 shadow-[0_0_30px_rgba(16,185,129,0.25)]';
      icon = '✅';
      title = 'VERIFIED LIVE & FRESH';
      detail = `Direct acoustic ultrasound verified. Timestamp age: ${Math.max(0, ageSec).toFixed(1)}s (clean spectrum).`;
      playBeep('success');
      triggerVibrate([80]);
    }

    // Update UI Cards
    verdictBox.className = `rounded-xl p-5 flex flex-col sm:flex-row items-center justify-between gap-4 transition-all border ${verdictClass}`;
    verdictIcon.textContent = icon;
    verdictTitle.textContent = title;
    verdictDetail.textContent = detail;
    verdictAge.textContent = `${Math.max(0, ageSec).toFixed(1)}s`;
    verdictAge.className = `text-2xl font-mono font-bold ${ageSec <= maxFreshness ? 'text-emerald-400' : 'text-rose-400'}`;

    cardToken.textContent = token;
    cardPayload.textContent = rawString;
    cardDistortion.textContent = `${distortion}%`;
    cardCrc.textContent = receivedCrc || 'OK';

    // Append to Log Table
    appendRxLog(token, ageSec, distortion, verdict);
  }

  // Append entry to decoded signal table
  function appendRxLog(token, ageSec, distortion, verdict) {
    if (rxLogBody.querySelector('td[colspan]')) {
      rxLogBody.innerHTML = '';
    }
    const row = document.createElement('tr');
    const timeStr = new Date().toLocaleTimeString();

    let badge = '';
    if (verdict === 'VERIFIED_LIVE') {
      badge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-950 text-emerald-300 border border-emerald-700">VERIFIED LIVE</span>';
    } else if (verdict === 'REPLAY_ATTACK') {
      badge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-950 text-rose-300 border border-rose-700">REPLAY BLOCKED</span>';
    } else if (verdict === 'SPEAKER_DISTORTION') {
      badge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-950 text-amber-300 border border-amber-700">DISTORTION ALERT</span>';
    } else {
      badge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-800 text-slate-300 border border-slate-700">CHECK ERROR</span>';
    }

    row.innerHTML = `
      <td class="py-2 px-3 text-slate-400">${timeStr}</td>
      <td class="py-2 px-3 font-bold text-white">${token}</td>
      <td class="py-2 px-3 font-mono ${ageSec <= parseFloat(freshnessThreshold.value) ? 'text-emerald-400' : 'text-rose-400 font-bold'}">${ageSec.toFixed(1)}s</td>
      <td class="py-2 px-3 font-mono text-slate-300">${distortion}%</td>
      <td class="py-2 px-3">${badge}</td>
    `;

    rxLogBody.insertBefore(row, rxLogBody.firstChild);

    // Keep max 25 rows
    while (rxLogBody.children.length > 25) {
      rxLogBody.removeChild(rxLogBody.lastChild);
    }
  }

  // Simulator: Simulate a recorded audio played back after 15 seconds
  btnSimulateReplay.addEventListener('click', () => {
    const fakeToken = 'F1A4';
    // 15 seconds old
    const staleTsSec = Math.floor(Date.now() / 1000) - 15;
    const tsHex = staleTsSec.toString(16).toUpperCase();
    const crc = calcCrc(fakeToken + ':' + tsHex);
    const simulatedPayload = `${fakeToken}:${tsHex}:${crc}`;

    handleDecodedPayload(simulatedPayload, true);
  });

  // Simulator: Simulate distorted phone loudspeaker
  btnSimulateDistortion.addEventListener('click', () => {
    const fakeToken = 'B2E9';
    const nowTsSec = Math.floor(Date.now() / 1000) - 1; // fresh timestamp
    const tsHex = nowTsSec.toString(16).toUpperCase();
    const crc = calcCrc(fakeToken + ':' + tsHex);
    const simulatedPayload = `${fakeToken}:${tsHex}:${crc}`;

    latestDistortionRatio = 75; // high loudspeaker distortion
    latestUltrasoundEnergy = 50;
    handleDecodedPayload(simulatedPayload, true);
  });

  // Event Listeners
  btnToggleRx.addEventListener('click', () => {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  });

  freshnessThreshold.addEventListener('input', () => {
    freshnessThresholdVal.textContent = `${freshnessThreshold.value}s`;
    verdictAgeSub.textContent = `Freshness limit: ${freshnessThreshold.value}s`;
  });

  distortionThreshold.addEventListener('input', () => {
    distortionThresholdVal.textContent = `${distortionThreshold.value}%`;
  });

  // Canvas resize
  function resizeCanvas() {
    fftCanvas.width = fftCanvas.offsetWidth * window.devicePixelRatio;
    fftCanvas.height = fftCanvas.offsetHeight * window.devicePixelRatio;
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();
})();
