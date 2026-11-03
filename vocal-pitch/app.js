(function () {
  const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);

  const fileInput = document.querySelector("#file");
  const dropzone = document.querySelector("#dropzone");
  const statusEl = document.querySelector("#status");
  const progressEl = document.querySelector("#progress");
  const progressBar = document.querySelector("#progress-bar");
  const stage = document.querySelector("#stage");
  const noteEl = document.querySelector("#note");
  const centsEl = document.querySelector("#cents");
  const hzEl = document.querySelector("#hz");
  const timeEl = document.querySelector("#time");
  const filenameEl = document.querySelector("#filename");
  const playButton = document.querySelector("#play");
  const canvas = document.querySelector("#chart");
  const player = document.querySelector("#player");

  const ctx = canvas.getContext("2d");
  const offscreen = document.createElement("canvas");
  const offscreenCtx = offscreen.getContext("2d");

  let job = 0;
  let objectUrl = null;
  let view = null;
  let hoverTime = null;
  let scrubbing = false;
  let playing = false;
  let cssWidth = 0;
  let cssHeight = 0;

  function hzToMidi(hz) {
    return 69 + 12 * Math.log2(hz / 440);
  }

  function noteName(midi) {
    const rounded = Math.round(midi);
    const name = NOTE_NAMES[((rounded % 12) + 12) % 12];
    const octave = Math.floor(rounded / 12) - 1;
    return name + octave;
  }

  function describe(freq) {
    if (!freq) return null;
    const midiFloat = hzToMidi(freq);
    const rounded = Math.round(midiFloat);
    const cents = Math.round((midiFloat - rounded) * 100);
    return { name: noteName(rounded), cents, hz: freq };
  }

  function formatCents(cents) {
    if (cents === 0) return "±0 音分";
    return (cents > 0 ? "+" : "") + cents + " 音分";
  }

  function formatHz(hz) {
    if (!hz) return "— Hz";
    return (hz >= 1000 ? hz.toFixed(0) : hz.toFixed(1)) + " Hz";
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
    const whole = Math.floor(seconds);
    const s = whole % 60;
    const m = Math.floor(whole / 60) % 60;
    const h = Math.floor(whole / 3600);
    const pad = (n) => String(n).padStart(2, "0");
    if (h > 0) return h + ":" + pad(m) + ":" + pad(s);
    return m + ":" + pad(s);
  }

  function formatTimeFine(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
    const m = Math.floor(seconds / 60);
    const s = seconds - m * 60;
    return m + ":" + (s < 10 ? "0" : "") + s.toFixed(1);
  }

  function setStatus(text) {
    statusEl.hidden = !text;
    statusEl.textContent = text || "";
  }

  function setProgress(ratio) {
    const visible = ratio != null && ratio < 1;
    progressEl.hidden = !visible;
    progressBar.style.width = visible ? Math.round(ratio * 100) + "%" : "0";
  }

  function isMp3(file) {
    const name = (file.name || "").toLowerCase();
    return name.endsWith(".mp3") || file.type === "audio/mpeg" || file.type === "audio/mp3";
  }

  function pitchRange(freqs) {
    let lo = Infinity;
    let hi = -Infinity;
    let count = 0;
    for (let i = 0; i < freqs.length; i++) {
      if (freqs[i] > 0) {
        const midi = hzToMidi(freqs[i]);
        if (midi < lo) lo = midi;
        if (midi > hi) hi = midi;
        count++;
      }
    }
    if (!count) return null;
    lo -= 3;
    hi += 3;
    if (hi - lo < 14) {
      const mid = (hi + lo) / 2;
      lo = mid - 7;
      hi = mid + 7;
    }
    return { midiMin: Math.floor(lo) - 0.5, midiMax: Math.ceil(hi) + 0.5 };
  }

  function layoutOf() {
    const margin = { left: 58, right: 16, top: 16, bottom: 32 };
    return {
      margin,
      plotX: margin.left,
      plotY: margin.top,
      plotW: Math.max(1, cssWidth - margin.left - margin.right),
      plotH: Math.max(1, cssHeight - margin.top - margin.bottom),
    };
  }

  function yAt(midi, layout, range) {
    const t = (range.midiMax - midi) / (range.midiMax - range.midiMin);
    return layout.plotY + t * layout.plotH;
  }

  function xAt(time, layout, duration) {
    if (!(duration > 0)) return layout.plotX;
    return layout.plotX + (time / duration) * layout.plotW;
  }

  function timeAt(x, layout, duration) {
    const t = ((x - layout.plotX) / layout.plotW) * duration;
    return Math.min(duration, Math.max(0, t));
  }

  function timeStep(duration) {
    const target = duration / 6;
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900];
    for (let i = 0; i < steps.length; i++) {
      if (steps[i] >= target) return steps[i];
    }
    return 900;
  }

  function frameIndexAt(time) {
    if (!view || view.times.length === 0) return -1;
    const index = Math.round((time - view.times[0]) / view.hop);
    if (index < 0 || index >= view.times.length) return -1;
    return index;
  }

  function freqAt(time) {
    const index = frameIndexAt(time);
    if (index < 0) return 0;
    return view.freqs[index];
  }

  function drawStatic() {
    const layout = layoutOf();
    const range = view && view.range;
    const duration = view ? view.duration : 0;
    const octx = offscreenCtx;
    octx.setTransform(deviceScale(), 0, 0, deviceScale(), 0, 0);
    octx.clearRect(0, 0, cssWidth, cssHeight);
    octx.fillStyle = "#141418";
    octx.fillRect(0, 0, cssWidth, cssHeight);

    if (!view || !range) {
      octx.fillStyle = "#b7b0a6";
      octx.font = "16px " + fontFamily();
      octx.textAlign = "center";
      octx.fillText("沒有偵測到穩定音高", cssWidth / 2, cssHeight / 2);
      return;
    }

    const minNote = Math.ceil(range.midiMin);
    const maxNote = Math.floor(range.midiMax);
    for (let midi = minNote; midi <= maxNote; midi++) {
      const top = yAt(midi + 0.5, layout, range);
      const bottom = yAt(midi - 0.5, layout, range);
      const pitchClass = ((midi % 12) + 12) % 12;
      const y0 = Math.max(layout.plotY, top);
      const y1 = Math.min(layout.plotY + layout.plotH, bottom);
      if (y1 <= y0) continue;
      octx.fillStyle = BLACK_KEYS.has(pitchClass) ? "#101014" : "#1c1c24";
      octx.fillRect(layout.plotX, y0, layout.plotW, y1 - y0);
    }

    const pxPerNote = layout.plotH / Math.max(1, range.midiMax - range.midiMin);
    const labelAll = pxPerNote >= 15;
    octx.font = (pxPerNote >= 18 ? "12px " : "11px ") + fontFamily();
    octx.textAlign = "right";
    octx.textBaseline = "middle";
    for (let midi = minNote; midi <= maxNote; midi++) {
      const pitchClass = ((midi % 12) + 12) % 12;
      const y = yAt(midi, layout, range);
      if (y < layout.plotY + 8 || y > layout.plotY + layout.plotH - 8) continue;
      if (pitchClass === 0) {
        octx.strokeStyle = "rgba(255,255,255,0.18)";
        octx.lineWidth = 1;
        octx.beginPath();
        octx.moveTo(layout.plotX, y);
        octx.lineTo(layout.plotX + layout.plotW, y);
        octx.stroke();
      }
      if (labelAll || pitchClass === 0) {
        octx.fillStyle = pitchClass === 0 ? "#f0ebe3" : "#a39c93";
        octx.fillText(noteName(midi), layout.plotX - 8, y);
      }
    }

    const step = timeStep(duration);
    octx.textAlign = "center";
    octx.textBaseline = "top";
    octx.fillStyle = "#9a938a";
    for (let t = 0; t <= duration + 0.001; t += step) {
      const x = xAt(Math.min(t, duration), layout, duration);
      if (x > layout.plotX + layout.plotW - 28 && t !== 0) continue;
      octx.strokeStyle = "rgba(255,255,255,0.06)";
      octx.beginPath();
      octx.moveTo(x, layout.plotY);
      octx.lineTo(x, layout.plotY + layout.plotH);
      octx.stroke();
      octx.fillText(formatTime(t), x, layout.plotY + layout.plotH + 8);
    }

    strokeContour(octx, layout, range, duration, 5, "rgba(255, 139, 74, 0.28)");
    strokeContour(octx, layout, range, duration, 1.8, "#ffb07a");
  }

  function strokeContour(context, layout, range, duration, width, color) {
    const times = view.times;
    const freqs = view.freqs;
    context.beginPath();
    let drawing = false;
    for (let i = 0; i < freqs.length; i++) {
      if (freqs[i] <= 0) {
        drawing = false;
        continue;
      }
      const x = xAt(times[i], layout, duration);
      const y = yAt(hzToMidi(freqs[i]), layout, range);
      if (!drawing) {
        context.moveTo(x, y);
        drawing = true;
        continue;
      }
      const gap = times[i] - times[i - 1];
      if (gap > view.hop * 1.8) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.strokeStyle = color;
    context.lineWidth = width;
    context.lineJoin = "round";
    context.lineCap = "round";
    context.stroke();
  }

  function fontFamily() {
    return '"PingFang TC", "Noto Sans TC", "Microsoft JhengHei", "WenQuanYi Micro Hei", sans-serif';
  }

  function deviceScale() {
    return Math.min(window.devicePixelRatio || 1, 2);
  }

  function render() {
    if (!cssWidth || !cssHeight) return;
    const scale = deviceScale();
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    ctx.drawImage(offscreen, 0, 0, cssWidth, cssHeight);
    if (!view || !view.range) return;

    const layout = layoutOf();
    const playTime = player.currentTime || 0;
    drawPlayhead(playTime, layout);
    if (hoverTime != null) drawHover(hoverTime, layout);
  }

  function drawPlayhead(time, layout) {
    const x = xAt(time, layout, view.duration);
    ctx.strokeStyle = "rgba(255, 248, 240, 0.95)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, layout.plotY);
    ctx.lineTo(x, layout.plotY + layout.plotH);
    ctx.stroke();
    const freq = freqAt(time);
    if (freq > 0) {
      const y = yAt(hzToMidi(freq), layout, view.range);
      ctx.fillStyle = "#fff6ec";
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawHover(time, layout) {
    const x = xAt(time, layout, view.duration);
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, layout.plotY);
    ctx.lineTo(x, layout.plotY + layout.plotH);
    ctx.stroke();

    const freq = freqAt(time);
    const info = describe(freq);
    const lines = [
      formatTimeFine(time),
      info ? info.name + "  " + formatCents(info.cents) : "無穩定音高",
      info ? formatHz(info.hz) : "",
    ].filter(Boolean);

    ctx.font = "12px " + fontFamily();
    const boxW = 132;
    const boxH = 18 + lines.length * 16;
    let boxX = x + 12;
    if (boxX + boxW > cssWidth - 8) boxX = x - boxW - 12;
    const boxY = layout.plotY + 8;
    ctx.fillStyle = "rgba(20, 18, 16, 0.92)";
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    roundRect(ctx, boxX, boxY, boxW, boxH, 8);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#f6f1ea";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], boxX + 10, boxY + 8 + i * 16);
    }
  }

  function roundRect(context, x, y, w, h, r) {
    context.beginPath();
    context.moveTo(x + r, y);
    context.arcTo(x + w, y, x + w, y + h, r);
    context.arcTo(x + w, y + h, x, y + h, r);
    context.arcTo(x, y + h, x, y, r);
    context.arcTo(x, y, x + w, y, r);
    context.closePath();
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    cssWidth = Math.max(1, rect.width);
    cssHeight = Math.max(1, rect.height);
    const scale = deviceScale();
    canvas.width = Math.round(cssWidth * scale);
    canvas.height = Math.round(cssHeight * scale);
    offscreen.width = canvas.width;
    offscreen.height = canvas.height;
    drawStatic();
    render();
  }

  function updateReadout(time) {
    const info = view ? describe(freqAt(time)) : null;
    noteEl.textContent = info ? info.name : "—";
    noteEl.classList.toggle("is-empty", !info);
    centsEl.textContent = info ? formatCents(info.cents) : "無穩定音高";
    hzEl.textContent = formatHz(info && info.hz);
    const duration = view ? view.duration : player.duration || 0;
    timeEl.textContent = formatTimeFine(time) + " / " + formatTime(duration);
  }

  function pointerTime(event) {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    return timeAt(x, layoutOf(), view.duration);
  }

  function seekTo(time) {
    if (!view) return;
    const next = Math.min(view.duration, Math.max(0, time));
    if (player.readyState >= 1) {
      const limit = Number.isFinite(player.duration) ? player.duration : next;
      try {
        player.currentTime = Math.min(next, limit);
      } catch (error) {
        /* Metadata can still be settling on some browsers. */
      }
    }
    updateReadout(next);
    render();
  }

  function togglePlayback() {
    if (!view) return;
    if (player.paused) {
      const playPromise = player.play();
      if (playPromise) playPromise.catch(() => setStatus("無法播放這個音訊。"));
    } else {
      player.pause();
    }
  }

  function setPlaying(next) {
    playing = next;
    playButton.textContent = next ? "暫停" : "播放";
    playButton.setAttribute("aria-pressed", next ? "true" : "false");
    if (next) requestAnimationFrame(tick);
    else render();
  }

  function tick() {
    if (!playing) return;
    updateReadout(player.currentTime || 0);
    render();
    requestAnimationFrame(tick);
  }

  async function handleFile(file) {
    if (!file) return;
    if (!isMp3(file)) {
      setStatus("請選擇 MP3 檔案。");
      setProgress(null);
      return;
    }

    const id = ++job;
    player.pause();
    setPlaying(false);
    stage.hidden = true;
    view = null;
    hoverTime = null;
    filenameEl.textContent = file.name;
    setStatus("正在解碼音訊…");
    setProgress(0);

    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(file);
    player.src = objectUrl;

    let audioBuffer;
    try {
      const bytes = await file.arrayBuffer();
      if (id !== job) return;
      const context = new AudioContext();
      audioBuffer = await context.decodeAudioData(bytes.slice(0));
      context.close();
    } catch (error) {
      if (id !== job) return;
      setStatus("無法解碼這個 MP3，請換一個檔案。");
      setProgress(null);
      return;
    }

    const length = audioBuffer.length;
    const channels = audioBuffer.numberOfChannels;
    const mono = new Float32Array(length);
    for (let c = 0; c < channels; c++) {
      const data = audioBuffer.getChannelData(c);
      for (let i = 0; i < length; i++) mono[i] += data[i];
    }
    if (channels > 1) {
      const scale = 1 / channels;
      for (let i = 0; i < length; i++) mono[i] *= scale;
    }

    setStatus("正在分析音高…");
    let result;
    try {
      result = await Pitch.analyze(mono, audioBuffer.sampleRate, (ratio) => {
        if (id !== job) return;
        setProgress(ratio);
        setStatus("正在分析音高… " + Math.round(ratio * 100) + "%");
      });
    } catch (error) {
      if (id !== job) return;
      setStatus("分析音高時發生問題。");
      setProgress(null);
      return;
    }
    if (id !== job) return;

    const range = pitchRange(result.freqs);
    view = {
      duration: result.duration,
      hop: result.hop,
      times: result.times,
      freqs: result.freqs,
      range,
    };
    setProgress(null);
    stage.hidden = false;
    resize();
    updateReadout(0);
    if (!range) setStatus("沒有偵測到穩定的人聲音高。仍可播放音訊，確認是不是歌聲或說話聲。");
    else setStatus("");
  }

  fileInput.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    handleFile(file);
    fileInput.value = "";
  });

  ["dragenter", "dragover"].forEach((type) => {
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.add("is-dragover");
    });
  });
  ["dragleave", "drop"].forEach((type) => {
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.remove("is-dragover");
    });
  });
  dropzone.addEventListener("drop", (event) => {
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    handleFile(file);
  });

  playButton.addEventListener("click", togglePlayback);
  player.addEventListener("play", () => setPlaying(true));
  player.addEventListener("pause", () => setPlaying(false));
  player.addEventListener("ended", () => {
    updateReadout(player.currentTime || 0);
    setPlaying(false);
  });

  canvas.addEventListener("pointerdown", (event) => {
    if (!view) return;
    scrubbing = true;
    canvas.setPointerCapture(event.pointerId);
    hoverTime = pointerTime(event);
    seekTo(hoverTime);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!view) return;
    const time = pointerTime(event);
    hoverTime = time;
    if (scrubbing) seekTo(time);
    else render();
  });
  canvas.addEventListener("pointerup", () => {
    scrubbing = false;
  });
  canvas.addEventListener("pointerleave", () => {
    if (scrubbing) return;
    hoverTime = null;
    if (view) updateReadout(player.currentTime || 0);
    render();
  });

  window.addEventListener("keydown", (event) => {
    if (event.code !== "Space") return;
    const tag = event.target && event.target.tagName;
    if (tag === "INPUT" || tag === "BUTTON" || tag === "LABEL") return;
    if (stage.hidden) return;
    event.preventDefault();
    togglePlayback();
  });

  window.addEventListener("resize", () => {
    if (!stage.hidden) resize();
  });

  if (window.ResizeObserver) {
    const observer = new ResizeObserver(() => {
      if (!stage.hidden) resize();
    });
    observer.observe(canvas);
  }
})();
