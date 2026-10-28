// Stage 3: the WebSocket relay. Uses a tiny echo server built from Node's own
// modules, and Node's built-in WebSocket client (Node 22+).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { handleWebSocket, encodeWsPath, decodeWsPath } from "../websocket.js";

// ---------- a minimal WebSocket echo server ----------

function acceptKey(key) {
  return crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
}
function frame(opcode, payload) {
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | opcode, len]) : Buffer.from([0x80 | opcode, 126, len >> 8, len & 255]);
  return Buffer.concat([head, payload]);
}
// Parses client frames (always masked) and calls onFrame(opcode, payload).
function frameReader(onFrame) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      let len = buf[1] & 127;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      }
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      onFrame(buf[0] & 15, payload);
      buf = buf.subarray(off + 4 + len);
    }
  };
}

let site, sitePort, seen;
let relay, relayUrl, strict, strictUrl;
const logs = [];
const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(s.address().port)));

before(async () => {
  site = http.createServer((req, res) => res.end("not a websocket"));
  site.on("upgrade", (req, socket) => {
    seen = { origin: req.headers.origin, path: req.url, protocol: req.headers["sec-websocket-protocol"], cookie: req.headers.cookie };
    if (req.url.startsWith("/refuse")) {
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const lines = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey(req.headers["sec-websocket-key"])}`,
      "Set-Cookie: tracking=1",
    ];
    if (req.headers["sec-websocket-protocol"]) lines.push(`Sec-WebSocket-Protocol: ${req.headers["sec-websocket-protocol"].split(",")[0].trim()}`);
    socket.write(lines.join("\r\n") + "\r\n\r\n");
    socket.on("data", frameReader((op, payload) => {
      if (op === 8) return socket.end(frame(8, payload)); // close
      if (op === 1) socket.write(frame(1, Buffer.from("echo:" + payload.toString())));
      if (op === 2) socket.write(frame(2, Buffer.from([...payload].reverse())));
    }));
  });
  sitePort = await listen(site);

  const make = (opts) => {
    const s = http.createServer((req, res) => res.end());
    s.on("upgrade", (req, socket, head) => handleWebSocket(req, socket, head, { ...opts, log: (...a) => logs.push(a) }));
    return s;
  };
  relay = make({ allowPrivate: true, allowedPorts: null });
  relayUrl = `ws://127.0.0.1:${await listen(relay)}`;
  strict = make({ allowedPorts: null });
  strictUrl = `ws://127.0.0.1:${await listen(strict)}`;
});
after(() => {
  site.close();
  relay.close();
  strict.close();
});

function open(url, protocols) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocols);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("WebSocket failed to open"));
  });
}
const next = (ws) => new Promise((r) => (ws.onmessage = (e) => r(e.data)));

test("address encoding round trip", () => {
  const p = encodeWsPath("wss://chat.example.com/socket?x=1", "https://chat.example.com");
  const d = decodeWsPath(p);
  assert.equal(d.target.href, "wss://chat.example.com/socket?x=1");
  assert.equal(d.origin, "https://chat.example.com");
  assert.equal(decodeWsPath(encodeWsPath("https://example.com/")), null, "only ws:// and wss:// targets");
});

test("text and binary messages are relayed both ways", async () => {
  const ws = await open(relayUrl + encodeWsPath(`ws://127.0.0.1:${sitePort}/chat?room=1`, "https://chat.example.com"), ["chat.v1", "chat.v2"]);
  assert.equal(ws.protocol, "chat.v1", "subprotocol negotiated end to end");
  ws.send("hello");
  assert.equal(await next(ws), "echo:hello");
  ws.send(new Uint8Array([1, 2, 3]));
  assert.deepEqual([...new Uint8Array(await next(ws))], [3, 2, 1]);
  const long = "x".repeat(500);
  ws.send(long);
  assert.equal(await next(ws), "echo:" + long);
  const closed = new Promise((r) => (ws.onclose = (e) => r(e.code)));
  ws.close(4000, "bye");
  assert.equal(await closed, 4000);
});

test("the site sees the real page's origin and path, and no cookies leak back", async () => {
  const ws = await open(relayUrl + encodeWsPath(`ws://127.0.0.1:${sitePort}/live?id=7`, "https://news.example.com"));
  assert.equal(seen.origin, "https://news.example.com");
  assert.equal(seen.path, "/live?id=7");
  assert.equal(seen.cookie, undefined);
  ws.close();
});

test("a site that refuses the WebSocket is reported as the site's answer", async () => {
  logs.length = 0;
  await assert.rejects(open(relayUrl + encodeWsPath(`ws://127.0.0.1:${sitePort}/refuse`)));
  assert.ok(logs.some(([status, , , source]) => status === 403 && source === "upstream"), JSON.stringify(logs));
});

test("SSRF: private and local WebSocket targets are refused", async () => {
  for (const target of [`ws://127.0.0.1:${sitePort}/chat`, `ws://localhost:${sitePort}/`, "ws://10.0.0.1/", "wss://169.254.169.254/"]) {
    logs.length = 0;
    await assert.rejects(open(strictUrl + encodeWsPath(target)), target);
    assert.equal(logs[0]?.[0], 403, target + " " + JSON.stringify(logs));
  }
});

test("garbage addresses are rejected", async () => {
  logs.length = 0;
  await assert.rejects(open(relayUrl + "/ws/not-base64-at-all"));
  assert.equal(logs[0]?.[0], 400);
});
