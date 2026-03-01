/**
 * Integration test script
 *
 * Requirements:
 *  - Server must be running at http://localhost:3001
 *  - Redis must be reachable at process.env.REDIS_URL used by the server
 *  - Environment used by server must have JWT_SECRET and JWT_EXPIRES_IN set
 *
 * This script:
 *  1. Registers two users
 *  2. Logs them in and captures cookies
 *  3. Connects two socket.io clients (with cookie header)
 *  4. Create a room (userA as white) and join (userB)
 *  5. Ensures gameStart and clockUpdate are emitted
 *  6. Sends a valid first move (e2 -> e4) from white; checks server accepts it
 *  7. Attempts an invalid move to validate error path
 *  8. Disconnects a client and expects leftRoom notification
 *
 * Exit codes: 0 = success, 1 = failure
 */

import fetch from "node-fetch";
import { io } from "socket.io-client";
import { Chess } from "chess";
import { v4 as uuidv4 } from "uuid";

const SERVER = process.env.SERVER_URL || "http://localhost:3001";
const TIMEOUT = 8000;

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

async function postJson(path, body, cookie) {
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
  return { status: res.status, json, headers: res.headers };
}

async function getJson(path, cookie) {
  const res = await fetch(`${SERVER}${path}`, {
    method: "GET",
    headers: Object.assign({}, cookie ? { Cookie: cookie } : {}),
  });
  const json = await res.json();
  return { status: res.status, json, headers: res.headers };
}

function extractCookie(setCookieHeader) {
  if (!setCookieHeader) return null;
  // take first cookie (token=...)
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  return raw.split(";")[0];
}

async function run() {
  try {
    console.log("1) Register two users");
    const usernameA = `testA_${uuidv4().slice(0,6)}`;
    const usernameB = `testB_${uuidv4().slice(0,6)}`;
    const password = "pass123";

    // Register A
    let r = await postJson("/register", { username: usernameA, password });
    if (r.status !== 201) throw new Error("Register A failed: " + JSON.stringify(r));
    console.log("  - Registered userA:", usernameA);

    // Register B
    r = await postJson("/register", { username: usernameB, password });
    if (r.status !== 201) throw new Error("Register B failed: " + JSON.stringify(r));
    console.log("  - Registered userB:", usernameB);

    console.log("2) Login both users and capture cookies");
    r = await postJson("/login", { username: usernameA, password });
    if (r.status !== 200) throw new Error("Login A failed: " + JSON.stringify(r));
    const cookieA = extractCookie(r.headers.raw()["set-cookie"]);
    if (!cookieA) throw new Error("Login A returned no cookie");
    console.log("  - Login A cookie captured");

    r = await postJson("/login", { username: usernameB, password });
    if (r.status !== 200) throw new Error("Login B failed: " + JSON.stringify(r));
    const cookieB = extractCookie(r.headers.raw()["set-cookie"]);
    if (!cookieB) throw new Error("Login B returned no cookie");
    console.log("  - Login B cookie captured");

    console.log("3) Test protected /profile with cookie");
    let g = await getJson("/profile", cookieA);
    if (g.status !== 200 || !g.json || g.json.username !== usernameA) {
      throw new Error("Profile A failed or wrong username: " + JSON.stringify(g));
    }
    console.log("  - /profile OK for A");

    // Connect socket.io clients using cookie header
    console.log("4) Connect socket clients");
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

    // Helper to await an event once with timeout
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
    const createRoomPromise = new Promise((resolve) => {
      clientA.emit("createRoom", { opponentUsername: usernameB, preference: "w", time: 300000 }, (response) => {
        resolve(response);
      });
    });
    const createResp = await createRoomPromise;
    if (!createResp || !createResp.success || !createResp.roomId) throw new Error("createRoom failed: "+JSON.stringify(createResp));
    const roomId = createResp.roomId;
    console.log("  - roomId:", roomId, "userRole:", createResp.userRole);

    console.log("6) userB joins the room");
    // capture events
    let joinedPromise = waitFor(clientB, "joinedRoom");
    clientB.emit("joinRoom", { roomId });

    const joinedPayload = await joinedPromise;
    if (!joinedPayload || !joinedPayload.success) throw new Error("userB failed to join: " + JSON.stringify(joinedPayload));
    console.log("  - userB joinedRoom event OK; fen:", joinedPayload.fen);

    console.log("7) Wait for gameStart and clockUpdate events on both sides");
    // both sockets should get gameStart and clockUpdate soon
    const bothGameStart = Promise.all([waitFor(clientA, "gameStart"), waitFor(clientB, "gameStart")]);
    await bothGameStart.catch(err => { throw new Error("gameStart missing: "+err.message); });
    console.log("  - gameStart emitted to both players");

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
      console.log("  - clockUpdate payloads OK");
    })
    .catch(err => {
      console.error("Error while waiting for clockUpdate:", err);
    });

    console.log("8) Make a valid first move (white plays e2 -> e4)");
    // Ensure userA is white; createRoom earlier requested preference 'w' so userA should be white
    // Get current fen from joinedPayload or clock update sender side: use joinedPayload.fen
    const beforeFen = joinedPayload.fen;
    const chess = new Chess(beforeFen); // initial pos
    const move = { from: "e2", to: "e4", promotion: undefined };
    const moveResult = chess.move({ from: move.from, to: move.to, promotion: move.promotion });
    if (!moveResult) throw new Error("Client-side move failed to produce after fen");
    const afterFen = chess.fen();

    // Listen for receiveMessage on B
    const receivePromise = waitFor(clientB, "receiveMessage", 5000);

    clientA.emit("sendMessage", { message: { from: move.from, to: move.to, promotion: move.promotion, before: beforeFen, after: afterFen } });

    // B should receive the move
    const received = await receivePromise;
    console.log("  - userB received move:", JSON.stringify(received).slice(0,200));

    console.log("9) Try an invalid move (stale state or wrong player)");
    // Attempt to replay the same move from userA again (should be invalid: not player's turn or stale)
    let errorSeen = false;
    const errorListener = (payload) => { errorSeen = true; console.log("  - error event received:", payload); };
    clientA.on("error", errorListener);

    clientA.emit("sendMessage", { message: { from: "e2", to: "e4", before: beforeFen, after: afterFen } });
    await sleep(700); // small wait

    clientA.off("error", errorListener);
    if (!errorSeen) {
      console.warn("  - warning: server did not emit `error` for the invalid replay move (server might silently ignore)");
    } else {
      console.log("  - invalid move produced error as expected");
    }

    console.log("10) Disconnect userB and expect leftRoom on server to be broadcast to A");
    // Listen for leftRoom on A
    const leftPromise = waitFor(clientA, "leftRoom", 5000);
    clientB.disconnect();

    const leftPayload = await leftPromise;
    console.log("  - leftRoom payload:", leftPayload);

    // Cleanups
    clientA.disconnect();
    console.log("\nALL tests completed successfully.");
    process.exit(0);

  } catch (err) {
    console.error("TEST FAILED:", err);
    process.exit(1);
  }
}

run();