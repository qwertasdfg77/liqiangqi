const profiles = Object.freeze({
  quick: Object.freeze({ key: 'quick', label: '快速档', milliseconds: 20000 }),
  highest: Object.freeze({ key: 'highest', label: '最高难度', milliseconds: 30000 })
});
function difficultyProfile(key) {
  if (!Object.hasOwn(profiles, key)) throw new Error('请选择快速档或最高难度。');
  return profiles[key];
}
module.exports = { difficultyProfile };
