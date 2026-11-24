(function () {
  'use strict';

  // Elements
  const btnToggleTx = document.getElementById('btnToggleTx');
  const btnSendSingle = document.getElementById('btnSendSingle');
  const displayToken = document.getElementById('displayToken');
  const displayPayload = document.getElementById('displayPayload');
  const displayEpoch = document.getElementById('displayEpoch');
  const displayCrc = document.getElementById('displayCrc');
  const countdownText = document.getElementById('countdownText');
  const countdownCircle = document.getElementById('countdownCircle');
  const txStatusBadge = document.getElementById('txStatusBadge');
  const txPing = document.getElementById('txPing');
  const txDot = document.getElementById('txDot');
  const txCountBadge = document.getElementById('txCountBadge');
  const txLogBody = document.getElementById('txLogBody');
  const rotationSecInput = document.getElementById('rotationSec');
  const rotationVal = document.getElementById('rotationVal');
  const txVolumeInput = document.getElementById('txVolume');
  const txVolumeVal = document.getElementById('txVolumeVal');
  const txProtocolSelect = document.getElementById('txProtocol');
  const chkKeepAlive = document.getElementById('chkKeepAlive');
  const txCanvas = document.getElementById('txCanvas');
  const audioLevelLabel = document.getElementById('audioLevelLabel');

  // State
  let audioCtx = null;
  let analyser = null;
  let keepAliveNode = null;
  let ggwaveHandle = null;
  let isTransmitting = false;
  let transmitTimer = null;
  let countdownTimer = null;
  let nextRotationEpochMs = 0;
  let totalPulses = 0;
  let wakeLock = null;

  const getHelper = () => window.GGWaveHelper || window.ggwaveHelper;

  // CRC-8 calculation for payload verification
  function calcCrc(str) {
    let c = 0xAA;
    for (let i = 0; i < str.length; i++) {
      c = (c ^ (str.charCodeAt(i) * 31)) & 0xFF;
    }
    return c.toString(16).padStart(2, '0').toUpperCase();
  }

  // Generate random 4-hex token
  function genToken() {
    const chars = '0123456789ABCDEF';
    let res = '';
    for (let i = 0; i < 4; i++) {
      res += chars[Math.floor(Math.random() * chars.length)];
    }
    return res;
  }

  // Create ephemeral payload: TOKEN:TIMESTAMP_HEX:CRC
  function createEphemeralPayload() {
    const token = genToken();
    const tsSec = Math.floor(Date.now() / 1000);
    const tsHex = tsSec.toString(16).toUpperCase();
    const crc = calcCrc(token + ':' + tsHex);
    return {
      token,
      tsSec,
      tsHex,
      crc,
      payload: `${token}:${tsHex}:${crc}`,
    };
  }

  // Initialize Web Audio Context & ggwave instance
  async function initAudio() {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AudioContextClass({ latencyHint: 'interactive' });
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.connect(audioCtx.destination);
    }
    if (audioCtx.state === 'suspended') {
      await audioCtx.resume();
    }
    if (!ggwaveHandle) {
      ggwaveHandle = await getHelper().createInstance(audioCtx.sampleRate, audioCtx.sampleRate);
    }
    updateKeepAlive();
    startCanvasVisualizer();
  }

  // Keep-alive oscillator (plays inaudible DC offset / ultra-low gain to prevent audio DAC sleep)
  function updateKeepAlive() {
    if (!audioCtx) return;
    if (chkKeepAlive.checked && !keepAliveNode) {
      try {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.frequency.value = 20000; // 20 kHz
        gain.gain.value = 0.00001; // effectively silent
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        keepAliveNode = { osc, gain };
      } catch (err) {
        console.warn('Keep-alive failed:', err);
      }
    } else if (!chkKeepAlive.checked && keepAliveNode) {
      try {
        keepAliveNode.osc.stop();
        keepAliveNode.osc.disconnect();
      } catch (_) {}
      keepAliveNode = null;
    }
  }

  // Canvas visualizer loop
  function startCanvasVisualizer() {
    const ctx = txCanvas.getContext('2d');
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    function draw() {
      requestAnimationFrame(draw);
      analyser.getByteTimeDomainData(dataArray);

      ctx.fillStyle = '#020617';
      ctx.fillRect(0, 0, txCanvas.width, txCanvas.height);

      ctx.lineWidth = 2;
      ctx.strokeStyle = isTransmitting ? '#10b981' : '#64748b';
      ctx.beginPath();

      const sliceWidth = txCanvas.width / bufferLength;
      let x = 0;
      let sum = 0;

      for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 128.0;
        const y = (v * txCanvas.height) / 2;
        sum += Math.abs(dataArray[i] - 128);

        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
        x += sliceWidth;
      }
      ctx.stroke();

      // Audio label
      if (sum > 500) {
        audioLevelLabel.textContent = 'Transmitting Ultrasonic Pulse…';
        audioLevelLabel.className = 'text-emerald-400 font-bold';
      } else {
        audioLevelLabel.textContent = isTransmitting ? 'Carrier Standby' : 'Silent';
        audioLevelLabel.className = 'text-slate-500';
      }
    }
    draw();
  }

  // Request screen WakeLock so phone/laptop doesn't sleep
  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch (_) {}
  }

  // Transmit a single pulse
  async function transmitPulse() {
    await initAudio();
    const packet = createEphemeralPayload();
    const protocol = txProtocolSelect.value;
    const volume = parseInt(txVolumeInput.value, 10);

    // Update UI token & payload
    displayToken.textContent = packet.token;
    displayPayload.textContent = packet.payload;
    displayEpoch.textContent = packet.tsHex;
    displayCrc.textContent = packet.crc;

    // Encode with ggwave
    try {
      const samples = getHelper().encodeToFloat32(ggwaveHandle, packet.payload, protocol, volume);
      getHelper().playFloat32(audioCtx, samples, analyser);

      totalPulses++;
      txCountBadge.textContent = `${totalPulses} pulse${totalPulses === 1 ? '' : 's'} sent`;

      // Log in table
      appendLog(packet.token, packet.payload, 'SENT OK');
    } catch (err) {
      console.error('Pulse encode/play error:', err);
      appendLog(packet.token, packet.payload, 'ERROR: ' + err.message);
    }
  }

  // Append entry to history table
  function appendLog(token, payload, status) {
    if (txLogBody.querySelector('td[colspan]')) {
      txLogBody.innerHTML = '';
    }
    const row = document.createElement('tr');
    const timeStr = new Date().toLocaleTimeString();
    row.innerHTML = `
      <td class="py-1.5 px-3 text-slate-500">${totalPulses}</td>
      <td class="py-1.5 px-3 text-slate-300">${timeStr}</td>
      <td class="py-1.5 px-3 font-bold text-emerald-400">${token}</td>
      <td class="py-1.5 px-3 text-slate-400">${payload}</td>
      <td class="py-1.5 px-3"><span class="px-1.5 py-0.5 rounded text-[10px] bg-emerald-950 text-emerald-300 border border-emerald-800">${status}</span></td>
    `;
    txLogBody.insertBefore(row, txLogBody.firstChild);

    // Keep max 20 rows
    while (txLogBody.children.length > 20) {
      txLogBody.removeChild(txLogBody.lastChild);
    }
  }

  // Start continuous transmission loop
  async function startTransmitter() {
    await initAudio();
    await requestWakeLock();
    isTransmitting = true;

    btnToggleTx.innerHTML = `
      <svg class="w-5 h-5 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
      <span>Stop Acoustic Transmitter</span>
    `;
    btnToggleTx.className = 'flex-1 py-4 px-6 rounded-xl font-bold text-base transition flex items-center justify-center gap-2 bg-rose-600 hover:bg-rose-500 active:bg-rose-700 text-white shadow-lg shadow-rose-950/50 cursor-pointer';

    txStatusBadge.textContent = 'ACTIVE BROADCASTING';
    txStatusBadge.className = 'px-2.5 py-1 rounded-full text-xs font-mono font-medium bg-emerald-950 text-emerald-400 border border-emerald-800 animate-pulse';

    txPing.classList.remove('hidden');
    txDot.className = 'relative inline-flex rounded-full h-3 w-3 bg-emerald-500';

    runLoop();
  }

  // Stop continuous transmission loop
  function stopTransmitter() {
    isTransmitting = false;
    clearTimeout(transmitTimer);
    clearInterval(countdownTimer);

    btnToggleTx.innerHTML = `
      <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
      <span>Start Acoustic Transmitter</span>
    `;
    btnToggleTx.className = 'flex-1 py-4 px-6 rounded-xl font-bold text-base transition flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white shadow-lg shadow-emerald-950/50 cursor-pointer';

    txStatusBadge.textContent = 'TRANSMITTER IDLE';
    txStatusBadge.className = 'px-2.5 py-1 rounded-full text-xs font-mono font-medium bg-slate-800 text-slate-400 border border-slate-700';

    txPing.classList.add('hidden');
    txDot.className = 'relative inline-flex rounded-full h-3 w-3 bg-slate-600';

    countdownText.textContent = `${rotationSecInput.value}s`;
    countdownCircle.style.strokeDashoffset = '0';
  }

  // Recursive loop
  async function runLoop() {
    if (!isTransmitting) return;

    const intervalSec = parseFloat(rotationSecInput.value);
    const intervalMs = intervalSec * 1000;
    nextRotationEpochMs = Date.now() + intervalMs;

    await transmitPulse();

    // Start countdown animation
    clearInterval(countdownTimer);
    countdownTimer = setInterval(() => {
      if (!isTransmitting) {
        clearInterval(countdownTimer);
        return;
      }
      const remainingMs = Math.max(0, nextRotationEpochMs - Date.now());
      const remainingSec = (remainingMs / 1000).toFixed(1);
      countdownText.textContent = `${remainingSec}s`;

      const progress = 1 - (remainingMs / intervalMs);
      const dashoffset = progress * 100;
      countdownCircle.style.strokeDasharray = '100, 100';
      countdownCircle.style.strokeDashoffset = -dashoffset;
    }, 50);

    transmitTimer = setTimeout(() => {
      runLoop();
    }, intervalMs);
  }

  // Event Listeners
  btnToggleTx.addEventListener('click', () => {
    if (isTransmitting) {
      stopTransmitter();
    } else {
      startTransmitter();
    }
  });

  btnSendSingle.addEventListener('click', async () => {
    await transmitPulse();
  });

  rotationSecInput.addEventListener('input', () => {
    rotationVal.textContent = `${rotationSecInput.value}s`;
    countdownText.textContent = `${rotationSecInput.value}s`;
  });

  txVolumeInput.addEventListener('input', () => {
    txVolumeVal.textContent = `${txVolumeInput.value}%`;
  });

  chkKeepAlive.addEventListener('change', updateKeepAlive);

  // Resize canvas for sharp rendering
  function resizeCanvas() {
    txCanvas.width = txCanvas.offsetWidth * window.devicePixelRatio;
    txCanvas.height = txCanvas.offsetHeight * window.devicePixelRatio;
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  // Initial random token preview
  const preview = createEphemeralPayload();
  displayToken.textContent = preview.token;
  displayPayload.textContent = preview.payload;
  displayEpoch.textContent = preview.tsHex;
  displayCrc.textContent = preview.crc;
})();
