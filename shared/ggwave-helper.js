(function (global) {
  'use strict';

  let ggwaveModulePromise = null;

  function load() {
    if (!ggwaveModulePromise) {
      if (typeof global.ggwave_factory !== 'function') {
        return Promise.reject(new Error('ggwave_factory is not loaded. Include /vendor/ggwave.js first.'));
      }
      ggwaveModulePromise = global.ggwave_factory();
    }
    return ggwaveModulePromise;
  }

  function resolveProtocol(ggwave, protocolKey) {
    if (!protocolKey) {
      return ggwave.ProtocolId.GGWAVE_PROTOCOL_ULTRASOUND_FASTEST;
    }
    if (typeof protocolKey !== 'string') {
      return protocolKey;
    }
    const normalized = protocolKey.startsWith('GGWAVE_PROTOCOL_')
      ? protocolKey
      : `GGWAVE_PROTOCOL_${protocolKey}`;
    const resolved = ggwave.ProtocolId[normalized];
    if (!resolved) {
      throw new Error(`Unknown ggwave protocol: ${protocolKey}`);
    }
    return resolved;
  }

  async function createInstance(sampleRateInp = 48000, sampleRateOut = sampleRateInp) {
    const ggwave = await load();
    const parameters = ggwave.getDefaultParameters();
    parameters.sampleRateInp = sampleRateInp;
    parameters.sampleRateOut = sampleRateOut;
    parameters.sampleFormatInp = ggwave.SampleFormat.GGWAVE_SAMPLE_FORMAT_F32;
    parameters.sampleFormatOut = ggwave.SampleFormat.GGWAVE_SAMPLE_FORMAT_F32;
    parameters.operatingMode = ggwave.GGWAVE_OPERATING_MODE_RX_AND_TX;

    const instance = ggwave.init(parameters);
    if (instance < 0) {
      throw new Error(`ggwave.init failed (code ${instance})`);
    }
    return {
      ggwave,
      instance,
      sampleRateInp,
      sampleRateOut,
    };
  }

  function freeInstance(handle) {
    if (handle && handle.ggwave && typeof handle.instance === 'number' && handle.instance >= 0) {
      try {
        handle.ggwave.free(handle.instance);
      } catch (_) {
        // Ignore double-free errors
      }
      handle.instance = -1;
    }
  }

  function encodeToFloat32(handle, text, protocolKey, volume = 50) {
    if (!handle || handle.instance < 0) {
      throw new Error('ggwave instance is not initialized');
    }
    const protocolId = resolveProtocol(handle.ggwave, protocolKey);
    const vol = Math.max(1, Math.min(100, Number(volume) || 50));
    const waveformBytes = handle.ggwave.encode(handle.instance, String(text), protocolId, vol);

    // Copy out of Emscripten WASM linear memory before future WASM calls reuse the static buffer.
    const buffer = new ArrayBuffer(waveformBytes.byteLength);
    new Int8Array(buffer).set(waveformBytes);
    return new Float32Array(buffer);
  }

  const textDecoder = new TextDecoder('utf-8');

  function decodeFromFloat32(handle, float32Samples) {
    if (!handle || handle.instance < 0) {
      return null;
    }
    const bytes = new Int8Array(
      float32Samples.buffer,
      float32Samples.byteOffset,
      float32Samples.byteLength
    );
    const res = handle.ggwave.decode(handle.instance, bytes);
    if (res && res.length > 0) {
      return textDecoder.decode(res);
    }
    return null;
  }

  function playFloat32(audioCtx, float32Samples, destinationNode) {
    const buffer = audioCtx.createBuffer(1, float32Samples.length, audioCtx.sampleRate);
    buffer.getChannelData(0).set(float32Samples);

    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(destinationNode || audioCtx.destination);
    source.start();
    return source;
  }

  async function startListening(options) {
    const {
      audioCtx: providedCtx,
      onToken,
      onLevel,
      onAnalyserReady,
      onSampleRate,
    } = options || {};

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('navigator.mediaDevices.getUserMedia is unavailable (requires HTTPS or localhost)');
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
        sampleRate: 48000,
      },
    });

    const AudioCtx = global.AudioContext || global.webkitAudioContext;
    const ownsCtx = !providedCtx;
    const audioCtx = providedCtx || new AudioCtx({ sampleRate: 48000 });
    if (audioCtx.state === 'suspended') {
      await audioCtx.resume();
    }

    const actualSampleRate = audioCtx.sampleRate;
    if (typeof onSampleRate === 'function') {
      onSampleRate(actualSampleRate);
    }

    const handle = await createInstance(actualSampleRate, actualSampleRate);
    const micSource = audioCtx.createMediaStreamSource(stream);

    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0.15;

    const processor = audioCtx.createScriptProcessor(1024, 1, 1);
    const silentGain = audioCtx.createGain();
    silentGain.gain.value = 0;

    micSource.connect(analyser);
    analyser.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(audioCtx.destination);

    if (typeof onAnalyserReady === 'function') {
      onAnalyserReady(analyser, audioCtx);
    }

    let stopped = false;
    processor.onaudioprocess = (event) => {
      if (stopped) return;
      const input = event.inputBuffer.getChannelData(0);

      if (typeof onLevel === 'function') {
        let sumSq = 0;
        for (let i = 0; i < input.length; i++) {
          sumSq += input[i] * input[i];
        }
        onLevel(Math.sqrt(sumSq / input.length));
      }

      const decoded = decodeFromFloat32(handle, input);
      if (decoded !== null && typeof onToken === 'function') {
        onToken(decoded, {
          sampleRate: actualSampleRate,
          at: Date.now(),
        });
      }
    };

    return {
      audioCtx,
      analyser,
      sampleRate: actualSampleRate,
      stream,
      stop: async () => {
        if (stopped) return;
        stopped = true;
        processor.onaudioprocess = null;
        try { micSource.disconnect(); } catch (_) {}
        try { analyser.disconnect(); } catch (_) {}
        try { processor.disconnect(); } catch (_) {}
        try { silentGain.disconnect(); } catch (_) {}
        stream.getTracks().forEach((t) => t.stop());
        freeInstance(handle);
        if (ownsCtx && audioCtx.state !== 'closed') {
          try { await audioCtx.close(); } catch (_) {}
        }
      },
    };
  }

  global.GGWaveHelper = {
    load,
    resolveProtocol,
    createInstance,
    freeInstance,
    encodeToFloat32,
    decodeFromFloat32,
    playFloat32,
    startListening,
  };
})(window);
