let socket = null;
let processor = null;
let audioContext = null;
let stream = null;
let currentAudio = null;

const contextInput = document.getElementById("context");
const transcriptText = document.getElementById("userText");
const responseText = document.getElementById("agentText");

document.getElementById("start").addEventListener("click", async () => {
  if (socket && socket.readyState === WebSocket.OPEN) {
    console.log("🟡 Already connected");
    return;
  }

  const context = contextInput.value.trim();
  if (!context) {
    alert("Please enter context");
    return;
  }

  const res = await fetch("http://localhost:3000/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ context }),
  });

  const data = await res.json();
  const joinUrl = data.joinUrl;
  connectToUltravox(joinUrl);
});

document.getElementById("stop").addEventListener("click", () => {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.close();
    socket = null;
    console.log("🛑 WebSocket closed");
  }

  if (processor) {
    processor.disconnect();
    processor.onaudioprocess = null;
  }

  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
  }

  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }

  console.log("🛑 Stopped mic stream and cleaned up");
});

function connectToUltravox(url) {
  socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";

  socket.onopen = () => {
    console.log("✅ Connected to Ultravox");
    startMicStream();
  };

  socket.onmessage = (event) => {
    const data = event.data;

    if (data instanceof ArrayBuffer) {
      console.log("🎧 Playing audio response...");
      playAudio(data);
    } else {
      const msg = JSON.parse(data);
      console.log("📨 Received message:", msg);

      if (msg.type === "transcript") {
        transcriptText.textContent = msg.transcript || "...";
      } else if (msg.type === "response") {
        responseText.textContent = msg.text || "(no reply)";
      } else if (msg.type === "playback_clear_buffer") {
        if (currentAudio) {
          currentAudio.pause();
          currentAudio.src = "";
          currentAudio = null;
          console.log("🧹 Audio buffer cleared by Ultravox");
        }
      }
    }
  };

  socket.onerror = (err) => console.error("❌ WebSocket error:", err);
  socket.onclose = () => console.log("🔌 Socket closed by server");
}

async function startMicStream() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioContext = new AudioContext({ sampleRate: 48000 });
    console.log("🎛️ Actual mic sample rate:", audioContext.sampleRate);

    const source = audioContext.createMediaStreamSource(stream);
    processor = audioContext.createScriptProcessor(8192, 1, 1);

    source.connect(processor);
    processor.connect(audioContext.destination);

    processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const buffer = convertFloat32ToInt16(input);
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(buffer);
      }
    };

    console.log("🎙️ Mic stream started");
  } catch (err) {
    console.error("❌ Failed to access microphone:", err);
    alert("Microphone permission denied or not available");
  }
}

function convertFloat32ToInt16(buffer) {
  const l = buffer.length;
  const buf = new Int16Array(l);
  for (let i = 0; i < l; i++) {
    buf[i] = Math.max(-1, Math.min(1, buffer[i])) * 32767;
  }
  return buf.buffer;
}

function playAudio(arrayBuffer) {
  try {
    const wavBuffer = encodeWav(arrayBuffer, {
      channels: 1,
      sampleRate: 48000,
      bitDepth: 16,
    });

    const blob = new Blob([wavBuffer], { type: "audio/wav" });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    currentAudio = audio;

    audio.play().catch((err) => {
      console.error("🔈 Playback error:", err);
    });
  } catch (err) {
    console.error("🎧 Failed to play audio:", err);
  }
}

function encodeWav(samples, options) {
  const { channels = 1, sampleRate = 48000, bitDepth = 16 } = options;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.byteLength;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');

  // fmt chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);

  // data chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  new Uint8Array(buffer, 44).set(new Uint8Array(samples));
  return buffer;
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
