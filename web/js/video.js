import { api, pollJob, sessionToken } from './api.js';
import { getAt, imageSlots, setAt } from './doc.js';

/**
 * 스텝의 회색 상자 **안에서** 영상 → 참고 GIF 를 만든다.
 *
 * 상자를 누르면 [영상으로 GIF 생성] · [GIF 업로드] 두 개가 상자 안에 뜨고,
 * 올리기·차례 기다리기·처리·GIF 만들기가 전부 그 상자 안에서 보인다.
 * 창을 띄우는 곳은 한 군데뿐이다 — **구간 고르기**(미리보기가 커야 고를 수 있다).
 *
 * - **올리기는 동시에.** 상자마다 따로 올라가므로 여러 개를 한꺼번에 올려도 서로 기다리지 않는다.
 * - **Claude 처리는 한 줄로.** 올리기가 끝난 순서대로 큐에 서서 하나씩 돈다(구독 한도·캐시 때문).
 *   기다리는 상자에는 「앞에 N개」가 보인다.
 * - 자리(경로)는 작업 도중에 밀릴 수 있어 **노드 id 로 다시 찾는다**.
 */

const PHASE_LABEL = {
  uploading: '영상 올리는 중',
  queued: '차례 기다리는 중',
  working: '처리 중',
  gif: 'GIF 만드는 중',
};

/** 작업 단계 → 진행 막대(%) */
const PCT = { tools: 8, probe: 14, sheets: 22, speech: 34, describe: 55, match: 45, preview: 82, gif: 60 };

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

/** 올리기 진행률을 보려면 XHR 이어야 한다(fetch 는 올리는 쪽 진행률을 안 준다). */
function upload(file, { draftId, onProgress, onXhr }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    onXhr?.(xhr);
    xhr.open('POST', '/api/videos');
    xhr.setRequestHeader('x-cbs-token', sessionToken());
    xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
    xhr.setRequestHeader('x-draft-id', draftId);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    });
    xhr.addEventListener('load', () => {
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch { /* 아래에서 처리 */ }
      if (xhr.status === 200 && body.video) resolve(body.video);
      else reject(new Error(body.error || `올리지 못했습니다 (${xhr.status})`));
    });
    xhr.addEventListener('error', () => reject(new Error('올리는 중에 연결이 끊겼습니다.')));
    xhr.addEventListener('abort', () => reject(Object.assign(new Error('취소했습니다.'), { cancelled: true })));
    xhr.send(file);
  });
}

export function createVideoPanel({ root, getDoc, getDraftId, commit, toast }) {
  const jobs = new Map(); // nodeId → 작업 상태
  const menus = new Set(); // nodeId — 버튼 두 개가 펼쳐진 상자
  const queue = []; // Claude 처리 차례(올리기 끝난 순서)
  let running = null; // 지금 도는 nodeId

  const videoInput = el('input', { type: 'file', class: 'fx-hidden-file', accept: 'video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm,.m4v' });
  const gifInput = el('input', { type: 'file', class: 'fx-hidden-file', accept: 'image/gif,image/png,image/jpeg,image/webp' });
  document.body.append(videoInput, gifInput);
  let pickFor = null;

  // ── 자리 찾기 ─────────────────────────────────────────────────────────────

  /** 노드 id 로 지금 문서에서 그 사진 자리의 경로를 찾는다(작업 중에 자리가 밀렸을 수 있다). */
  function pathOf(doc, nodeId) {
    return imageSlots(doc).find((s) => s.node?.id === nodeId)?.path ?? null;
  }

  // ── 그리기 ────────────────────────────────────────────────────────────────

  function bar(pct) {
    return el('div', { class: 'vp-bar' }, el('div', { style: `width:${Math.round(Math.max(3, Math.min(100, pct * 100)))}%` }));
  }

  function actions(job) {
    return el('button', {
      type: 'button', class: 'vp-link', dataset: { vid: '1' }, on: { click: () => cancel(job.nodeId) },
    }, '취소');
  }

  function menuPanel(nodeId) {
    return el('div', { class: 'vp', dataset: { vidPanel: '1' } },
      el('button', {
        type: 'button', class: 'vp-btn primary', dataset: { vid: '1' }, on: { click: () => pick('video', nodeId) },
      }, '영상으로 GIF 생성'),
      el('button', {
        type: 'button', class: 'vp-btn', dataset: { vid: '1' }, on: { click: () => pick('gif', nodeId) },
      }, 'GIF 업로드'),
      el('div', { class: 'vp-note' }, '영상은 2분까지 · 이 스텝에 맞는 구간을 찾아 잘라 줍니다'),
      el('button', {
        type: 'button', class: 'vp-link', dataset: { vid: '1' }, on: { click: () => { menus.delete(nodeId); paint(); } },
      }, '닫기'));
  }

  /**
   * 구간 고르는 화면만 창으로 띄운다 — 미리보기가 작으면 고를 수가 없다.
   * 올리기·차례 기다리기·처리·GIF 만들기는 전부 상자 안에서 보인다.
   */
  function openClip(nodeId) {
    const job = jobs.get(nodeId);
    if (!job?.candidates?.length) return;
    const dlg = document.getElementById('clip_dialog');
    const step = getAt(getDoc(), (job.path ?? []).slice(0, -1));
    document.getElementById('clip_where').textContent = step?.title
      ? `「${step.title}」 자리 — ${job.name} 에서 찾은 구간입니다. 누르면 GIF 로 만들어 그 자리에 넣습니다.`
      : `${job.name} 에서 찾은 구간입니다. 누르면 GIF 로 만들어 그 자리에 넣습니다.`;
    document.getElementById('clip_grid').replaceChildren(...job.candidates.map((c) => el('button', {
      type: 'button', class: 'clip-cand', on: { click: () => { dlg.close(); makeGif(nodeId, c.start, c.end); } },
    },
    el('video', { src: c.preview, autoplay: true, muted: true, loop: true, playsinline: true }),
    el('b', {}, `${c.start}–${c.end}초 (${Math.round((c.end - c.start) * 10) / 10}초)${c.confidence != null ? ` · 확신 ${Math.round(c.confidence * 100)}%` : ''}`),
    el('span', {}, c.why),
    el('div', { class: 'vp-btn primary' }, '이 구간으로'))));
    const first = job.candidates[0];
    const from_ = el('input', { type: 'number', min: '0', step: '0.5', value: String(first.start) });
    const to_ = el('input', { type: 'number', min: '0', step: '0.5', value: String(first.end) });
    document.getElementById('clip_manual').replaceChildren(
      el('label', {}, '직접 구간 지정'), from_, el('span', {}, '~'), to_,
      el('button', {
        type: 'button', class: 'vp-btn small', on: { click: () => { dlg.close(); makeGif(nodeId, Number(from_.value), Number(to_.value)); } },
      }, '이 구간으로'),
    );
    if (!dlg.open) dlg.showModal();
  }

  function candidatePanel(job) {
    return el('div', { class: 'vp', dataset: { vidPanel: '1' } },
      el('div', { class: 'vp-head' }, `맞는 구간 ${job.candidates.length}개를 찾았습니다`),
      el('button', {
        type: 'button', class: 'vp-btn primary', dataset: { vid: '1' }, on: { click: () => openClip(job.nodeId) },
      }, '구간 고르기'),
      el('div', { class: 'vp-note' }, job.name),
      el('button', { type: 'button', class: 'vp-link', dataset: { vid: '1' }, on: { click: () => reset(job.nodeId) } }, '다른 영상으로'));
  }

  function panelFor(nodeId) {
    const job = jobs.get(nodeId);
    if (!job) return menus.has(nodeId) ? menuPanel(nodeId) : null;
    if (job.phase === 'candidates') return candidatePanel(job);
    if (job.phase === 'error') {
      return el('div', { class: 'vp', dataset: { vidPanel: '1' } },
        el('div', { class: 'vp-err' }, job.error),
        el('button', { type: 'button', class: 'vp-btn', dataset: { vid: '1' }, on: { click: () => reset(nodeId) } }, '다시'));
    }
    const ahead = queue.indexOf(nodeId);
    const detail = job.phase === 'queued'
      ? (ahead >= 0 ? `앞에 ${ahead + (running ? 1 : 0)}개 있습니다` : '곧 시작합니다')
      : job.detail || '';
    return el('div', { class: 'vp', dataset: { vidPanel: '1' } },
      el('div', { class: 'vp-head' }, PHASE_LABEL[job.phase] ?? '처리 중'),
      bar(job.pct ?? 0),
      el('div', { class: 'vp-note' }, [job.name, detail].filter(Boolean).join(' · ')),
      actions(job));
  }

  /**
   * 문서를 다시 그린 뒤에도 상자 안 상태가 살아 있게 — 다시 그릴 때마다 호출한다.
   * 상자 원래 내용(회색 라벨·사진)은 **지우지 않고 덮는다**. 그래야 패널이 사라질 때
   * 원래 모습(넣은 GIF)이 그대로 돌아온다.
   */
  function paint() {
    for (const box of root.querySelectorAll('[data-slot-id]')) {
      const nodeId = box.dataset.slotId;
      const panel = panelFor(nodeId);
      box.querySelector(':scope > [data-vid-panel]')?.remove();
      box.classList.toggle('has-panel', !!panel);
      if (panel) box.append(panel);
    }
  }

  function update(nodeId, patch) {
    const job = jobs.get(nodeId);
    if (!job) return;
    Object.assign(job, patch);
    paint();
  }

  // ── 고르기 ────────────────────────────────────────────────────────────────

  function pick(kind, nodeId) {
    pickFor = { kind, nodeId };
    const input = kind === 'video' ? videoInput : gifInput;
    input.value = '';
    input.click();
  }

  videoInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    const at = pickFor;
    e.target.value = '';
    pickFor = null;
    if (file && at) start(at.nodeId, file);
  });

  gifInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    const at = pickFor;
    e.target.value = '';
    pickFor = null;
    if (!file || !at) return;
    try {
      const { uploadImage } = await import('./slots.js');
      const asset = await uploadImage(file);
      putAsset(at.nodeId, asset);
      menus.delete(at.nodeId);
      paint();
      toast('넣었습니다');
    } catch (err) {
      toast(err.message, true);
    }
  });

  // ── 올리기 → 큐 → 처리 ────────────────────────────────────────────────────

  async function start(nodeId, file) {
    menus.delete(nodeId);
    const doc = getDoc();
    jobs.set(nodeId, { nodeId, name: file.name, phase: 'uploading', pct: 0, detail: '', path: pathOf(doc, nodeId) });
    paint();
    try {
      const video = await upload(file, {
        draftId: getDraftId(),
        onXhr: (xhr) => update(nodeId, { xhr }),
        onProgress: (p) => update(nodeId, { pct: p * 0.98, detail: `${Math.round(p * 100)}%` }),
      });
      update(nodeId, { videoId: video.id, video, phase: 'queued', pct: 0, detail: '', xhr: null });
      queue.push(nodeId);
      paint();
      pump();
    } catch (e) {
      if (e.cancelled) jobs.delete(nodeId);
      else update(nodeId, { phase: 'error', error: e.message });
      paint();
    }
  }

  async function pump() {
    if (running) return;
    const nodeId = queue.shift();
    if (!nodeId) return;
    if (!jobs.has(nodeId)) return pump();
    running = nodeId;
    paint();
    try {
      await work(nodeId);
    } catch (e) {
      if (jobs.has(nodeId)) update(nodeId, { phase: e.cancelled ? 'menu' : 'error', error: e.message, jobId: null });
      if (e.cancelled) { jobs.delete(nodeId); menus.add(nodeId); }
    } finally {
      running = null;
      paint();
      pump();
    }
  }

  async function runJob(nodeId, startCall) {
    const { jobId } = await startCall();
    update(nodeId, { jobId });
    const done = await pollJob(jobId, (j) => update(nodeId, {
      pct: Math.min(0.97, ((PCT[j.phase] ?? 10) + (j.total ? (15 * j.done) / j.total : 0)) / 100),
      detail: j.detail || '',
    }));
    update(nodeId, { jobId: null });
    if (done.status === 'cancelled') throw Object.assign(new Error('멈췄습니다.'), { cancelled: true });
    if (done.status !== 'done') throw new Error(done.error?.message ?? '실패했습니다.');
    return done.result;
  }

  async function work(nodeId) {
    const job = jobs.get(nodeId);
    update(nodeId, { phase: 'working', pct: 0.05, detail: '영상 준비 중' });
    // 준비는 영상당 한 번이다. 이미 준비된 영상이면 서버가 바로 돌려준다(같은 영상을 여러 스텝에 써도 한 번).
    await runJob(nodeId, () => api('POST', `/api/videos/${job.videoId}/prepare`));
    const doc = getDoc();
    const path = pathOf(doc, nodeId);
    if (!path) throw new Error('이 사진 자리가 문서에서 사라졌습니다.');
    update(nodeId, { path, detail: '맞는 구간을 찾는 중' });
    const { candidates } = await runJob(nodeId, () => api('POST', `/api/videos/${job.videoId}/match`, { doc, path }));
    update(nodeId, { phase: 'candidates', candidates, detail: '' });
  }

  // ── 넣기 ──────────────────────────────────────────────────────────────────

  function putAsset(nodeId, asset) {
    commit((cur) => {
      const path = pathOf(cur, nodeId);
      if (!path) throw new Error('이 사진 자리가 문서에서 사라졌습니다.');
      return setAt(cur, path, { ...getAt(cur, path), asset });
    });
  }

  async function makeGif(nodeId, start_, end) {
    const job = jobs.get(nodeId);
    if (!job?.videoId) return;
    if (!(end > start_)) return toast('끝나는 초가 시작보다 커야 합니다', true);
    const label = getAt(getDoc(), (job.path ?? []).slice(0, -1))?.title ?? '';
    update(nodeId, { phase: 'gif', pct: 0.1, detail: '' });
    try {
      const r = await runJob(nodeId, () => api('POST', `/api/videos/${job.videoId}/clip`, { start: start_, end, label }));
      putAsset(nodeId, r.asset);
      jobs.delete(nodeId);
      paint();
      const mb = (r.gif.size / 1048576).toFixed(1);
      toast(r.gif.reduced ? `GIF 를 넣었습니다 (${mb}MB — 용량 때문에 화질을 조금 낮췄습니다)` : `GIF 를 넣었습니다 (${mb}MB)`);
    } catch (e) {
      if (e.cancelled) update(nodeId, { phase: 'candidates', detail: '' });
      else update(nodeId, { phase: 'error', error: e.message });
    }
  }

  // ── 멈추기·되돌리기 ───────────────────────────────────────────────────────

  async function cancel(nodeId) {
    const job = jobs.get(nodeId);
    if (!job) return;
    const at = queue.indexOf(nodeId);
    if (at >= 0) queue.splice(at, 1);
    job.xhr?.abort();
    if (job.jobId) await api('POST', `/api/jobs/${job.jobId}/cancel`).catch(() => {});
    if (job.phase !== 'working' && job.phase !== 'gif') {
      jobs.delete(nodeId);
      menus.add(nodeId);
      paint();
    }
  }

  function reset(nodeId) {
    jobs.delete(nodeId);
    menus.add(nodeId);
    paint();
  }

  /** 회색 상자를 눌렀을 때 — 버튼 두 개를 폈다 접는다. 처리 중이면 그대로 둔다. */
  function toggle(nodeId) {
    if (jobs.has(nodeId)) return;
    if (menus.has(nodeId)) menus.delete(nodeId);
    else menus.add(nodeId);
    paint();
  }

  return {
    toggle,
    paint,
    /** 영상 일이 돌고 있는가 — 게시 전에 물어본다. */
    busyCount: () => [...jobs.values()].filter((j) => j.phase !== 'candidates' && j.phase !== 'error').length,
  };
}
