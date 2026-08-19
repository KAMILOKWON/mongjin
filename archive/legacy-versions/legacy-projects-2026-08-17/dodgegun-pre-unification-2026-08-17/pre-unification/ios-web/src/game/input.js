const DEAD = 0.16;
const FIRE_PULL = 0.22;
// 다시 잡을 때 마지막 조준을 가상 원점으로 이어 붙여, 손가락이 패드 어디에
// 떨어지든 각도가 중앙 기준으로 튀지 않게 한다.
const AIM_REST = 0.62;

export function stickFromAim(aim) {
  return { nx: Math.sin(aim), ny: Math.cos(aim) };
}

export function grabOrigin(x, y, aim, max, rest = AIM_REST) {
  if (aim == null || !Number.isFinite(aim) || !Number.isFinite(max) || max <= 0) {
    return { ox: x, oy: y };
  }
  const v = stickFromAim(aim);
  return { ox: x - v.nx * max * rest, oy: y - v.ny * max * rest };
}

export function readStickAt(cx, cy, ox, oy, max) {
  const dx = cx - ox;
  const dy = cy - oy;
  const dist = Math.hypot(dx, dy);
  if (dist === 0 || !Number.isFinite(max) || max <= 0) {
    return { nx: 0, ny: 0, mag: 0 };
  }
  const clamped = Math.min(1, dist / max);
  return { nx: (dx / dist) * clamped, ny: (dy / dist) * clamped, mag: clamped };
}

export function createInput(root) {
  const state = {
    mx: 0,
    mz: 0,
    aim: null,
    fire: false,
    reload: false,
    usingTouch: false,
    mouseNdc: { x: 0, y: 0 },
    mouseAim: true,
  };

  const leftPad = root.querySelector('#stick-move');
  const rightPad = root.querySelector('#stick-aim');
  const reloadBtn = root.querySelector('#btn-reload');
  const leftKnob = leftPad.querySelector('.knob');
  const rightKnob = rightPad.querySelector('.knob');

  const pointers = new Map();
  const keys = Object.create(null);

  function setKnob(el, nx, ny) {
    el.style.transform = `translate(${nx * 28}px, ${ny * 28}px)`;
  }

  function padMax(pad) {
    return pad.getBoundingClientRect().width * 0.38;
  }

  function readStick(pad, cx, cy) {
    const r = pad.getBoundingClientRect();
    return readStickAt(cx, cy, r.left + r.width / 2, r.top + r.height / 2, padMax(pad));
  }

  function bindPad(pad, onMove, onUp) {
    pad.addEventListener('pointerdown', ev => {
      ev.preventDefault();
      pad.setPointerCapture(ev.pointerId);
      if (ev.pointerType !== 'mouse') {
        state.usingTouch = true;
        state.mouseAim = false;
      }
      pointers.set(ev.pointerId, pad);
      onMove(ev);
    });
    pad.addEventListener('pointermove', ev => {
      if (!pointers.has(ev.pointerId)) return;
      ev.preventDefault();
      onMove(ev);
    });
    const end = ev => {
      if (!pointers.has(ev.pointerId)) return;
      pointers.delete(ev.pointerId);
      onUp(ev);
    };
    pad.addEventListener('pointerup', end);
    pad.addEventListener('pointercancel', end);
  }

  bindPad(leftPad, ev => {
    const s = readStick(leftPad, ev.clientX, ev.clientY);
    state.mx = Math.abs(s.nx) < DEAD ? 0 : s.nx;
    state.mz = Math.abs(s.ny) < DEAD ? 0 : s.ny;
    setKnob(leftKnob, s.nx, s.ny);
  }, () => {
    state.mx = 0;
    state.mz = 0;
    setKnob(leftKnob, 0, 0);
  });

  let rightPull = 0;
  let rightOrigin = null;
  bindPad(rightPad, ev => {
    if (!rightOrigin) {
      const max = padMax(rightPad);
      rightOrigin = { ...grabOrigin(ev.clientX, ev.clientY, state.aim, max), max };
    }
    const s = readStickAt(ev.clientX, ev.clientY, rightOrigin.ox, rightOrigin.oy, rightOrigin.max);
    rightPull = s.mag;
    if (s.mag > DEAD) {
      // 화면 위(ny < 0) = 월드 -Z. atan2(x, z)에 z=ny 를 넣으면 스틱 위가 -Z.
      state.aim = Math.atan2(s.nx, s.ny);
      state.mouseAim = false;
    }
    setKnob(rightKnob, s.nx, s.ny);
    rightPad.classList.toggle('hot', s.mag > FIRE_PULL);
  }, () => {
    if (rightPull > FIRE_PULL * 0.45) state.fire = true;
    rightPull = 0;
    rightOrigin = null;
    setKnob(rightKnob, 0, 0);
    rightPad.classList.remove('hot');
  });

  const hold = ev => {
    ev.preventDefault();
    state.reload = true;
    reloadBtn.classList.add('held');
  };
  const release = () => {
    state.reload = false;
    reloadBtn.classList.remove('held');
  };
  reloadBtn.addEventListener('pointerdown', hold);
  reloadBtn.addEventListener('pointerup', release);
  reloadBtn.addEventListener('pointercancel', release);
  reloadBtn.addEventListener('pointerleave', ev => {
    if (ev.buttons === 0) release();
  });

  addEventListener('keydown', e => {
    keys[e.code] = true;
    if (e.code === 'KeyR') state.reload = true;
    if (e.code === 'Space') e.preventDefault();
  });
  addEventListener('keyup', e => {
    keys[e.code] = false;
    if (e.code === 'KeyR') state.reload = false;
  });

  const canvas = root.querySelector('#game');

  function ndcFromClient(x, y) {
    const r = canvas?.getBoundingClientRect();
    const w = r?.width || innerWidth;
    const h = r?.height || innerHeight;
    const left = r?.left || 0;
    const top = r?.top || 0;
    return {
      x: ((x - left) / w) * 2 - 1,
      y: -((y - top) / h) * 2 + 1,
    };
  }

  addEventListener('mousemove', e => {
    if (state.usingTouch) return;
    const ndc = ndcFromClient(e.clientX, e.clientY);
    state.mouseNdc.x = ndc.x;
    state.mouseNdc.y = ndc.y;
    state.mouseAim = true;
  });
  addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    if (e.target.closest('#controls') || e.target.closest('.panel') || e.target.closest('.modal')) return;
    if (e.target.closest('#screen-splash') || e.target.closest('#tutorial-tip')) return;
    if (state.mouseAim) state.fire = true;
  });

  function consume() {
    let mx = state.mx;
    let mz = state.mz;
    mx += (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
    mz += (keys.KeyS ? 1 : 0) - (keys.KeyW ? 1 : 0);
    const fire = state.fire;
    state.fire = false;
    return {
      mx,
      mz,
      aim: state.aim,
      fire,
      reload: state.reload || !!keys.KeyR,
      mouseAim: state.mouseAim,
      mouseNdc: state.mouseNdc,
    };
  }

  return { consume, state };
}
