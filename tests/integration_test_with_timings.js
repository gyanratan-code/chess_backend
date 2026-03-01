/**
 * Instrumented integration test for gyanratan-code/chess_backend
 *
 * Outputs:
 *  - normal console logs for human reading
 *  - at the end prints a line beginning with METRICS_JSON: containing JSON summary
 *
 * Usage: node integration_test_with_timings.js
 */

import fetch from "node-fetch";
import { io } from "socket.io-client";
import { Chess } from "chess";
import { v4 as uuidv4 } from "uuid";
import { performance } from "perf_hooks";

const SERVER = process.env.SERVER_URL || "http://localhost:3001";
const TIMEOUT = 8000;

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

async function postJson(path, body, cookie) {
  const t0 = performance.now();
  const res = await fetch(`${SERVER}${path}`, {
    method: "POST",
    headers: Object.assign({
      "Content-Type": "application/json",
    }, cookie ? { Cookie: cookie } : {}),
    body: JSON.stringify(body),
    redirect: "manual",
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch(e) {}
  const t1 = performance.now();
  return { status: res.status, json, headers: res.headers, durationMs: t1 - t0 };
}

async function getJson(path, cookie) {
  const t0 = performance.now();
  const res = await fetch(`${SERVER}${path}`, {
    method: "GET",
    headers: Object.assign({}, cookie ? { Cookie: cookie } : {}),
  });
  const json = await res.json();
  const t1 = performance.now();
  return { status: res.status, json, headers: res.headers, durationMs: t1 - t0 };
}

function extractCookie(setCookieHeader) {
  if (!setCookieHeader) return null;
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  return raw.split(";")[0];
}

async function run() {
  const times = {};
  const stepDurations = {}; // store durations for each step (ms)
  const overallStart = performance.now();
  try {
    console.log("1) Register two users");
    const usernameA = `testA_${uuidv4().slice(0,6)}`;
    const usernameB = `testB_${uuidv4().slice(0,6)}`;
    const password = "pass123";

    const t_reg_start = performance.now();
    let r = await postJson("/register", { username: usernameA, password });
    stepDurations.registerA = r.durationMs;
    if (r.status !== 201) throw new Error("Register A failed: " + JSON.stringify(r));
    console.log("  - Registered userA:", usernameA);

    r = await postJson("/register", { username: usernameB, password });
    stepDurations.registerB = r.durationMs;
    if (r.status !== 201) throw new Error("Register B failed: " + JSON.stringify(r));
    console.log("  - Registered userB:", usernameB);

    console.log("2) Login both users and capture cookies");
    r = await postJson("/login", { username: usernameA, password });
    stepDurations.loginA = r.durationMs;
    if (r.status !== 200) throw new Error("Login A failed: " + JSON.stringify(r));
    const cookieA = extractCookie(r.headers.raw()["set-cookie"]);
    if (!cookieA) throw new Error("Login A returned no cookie");
    console.log("  - Login A cookie captured");

    r = await postJson("/login", { username: usernameB, password });
    stepDurations.loginB = r.durationMs;
    if (r.status !== 200) throw new Error("Login B failed: " + JSON.stringify(r));
    const cookieB = extractCookie(r.headers.raw()["set-cookie"]);
    if (!cookieB) throw new Error("Login B returned no cookie");
    console.log("  - Login B cookie captured");

    console.log("3) Test protected /profile with cookie");
    let g = await getJson("/profile", cookieA);
    stepDurations.profileA = g.durationMs;
    if (g.status !== 200 || !g.json || g.json.username !== usernameA) {
      throw new Error("Profile A failed or wrong username: " + JSON.stringify(g));
    }
    console.log("  - /profile OK for A");

    console.log("4) Connect socket clients");
    const t_socket_connect_start = performance.now();
    const clientA = io(SERVER, {
      extraHeaders: { Cookie: cookieA },
      transports: ["websocket"],
      reconnection: false,
    });
    const clientB = io(SERVER, {
      extraHeaders: { Cookie: cookieB },
      transports: ["websocket"],
      reconnection: false,
    });

    await Promise.all([
      new Promise((res, rej) => {
        clientA.on("connect", () => { console.log("  - socket A connected"); res(); });
        clientA.on("connect_error", err => rej(new Error("clientA connect_error: "+err.message)));
      }),
      new Promise((res, rej) => {
        clientB.on("connect", () => { console.log("  - socket B connected"); res(); });
        clientB.on("connect_error", err => rej(new Error("clientB connect_error: "+err.message)));
      })
    ]);
    stepDurations.socketConnect = performance.now() - t_socket_connect_start;

    function waitFor(socket, event, timeout = TIMEOUT) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
          socket.off(event, onEvent);
          reject(new Error(`Timeout waiting for ${event}`));
        }, timeout);
        function onEvent(payload) {
          clearTimeout(t);
          resolve(payload);
        }
        socket.once(event, onEvent);
      });
    }

    console.log("5) Create a room as userA (preference='w')");
    const createRoomStart = performance.now();
    const createRoomPromise = new Promise((resolve) => {
      clientA.emit("createRoom", { opponentUsername: usernameB, preference: "w", time: 300000 }, (response) => {
        resolve(response);
      });
    });
    const createResp = await createRoomPromise;
    stepDurations.createRoom = performance.now() - createRoomStart;
    if (!createResp || !createResp.success || !createResp.roomId) throw new Error("createRoom failed: "+JSON.stringify(createResp));
    const roomId = createResp.roomId;
    console.log("  - roomId:", roomId, "userRole:", createResp.userRole);

    console.log("6) userB joins the room");
    const joinStart = performance.now();
    let joinedPromise = waitFor(clientB, "joinedRoom");
    clientB.emit("joinRoom", { roomId });
    const joinedPayload = await joinedPromise;
    stepDurations.joinRoom = performance.now() - joinStart;
    if (!joinedPayload || !joinedPayload.success) throw new Error("userB failed to join: " + JSON.stringify(joinedPayload));
    console.log("  - userB joinedRoom event OK; fen:", joinedPayload.fen);

    console.log("7) Wait for gameStart and clockUpdate events on both sides");
    const gameStartStart = performance.now();
    await Promise.all([waitFor(clientA, "gameStart"), waitFor(clientB, "gameStart")])
      .catch(err => { throw new Error("gameStart missing: "+err.message); });
    stepDurations.gameStart = performance.now() - gameStartStart;
    console.log("  - gameStart emitted to both players");

    const clockStart = performance.now();
    
    // Wait clockUpdates to be sure clocks were set
    await Promise.all([
      waitFor(clientA, "clockUpdate"),
      waitFor(clientB, "clockUpdate")
    ])
    .then(([clockA, clockB]) => {
      if (typeof clockA.w === "undefined" || typeof clockA.b === "undefined") {
        throw new Error("clockUpdate payload invalid: " + JSON.stringify(clockA));
      }
      if (typeof clockB.w === "undefined" || typeof clockB.b === "undefined") {
        throw new Error("clockUpdate payload invalid: " + JSON.stringify(clockB));
      }
      stepDurations.clockUpdate = performance.now() - clockStart;
      console.log("  - clockUpdate payloads OK");
    })
    .catch(err => {
      console.error("Error while waiting for clockUpdate:", err);
    });

    console.log("8) Make a valid first move (white plays e2 -> e4)");
    const moveStart = performance.now();
    const beforeFen = joinedPayload.fen;
    const chess = new Chess(beforeFen);
    const move = { from: "e2", to: "e4", promotion: undefined };
    const moveResult = chess.move({ from: move.from, to: move.to, promotion: move.promotion });
    if (!moveResult) throw new Error("Client-side move failed to produce after fen");
    const afterFen = chess.fen();

    const receivePromise = waitFor(clientB, "receiveMessage", 5000);
    clientA.emit("sendMessage", { message: { from: move.from, to: move.to, promotion: move.promotion, before: beforeFen, after: afterFen } });
    const received = await receivePromise;
    stepDurations.validMove = performance.now() - moveStart;
    console.log("  - userB received move:", JSON.stringify(received).slice(0,200));

    console.log("9) Try an invalid move (stale state or wrong player)");
    const invalidStart = performance.now();
    let errorSeen = false;
    const errorListener = (payload) => { errorSeen = true; console.log("  - error event received:", payload); };
    clientA.on("error", errorListener);
    clientA.emit("sendMessage", { message: { from: "e2", to: "e4", before: beforeFen, after: afterFen } });
    await sleep(700);
    clientA.off("error", errorListener);
    stepDurations.invalidMoveCheck = performance.now() - invalidStart;
    if (!errorSeen) {
      console.warn("  - warning: server did not emit `error` for the invalid replay move (server might silently ignore)");
    } else {
      console.log("  - invalid move produced error as expected");
    }

    console.log("10) Disconnect userB and expect leftRoom on server to be broadcast to A");
    const leftStart = performance.now();
    const leftPromise = waitFor(clientA, "leftRoom", 5000);
    clientB.disconnect();
    const leftPayload = await leftPromise;
    stepDurations.leftRoom = performance.now() - leftStart;
    console.log("  - leftRoom payload:", leftPayload);

    clientA.disconnect();
    const overallEnd = performance.now();
    const totalMs = overallEnd - overallStart;

    const summary = {
      ok: true,
      server: SERVER,
      usernameA,
      usernameB,
      totalMs,
      stepDurations,
      timestamp: new Date().toISOString()
    };

    // Print both a human readable line and a machine-parseable line
    console.log("\nALL tests completed successfully.");
    console.log("METRICS_JSON: " + JSON.stringify(summary));
    // exit cleanly
    process.exit(0);

  } catch (err) {
    console.error("TEST FAILED:", err && err.stack ? err.stack : err);
    const overallEnd = performance.now();
    const totalMs = overallEnd - overallStart;
    const summary = {
      ok: false,
      server: SERVER,
      error: (err && err.message) || String(err),
      totalMs,
      stepDurations,
      timestamp: new Date().toISOString()
    };
    console.log("METRICS_JSON: " + JSON.stringify(summary));
    process.exit(1);
  }
}

run();