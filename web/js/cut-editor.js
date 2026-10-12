import {
  addAt, dragEdge, globalOf, isZero, layout, locate, moveRange, normalize, partsOf, tickStep, toggleVideo, totalOf,
} from './cut-ranges.js';

/**
 * 구간 고르기 창 아래의 **직접 컷 편집** — 일반 컷 편집 툴처럼 시퀀스 바 위에서 구간을 고른다.
 *
 * 배치(2026-10-12 사용자 지시): 왼쪽 위 영상 썸네일 → 그 아래 재생 줄·시퀀스 바 → 합계·[GIF 만들기], 오른쪽에 미리보기 화면.
 * 창을 열자마자 스크롤 없이 바가 보이게 한 것이다. 바·미리보기 폭은 예전 그대로(바 950px, 미리보기는 영상 비율) —
 * 늘어난 만큼 창이 넓어진다(미리보기 폭을 창의 `--ce-stage-w` 로 알린다, app.css `.clip-dialog`).
 *
 * - 처음에는 가장 유력한 추천 후보의 구간이 골라져 있다(video.js 가 fromParts 로 넘긴다).
 * - 바의 빈 곳을 누르면 그 자리부터 1초 구간이 생기고, 구간 양 끝 손잡이를 끌어 늘이거나 줄인다.
 *   한쪽 끝을 반대쪽 끝에 붙이면(0초) 테두리가 빨개지고 「구간 선택 취소」가 뜬다 — 그대로 놓으면 그 구간이 지워진다.
 * - 파란 구간 가운데를 잡고 끌면 길이 그대로 앞뒤로 옮긴다(누르기만 하면 인디케이터가 그 자리로).
 * - 끝을 끌거나 구간을 옮기는 동안 인디케이터가 그 끝(옮길 땐 시작)을 따라가고, 위에 그 자리 화면이 뜬다.
 * - 영상이 여럿이면 썸네일을 눌러 넣고 뺀다. 누른 순서대로 바에 이어 붙고, 뺐다 다시 넣어도 전에 고른 구간이 그대로다
 *   (구간 계산은 cut-ranges.js).
 * - 위쪽 눈금을 누르거나 끌면(또는 인디케이터 머리를 끌면) 인디케이터만 옮긴다. ▶ 는 고른 구간만 이어서 재생한다.
 * - 바의 영상 칸에는 장면 사진을 깐다(필름스트립 — 서버가 0.5초마다 한 장씩 한 줄로 붙인 사진을 칸마다 배경 위치로 고른다).
 *
 * 화면은 서버의 탐색용 영상(`/api/videos/<id>/scrub` — 소리 없음, 키프레임이 촘촘해 끌어도 바로 그 장면)을 쓴다.
 * 영상마다 <video> 를 하나씩 두고 인디케이터가 있는 영상만 보인다 — 영상을 넘나들어도 다시 불러오지 않게.
 */

const PAD = 14; // 바 양 끝 여백 — 맨 끝 구간의 손잡이가 잘리지 않게
const MAX_PPS = 80; // 끝까지 확대했을 때 1초 폭(px)
const TAP_PX = 4; // 이만큼 안 움직이고 떼면 「누르기」
const LONG_SEC = 12; // 이보다 길면 GIF 화질 안내(config.media.seqMaxSec 와 같은 값)
const POP_W = 120; // 끝을 끌 때 뜨는 화면 폭
const POP_H = 200;

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined) e.append(c);
  return e;
}

const sec = (t) => `${(Math.round(Number(t) * 10) / 10).toFixed(1)}초`;

/**
 * <video> 옮기기를 줄 세운다 — 끄는 동안 currentTime 을 매번 바꾸면 앞 옮기기가 끝나기 전에 쌓여 화면이 늦게 따라온다.
 * 옮기는 중에 온 요청은 마지막 것만 남겼다가 앞 옮기기가 끝나면(seeked) 한 번에 간다.
 */
function seeker(video) {
  let want = null;
  let busy = false;
  let timer = 0;
  const next = () => {
    clearTimeout(timer);
    if (want === null) { busy = false; return; }
    const t = want;
    want = null;
    busy = true;
    timer = setTimeout(next, 800); // seeked 가 안 오는 일이 있어도 멈춰 있지 않게
    video.currentTime = t;
  };
  video.addEventListener('seeked', next);
  video.addEventListener('loadedmetadata', () => { if (!busy) next(); });
  return (t) => {
    want = Math.max(0, Number(t) || 0);
    if (!busy && video.readyState >= 1) next();
  };
}

/**
 * @param {object} o
 * @param {{id:string,name:string,usedSec?:number,durationSec?:number}[]} o.videos  이 자리에 올린 영상(올린 순서 = 영상1·2·3)
 * @param {{order:string[],ranges:Object<string,{start:number,end:number}[]>}} o.cut  처음 편집 상태
 * @param {(id:string)=>string} o.scrubUrl
 * @param {(id:string)=>string} [o.stripUrl]  필름스트립 칸 정보(JSON) 주소 — 없으면 바에 사진을 안 깐다
 * @param {(cut:object)=>void} [o.onChange]  바뀔 때마다 — 창을 닫았다 열어도 이어서 고치게 부른 쪽이 들고 있는다
 * @param {(parts:{videoId:string,start:number,end:number}[])=>void} o.onMake  [이 구간으로 GIF 만들기]
 */
export function createCutEditor({
  videos, cut: initial, scrubUrl, stripUrl, onChange, onMake,
}) {
  const many = videos.length > 1;
  const meta = new Map(); // 영상 id → 탐색용 영상에서 읽은 길이(준비 결과에 길이가 없을 때만)
  const strips = new Map(); // 영상 id → 필름스트립 { src, fps, frames, frameW, frameH }
  const durOf = (id) => {
    const v = videos.find((x) => x.id === id);
    return Number(v?.usedSec) || Number(v?.durationSec) || meta.get(id) || 0;
  };
  const nameOf = (id) => `영상${videos.findIndex((v) => v.id === id) + 1}`;

  let cut = {
    order: (initial?.order ?? []).filter((id) => videos.some((v) => v.id === id)),
    ranges: Object.fromEntries(Object.entries(initial?.ranges ?? {}).map(([id, list]) => [id, normalize(list, durOf(id))])),
  };
  let zoom = 1;
  let fitPps = 1;
  let geo = { segments: [], total: 0 };
  let playhead = null; // { videoId, t }
  let drag = null;
  let playing = null;
  let active = '';
  let destroyed = false;

  // ── 틀 ────────────────────────────────────────────────────────────────────
  const stage = el('div', { class: 'ce-stage' });
  const stageMsg = el('div', { class: 'ce-stage-msg' });
  stage.append(stageMsg);
  const thumbs = el('div', { class: 'ce-thumbs' });
  const playBtn = el('button', {
    type: 'button', class: 'ce-play', 'aria-label': '고른 구간 재생', title: '고른 구간만 이어서 재생', on: { click: () => (playing ? stopPlay() : play()) },
  });
  const timeText = el('span', { class: 'ce-time' });
  const zoomInput = el('input', {
    type: 'range', min: '0', max: '100', value: '0', step: '1', class: 'ce-zoom', 'aria-label': '확대',
  });
  const zoomWrap = el('label', { class: 'ce-zoom-wrap' }, '확대', zoomInput);
  const track = el('div', { class: 'ce-track' });
  const scroll = el('div', { class: 'ce-scroll' }, track);
  const totalText = el('span', { class: 'ce-total' });
  const warnText = el('span', { class: 'ce-warn' });
  const makeBtn = el('button', {
    type: 'button', class: 'vp-btn primary small ce-make', on: { click: () => { const parts = partsOf(cut); if (parts.length) { stopPlay(); onMake(parts); } } },
  }, '이 구간으로 GIF 만들기');
  const popCanvas = el('canvas', { width: String(POP_W), height: String(POP_H) });
  const popText = el('div', { class: 'ce-pop-text' });
  const pop = el('div', { class: 'ce-pop', hidden: true }, popCanvas, popText);

  // 왼쪽(썸네일 → 재생 줄·바 → 합계) | 오른쪽 미리보기 — 창을 열자마자 바가 보이게
  const root = el('section', { class: 'ce', dataset: { cutEditor: '1' } },
    el('div', { class: 'ce-head' },
      el('b', {}, '직접 컷 편집'),
      el('span', { class: 'ce-hint' }, [
        many ? '영상 썸네일을 누른 순서대로 이어 붙습니다(다시 누르면 빠집니다).' : '',
        '바의 빈 곳을 누르면 1초 구간이 생기고, 구간 양 끝을 끌면 길이를, 가운데를 끌면 위치를 맞춥니다. 끝을 반대쪽 끝에 붙이면 구간이 취소됩니다.',
      ].filter(Boolean).join(' '))),
    el('div', { class: 'ce-top' },
      el('div', { class: 'ce-main' },
        many ? thumbs : null,
        el('div', { class: 'ce-transport' }, playBtn, timeText, zoomWrap),
        scroll,
        el('div', { class: 'ce-foot' }, totalText, warnText, makeBtn)),
      stage),
    pop);

  // ── 영상(화면·썸네일) ──────────────────────────────────────────────────────
  const players = new Map(); // id → { video, seek }
  const thumbVideos = new Map();

  function player(id) {
    let p = players.get(id);
    if (p) return p;
    const video = el('video', { muted: true, playsinline: true, preload: 'auto', src: scrubUrl(id) });
    video.muted = true;
    p = {
      video, seek: seeker(video), failed: false, loaded: false,
    };
    video.addEventListener('loadedmetadata', () => {
      if (!(durOf(id) > 0) && video.duration > 0 && Number.isFinite(video.duration)) {
        meta.set(id, Math.floor(video.duration * 10) / 10);
        cut = { ...cut, ranges: { ...cut.ranges, [id]: normalize(cut.ranges[id] ?? [], durOf(id)) } };
        render();
      }
      if (id === active) fitStage();
    });
    video.addEventListener('loadeddata', () => { p.loaded = true; if (id === active) stageNote(); });
    video.addEventListener('seeked', () => { if (drag?.videoId === id && (drag.kind === 'edge' || drag.kind === 'move')) drawPop(); });
    video.addEventListener('error', () => { p.failed = true; if (id === active) stageNote(); });
    players.set(id, p);
    stage.append(video);
    return p;
  }

  function thumbVideo(id) {
    let v = thumbVideos.get(id);
    if (!v) {
      // #t= 로 첫 장면 대신 0.5초 화면을 보여 준다(첫 장면은 검은 화면인 영상이 많다)
      v = el('video', { muted: true, playsinline: true, preload: 'metadata', src: `${scrubUrl(id)}#t=0.5` });
      v.muted = true;
      thumbVideos.set(id, v);
    }
    return v;
  }

  /** 인디케이터가 있는 영상만 보이게, 그 초로 옮긴다. */
  function showFrame() {
    const id = playhead?.videoId ?? '';
    if (id !== active) {
      active = id;
      for (const [vid, p] of players) p.video.classList.toggle('on', vid === id);
      if (id) player(id).video.classList.add('on');
      fitStage();
    }
    if (id && !playing) player(id).seek(playhead.t);
    stageNote();
  }

  /** 화면 비율 — 세로 영상이면 좁게, 가로 영상이면 넓게(높이는 고정). */
  function fitStage() {
    const v = players.get(active)?.video;
    const ratio = v?.videoWidth && v?.videoHeight ? v.videoWidth / v.videoHeight : 9 / 16;
    stage.style.width = `${Math.round(Math.min(460, Math.max(160, 300 * ratio)))}px`;
    syncDialog();
  }

  /** 창이 미리보기 폭만큼 넓어진다 — 바 폭은 예전 그대로(app.css .clip-dialog). 창에 붙은 뒤에야 알릴 수 있어 그릴 때마다 맞춘다. */
  function syncDialog() {
    const dlg = root.closest('dialog');
    const w = stage.style.width || '169px';
    if (dlg && dlg.style.getPropertyValue('--ce-stage-w') !== w) dlg.style.setProperty('--ce-stage-w', w);
  }

  // ── 필름스트립(바에 까는 장면 사진) ─────────────────────────────────────────
  function loadStrip(id) {
    if (!stripUrl || strips.has(id)) return;
    strips.set(id, null); // 받는 중
    fetch(stripUrl(id), { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (destroyed || !j?.strip) return;
        // 사진을 먼저 받아 둔 뒤 깐다 — 칸마다 같은 주소라 한 번만 받는다
        const img = new Image();
        img.onload = () => { if (!destroyed) { strips.set(id, j.strip); render(); } };
        img.src = j.strip.src;
      })
      .catch(() => {}); // 사진이 없어도 바는 쓸 수 있다
  }

  /** 영상 칸 하나에 깔 장면 사진들 — 칸 높이에 맞춘 폭으로 이어 놓고, 칸마다 그 자리 초에 가까운 장면을 고른다. */
  function stripTiles(s, width) {
    const m = strips.get(s.videoId);
    if (!m || !(width > 0)) return null;
    const h = 46; // 영상 칸(48) 안쪽
    const tw = Math.max(8, (h * m.frameW) / m.frameH);
    const last = Math.max(0, Math.min(m.frames - 1, Math.floor(Math.max(0, s.dur - 0.05) * m.fps)));
    const tiles = [];
    for (let k = 0; k * tw < width; k += 1) {
      const t = ((k + 0.5) * tw) / pps();
      const i = Math.min(last, Math.max(0, Math.round(t * m.fps)));
      tiles.push(el('div', {
        class: 'ce-frame',
        style: `left:${(k * tw).toFixed(2)}px;width:${tw.toFixed(2)}px;background-size:${(m.columns * tw).toFixed(2)}px ${h}px;background-position:${(-i * tw).toFixed(2)}px 0`,
      }));
    }
    return el('div', { class: 'ce-strip', style: `--strip:url("${m.src}")` }, tiles);
  }

  function stageNote() {
    const p = players.get(active);
    let msg = '';
    if (!active) msg = cut.order.length ? '' : '영상을 넣어 주세요';
    else if (p?.failed) msg = '영상을 불러오지 못했습니다';
    // 한 번 그려진 뒤로는 띄우지 않는다 — 옮기는(seek) 동안은 readyState 가 잠깐 내려가 끌 때마다 깜빡였다
    else if (!p?.loaded) msg = '불러오는 중…';
    stageMsg.textContent = msg;
    stageMsg.hidden = !msg;
  }

  // ── 바 그리기 ─────────────────────────────────────────────────────────────
  const pps = () => fitPps * zoom;
  const xOf = (g) => PAD + g * pps();
  const maxZoom = () => Math.max(1, MAX_PPS / fitPps);

  function render() {
    if (destroyed) return;
    syncDialog();
    geo = layout(cut.order, durOf);
    const width = scroll.clientWidth;
    if (width > 0) {
      fitPps = Math.max(0.5, (width - PAD * 2) / Math.max(1, geo.total));
      zoom = Math.min(zoom, maxZoom());
      zoomWrap.hidden = maxZoom() < 1.3;
      renderTrack();
    }
    renderSide();
    renderPlayhead();
  }

  function renderTrack() {
    track.style.width = `${Math.max(scroll.clientWidth, Math.ceil(geo.total * pps() + PAD * 2))}px`;
    if (!cut.order.length) {
      track.replaceChildren(el('div', { class: 'ce-empty' }, many ? '위 썸네일을 눌러 영상을 넣어 주세요' : '영상이 없습니다'));
      return;
    }
    const step = tickStep(pps());
    const minor = step / (step === 15 ? 3 : step >= 2 ? 5 : 2);
    const ticks = [];
    const kids = [];
    for (const s of geo.segments) {
      const left = xOf(s.offset);
      const width = s.dur * pps();
      for (let i = 0; i * minor <= s.dur + 1e-6; i += 1) {
        const t = i * minor;
        const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
        // 영상이 여럿이면 칸 첫 눈금에 「영상N」(0 대신). 칸 끝에 붙은 숫자는 뒤 칸 이름과 겹치거나 잘려서 뺀다.
        let label = null;
        if (major && t === 0 && many) label = el('span', { class: 'name' }, nameOf(s.videoId));
        else if (major && (t === 0 || (s.dur - t) * pps() >= 22)) label = el('span', {}, String(Math.round(t * 10) / 10));
        ticks.push(el('div', { class: `ce-tick${major ? ' major' : ''}${t === 0 && many ? ' start' : ''}`, style: `left:${xOf(s.offset + t)}px` }, label));
      }
      kids.push(el('div', { class: 'ce-seg', style: `left:${left}px;width:${width}px`, dataset: { video: s.videoId } },
        stripTiles(s, width)));
      (cut.ranges[s.videoId] ?? []).forEach((r, i) => {
        const mine = drag?.videoId === s.videoId && drag.index === i;
        const dragging = mine && drag.kind === 'edge';
        const moving = mine && drag.kind === 'move' && drag.moved;
        kids.push(el('div', {
          class: ['ce-range', dragging || moving ? 'is-drag' : '', moving ? 'is-move' : '', dragging && drag.zero ? 'zero' : ''].filter(Boolean).join(' '),
          style: `left:${xOf(s.offset + r.start)}px;width:${Math.max(0, (r.end - r.start) * pps())}px`,
          dataset: { video: s.videoId, index: String(i) },
          title: '끌어서 구간 옮기기',
        },
        el('div', { class: 'ce-handle l', dataset: { edge: 'start' }, title: '끌어서 시작 조절' }),
        el('div', { class: 'ce-handle r', dataset: { edge: 'end' }, title: '끌어서 끝 조절' })));
      });
    }
    track.replaceChildren(
      el('div', { class: 'ce-ruler', title: '누르거나 끌어서 인디케이터 옮기기' }, ...ticks),
      ...kids,
      el('div', { class: 'ce-playhead' }, el('div', { class: 'ce-playhead-knob', title: '끌어서 옮기기' })),
    );
  }

  function renderPlayhead() {
    const g = playhead ? globalOf(geo.segments, playhead.videoId, playhead.t) : null;
    const line = track.querySelector('.ce-playhead');
    if (line) {
      line.hidden = g === null;
      if (g !== null) line.style.left = `${xOf(g)}px`;
    }
    timeText.textContent = playhead && g !== null
      ? `${many ? `${nameOf(playhead.videoId)} · ` : ''}${sec(playhead.t)} / ${sec(durOf(playhead.videoId))}`
      : '';
  }

  function renderSide() {
    if (many) {
      thumbs.replaceChildren(...videos.map((v, i) => {
        const pos = cut.order.indexOf(v.id);
        const n = (cut.ranges[v.id] ?? []).filter((r) => !isZero(r)).length;
        return el('button', {
          type: 'button',
          class: `ce-thumb${pos >= 0 ? ' on' : ''}`,
          title: `${v.name}${pos >= 0 ? ' — 누르면 뺍니다' : ' — 누르면 넣습니다'}`,
          dataset: { video: v.id },
          on: { click: () => toggle(v.id) },
        },
        thumbVideo(v.id),
        pos >= 0 ? el('span', { class: 'ce-thumb-n' }, String(pos + 1)) : null,
        el('span', { class: 'ce-thumb-name' }, `영상${i + 1}`),
        el('span', { class: 'ce-thumb-sub' }, n ? `구간 ${n}개` : pos >= 0 ? '구간 없음' : '빠짐'));
      }));
    }
    const parts = partsOf(cut);
    // 지금 GIF 가 될 조각(순서대로) — 화면에는 안 보이고, 실화면 시험이 읽는다
    root.dataset.parts = JSON.stringify(parts);
    const total = totalOf(cut);
    totalText.textContent = parts.length ? `구간 ${parts.length}개 · 합계 ${sec(total)}` : '고른 구간이 없습니다 — 바의 빈 곳을 누르세요';
    warnText.textContent = total > LONG_SEC ? `${LONG_SEC}초가 넘으면 GIF 용량 때문에 화질이 조금 낮아질 수 있습니다` : '';
    makeBtn.disabled = !parts.length;
    playBtn.disabled = !parts.length;
    playBtn.classList.toggle('is-playing', !!playing);
  }

  /** 인디케이터가 보이는 곳에 있게 바를 민다(재생·확대할 때). */
  function follow() {
    const g = playhead ? globalOf(geo.segments, playhead.videoId, playhead.t) : null;
    if (g === null) return;
    const x = xOf(g);
    const { scrollLeft, clientWidth } = scroll;
    if (x < scrollLeft + 24 || x > scrollLeft + clientWidth - 24) scroll.scrollLeft = Math.max(0, x - clientWidth / 3);
  }

  const changed = () => onChange?.({ order: [...cut.order], ranges: { ...cut.ranges } });

  // ── 끝 조절 미리보기 ──────────────────────────────────────────────────────

  function drawPop() {
    if (!drag || !(drag.kind === 'edge' || drag.kind === 'move') || drag.zero) return;
    const v = players.get(drag.videoId)?.video;
    if (!v || v.readyState < 2 || !v.videoWidth) return;
    let w = POP_W;
    let h = Math.round((POP_W * v.videoHeight) / v.videoWidth);
    if (h > POP_H) { h = POP_H; w = Math.round((POP_H * v.videoWidth) / v.videoHeight); }
    if (popCanvas.width !== w || popCanvas.height !== h) { popCanvas.width = w; popCanvas.height = h; }
    popCanvas.getContext('2d').drawImage(v, 0, 0, w, h);
  }

  /**
   * 끄는 손잡이 위에 그 자리 화면(0초가 되면 「구간 선택 취소」). 구간을 옮길 땐 시작 자리 화면.
   * 바는 세로로 잘리므로 편집기 위에 띄운다.
   */
  function placePop() {
    const moving = drag?.kind === 'move' && drag.moved;
    if (!drag || !(drag.kind === 'edge' || moving)) { pop.hidden = true; return; }
    const r = cut.ranges[drag.videoId]?.[drag.index];
    const box = track.querySelector(`.ce-range[data-video="${CSS.escape(drag.videoId)}"][data-index="${drag.index}"]`);
    if (!r || !box) { pop.hidden = true; return; }
    const side = moving ? 'start' : drag.side;
    pop.classList.toggle('zero', !!drag.zero);
    if (drag.zero) popText.textContent = '구간 선택 취소';
    else popText.textContent = `${side === 'start' ? '시작' : '끝'} ${sec(side === 'start' ? r.start : r.end)} · 길이 ${sec(r.end - r.start)}`;
    pop.hidden = false;
    const rb = box.getBoundingClientRect();
    const sb = scroll.getBoundingClientRect();
    const ob = root.getBoundingClientRect();
    const edgeX = drag.zero ? rb.left + rb.width / 2 : side === 'start' ? rb.left : rb.right;
    const x = Math.min(Math.max(edgeX, sb.left + 4), sb.right - 4); // 바 밖으로 밀려난 끝은 바 가장자리에
    const pw = pop.offsetWidth;
    pop.style.left = `${Math.round(Math.min(Math.max(x - ob.left - pw / 2, 4), ob.width - pw - 4))}px`;
    pop.style.top = `${Math.round(sb.top - ob.top - pop.offsetHeight - 8)}px`;
    pop.style.setProperty('--arrow', `${Math.round(x - ob.left - parseFloat(pop.style.left))}px`);
  }

  // ── 바 조작 ───────────────────────────────────────────────────────────────

  /** 포인터 → 바 전체의 초 */
  function gAt(e) {
    const x = e.clientX - track.getBoundingClientRect().left;
    return Math.min(geo.total, Math.max(0, (x - PAD) / pps()));
  }

  function scrubTo(e) {
    const at = locate(geo.segments, gAt(e));
    if (!at) return;
    playhead = at;
    renderPlayhead();
    showFrame();
  }

  function moveEdge(e) {
    const s = geo.segments.find((x) => x.videoId === drag.videoId);
    const ranges = cut.ranges[drag.videoId];
    if (!s || !ranges?.[drag.index]) return;
    const { range, zero } = dragEdge(ranges, drag.index, drag.side, gAt(e) - s.offset, s.dur);
    const next = ranges.slice();
    next[drag.index] = range; // 놓을 때까지는 0초 구간도 그대로 둔다(번호가 밀리지 않게)
    cut = { ...cut, ranges: { ...cut.ranges, [drag.videoId]: next } };
    drag.zero = zero;
    // 인디케이터가 끄는 끝을 따라간다 — 큰 화면과 손잡이 위 화면이 그 장면을 보여 준다
    playhead = { videoId: drag.videoId, t: drag.side === 'start' ? range.start : range.end };
    render();
    showFrame();
    placePop();
    drawPop();
  }

  /** 파란 구간을 잡고 끈다 — 잡은 자리를 손가락 밑에 둔 채 길이 그대로 옮긴다. */
  function moveBox(e) {
    const s = geo.segments.find((x) => x.videoId === drag.videoId);
    const ranges = cut.ranges[drag.videoId];
    if (!s || !ranges?.[drag.index]) return;
    const range = moveRange(ranges, drag.index, gAt(e) - s.offset - drag.grab, s.dur);
    const next = ranges.slice();
    next[drag.index] = range;
    cut = { ...cut, ranges: { ...cut.ranges, [drag.videoId]: next } };
    playhead = { videoId: drag.videoId, t: range.start };
    render();
    showFrame();
    placePop();
    drawPop();
  }

  function endDrag(e, { cancel = false } = {}) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const d = drag;
    drag = null;
    if (track.hasPointerCapture?.(e.pointerId)) track.releasePointerCapture(e.pointerId);
    pop.hidden = true;
    if (d.kind === 'move') {
      if (d.moved) {
        const ranges = (cut.ranges[d.videoId] ?? []).slice();
        if (cancel) ranges[d.index] = d.orig;
        cut = { ...cut, ranges: { ...cut.ranges, [d.videoId]: normalize(ranges, durOf(d.videoId)) } };
        changed();
        render();
        showFrame();
      } else if (!cancel) {
        scrubTo(e); // 끌지 않고 눌렀다 — 인디케이터만 그 자리로
      }
      return;
    }
    if (d.kind === 'edge') {
      const ranges = (cut.ranges[d.videoId] ?? []).slice();
      if (cancel) ranges[d.index] = d.orig;
      else if (d.zero) ranges.splice(d.index, 1); // 0초에서 놓았다 — 구간 선택 취소
      cut = { ...cut, ranges: { ...cut.ranges, [d.videoId]: normalize(ranges, durOf(d.videoId)) } };
      if (d.zero && !cancel) playhead = { videoId: d.videoId, t: d.orig.start };
      changed();
      render();
      showFrame();
      return;
    }
    if (d.kind === 'lane' && !d.moved && !cancel) {
      // 빈 곳을 눌렀다 — 그 자리부터 1초 구간
      const at = locate(geo.segments, gAt(e));
      if (!at) return;
      const added = addAt(cut.ranges[at.videoId] ?? [], at.t, durOf(at.videoId));
      if (added) {
        cut = { ...cut, ranges: { ...cut.ranges, [at.videoId]: added.list } };
        playhead = { videoId: at.videoId, t: added.range.start };
        changed();
      } else {
        playhead = at;
      }
      render();
      showFrame();
    }
  }

  track.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !cut.order.length) return;
    stopPlay();
    const handle = e.target.closest('.ce-handle');
    const box = e.target.closest('.ce-range');
    e.preventDefault();
    track.setPointerCapture(e.pointerId);
    if (handle && box) {
      const videoId = box.dataset.video;
      const index = Number(box.dataset.index);
      const r = cut.ranges[videoId]?.[index];
      if (!r) return;
      drag = {
        kind: 'edge', videoId, index, side: handle.dataset.edge, orig: { ...r }, zero: false, pointerId: e.pointerId,
      };
      moveEdge(e);
      return;
    }
    // 파란 구간 가운데 = 끌면 구간째 옮기기(누르기만 하면 인디케이터를 그 자리로)
    if (box) {
      const videoId = box.dataset.video;
      const index = Number(box.dataset.index);
      const r = cut.ranges[videoId]?.[index];
      const s = geo.segments.find((x) => x.videoId === videoId);
      if (!r || !s) return;
      drag = {
        kind: 'move', videoId, index, orig: { ...r }, grab: gAt(e) - s.offset - r.start, x0: e.clientX, moved: false, pointerId: e.pointerId,
      };
      return;
    }
    // 눈금·인디케이터 머리 = 인디케이터 옮기기, 바의 빈 곳 = 누르면 새 구간(끌면 인디케이터만)
    const scrub = !!(e.target.closest('.ce-ruler') || e.target.closest('.ce-playhead'));
    drag = {
      kind: scrub ? 'scrub' : 'lane', x0: e.clientX, moved: false, pointerId: e.pointerId,
    };
    if (scrub) scrubTo(e);
  });
  track.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (drag.kind === 'edge') { moveEdge(e); return; }
    if (drag.kind === 'move') {
      if (!drag.moved && Math.abs(e.clientX - drag.x0) <= TAP_PX) return;
      drag.moved = true;
      moveBox(e);
      return;
    }
    if (Math.abs(e.clientX - drag.x0) > TAP_PX) drag.moved = true;
    if (drag.kind === 'scrub' || drag.moved) {
      drag.kind = 'scrub';
      scrubTo(e);
    }
  });
  track.addEventListener('pointerup', (e) => endDrag(e));
  track.addEventListener('pointercancel', (e) => endDrag(e, { cancel: true }));

  // ── 확대 ──────────────────────────────────────────────────────────────────

  function setZoom(z) {
    const g = playhead ? globalOf(geo.segments, playhead.videoId, playhead.t) : 0;
    const before = xOf(g ?? 0) - scroll.scrollLeft;
    zoom = Math.min(maxZoom(), Math.max(1, z));
    render();
    scroll.scrollLeft = Math.max(0, xOf(g ?? 0) - before);
  }
  zoomInput.addEventListener('input', () => setZoom(maxZoom() ** (Number(zoomInput.value) / 100)));
  scroll.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return; // Ctrl+휠 = 확대·축소
    e.preventDefault();
    const v = Math.min(100, Math.max(0, Number(zoomInput.value) + (e.deltaY < 0 ? 8 : -8)));
    zoomInput.value = String(v);
    setZoom(maxZoom() ** (v / 100));
  }, { passive: false });

  // ── 영상 넣고 빼기 ────────────────────────────────────────────────────────

  function firstPlayhead() {
    const p = partsOf(cut)[0];
    if (p) return { videoId: p.videoId, t: p.start };
    return cut.order.length ? { videoId: cut.order[0], t: 0 } : null;
  }

  function toggle(id) {
    stopPlay();
    cut = toggleVideo(cut, id);
    if (cut.order.includes(id)) {
      // 넣은 영상으로 인디케이터를 옮겨 바로 보이게(전에 고른 구간이 있으면 그 시작)
      const r = (cut.ranges[id] ?? [])[0];
      playhead = { videoId: id, t: r ? r.start : 0 };
    } else if (playhead?.videoId === id) {
      playhead = firstPlayhead();
    }
    changed();
    render();
    showFrame();
    follow();
  }

  // ── 재생(고른 구간만 이어서) ──────────────────────────────────────────────

  function play() {
    const parts = partsOf(cut);
    if (!parts.length) return;
    const plan = parts.map((p) => ({
      ...p, g0: globalOf(geo.segments, p.videoId, p.start), g1: globalOf(geo.segments, p.videoId, p.end),
    }));
    // 인디케이터가 구간 안이면 거기서, 아니면 그 뒤의 첫 구간부터(뒤에 없으면 처음부터)
    const g = playhead ? globalOf(geo.segments, playhead.videoId, playhead.t) ?? 0 : 0;
    let i = plan.findIndex((p) => g >= p.g0 && g < p.g1 - 0.05);
    let from = i >= 0 ? playhead.t : null;
    if (i < 0) {
      i = plan.findIndex((p) => p.g0 >= g);
      if (i < 0) i = 0;
      from = plan[i].start;
    }
    playing = { plan, i, raf: 0 };
    startPart(i, from);
  }

  function startPart(i, from) {
    const p = playing.plan[i];
    playing.i = i;
    playhead = { videoId: p.videoId, t: from };
    showFrame();
    const { video } = player(p.videoId);
    video.currentTime = from;
    video.play().catch(() => {});
    // 다음 조각이 다른 영상이면 그 영상을 미리 그 자리로 옮겨 둔다(넘어갈 때 멈칫하지 않게)
    const nx = playing.plan[i + 1];
    if (nx && nx.videoId !== p.videoId) player(nx.videoId).seek(nx.start);
    renderSide();
    tick();
  }

  function tick() {
    cancelAnimationFrame(playing.raf);
    playing.raf = requestAnimationFrame(() => {
      if (!playing || destroyed) return;
      const p = playing.plan[playing.i];
      const v = player(p.videoId).video;
      playhead = { videoId: p.videoId, t: Math.min(p.end, v.currentTime) };
      renderPlayhead();
      follow();
      if (v.currentTime >= p.end - 0.03 || v.ended) {
        v.pause();
        if (playing.i + 1 < playing.plan.length) { startPart(playing.i + 1, playing.plan[playing.i + 1].start); return; }
        playhead = { videoId: p.videoId, t: p.end };
        stopPlay();
        renderPlayhead();
        return;
      }
      tick();
    });
  }

  function stopPlay() {
    if (!playing) return;
    cancelAnimationFrame(playing.raf);
    playing = null;
    for (const { video } of players.values()) video.pause();
    renderSide();
  }

  // ── 시작·정리 ─────────────────────────────────────────────────────────────

  // 창이 열려 폭이 정해진 뒤에 바를 그린다(열기 전엔 폭이 0) — 창 크기가 바뀌어도 다시 맞춘다.
  const ro = new ResizeObserver(() => render());
  ro.observe(scroll);
  for (const v of videos) loadStrip(v.id); // 빠진 영상 것도 — 썸네일로 넣자마자 사진이 보이게
  playhead = firstPlayhead();
  render();
  showFrame();

  return {
    el: root,
    /** 창을 닫을 때 — 재생을 멈추고 영상을 놓아 준다. */
    destroy() {
      destroyed = true;
      stopPlay();
      ro.disconnect();
      for (const v of [...[...players.values()].map((p) => p.video), ...thumbVideos.values()]) {
        v.pause();
        v.removeAttribute('src');
        v.load();
      }
      root.remove();
    },
    /** 시험용 — 지금 편집 상태 */
    state: () => ({ cut, playhead, total: totalOf(cut) }),
  };
}
