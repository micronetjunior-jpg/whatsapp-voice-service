"use strict";

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const META_TOKEN = process.env.META_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const TURN_KEY_API_TOKEN=process.env.TURN_KEY_API_TOKEN;
const TURN_KEY_ID = process.env.TURN_KEY_ID;

const URL_TURN_1 = "turn:turn.cloudflare.com:3478?transport=tcp";
const URL_TURN_2 = "turns:turn.cloudflare.com:443?transport=tcp";
const URL_TURN_3 = "turn:turn.cloudflare.com:80?transport=tcp";
const URL_TURN_4 = "turns:turn.cloudflare.com:5349?transport=tcp";

const TURN_USERNAME = "g0d8cee843b0d9f81f11e446f85eb9933c6e28e313013acf5f7ef7eeccaa85e7";
const TURN_CREDENTIAL = "bada28e4fe6702129a29ab15f5bc06670b7a61a2f92bdd73c7740c087bcfa868";

const PORT = process.env.PORT || 3000;

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const {WebSocket, WebSocketServer } = require("ws");
const http = require("http");

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
// 👇 crear servidor HTTP
const server = http.createServer(app);
app.use(express.json({limit: "2mb"}));


//WKWERNR614A81EBH37T5ATDE recovery code twiilio



const RELOAD_NOTIFY_TO = "573176429931";

const GRAPH_BASE = `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}`;
const CLOUDFLARE_TURN_URL =
  `https://rtc.live.cloudflare.com/v1/turn/keys/${TURN_KEY_ID}/credentials/generate-ice-servers`;

const SAMPLE_RATE = 48000;
const FRAME_SIZE = 480; // 10 ms
const CHANNELS = 1;

const sessions = new Map();







// ─────────────────────────────
// WebSocket con Python (control)
// ─────────────────────────────
let pythonWS = null;

const wss = new WebSocketServer({ server });






























/* =========================
   HELPERS
========================= */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertEnv() {
  const required = [
    "VERIFY_TOKEN",
    "META_TOKEN",
    "PHONE_NUMBER_ID",
    "TURN_KEY_ID",
    "TURN_KEY_API_TOKEN"
  ];

  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Faltan variables de entorno: ${missing.join(", ")}`);
  }
}

async function graphPost(path, payload) {
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${META_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`Graph API ${res.status}: ${text}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function enviarMensajeTexto(to, body) {
  return graphPost("/messages", {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body }
  });
}

async function preAcceptCall(callId, sdpAnswer) {
  return graphPost("/calls", {
    messaging_product: "whatsapp",
    call_id: callId,
    action: "pre_accept",
    session: {
      sdp_type: "answer",
      sdp: sdpAnswer
    }
  });
}

async function acceptCall(callId, sdpAnswer) {
  return graphPost("/calls", {
    messaging_product: "whatsapp",
    call_id: callId,
    action: "accept",
    session: {
      sdp_type: "answer",
      sdp: sdpAnswer
    }
  });
}

async function rejectCall(callId) {
  return graphPost("/calls", {
    messaging_product: "whatsapp",
    call_id: callId,
    action: "reject"
  });
}

async function terminateCall(callId) {
  return graphPost("/calls", {
    messaging_product: "whatsapp",
    call_id: callId,
    action: "terminate"
  });
}

async function obtenerIceServersCloudflare() {
  const res = await fetch(CLOUDFLARE_TURN_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TURN_KEY_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ ttl: 3600 })
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`Cloudflare TURN ${res.status}: ${text}`);
  }

  const data = JSON.parse(text);

  // Filtramos para favorecer TCP/TLS
  const iceServers = (data.iceServers || []).map((server) => {
    if (!server.urls) return server;

    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];

    const filtered = urls.filter((u) => {
      if (u.startsWith("stun:")) return true;
      if (u.includes("transport=tcp")) return true;
      return false;
    });

    return {
      ...server,
      urls: filtered.length ? filtered : urls
    };
  });

  return iceServers;
}

function limpiarSdp(sdp) {
  if (!sdp) return sdp;

  // Dejamos candidates TCP si aparecen en SDP
  return sdp
    .split("\r\n")
    .filter((line) => {
      if (!line.startsWith("a=candidate:")) return true;
      return /\btcp\b/i.test(line);
    })
    .join("\r\n");
}

async function esperarIceCompleto(pc, timeoutMs = 16000) {
  
  console.log(pc.iceGatheringState);
  
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

async function diagnosticarIce(pc, callId = "sin_id") {

  console.log(`===== ICE [${callId}] =====`);

  try {
    const stats = await pc.getStats();
    const byId = new Map();
    let selectedPair = null;

    stats.forEach((report) => {
      byId.set(report.id, report);
      if (
        report.type === "candidate-pair" &&
        (report.selected === true ||
          (report.nominated === true && report.state === "succeeded"))
      ) {
        selectedPair = report;
      }
    });

    

    if (!selectedPair) {
      console.log("No hay candidate pair seleccionado aún");
      return;
    }

    const local = byId.get(selectedPair.localCandidateId);
    const remote = byId.get(selectedPair.remoteCandidateId);

    console.log("LOCAL:", local ? {
      ip: local.ip || local.address,
      port: local.port,
      protocol: local.protocol,
      candidateType: local.candidateType,
      relayProtocol: local.relayProtocol,
      url: local.url
    } : null);

    console.log("REMOTE:", remote ? {
      ip: remote.ip || remote.address,
      port: remote.port,
      protocol: remote.protocol,
      candidateType: remote.candidateType,
      relayProtocol: remote.relayProtocol,
      url: remote.url
    } : null);
  } catch (err) {
    console.error(`[${callId}] error getStats`, err.message);
  }
}

/* =========================
   AUDIO
========================= */

function crearEmisorSilencio() {
  const source = new RTCAudioSource();
  const track = source.createTrack();

  const interval = setInterval(() => {
    const samples = new Int16Array(FRAME_SIZE); // silencio
    source.onData({
      samples,
      sampleRate: SAMPLE_RATE,
      bitsPerSample: 16,
      channelCount: 1
    });
  }, 20);

  return {
    track,
    stop() {
      clearInterval(interval);
      try { track.stop(); } catch {}
    }
  };
}

function crearLoopbackTrack(trackEntrada, callId) {
  const sink = new RTCAudioSink(trackEntrada);
  const source = new RTCAudioSource();
  const trackSalida = source.createTrack();

  sink.ondata = (data) => {
    source.onData(data);
  };

  return {
    track: trackSalida,
    stop() {
      try { sink.stop(); } catch {}
      try { trackSalida.stop(); } catch {}
    }
  };
}

function crearReceptorDebug(track, label) {
  const sink = new RTCAudioSink(track);

  sink.ondata = (data) => {
    //console.log(`[${label}] frame recibido samples=${data.samples.length} sr=${data.sampleRate}`);
  };

  return {
    stop() {
      try { sink.stop(); } catch {}
    }
  };
}




























// ===== Detector simple de silencio =====
class SilenceDetector {
  constructor({
    threshold = 900,
    speechFramesStart = 6,
    silenceFramesEnd = 30
  } = {}) {
    this.threshold = threshold;
    this.speechFramesStart = speechFramesStart;
    this.silenceFramesEnd = silenceFramesEnd;

    this.speechCount = 0;
    this.silenceCount = 0;
    this.isSpeaking = false;
  }

  rms(int16Samples) {
    let sum = 0;
    for (let i = 0; i < int16Samples.length; i++) {
      const s = int16Samples[i];
      sum += s * s;
    }
    return Math.sqrt(sum / int16Samples.length);
  }

  update(samples) {
    const level = this.rms(samples);
    const silent = level < this.threshold;

    if (!this.isSpeaking) {
      if (!silent) {
        this.speechCount += 1;
        if (this.speechCount >= this.speechFramesStart) {
          this.isSpeaking = true;
          this.silenceCount = 0;
        }
      } else {
        this.speechCount = 0;
      }
      return {
        level,
        silent,
        started: this.isSpeaking,
        ended: false,
        speaking: this.isSpeaking
      };
    }

    // ya está hablando
    if (silent) {
      this.silenceCount += 1;
      if (this.silenceCount >= this.silenceFramesEnd) {
        this.isSpeaking = false;
        this.speechCount = 0;
        this.silenceCount = 0;
        return {
          level,
          silent,
          started: false,
          ended: true,
          speaking: false
        };
      }
    } else {
      this.silenceCount = 0;
    }

    return {
      level,
      silent,
      started: false,
      ended: false,
      speaking: true
    };
  }
}









// ===== Reproductor de frames =====
class BufferedEchoPlayer {
  constructor() {
    this.source = new RTCAudioSource();
    this.track = this.source.createTrack();
    this.queue = [];
    this.playing = false;
  }

  enqueueFrame(frame) {
    this.queue.push(frame);
  }

  async playAll() {
    if (this.playing) return;
    this.playing = true;

    while (this.queue.length > 0) {
      const frame = this.queue.shift();

      this.source.onData({
        samples: frame.samples,
        sampleRate: frame.sampleRate,
        bitsPerSample: 16,
        channelCount: frame.channelCount
      });

      await new Promise((r) => setTimeout(r, 10));
    }

    this.playing = false;
  }

  stop() {
    try {
      this.track.stop();
    } catch {}
  }
}









const player = new BufferedEchoPlayer();

// ===== Conecta un track remoto a eco por turnos =====
function crearEcoPorSilencio(remoteTrack, pc, callId = "call") {
  const sink = new RTCAudioSink(remoteTrack);
  const detector = new SilenceDetector({
    threshold: 900,
    speechFramesStart: 8,
    silenceFramesEnd: 80
  });

  
  pc.addTrack(player.track);

  let buffer = [];
  let recording = false;

  sink.ondata = async (audio) => {
    const samples = new Int16Array(audio.samples);
    const state = detector.update(samples);

    if (state.started && !recording) {
      recording = true;
      buffer = [];
      console.log(`[${callId}] usuario empezó a hablar`);
    }

    if (recording) {
      buffer.push({
        samples: new Int16Array(samples),
        sampleRate: audio.sampleRate,
        channelCount: audio.channelCount
      });
    }

    if (state.ended && recording) {
      recording = false;
      console.log(`[${callId}] usuario dejó de hablar. Reproduciendo ${buffer.length} frames`);

      if (pythonWS?.readyState === WebSocket.OPEN) {
        pythonWS.send(JSON.stringify({
          type: "TURN_AUDIO_START",
          callId,
          frames: buffer.length,
          sampleRate: buffer[0]?.sampleRate || 48000,
          channelCount: buffer[0]?.channelCount || 1
        }));
      }

      for (const frame of buffer) {
        //player.enqueueFrame(frame);

        if (pythonWS?.readyState === WebSocket.OPEN) {
          const audioBuffer = Buffer.from(
            frame.samples.buffer,
            frame.samples.byteOffset,
            frame.samples.byteLength
          );

          pythonWS.send(audioBuffer);
        }
      }

      if (pythonWS?.readyState === WebSocket.OPEN) {
        pythonWS.send(JSON.stringify({
          type: "TURN_AUDIO_END",
          callId
        }));
      }

      buffer = [];
      //player.playAll().catch((err) => {
      //  console.error(`[${callId}] error reproduciendo`, err);
      //});
    }
  };



}





































class OpenAIRealtimeSession {
  constructor({
    apiKey,
    model = "gpt-realtime-mini",
    instructions = "Responde de forma breve y clara."
  }) {
    this.apiKey = apiKey;
    this.model = model;
    this.instructions = instructions;
    this.ws = null;
    this.isReady = false;
  }

  track(remoteTrack,pc,callId)
  {

    const sink = new RTCAudioSink(remoteTrack);
    const detector = new SilenceDetector({
      threshold: 900,
      speechFramesStart: 8,
      silenceFramesEnd: 80
    });

    const player = new BufferedEchoPlayer();
    pc.addTrack(player.track);

    let buffer = [];
    let recording = false;

    sink.ondata = async (audio) => {
      const samples = new Int16Array(audio.samples);
      const state = detector.update(samples);

      if (state.started && !recording) {
        recording = true;
        buffer = [];
        console.log(`[${callId}] usuario empezó a hablar`);
      }

      if (recording) {
        buffer.push({
          samples: new Int16Array(samples),
          sampleRate: audio.sampleRate,
          channelCount: audio.channelCount
        });
      }

      if (state.ended && recording) {
        recording = false;
        console.log(`[${callId}] usuario dejó de hablar. Reproduciendo ${buffer.length} frames`);

        for (const frame of buffer) {
          player.enqueueFrame(frame);
        }

        buffer = [];
        player.playAll().catch((err) => {
          console.error(`[${callId}] error reproduciendo`, err);
        });
      }
    };

    return {
      track: player.track,
      stop() {
        try { sink.stop(); } catch {}
        try { player.stop(); } catch {}
      }
    };

  }

  connect() {
    return new Promise((resolve, reject) => {
      const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.model)}`;

      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "OpenAI-Beta": "realtime=v1"
        }
      });

      this.ws.on("open", () => {
        console.log("✅ WS conectado a OpenAI Realtime");
      });

      this.ws.on("message", (raw) => {
        try {
          const event = JSON.parse(raw.toString());

          console.log("⬅️ Realtime event:", event.type);

          if (event.type === "session.created") {
            this.updateSession({
              instructions: this.instructions,
              modalities: ["text", "audio"],
              input_audio_format: "pcm16",
              output_audio_format: "pcm16"
            });
          }

          if (event.type === "session.updated") {
            this.isReady = true;
            console.log("✅ Sesión Realtime lista");
            resolve();
          }

          if (event.type === "response.audio.delta") {
            // Aquí recibirías audio generado en chunks
            // event.delta suele venir en base64
          }

          if (event.type === "response.done") {
            console.log("✅ Respuesta finalizada");
          }
        } catch (err) {
          console.error("Error parseando evento Realtime:", err);
        }
      });

      this.ws.on("error", (err) => {
        console.error("❌ Error WS Realtime:", err.message);
        reject(err);
      });

      this.ws.on("close", () => {
        this.isReady = false;
        console.log("🔌 WS Realtime cerrado");
      });
    });
  }

  send(event) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket Realtime no está abierto");
    }
    this.ws.send(JSON.stringify(event));
  }

  updateSession({
    instructions,
    modalities = ["text", "audio"],
    input_audio_format = "pcm16",
    output_audio_format = "pcm16"
  }) {
    this.send({
      type: "session.update",
      session: {
        instructions,
        modalities,
        input_audio_format,
        output_audio_format
      }
    });
  }

  sendUserText(text) {
    this.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text
          }
        ]
      }
    });

    this.send({
      type: "response.create"
    });
  }

  appendAudioBase64(base64Audio) {
    this.send({
      type: "input_audio_buffer.append",
      audio: base64Audio
    });
  }

  commitAudio() {
    this.send({
      type: "input_audio_buffer.commit"
    });

    this.send({
      type: "response.create"
    });
  }

  close() {
    if (this.ws) {
      this.ws.close();
    }
  }
}




































/* =========================
   WEBRTC
========================= */

async function crearPeer(callId) {

  const iceServersRaw = await obtenerIceServersCloudflare();

  const iceServers = iceServersRaw.filter(s => s.username);

  const pc = new RTCPeerConnection({
    iceServers,
    iceTransportPolicy: "relay"
  });

  
  //console.log("ICE SERVERS:");
  //console.log(iceServers);

  //const iceServers = iceServersRAW[1];

  const recursos = {
    silentSender: null,
    loopbacks: [],
    sinks: []
  };

  pc.onicecandidate = (event) => {
    if (!event.candidate) {
      console.log(`[${callId}] ICE gathering finalizado`);
      return;
    }
    console.log(`[${callId}] ICE local: ${event.candidate.candidate}`);
    
  };

  pc.oniceconnectionstatechange = () => {
    console.log(`[${callId}] iceConnectionState=${pc.iceConnectionState}`);
    console.log("ICE Cambió estado...");
    if (
      pc.iceConnectionState === "connected" ||
      pc.iceConnectionState === "completed"
    ) {
      console.log("DIAGNOSTICAR...");
      //setTimeout(() => diagnosticarIce(pc, callId), 1000);
    }
    else
    {
      console.log(pc.iceConnectionState)
    }
  };

  pc.onconnectionstatechange = () => {
    console.log(`[${callId}] connectionState=${pc.connectionState}`);

    if (
      pc.connectionState === "failed" ||
      pc.connectionState === "closed" ||
      pc.connectionState === "disconnected"
    ) {
      cerrarSesion(callId).catch((e) => {
        console.error(`[${callId}] error cerrando`, e.message);
      });
    }
  };

  // Track de salida base para que Meta tenga audio saliente
  //recursos.silentSender = crearEmisorSilencio();
  //pc.addTrack(recursos.silentSender.track);

  pc.ontrack = (event) => {
    const remoteTrack = event.track;
    console.log(`[${callId}] track remoto recibido kind=${remoteTrack.kind}`);


    pythonWS?.send(JSON.stringify({
      type: "control",
      data: "ok"
    }));

    //const ws = crearWsPython(callId);








    /*
    const realtime = new OpenAIRealtimeSession({
      apiKey: process.env.OPENAI_API_KEY,
      model: "gpt-realtime",
      instructions: "Habla en español, breve y natural."
    });
    const loop = realtime.track(remoteTrack,pc,callId);
    recursos.loopbacks.push(loop);
    */

    //await rt.connect();

    // prueba de texto
    //rt.sendUserText("Hola, esta es una prueba desde Node.");





    const loop = crearEcoPorSilencio(remoteTrack,pc,callId);
    recursos.loopbacks.push(loop);

    //const sink = crearReceptorDebug(remoteTrack, `${callId}_IN`);
    //recursos.sinks.push(sink);

    //const loop = crearLoopbackTrack(remoteTrack, callId);
    //recursos.loopbacks.push(loop);
    //pc.addTrack(loop.track);
  };

  return { pc, recursos };
}

async function crearAnswer(pc, offerSdp) {
  const remote = new RTCSessionDescription({
    type: "offer",
    sdp: offerSdp//limpiarSdp(offerSdp)
  });

  await pc.setRemoteDescription(remote);

  
  //answer = new RTCSessionDescription({
  //  type: "answer",
    //sdp: limpiarSdp(answer.sdp)
  //});
  await esperarIceCompleto(pc, 16000);

  let answer = await pc.createAnswer();
  
  await pc.setLocalDescription(answer);

  return answer
  
  

  /*
  return new RTCSessionDescription({
    type: "answer",
    sdp: answer.sdp
    //sdp: pc.localDescription.sdp
    //sdp: limpiarSdp(pc.localDescription.sdp)
  });
  */

}

/* =========================
   SESIONES
========================= */

async function cerrarSesion(callId) {
  const s = sessions.get(callId);
  if (!s) return;

  try {
    for (const x of s.recursos.sinks) x.stop();
    for (const x of s.recursos.loopbacks) x.stop();
    if (s.recursos.silentSender) s.recursos.silentSender.stop();
    if (s.pc) s.pc.close();
  } catch (err) {
    console.error(`[${callId}] error liberando recursos`, err.message);
  }

  sessions.delete(callId);
  console.log(`[${callId}] sesión cerrada`);
}

async function manejarConnect(call) {
  const callId = call.id || call.call_id || call.callId;
  const offerSdp = call.session?.sdp;

  if (!callId || !offerSdp) {
    console.error("connect sin callId o sin SDP");
    return;
  }

  if (sessions.has(callId)) {
    console.log(`[${callId}] sesión ya existe`);
    return;
  }

  console.log(`[${callId}] CONNECT recibido`);

  const { pc, recursos } = await crearPeer(callId);
  sessions.set(callId, { pc, recursos });

  try {
    const answer = await crearAnswer(pc, offerSdp);

    console.log(answer);

    await preAcceptCall(callId, answer.sdp);
    await sleep(400);
    await acceptCall(callId, answer.sdp);

    console.log(`[${callId}] llamada aceptada`);
  } catch (err) {
    console.error(`[${callId}] error connect`, err.message);
    try {
      await rejectCall(callId);
    } catch (e) {
      console.error(`[${callId}] error reject`, e.message);
    }
    await cerrarSesion(callId);
  }
}

async function manejarTerminate(call) {
  const callId = call.id || call.call_id || call.callId;
  if (!callId) return;

  console.log(`[${callId}] TERMINATE recibido`);

  try {
    await terminateCall(callId);
  } catch (err) {
    console.error(`[${callId}] terminate Graph error`, err.message);
  }

  await cerrarSesion(callId);
}

/* =========================
   WEBHOOK
========================= */

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado");
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    if (!body || body.object !== "whatsapp_business_account") return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};

        if (Array.isArray(value.calls)) {
          for (const call of value.calls) {
            console.log("Evento llamada:", call.event);

            if (call.event === "connect") {
              await manejarConnect(call);
            } else if (call.event === "terminate") {
              await manejarTerminate(call);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error("Error en webhook POST", err.message);
  }
});

/* =========================
   ARRANQUE
========================= */

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    activeCalls: sessions.size
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    activeCalls: sessions.size,
    callIds: [...sessions.keys()]
  });
});










function bufferToFrame(buffer, sampleRate = 48000, channelCount = 1) {
  const samples = new Int16Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength / 2
  );

  return {
    samples,
    sampleRate,
    channelCount
  };
}


wss.on("connection", ws => 
  {
  pythonWS = ws;
  console.log("🐍 Python conectado");

  ws.on("close", () => {
    pythonWS = null;
    console.log("🐍 Python desconectado");
  });

  let returningAudio = false;
  let returnSampleRate = 48000;
  let returnChannelCount = 1;
  let frames = [];

  pythonWS.on("message", async (data, isBinary) => {

    if(isBinary)
    {
      if(returningAudio)
      {
        const frame = bufferToFrame(data);
        player.enqueueFrame(frame);

      }
      //console.log("Es binario");
    }
    else{
      const msg = JSON.parse(data.toString());
      const type = msg.type;
      const callId = msg.callId;
      if(type === "RETURN_AUDIO_START")
      {
        returningAudio = true;
      }
      if(type === "RETURN_AUDIO_END")
      {
        returningAudio = false;
        player.playAll().catch((err) => {
          console.error(`error reproduciendo`, err);
        });

      }
    }
    
    
  });


});
















async function main() {
  assertEnv();

  server.listen(PORT, async () => {
    console.log(`Servidor escuchando en ${PORT}`);

    try {
      await enviarMensajeTexto(RELOAD_NOTIFY_TO, "Reload Ok");
      console.log("Mensaje de arranque enviado");
    } catch (err) {
      console.error("No se pudo enviar Reload Ok:", err.message);
    }
  });
}

main().catch((err) => {
  console.error("Fallo fatal al iniciar:", err);
  process.exit(1);
});