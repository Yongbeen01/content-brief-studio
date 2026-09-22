import { uploadAsset } from './api.js';

/**
 * 사진 자리.
 * - 누르면 파일을 골라 그 자리에 넣는다(서버에 저장, 노션 게시 때 그 파일이 올라간다).
 * - 안 바꾼 자리는 게시 직전에 여기서 회색 PNG 를 **글자까지 그려서** 올린다. 노션에서도 회색 네모로
 *   보이고, 노션의 이미지 「바꾸기」로 나중에 갈아끼울 수 있다. 글자는 영어로 — 크리에이터가 보는 페이지다.
 */

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export function checkImage(file) {
  if (!IMAGE_TYPES.includes(file.type)) return 'png·jpg·gif·webp 이미지만 넣을 수 있습니다.';
  if (file.size > MAX_IMAGE_BYTES) return '이미지가 20MB 를 넘습니다(노션 한 번 올리기 한도).';
  return '';
}

export async function uploadImage(file) {
  const err = checkImage(file);
  if (err) throw new Error(err);
  return uploadAsset(file, file.name);
}

/** 화면 라벨(한국어) → 회색 이미지에 쓸 영어 라벨. */
export function englishLabel(label) {
  return String(label ?? '')
    .replace('제품 이미지', 'Product image')
    .replace('참고 GIF', 'reference GIF')
    .replace('예시 이미지', 'example image')
    .trim() || 'Image';
}

export async function placeholderBlob(label, ratio, width = 540) {
  const w = width;
  const h = Math.max(60, Math.round(width * (Number(ratio) || 1)));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  g.fillStyle = '#E3E3E3';
  g.fillRect(0, 0, w, h);
  try { await document.fonts?.ready; } catch { /* 글꼴 없이 그린다 */ }
  const font = "'Pretendard Variable', Pretendard, 'Segoe UI', sans-serif";
  const big = Math.round(Math.min(w / 16, h / 6, 34));
  g.fillStyle = '#6B6F76';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `600 ${big}px ${font}`;
  g.fillText(englishLabel(label), w / 2, h / 2 - big * 0.45, w - 40);
  g.font = `400 ${Math.round(big * 0.6)}px ${font}`;
  g.fillStyle = '#8B93AA';
  g.fillText('Replace this image', w / 2, h / 2 + big * 0.75, w - 40);
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('회색 이미지를 만들지 못했습니다.'))), 'image/png');
  });
}
