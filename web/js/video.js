import { api, pollJob } from './api.js';
import { getAt, setAt, stepTimeline, stepTitle } from './doc.js';

/**
 * 영상에서 참고 GIF 만들기 — 스텝의 회색 자리에서만 연다.
 *
 * 영상 올리기 → 준비(장면 뽑기·화면 읽기, 영상당 한 번) → 이 스텝에 맞는 구간 3개 → 골라서 GIF.
 * 준비는 영상당 한 번이라, 같은 영상으로 다른 스텝을 할 때는 구간 고르기만 한다.
 */

const $ = (id) => document.getElementById(id);
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** 작업 단계 → 진행 막대(%) */
const PCT = { tools: 8, probe: 12, sheets: 20, speech: 35, describe: 55, match: 45, preview: 80, gif: 60 };

export function createVideoPicker({ getDoc, getDraftId, commit, toast }) {
  const dlg = $('video_dialog');
  let target = null; // 사진 자리 경로
  let current = null; // 지금 고른 영상 id
  let job = null; // 도는 작업 id

  const setStatus = (text, cls = 'busy') => {
    $('video_status').textContent = text;
    $('video_status').className = `fx-status ${cls}`.trim();
  };
  const setResult = (text, cls = '') => {
    $('video_result').textContent = text;
    $('video_result').className = `fx-status ${cls}`.trim();
  };

  function showProgress(on) {
    $('video_progress').classList.toggle('hidden', !on);
    $('video_close').textContent = on ? '멈추기' : '닫기';
    $('video_add').disabled = on;
    if (!on) $('video_bar').style.width = '0%';
  }

  const onProgress = (j) => {
    const base = PCT[j.phase] ?? 10;
    const span = j.total ? (15 * j.done) / j.total : 0;
    $('video_bar').style.width = `${Math.min(97, base + span)}%`;
    setStatus(j.detail || '처리 중…');
  };

  async function runJob(startCall, label) {
    showProgress(true);
    setResult('');
    setStatus(label);
    try {
      const { jobId } = await startCall();
      job = jobId;
      const done = await pollJob(jobId, onProgress);
      if (done.status !== 'done') {
        throw new Error(done.error?.message ?? (done.status === 'cancelled' ? '멈췄습니다.' : '실패했습니다.'));
      }
      return done.result;
    } finally {
      job = null;
      showProgress(false);
    }
  }

  // ── 영상 목록 ─────────────────────────────────────────────────────────────

  function statusText(v) {
    if (v.status === 'ready') return `${fmt(v.usedSec || v.durationSec)}${v.trimmed ? ' (앞부분만)' : ''} · 준비됨`;
    if (v.status === 'preparing') return '준비 중…';
    if (v.status === 'error') return v.error || '실패';
    return '아직 준비 안 됨 — 누르면 준비합니다';
  }

  async function loadList() {
    try {
      const { videos } = await api('GET', `/api/videos?draft=${encodeURIComponent(getDraftId())}`);
      $('video_list').replaceChildren(...videos.map((v) => {
        const row = document.createElement('div');
        row.className = `video-item ${v.status === 'error' ? 'bad' : ''} ${current === v.id ? 'is-on' : ''}`.trim();
        const name = document.createElement('button');
        name.type = 'button';
        name.className = 'video-item-name';
        name.append(
          Object.assign(document.createElement('b'), { textContent: v.name }),
          Object.assign(document.createElement('small'), { textContent: statusText(v) }),
        );
        name.addEventListener('click', () => useVideo(v));
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'fx-link-btn';
        del.textContent = '지우기';
        del.addEventListener('click', async () => {
          await api('DELETE', `/api/videos/${v.id}`).catch(() => {});
          if (current === v.id) current = null;
          loadList();
        });
        row.append(name, del);
        return row;
      }));
      $('video_list').classList.toggle('hidden', !videos.length);
      return videos;
    } catch {
      return [];
    }
  }

  // ── 올리기 · 준비 · 구간 고르기 ───────────────────────────────────────────

  async function upload(file) {
    if (!/\.(mp4|mov|webm|m4v)$/i.test(file.name)) {
      toast('mp4·mov·webm 영상만 올릴 수 있습니다', true);
      return;
    }
    showProgress(true);
    setStatus(`${file.name} 올리는 중…`);
    try {
      const { video } = await api('POST', '/api/videos', file, {
        raw: true,
        headers: {
          'x-file-name': encodeURIComponent(file.name),
          'x-draft-id': getDraftId(),
          'content-type': 'application/octet-stream',
        },
      });
      showProgress(false);
      await loadList();
      await useVideo(video);
    } catch (e) {
      showProgress(false);
      setResult(e.message, 'bad');
    }
  }

  async function useVideo(v) {
    current = v.id;
    $('video_cands').replaceChildren();
    $('video_cands').classList.add('hidden');
    await loadList();
    try {
      if (v.status !== 'ready') {
        const r = await runJob(() => api('POST', `/api/videos/${v.id}/prepare`), '영상 준비를 시작합니다…');
        Object.assign(v, r.video ?? {});
        await loadList();
      }
      const { candidates } = await runJob(
        () => api('POST', `/api/videos/${v.id}/match`, { doc: getDoc(), path: target }),
        '이 스텝에 맞는 구간을 찾는 중…',
      );
      renderCandidates(candidates);
      setResult('후보를 골라 주세요. 누르면 GIF 로 만들어 그 자리에 넣습니다.', 'ok');
    } catch (e) {
      setResult(e.message, 'bad');
      if (current) $('video_manual').classList.remove('hidden'); // 막혀도 직접 구간으로 갈 수 있게
    }
  }

  function renderCandidates(candidates) {
    $('video_cands').replaceChildren(...candidates.map((c) => {
      const card = document.createElement('div');
      card.className = 'video-cand';
      const v = document.createElement('video');
      Object.assign(v, { src: c.preview, autoplay: true, muted: true, loop: true, playsInline: true });
      const time = document.createElement('div');
      time.className = 'video-cand-time';
      const secs = Math.round((c.end - c.start) * 10) / 10;
      time.textContent = `${c.start}–${c.end}초 (${secs}초)${c.confidence != null ? ` · 확신 ${Math.round(c.confidence * 100)}%` : ''}`;
      const why = document.createElement('div');
      why.className = 'video-cand-why';
      why.textContent = c.why;
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'primary-btn';
      go.textContent = '이 구간으로';
      go.addEventListener('click', () => makeGif(c.start, c.end));
      card.append(v, time, why, go);
      return card;
    }));
    $('video_cands').classList.toggle('hidden', !candidates.length);
    if (candidates[0]) {
      $('video_from').value = candidates[0].start;
      $('video_to').value = candidates[0].end;
    }
    $('video_manual').classList.remove('hidden');
  }

  async function makeGif(start, end) {
    if (!current || !target) return;
    const doc = getDoc();
    const node = getAt(doc, target);
    const step = getAt(doc, target.slice(0, -1));
    try {
      const r = await runJob(
        () => api('POST', `/api/videos/${current}/clip`, { start, end, label: step?.title ?? '' }),
        'GIF 만드는 중…',
      );
      commit(setAt(doc, target, { ...node, asset: r.asset }));
      dlg.close();
      const mb = (r.gif.size / 1048576).toFixed(1);
      toast(r.gif.reduced ? `GIF 를 넣었습니다 (${mb}MB — 용량 때문에 화질을 조금 낮췄습니다)` : `GIF 를 넣었습니다 (${mb}MB)`);
    } catch (e) {
      setResult(e.message, 'bad');
    }
  }

  // ── 열기 ──────────────────────────────────────────────────────────────────

  async function open(path) {
    target = path;
    current = null;
    const doc = getDoc();
    const step = getAt(doc, path.slice(0, -1));
    const tl = step?.type === 'step' ? stepTimeline(doc).steps.get(step.id) : null;
    $('video_step').textContent = step?.type === 'step'
      ? `「${stepTitle(step, tl)}」 자리 — 올린 영상에서 이 스텝에 맞는 구간을 찾아 ${tl?.secs ?? 5}초 안팎으로 잘라 줍니다.`
      : '올린 영상에서 이 자리에 맞는 구간을 찾아 줍니다.';
    $('video_cands').replaceChildren();
    $('video_cands').classList.add('hidden');
    $('video_manual').classList.add('hidden');
    setResult('');
    showProgress(false);
    if (!dlg.open) dlg.showModal();
    const videos = await loadList();
    if (!videos.length) $('video_file').click();
  }

  $('video_add').addEventListener('click', () => $('video_file').click());
  $('video_file').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) upload(file);
  });
  $('video_manual_go').addEventListener('click', () => {
    const start = Number($('video_from').value);
    const end = Number($('video_to').value);
    if (!(end > start)) {
      setResult('끝나는 초가 시작보다 커야 합니다.', 'bad');
      return;
    }
    makeGif(start, end);
  });
  $('video_close').addEventListener('click', async () => {
    if (job) {
      await api('POST', `/api/jobs/${job}/cancel`).catch(() => {});
      return;
    }
    dlg.close();
  });

  return { open };
}
