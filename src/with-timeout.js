function withTimeout(promise, ms, label) {
  let timer;
  promise.catch(() => {}); // 防超时分支胜出后原 promise reject 变 unhandledRejection
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
  });
  return Promise.race([Promise.resolve(promise), guard]).finally(() => clearTimeout(timer));
}
module.exports = { withTimeout };
