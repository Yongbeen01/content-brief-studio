/**
 * 한 번에 limit 개까지만 돌린다(결과 순서는 넣은 순서 그대로).
 * 하나가 실패하면 남은 것은 새로 시작하지 않고 그 오류를 던진다 — 실패를 삼키려면 fn 안에서 잡는다.
 */
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i], i);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}
