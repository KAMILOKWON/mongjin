import { Client } from 'colyseus.js';
import { CFG } from '../game/config.js';
import { applyLocalMove, copyFighter, emptyInput } from '../game/sim.js';
import { defaultEndpoint, ROOM_NAME } from './protocol.js';

export function createNet() {
  const state = {
    status: 'idle',
    side: 'p1',
    vsAi: false,
    opponentType: 'human',
    opponentName: 'P2',
    waitLeft: CFG.matchWait,
    match: null,
    events: [],
    error: '',
    peer: '',
    room: null,
    client: null,
  };

  let seq = 0;
  let pendingFire = false;
  let lastSend = 0;
  const pred = { p1: null, p2: null };

  function pushEvent(ev) {
    state.events.push(ev);
  }

  function hydrate(snap) {
    state.match = snap;
    state.vsAi = !!snap.vsAi;
    state.opponentType = snap.opponentType || (snap.vsAi ? 'ai' : 'human');
    state.opponentName = snap.opponentName || (snap.vsAi ? 'AI' : 'P2');
    if (!pred.p1) pred.p1 = copyFighter(snap.p1);
    if (!pred.p2) pred.p2 = copyFighter(snap.p2);
    reconcile(snap.p1, pred.p1, 'p1');
    reconcile(snap.p2, pred.p2, 'p2');
  }

  function reconcile(serverF, localF, side) {
    const dx = serverF.x - localF.x;
    const dz = serverF.z - localF.z;
    const dist = Math.hypot(dx, dz);
    const isLocal = side === state.side;
    // The local fighter is prediction-corrected immediately. The opponent is
    // rendered from a small visual buffer below, so regular network packets do
    // not turn into visible 20Hz jumps.
    if (dist > (isLocal ? 1.4 : 2.4)) copyFighter(serverF, localF);
    else if (isLocal) {
      localF.x += dx * 0.35;
      localF.z += dz * 0.35;
      localF.ang = serverF.ang;
      copyFighterState(serverF, localF);
    } else {
      copyFighterState(serverF, localF);
    }
  }

  function copyFighterState(serverF, localF) {
    localF.hp = serverF.hp;
    localF.ammo = serverF.ammo;
    localF.leverT = serverF.leverT;
    localF.reloadT = serverF.reloadT;
    localF.reloading = serverF.reloading;
    localF.hitT = serverF.hitT;
    localF.knockX = serverF.knockX;
    localF.knockZ = serverF.knockZ;
    localF.rifleTilt = serverF.rifleTilt;
    localF.visible = serverF.visible;
    localF.moving = serverF.moving;
  }

  function smoothRemote(dt) {
    if (!state.match || !pred.p1 || !pred.p2) return;
    const remoteSide = state.side === 'p1' ? 'p2' : 'p1';
    const target = state.match[remoteSide];
    const visual = pred[remoteSide];
    if (!target || !visual) return;

    const dx = target.x - visual.x;
    const dz = target.z - visual.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 2.4) {
      copyFighter(target, visual);
      return;
    }

    const frameDt = Math.max(0.001, Math.min(0.05, Number(dt) || 1 / 60));
    const alpha = 1 - Math.exp(-18 * frameDt);
    visual.x += dx * alpha;
    visual.z += dz * alpha;

    const angleDelta = Math.atan2(
      Math.sin(target.ang - visual.ang),
      Math.cos(target.ang - visual.ang)
    );
    visual.ang += angleDelta * alpha;
    if (visual.moving) visual.walkT += frameDt;
  }

  async function connect(userKey, nickname = 'PLAYER') {
    leave();
    state.status = 'connecting';
    state.error = '';
    state.waitLeft = CFG.matchWait;
    try {
      const client = new Client(defaultEndpoint());
      state.client = client;
      const room = await client.joinOrCreate(ROOM_NAME, { userKey, nickname });
      state.room = room;
      state.status = 'queued';

      room.onMessage('hello', msg => {
        state.side = msg.side || 'p1';
        state.waitLeft = msg.wait ?? CFG.matchWait;
      });
      room.onMessage('queue', msg => {
        state.status = 'queued';
        state.waitLeft = msg.wait ?? state.waitLeft;
      });
      room.onMessage('start', msg => {
        state.vsAi = !!msg.vsAi;
        state.opponentType = msg.opponentType || (msg.vsAi ? 'ai' : 'human');
        state.opponentName = msg.opponentName || (msg.vsAi ? 'AI' : 'P2');
        state.status = 'battle';
        if (msg.sideBySession && room.sessionId) {
          state.side = msg.sideBySession[room.sessionId] || state.side;
        }
      });
      room.onMessage('snap', snap => {
        hydrate(snap);
        if (state.status === 'queued' || state.status === 'connecting') {
          state.vsAi = !!snap.vsAi;
          state.status = 'battle';
        }
        if (snap.phase === 'matchEnd') state.status = 'ended';
      });
      room.onMessage('ev', list => {
        for (const ev of list) pushEvent(ev);
      });
      room.onMessage('peer', msg => {
        state.peer = msg.state === 'away' ? '상대 재접속 대기' : '';
      });
      room.onError((_code, message) => {
        state.error = message || '서버 오류';
        state.status = 'error';
      });
      room.onLeave(code => {
        if (state.status === 'battle' || state.status === 'queued') {
          state.error = code === 1000 ? '' : '연결이 끊겼어요';
          if (state.status !== 'ended') state.status = state.error ? 'error' : 'idle';
        }
      });
      return true;
    } catch (err) {
      state.status = 'error';
      state.error = '서버에 연결할 수 없어요';
      console.warn(err);
      return false;
    }
  }

  function sendInput(input, dt) {
    if (!state.room || !state.match) return;
    if (input.fire) pendingFire = true;
    const side = state.side;
    const mine = pred[side];
    if (mine && state.match.phase === 'fight' && !state.match.paused) {
      applyLocalMove(mine, dt, input);
    }
    const now = performance.now();
    if (now - lastSend < 1000 / CFG.netHz) return;
    lastSend = now;
    seq += 1;
    state.room.send('input', {
      seq,
      mx: input.mx,
      mz: input.mz,
      aim: input.aim,
      fire: pendingFire,
      reload: input.reload,
    });
    pendingFire = false;
  }

  function setAway(on) {
    state.room?.send('away', !!on);
  }

  function viewMatch(dt = 1 / 60) {
    if (!state.match) return null;
    smoothRemote(dt);
    const view = {
      ...state.match,
      p1: pred.p1 ? copyFighter(pred.p1, { ...state.match.p1 }) : state.match.p1,
      p2: pred.p2 ? copyFighter(pred.p2, { ...state.match.p2 }) : state.match.p2,
    };
    return view;
  }

  function drain() {
    return state.events.splice(0, state.events.length);
  }

  function leave() {
    try { state.room?.leave(true); } catch { /* ignore */ }
    state.room = null;
    state.client = null;
    state.match = null;
    state.opponentType = 'human';
    state.opponentName = 'P2';
    state.events.length = 0;
    state.peer = '';
    pred.p1 = null;
    pred.p2 = null;
    pendingFire = false;
    if (state.status !== 'error') state.status = 'idle';
  }

  return { state, connect, sendInput, setAway, viewMatch, drain, leave, emptyInput };
}
