/**
 * 생성이 끝났을 때 알린다 — 소리 + 브라우저 알림.
 *
 * 브라우저 알림(Notification)은 윈도우에서 **오른쪽 아래 알림**으로 뜬다(크롬·엣지가 윈도우 알림으로 보낸다).
 * 처음 한 번 브라우저가 허용할지 묻는다 — [생성]을 누를 때 묻는다(누른 순간이어야 묻는 창이 뜬다).
 * 소리는 알림 소리에 기대지 않고 여기서 낸다 — 윈도우에서 크롬 알림 소리가 꺼져 있어도 들리게.
 * 그래서 알림 자체는 조용히(silent) 띄운다(소리가 두 번 나지 않게).
 */

let audio = null;

/** 버튼을 누른 순간에 불러 둔다 — 브라우저는 사용자가 누르기 전에는 소리를 못 내게 막는다. */
export function prime() {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
  } catch { /* 소리 없이 */ }
  if ('Notification' in window && Notification.permission === 'default') {
    try { Notification.requestPermission(); } catch { /* 알림 없이 */ }
  }
}

/** 알림을 띄울 수 있는가 — 'granted' | 'denied' | 'default' | 'unsupported' */
export const permission = () => ('Notification' in window ? Notification.permission : 'unsupported');

/** 딩-동. 실패는 한 음 낮게 두 번. */
function chime(ok) {
  if (!audio) return;
  try {
    if (audio.state === 'suspended') audio.resume();
    const notes = ok ? [880, 1318.5] : [523.25, 392];
    const t0 = audio.currentTime + 0.02;
    notes.forEach((hz, i) => {
      const at = t0 + i * 0.18;
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = hz;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.22, at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.55);
      osc.connect(gain).connect(audio.destination);
      osc.start(at);
      osc.stop(at + 0.6);
    });
  } catch { /* 소리 없이 */ }
}

/**
 * @param {string} title
 * @param {string} body
 * @param {{ ok?: boolean }} [o]
 * @returns {boolean} 윈도우 알림을 띄웠는가
 */
export function notify(title, body, { ok = true } = {}) {
  chime(ok);
  if (permission() !== 'granted') return false;
  try {
    const n = new Notification(title, { body, tag: 'content-brief-studio', silent: true });
    n.onclick = () => {
      window.focus();
      n.close();
    };
    return true;
  } catch {
    return false;
  }
}
