const VERIFY_TOKEN = "mi_token";
const META_TOKEN = process.env.HEALTHCARE_WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.HEALTHCARE_WHATSAPP_PHONE_NUMBER_ID;


const TURN_URL_1="turn:academiabot.digital:3478?transport=tcp";
const TURN_URL_2="turns:academiabot.digital:5349?transport=tcp";
const TURN_USERNAME="admin"
const TURN_PASSWORD="1234"

const PORT = process.env.PORT || 3000;

"use strict";

const express = require("express");
const axios = require("axios");
//const wrtc = require("wrtc");

//const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, nonstandard } = wrtc;
const {
    RTCPeerConnection,
    nonstandard,
    RTCSessionDescription,
    RTCIceCandidate,
    MediaStream,
} = require("@roamhq/wrtc");

const { RTCAudioSource, RTCAudioSink } = nonstandard;

const app = express();
app.use(express.json({ limit: "2mb" }));


//const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
//const META_TOKEN = process.env.META_TOKEN;
//const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

//const TURN_URL_1 = process.env.TURN_URL_1;
//const TURN_URL_2 = process.env.TURN_URL_2;
//const TURN_USERNAME = process.env.TURN_USERNAME;
//const TURN_PASSWORD = process.env.TURN_PASSWORD;

const GRAPH_BASE = `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}`;

const SAMPLE_RATE = 48000;
const FRAME_SIZE = 480; // 10 ms a 48 kHz

// Guarda las sesiones activas por call_id
const callSessions = new Map();

/* =========================================================
   HELPERS GENERALES
========================================================= */

function assertEnv() {
  const missing = [];
  if (!VERIFY_TOKEN) missing.push("VERIFY_TOKEN");
  if (!META_TOKEN) missing.push("META_TOKEN");
  if (!PHONE_NUMBER_ID) missing.push("PHONE_NUMBER_ID");
  if (!TURN_URL_1 && !TURN_URL_2) missing.push("TURN_URL_1 o TURN_URL_2");
  if (!TURN_USERNAME) missing.push("TURN_USERNAME");
  if (!TURN_PASSWORD) missing.push("TURN_PASSWORD");

  if (missing.length) {
    console.error("Faltan variables de entorno:", missing.join(", "));
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function esCandidatoTcp(candidateStr = "") {
  return /\btcp\b/i.test(candidateStr);
}

function esCandidatoRelay(candidateStr = "") {
  return /\btyp relay\b/i.test(candidateStr);
}

function limpiarSdpSoloTcp(sdp = "") {
  return sdp
    .split("\r\n")
    .filter((line) => {
      if (!line.startsWith("a=candidate:")) return true;
      return /\btcp\b/i.test(line);
    })
    .join("\r\n");
}

function forzarSetupPassiveEnAnswer(sdp = "") {
  // En un answer, normalmente conviene passive en DTLS
  return sdp.replace(/a=setup:actpass/g, "a=setup:passive");
}

function resumenSdp(sdp = "") {
  return sdp
    .split("\r\n")
    .filter((l) => l.startsWith("m=") || l.startsWith("a=candidate:") || l.startsWith("a=setup:"))
    .join("\n");
}

async function esperarIceCompleto(pc, timeoutMs = 8000) {
  if (pc.iceGatheringState === "complete") return;

  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      pc.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    }, timeoutMs);

    function onChange() {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(timer);
        pc.removeEventListener("icegatheringstatechange", onChange);
        resolve();
      }
    }

    pc.addEventListener("icegatheringstatechange", onChange);
  });
}

/* =========================================================
   AUDIO: EMITIR / RECIBIR / LOOPBACK
========================================================= */

function crearEmisorAudioPrueba() {
  const source = new RTCAudioSource();
  const track = source.createTrack();

  let sampleIndex = 0;
  const freq = 440;

  const interval = setInterval(() => {
    const samples = new Int16Array(FRAME_SIZE);

    for (let i = 0; i < FRAME_SIZE; i++) {
      const value = Math.sin(2 * Math.PI * freq * (sampleIndex / SAMPLE_RATE));
      samples[i] = Math.max(-32768, Math.min(32767, value * 12000));
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

function crearReceptorAudio(track, label = "RX") {
  const sink = new RTCAudioSink(track);

  sink.ondata = (data) => {
    //console.log(
    //  `[${label}] frame recibido | samples=${data.samples.length} | sr=${data.sampleRate} | ch=${data.channelCount}`
    //);
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

/* =========================================================
   WEBRTC
========================================================= */

function crearPeerConnection(callId) {
  const iceServers = [
    {
      urls: [TURN_URL_1, TURN_URL_2].filter(Boolean),
      username: TURN_USERNAME,
      credential: TURN_PASSWORD,
    },
  ];

  const pc = new RTCPeerConnection({
    iceTransportPolicy: "relay",
    iceServers,
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require",
  });

  pc.onicecandidate = (event) => {
    if (!event.candidate) {
      console.log(`[${callId}] ICE gathering finalizado`);
      return;
    }

    const cand = event.candidate.candidate || "";

    if (esCandidatoTcp(cand) && esCandidatoRelay(cand)) {
      console.log(`[${callId}] ICE TCP relay OK: ${cand}`);
    } else {
      console.log(`[${callId}] ICE descartado: ${cand}`);
    }
  };

  pc.oniceconnectionstatechange = () => {
    console.log(`[${callId}] iceConnectionState=${pc.iceConnectionState}`);
  };

  pc.onconnectionstatechange = () => {
    console.log(`[${callId}] connectionState=${pc.connectionState}`);
  };

  pc.onicegatheringstatechange = () => {
    console.log(`[${callId}] iceGatheringState=${pc.iceGatheringState}`);
  };

  return pc;
}

function prepararMediaParaSesion(pc, callId) {
  const recursos = {
    emisor: null,
    receptores: [],
    loopbacks: [],
  };

  // Emisor local de prueba
  recursos.emisor = crearEmisorAudioPrueba();
  pc.addTrack(recursos.emisor.track);

  pc.ontrack = (event) => {
    const incomingTrack = event.track;
    console.log(`[${callId}] track remoto recibido kind=${incomingTrack.kind}`);

    const receptor = crearReceptorAudio(incomingTrack, `${callId}_IN`);
    recursos.receptores.push(receptor);

    // Loopback: lo que entra vuelve a salir
    const loop = crearLoopbackTrack(incomingTrack);
    recursos.loopbacks.push(loop);
    pc.addTrack(loop.track);
  };

  return recursos;
}

async function crearAnswerSoloTcp(pc, remoteOfferSdp) {
  const remote = new RTCSessionDescription({
    type: "offer",
    sdp: limpiarSdpSoloTcp(remoteOfferSdp),
  });

  await pc.setRemoteDescription(remote);

  let answer = await pc.createAnswer();
  answer = new RTCSessionDescription({
    type: "answer",
    sdp: forzarSetupPassiveEnAnswer(limpiarSdpSoloTcp(answer.sdp)),
  });

  await pc.setLocalDescription(answer);
  await esperarIceCompleto(pc, 8000);

  const finalAnswer = new RTCSessionDescription({
    type: "answer",
    sdp: forzarSetupPassiveEnAnswer(limpiarSdpSoloTcp(pc.localDescription.sdp)),
  });

  return finalAnswer;
}

/* =========================================================
   GRAPH API META
========================================================= */

async function graphPost(path, payload) {
  const url = `${GRAPH_BASE}${path}`;

  const response = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${META_TOKEN}`,
      "Content-Type": "application/json",
    },
    timeout: 20000,
  });

  return response.data;
}

async function enviarMensajeTexto(to, text) {
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
  };

  const data = await graphPost("/messages", payload);
  console.log("Mensaje enviado:", data);
  return data;
}

async function preAcceptCall(callId, sdpAnswer) {
  const payload = {
    messaging_product: "whatsapp",
    call_id: callId,
    action: "pre_accept",
    session: {
      sdp_type: "answer",
      sdp: sdpAnswer,
    },
  };

  const data = await graphPost("/calls", payload);
  console.log(`[${callId}] pre_accept OK`, data);
  return data;
}

async function acceptCall(callId, sdpAnswer) {
  const payload = {
    messaging_product: "whatsapp",
    call_id: callId,
    action: "accept",
    session: {
      sdp_type: "answer",
      sdp: sdpAnswer,
    },
  };

  const data = await graphPost("/calls", payload);
  console.log(`[${callId}] accept OK`, data);
  return data;
}

async function rejectCall(callId) {
  const payload = {
    messaging_product: "whatsapp",
    call_id: callId,
    action: "reject",
  };

  const data = await graphPost("/calls", payload);
  console.log(`[${callId}] reject OK`, data);
  return data;
}

async function terminateCall(callId) {
  const payload = {
    messaging_product: "whatsapp",
    call_id: callId,
    action: "terminate",
  };

  const data = await graphPost("/calls", payload);
  console.log(`[${callId}] terminate OK`, data);
  return data;
}

/* =========================================================
   CICLO DE VIDA DE LLAMADA
========================================================= */

function cerrarSesion(callId) {
  const session = callSessions.get(callId);
  if (!session) return;

  try {
    for (const r of session.recursos.receptores) r.stop();
    for (const l of session.recursos.loopbacks) l.stop();
    if (session.recursos.emisor) session.recursos.emisor.stop();
    if (session.pc) session.pc.close();
  } catch (err) {
    console.error(`[${callId}] error cerrando sesión`, err.message);
  }

  callSessions.delete(callId);
  console.log(`[${callId}] sesión cerrada`);
}

async function manejarConnectCall(call) {
  const callId = call.id || call.call_id || call.callId;
  const remoteSdp = call.session?.sdp;

  if (!callId) {
    console.error("No llegó callId en el evento calls.connect");
    return;
  }

  if (!remoteSdp) {
    console.error(`[${callId}] No llegó session.sdp en calls.connect`);
    return;
  }

  if (callSessions.has(callId)) {
    console.log(`[${callId}] ya existe una sesión activa`);
    return;
  }

  console.log(`[${callId}] CONNECT recibido`);
  console.log(`[${callId}] SDP remoto resumen:\n${resumenSdp(remoteSdp)}`);

  const pc = crearPeerConnection(callId);
  const recursos = prepararMediaParaSesion(pc, callId);

  callSessions.set(callId, {
    callId,
    pc,
    recursos,
    state: "connecting",
  });

  try {
    const answer = await crearAnswerSoloTcp(pc, remoteSdp);

    console.log(`[${callId}] SDP answer resumen:\n${resumenSdp(answer.sdp)}`);

    // 1) pre_accept
    await preAcceptCall(callId, answer.sdp);

    // Pausa breve para dar tiempo al establecimiento
    await sleep(500);

    // 2) accept
    await acceptCall(callId, answer.sdp);

    const session = callSessions.get(callId);
    if (session) session.state = "accepted";

    console.log(`[${callId}] llamada pre-accept + accept enviada`);
  } catch (err) {
    console.error(
      `[${callId}] error en connect:`,
      err.response?.data || err.message
    );

    try {
      await rejectCall(callId);
    } catch (rejectErr) {
      console.error(
        `[${callId}] error haciendo reject:`,
        rejectErr.response?.data || rejectErr.message
      );
    }

    cerrarSesion(callId);
  }
}

async function manejarTerminateCall(call) {
  const callId = call.id || call.call_id || call.callId;
  if (!callId) return;

  console.log(`[${callId}] TERMINATE recibido`);

  try {
    await terminateCall(callId);
  } catch (err) {
    console.error(
      `[${callId}] terminate Graph error:`,
      err.response?.data || err.message
    );
  }

  cerrarSesion(callId);
}

/* =========================================================
   WEBHOOK
========================================================= */

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado con Meta");
    return res.status(200).send(challenge);
  }

  console.error("Verificación fallida");
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  // responder rápido a Meta
  res.sendStatus(200);

  try {
    const body = req.body;
    if (!body || body.object !== "whatsapp_business_account") {
      return;
    }

    const entries = Array.isArray(body.entry) ? body.entry : [];

    for (const entry of entries) {
      const changes = Array.isArray(entry.changes) ? entry.changes : [];

      for (const change of changes) {
        const value = change.value || {};

        // Mensajes
        if (Array.isArray(value.messages) && value.messages.length > 0) {
          for (const msg of value.messages) {
            const from = msg.from;
            const type = msg.type;
            console.log(`Mensaje recibido from=${from} type=${type}`);

            if (from) {
              try {
                await enviarMensajeTexto(from, "Hola 👋 webhook activo y operativo.");
              } catch (err) {
                console.error("Error enviando mensaje:", err.response?.data || err.message);
              }
            }
          }
        }

        // Llamadas
        if (Array.isArray(value.calls) && value.calls.length > 0) {
          for (const call of value.calls) {
            const event = call.event;
            console.log("Evento de llamada recibido:", event);

            if (event === "connect") {
              await manejarConnectCall(call);
            } else if (event === "terminate") {
              await manejarTerminateCall(call);
            } else {
              console.log("Evento de llamada no manejado:", event);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error("Error en POST /webhook:", err.response?.data || err.message);
  }
});

/* =========================================================
   ENDPOINTS DE APOYO
========================================================= */

app.get("/", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "meta-call-webrtc-tcp-relay",
    activeCalls: callSessions.size,
  });
});

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    activeCalls: callSessions.size,
    callIds: Array.from(callSessions.keys()),
  });
});

app.post("/close/:callId", async (req, res) => {
  const { callId } = req.params;

  if (!callSessions.has(callId)) {
    return res.status(404).json({ ok: false, message: "callId no encontrado" });
  }

  try {
    await terminateCall(callId);
  } catch (err) {
    console.error("Error terminando por endpoint:", err.response?.data || err.message);
  }

  cerrarSesion(callId);

  return res.status(200).json({ ok: true, message: "Llamada cerrada" });
});

/* =========================================================
   START
========================================================= */

assertEnv();

app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
  console.log(`GET  /webhook`);
  console.log(`POST /webhook`);
  console.log(`GET  /health`);
  enviarMensajeTexto("573176429931","Reload NodeJS")
});

//WKWERNR614A81EBH37T5ATDE recovery code twiilio