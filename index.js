const express = require("express");
const wrtc = require("wrtc");

const { RTCPeerConnection, nonstandard } = wrtc;
const { RTCAudioSource, RTCAudioSink } = nonstandard;

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const SAMPLE_RATE = 48000;
const FRAME_SIZE = 480; // 10 ms a 48 kHz

let sesionActiva = null;

/* =========================
   EMITIR AUDIO
========================= */
function crearEmisorAudio() {
  const source = new RTCAudioSource();
  const track = source.createTrack();

  let sampleIndex = 0;
  const freq = 440; // tono simple para prueba

  const interval = setInterval(() => {
    const samples = new Int16Array(FRAME_SIZE);

    for (let i = 0; i < FRAME_SIZE; i++) {
      const value = Math.sin(2 * Math.PI * freq * (sampleIndex / SAMPLE_RATE));
      samples[i] = Math.max(-32768, Math.min(32767, value * 16000));
      sampleIndex++;
    }

    source.onData({
      samples,
      sampleRate: SAMPLE_RATE,
      bitsPerSample: 16,
      channelCount: 1,
    });
  }, 10);

  return {
    track,
    stop() {
      clearInterval(interval);
      try {
        track.stop();
      } catch {}
    },
  };
}

/* =========================
   RECIBIR AUDIO
========================= */
function crearReceptorAudio(track, label = "RX") {
  const sink = new RTCAudioSink(track);

  sink.ondata = (data) => {
    console.log(
      `[${label}] frame recibido | samples=${data.samples.length} | sampleRate=${data.sampleRate} | channels=${data.channelCount}`
    );
  };

  return {
    sink,
    stop() {
      try {
        sink.stop();
      } catch {}
    },
  };
}

/* =========================
   LOOPBACK
   lo que entra se vuelve a emitir
========================= */
function crearLoopbackTrack(trackEntrada) {
  const sink = new RTCAudioSink(trackEntrada);
  const source = new RTCAudioSource();
  const trackSalida = source.createTrack();

  sink.ondata = (data) => {
    source.onData(data);
  };

  return {
    track: trackSalida,
    stop() {
      try {
        sink.stop();
      } catch {}
      try {
        trackSalida.stop();
      } catch {}
    },
  };
}

/* =========================
   SESIÓN WEBRTC LOCAL
========================= */
async function iniciarSesionLoopback() {
  const pc1 = new RTCPeerConnection();
  const pc2 = new RTCPeerConnection();

  const recursos = {
    emisores: [],
    receptores: [],
    loopbacks: [],
    pcs: [pc1, pc2],
  };

  pc1.onicecandidate = async (event) => {
    if (event.candidate) {
      try {
        await pc2.addIceCandidate(event.candidate);
      } catch (err) {
        console.error("Error agregando ICE candidate a pc2:", err);
      }
    }
  };

  pc2.onicecandidate = async (event) => {
    if (event.candidate) {
      try {
        await pc1.addIceCandidate(event.candidate);
      } catch (err) {
        console.error("Error agregando ICE candidate a pc1:", err);
      }
    }
  };

  const emisor = crearEmisorAudio();
  recursos.emisores.push(emisor);
  pc1.addTrack(emisor.track);

  pc2.ontrack = (event) => {
    const incomingTrack = event.track;
    console.log("[PC2] track recibido");

    const receptor = crearReceptorAudio(incomingTrack, "PC2");
    recursos.receptores.push(receptor);

    const loopback = crearLoopbackTrack(incomingTrack);
    recursos.loopbacks.push(loopback);

    pc2.addTrack(loopback.track);
  };

  pc1.ontrack = (event) => {
    console.log("[PC1] loopback recibido");
    const receptor = crearReceptorAudio(event.track, "PC1_LOOPBACK");
    recursos.receptores.push(receptor);
  };

  const offer = await pc1.createOffer();
  await pc1.setLocalDescription(offer);
  await pc2.setRemoteDescription(offer);

  const answer = await pc2.createAnswer();
  await pc2.setLocalDescription(answer);
  await pc1.setRemoteDescription(answer);

  console.log("Sesión WebRTC local iniciada");

  return {
    pc1,
    pc2,
    recursos,
    cerrar() {
      for (const r of recursos.receptores) r.stop();
      for (const l of recursos.loopbacks) l.stop();
      for (const e of recursos.emisores) e.stop();

      for (const pc of recursos.pcs) {
        try {
          pc.close();
        } catch {}
      }

      console.log("Sesión cerrada");
    },
  };
}

/* =========================
   WEBHOOK
========================= */

// Verificación simple por GET
app.get("/webhook", (req, res) => {
  res.status(200).send("Webhook activo");
});

// POST para iniciar/detener estado de prueba
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body || {};
    const action = body.action || "start";

    if (action === "start") {
      if (sesionActiva) {
        return res.status(200).json({
          ok: true,
          message: "Ya existe una sesión activa",
        });
      }

      sesionActiva = await iniciarSesionLoopback();

      return res.status(200).json({
        ok: true,
        message: "Sesión WebRTC iniciada",
      });
    }

    if (action === "stop") {
      if (sesionActiva) {
        sesionActiva.cerrar();
        sesionActiva = null;
      }

      return res.status(200).json({
        ok: true,
        message: "Sesión detenida",
      });
    }

    if (action === "status") {
      return res.status(200).json({
        ok: true,
        active: !!sesionActiva,
      });
    }

    return res.status(400).json({
      ok: false,
      message: "Acción no válida. Usa start, stop o status",
    });
  } catch (error) {
    console.error("Error en webhook:", error);
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
  console.log(`GET  /webhook`);
  console.log(`POST /webhook`);
});