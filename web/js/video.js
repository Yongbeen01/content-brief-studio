import { api, pollJob, sessionToken } from './api.js';
import {
  getAt, imageSlots, setAt, slotScene,
} from './doc.js';
import { checkLabel, passes, topPick } from './clip-rank.js';

/**
 * 스텝의 회색 상자 **안에서** 영상 → 참고 GIF 를 만든다. 불러온 브리프는 제품 사진 밖 모든 사진 자리가 이 상자다 —
 * 그 자리는 스텝 글 대신 사진 옆·아래 글로 장면을 찾는다(doc.js slotScene, 서버 match.js 도 같다).
 *
 * 상자를 누르면 [레퍼런스 검색] · [영상으로 자동 생성] · [GIF 업로드] 가 상자 안에 뜨고,
 * 올리기·차례 기다리기·처리·GIF 만들기가 전부 그 상자 안에서 보인다.
 * [레퍼런스 검색]은 틱톡 검색어 창을 띄운다(onReference — main.js).
 * 창을 띄우는 곳은 한 군데뿐이다 — **구간 고르기**(미리보기가 커야 고를 수 있다).
 *
 * - **한 자리에 영상을 여러 개** 올릴 수 있다. 여러 개면 조각이 서로 다른 영상에서 올 수 있다.
 * - **올리기는 동시에.** 상자마다, 파일마다 따로 올라가므로 서로 기다리지 않는다.
 * - **Claude 처리는 한 줄로.** 올리기가 끝난 순서대로 큐에 서서 하나씩 돈다(구독 한도·캐시 때문).
 *   기다리는 상자에는 「앞에 N개」가 보인다.
 * - 자리(경로)는 작업 도중에 밀릴 수 있어 **노드 id 로 다시 찾는다**.
 * - **틱톡 다운로더(확장)에서도 영상이 온다**(fromExtension). 레퍼런스 검색으로 연 틱톡 탭에서 [Step N GIF 생성]을
 *   누르면 확장이 영상을 서버에 직접 올리고 여기로 알린다 — 올리기 대신 「틱톡에서 받는 중」을 거쳐 같은 큐에 선다.
 */

const PHASE_LABEL = {
  receiving: '틱톡에서 영상 받는 중',
  uploading: '영상 올리는 중',
  queued: '차례 기다리는 중',
  working: '처리 중',
  gif: 'GIF 만드는 중',
};

/** 작업 단계 → 진행 막대(%) */
const PCT = { tools: 8, probe: 14, sheets: 22, speech: 34, describe: 55, match: 45, preview: 72, verify: 88, gif: 60 };

/** 카드·상자에 붙는 「확신 N% · 화면 확인 통과」. 순서 규칙은 clip-rank.js(서버와 같다). */
function scoreText(c) {
  return [
    c?.confidence != null ? `확신 ${Math.round(c.confidence * 100)}%` : '',
    checkLabel(c),
  ].filter(Boolean).join(' · ');
}

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

const pctText = (n) => `${Math.round(n * 100)}%`;

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

export function createVideoPanel({ root, getDoc, getDraftId, commit, toast, onReference }) {
  const jobs = new Map(); // nodeId → 작업 상태
  const menus = new Set(); // nodeId — 버튼들이 펼쳐진 상자
  const queue = []; // Claude 처리 차례(올리기 끝난 순서)
  let running = null; // 지금 도는 nodeId

  const videoInput = el('input', {
    type: 'file', class: 'fx-hidden-file', multiple: true,
    accept: 'video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm,.m4v',
  });
  const gifInput = el('input', { type: 'file', class: 'fx-hidden-file', accept: 'image/gif,image/png,image/jpeg,image/webp' });
  document.body.append(videoInput, gifInput);
  let pickFor = null;

  // ── 자리 찾기 ─────────────────────────────────────────────────────────────

  /** 노드 id 로 지금 문서에서 그 사진 자리의 경로를 찾는다(작업 중에 자리가 밀렸을 수 있다). */
  function pathOf(doc, nodeId) {
    return imageSlots(doc).find((s) => s.node?.id === nodeId)?.path ?? null;
  }

  // ── 상자 안 그리기 ────────────────────────────────────────────────────────

  function bar(pct) {
    return el('div', { class: 'vp-bar' }, el('div', { style: `width:${Math.round(Math.max(3, Math.min(100, pct * 100)))}%` }));
  }

  function menuPanel(nodeId) {
    return el('div', { class: 'vp', dataset: { vidPanel: '1' } },
      // 틱톡에서 참고 영상을 찾을 검색어 — 창은 main.js 가 띄운다.
      el('button', {
        type: 'button', class: 'vp-btn primary', dataset: { vid: '1' }, on: { click: () => onReference?.(nodeId) },
      }, '레퍼런스 검색'),
      el('button', {
        type: 'button', class: 'vp-btn', dataset: { vid: '1' }, on: { click: () => pick('video', nodeId) },
      }, '영상으로 자동 생성'),
      el('button', {
        type: 'button', class: 'vp-btn', dataset: { vid: '1' }, on: { click: () => pick('gif', nodeId) },
      }, 'GIF 업로드'),
      el('div', { class: 'vp-note' }, '영상은 2분까지 · 여러 개 고르면 장면을 나눠 이어 붙입니다'),
      el('button', {
        type: 'button', class: 'vp-link', dataset: { vid: '1' }, on: { click: () => { menus.delete(nodeId); paint(); } },
      }, '닫기'));
  }

  /** 그 자리에 지금 들어 있는 사진·GIF(없으면 null). */
  function assetOf(nodeId) {
    const doc = getDoc();
    const p = pathOf(doc, nodeId);
    return p ? getAt(doc, p)?.asset ?? null : null;
  }

  /**
   * 이미 GIF 가 들어 있는 자리를 눌렀을 때 — [삭제]·[GIF 다운로드]. 다시 만들려면 삭제해서 회색 자리로 돌린다
   * (그러면 같은 상자에 [레퍼런스 검색]·[영상으로 자동 생성]·[GIF 업로드]가 바로 뜬다).
   */
  function filledPanel(nodeId, asset) {
    const gif = asset.mime === 'image/gif' || /\.gif$/i.test(asset.name ?? '');
    return el('div', { class: 'vp', dataset: { vidPanel: '1' } },
      el('button', {
        type: 'button', class: 'vp-btn danger', dataset: { vid: '1' }, on: { click: () => removeAsset(nodeId) },
      }, '삭제'),
      el('button', {
        type: 'button', class: 'vp-btn', dataset: { vid: '1' }, on: { click: () => downloadAsset(asset) },
      }, gif ? 'GIF 다운로드' : '이미지 다운로드'),
      el('div', { class: 'vp-note' }, '삭제하면 회색 자리로 돌아가 다시 만들 수 있습니다'),
      el('button', {
        type: 'button', class: 'vp-link', dataset: { vid: '1' }, on: { click: () => { menus.delete(nodeId); paint(); } },
      }, '닫기'));
  }

  /** 들어 있는 GIF 를 지우고 회색 자리로 — 상자는 열어 둔 채라 곧바로 다시 만들 수 있다. 되돌리기로 살릴 수 있다. */
  function removeAsset(nodeId) {
    menus.add(nodeId);
    commit((cur) => {
      const path = pathOf(cur, nodeId);
      if (!path) throw new Error('이 사진 자리가 문서에서 사라졌습니다.');
      const { asset, ...rest } = getAt(cur, path);
      return setAt(cur, path, rest);
    });
    paint();
    toast('삭제했습니다 — 되돌리기로 살릴 수 있습니다');
  }

  /** 들어 있는 GIF(·사진)를 내 컴퓨터로 받는다 — 같은 출처라 a[download] 로 바로 저장된다. */
  function downloadAsset(asset) {
    const ext = { 'image/gif': 'gif', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[asset.mime] ?? 'gif';
    const base = String(asset.name ?? '').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'reference';
    const a = el('a', { href: `/api/assets/${asset.id}`, download: `${base}.${ext}` });
    document.body.append(a);
    a.click();
    a.remove();
  }

  function foundPanel(job) {
    const seq = job.sequence;
    const top = topPick(job);
    const what = seq
      ? `${seq.parts.length}조각을 이어 붙인 것까지 ${(job.singles?.length ?? 0) + 1}개`
      : `${job.singles?.length ?? 0}개`;
    // 영상이 여럿이면 맨 위 후보가 그중 몇 개를 쓰는지 — "왜 하나만?" 을 상자에서 바로 알 수 있게
    const used = new Set((top?.parts ?? []).map((p) => p.videoId));
    const usage = job.videos.length > 1 ? `영상 ${job.videos.length}개 중 ${used.size}개 사용` : job.videos[0]?.name;
    return el('div', { class: 'vp', dataset: { vidPanel: '1' } },
      el('div', { class: 'vp-head' }, `맞는 구간 ${what}`),
      el('button', {
        type: 'button', class: 'vp-btn primary', dataset: { vid: '1' }, on: { click: () => openClip(job.nodeId) },
      }, '구간 고르기'),
      el('div', { class: 'vp-note' }, [
        usage,
        scoreText(top?.cand),
      ].filter(Boolean).join(' · ')),
      el('button', { type: 'button', class: 'vp-link', dataset: { vid: '1' }, on: { click: () => reset(job.nodeId) } }, '다른 영상으로'));
  }

  function panelFor(nodeId) {
    const job = jobs.get(nodeId);
    if (!job) {
      if (!menus.has(nodeId)) return null;
      // 이미 GIF 가 들어 있으면 [삭제]·[다운로드], 회색 자리면 만들기 버튼들
      const asset = assetOf(nodeId);
      return asset ? filledPanel(nodeId, asset) : menuPanel(nodeId);
    }
    if (job.phase === 'found') return foundPanel(job);
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
      el('div', { class: 'vp-note' }, [job.label, detail].filter(Boolean).join(' · ')),
      el('button', {
        type: 'button', class: 'vp-link', dataset: { vid: '1' }, on: { click: () => cancel(nodeId) },
      }, '취소'));
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

  // ── 구간 고르기 창 ────────────────────────────────────────────────────────

  /** 조각이 맡은 행동 — 「행동 2 코튼 패드에 소프트너를…」 처럼 스텝 글 앞부분을 붙여 보여 준다. */
  function coversText(step, covers) {
    if (!covers?.length) return '';
    const actions = (step?.action ?? []).map((a) => String(a).replace(/\*\*/g, '').replace(/\s+/g, ' ').trim());
    const short = (s) => (s.length > 16 ? `${s.slice(0, 16)}…` : s);
    if (covers.length > 1) return `행동 ${covers.join('·')}`;
    const a = actions[covers[0] - 1];
    return a ? `행동 ${covers[0]} ${short(a)}` : `행동 ${covers[0]}`;
  }

  function clipCard(job, step, {
    preview, seconds, why, cand, seen, label, parts, covers, dropped = [], seq = false,
  }) {
    const many = job.videos.length > 1;
    const name = (p) => {
      const v = job.videos.findIndex((x) => x.id === p.videoId);
      return many ? `영상${v + 1} ` : '';
    };
    const partLines = seq
      ? parts.map((p, i) => el('span', { class: `clip-parts${p.ok === false ? ' bad' : ''}` },
        `${i + 1}) ${name(p)}${p.start}–${p.end}초${p.covers?.length ? ` · ${coversText(step, p.covers)}` : ''}${p.ok === false ? ' — 화면 확인에서 안 맞음' : ''}`))
      : (covers?.length ? [el('span', { class: 'clip-parts' }, coversText(step, covers))] : []);
    // 실제 장면 확인에서 안 맞아 뺀 조각 — 미리보기·GIF 에는 이미 빠져 있다
    const droppedLines = dropped.map((p) => el('span', { class: 'clip-parts bad' },
      `뺀 조각: ${name(p)}${p.start}–${p.end}초${p.covers?.length ? ` · ${coversText(step, p.covers)}` : ''} — 실제 장면에서 안 보여 뺐습니다`));
    return el('button', {
      type: 'button', class: ['clip-cand', seq ? 'clip-seq' : '', passes(cand) ? '' : 'weak'].filter(Boolean).join(' '), on: { click: () => makeGif(job.nodeId, parts) },
    },
    el('video', { src: preview, autoplay: true, muted: true, loop: true, playsinline: true }),
    el('div', { class: 'clip-body' },
      el('b', {}, [`${label} · ${seconds}초`, scoreText(cand)].filter(Boolean).join(' · ')),
      el('span', {}, why),
      seen ? el('span', { class: 'clip-seen' }, `${dropped.length ? '빼기 전 실제 장면' : '실제 장면'}: ${seen}`) : null,
      ...partLines,
      ...droppedLines,
      el('div', { class: 'vp-btn primary' }, '이 구간으로')));
  }

  /** 영상이 여럿일 때 — 영상마다 이 스텝에 무엇이 있는지, 맨 위 후보가 안 쓴 영상은 왜 빠졌는지. */
  function videoNotesList(job) {
    if (job.videos.length < 2) return null;
    const used = new Set((topPick(job)?.parts ?? []).map((p) => p.videoId));
    const notes = new Map((job.videoNotes ?? []).map((n) => [n.videoId, n.why]));
    return el('ul', { class: 'clip-videos' }, job.videos.map((v, i) => el('li', { class: used.has(v.id) ? '' : 'unused' },
      el('b', {}, `영상${i + 1}${used.has(v.id) ? '' : ' (맨 위 후보에 안 씀)'}`),
      ` ${v.name}${notes.get(v.id) ? ` — ${notes.get(v.id)}` : ''}`)));
  }

  /**
   * 그 자리가 보여 줄 장면 — 스텝 자리면 그 스텝, 불러온 브리프의 다른 사진 자리면 그 사진 옆·아래 글을 행동 줄로
   * 본다(서버 구간 고르기와 같은 기준 — doc.js slotScene). 조각 설명의 「행동 N …」 이 이 줄을 쓴다.
   */
  function sceneOf(path) {
    const s = slotScene(getDoc(), path ?? []);
    if (s?.kind === 'step') return s.step;
    return { title: s?.title ?? '', action: s?.lines ?? [] };
  }

  function openClip(nodeId) {
    const job = jobs.get(nodeId);
    if (!job) return;
    const dlg = document.getElementById('clip_dialog');
    const step = sceneOf(job.path);
    const top = topPick(job);
    const where = document.getElementById('clip_where');
    where.textContent = [
      step?.title ? `「${step.title}」 자리` : '이 자리',
      job.videos.length > 1 ? `영상 ${job.videos.length}개에서 찾은 구간입니다.` : `${job.videos[0]?.name} 에서 찾은 구간입니다.`,
      top?.seq ? '맨 위는 여러 장면을 순서대로 이어 붙인 것입니다.' : '',
      job.verified ? '「화면 확인」은 고른 장면을 실제 화면으로 다시 본 결과입니다 — 미흡한 후보는 아래로 내렸습니다.' : '',
    ].filter(Boolean).join(' — ');
    if (where.nextElementSibling?.classList.contains('clip-videos')) where.nextElementSibling.remove();
    const notes = videoNotesList(job);
    if (notes) where.after(notes);

    const seqCard = job.sequence ? clipCard(job, step, {
      preview: job.sequence.preview,
      seconds: job.sequence.seconds,
      why: job.sequence.why,
      cand: job.sequence,
      seen: job.sequence.check?.seen,
      label: `이어 붙이기 ${job.sequence.parts.length}조각`,
      parts: job.sequence.parts,
      dropped: job.sequence.dropped ?? [],
      seq: true,
    }) : null;
    const singleCards = (job.singles ?? []).map((c) => clipCard(job, step, {
      preview: c.preview,
      seconds: Math.round((c.end - c.start) * 10) / 10,
      why: c.why,
      cand: c,
      seen: c.check?.seen,
      covers: c.covers,
      label: job.videos.length > 1
        ? `영상${job.videos.findIndex((v) => v.id === c.videoId) + 1} ${c.start}–${c.end}초`
        : `${c.start}–${c.end}초`,
      parts: [c],
    }));
    // 이어 붙인 것은 한 구간짜리 1등보다 점수가 낮으면 아래로 내린다(실제 장면 확인에서 떨어졌을 때)
    document.getElementById('clip_grid').replaceChildren(
      ...(seqCard && top?.seq ? [seqCard] : []),
      ...singleCards,
      ...(seqCard && !top?.seq ? [seqCard] : []),
    );
    const first = job.singles?.[0] ?? job.sequence?.parts?.[0];
    const from = el('input', { type: 'number', min: '0', step: '0.5', value: String(first?.start ?? 0) });
    const to = el('input', { type: 'number', min: '0', step: '0.5', value: String(first?.end ?? 5) });
    // 처음 채워 두는 초가 어느 영상 것인지 칸도 맞춘다(예전엔 늘 1번 영상이 골라져 있어 초와 영상이 어긋났다)
    const which = job.videos.length > 1
      ? el('select', {}, job.videos.map((v, i) => el('option', { value: v.id, selected: v.id === first?.videoId }, `${i + 1}. ${v.name}`)))
      : null;
    document.getElementById('clip_manual').replaceChildren(
      el('label', {}, '직접 구간 지정'), which, from, el('span', {}, '~'), to,
      el('button', {
        type: 'button',
        class: 'vp-btn small',
        on: {
          click: () => {
            dlg.close();
            makeGif(nodeId, [{
              videoId: which ? which.value : job.videos[0].id, start: Number(from.value), end: Number(to.value),
            }]);
          },
        },
      }, '이 구간으로'),
    );
    if (!dlg.open) dlg.showModal();
  }

  // ── 고르기 ────────────────────────────────────────────────────────────────

  function pick(kind, nodeId) {
    pickFor = { kind, nodeId };
    const input = kind === 'video' ? videoInput : gifInput;
    input.value = '';
    input.click();
  }

  videoInput.addEventListener('change', (e) => {
    const files = [...(e.target.files ?? [])];
    const at = pickFor;
    e.target.value = '';
    pickFor = null;
    if (files.length && at) start(at.nodeId, files);
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

  async function start(nodeId, files) {
    menus.delete(nodeId);
    const doc = getDoc();
    const label = files.length > 1 ? `영상 ${files.length}개` : files[0].name;
    const progress = files.map(() => 0);
    jobs.set(nodeId, {
      nodeId, label, phase: 'uploading', pct: 0, detail: '', path: pathOf(doc, nodeId), xhrs: [], videos: [],
    });
    paint();
    const show = () => {
      const done = progress.reduce((a, b) => a + b, 0) / files.length;
      update(nodeId, { pct: done * 0.98, detail: pctText(done) });
    };
    try {
      // 파일마다 동시에 올린다. 같은 영상을 다시 올리면 서버가 이미 올린 것을 돌려준다.
      const videos = await Promise.all(files.map((f, i) => upload(f, {
        draftId: getDraftId(),
        onXhr: (xhr) => jobs.get(nodeId)?.xhrs.push(xhr),
        onProgress: (p) => { progress[i] = p; show(); },
      })));
      enqueue(nodeId, videos);
    } catch (e) {
      if (e.cancelled) jobs.delete(nodeId);
      else update(nodeId, { phase: 'error', error: e.message });
      paint();
    }
  }

  /** 서버에 올라간 영상으로 Claude 처리 차례를 선다 — 파일을 올렸든 확장이 보냈든 여기부터 같다. */
  function enqueue(nodeId, videos) {
    const seen = new Set();
    const unique = videos.filter((v) => (seen.has(v.id) ? false : seen.add(v.id)));
    update(nodeId, {
      videos: unique, phase: 'queued', pct: 0, detail: '', xhrs: [], label: unique.map((v) => v.name).join(', '),
    });
    queue.push(nodeId);
    paint();
    pump();
  }

  // ── 틱톡 다운로더(확장)에서 오는 영상 ─────────────────────────────────────

  /**
   * 틱톡 검색 탭의 [Step N GIF 생성] — 확장이 영상을 받아 서버에 직접 올리고(`POST /api/videos`), 여기는 소식만 받는다.
   * begin(받기 시작) → progress → videos(다 올림) | fail. videos 가 오면 파일을 골라 올린 것과 똑같이 큐에 선다.
   * 돌려주는 값이 확장에 가는 답이다 — ok 가 아니면 확장은 거기서 멈추고 틱톡 탭에 error 를 보여 준다.
   */
  function fromExtension(ev) {
    const nodeId = String(ev.slotId ?? '');
    const where = ev.step ? `Step ${ev.step}` : '이 스텝';
    const job = jobs.get(nodeId);
    if (String(ev.draftId ?? '') !== String(getDraftId())) {
      const error = '브리프 생성기에 다른 기획서가 열려 있습니다. 레퍼런스 검색을 연 기획서로 돌아간 뒤 다시 눌러 주세요.';
      if (job?.phase === 'receiving') update(nodeId, { phase: 'error', error });
      return { ok: false, error };
    }
    if (ev.kind === 'begin') {
      const path = pathOf(getDoc(), nodeId);
      if (!path) return { ok: false, error: `${where} 자리를 기획서에서 찾지 못했습니다.` };
      if (job && job.phase !== 'found' && job.phase !== 'error') {
        return { ok: false, error: `${where} 자리는 아직 영상을 처리하고 있습니다. 끝난 뒤 다시 눌러 주세요.` };
      }
      const total = Math.max(1, Number(ev.total) || 1);
      menus.delete(nodeId);
      jobs.set(nodeId, {
        nodeId, label: `틱톡 영상 ${total}개`, phase: 'receiving', pct: 0, detail: `1/${total}`, path, xhrs: [], videos: [], total,
      });
      paint();
      return { ok: true };
    }
    // 받는 도중에 상자에서 [취소]를 눌렀다 — 확장은 남은 영상을 보내지 않는다.
    if (job?.phase !== 'receiving') return { ok: false, cancelled: true };
    if (ev.kind === 'progress') {
      const i = Math.max(0, Number(ev.index) || 0);
      const pct = Math.max(0, Math.min(1, Number(ev.pct) || 0));
      update(nodeId, { pct: ((i + pct) / job.total) * 0.98, detail: `${Math.min(i + 1, job.total)}/${job.total}` });
      return { ok: true };
    }
    if (ev.kind === 'videos') {
      const videos = (ev.videos ?? []).filter((v) => v && typeof v.id === 'string');
      if (!videos.length) {
        update(nodeId, { phase: 'error', error: '틱톡에서 받은 영상이 없습니다.' });
        return { ok: true };
      }
      enqueue(nodeId, videos);
      root.querySelector(`[data-slot-id="${CSS.escape(nodeId)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      toast(`틱톡 영상 ${videos.length}개를 받았습니다 — ${where} 참고 GIF 를 만듭니다`);
      return { ok: true };
    }
    if (ev.kind === 'fail') {
      update(nodeId, { phase: 'error', error: ev.error || '틱톡에서 영상을 받지 못했습니다.' });
      return { ok: true };
    }
    return { ok: false, error: 'unknown' };
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
      if (jobs.has(nodeId)) update(nodeId, { phase: 'error', error: e.message });
      if (e.cancelled) { jobs.delete(nodeId); menus.add(nodeId); }
    } finally {
      running = null;
      paint();
      pump();
    }
  }

  const pctOf = (j) => Math.min(0.97, ((PCT[j.phase] ?? 10) + (j.total ? (15 * j.done) / j.total : 0)) / 100);

  /**
   * 서버 작업 하나를 끝까지 기다린다. 도는 작업 id 는 상자의 jobIds 에 두어 [취소]가 전부 멈출 수 있게 한다
   * (영상 여러 개는 준비를 동시에 돌린다). onTick 을 주면 진행 표시는 부른 쪽이 한다.
   */
  async function runJob(nodeId, startCall, { detail = '', onTick } = {}) {
    const { jobId } = await startCall();
    const mine = jobs.get(nodeId);
    if (mine) (mine.jobIds ??= new Set()).add(jobId);
    const done = await pollJob(jobId, onTick ?? ((j) => update(nodeId, {
      pct: pctOf(j),
      detail: [detail, j.detail].filter(Boolean).join(' · '),
    })));
    mine?.jobIds?.delete(jobId);
    if (done.status === 'cancelled') throw Object.assign(new Error('멈췄습니다.'), { cancelled: true });
    if (done.status !== 'done') throw new Error(done.error?.message ?? '실패했습니다.');
    return done.result;
  }

  /**
   * 영상 준비 — 영상마다 한 번, 여러 개면 **동시에**(차례로 하면 짧은 영상 몫만큼 기다림이 그대로 더해진다).
   * 이미 준비된 영상(같은 파일을 다른 스텝에 또 올린 경우)은 서버가 바로 돌려준다.
   */
  async function prepareAll(nodeId, videos) {
    const n = videos.length;
    const state = videos.map(() => ({ pct: 0, detail: '', done: false }));
    const show = () => {
      const finished = state.filter((s) => s.done).length;
      const live = state.find((s) => !s.done && s.detail)?.detail ?? '';
      update(nodeId, {
        pct: Math.max(0.05, state.reduce((a, s) => a + s.pct, 0) / n),
        detail: n > 1 ? [`영상 ${n}개 준비 중 (${finished}/${n} 끝)`, live].filter(Boolean).join(' · ') : live,
      });
    };
    await Promise.all(videos.map((v, i) => runJob(nodeId, () => api('POST', `/api/videos/${v.id}/prepare`), {
      onTick: (j) => { state[i].pct = pctOf(j); state[i].detail = j.detail ?? ''; show(); },
    }).then(() => { Object.assign(state[i], { done: true, pct: PCT.describe / 100 }); show(); })));
  }

  async function work(nodeId) {
    const job = jobs.get(nodeId);
    update(nodeId, { phase: 'working', pct: 0.05, detail: '영상 준비 중' });
    await prepareAll(nodeId, job.videos);
    const doc = getDoc();
    const path = pathOf(doc, nodeId);
    if (!path) throw new Error('이 사진 자리가 문서에서 사라졌습니다.');
    update(nodeId, { path, detail: '맞는 구간을 찾는 중' });
    const found = await runJob(nodeId, () => api('POST', '/api/videos/match', {
      videoIds: job.videos.map((v) => v.id), doc, path,
    }));
    update(nodeId, {
      phase: 'found',
      singles: found.singles ?? [],
      sequence: found.sequence ?? null,
      videoNotes: found.videoNotes ?? [],
      verified: !!found.verified,
      detail: '',
    });
  }

  // ── 넣기 ──────────────────────────────────────────────────────────────────

  function putAsset(nodeId, asset) {
    commit((cur) => {
      const path = pathOf(cur, nodeId);
      if (!path) throw new Error('이 사진 자리가 문서에서 사라졌습니다.');
      return setAt(cur, path, { ...getAt(cur, path), asset });
    });
  }

  async function makeGif(nodeId, parts) {
    const job = jobs.get(nodeId);
    if (!job || !parts?.length) return;
    const bad = parts.find((p) => !(Number(p.end) > Number(p.start)));
    if (bad) return toast('끝나는 초가 시작보다 커야 합니다', true);
    document.getElementById('clip_dialog')?.close();
    const label = String(sceneOf(job.path).title ?? '');
    update(nodeId, { phase: 'gif', pct: 0.1, detail: parts.length > 1 ? `${parts.length}조각 이어 붙이는 중` : '' });
    try {
      const r = await runJob(nodeId, () => api('POST', '/api/videos/clip', {
        parts: parts.map((p) => ({ videoId: p.videoId, start: Number(p.start), end: Number(p.end) })),
        label,
      }));
      putAsset(nodeId, r.asset);
      jobs.delete(nodeId);
      paint();
      const mb = (r.gif.size / 1048576).toFixed(1);
      const how = r.parts > 1 ? `${r.parts}조각 ${r.seconds}초` : `${r.seconds}초`;
      toast(r.gif.reduced
        ? `GIF 를 넣었습니다 (${how}, ${mb}MB — 용량 때문에 화질을 조금 낮췄습니다)`
        : `GIF 를 넣었습니다 (${how}, ${mb}MB)`);
    } catch (e) {
      if (e.cancelled) update(nodeId, { phase: 'found', detail: '' });
      else update(nodeId, { phase: 'error', error: e.message });
    }
  }

  // ── 멈추기·되돌리기 ───────────────────────────────────────────────────────

  async function cancel(nodeId) {
    const job = jobs.get(nodeId);
    if (!job) return;
    const at = queue.indexOf(nodeId);
    if (at >= 0) queue.splice(at, 1);
    for (const xhr of job.xhrs ?? []) xhr.abort();
    await Promise.all([...(job.jobIds ?? [])].map((id) => api('POST', `/api/jobs/${id}/cancel`).catch(() => {})));
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

  /** 회색 상자를 눌렀을 때 — 버튼들을 폈다 접는다. 처리 중이면 그대로 둔다. */
  function toggle(nodeId) {
    if (jobs.has(nodeId)) return;
    if (menus.has(nodeId)) menus.delete(nodeId);
    else menus.add(nodeId);
    paint();
  }

  return {
    toggle,
    paint,
    fromExtension,
    /** 영상 일이 돌고 있는가 — 게시 전에 물어본다. */
    busyCount: () => [...jobs.values()].filter((j) => j.phase !== 'found' && j.phase !== 'error').length,
  };
}
